// World Engine acoustic chamber greybox (L3). Puzzle logic is C4 — hook is updatePuzzle().
import * as THREE from 'three';
import { addBox, makeMat } from './greybox.js';

/** C4: acoustic puzzle logic against Krea's src/data/puzzle.json lives in acoustic-puzzle.js. */
export { updatePuzzle } from './acoustic-puzzle.js';
import { updatePuzzle } from './acoustic-puzzle.js';

export function createChamber(ctx) {
  const { scene, physics } = ctx;
  const group = new THREE.Group(); group.name = 'chamber';
  const ids = [];
  const mats = {
    obsidian: makeMat({ color: 0x0c1016, roughness: 0.25, metalness: 0.55, emissive: 0x061018, emissiveIntensity: 0.3 }),
    floor: makeMat({ color: 0x10161e, roughness: 0.3, metalness: 0.4 }),
    ring: makeMat({ color: 0x0a1820, roughness: 0.2, metalness: 0.5, emissive: 0x1ee0ff, emissiveIntensity: 0.45 }),
  };
  const box = (opts) => { const r = addBox({ group, physics, mats }, opts); if (r.id) ids.push(r.id); return r; };

  box({ id: 'ch-floor', size: [24, 0.6, 24], pos: [0, -0.3, 0], mat: mats.floor, userData: { solid: true, ground: true }, cast: false });
  // octagonal-ish walls
  const wallH = 7, wallT = 0.8, r = 11.5;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    box({ size: [8.2, wallH, wallT], pos: [Math.sin(a) * r, wallH / 2, Math.cos(a) * r], rot: [0, a, 0], mat: mats.obsidian, userData: { solid: true } });
  }
  // concentric platform rings (visual + later puzzle pads)
  for (const rad of [3.2, 5.6, 8.0]) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.08, 8, 48), mats.ring);
    torus.rotation.x = Math.PI / 2; torus.position.y = 0.04; group.add(torus);
  }
  box({ size: [1.6, 0.5, 1.6], pos: [0, 0.25, 0], mat: mats.ring, userData: { solid: true, ground: true } });

  const hemi = new THREE.HemisphereLight(0x446688, 0x05070c, 0.4); group.add(hemi);
  const key = new THREE.DirectionalLight(0x88d8ff, 0.45);
  key.position.set(-6, 14, 8); key.castShadow = true; group.add(key);
  const core = new THREE.PointLight(0x3df0ff, 2.0, 16, 1.4); core.position.set(0, 2, 0); group.add(core);

  const portals = [
    { to: 'arena', pos: new THREE.Vector3(0, 0, 10.2), radius: 1.6, label: 'HULK' },
    { to: 'cradle', pos: new THREE.Vector3(0, 0, -10.2), radius: 1.6, label: 'CRADLE' },
  ];
  scene.add(group);
  return {
    name: 'chamber', group, spawn: new THREE.Vector3(0, 0, -6), faceYaw: 0, portals, enemies: [], physicsIds: ids,
    fog: { color: 0x070b12, near: 6, far: 28 }, clearColor: 0x05070c,
    update(dt, playerPos, bus) { updatePuzzle({ ctx, dt, playerPos, bus, group }); },
    unload() { scene.remove(group); for (const id of ids) physics.remove(id); },
  };
}
