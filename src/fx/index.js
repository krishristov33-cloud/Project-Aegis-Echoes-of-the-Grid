// Aether power VFX — event-driven, pooled, no composer / post stack.
// Colors from Krea's 00_master: cyan energy (0x3df0ff) + magenta neon (0xff3d8a).
// initFX(game) subscribes to the bus; the manual API works without power logic.
import * as THREE from 'three';
import { Events } from '../core/events.js';

const CYAN = 0x3df0ff, MAGENTA = 0xff3d8a, TEAL = 0x9cffff;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

function addMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function shaderMat(vert, frag, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader: vert, fragmentShader: frag,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
}
const UV_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;

function makeGhostMat() {
  return shaderMat(UV_VERT, /* glsl */`
    uniform float uTime, uLife;
    varying vec2 vUv;
    void main(){
      float scan = 0.55 + 0.45 * sin(vUv.y * 90.0 + uTime * 22.0);
      float flick = 0.7 + 0.3 * step(0.35, fract(uTime * 19.0 + vUv.x * 4.0));
      vec3 col = vec3(0.15, 0.95, 1.0) * scan;
      col.r += 0.55 + 0.35 * sin(uTime * 40.0);
      col.b += 0.25 * sin(vUv.x * 30.0 + uTime * 16.0);
      col.rb += vec2(0.35, -0.2) * sin(uTime * 26.0);
      gl_FragColor = vec4(col, 0.4 * flick * uLife);
    }`, { uTime: { value: 0 }, uLife: { value: 1 } });
}
function makeGridMat() {
  return shaderMat(UV_VERT, /* glsl */`
    uniform float uLife;
    varying vec2 vUv;
    void main(){
      vec2 g = abs(fract(vUv * vec2(10.0, 6.0)) - 0.5);
      float line = 1.0 - smoothstep(0.02, 0.05, min(g.x, g.y));
      float edge = 1.0 - smoothstep(0.015, 0.1, min(min(vUv.x,1.0-vUv.x), min(vUv.y,1.0-vUv.y)));
      float m = max(line, edge);
      vec3 col = mix(vec3(0.12, 0.92, 1.0), vec3(1.0, 0.28, 0.62), edge);
      gl_FragColor = vec4(col, m * uLife * 0.95);
    }`, { uLife: { value: 1 } });
}
function makeGlitchMat() {
  return shaderMat(UV_VERT, /* glsl */`
    uniform float uTime, uAmt;
    varying vec2 vUv;
    void main(){
      float e = 1.0 - smoothstep(0.0, 0.22, min(min(vUv.x,1.0-vUv.x), min(vUv.y,1.0-vUv.y)));
      float n = fract(sin(dot(vUv * 40.0 + uTime, vec2(12.7, 78.1))) * 43758.5);
      float blocks = step(0.72, fract(vUv.y * 18.0 + uTime * 6.0 + n));
      vec3 col = vec3(0.2, 0.95, 1.0);
      col.r += 0.7 * n; col.b += 0.3 * blocks;
      gl_FragColor = vec4(col, e * uAmt * (0.35 + 0.65 * blocks));
    }`, { uTime: { value: 0 }, uAmt: { value: 0 } });
}

function makeArcGeom(radius = 1.45, tube = 0.055, arc = Math.PI * 0.75) {
  return new THREE.TorusGeometry(radius, tube, 5, 28, arc);
}
function makeGhost() {
  const g = new THREE.Group(); g.name = 'fxGhost';
  const mat = makeGhostMat();
  const add = (geo, y, s) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.scale.setScalar(s); g.add(m); };
  add(new THREE.BoxGeometry(0.38, 0.55, 0.22), 1.15, 1);
  add(new THREE.BoxGeometry(0.22, 0.22, 0.2), 1.55, 1);
  add(new THREE.BoxGeometry(0.16, 0.55, 0.16), 0.55, 1);
  g.userData.mat = mat;
  g.visible = false;
  return g;
}

/**
 * @param {object} game  { scene, bus, camera, time, player, clock }
 * @returns {object} fx  manual API + update/dispose
 */
export function initFX(game = {}) {
  const scene = game.scene;
  const group = new THREE.Group(); group.name = 'aetherFx';
  if (scene) scene.add(group);
  const live = [];
  let timeSec = 0, mix = 0, beatPunch = 1;

  const rings = [];
  for (let i = 0; i < 10; i++) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40), addMat(CYAN, 0));
    mesh.rotation.x = -Math.PI / 2; mesh.visible = false; group.add(mesh); rings.push(mesh);
  }
  const ribbons = [];
  for (let i = 0; i < 6; i++) {
    const a = new THREE.Mesh(makeArcGeom(), addMat(CYAN, 0));
    const b = new THREE.Mesh(makeArcGeom(1.45, 0.03, Math.PI * 0.75), addMat(MAGENTA, 0));
    const g = new THREE.Group(); g.add(a, b); g.visible = false; group.add(g); ribbons.push({ g, a, b });
  }
  const sparkGeo = new THREE.BufferGeometry();
  const sparkN = 24;
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sparkN * 3), 3));
  const sparkMat = new THREE.PointsMaterial({
    color: TEAL, size: 0.08, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, sizeAttenuation: true,
  });
  const sparkPool = [];
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Points(sparkGeo.clone(), sparkMat.clone());
    p.visible = false; p.userData.vel = []; group.add(p); sparkPool.push(p);
  }
  const cones = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(2.0, 7.2, 18, 1, true), addMat(CYAN, 0));
    m.rotation.x = -Math.PI / 2; m.visible = false; group.add(m); cones.push(m);
  }
  const blockGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const blockMesh = new THREE.InstancedMesh(blockGeo, addMat(CYAN, 0.85), 64);
  blockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blockMesh.visible = false; blockMesh.count = 0; group.add(blockMesh);
  const blockJobs = [];
  const dummy = new THREE.Object3D();

  const ghost = makeGhost(); group.add(ghost);
  const streaks = [];
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.45), addMat(i % 2 ? MAGENTA : CYAN, 0));
    c.visible = false; group.add(c); streaks.push(c);
  }
  const shieldMesh = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.8, 0.12), makeGridMat());
  shieldMesh.visible = false; group.add(shieldMesh);
  const pad = new THREE.Group(); pad.visible = false;
  const padRings = [];
  for (let i = 0; i < 4; i++) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.35 + i * 0.35, 0.42 + i * 0.35, 40), addMat(i % 2 ? MAGENTA : CYAN, 0.0));
    r.rotation.x = -Math.PI / 2; pad.add(r); padRings.push(r);
  }
  group.add(pad);
  const flash = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), addMat(0xffffff, 0));
  flash.rotation.x = -Math.PI / 2; flash.visible = false; group.add(flash);
  const glitchMat = makeGlitchMat();
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.42), glitchMat);
  overlay.position.z = -0.28; overlay.frustumCulled = false;
  if (game.camera) game.camera.add(overlay);
  else group.add(overlay);

  function acquire(pool) {
    const m = pool.find((x) => !x.visible && !x.g) || pool.find((x) => x.g && !x.g.visible);
    return m || pool[0];
  }
  function liveAdd(obj, life, tick) {
    live.push({ obj, t: 0, life, tick });
  }

  function melee(origin, dir, opts = {}) {
    if (!origin) return;
    const d = dir && dir.lengthSq() > 1e-6 ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const item = acquire(ribbons); if (!item) return;
    const g = item.g; g.visible = true;
    g.position.copy(origin); g.position.y += 1.05;
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
    g.rotateX(-0.35); g.rotateZ(opts.flip ? 0.7 : -0.55);
    item.a.material.opacity = item.b.material.opacity = 0;
    const scale = opts.onBeat ? 1.25 : 1;
    g.scale.setScalar(scale);
    liveAdd(g, 0.28, (o, u, k) => {
      const fade = u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8;
      item.a.material.opacity = fade * 0.95;
      item.b.material.opacity = fade * 0.55;
      o.scale.setScalar(scale * (1 + u * 0.35));
      if (k) { o.visible = false; item.a.material.opacity = 0; }
    });
    const hit = origin.clone().addScaledVector(d, 1.5); hit.y += 1.0;
    hitSparks(hit);
    if (opts.onBeat) beatFlash(hit);
    hitStop(0.05);
  }

  function hitSparks(origin) {
    if (!origin) return;
    const p = sparkPool.find((s) => !s.visible) || sparkPool[0];
    p.visible = true; p.position.copy(origin);
    const pos = p.geometry.attributes.position; const vel = [];
    for (let i = 0; i < sparkN; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3.5, (Math.random() - 0.5) * 4);
      vel.push(v);
      pos.setXYZ(i, 0, 0, 0);
    }
    p.userData.vel = vel; pos.needsUpdate = true; p.material.opacity = 1;
    liveAdd(p, 0.35, (o, u, k) => {
      const a = o.geometry.attributes.position; const vs = o.userData.vel;
      for (let i = 0; i < sparkN; i++) {
        vs[i].y -= 12 * 0.016;
        a.setXYZ(i, a.getX(i) + vs[i].x * 0.016, a.getY(i) + vs[i].y * 0.016, a.getZ(i) + vs[i].z * 0.016);
      }
      a.needsUpdate = true; o.material.opacity = 1 - u;
      if (k) o.visible = false;
    });
  }

  function blast(origin, dir, opts = {}) {
    if (!origin) return;
    const d = dir && dir.lengthSq() > 1e-6 ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const punch = (opts.onBeat ? 1.2 : 1) * beatPunch;
    const spawnRing = (delay, speed, color, wobble) => {
      const r = rings.find((m) => !m.visible && !m.userData.busy) || rings[0];
      r.visible = true; r.userData.busy = true;
      r.position.copy(origin); r.position.y += 0.08;
      r.material.color.setHex(color); r.scale.setScalar(0.4);
      liveAdd(r, 0.55 + delay, (o, u, k) => {
        const t = Math.max(0, u - delay / (0.55 + delay));
        const s = (0.5 + t * speed) * punch;
        const w = wobble ? 1 + 0.08 * Math.sin(timeSec * 16 + t * 10) : 1;
        o.scale.set(s * w, 1, s / w);
        o.material.opacity = (1 - t) * 0.8;
        if (k) { o.visible = false; o.userData.busy = false; }
      });
    };
    spawnRing(0, 10, CYAN, true);
    spawnRing(0.06, 7, TEAL, true);
    spawnRing(0.12, 5, MAGENTA, false);
    const c = cones.find((m) => !m.visible) || cones[0];
    c.visible = true; c.position.copy(origin); c.position.y += 0.9;
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    c.scale.set(punch, punch, punch);
    liveAdd(c, 0.45, (o, u, k) => {
      o.material.opacity = (1 - u) * 0.4; o.scale.setScalar(punch * (1 + u * 0.4));
      if (k) o.visible = false;
    });
    // cone dust as a second spark burst along the aim
    const dust = origin.clone().addScaledVector(d, 2.2); dust.y += 0.4;
    hitSparks(dust);
    if (opts.onBeat) beatFlash(origin);
  }

  function _blocks(center, n, life) {
    const start = blockJobs.length ? blockJobs[blockJobs.length - 1].end : 0;
    const job = { start, end: start + n, t: 0, life, center: center.clone(), seeds: [] };
    for (let i = 0; i < n; i++) {
      job.seeds.push({
        x: (Math.random() - 0.5) * 1.4, y: Math.random() * 1.8, z: (Math.random() - 0.5) * 1.4,
        s: 0.4 + Math.random() * 1.1, spin: Math.random() * 6,
      });
    }
    blockJobs.push(job);
    blockMesh.visible = true;
  }
  function blink(from, to, opts = {}) {
    if (from) _blocks(from, 16, 0.32);
    if (to) _blocks(to, 16, 0.32);
    const life = opts.duration ?? 2.5;
    if (from) {
      ghost.visible = true;
      ghost.position.copy(from);
      ghost.lookAt(to || from.clone().add(new THREE.Vector3(0, 0, 1)));
      const mat = ghost.userData.mat;
      liveAdd(ghost, life, (o, u, k) => {
        mat.uniforms.uTime.value = timeSec;
        mat.uniforms.uLife.value = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;
        o.position.y = from.y + 0.02 * Math.sin(timeSec * 7);
        if (k) o.visible = false;
      });
    }
  }

  function phaseSkip(from, to) {
    if (!from || !to) return;
    const delta = _v.copy(to).sub(from);
    const len = Math.max(0.2, delta.length());
    const midDir = delta.clone().normalize();
    streaks.forEach((s, i) => {
      const u = (i + 0.5) / streaks.length;
      s.visible = true;
      s.position.lerpVectors(from, to, u); s.position.y += 1.0;
      s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), midDir);
      s.scale.set(1, len / 1.6 * 0.35, 1);
      const isMag = i % 2;
      s.position.add(_v2.set(isMag ? 0.06 : -0.06, 0, 0));
      liveAdd(s, 0.4, (o, t, k) => {
        const fade = 1 - t; o.material.opacity = fade * 0.85;
        o.scale.y = (len / 1.6) * 0.35 * (1 + t * 0.4);
        if (k) o.visible = false;
      });
    });
  }

  function shield(origin, dir, opts = {}) {
    if (!origin) return;
    const d = dir && dir.lengthSq() > 1e-6 ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const life = opts.duration ?? 4;
    shieldMesh.visible = true;
    shieldMesh.position.copy(origin).addScaledVector(d, 1.25); shieldMesh.position.y += 0.9;
    shieldMesh.lookAt(shieldMesh.position.clone().add(d));
    const mat = shieldMesh.material;
    liveAdd(shieldMesh, life, (o, u, k) => {
      const fade = u < 0.1 ? u / 0.1 : u > 0.85 ? 1 - (u - 0.85) / 0.15 : 1;
      mat.uniforms.uLife.value = fade;
      if (k) o.visible = false;
    });
  }

  function launchpad(origin, opts = {}) {
    if (!origin) return;
    pad.visible = true; pad.position.copy(origin); pad.position.y += 0.05;
    const burst = !!opts.burst;
    const life = burst ? 0.55 : (opts.duration ?? 3);
    liveAdd(pad, life, (o, u, k) => {
      padRings.forEach((r, i) => {
        const eq = 0.45 + 0.55 * Math.abs(Math.sin(timeSec * (6 + i * 2) + i));
        const s = burst ? 1 + u * (2.2 + i * 0.4) : 1;
        r.scale.setScalar(s);
        r.material.opacity = (burst ? (1 - u) : eq * (1 - Math.max(0, u - 0.8) / 0.2)) * 0.8;
      });
      if (k) o.visible = false;
    });
  }

  function beatFlash(origin) {
    if (!origin) return;
    flash.visible = true; flash.position.copy(origin); flash.position.y += 0.06;
    flash.scale.setScalar(1);
    liveAdd(flash, 0.18, (o, u, k) => {
      o.material.opacity = (1 - u) * 0.9; o.scale.setScalar(1 + u * 3.2);
      if (k) o.visible = false;
    });
    const r = rings.find((m) => !m.visible) || rings[rings.length - 1];
    r.visible = true; r.position.copy(origin); r.position.y += 0.07;
    r.material.color.setHex(0xffffff); r.scale.setScalar(0.6);
    liveAdd(r, 0.22, (o, u, k) => {
      o.scale.setScalar(0.6 + u * 4); o.material.opacity = (1 - u) * 0.7;
      if (k) o.visible = false;
    });
  }

  function setMixDistortion(v) { mix = Math.max(mix, Math.max(0, Math.min(1, v))); }
  let _stop = null;
  function hitStop(dur = 0.055, scale = 0.15) {
    const time = game.time;
    _stop = { t: dur, prev: time && time.scale !== undefined ? time.scale : 1 };
    if (time) { if (time.scale === undefined) time.scale = 1; time.scale = scale; }
  }

  function poseFromPlayer() {
    const p = game.player; if (!p || !p.position) return null;
    const yaw = p.yaw ?? p.object?.rotation.y ?? 0;
    return { origin: p.position.clone(), dir: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)) };
  }

  const bus = game.bus;
  const offs = [];
  const on = (name, fn) => { if (bus?.on) offs.push(bus.on(name, fn)); };
  on(Events.sidechain, (d) => {
    const pose = poseFromPlayer(); if (!pose) return;
    const src = d?.source || '';
    if (String(src).startsWith('melee')) melee(pose.origin, pose.dir, { onBeat: d.onBeat });
    else if (src === 'blast') blast(pose.origin, pose.dir, { onBeat: d.onBeat });
    if (d?.onBeat) beatFlash(pose.origin);
  });
  on(Events.blink, (d) => blink(d?.from, d?.to, { duration: 2.5 }));
  on(Events.beat, () => { beatPunch = 1.15; });
  on(Events.playerDamaged, (d) => setMixDistortion(Math.min(1, 0.35 + (d?.amount || 10) / 80)));
  on(Events.resonance, (d) => setMixDistortion(d?.value ?? 0));
  on('phaseSkip', (d) => phaseSkip(d?.from, d?.to));
  on('waveShield', (d) => shield(d?.origin, d?.dir, { duration: d?.duration }));
  on('launchpad', (d) => launchpad(d?.origin, { burst: !!d?.burst, duration: d?.duration }));

  function update(dt) {
    timeSec += dt;
    if (beatPunch > 1) beatPunch = Math.max(1, beatPunch - dt * 2);
    mix = Math.max(0, mix - dt * 0.6);
    glitchMat.uniforms.uTime.value = timeSec;
    glitchMat.uniforms.uAmt.value = mix;
    if (_stop) {
      _stop.t -= dt;
      if (_stop.t <= 0) { if (game.time && game.time.scale !== undefined) game.time.scale = _stop.prev; _stop = null; }
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const L = live[i]; L.t += dt; const u = Math.min(1, L.t / L.life); const done = L.t >= L.life;
      L.tick(L.obj, u, done);
      if (done) live.splice(i, 1);
    }
    // datamosh blocks
    let count = 0;
    for (let j = blockJobs.length - 1; j >= 0; j--) {
      const job = blockJobs[j]; job.t += dt; const u = job.t / job.life;
      if (u >= 1) { blockJobs.splice(j, 1); continue; }
      for (let i = 0; i < job.seeds.length; i++) {
        const s = job.seeds[i];
        dummy.position.set(job.center.x + s.x + 0.04 * Math.sin(timeSec * 30 + s.spin), job.center.y + s.y, job.center.z + s.z);
        const sc = s.s * (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85);
        dummy.scale.setScalar(Math.max(0.01, sc));
        dummy.rotation.set(s.spin, timeSec * 8 + s.spin, 0);
        dummy.updateMatrix();
        blockMesh.setMatrixAt(count++, dummy.matrix);
      }
    }
    blockMesh.count = count; blockMesh.instanceMatrix.needsUpdate = true; blockMesh.visible = count > 0;
    if (blockMesh.material) blockMesh.material.opacity = count ? 0.85 : 0;
  }

  function dispose() {
    offs.forEach((fn) => { try { fn(); } catch (e) { /* */ } });
    if (game.camera) game.camera.remove(overlay);
    scene?.remove(group);
  }

  const fx = {
    group, update, dispose,
    melee, blast, blink, phaseSkip, shield, launchpad, beatFlash, hitSparks,
    hitStop, setMixDistortion,
    // aliases matching the brief
    waveShield: shield, launch: (o) => launchpad(o, { burst: true }),
  };
  if (game) game.fx = fx;
  return fx;
}

export default initFX;
