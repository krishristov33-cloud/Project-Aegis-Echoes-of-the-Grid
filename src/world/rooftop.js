// Sofia rooftop escape: rainy neon night. Wet reflective deck with puddles, neon signage, searchlights,
// a layered skyline in haze, and rim light so characters read against the dark.
// Colliders are unchanged from the greybox (sprint / vault lane, uneven IK patch, ramp, lower roof).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addBox, makeMat } from './greybox.js';
import { createRain } from './rain.js';
import { mulberry32, placeProp, makeEnv, skyDome, deckMaps, wetDeck, lightCone, glowSprite, neonText, portalGate } from './kit.js';

function trim(list, pos, size) {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  g.translate(pos[0], pos[1], pos[2]);
  list.push(g);
}

function trimMesh(group, list, color, gain = 2.2) {
  if (!list.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(list), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain) }));
  list.forEach((g) => g.dispose());
  mesh.castShadow = false; mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}

/** Two rings of towers merged into one mesh each, with instanced lit windows facing the roof. */
function addSkyline(group, beacons) {
  const rand = mulberry32(0xAE615);
  // x, z, w, h, d
  const near = [
    [-8, -36, 9, 22, 8], [8, -34, 11, 26, 9], [24, -26, 10, 18, 8], [32, -12, 8, 20, 8], [30, 8, 9, 16, 7],
    [-32, -10, 10, 24, 8], [-30, 10, 8, 14, 7], [18, -42, 14, 20, 10], [-16, -44, 10, 16, 8], [0, -50, 16, 12, 8],
    [42, -30, 8, 28, 8], [-42, -26, 9, 22, 8], [20, -22, 7, 14, 7], [-24, -32, 8, 18, 7], [36, 2, 7, 12, 6],
    [-36, 0, 7, 15, 6], [16, 40, 10, 20, 8], [-14, 44, 9, 24, 8], [30, 30, 8, 16, 7], [-30, 32, 9, 18, 8],
    [4, 54, 14, 18, 9], [22, 50, 8, 14, 7], [-22, 52, 8, 16, 7],
  ];
  const far = [];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rand() * 0.1;
    const r = 78 + rand() * 46;
    far.push([Math.sin(a) * r, Math.cos(a) * r, 8 + rand() * 12, 18 + rand() * 46, 8 + rand() * 10]);
  }
  const winGeom = new THREE.PlaneGeometry(0.6, 0.8);
  const warm = new THREE.InstancedMesh(winGeom, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc070).multiplyScalar(1.5) }), 2600);
  const cool = new THREE.InstancedMesh(winGeom, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5ad8ff).multiplyScalar(1.4) }), 900);
  const dummy = new THREE.Object3D();
  const UP = new THREE.Vector3(0, 1, 0);
  let wi = 0, ci = 0;
  const build = (blocks, mat, windowScale, density) => {
    const geoms = [];
    for (const [x, z, w, h, d] of blocks) {
      const yaw = Math.atan2(-x, -z); // face the roof
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateY(yaw);
      g.translate(x, h / 2 - 14, z);
      geoms.push(g);
      const cols = Math.max(3, Math.floor(w / 1.7));
      const rows = Math.max(4, Math.floor(h / 2.3));
      const litFloor = rand();
      for (let r = 0; r < rows; r++) {
        const rowLit = rand() < 0.2 ? 0.9 : density;
        for (let c = 0; c < cols; c++) {
          const roll = rand();
          if (roll > rowLit) continue;
          const lx = -w / 2 + 1.0 + c * ((w - 2) / Math.max(1, cols - 1));
          const ly = 1.5 + r * ((h - 2.6) / Math.max(1, rows - 1)) - 14;
          dummy.position.set(lx, ly, d / 2 + 0.08).applyAxisAngle(UP, yaw);
          dummy.position.x += x; dummy.position.z += z;
          dummy.rotation.set(0, yaw, 0);
          dummy.scale.setScalar(windowScale);
          dummy.updateMatrix();
          if ((roll * 7.3 + litFloor) % 1 > 0.8 && ci < 900) cool.setMatrixAt(ci++, dummy.matrix);
          else if (wi < 2600) warm.setMatrixAt(wi++, dummy.matrix);
        }
      }
      if (h > 20 && beacons.length < 14 && rand() > 0.35) beacons.push(new THREE.Vector3(x, h - 14 + 0.8, z));
    }
    const mesh = new THREE.Mesh(mergeGeometries(geoms), mat);
    geoms.forEach((g) => g.dispose());
    mesh.castShadow = false; mesh.receiveShadow = false;
    group.add(mesh);
  };
  build(near, makeMat({ color: 0x0c131b, roughness: 0.55, metalness: 0.35 }), 1, 0.5);
  build(far, makeMat({ color: 0x0a1118, roughness: 0.9, metalness: 0.05 }), 1.5, 0.34);
  warm.count = wi; cool.count = ci;
  for (const m of [warm, cool]) {
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    group.add(m);
  }
}

export function createRooftop(ctx) {
  const { scene, physics, strings, props, renderer, tuning } = ctx;
  const group = new THREE.Group(); group.name = 'rooftop';
  const ids = [];
  const mats = {
    concrete: makeMat({ color: 0x252d38, roughness: 0.42, metalness: 0.1 }),
    deck: makeMat({ color: 0x10151b, roughness: 0.5, metalness: 0.1 }),
    metal: makeMat({ color: 0x343e4b, roughness: 0.34, metalness: 0.75 }),
    rust: makeMat({ color: 0x3e3430, roughness: 0.5, metalness: 0.35 }),
    parapet: makeMat({ color: 0x1a222c, roughness: 0.36, metalness: 0.25 }),
    glass: makeMat({ color: 0x0e1a26, roughness: 0.06, metalness: 0.9, emissive: 0x0a2030, emissiveIntensity: 0.3 }),
  };
  for (const m of [mats.concrete, mats.metal, mats.rust, mats.parapet]) m.envMapIntensity = 1.3;
  const box = (opts) => {
    const r = addBox({ group, physics, mats }, opts);
    if (r.id) ids.push(r.id);
    return r;
  };

  // ---------- decks (collider boxes + wet reflective tops) ----------
  box({ id: 'roof', size: [28, 0.7, 22], pos: [0, -0.35, 0], mat: mats.deck, userData: { solid: true, ground: true }, cast: false });
  box({ id: 'roof-low', size: [14, 0.6, 10], pos: [0, -2.8, 17], mat: mats.deck, userData: { solid: true, ground: true }, cast: false });
  const decks = [
    wetDeck(group, {
      w: 28, d: 22, x: 0, z: 0, y: 0,
      maps: deckMaps({ w: 28, d: 22, seed: 0xA3E15, panel: 2, puddles: 30 }),
      envMapIntensity: 1.2, normalScale: 0.14, normalRepeat: 0.7,
      reflect: { strength: 0.9, base: 0.18, blur: 0.006, ripple: 0.0011 },
    }),
    wetDeck(group, {
      w: 14, d: 10, x: 0, z: 17, y: -2.5,
      maps: deckMaps({ w: 14, d: 10, seed: 0x51DE, panel: 2, puddles: 12, res: 512 }),
      envMapIntensity: 1.2, normalScale: 0.14, normalRepeat: 0.7,
      reflect: { strength: 0.9, base: 0.18, blur: 0.006, ripple: 0.0011 },
    }),
  ];

  // Parapets with a gap on +Z toward the lower roof / vault lane
  const ph = 0.55, pt = 0.28;
  box({ size: [28, ph, pt], pos: [0, ph / 2, -11 + pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [12, ph, pt], pos: [-8, ph / 2, 11 - pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [12, ph, pt], pos: [8, ph / 2, 11 - pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [pt, ph, 22], pos: [-14 + pt / 2, ph / 2, 0], mat: mats.parapet, userData: { solid: true } });
  box({ size: [pt, ph, 22], pos: [14 - pt / 2, ph / 2, 0], mat: mats.parapet, userData: { solid: true } });

  // Neon trim: one merged HDR mesh per colour
  const cy = [], mg = [];
  trim(cy, [0, ph + 0.03, -11 + pt / 2], [28, 0.05, 0.08]);
  trim(mg, [-8, ph + 0.03, 11 - pt / 2], [12, 0.05, 0.08]);
  trim(mg, [8, ph + 0.03, 11 - pt / 2], [12, 0.05, 0.08]);
  trim(cy, [-14 + pt / 2, ph + 0.03, 0], [0.08, 0.05, 22]);
  trim(mg, [14 - pt / 2, ph + 0.03, 0], [0.08, 0.05, 22]);
  trim(cy, [0, -2.47, 12.1], [14, 0.04, 0.07]);
  trim(mg, [-7, -2.47, 17], [0.07, 0.04, 10]);
  trim(mg, [7, -2.47, 17], [0.07, 0.04, 10]);
  trim(cy, [0, -2.47, 21.95], [14, 0.04, 0.07]);
  trimMesh(group, cy, 0x3df0ff);
  trimMesh(group, mg, 0xff3d8a);

  // Vault crate directly ahead of spawn (facing +Z) — keep the sprint/vault lane clear
  box({ id: 'vault-crate', size: [1.5, 0.84, 1.0], pos: [0, 0.42, 7.0], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [1.1, 1.1, 1.1], pos: [-4.2, 0.55, 4.2], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [0.9, 0.55, 0.9], pos: [-4.2, 1.38, 4.2], mat: mats.metal, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [2.2, 0.7, 1.2], pos: [5.5, 0.35, 6], mat: mats.metal, userData: { solid: true, ground: true, vaultable: true } });

  // AC units / antennas
  box({ size: [1.8, 1.05, 1.1], pos: [-8.5, 0.53, -6.5], mat: mats.metal, userData: { solid: true } });
  box({ size: [0.12, 2.4, 0.12], pos: [-8.5, 2.25, -6.5], mat: mats.metal, userData: { solid: true, ground: false } });
  box({ size: [1.6, 0.9, 1.0], pos: [9.2, 0.45, -7], mat: mats.metal, userData: { solid: true } });
  const dish = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), mats.metal);
  dish.position.set(9.2, 1.3, -7); dish.rotation.x = -Math.PI * 0.65; group.add(dish);

  // Uneven ground patch (foot IK): colliders per slab, one merged visual
  {
    const slabs = [];
    let k = 0;
    for (let ix = 0; ix < 6; ix++) for (let iz = 0; iz < 5; iz++) {
      const h = 0.08 + ((ix * 3 + iz * 5) % 7) * 0.045;
      const r = box({ id: `uneven-${k++}`, size: [0.95, h, 0.95], pos: [5.2 + ix * 0.95, h / 2, -3.2 + iz * 0.95], mat: mats.concrete, userData: { solid: true, ground: true }, cast: false });
      r.mesh.visible = false;
      const g = new THREE.BoxGeometry(0.93, h, 0.93);
      g.translate(5.2 + ix * 0.95, h / 2, -3.2 + iz * 0.95);
      slabs.push(g);
    }
    const mesh = new THREE.Mesh(mergeGeometries(slabs), mats.concrete);
    slabs.forEach((g) => g.dispose());
    mesh.receiveShadow = true; mesh.castShadow = true;
    group.add(mesh);
  }

  // Ramp up to a short raised platform (slopes)
  box({ id: 'ramp', size: [2.4, 0.22, 5.2], pos: [-7.5, 0.55, 1.2], rot: [-0.28, 0, 0], mat: mats.concrete, userData: { solid: true, ground: true } });
  box({ size: [2.6, 0.3, 2.4], pos: [-7.5, 1.2, 4.4], mat: mats.concrete, userData: { solid: true, ground: true } });

  // Lower roof cover crate. Enemy encounters live here; leave it open.
  box({ size: [1.2, 0.7, 1.2], pos: [0, -2.15, 14.2], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });

  // Krea props along the edges and as cover — never in the +Z sprint/vault lane (x≈0, z=0..8)
  // or on the lower-roof encounter (x≈-6..6, z≈15..20).
  const P = (name, x, z, o) => placeProp(group, physics, ids, props, name, x, z, o);
  P('hvac_neon', -11.2, -8.2, { yaw: 0.2, collide: true });
  P('hvac_neon', 11.4, -8.4, { yaw: -0.4, collide: true });
  P('speaker_stack', -12.2, 4.2, { yaw: 0.3, collide: true });
  P('speaker_stack', 12.0, 7.4, { yaw: -0.5, collide: true });
  P('crate', -6.6, -4.2, { yaw: 0.4, collide: true });
  P('crate', 8.2, 3.4, { yaw: -0.2, collide: true });
  P('crate', 7.4, -8.0, { yaw: 0.7, collide: true });
  P('monolith', -12.6, 8.6, { yaw: 0.15, collide: true, scale: 0.22 });
  P('resonance_ring', 12.2, -4.5, { scale: 0.4, y: 0.4 });
  P('panel_block', 26, -18, { yaw: -0.35, y: -8 });

  // ---------- company tower (backdrop) ----------
  const company = (strings && strings.company) || '';
  const tower = new THREE.Group(); tower.position.set(-22, -14, -40);
  tower.rotation.y = 0.45;
  const towerBody = new THREE.Mesh(new THREE.BoxGeometry(11, 46, 9), mats.glass);
  towerBody.position.y = 23; tower.add(towerBody);
  {
    const strips = [];
    for (let i = 0; i < 17; i++) { const g = new THREE.BoxGeometry(11.1, 0.4, 9.1); g.translate(0, 3 + i * 2.5, 0); strips.push(g); }
    const m = new THREE.Mesh(mergeGeometries(strips), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3a6a90).multiplyScalar(0.9) }));
    strips.forEach((g) => g.dispose());
    tower.add(m);
  }
  if (company) {
    const sign = neonText(company, { color: 0xff3d8a, w: 9.6, h: 2.4, gain: 3.2 });
    sign.position.set(0, 34, 4.62);
    tower.add(sign);
    const echo = neonText(company, { color: 0x3df0ff, w: 9.6, h: 2.4, gain: 1.6, backing: false });
    echo.position.set(0.14, 33.9, 4.66);
    tower.add(echo);
  }
  group.add(tower);

  // ---------- roof signage ----------
  const signs = [];
  const post = (x, h, z, baseY = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, h, 0.14), mats.metal);
    m.position.set(x, h / 2 + baseY, z);
    group.add(m);
  };
  const addSign = (text, color, w, h, pos, yaw, lightDist = 16) => {
    const s = neonText(text, { color, w, h, gain: 2.8 });
    s.position.set(...pos); s.rotation.y = yaw;
    group.add(s);
    const l = new THREE.PointLight(color, 6, lightDist, 1.6);
    l.position.set(pos[0] + Math.sin(yaw) * 1.0, pos[1], pos[2] + Math.cos(yaw) * 1.0);
    group.add(l);
    const halo = glowSprite(color, 5.5, 0.2);
    halo.position.copy(l.position); group.add(halo);
    signs.push({ mat: s.userData.text.material, base: s.userData.text.material.color.clone(), light: l, li: 6, seed: signs.length * 3.7 });
    return s;
  };
  post(-13.6, 2.6, -4.2); post(-13.6, 2.6, -0.8); post(13.6, 2.4, 1.3); post(13.6, 2.4, 4.3);
  addSign('AEGIS', 0x3df0ff, 3.8, 0.9, [-13.5, 2.2, -2.5], Math.PI / 2);
  addSign('GRID', 0xff3d8a, 3.2, 0.85, [13.5, 2.0, 2.8], -Math.PI / 2);

  // ---------- skyline, sky, haze ----------
  const beacons = [];
  addSkyline(group, beacons);
  const sky = skyDome({ top: 0x03060b, horizon: 0x0c1a26, glow: 0x16303f, glowPower: 5, radius: 190 });
  group.add(sky);
  const beaconSprites = beacons.map((p, i) => {
    const s = glowSprite(0xff2030, 2.6, 0.9);
    s.position.copy(p); group.add(s);
    return { s, ph: i * 1.3 };
  });
  // street-level glow rising between the towers
  for (const [x, z, c, s] of [[-30, -30, 0xff3d8a, 60], [28, -34, 0x3df0ff, 64], [0, 46, 0xffb060, 56], [44, 10, 0xff3d8a, 44], [-46, 8, 0x3df0ff, 48]]) {
    const g = glowSprite(c, s, 0.12);
    g.position.set(x, -12, z); group.add(g);
  }
  // searchlights sweeping from distant roofs
  const beams = [];
  for (const [x, y, z, c] of [[30, 6.5, -12, 0x9fdcff], [-32, 10.5, -10, 0xff9ac4], [8, 12.5, -34, 0x9fdcff]]) {
    const cone = lightCone({ color: c, height: 70, radius: 5, topRadius: 0.3, opacity: 0.2 });
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    cone.rotation.x = Math.PI; // point up
    pivot.add(cone);
    group.add(pivot);
    beams.push({ pivot, ph: x * 0.1 });
  }
  // lamp posts with light cones (fake volumetrics in the rain)
  const lamp = (x, h, z, color, baseY = 0) => {
    post(x, h, z, baseY);
    const cone = lightCone({ color, height: h + 0.2, radius: 2.6, topRadius: 0.12, opacity: 0.3 });
    cone.position.set(x, h + baseY, z); group.add(cone);
    const halo = glowSprite(color, 1.6, 0.9); halo.position.set(x, h + baseY, z); group.add(halo);
    const l = new THREE.PointLight(color, 14, 13, 1.6); l.position.set(x, h - 0.3 + baseY, z); group.add(l);
  };
  lamp(-13.3, 4.2, 9.6, 0xbfe6ff);
  lamp(13.3, 4.2, -9.8, 0xbfe6ff);
  lamp(-6.7, 4.0, 21.6, 0xffc890, -2.5);
  lamp(6.7, 4.0, 21.6, 0xbfe6ff, -2.5);

  // ---------- lighting: one shadow key, coloured rims, soft fill ----------
  const hemi = new THREE.HemisphereLight(0x8ab8e0, 0x150c1c, 0.7);
  group.add(hemi);
  const key = new THREE.DirectionalLight(0xdbe8ff, 1.5);
  key.position.set(-12, 22, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.camera.left = -22; key.shadow.camera.right = 22;
  key.shadow.camera.top = 26; key.shadow.camera.bottom = -18;
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.03;
  key.shadow.radius = 3;
  group.add(key); group.add(key.target);
  const rim = new THREE.DirectionalLight(0x40e8ff, 2.0);
  rim.position.set(10, 9, -14); group.add(rim);
  const magRim = new THREE.DirectionalLight(0xff4da0, 0.6);
  magRim.position.set(-10, 7, 14); group.add(magRim);

  let envRT = null;
  if (renderer) {
    envRT = makeEnv(renderer, {
      sky: 0x0d1b28, hemiTop: 0x6fb4d8, hemiBottom: 0x1a1020, hemi: 1.0,
      cards: [
        { color: 0x3df0ff, gain: 2.2, pos: [-18, 6, -18], size: [10, 6] },
        { color: 0xff3d8a, gain: 2.2, pos: [18, 5, -14], size: [10, 6] },
        { color: 0xffc070, gain: 1.4, pos: [0, -3, -24], size: [30, 3] },
        { color: 0xff3d8a, gain: 1.4, pos: [-14, 4, 20], size: [8, 5] },
        { color: 0x3df0ff, gain: 1.2, pos: [16, 8, 18], size: [8, 5] },
      ],
    });
    scene.environment = envRT.texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.75;
  }

  const rain = createRain(tuning, group);

  const spawn = new THREE.Vector3(0, 0, 0);
  // Escape route: clear the lower roof, then drop through the gate into the Cradle.
  const portals = [
    { to: 'cradle', pos: new THREE.Vector3(0, -2.5, 20), radius: 1.8, label: 'CRADLE', locked: true },
  ];
  let arch = null;
  if (props?.gate_arch?.root) {
    arch = props.gate_arch.root.clone(true);
    arch.scale.multiplyScalar(0.7);
    arch.position.set(0, props.gate_arch.root.position.y * 0.7 - 0.1, 0.9);
  }
  const gate = portalGate(group, portals[0], { color: 0x3df0ff, arch });

  scene.add(group);
  let t = 0;
  let groundY = 0;
  return {
    name: 'rooftop',
    group,
    spawn,
    faceYaw: 0,
    portals,
    enemies: [],
    rain,
    physicsIds: ids,
    fog: { color: 0x0b1822, density: 0.011 },
    clearColor: 0x05090f,
    exposure: 1.2,
    far: 260,
    update(dt, playerPos) {
      t += dt;
      // splashes sit on whichever deck the player is over
      const target = playerPos.z > 11.5 ? -2.5 : 0;
      groundY += (target - groundY) * Math.min(1, dt * 6);
      rain.setOrigin(playerPos);
      rain.setGround(groundY);
      rain.update(dt);
      for (const d of decks) d.update(t);
      gate.update(dt);
      sky.position.set(playerPos.x, 0, playerPos.z);
      for (const b of beaconSprites) b.s.material.opacity = 0.25 + 0.75 * Math.max(0, Math.sin(t * 2.2 + b.ph)) ** 4;
      for (const b of beams) {
        b.pivot.rotation.z = Math.sin(t * 0.21 + b.ph) * 0.5;
        b.pivot.rotation.x = Math.cos(t * 0.17 + b.ph * 2) * 0.4;
      }
      // neon tubes buzz: mostly steady, with the odd dropout
      for (const s of signs) {
        const n = Math.sin(t * 31 + s.seed) * Math.sin(t * 7.3 + s.seed * 2);
        const k = n > 0.93 ? 0.35 : 0.94 + 0.06 * Math.sin(t * 50 + s.seed);
        s.mat.color.copy(s.base).multiplyScalar(k);
        s.light.intensity = s.li * k;
      }
    },
    unload() {
      rain.dispose();
      for (const d of decks) d.dispose();
      if (envRT && scene.environment === envRT.texture) scene.environment = null;
      envRT?.dispose();
      envRT = null;
      scene.remove(group);
      for (const id of ids) physics.remove(id);
    },
  };
}
