// Antarctic Cradle greybox (L3). Caves / warm amber vs the rooftop's cyan night.
import * as THREE from 'three';
import { addBox, makeMat, createNavBuckets } from './greybox.js';

export function createCradle(ctx) {
  const { scene, physics } = ctx;
  const group = new THREE.Group(); group.name = 'cradle';
  const ids = [];
  const nav = createNavBuckets();
  const mats = {
    rock: makeMat({ color: 0x2a241c, roughness: 0.85, metalness: 0.05 }),
    floor: makeMat({ color: 0x3a3226, roughness: 0.7, metalness: 0.08 }),
    moss: makeMat({ color: 0x1c2a18, roughness: 0.9, metalness: 0.02, emissive: 0x0a1808, emissiveIntensity: 0.15 }),
    amber: makeMat({ color: 0x20180c, roughness: 0.4, metalness: 0.1, emissive: 0xffaa44, emissiveIntensity: 0.55 }),
  };
  const box = (opts) => { const r = addBox({ group, physics, mats }, opts); if (r.id) ids.push(r.id); nav.collect(opts, r.mesh); return r; };

  box({ id: 'cradle-floor', size: [32, 0.8, 32], pos: [0, -0.4, 0], mat: mats.floor, userData: { solid: true, ground: true }, cast: false });
  // cavern walls
  box({ size: [32, 8, 1.2], pos: [0, 4, -16], mat: mats.rock, userData: { solid: true } });
  box({ size: [32, 8, 1.2], pos: [0, 4, 16], mat: mats.rock, userData: { solid: true } });
  box({ size: [1.2, 8, 32], pos: [-16, 4, 0], mat: mats.rock, userData: { solid: true } });
  box({ size: [1.2, 8, 32], pos: [16, 4, 0], mat: mats.rock, userData: { solid: true } });
  // pillars + ledges
  box({ size: [2.2, 6, 2.2], pos: [-6, 3, -4], mat: mats.rock, userData: { solid: true } });
  box({ size: [2.2, 5, 2.2], pos: [7, 2.5, 3], mat: mats.rock, userData: { solid: true } });
  box({ size: [3.0, 0.8, 3.0], pos: [0, 0.4, 6], mat: mats.moss, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [1.4, 0.7, 1.4], pos: [-3, 0.35, 3], mat: mats.moss, userData: { solid: true, ground: true, vaultable: true } });

  const hemi = new THREE.HemisphereLight(0xffd9a0, 0x0a0806, 0.5); group.add(hemi);
  const key = new THREE.DirectionalLight(0xffc080, 0.7);
  key.position.set(8, 14, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); group.add(key);
  const glow = new THREE.PointLight(0xffaa55, 1.6, 20, 1.4); glow.position.set(0, 2.2, 0); group.add(glow);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), mats.amber);
  crystal.position.set(0, 1.4, -8); group.add(crystal);

  const portals = [
    { to: 'chamber', pos: new THREE.Vector3(0, 0, 14.5), radius: 1.6, label: 'ENGINE' },
    { to: 'rooftop', pos: new THREE.Vector3(0, 0, -14.5), radius: 1.6, label: 'SURFACE' },
  ];
  const V = (x, z) => [x, 0, z];
  const spawns = [
    { kind: 'soldier', position: V(-8, 4), patrol: [V(-8, 4), V(-8, -8), V(-3, 8)], yaw: 0.5 },
    { kind: 'soldier', position: V(8, 6), patrol: [V(8, 6), V(8, -6), V(3, 8)], yaw: -0.5 },
    { kind: 'drone', position: V(0, 0), patrol: [V(-10, -10), V(10, -10), V(10, 10), V(-10, 10)] },
  ];

  scene.add(group);
  return {
    name: 'cradle', group, spawn: new THREE.Vector3(0, 0, -8), faceYaw: 0, portals, enemies: [], physicsIds: ids, ...nav.asLevel(), spawns,
    fog: { color: 0x1a140e, near: 10, far: 42 }, clearColor: 0x0e0a08,
    update() {},
    unload() { scene.remove(group); for (const id of ids) physics.remove(id); },
  };
}
