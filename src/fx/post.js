// Post stack: HDR MSAA scene -> UnrealBloom -> one final pass (chromatic aberration, ACES tone map, sRGB,
// per-level grade, vignette, film grain).
//
//   const post = createPost({ renderer, scene, camera, tuning, bus });
//   post.render(dt); post.resize(w, h); post.setGrade({ tint, saturation, contrast, vignette, bloom, ... });
//
// Tone mapping happens in exactly one place: the final pass here. The scene renders into a float target, where
// three.js skips its own tone mapping, and `renderer.toneMappingExposure` (set per level by main.js) is read as
// the exposure. `?nopost=1` (or a failed composer) falls back to a plain renderer.render().
// Numbers live in tuning.json "post" (defaults + per-level grades under post.levels).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const DEFAULTS = {
  msaa: 4,
  bloom: { strength: 0.55, radius: 0.62, threshold: 0.92 },
  chroma: 0.0006,
  grain: 0.035,
  vignette: 0.42,
  vignetteSoft: 0.55,
  saturation: 1.08,
  contrast: 1.06,
  tint: [1, 1, 1],
  lift: [0, 0, 0],
  beatBloom: 0.06,
  impactChroma: 0.006,
  hurtChroma: 0.008,
  hurtVignette: 0.35,
  pulseDecay: 5.5,
  gradeLerp: 3,
  levels: {},
};

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1 },
    uChroma: { value: 0.001 },
    uGrain: { value: 0.03 },
    uVignette: { value: 0.4 },
    uVignetteSoft: { value: 0.55 },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uHurt: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure, uChroma, uGrain, uVignette, uVignetteSoft, uSaturation, uContrast, uHurt, uTime;
    uniform vec3 uTint, uLift;
    varying vec2 vUv;

    // ACES filmic, same fit three.js uses (ACESFilmicToneMapping)
    vec3 agFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 agAces(vec3 color) {
      const mat3 ACESInputMat = mat3(
        vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOutputMat = mat3(
        vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color *= uExposure / 0.6;
      color = ACESInputMat * color;
      color = agFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }
    vec3 agSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    float agHash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // chromatic aberration grows toward the frame edge
      vec2 off = c * r2 * uChroma * 4.0 + c * uChroma * 0.35;
      vec3 hdr = vec3(
        texture2D(tDiffuse, vUv + off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - off).b);
      hdr = clamp(hdr, 0.0, 64.0);
      vec3 col = agSRGB(agAces(hdr));
      // grade (display space)
      col = col * uTint + uLift * (1.0 - col);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      // vignette, tinted magenta while hurt
      float v = smoothstep(uVignetteSoft * 0.35, uVignetteSoft + 0.45, sqrt(r2) * 1.15);
      col *= 1.0 - v * uVignette;
      col += vec3(0.55, 0.02, 0.16) * v * uHurt;
      // film grain, stronger in the shadows
      float g = agHash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.0 - l * 0.6);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

function plain({ renderer, scene, camera }) {
  return {
    enabled: false,
    render() { renderer.render(scene, camera); },
    resize() {},
    setGrade() {},
    dispose() {},
  };
}

export function createPost(ctx) {
  const { renderer, scene, camera, tuning, bus } = ctx;
  const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  if (qs.has('nopost')) return plain(ctx);

  const P = { ...DEFAULTS, ...(tuning?.post || {}) };
  P.bloom = { ...DEFAULTS.bloom, ...(tuning?.post?.bloom || {}) };

  let composer, bloom, final;
  try {
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr), {
      type: THREE.HalfFloatType,
      samples: P.msaa,
      depthBuffer: true,
    });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), P.bloom.strength, P.bloom.radius, P.bloom.threshold);
    composer.addPass(bloom);
    final = new ShaderPass(FinalShader);
    composer.addPass(final);
  } catch (err) {
    console.warn('[post] composer unavailable, plain render', err);
    return plain(ctx);
  }

  // current grade eases toward the target grade so level changes do not pop
  const gradeOf = (g = {}) => ({
    tint: new THREE.Vector3(...(g.tint ?? P.tint)),
    lift: new THREE.Vector3(...(g.lift ?? P.lift)),
    saturation: g.saturation ?? P.saturation,
    contrast: g.contrast ?? P.contrast,
    vignette: g.vignette ?? P.vignette,
    chroma: g.chroma ?? P.chroma,
    grain: g.grain ?? P.grain,
    bloom: g.bloom ?? P.bloom.strength,
    threshold: g.threshold ?? P.bloom.threshold,
    radius: g.radius ?? P.bloom.radius,
  });
  let cur = gradeOf();
  let tgt = gradeOf();
  let snap = true;
  let chromaPulse = 0;
  let hurtPulse = 0;
  let bloomPulse = 0;
  let time = 0;

  const offs = [];
  if (bus?.on) {
    offs.push(bus.on('levelState', (e) => {
      if (e?.phase !== 'enter') return;
      tgt = gradeOf(P.levels?.[e.level]);
      snap = true; // the level switch is a hard cut anyway
    }));
    offs.push(bus.on('beat', () => { bloomPulse = Math.max(bloomPulse, P.beatBloom); }));
    offs.push(bus.on('impact', (e) => {
      const s = Math.max(0, Math.min(1, e?.strength ?? 0.5));
      chromaPulse = Math.max(chromaPulse, P.impactChroma * s * (e?.onBeat ? 1.4 : 1));
      if (e?.onBeat) bloomPulse = Math.max(bloomPulse, P.beatBloom * 2.5 * s);
    }));
    offs.push(bus.on('playerDamaged', (e) => {
      const s = Math.max(0.35, Math.min(1, (e?.amount ?? 10) / 25));
      chromaPulse = Math.max(chromaPulse, P.hurtChroma * s);
      hurtPulse = Math.max(hurtPulse, s);
    }));
  }

  const U = final.uniforms;
  return {
    enabled: true,
    composer,
    bloom,
    /** Override parts of the grade: { tint:[r,g,b], lift:[r,g,b], saturation, contrast, vignette, chroma, grain, bloom, threshold, radius }. */
    setGrade(g = {}, immediate = false) {
      const merged = gradeOf({
        tint: tgt.tint.toArray(), lift: tgt.lift.toArray(), saturation: tgt.saturation, contrast: tgt.contrast,
        vignette: tgt.vignette, chroma: tgt.chroma, grain: tgt.grain, bloom: tgt.bloom, threshold: tgt.threshold, radius: tgt.radius,
        ...g,
      });
      tgt = merged;
      if (immediate) snap = true;
    },
    render(dt = 0) {
      time += dt;
      const k = snap ? 1 : 1 - Math.exp(-P.gradeLerp * dt);
      snap = false;
      cur.tint.lerp(tgt.tint, k);
      cur.lift.lerp(tgt.lift, k);
      for (const key of ['saturation', 'contrast', 'vignette', 'chroma', 'grain', 'bloom', 'threshold', 'radius']) {
        cur[key] += (tgt[key] - cur[key]) * k;
      }
      const decay = Math.exp(-P.pulseDecay * dt);
      chromaPulse *= decay;
      hurtPulse *= decay;
      bloomPulse *= decay;

      bloom.strength = cur.bloom + bloomPulse;
      bloom.threshold = cur.threshold;
      bloom.radius = cur.radius;
      U.uExposure.value = renderer.toneMappingExposure;
      U.uChroma.value = cur.chroma + chromaPulse;
      U.uGrain.value = cur.grain;
      U.uVignette.value = Math.min(1, cur.vignette + hurtPulse * P.hurtVignette);
      U.uVignetteSoft.value = P.vignetteSoft;
      U.uSaturation.value = cur.saturation;
      U.uContrast.value = cur.contrast;
      U.uTint.value.copy(cur.tint);
      U.uLift.value.copy(cur.lift);
      U.uHurt.value = hurtPulse * 0.5;
      U.uTime.value = time;
      composer.render(dt);
    },
    resize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    dispose() {
      offs.forEach((off) => off?.());
      composer.dispose?.();
    },
  };
}
