// Shared level-dressing kit: props, image-based light, sky domes, wet reflective decks, light cones, glow
// sprites, neon text, GPU particles and portal gates. Everything here is visual only; colliders stay in the
// level files (addBox) so physics and the navmesh never depend on dressing.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

export function mulberry32(a) {
  return () => {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NO_REFLECT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noreflect');

/**
 * Clone a loaded manifest prop into the level. `collide` adds a tight box collider.
 * opts: { yaw, collide, scale, y, maxFootprint }
 */
export function placeProp(group, physics, ids, props, name, x, z, opts = {}) {
  const { yaw = 0, collide = false, scale = 1, y = 0, maxFootprint = 2.4 } = opts;
  const loaded = props?.[name];
  if (!loaded?.root) return null;
  const obj = loaded.root.clone(true);
  obj.position.x = x;
  obj.position.z = z;
  obj.position.y = loaded.root.position.y * scale + y;
  if (scale !== 1) obj.scale.multiplyScalar(scale);
  if (yaw) obj.rotation.y = yaw;
  obj.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
  group.add(obj);
  if (collide && physics) {
    obj.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(obj);
    if (!box.isEmpty()) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      // keep colliders tight so dressing can't eat movement lanes
      size.x = Math.min(size.x, maxFootprint) * 0.85;
      size.z = Math.min(size.z, maxFootprint) * 0.85;
      size.y *= 0.9;
      const id = physics.addBox({ center, halfExtents: size.multiplyScalar(0.5), userData: { solid: true } });
      if (id) ids.push(id);
    }
  }
  return obj;
}

/** Small PMREM environment from a few coloured cards, for reflections on wet / glossy materials. */
export function makeEnv(renderer, { sky = 0x152838, hemiTop = 0x7ec8e8, hemiBottom = 0x1a1020, hemi = 1.1, cards = [] } = {}) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight(hemiTop, hemiBottom, hemi));
  s.add(new THREE.Mesh(new THREE.SphereGeometry(30, 16, 12), new THREE.MeshBasicMaterial({ color: sky, side: THREE.BackSide })));
  for (const c of cards) {
    const col = new THREE.Color(c.color).multiplyScalar(c.gain ?? 1);
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.size?.[0] ?? 8, c.size?.[1] ?? 8, 1), new THREE.MeshBasicMaterial({ color: col }));
    m.position.set(...c.pos);
    m.lookAt(0, 0, 0);
    s.add(m);
  }
  const rt = pmrem.fromScene(s, 0.04);
  pmrem.dispose();
  s.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  return rt;
}

/**
 * Sky dome with a vertical gradient, optional stars, aurora curtains and a low haze glow.
 * Returns a mesh; call mesh.userData.update(t) each frame when aurora is on.
 */
export function skyDome({ top = 0x05070c, horizon = 0x10202c, glow = 0x000000, glowPower = 3, stars = 0, aurora = 0, auroraA = 0x3dffb0, auroraB = 0x7a5cff, radius = 180 } = {}) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uHorizon: { value: new THREE.Color(horizon) },
      uGlow: { value: new THREE.Color(glow) },
      uGlowPower: { value: glowPower },
      uStars: { value: stars },
      uAurora: { value: aurora },
      uAuroraA: { value: new THREE.Color(auroraA) },
      uAuroraB: { value: new THREE.Color(auroraB) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uGlow, uAuroraA, uAuroraB;
      uniform float uGlowPower, uStars, uAurora, uTime;
      varying vec3 vDir;
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);
        vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
        col += uGlow * pow(1.0 - clamp(abs(h), 0.0, 1.0), uGlowPower);
        if (uStars > 0.0 && h > 0.0) {
          vec2 sp = d.xz / (d.y + 0.35) * 46.0;
          vec2 cell = floor(sp);
          float r = h21(cell);
          vec2 o = vec2(h21(cell + 3.1), h21(cell + 7.7)) - 0.5;
          float dist = length(fract(sp) - 0.5 - o * 0.7);
          float tw = 0.75 + 0.25 * sin(uTime * (1.0 + r * 3.0) + r * 40.0);
          col += vec3(0.8, 0.9, 1.0) * step(0.93, r) * smoothstep(0.09, 0.0, dist) * uStars * tw * smoothstep(0.0, 0.25, h);
        }
        if (uAurora > 0.0 && h > 0.02) {
          float az = atan(d.x, d.z);
          float band = 0.0;
          vec3 ac = vec3(0.0);
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float wave = fbm(vec2(az * (2.0 + fi) + fi * 9.0, uTime * (0.035 + 0.02 * fi)));
            float centre = 0.26 + 0.16 * fi + (wave - 0.5) * 0.3;
            float curtain = smoothstep(0.0, 0.05, h - centre + 0.1) * smoothstep(0.38, 0.0, h - centre);
            float rays = 0.55 + 0.45 * vnoise(vec2(az * 60.0 + fi * 13.0 + uTime * 0.12, fi));
            float amt = curtain * rays * (0.5 + 0.5 * fbm(vec2(az * 3.0 - uTime * 0.05, fi * 4.0)));
            ac += mix(uAuroraA, uAuroraB, clamp((h - centre) * 3.0 + 0.2 * fi, 0.0, 1.0)) * amt;
          }
          col += ac * uAurora;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.userData.update = (t) => { mat.uniforms.uTime.value = t; };
  return mesh;
}

/**
 * Canvas maps for a deck: albedo, roughness (dark = wet) and a puddle mask, all laid out once over the whole
 * deck in world-planar UVs (u = x / w + 0.5, v = z / d + 0.5).
 * opts: { w, d, seed, base, seam, panel (m), puddles, puddleSize:[min,max] (m), grime, rings:[radii], ringColor }
 */
export function deckMaps(opts = {}) {
  const { w = 28, d = 22, seed = 0xA3E15, base = '#161b22', seam = 'rgba(4,6,9,0.85)', panel = 2, puddles = 26, puddleSize = [0.9, 3.2], grime = 9000, dryRough = 150, rings = null, ringColor = 'rgba(60,220,255,0.5)', res = 1024 } = opts;
  const W = res;
  const H = Math.max(64, Math.round((res * d) / w));
  const ppm = W / w;
  const rnd = mulberry32(seed);
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const albedo = mk(); const rough = mk(); const mask = mk();
  const a = albedo.getContext('2d'); const r = rough.getContext('2d'); const m = mask.getContext('2d');
  a.fillStyle = base; a.fillRect(0, 0, W, H);
  r.fillStyle = `rgb(${dryRough},${dryRough},${dryRough})`; r.fillRect(0, 0, W, H);
  m.fillStyle = '#000'; m.fillRect(0, 0, W, H);
  // panel tone variation
  if (panel > 0) {
    for (let x = 0; x < w; x += panel) for (let z = 0; z < d; z += panel) {
      const t = rnd();
      a.fillStyle = `rgba(${t > 0.5 ? 255 : 0},${t > 0.5 ? 255 : 0},${t > 0.5 ? 255 : 0},${0.012 + rnd() * 0.03})`;
      a.fillRect(x * ppm, z * ppm, panel * ppm, panel * ppm);
      const rr = Math.round(dryRough + (rnd() - 0.5) * 50);
      r.fillStyle = `rgb(${rr},${rr},${rr})`;
      r.fillRect(x * ppm, z * ppm, panel * ppm, panel * ppm);
    }
  }
  // grit
  for (let i = 0; i < grime; i++) {
    const x = rnd() * W, y = rnd() * H;
    const n = rnd();
    a.fillStyle = n > 0.5 ? `rgba(160,190,210,${0.03 + rnd() * 0.05})` : `rgba(0,0,0,${0.08 + rnd() * 0.14})`;
    a.fillRect(x, y, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
  }
  // seams
  if (panel > 0) {
    a.strokeStyle = seam; a.lineWidth = Math.max(1.5, ppm * 0.035);
    r.strokeStyle = '#d8d8d8'; r.lineWidth = a.lineWidth;
    for (let x = 0; x <= w + 0.01; x += panel) {
      a.beginPath(); a.moveTo(x * ppm, 0); a.lineTo(x * ppm, H); a.stroke();
      r.beginPath(); r.moveTo(x * ppm, 0); r.lineTo(x * ppm, H); r.stroke();
    }
    for (let z = 0; z <= d + 0.01; z += panel) {
      a.beginPath(); a.moveTo(0, z * ppm); a.lineTo(W, z * ppm); a.stroke();
      r.beginPath(); r.moveTo(0, z * ppm); r.lineTo(W, z * ppm); r.stroke();
    }
  }
  if (rings) {
    a.strokeStyle = ringColor; a.lineWidth = Math.max(2, ppm * 0.05);
    for (const rad of rings) { a.beginPath(); a.arc(W / 2, H / 2, rad * ppm, 0, Math.PI * 2); a.stroke(); }
  }
  // puddles: several overlapping soft blobs each, so the edges are organic
  for (let i = 0; i < puddles; i++) {
    const cx = rnd() * W, cy = rnd() * H;
    const size = (puddleSize[0] + rnd() * (puddleSize[1] - puddleSize[0])) * ppm;
    const blobs = 3 + Math.floor(rnd() * 4);
    for (let b = 0; b < blobs; b++) {
      const bx = cx + (rnd() - 0.5) * size * 1.1;
      const by = cy + (rnd() - 0.5) * size * 0.8;
      const br = size * (0.3 + rnd() * 0.45);
      for (const [ctx2, inner, outer] of [[m, 'rgba(255,255,255,0.95)', 'rgba(255,255,255,0)'], [r, 'rgba(8,8,8,0.97)', 'rgba(8,8,8,0)'], [a, 'rgba(2,4,7,0.5)', 'rgba(2,4,7,0)']]) {
        const g = ctx2.createRadialGradient(bx, by, br * 0.45, bx, by, br);
        g.addColorStop(0, inner); g.addColorStop(1, outer);
        ctx2.fillStyle = g;
        ctx2.beginPath(); ctx2.ellipse(bx, by, br, br * (0.6 + rnd() * 0.4), rnd() * 3, 0, Math.PI * 2); ctx2.fill();
      }
    }
  }
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  return { map: tex(albedo, true), roughnessMap: tex(rough, false), mask: tex(mask, false), w, d };
}

let _detailNormal = null;
/** Tiling micro-normal (fine asphalt / ice grain) from value noise. */
export function detailNormal() {
  if (_detailNormal) return _detailNormal;
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = mulberry32(77);
  const hgt = new Float32Array(S * S);
  for (let o = 0; o < 3; o++) {
    const cells = 16 << o;
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, fy = (y / S) * cells;
      const x0 = Math.floor(fx) % cells, y0 = Math.floor(fy) % cells, x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
      const v = (grid[y0 * cells + x0] * (1 - tx) + grid[y0 * cells + x1] * tx) * (1 - ty) + (grid[y1 * cells + x0] * (1 - tx) + grid[y1 * cells + x1] * tx) * ty;
      hgt[y * S + x] += v / (1 << o);
    }
  }
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const hx = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x + S - 1) % S)];
    const hy = hgt[((y + 1) % S) * S + x] - hgt[((y + S - 1) % S) * S + x];
    const n = new THREE.Vector3(-hx * 2.2, -hy * 2.2, 1).normalize();
    const i = (y * S + x) * 4;
    img.data[i] = (n.x * 0.5 + 0.5) * 255; img.data[i + 1] = (n.y * 0.5 + 0.5) * 255; img.data[i + 2] = (n.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _detailNormal = t;
  return t;
}

let _inMirror = false;

const ReflectShader = {
  name: 'WetDeckReflect',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uMask: { value: null },
    uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, // centre x, centre z, 1/w, 1/d
    uStrength: { value: 0.85 },
    uBase: { value: 0.12 },
    uBlur: { value: 0.006 },
    uRipple: { value: 0.004 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D uMask;
    uniform vec4 uRect;
    uniform float uStrength, uBase, uBlur, uRipple, uTime;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 muv = (vWorld.xz - uRect.xy) * uRect.zw + 0.5;
      float wet = texture2D(uMask, muv).r;
      // rain ripples disturb the mirror inside puddles, coarse shimmer elsewhere
      vec2 rp = vWorld.xz * 14.0;
      vec2 rip = vec2(sin(rp.x * 1.7 + uTime * 5.0) + sin(rp.y * 2.3 - uTime * 4.0), cos(rp.y * 1.9 + uTime * 4.5) + cos(rp.x * 2.1 + uTime * 3.5));
      vec2 uv = vUv.xy / vUv.w + rip * uRipple * (0.4 + wet);
      float blur = uBlur * (1.0 - wet * 0.85);
      vec3 refl = texture2D(tDiffuse, uv).rgb * 0.36;
      refl += texture2D(tDiffuse, uv + vec2(blur, blur * 0.4)).rgb * 0.16;
      refl += texture2D(tDiffuse, uv - vec2(blur, blur * 0.4)).rgb * 0.16;
      refl += texture2D(tDiffuse, uv + vec2(-blur * 0.5, blur * 1.6)).rgb * 0.16;
      refl += texture2D(tDiffuse, uv - vec2(-blur * 0.5, blur * 1.6)).rgb * 0.16;
      vec3 view = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - clamp(view.y, 0.0, 1.0), 3.0);
      float alpha = clamp((uBase + (1.0 - uBase) * wet) * (0.25 + 0.75 * fres) * uStrength, 0.0, 1.0);
      gl_FragColor = vec4(refl * color, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/**
 * Visual top for a flat deck: a PBR plane with deck maps plus a planar-reflection overlay that is strong in the
 * puddles and at grazing angles. The collider stays the level's own box.
 * opts: { w, d, x, z, y, maps, color, roughness, metalness, envMapIntensity, reflect: { strength, base, blur, ripple, scale } | false }
 * Returns { top, mirror, update(t), dispose() }.
 */
export function wetDeck(group, opts = {}) {
  const { w, d, x = 0, z = 0, y = 0, maps, color = 0xffffff, roughness = 1, metalness = 0, envMapIntensity = 1, normalScale = 0.35, normalRepeat = 1.2, reflect = {} } = opts;
  const geom = new THREE.PlaneGeometry(w, d);
  geom.rotateX(-Math.PI / 2);
  // world-planar UVs so the reflection mask lines up with the roughness map
  const uv = geom.attributes.uv;
  const pos = geom.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getZ(i) / d + 0.5);
  const mat = new THREE.MeshStandardMaterial({ color, map: maps?.map ?? null, roughnessMap: maps?.roughnessMap ?? null, roughness, metalness, envMapIntensity });
  if (normalScale > 0) {
    const dn = detailNormal().clone();
    dn.needsUpdate = true;
    dn.repeat.set(w * normalRepeat, d * normalRepeat);
    mat.normalMap = dn;
    mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;
  const top = new THREE.Mesh(geom, mat);
  top.position.set(x, y + 0.004, z);
  top.receiveShadow = true;
  group.add(top);

  let mirror = null;
  if (reflect && !NO_REFLECT) {
    const scale = reflect.scale ?? 0.5;
    const pr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    mirror = new Reflector(new THREE.PlaneGeometry(w, d), {
      textureWidth: Math.round(innerWidth * pr * scale),
      textureHeight: Math.round(innerHeight * pr * scale),
      clipBias: 0.02,
      color: reflect.color ?? 0xffffff,
      shader: ReflectShader,
    });
    const u = mirror.material.uniforms;
    u.uMask.value = maps?.mask ?? null;
    u.uRect.value.set(x, z, 1 / w, 1 / d);
    u.uStrength.value = reflect.strength ?? 0.85;
    u.uBase.value = reflect.base ?? 0.12;
    u.uBlur.value = reflect.blur ?? 0.006;
    u.uRipple.value = reflect.ripple ?? 0.004;
    mirror.material.transparent = true;
    mirror.material.depthWrite = false;
    mirror.material.polygonOffset = true;
    mirror.material.polygonOffsetFactor = -2; mirror.material.polygonOffsetUnits = -2;
    mirror.rotation.x = -Math.PI / 2;
    mirror.position.set(x, y + 0.008, z);
    mirror.renderOrder = 1;
    // never render a mirror from inside another mirror's reflection pass
    const inner = mirror.onBeforeRender;
    mirror.onBeforeRender = function (...args) {
      if (_inMirror) return;
      _inMirror = true;
      try { inner.apply(this, args); } finally { _inMirror = false; }
    };
    group.add(mirror);
  }
  return {
    top,
    mirror,
    update(t) { if (mirror) mirror.material.uniforms.uTime.value = t; },
    dispose() {
      geom.dispose(); mat.dispose();
      maps?.map?.dispose(); maps?.roughnessMap?.dispose(); maps?.mask?.dispose();
      if (mirror) { mirror.getRenderTarget().dispose(); mirror.material.dispose(); mirror.geometry.dispose(); }
    },
  };
}

/** Additive volumetric-light fake: an open cone that fades along its length and at its silhouette. */
export function lightCone({ color = 0x3df0ff, height = 8, radius = 2.2, topRadius = 0.15, opacity = 0.35 } = {}) {
  const geom = new THREE.CylinderGeometry(topRadius, radius, height, 28, 1, true);
  geom.translate(0, -height / 2, 0); // apex at the origin, pointing down
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uHeight: { value: height } },
    vertexShader: /* glsl */`
      varying float vT; varying vec3 vN; varying vec3 vV;
      uniform float uHeight;
      void main() {
        vT = -position.y / uHeight;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity;
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.6);
        float tt = clamp(vT, 0.0, 1.0);
        float along = pow(1.0 - tt, 1.5) * smoothstep(0.0, 0.06, tt);
        gl_FragColor = vec4(uColor * uOpacity * rim * along, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.renderOrder = 3;
  return mesh;
}

let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

/** Soft additive halo sprite (lamp glare, distant lights, crystal cores). */
export function glowSprite(color = 0x3df0ff, size = 2, opacity = 0.8) {
  const mat = new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  s.renderOrder = 4;
  return s;
}

/**
 * Neon lettering on a transparent card: the glyphs are HDR so the bloom pass turns them into tubes.
 * opts: { color, w, h, gain, font, backing }
 */
export function neonText(text, { color = 0x3df0ff, w = 3.2, h = 0.7, gain = 2.4, font = '900 84px system-ui, sans-serif', backing = true, outline = false } = {}) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = Math.max(64, Math.round((1024 * h) / w));
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const px = Math.round(c.height * 0.68);
  g.font = font.replace(/\d+px/, `${px}px`);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // shrink to fit
  const tw = g.measureText(text).width;
  if (tw > c.width * 0.9) g.font = font.replace(/\d+px/, `${Math.floor((px * c.width * 0.9) / tw)}px`);
  g.shadowColor = '#fff'; g.shadowBlur = c.height * 0.16;
  if (outline) { g.lineWidth = c.height * 0.045; g.strokeStyle = '#fff'; g.strokeText(text, c.width / 2, c.height * 0.54); }
  else { g.fillStyle = '#fff'; g.fillText(text, c.width / 2, c.height * 0.54); }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  const col = new THREE.Color(color).multiplyScalar(gain);
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: col, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.renderOrder = 2;
  const holder = new THREE.Group();
  holder.add(mesh);
  if (backing) {
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(w * 1.06, h * 1.25, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x06080c, roughness: 0.5, metalness: 0.6 }),
    );
    back.position.z = -0.07;
    holder.add(back);
  }
  holder.userData.text = mesh;
  return holder;
}

/**
 * GPU-animated particles in a box that follows `origin` (snow, embers, dust motes). No per-frame CPU work
 * beyond two uniforms. opts: { count, area, height, color, size, velocity:[x,y,z], sway, opacity, additive }
 */
export function createMotes(parent, { count = 400, area = 30, height = 12, color = 0xffffff, size = 0.08, velocity = [0, -1, 0], sway = 0.4, opacity = 0.8, additive = true, twinkle = 0 } = {}) {
  const geom = new THREE.BufferGeometry();
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
  geom.setAttribute('position', new THREE.BufferAttribute(seed, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
    uniforms: {
      uTime: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(area, height, area) },
      uVel: { value: new THREE.Vector3(...velocity) }, uSway: { value: sway }, uSize: { value: size }, uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity }, uTwinkle: { value: twinkle }, uScale: { value: 600 },
    },
    vertexShader: /* glsl */`
      uniform float uTime, uSway, uSize, uScale, uTwinkle;
      uniform vec3 uOrigin, uBox, uVel;
      varying float vA;
      void main() {
        vec3 s = position;
        vec3 p = s * uBox + uVel * uTime * (0.6 + s.z * 0.8);
        p.x += sin(uTime * (0.5 + s.y) + s.z * 40.0) * uSway;
        p.z += cos(uTime * (0.4 + s.x) + s.y * 40.0) * uSway;
        vec3 base = vec3(uOrigin.x - uBox.x * 0.5, uOrigin.y, uOrigin.z - uBox.z * 0.5);
        p = mod(p - base, uBox) + base;
        float fy = (p.y - uOrigin.y) / uBox.y;
        vA = smoothstep(0.0, 0.08, fy) * smoothstep(1.0, 0.8, fy);
        vA *= 1.0 - uTwinkle * (0.5 + 0.5 * sin(uTime * (2.0 + s.x * 6.0) + s.y * 50.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * (0.6 + s.x * 0.8) * uScale / max(0.1, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.05, d) * vA * uOpacity;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
  mat.premultipliedAlpha = true;
  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  parent.add(pts);
  let t = 0;
  return {
    points: pts,
    update(dt, origin, baseY = null) {
      t += dt;
      mat.uniforms.uTime.value = t;
      mat.uniforms.uScale.value = innerHeight * 0.9;
      if (origin) mat.uniforms.uOrigin.value.set(origin.x, baseY ?? origin.y - 1, origin.z);
    },
    dispose() { parent.remove(pts); geom.dispose(); mat.dispose(); },
  };
}

/**
 * Visible gate for a level portal: floor ring, swirling disc and a light column. Red and dim while
 * `portal.locked`, level colour and bright once open. Returns { update(dt) }.
 */
export function portalGate(group, portal, { color = 0x3df0ff, lockedColor = 0xff2d55, yaw = 0, arch = null } = {}) {
  const root = new THREE.Group();
  root.position.copy(portal.pos);
  root.rotation.y = yaw;
  const cOpen = new THREE.Color(color);
  const cLock = new THREE.Color(lockedColor);
  const r = portal.radius ?? 1.6;
  const ringMat = new THREE.MeshBasicMaterial({ color: cOpen.clone(), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.92, r, 48), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
  const discMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uColor: { value: cOpen.clone() }, uTime: { value: 0 }, uOpen: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uTime, uOpen; varying vec2 vUv;
      void main() {
        vec2 p = vUv - 0.5; float d = length(p) * 2.0; float a = atan(p.y, p.x);
        float swirl = 0.5 + 0.5 * sin(a * 3.0 + d * 9.0 - uTime * (1.0 + 2.5 * uOpen));
        float body = smoothstep(1.0, 0.75, d) * (0.18 + 0.5 * swirl * uOpen) + smoothstep(0.35, 0.0, d) * 0.5 * uOpen;
        gl_FragColor = vec4(uColor * body * (0.5 + 1.2 * uOpen), 1.0);
      }
    `,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.95, 40), discMat);
  disc.position.y = r * 0.95 + 0.25; // upright doorway
  const beam = lightCone({ color, height: 7, radius: r * 0.9, topRadius: r * 0.55, opacity: 0.22 });
  beam.position.y = 7;
  const light = new THREE.PointLight(color, 6, 12, 1.6);
  light.position.y = 1.6;
  root.add(ring, disc, beam, light);
  if (arch) root.add(arch);
  group.add(root);
  let t = 0;
  let open = portal.locked ? 0 : 1;
  const tmp = new THREE.Color();
  return {
    root,
    update(dt) {
      t += dt;
      open += ((portal.locked ? 0 : 1) - open) * Math.min(1, dt * 4);
      tmp.copy(cLock).lerp(cOpen, open);
      ringMat.color.copy(tmp).multiplyScalar(1.2 + open);
      ringMat.opacity = 0.5 + 0.4 * open;
      discMat.uniforms.uColor.value.copy(tmp);
      discMat.uniforms.uTime.value = t;
      discMat.uniforms.uOpen.value = open;
      beam.material.uniforms.uColor.value.copy(tmp);
      beam.material.uniforms.uOpacity.value = 0.05 + 0.2 * open;
      light.color.copy(tmp);
      light.intensity = 2 + 5 * open + Math.sin(t * 3) * 0.6 * open;
    },
  };
}
