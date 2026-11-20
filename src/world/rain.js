import * as THREE from 'three';

/**
 * GPU rain: one instanced draw for the streaks and one for the splash rings. Positions come from a per-instance
 * seed and time in the vertex shader, wrapped in a box that follows the player, so there is no per-drop CPU work.
 * tuning.rain: { count, area, speed, size, height, wind, length, opacity, splashes, splashSize }
 */
export function createRain(tuning, parent, opts = {}) {
  const t = { ...(tuning?.rain || {}), ...opts };
  const count = t.count ?? 1100;
  const area = t.area ?? 42;
  const speed = t.speed ?? 16;
  const size = t.size ?? 0.07;
  const height = t.height ?? 16;
  const wind = t.wind ?? 1.4;
  const splashes = t.splashes ?? 260;

  const seeds = (n) => {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < a.length; i++) a[i] = Math.random();
    return new THREE.InstancedBufferAttribute(a, 3);
  };

  // ---- streaks: camera-facing quads stretched along the fall direction ----
  const geom = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  geom.instanceCount = count;
  geom.setAttribute('aSeed', seeds(count));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: {
      uTime: { value: 0 }, uOrigin: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(area, height, area) },
      uFall: { value: new THREE.Vector3(-wind, -speed, 0) },
      uWidth: { value: size * (t.widthScale ?? 0.22) }, uLength: { value: t.length ?? 0.55 },
      uColor: { value: new THREE.Color(t.color ?? 0x9fc8e0) }, uOpacity: { value: t.opacity ?? 0.5 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aSeed;
      uniform float uTime, uWidth, uLength;
      uniform vec3 uOrigin, uBox, uFall;
      varying float vA; varying vec2 vQ;
      void main() {
        float sp = 0.75 + aSeed.y * 0.5;
        vec3 p = aSeed * uBox + uFall * uTime * sp;
        vec3 base = vec3(uOrigin.x - uBox.x * 0.5, uOrigin.y - 2.0, uOrigin.z - uBox.z * 0.5);
        p = mod(p - base, uBox) + base;
        vec3 dir = normalize(uFall);
        vec3 toCam = normalize(cameraPosition - p);
        vec3 side = normalize(cross(dir, toCam));
        p += side * position.x * uWidth + dir * position.y * uLength * sp;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vQ = uv;
        vA = (0.45 + 0.55 * aSeed.x) * smoothstep(60.0, 22.0, -mv.z) * smoothstep(0.6, 2.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity;
      varying float vA; varying vec2 vQ;
      void main() {
        float a = (1.0 - abs(vQ.x - 0.5) * 2.0) * smoothstep(0.0, 0.25, vQ.y) * smoothstep(1.0, 0.6, vQ.y);
        gl_FragColor = vec4(uColor * a * vA * uOpacity, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.renderOrder = 6;
  parent.add(mesh);

  // ---- splashes: short-lived expanding rings on the ground plane under the player ----
  let splash = null;
  if (splashes > 0) {
    const sg = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    sg.instanceCount = splashes;
    sg.setAttribute('aSeed', seeds(splashes));
    const sm = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      uniforms: {
        uTime: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uArea: { value: t.splashArea ?? 26 },
        uSize: { value: t.splashSize ?? 0.17 }, uColor: { value: new THREE.Color(t.color ?? 0x9fc8e0) }, uOpacity: { value: t.splashOpacity ?? 0.4 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        uniform float uTime, uArea, uSize;
        uniform vec3 uOrigin;
        varying vec2 vQ; varying float vLife;
        float h1(float n) { return fract(sin(n * 91.345) * 47453.5453); }
        void main() {
          float period = 0.45 + aSeed.z * 0.5;
          float tt = uTime / period + aSeed.x * 7.0;
          float cyc = floor(tt);
          vLife = fract(tt);
          // a new random spot every cycle, snapped to a grid that does not slide with the player
          vec2 r = vec2(h1(cyc + aSeed.x * 31.0), h1(cyc * 1.7 + aSeed.y * 57.0));
          vec2 cell = floor(uOrigin.xz / uArea);
          vec2 xz = (cell + r) * uArea;
          xz += uArea * step(uArea * 0.5, uOrigin.xz - xz) - uArea * step(uArea * 0.5, xz - uOrigin.xz);
          float s = uSize * (0.35 + vLife) * (0.6 + aSeed.y * 0.8);
          vec3 p = vec3(xz.x + position.x * s, uOrigin.y + 0.02, xz.y + position.z * s);
          vQ = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vQ; varying float vLife;
        void main() {
          float d = length(vQ - 0.5) * 2.0;
          float ring = smoothstep(0.55, 0.8, d) * smoothstep(1.0, 0.85, d);
          gl_FragColor = vec4(uColor * ring * (1.0 - vLife) * (1.0 - vLife) * uOpacity, 1.0);
        }
      `,
    });
    splash = new THREE.Mesh(sg, sm);
    splash.frustumCulled = false;
    splash.renderOrder = 2;
    parent.add(splash);
  }

  const origin = new THREE.Vector3();
  let groundY = 0;
  let time = 0;
  return {
    mesh,
    setOrigin(p) { origin.copy(p); },
    /** Height of the surface the splashes sit on (defaults to the last grounded player height). */
    setGround(y) { groundY = y; },
    update(dt) {
      time += dt;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uOrigin.value.copy(origin);
      if (splash) {
        splash.material.uniforms.uTime.value = time;
        splash.material.uniforms.uOrigin.value.set(origin.x, groundY, origin.z);
      }
    },
    dispose() {
      parent.remove(mesh);
      geom.dispose(); mat.dispose();
      if (splash) { parent.remove(splash); splash.geometry.dispose(); splash.material.dispose(); }
    },
  };
}
