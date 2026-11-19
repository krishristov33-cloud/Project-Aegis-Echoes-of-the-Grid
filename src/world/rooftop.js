// Sofia rooftop escape — rainy neon cyberpunk art pass. Mood from Krea's 00_master:
// wet low-roughness deck, cyan/magenta trim, amuNet tower, far instanced skyline.
import * as THREE from 'three';
import { addBox, makeMat, wetRoofMaps, neonSign } from './greybox.js';
import { createRain } from './rain.js';

function mulberry32(a) {
  return () => {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNightEnv(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight(0x7ec8e8, 0x1a1020, 1.15));
  s.add(new THREE.Mesh(
    new THREE.SphereGeometry(30, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x152838, side: THREE.BackSide }),
  ));
  const cyan = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 1), new THREE.MeshBasicMaterial({ color: 0x3df0ff }));
  cyan.position.set(-10, 6, -20); s.add(cyan);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 1), new THREE.MeshBasicMaterial({ color: 0xff3d8a }));
  mag.position.set(10, 5, -20); s.add(mag);
  const warm = new THREE.Mesh(new THREE.BoxGeometry(22, 4, 1), new THREE.MeshBasicMaterial({ color: 0xffc070 }));
  warm.position.set(0, -4, -15); s.add(warm);
  const rt = pmrem.fromScene(s, 0.04);
  pmrem.dispose();
  return rt;
}

function trim(group, pos, size, color, intensity = 1.7) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    makeMat({ color, roughness: 0.22, metalness: 0.35, emissive: color, emissiveIntensity: intensity }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}

function placeProp(group, physics, ids, props, name, x, z, yaw = 0, collide = false, scale = 1, yAdd = 0) {
  const loaded = props?.[name];
  if (!loaded?.root) return null;
  const obj = loaded.root.clone(true);
  obj.position.x = x;
  obj.position.z = z;
  obj.position.y = loaded.root.position.y * scale + yAdd;
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
      // keep colliders tight so dressing can't eat the sprint/vault lane
      size.x = Math.min(size.x, 2.4) * 0.85;
      size.z = Math.min(size.z, 2.4) * 0.85;
      size.y *= 0.9;
      const id = physics.addBox({
        center,
        halfExtents: size.multiplyScalar(0.5),
        userData: { solid: true },
      });
      if (id) ids.push(id);
    }
  }
  return obj;
}

function addSkyline(group) {
  const rand = mulberry32(0xAE615);
  const bodyMat = makeMat({ color: 0x101820, roughness: 0.82, metalness: 0.12 });
  const glassMat = makeMat({ color: 0x152030, roughness: 0.12, metalness: 0.7, emissive: 0x0a2030, emissiveIntensity: 0.2 });
  // x, z, w, h, d, yaw, glass?
  const blocks = [
    [-8, -36, 9, 22, 8, 0, false],
    [8, -34, 11, 26, 9, 0, false],
    [24, -26, 10, 18, 8, 0.12, false],
    [32, -12, 8, 20, 8, 0.4, false],
    [30, 8, 9, 16, 7, 0.55, false],
    [-32, -10, 10, 24, 8, -0.3, false],
    [-30, 10, 8, 14, 7, -0.5, false],
    [18, -42, 14, 20, 10, 0, false],
    [-16, -44, 10, 16, 8, 0, false],
    [0, -50, 16, 12, 8, 0, false],
    [42, -30, 8, 28, 8, 0.05, false],
    [-42, -26, 9, 22, 8, -0.08, false],
    [20, -22, 7, 14, 7, 0.15, false],
    [-24, -32, 8, 18, 7, -0.1, false],
    [36, 2, 7, 12, 6, 0.7, false],
    [-36, 0, 7, 15, 6, -0.6, false],
    [16, 38, 10, 20, 8, Math.PI, false],
    [-14, 42, 9, 24, 8, Math.PI, false],
    [28, 30, 8, 16, 7, 2.8, false],
    [-28, 32, 9, 18, 8, -2.8, false],
    [4, 52, 14, 18, 9, Math.PI, false],
    [22, 48, 8, 14, 7, 3.0, false],
    [-22, 50, 8, 16, 7, -3.0, false],
  ];
  const winGeom = new THREE.BoxGeometry(0.55, 0.7, 0.1);
  const warmMat = makeMat({ color: 0x1a1208, emissive: 0xffc070, emissiveIntensity: 1.15, roughness: 0.85 });
  const coolMat = makeMat({ color: 0x081018, emissive: 0x5ad8ff, emissiveIntensity: 0.95, roughness: 0.7 });
  const warm = new THREE.InstancedMesh(winGeom, warmMat, 900);
  const cool = new THREE.InstancedMesh(winGeom, coolMat, 280);
  warm.castShadow = cool.castShadow = false;
  warm.receiveShadow = cool.receiveShadow = false;
  warm.frustumCulled = cool.frustumCulled = false;
  const dummy = new THREE.Object3D();
  let wi = 0, ci = 0;
  for (const [x, z, w, h, d, yaw, glass] of blocks) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glass ? glassMat : bodyMat);
    body.position.set(x, h / 2, z);
    body.rotation.y = yaw;
    body.castShadow = false;
    body.receiveShadow = false;
    group.add(body);
    // windows on the facade facing the rooftop (roughly +Z / toward origin)
    const cols = Math.max(3, Math.floor(w / 1.7));
    const rows = Math.max(4, Math.floor(h / 2.15));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const roll = rand();
        if (roll < 0.28) continue;
        const lx = -w / 2 + 1.0 + c * ((w - 2) / Math.max(1, cols - 1));
        const ly = 1.5 + r * ((h - 2.4) / Math.max(1, rows - 1));
        const lz = d / 2 + 0.06;
        dummy.position.set(lx, ly, lz);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        // rotate around building origin
        const m = dummy.matrix.clone();
        const pose = new THREE.Matrix4().makeRotationY(yaw);
        pose.setPosition(x, 0, z);
        const world = new THREE.Matrix4().multiplyMatrices(pose, m);
        if (roll > 0.86 && ci < 280) cool.setMatrixAt(ci++, world);
        else if (wi < 900) warm.setMatrixAt(wi++, world);
      }
    }
  }
  warm.count = wi;
  cool.count = ci;
  warm.instanceMatrix.needsUpdate = true;
  cool.instanceMatrix.needsUpdate = true;
  group.add(warm);
  group.add(cool);
}

export function createRooftop(ctx) {
  const { scene, physics, strings, props, renderer } = ctx;
  const group = new THREE.Group(); group.name = 'rooftop';
  const ids = [];
  const mats = {
    concrete: makeMat({ color: 0x2a3444, roughness: 0.22, metalness: 0.18 }),
    wet: (() => {
      const m = makeMat({ color: 0xc8d4e0, roughness: 0.14, metalness: 0.36 });
      const maps = wetRoofMaps();
      m.map = maps.map;
      m.roughnessMap = maps.roughnessMap;
      return m;
    })(),
    metal: makeMat({ color: 0x3a4554, roughness: 0.32, metalness: 0.7 }),
    rust: makeMat({ color: 0x4a3c36, roughness: 0.48, metalness: 0.3 }),
    parapet: makeMat({ color: 0x1c2530, roughness: 0.28, metalness: 0.2, emissive: 0x0a1520, emissiveIntensity: 0.15 }),
    glass: makeMat({ color: 0x1a2838, roughness: 0.08, metalness: 0.85, emissive: 0x0a2030, emissiveIntensity: 0.35 }),
  };
  const box = (opts) => {
    const r = addBox({ group, physics, mats }, opts);
    if (r.id) ids.push(r.id);
    return r;
  };

  // Main roof deck (top at y=0)
  box({ id: 'roof', size: [28, 0.7, 22], pos: [0, -0.35, 0], mat: mats.wet, userData: { solid: true, ground: true }, cast: false });

  // Parapets with a gap on +Z toward the lower roof / vault lane
  const ph = 0.55, pt = 0.28;
  box({ size: [28, ph, pt], pos: [0, ph / 2, -11 + pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [12, ph, pt], pos: [-8, ph / 2, 11 - pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [12, ph, pt], pos: [8, ph / 2, 11 - pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [pt, ph, 22], pos: [-14 + pt / 2, ph / 2, 0], mat: mats.parapet, userData: { solid: true } });
  box({ size: [pt, ph, 22], pos: [14 - pt / 2, ph / 2, 0], mat: mats.parapet, userData: { solid: true } });

  // Cyan / magenta emissive trim on parapet tops and the deck edge
  trim(group, [0, ph + 0.03, -11 + pt / 2], [28, 0.05, 0.08], 0x3df0ff);
  trim(group, [-8, ph + 0.03, 11 - pt / 2], [12, 0.05, 0.08], 0xff3d8a);
  trim(group, [8, ph + 0.03, 11 - pt / 2], [12, 0.05, 0.08], 0xff3d8a);
  trim(group, [-14 + pt / 2, ph + 0.03, 0], [0.08, 0.05, 22], 0x3df0ff);
  trim(group, [14 - pt / 2, ph + 0.03, 0], [0.08, 0.05, 22], 0xff3d8a);
  trim(group, [0, 0.02, -10.6], [26, 0.03, 0.06], 0x3df0ff, 1.2);
  trim(group, [-13.6, 0.02, 0], [0.06, 0.03, 20], 0xff3d8a, 1.2);
  trim(group, [13.6, 0.02, 0], [0.06, 0.03, 20], 0x3df0ff, 1.2);

  // Vault crate directly ahead of spawn (facing +Z) — keep the sprint/vault lane clear
  box({
    id: 'vault-crate',
    size: [1.5, 0.84, 1.0],
    pos: [0, 0.42, 7.0],
    mat: mats.rust,
    userData: { solid: true, ground: true, vaultable: true },
  });
  box({ size: [1.1, 1.1, 1.1], pos: [-4.2, 0.55, 4.2], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [0.9, 0.55, 0.9], pos: [-4.2, 1.38, 4.2], mat: mats.metal, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [2.2, 0.7, 1.2], pos: [5.5, 0.35, 6], mat: mats.metal, userData: { solid: true, ground: true, vaultable: true } });

  // AC units / antennas (greybox keepers, dressed with Krea HVAC nearby)
  box({ size: [1.8, 1.05, 1.1], pos: [-8.5, 0.53, -6.5], mat: mats.metal, userData: { solid: true } });
  box({ size: [0.12, 2.4, 0.12], pos: [-8.5, 2.25, -6.5], mat: mats.metal, userData: { solid: true, ground: false } });
  box({ size: [1.6, 0.9, 1.0], pos: [9.2, 0.45, -7], mat: mats.metal, userData: { solid: true } });
  const dish = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), mats.metal);
  dish.position.set(9.2, 1.3, -7); dish.rotation.x = -Math.PI * 0.65; group.add(dish);

  // Uneven ground patch (foot IK)
  let k = 0;
  for (let ix = 0; ix < 6; ix++) for (let iz = 0; iz < 5; iz++) {
    const h = 0.08 + ((ix * 3 + iz * 5) % 7) * 0.045;
    box({
      id: `uneven-${k++}`,
      size: [0.95, h, 0.95],
      pos: [5.2 + ix * 0.95, h / 2, -3.2 + iz * 0.95],
      mat: mats.concrete,
      userData: { solid: true, ground: true },
      cast: false,
    });
  }

  // Ramp up to a short raised platform (slopes)
  box({
    id: 'ramp',
    size: [2.4, 0.22, 5.2],
    pos: [-7.5, 0.55, 1.2],
    rot: [-0.28, 0, 0],
    mat: mats.concrete,
    userData: { solid: true, ground: true },
  });
  box({ size: [2.6, 0.3, 2.4], pos: [-7.5, 1.2, 4.4], mat: mats.concrete, userData: { solid: true, ground: true } });

  // Lower connecting roof (+Z) — a drop / later escape path. Enemy encounters live here; leave it open.
  box({ id: 'roof-low', size: [14, 0.6, 10], pos: [0, -2.8, 17], mat: mats.wet, userData: { solid: true, ground: true }, cast: false });
  box({ size: [1.2, 0.7, 1.2], pos: [0, -2.15, 14.2], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });
  trim(group, [0, -2.48, 12.1], [14, 0.04, 0.07], 0x3df0ff, 1.3);

  // Krea props along the edges and as cover — never in the +Z sprint/vault lane (x≈0, z=0..8)
  // or on the lower-roof encounter (x≈-6..6, z≈15..20).
  placeProp(group, physics, ids, props, 'hvac_neon', -11.2, -8.2, 0.2, true);
  placeProp(group, physics, ids, props, 'hvac_neon', 11.4, -8.4, -0.4, true);
  placeProp(group, physics, ids, props, 'speaker_stack', -12.2, 4.2, 0.3, true);
  placeProp(group, physics, ids, props, 'speaker_stack', 12.0, 7.4, -0.5, true);
  placeProp(group, physics, ids, props, 'crate', -6.6, -4.2, 0.4, true);
  placeProp(group, physics, ids, props, 'crate', 8.2, 3.4, -0.2, true);
  placeProp(group, physics, ids, props, 'crate', 7.4, -8.0, 0.7, true);
  placeProp(group, physics, ids, props, 'monolith', -12.6, 8.6, 0.15, true, 0.22);
  placeProp(group, physics, ids, props, 'resonance_ring', 12.2, -4.5, 0, false, 0.4, 0.4);
  placeProp(group, physics, ids, props, 'gate_arch', 0, 21.6, 0, false, 0.7, -0.4);
  placeProp(group, physics, ids, props, 'panel_block', 24, -16, -0.35, false, 1, -8);

  // Glass office tower with amuNet neon (backdrop)
  const tower = new THREE.Group(); tower.position.set(-22, 0, -40);
  const towerBody = new THREE.Mesh(new THREE.BoxGeometry(10, 28, 8), mats.glass);
  towerBody.position.y = 14; towerBody.castShadow = false; tower.add(towerBody);
  const winMat = makeMat({ color: 0x0b1520, emissive: 0x3a5a80, emissiveIntensity: 0.55, roughness: 0.2, metalness: 0.6 });
  for (let i = 0; i < 10; i++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.35, 8.1), winMat);
    strip.position.y = 2 + i * 2.4; strip.castShadow = false; tower.add(strip);
  }
  const company = (strings && strings.company) || 'amuNet';
  const sign = neonSign(company, { color: 0xff3d8a, w: 7.2, h: 1.6 });
  sign.position.set(0, 12.2, 4.15);
  tower.add(sign);
  const signCyan = neonSign(company, { color: 0x3df0ff, w: 7.2, h: 1.6 });
  signCyan.position.set(0.08, 12.12, 4.12);
  signCyan.material.opacity = 0.85; signCyan.material.transparent = true;
  signCyan.material.toneMapped = false; signCyan.material.emissiveIntensity = 2.2;
  tower.add(signCyan);
  group.add(tower);

  // Neon signs on the roof that actually light the deck
  const roofSign = neonSign('AEGIS', { color: 0x3df0ff, w: 3.6, h: 0.7 });
  roofSign.position.set(-13.55, 2.1, -2.5);
  roofSign.rotation.y = Math.PI / 2;
  group.add(roofSign);
  const roofSignM = neonSign('GRID', { color: 0xff3d8a, w: 3.2, h: 0.65 });
  roofSignM.position.set(13.55, 1.9, 2.8);
  roofSignM.rotation.y = -Math.PI / 2;
  group.add(roofSignM);

  addSkyline(group);

  // Distant mountain silhouettes (Vitosha-ish)
  const mtMat = makeMat({ color: 0x0b1018, roughness: 1, metalness: 0 });
  for (const [x, z, s] of [[-40, -80, 28], [10, -90, 36], [50, -85, 24]]) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(s * 0.8, s, 5), mtMat);
    m.position.set(x, s * 0.3, z); m.rotation.y = 0.4; m.castShadow = false; group.add(m);
  }

  // Lighting: one shadow-casting key, a cyan rim, hemi fill, neon points
  const hemi = new THREE.HemisphereLight(0x9ad4ff, 0x1a1020, 1.05);
  group.add(hemi);
  const key = new THREE.DirectionalLight(0xe8f2ff, 2.15);
  key.position.set(-12, 22, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.camera.left = -22; key.shadow.camera.right = 22;
  key.shadow.camera.top = 22; key.shadow.camera.bottom = -22;
  key.shadow.bias = -0.0008;
  group.add(key); group.add(key.target);
  const rim = new THREE.DirectionalLight(0x40e8ff, 1.55);
  rim.position.set(10, 10, -14); rim.castShadow = false; group.add(rim);
  const magRim = new THREE.DirectionalLight(0xff4da0, 0.55);
  magRim.position.set(-8, 8, 12); magRim.castShadow = false; group.add(magRim);

  // Signs cast colored light onto the wet deck (no shadows)
  const neonM = new THREE.PointLight(0xff3d8a, 28, 48, 1.15); neonM.position.set(-22, 14, -34); group.add(neonM);
  const neonC = new THREE.PointLight(0x3df0ff, 28, 48, 1.15); neonC.position.set(-20, 13, -34); group.add(neonC);
  const signC = new THREE.PointLight(0x3df0ff, 10, 18, 1.4); signC.position.set(-12.5, 2.2, -2.5); group.add(signC);
  const signM = new THREE.PointLight(0xff3d8a, 10, 18, 1.4); signM.position.set(12.5, 2.0, 2.8); group.add(signM);
  const roofFill = new THREE.PointLight(0xc0d8ee, 4.5, 28, 1.3); roofFill.position.set(0, 7, 2); group.add(roofFill);

  let envRT = null;
  if (renderer) {
    envRT = makeNightEnv(renderer);
    scene.environment = envRT.texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.9;
  }

  const rain = createRain(ctx.tuning, group);

  const spawn = new THREE.Vector3(0, 0, 0);
  const portals = [
    { to: 'cradle', pos: new THREE.Vector3(0, -2.5, 20), radius: 1.8, label: 'DROP' },
  ];

  scene.add(group);
  return {
    name: 'rooftop',
    group,
    spawn,
    faceYaw: 0,
    portals,
    enemies: [],
    rain,
    physicsIds: ids,
    fog: { color: 0x08141c, density: 0.018 },
    clearColor: 0x071018,
    exposure: 1.55,
    far: 220,
    update(dt, playerPos) {
      rain.setOrigin(playerPos);
      rain.update(dt);
    },
    unload() {
      rain.dispose();
      if (envRT && scene.environment === envRT.texture) scene.environment = null;
      envRT?.dispose();
      envRT = null;
      scene.remove(group);
      for (const id of ids) physics.remove(id);
    },
  };
}
