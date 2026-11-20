// Readability VFX for enemy attacks (W3): everything that hurts is visible before and while it happens.
//   - aim lasers: muzzle -> the weapon's aim point while a soldier winds up (dim, brightening) and fires (bright)
//   - tracers + muzzle flashes + impact sparks on `enemyShot`
//   - drone dive: tracking beam during the wind-up, locked line + ground ring during the dive
// All pooled InstancedMeshes: 4 draw calls in total regardless of enemy count.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function beamMesh(count, color) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0, 0.5); // unit length along +Z from the origin
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const mesh = new THREE.InstancedMesh(g, mat, count);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < count; i++) {
    mesh.setMatrixAt(i, HIDDEN);
    mesh.setColorAt(i, _c.set(color));
  }
  mesh.renderOrder = 5;
  return mesh;
}

function setBeam(mesh, i, from, to, width, color, gain) {
  _d.subVectors(to, from);
  const len = _d.length();
  if (len < 1e-3) return mesh.setMatrixAt(i, HIDDEN);
  _q.setFromUnitVectors(Z, _d.divideScalar(len));
  mesh.setMatrixAt(i, _m.compose(from, _q, _s.set(width, width, len)));
  mesh.setColorAt(i, _c.set(color).multiplyScalar(gain));
}

export function createEnemyFx({ bus, scene, cfg = {} }) {
  const F = {
    laserColor: 0xff2d6f, tracerColor: 0xffc27a, diveColor: 0xff7a2d,
    laserWidth: 0.018, tracerWidth: 0.035, tracerSpeed: 140, tracerLength: 5, flashTime: 0.06, maxLasers: 8, maxTracers: 24,
    ...cfg,
  };
  const group = new THREE.Group();
  group.name = 'enemy-fx';
  scene.add(group);

  const lasers = beamMesh(F.maxLasers + 4, F.laserColor);
  const tracers = beamMesh(F.maxTracers, F.tracerColor);
  const flashGeo = new THREE.IcosahedronGeometry(1, 1);
  const flashes = new THREE.InstancedMesh(flashGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), 32);
  flashes.frustumCulled = false;
  flashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < 32; i++) {
    flashes.setMatrixAt(i, HIDDEN);
    flashes.setColorAt(i, _c.set(0xffffff));
  }
  const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
  ringGeo.rotateX(-Math.PI / 2);
  const rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), 6);
  rings.frustumCulled = false;
  for (let i = 0; i < 6; i++) {
    rings.setMatrixAt(i, HIDDEN);
    rings.setColorAt(i, _c.set(0xffffff));
  }
  group.add(lasers, tracers, flashes, rings);

  const shots = []; // { from, to, len, t }
  const pops = []; // { pos, t, life, size, color }

  function pop(pos, size, color, life = F.flashTime) {
    if (pops.length >= 32) pops.shift();
    pops.push({ pos: pos.clone(), t: 0, life, size, color });
  }

  const offs = [
    bus.on('enemyShot', ({ from, to, hit } = {}) => {
      if (!from || !to) return;
      if (shots.length >= F.maxTracers) shots.shift();
      shots.push({ from: from.clone(), to: to.clone(), len: from.distanceTo(to), t: 0, hit: !!hit });
      pop(from, 0.07, F.tracerColor);
    }),
  ];

  return {
    group,
    /** Short additive pop (hit sparks, drone impact...). */
    pop,

    /**
     * @param {number} dt
     * @param {object[]} enemies  live AI enemies (soldiers, drones)
     * @param {object} player
     */
    update(dt, enemies, player) {
      // --- lasers ---
      let li = 0;
      let ri = 0;
      const max = lasers.count;
      for (const e of enemies) {
        if (e.dead || li >= max) continue;
        const w = e.weapon;
        if (w?.aiming) {
          const from = e.muzzleWorld ?? _p.copy(e.position).setY(e.position.y + 1.4);
          const k = w.aimProgress;
          const firing = w.phase === 'burst';
          const pulse = firing ? 1 : 0.25 + 0.75 * k * (0.75 + 0.25 * Math.sin(k * k * 60));
          setBeam(lasers, li++, from, w.aimPoint, F.laserWidth * (firing ? 1.6 : 0.8 + k), F.laserColor, 0.5 + 1.6 * pulse);
          if (pops.length < 30) pop(w.aimPoint, 0.05 + 0.05 * k, F.laserColor, 0.03);
        }
        const d = e.dive;
        if (d && player && li < max) {
          if (d.phase === 'windup') {
            const k = Math.min(1, d.t / Math.max(0.05, d.dur));
            _p.copy(player.position).setY(player.position.y + 0.9);
            setBeam(lasers, li++, e.position, _p, 0.03 + 0.07 * k, F.diveColor, 0.4 + 1.8 * k);
            if (ri < 6) {
              const r = 1.6 - 0.5 * k;
              rings.setMatrixAt(ri, _m.compose(_p.set(player.position.x, player.position.y + 0.06, player.position.z), _q.identity(), _s.set(r, 1, r)));
              rings.setColorAt(ri++, _c.set(F.diveColor).multiplyScalar(0.5 + k));
            }
          } else if (d.phase === 'dive') {
            setBeam(lasers, li++, d.from, d.to, 0.07, F.diveColor, 1.4);
          }
        }
      }
      for (let i = li; i < max; i++) lasers.setMatrixAt(i, HIDDEN);
      for (let i = ri; i < 6; i++) rings.setMatrixAt(i, HIDDEN);
      lasers.instanceMatrix.needsUpdate = true;
      if (lasers.instanceColor) lasers.instanceColor.needsUpdate = true;
      rings.instanceMatrix.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;

      // --- tracers: a streak that travels from the muzzle to the impact ---
      for (let i = shots.length - 1; i >= 0; i--) {
        const s = shots[i];
        s.t += dt;
        if (s.t * F.tracerSpeed > s.len + F.tracerLength) {
          if (!s.hit) pop(s.to, 0.12, F.tracerColor, 0.08);
          shots.splice(i, 1);
        }
      }
      for (let i = 0; i < F.maxTracers; i++) {
        const s = shots[i];
        if (!s) {
          tracers.setMatrixAt(i, HIDDEN);
          continue;
        }
        const head = Math.min(s.len, s.t * F.tracerSpeed);
        const tail = Math.max(0, s.t * F.tracerSpeed - F.tracerLength);
        if (tail >= head) {
          tracers.setMatrixAt(i, HIDDEN);
          continue;
        }
        _d.subVectors(s.to, s.from).divideScalar(s.len || 1);
        const a = _p.copy(s.from).addScaledVector(_d, tail);
        const b = _s.copy(s.from).addScaledVector(_d, head).clone();
        setBeam(tracers, i, a, b, F.tracerWidth, F.tracerColor, 2.2);
      }
      tracers.instanceMatrix.needsUpdate = true;
      if (tracers.instanceColor) tracers.instanceColor.needsUpdate = true;

      // --- pops ---
      for (let i = pops.length - 1; i >= 0; i--) {
        pops[i].t += dt;
        if (pops[i].t >= pops[i].life) pops.splice(i, 1);
      }
      for (let i = 0; i < 32; i++) {
        const f = pops[i];
        if (!f) {
          flashes.setMatrixAt(i, HIDDEN);
          continue;
        }
        const u = 1 - f.t / f.life;
        const sz = f.size * (0.6 + 0.8 * (1 - u));
        flashes.setMatrixAt(i, _m.compose(f.pos, _q.identity(), _s.set(sz, sz, sz)));
        flashes.setColorAt(i, _c.set(f.color).multiplyScalar(2.5 * u));
      }
      flashes.instanceMatrix.needsUpdate = true;
      if (flashes.instanceColor) flashes.instanceColor.needsUpdate = true;
    },

    clear() {
      shots.length = 0;
      pops.length = 0;
    },

    dispose() {
      offs.forEach((o) => o?.());
      group.removeFromParent();
      for (const m of [lasers, tracers, flashes, rings]) {
        m.geometry.dispose();
        m.material.dispose();
      }
    },
  };
}
