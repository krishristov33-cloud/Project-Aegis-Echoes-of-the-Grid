// Dissonant Hulk boss-arena greybox (L3). C2 owns the boss itself (src/ai/hulk.js).
import * as THREE from 'three';
import { addBox, makeMat, createNavBuckets } from './greybox.js';

export function createArena(ctx) {
  const { scene, physics } = ctx;
  const group = new THREE.Group(); group.name = 'arena';
  const ids = [];
  const nav = createNavBuckets();
  const mats = {
    floor: makeMat({ color: 0x1a1214, roughness: 0.45, metalness: 0.2 }),
    wall: makeMat({ color: 0x140c10, roughness: 0.6, metalness: 0.15, emissive: 0x200810, emissiveIntensity: 0.2 }),
    tile: makeMat({ color: 0x221418, roughness: 0.4, metalness: 0.25 }),
  };
  const box = (opts) => { const r = addBox({ group, physics, mats }, opts); if (r.id) ids.push(r.id); nav.collect(opts, r.mesh); return r; };

  box({ id: 'arena-floor', size: [36, 0.8, 36], pos: [0, -0.4, 0], mat: mats.floor, userData: { solid: true, ground: true }, cast: false });
  // destructible-looking floor tiles (visual only until C2/C3)
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (x === 0 && z === 0) continue;
    const tile = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.08, 3.8), mats.tile);
    tile.position.set(x * 4.2, 0.02, z * 4.2);
    tile.userData = { destructible: true, tile: `${x},${z}` };
    group.add(tile);
  }
  box({ size: [36, 6, 1.2], pos: [0, 3, -18], mat: mats.wall, userData: { solid: true } });
  box({ size: [36, 6, 1.2], pos: [0, 3, 18], mat: mats.wall, userData: { solid: true } });
  box({ size: [1.2, 6, 36], pos: [-18, 3, 0], mat: mats.wall, userData: { solid: true } });
  box({ size: [1.2, 6, 36], pos: [18, 3, 0], mat: mats.wall, userData: { solid: true } });

  const hemi = new THREE.HemisphereLight(0xff6688, 0x080406, 0.35); group.add(hemi);
  const key = new THREE.DirectionalLight(0xff5577, 0.5);
  key.position.set(6, 16, 10); key.castShadow = true; group.add(key);
  const core = new THREE.PointLight(0xff2255, 1.4, 22, 1.5); core.position.set(0, 3, 0); group.add(core);

  const portals = [{ to: 'chamber', pos: new THREE.Vector3(0, 0, -16.5), radius: 1.6, label: 'ENGINE' }];
  const V = (x, z) => [x, 0, z];
  const spawns = [
    { kind: 'soldier', position: V(-10, 6), patrol: [V(-10, 6), V(-10, -6), V(-4, 10)], yaw: 0.4 },
    { kind: 'soldier', position: V(10, 6), patrol: [V(10, 6), V(10, -6), V(4, 10)], yaw: -0.4 },
    { kind: 'drone', position: V(0, 0), patrol: [V(-12, -12), V(12, -12), V(12, 12), V(-12, 12)] },
  ];

  scene.add(group);
  return {
    name: 'arena', group, spawn: new THREE.Vector3(0, 0, -10), faceYaw: 0, portals, enemies: [], physicsIds: ids, ...nav.asLevel(), spawns,
    fog: { color: 0x14080c, near: 8, far: 40 }, clearColor: 0x0c0608,
    update() {},
    unload() { scene.remove(group); for (const id of ids) physics.remove(id); },
  };
}
