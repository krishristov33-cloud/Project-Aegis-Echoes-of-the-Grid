// Antarctic Cradle: an open ice crevasse under an aurora. Cold blue ice and moonlight against the amber heart
// of the Cradle ring. Colliders match the greybox (floor, four walls, two columns, two vault ledges).
import * as THREE from 'three';
import { addBox, makeMat } from './greybox.js';
import { mulberry32, placeProp, makeEnv, skyDome, deckMaps, wetDeck, lightCone, glowSprite, createMotes, portalGate } from './kit.js';

/** Jagged ice wall dressing: one instanced mesh of flat-shaded shards around the pit. */
function addShards(group, mat) {
  const rand = mulberry32(0xC4AD1E);
  const geom = new THREE.ConeGeometry(1, 1, 5, 1);
  geom.translate(0, 0.5, 0);
  const count = 190;
  const mesh = new THREE.InstancedMesh(geom, mat, count);
  const d = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const side = i % 4;
    const along = (rand() - 0.5) * 38;
    const back = i < 80 ? 16.2 + rand() * 1.2 : 18 + rand() * 9; // near row hugs the wall, far rows tower behind it
    const h = i < 80 ? 5 + rand() * 6 : 10 + rand() * 16;
    const r = i < 80 ? 1.1 + rand() * 1.3 : 2.5 + rand() * 3.5;
    if (side === 0) d.position.set(along, -0.5, -back);
    else if (side === 1) d.position.set(along, -0.5, back);
    else if (side === 2) d.position.set(-back, -0.5, along);
    else d.position.set(back, -0.5, along);
    d.rotation.set((rand() - 0.5) * 0.35, rand() * 6.28, (rand() - 0.5) * 0.35);
    d.scale.set(r, h, r);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = false;
  group.add(mesh);
}

export function createCradle(ctx) {
  const { scene, physics, props, renderer, bus } = ctx;
  const group = new THREE.Group(); group.name = 'cradle';
  const ids = [];
  const mats = {
    ice: makeMat({ color: 0x6fa6c4, roughness: 0.22, metalness: 0.05, emissive: 0x0b3a52, emissiveIntensity: 0.55, flat: true }),
    wall: makeMat({ color: 0x4d7c98, roughness: 0.3, metalness: 0.05, emissive: 0x082a3c, emissiveIntensity: 0.5 }),
    deck: makeMat({ color: 0x1b2a36, roughness: 0.4, metalness: 0.05 }),
    block: makeMat({ color: 0x86b9d2, roughness: 0.16, metalness: 0.05, emissive: 0x0d4660, emissiveIntensity: 0.5, flat: true }),
  };
  mats.concrete = mats.wall;
  for (const m of Object.values(mats)) m.envMapIntensity = 1.5;
  const box = (opts) => { const r = addBox({ group, physics, mats }, opts); if (r.id) ids.push(r.id); return r; };

  // ---------- colliders ----------
  box({ id: 'cradle-floor', size: [32, 0.8, 32], pos: [0, -0.4, 0], mat: mats.deck, userData: { solid: true, ground: true }, cast: false });
  box({ size: [32, 8, 1.2], pos: [0, 4, -16], mat: mats.wall, userData: { solid: true }, cast: false });
  box({ size: [32, 8, 1.2], pos: [0, 4, 16], mat: mats.wall, userData: { solid: true }, cast: false });
  box({ size: [1.2, 8, 32], pos: [-16, 4, 0], mat: mats.wall, userData: { solid: true }, cast: false });
  box({ size: [1.2, 8, 32], pos: [16, 4, 0], mat: mats.wall, userData: { solid: true }, cast: false });
  // ice columns: box colliders, hexagonal crystal visuals
  for (const [x, z, h] of [[-6, -4, 6], [7, 3, 5]]) {
    const r = box({ size: [2.2, h, 2.2], pos: [x, h / 2, z], mat: mats.ice, userData: { solid: true } });
    r.mesh.visible = false;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.5, h, 6, 1), mats.ice);
    col.position.set(x, h / 2, z); col.rotation.y = 0.4; col.castShadow = true; col.receiveShadow = true;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.4, 6, 1), mats.ice);
    tip.position.set(x, h + 1.2, z); tip.rotation.y = 0.4; tip.castShadow = true;
    const side = new THREE.Mesh(new THREE.ConeGeometry(0.6, h * 0.7, 5, 1), mats.ice);
    side.position.set(x + 1.0, h * 0.35, z - 0.7); side.rotation.z = -0.22; side.castShadow = true;
    group.add(col, tip, side);
  }
  // vault ledges: cut ice blocks
  box({ size: [3.0, 0.8, 3.0], pos: [0, 0.4, 6], mat: mats.block, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [1.4, 0.7, 1.4], pos: [-3, 0.35, 3], mat: mats.block, userData: { solid: true, ground: true, vaultable: true } });

  // ---------- ice floor ----------
  const deck = wetDeck(group, {
    w: 32, d: 32, x: 0, z: 0, y: 0,
    maps: deckMaps({ w: 32, d: 32, seed: 0x1CE, base: '#31485a', panel: 0, puddles: 34, puddleSize: [1.5, 5], grime: 14000, dryRough: 120, rings: [4.2, 4.5, 9], ringColor: 'rgba(255,190,110,0.35)' }),
    envMapIntensity: 1.3, normalScale: 0.3, normalRepeat: 0.5,
    reflect: { strength: 0.8, base: 0.22, blur: 0.009, ripple: 0.0 },
  });

  addShards(group, mats.ice);

  // ---------- props ----------
  const P = (name, x, z, o) => placeProp(group, physics, ids, props, name, x, z, o);
  P('crystals', -12.6, -12.4, { yaw: 0.4, collide: true });
  P('crystals', 12.4, -11.6, { yaw: 2.1, collide: true, scale: 0.8 });
  P('crystals', -12.8, 11.4, { yaw: 3.6, collide: true, scale: 0.9 });
  P('crystals', 12.6, 12.2, { yaw: 5.0, collide: true });
  P('crate', -10.5, 2, { yaw: 0.5, collide: true });
  P('crate', 11, -3.5, { yaw: -0.3, collide: true });
  P('monolith', 0, 24, { yaw: Math.PI, y: -1 });
  P('monolith', -24, -6, { yaw: 1.2, scale: 0.7, y: -1 });
  P('monolith', 25, 8, { yaw: -1.9, scale: 0.8, y: -1 });
  // the Cradle heart: a resonance ring hanging over the floor seal
  const ring = P('resonance_ring', 0, 0, { scale: 0.75, y: 2.6 });
  const heart = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(3) }));
  heart.position.set(0, 5.6, 0); group.add(heart);
  const heartGlow = glowSprite(0xffa040, 7, 0.55); heartGlow.position.copy(heart.position); group.add(heartGlow);
  const heartCone = lightCone({ color: 0xffa040, height: 5.6, radius: 4.4, topRadius: 0.3, opacity: 0.3 });
  heartCone.position.set(0, 5.6, 0); group.add(heartCone);
  const crystalGlows = [];
  for (const [x, z, c] of [[-12.6, -12.4, 0x3df0ff], [12.4, -11.6, 0x7a8cff], [-12.8, 11.4, 0x7a8cff], [12.6, 12.2, 0x3df0ff]]) {
    const l = new THREE.PointLight(c, 10, 14, 1.6); l.position.set(x * 0.9, 1.6, z * 0.9); group.add(l);
    const g = glowSprite(c, 5, 0.35); g.position.set(x, 1.6, z); group.add(g);
    crystalGlows.push({ l, g, ph: x + z });
  }

  // ---------- sky + air ----------
  const sky = skyDome({ top: 0x020611, horizon: 0x0a2233, glow: 0x0d3040, glowPower: 6, stars: 1.6, aurora: 1.15, auroraA: 0x35ffb0, auroraB: 0x8a5cff, radius: 150 });
  group.add(sky);
  const snow = createMotes(group, { count: 700, area: 36, height: 14, color: 0xdff2ff, size: 0.06, velocity: [-0.7, -1.3, 0.3], sway: 0.5, opacity: 0.75 });

  // ---------- lighting ----------
  group.add(new THREE.HemisphereLight(0x9fd0ff, 0x0a1622, 0.75));
  const key = new THREE.DirectionalLight(0xbcd6ff, 1.7);
  key.position.set(10, 20, -8); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.camera.left = -20; key.shadow.camera.right = 20; key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.03; key.shadow.radius = 3;
  group.add(key); group.add(key.target);
  const auroraRim = new THREE.DirectionalLight(0x40ffc0, 0.9); auroraRim.position.set(-10, 8, 12); group.add(auroraRim);
  const violetRim = new THREE.DirectionalLight(0x8a6cff, 0.6); violetRim.position.set(12, 6, 10); group.add(violetRim);
  const amber = new THREE.PointLight(0xffa040, 30, 20, 1.5); amber.position.set(0, 3.4, 0); group.add(amber);

  let envRT = null;
  if (renderer) {
    envRT = makeEnv(renderer, {
      sky: 0x0a1c2a, hemiTop: 0x8fd0f0, hemiBottom: 0x0a1420, hemi: 1.0,
      cards: [
        { color: 0x35ffb0, gain: 1.6, pos: [-12, 14, 14], size: [26, 6] },
        { color: 0x8a5cff, gain: 1.3, pos: [14, 16, 8], size: [20, 6] },
        { color: 0xbcd6ff, gain: 2.0, pos: [10, 20, -8], size: [6, 6] },
        { color: 0xffa040, gain: 1.6, pos: [0, 2, -6], size: [4, 4] },
      ],
    });
    scene.environment = envRT.texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.8;
  }

  // ---------- flow: clear the patrol, then the gate to the engine opens ----------
  const portals = [
    { to: 'chamber', pos: new THREE.Vector3(0, 0, 14.2), radius: 1.6, label: 'WORLD ENGINE', locked: true },
  ];
  let arch = null;
  if (props?.gate_arch?.root) {
    arch = props.gate_arch.root.clone(true);
    arch.scale.multiplyScalar(0.62);
    arch.position.set(0, props.gate_arch.root.position.y * 0.62, 0.7);
  }
  const gate = portalGate(group, portals[0], { color: 0xffa040, arch });

  scene.add(group);
  let t = 0;
  let sawEnemies = false;
  let cleared = false;
  return {
    name: 'cradle', group, spawn: new THREE.Vector3(0, 0, -11), faceYaw: 0, portals, enemies: [], physicsIds: ids,
    fog: { color: 0x0a1c28, density: 0.014 }, clearColor: 0x030811,
    exposure: 1.15, far: 220,
    update(dt, playerPos, busArg) {
      t += dt;
      deck.update(t);
      gate.update(dt);
      sky.userData.update(t);
      sky.position.set(playerPos.x, 0, playerPos.z);
      snow.update(dt, playerPos, -0.5);
      if (ring) { ring.rotation.y = t * 0.25; ring.position.y += Math.sin(t * 0.9) * 0.0015; }
      heart.rotation.y = t * 1.2; heart.position.y = 5.6 + Math.sin(t * 1.4) * 0.15;
      const pulse = 0.85 + 0.15 * Math.sin(t * 2.1);
      amber.intensity = 30 * pulse;
      heartGlow.material.opacity = 0.55 * pulse;
      for (const c of crystalGlows) { const k = 0.8 + 0.2 * Math.sin(t * 1.3 + c.ph); c.l.intensity = 10 * k; c.g.material.opacity = 0.35 * k; }
      if (!cleared) {
        const list = (globalThis.game?.enemies ?? []).filter((e) => e.isEnemy);
        if (list.length) sawEnemies = true;
        // open once the patrol is down; also open if no patrol ever arrives (AI failed to build)
        if ((sawEnemies && list.every((e) => e.dead)) || (!sawEnemies && t > 12)) {
          cleared = true;
          portals[0].locked = false;
          (busArg ?? bus)?.emit('levelState', { level: 'cradle', phase: 'clear' });
        }
      }
    },
    unload() {
      snow.dispose();
      deck.dispose();
      if (envRT && scene.environment === envRT.texture) scene.environment = null;
      envRT?.dispose(); envRT = null;
      scene.remove(group);
      for (const id of ids) physics.remove(id);
    },
  };
}
