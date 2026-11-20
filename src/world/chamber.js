// World Engine acoustic chamber: a polished obsidian resonator. Light ribs on the walls breathe with the beat,
// the floor mirrors the room, and the core hangs under a turning resonance ring.
// Puzzle logic lives in acoustic-puzzle.js (data: src/data/puzzle.json); this file owns the room, the gate to the
// arena (locked until `puzzleSolved`) and the room's reaction to puzzle events.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addBox, makeMat } from './greybox.js';
import { placeProp, makeEnv, deckMaps, wetDeck, lightCone, glowSprite, createMotes, portalGate } from './kit.js';
import { updatePuzzle, disposePuzzle, isSolved } from './acoustic-puzzle.js';

/** C4: acoustic puzzle logic against src/data/puzzle.json lives in acoustic-puzzle.js. */
export { updatePuzzle } from './acoustic-puzzle.js';

const CYAN = new THREE.Color(0x3df0ff);
const GREEN = new THREE.Color(0x6cffb0);
const RED = new THREE.Color(0xff2040);

export function createChamber(ctx) {
  const { scene, physics, props, renderer, bus } = ctx;
  const group = new THREE.Group(); group.name = 'chamber';
  const ids = [];
  const mats = {
    obsidian: makeMat({ color: 0x0b0f15, roughness: 0.16, metalness: 0.75, emissive: 0x04121c, emissiveIntensity: 0.4 }),
    floor: makeMat({ color: 0x07090d, roughness: 0.3, metalness: 0.5 }),
    core: makeMat({ color: 0x0a141c, roughness: 0.2, metalness: 0.8, emissive: 0x0a3848, emissiveIntensity: 0.6 }),
  };
  mats.concrete = mats.obsidian;
  mats.obsidian.envMapIntensity = 1.6;
  const box = (opts) => { const r = addBox({ group, physics, mats }, opts); if (r.id) ids.push(r.id); return r; };

  // ---------- colliders ----------
  box({ id: 'ch-floor', size: [24, 0.6, 24], pos: [0, -0.3, 0], mat: mats.floor, userData: { solid: true, ground: true }, cast: false });
  const wallH = 9, wallT = 0.8, r = 11.5;
  const ribs = [];
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    box({ size: [9.6, wallH, wallT], pos: [Math.sin(a) * r, wallH / 2, Math.cos(a) * r], rot: [0, a, 0], mat: mats.obsidian, userData: { solid: true }, cast: false });
    // three vertical light ribs per wall panel + a base strip
    for (const off of [-3, 0, 3]) {
      const g = new THREE.BoxGeometry(0.1, wallH - 1.2, 0.06);
      g.translate(off, wallH / 2, -wallT / 2 - 0.04);
      g.rotateY(a);
      g.translate(Math.sin(a) * r, 0, Math.cos(a) * r);
      ribs.push(g);
    }
    const base = new THREE.BoxGeometry(9.2, 0.06, 0.06);
    base.translate(0, 0.25, -wallT / 2 - 0.04);
    base.rotateY(a);
    base.translate(Math.sin(a) * r, 0, Math.cos(a) * r);
    ribs.push(base);
  }
  const ribMat = new THREE.MeshBasicMaterial({ color: CYAN.clone().multiplyScalar(1.6) });
  const ribMesh = new THREE.Mesh(mergeGeometries(ribs), ribMat);
  ribs.forEach((g) => g.dispose());
  group.add(ribMesh);
  // core pedestal (collider) with the altar prop as its visual when available
  const ped = box({ size: [1.6, 0.5, 1.6], pos: [0, 0.25, 0], mat: mats.core, userData: { solid: true, ground: true } });
  const altar = placeProp(group, null, ids, props, 'altar', 0, 0, { scale: 0.62 });
  if (altar) ped.mesh.visible = false;

  // ---------- mirror floor with the resonance rings etched in ----------
  const deck = wetDeck(group, {
    w: 24, d: 24, x: 0, z: 0, y: 0,
    maps: deckMaps({ w: 24, d: 24, seed: 0x0B51D, base: '#090c11', panel: 3, puddles: 0, grime: 5000, dryRough: 70, rings: [2.4, 5.6, 8.6], ringColor: 'rgba(40,150,180,0.55)' }),
    metalness: 0.4, envMapIntensity: 1.2, normalScale: 0.08, normalRepeat: 0.6,
    reflect: { strength: 0.9, base: 0.62, blur: 0.005, ripple: 0.0 },
  });

  // floor rings: one lights for each solved stage
  const stageRings = [2.4, 8.6, 10.6].map((rad) => {
    const mat = new THREE.MeshBasicMaterial({ color: CYAN.clone().multiplyScalar(0.5), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(new THREE.RingGeometry(rad - 0.05, rad + 0.05, 96), mat);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.renderOrder = 2;
    group.add(m);
    return { mat, level: 0.5, target: 0.5 };
  });

  // ---------- ceiling ----------
  const ceil = new THREE.Mesh(new THREE.ConeGeometry(13.5, 5, 8, 1, true), new THREE.MeshStandardMaterial({ color: 0x06080c, roughness: 0.4, metalness: 0.6, side: THREE.BackSide }));
  ceil.position.y = wallH + 2.5; ceil.rotation.y = Math.PI / 8;
  group.add(ceil);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(6.2, 0.07, 8, 96), new THREE.MeshBasicMaterial({ color: CYAN.clone().multiplyScalar(2.2) }));
  halo.rotation.x = Math.PI / 2; halo.position.y = wallH + 0.4;
  group.add(halo);

  // ---------- the core ----------
  const ring = placeProp(group, null, ids, props, 'resonance_ring', 0, 0, { scale: 0.42, y: 2.2 });
  const coreMat = new THREE.MeshBasicMaterial({ color: CYAN.clone().multiplyScalar(1.3) });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), coreMat);
  core.position.set(0, 1.75, 0); group.add(core);
  const coreGlow = glowSprite(0x3df0ff, 4.5, 0.5); coreGlow.position.copy(core.position); group.add(coreGlow);
  const coreCone = lightCone({ color: 0x3df0ff, height: wallH - 1, radius: 2.4, topRadius: 0.5, opacity: 0.22 });
  coreCone.position.set(0, wallH + 0.4, 0); group.add(coreCone);
  const coreLight = new THREE.PointLight(0x3df0ff, 26, 20, 1.5); coreLight.position.set(0, 2.4, 0); group.add(coreLight);

  // speaker stacks on the diagonal walls (clear of the patrols and the pad ring)
  const P = (name, x, z, o) => placeProp(group, physics, ids, props, name, x, z, o);
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
    P('speaker_stack', Math.sin(a) * 9.6, Math.cos(a) * 9.6, { yaw: a + Math.PI, collide: true, scale: 0.9 });
  }
  P('crystals', -9.9, 0, { yaw: 1.2, collide: true, scale: 0.5 });
  P('crystals', 9.9, 0, { yaw: -1.9, collide: true, scale: 0.5 });

  const motes = createMotes(group, { count: 260, area: 22, height: 9, color: 0x7fe8ff, size: 0.045, velocity: [0.05, 0.12, 0.03], sway: 0.35, opacity: 0.7, twinkle: 0.7 });

  // ---------- lighting ----------
  group.add(new THREE.HemisphereLight(0x5a86a8, 0x05070c, 0.5));
  const key = new THREE.DirectionalLight(0x9fdcff, 1.1);
  key.position.set(-5, 16, 6); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 40;
  key.shadow.camera.left = -14; key.shadow.camera.right = 14; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14;
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.03; key.shadow.radius = 3;
  group.add(key); group.add(key.target);
  const rimA = new THREE.DirectionalLight(0xff3d8a, 0.7); rimA.position.set(8, 5, -10); group.add(rimA);
  const rimB = new THREE.DirectionalLight(0x3df0ff, 0.9); rimB.position.set(-9, 6, 9); group.add(rimB);

  let envRT = null;
  if (renderer) {
    envRT = makeEnv(renderer, {
      sky: 0x05080c, hemiTop: 0x4a7a98, hemiBottom: 0x05070c, hemi: 0.8,
      cards: [
        { color: 0x3df0ff, gain: 2.4, pos: [0, 12, 0], size: [10, 10] },
        { color: 0x3df0ff, gain: 1.6, pos: [-16, 4, 0], size: [2, 12] },
        { color: 0x3df0ff, gain: 1.6, pos: [16, 4, 0], size: [2, 12] },
        { color: 0xff3d8a, gain: 1.4, pos: [0, 4, -16], size: [2, 12] },
        { color: 0x3df0ff, gain: 1.6, pos: [0, 4, 16], size: [2, 12] },
      ],
    });
    scene.environment = envRT.texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.7;
  }

  // ---------- gate to the arena: locked until the engine is tuned ----------
  const portals = [
    { to: 'arena', pos: new THREE.Vector3(0, 0, 10.0), radius: 1.5, label: 'THE HULK', locked: !isSolved('chamber') },
  ];
  let arch = null;
  if (props?.gate_arch?.root) {
    arch = props.gate_arch.root.clone(true);
    arch.scale.multiplyScalar(0.58);
    arch.position.set(0, props.gate_arch.root.position.y * 0.58, 0.5);
  }
  const gate = portalGate(group, portals[0], { color: 0xff3d8a, arch });

  // ---------- room reactions to the puzzle ----------
  let beatPulse = 0;
  let notePulse = 0;
  let failPulse = 0;
  let solved = isSolved('chamber');
  const noteColor = new THREE.Color(0x3df0ff);
  const mine = (e) => (e?.level ?? 'chamber') === 'chamber';
  const offs = [
    bus.on('beat', () => { beatPulse = 1; }),
    bus.on('puzzleState', (e) => {
      if (!mine(e)) return;
      stageRings.forEach((s, i) => { s.target = i < e.stage ? 2.6 : 0.5; });
      if (e.phase === 'solved') { solved = true; portals[0].locked = false; }
    }),
    bus.on('puzzleNote', (e) => { if (mine(e)) notePulse = 1; }),
    bus.on('puzzleFail', (e) => { if (mine(e)) failPulse = 1; }),
    bus.on('puzzleSolved', (e) => {
      if (!mine(e)) return;
      solved = true;
      portals[0].locked = false;
      bus.emit('levelState', { level: 'chamber', phase: 'clear' });
    }),
  ];

  scene.add(group);
  let t = 0;
  const tmp = new THREE.Color();
  return {
    name: 'chamber', group, spawn: new THREE.Vector3(0, 0, -9), faceYaw: 0, portals, enemies: [], physicsIds: ids,
    fog: { color: 0x05090f, density: 0.02 }, clearColor: 0x030508,
    exposure: 1.15, far: 120,
    update(dt, playerPos, busArg) {
      t += dt;
      updatePuzzle({ ctx, dt, playerPos, bus: busArg ?? bus, group });
      deck.update(t);
      gate.update(dt);
      motes.update(dt, { x: 0, y: 0, z: 0 }, 0);
      beatPulse = Math.max(0, beatPulse - dt * 4.5);
      notePulse = Math.max(0, notePulse - dt * 2.2);
      failPulse = Math.max(0, failPulse - dt * 1.6);
      const base = solved ? GREEN : CYAN;
      tmp.copy(base).lerp(RED, failPulse);
      const k = 1.0 + beatPulse * 0.7 + notePulse * 1.4;
      ribMat.color.copy(tmp).multiplyScalar(1.1 * k);
      halo.material.color.copy(tmp).multiplyScalar(1.8 * k);
      coreMat.color.copy(tmp).multiplyScalar(1.3 + beatPulse * 0.5 + notePulse * 1.6);
      coreLight.color.copy(tmp);
      coreLight.intensity = 16 + beatPulse * 5 + notePulse * 12;
      coreGlow.material.color.copy(tmp);
      coreGlow.material.opacity = 0.22 + beatPulse * 0.08 + notePulse * 0.2;
      coreCone.material.uniforms.uColor.value.copy(tmp);
      core.rotation.y = t * 0.9; core.rotation.x = t * 0.5;
      core.position.y = 1.75 + Math.sin(t * 1.6) * 0.06;
      core.scale.setScalar(1 + beatPulse * 0.12 + notePulse * 0.25);
      if (ring) { ring.rotation.y = t * (solved ? 0.9 : 0.3); ring.rotation.x = Math.sin(t * 0.4) * 0.08; }
      for (const s of stageRings) {
        s.level += (s.target - s.level) * Math.min(1, dt * 4);
        s.mat.color.copy(s.target > 1 ? GREEN : noteColor).lerp(RED, failPulse).multiplyScalar(s.level * (1 + beatPulse * 0.25));
      }
    },
    unload() {
      offs.forEach((off) => off?.());
      motes.dispose();
      deck.dispose();
      if (envRT && scene.environment === envRT.texture) scene.environment = null;
      envRT?.dispose(); envRT = null;
      disposePuzzle(group);
      scene.remove(group);
      for (const id of ids) physics.remove(id);
    },
  };
}
