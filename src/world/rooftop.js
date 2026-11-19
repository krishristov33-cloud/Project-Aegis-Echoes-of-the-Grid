// Sofia rooftop escape greybox. Mood from Krea's 00_master: rainy-night teal fog,
// wet concrete, magenta/cyan amuNet neon on a glass tower, warm apartment windows.
import * as THREE from 'three';
import { addBox, makeMat, wetGridTexture, neonSign, createNavBuckets } from './greybox.js';
import { createRain } from './rain.js';

export function createRooftop(ctx) {
  const { scene, physics, strings } = ctx;
  const group = new THREE.Group(); group.name = 'rooftop';
  const ids = [];
  const nav = createNavBuckets();
  const mats = {
    concrete: makeMat({ color: 0x1a222e, roughness: 0.28, metalness: 0.22 }),
    wet: (() => {
      const m = makeMat({ color: 0x2a3444, roughness: 0.28, metalness: 0.22 });
      const tex = wetGridTexture('#1c2838', '#3a4c62'); tex.repeat.set(8, 6); m.map = tex;
      return m;
    })(),
    metal: makeMat({ color: 0x2a3340, roughness: 0.4, metalness: 0.7 }),
    rust: makeMat({ color: 0x3a302c, roughness: 0.6, metalness: 0.35 }),
    parapet: makeMat({ color: 0x171e28, roughness: 0.4, metalness: 0.15 }),
    glass: makeMat({ color: 0x1a2838, roughness: 0.08, metalness: 0.85, emissive: 0x0a2030, emissiveIntensity: 0.25 }),
  };
  const box = (opts) => {
    const r = addBox({ group, physics, mats }, opts);
    if (r.id) ids.push(r.id);
    nav.collect(opts, r.mesh);
    return r;
  };

  // Main roof deck (top at y=0)
  box({ id: 'roof', size: [28, 0.7, 22], pos: [0, -0.35, 0], mat: mats.wet, userData: { solid: true, ground: true }, cast: false });

  // Parapets with a gap on +Z toward the lower roof / vault lane
  const ph = 0.55, pt = 0.28;
  box({ size: [28, ph, pt], pos: [0, ph / 2, -11 + pt / 2], mat: mats.parapet, userData: { solid: true } });
  // gap in the +Z parapet so the vault lane and drop to the lower roof stay open
  box({ size: [12, ph, pt], pos: [-8, ph / 2, 11 - pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [12, ph, pt], pos: [8, ph / 2, 11 - pt / 2], mat: mats.parapet, userData: { solid: true } });
  box({ size: [pt, ph, 22], pos: [-14 + pt / 2, ph / 2, 0], mat: mats.parapet, userData: { solid: true } });
  box({ size: [pt, ph, 22], pos: [14 - pt / 2, ph / 2, 0], mat: mats.parapet, userData: { solid: true } });
  // open a vault testing gap: no extra wall in the +Z lane at x=0

  // Vault crate directly ahead of spawn (facing +Z)
  box({
    id: 'vault-crate',
    size: [1.5, 0.84, 1.0],
    pos: [0, 0.42, 7.0],
    mat: mats.rust,
    userData: { solid: true, ground: true, vaultable: true },
  });
  // extra crates
  box({ size: [1.1, 1.1, 1.1], pos: [-4.2, 0.55, 4.2], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [0.9, 0.55, 0.9], pos: [-4.2, 1.38, 4.2], mat: mats.metal, userData: { solid: true, ground: true, vaultable: true } });
  box({ size: [2.2, 0.7, 1.2], pos: [5.5, 0.35, 6], mat: mats.metal, userData: { solid: true, ground: true, vaultable: true } });

  // AC units / antennas
  box({ size: [1.8, 1.05, 1.1], pos: [-8.5, 0.53, -6.5], mat: mats.metal, userData: { solid: true } });
  box({ size: [0.12, 2.4, 0.12], pos: [-8.5, 2.25, -6.5], mat: mats.metal, userData: { solid: true, ground: false } });
  box({ size: [1.6, 0.9, 1.0], pos: [9.2, 0.45, -7], mat: mats.metal, userData: { solid: true } });
  // dish
  const dish = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), mats.metal);
  dish.position.set(9.2, 1.3, -7); dish.rotation.x = -Math.PI * 0.65; group.add(dish);

  // Uneven ground patch (foot IK) — tiled boxes of varying height
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

  // Lower connecting roof (+Z) — a drop / later escape path
  box({ id: 'roof-low', size: [14, 0.6, 10], pos: [0, -2.8, 17], mat: mats.wet, userData: { solid: true, ground: true }, cast: false });
  box({ size: [1.2, 0.7, 1.2], pos: [0, -2.15, 14.2], mat: mats.rust, userData: { solid: true, ground: true, vaultable: true } });

  // Glass office tower with amuNet neon (backdrop, no collision needed beyond a bulk)
  const tower = new THREE.Group(); tower.position.set(-18, 0, -16);
  const towerBody = new THREE.Mesh(new THREE.BoxGeometry(10, 28, 8), mats.glass);
  towerBody.position.y = 14; tower.add(towerBody);
  // window strips
  const winMat = makeMat({ color: 0x0b1520, emissive: 0x3a5a80, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.6 });
  for (let i = 0; i < 10; i++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.35, 8.1), winMat);
    strip.position.y = 2 + i * 2.4; tower.add(strip);
  }
  const sign = neonSign((strings && strings.company) || 'amuNet', { color: 0xff3d8a, w: 7.2, h: 1.6 });
  // two-tone: overlay a cyan plane? the canvas already draws the text; add a cyan edge box
  sign.position.set(0, 20.5, 4.15);
  tower.add(sign);
  const signCyan = neonSign('amuNet', { color: 0x3df0ff, w: 7.2, h: 1.6 });
  signCyan.position.set(0.08, 20.42, 4.12);
  signCyan.material.opacity = 0.85; signCyan.material.transparent = true;
  tower.add(signCyan);
  group.add(tower);

  // Apartment blocks with warm windows
  const aptMat = makeMat({ color: 0x121820, roughness: 0.7, metalness: 0.1 });
  const lit = makeMat({ color: 0x1a1208, emissive: 0xffc070, emissiveIntensity: 0.7, roughness: 0.8 });
  const addApt = (x, z, w, h, d) => {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), aptMat);
    body.position.y = h / 2; g.add(body);
    const cols = Math.max(3, Math.floor(w / 2)), rows = Math.max(4, Math.floor(h / 2.2));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (Math.random() < 0.35) continue;
      const ww = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.55, 0.08), lit);
      ww.position.set(-w / 2 + 1.1 + c * ((w - 2) / Math.max(1, cols - 1)), 1.4 + r * 2.0, d / 2 + 0.02);
      g.add(ww);
    }
    group.add(g);
  };
  addApt(22, -18, 10, 16, 8);
  addApt(28, -6, 8, 12, 7);
  addApt(16, -28, 12, 18, 9);
  addApt(-6, -30, 9, 14, 8);

  // Distant mountain silhouettes (Vitosha-ish)
  const mtMat = makeMat({ color: 0x0b1018, roughness: 1, metalness: 0 });
  for (const [x, z, s] of [[-40, -70, 28], [10, -80, 36], [50, -75, 24]]) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(s * 0.8, s, 5), mtMat);
    m.position.set(x, s * 0.3, z); m.rotation.y = 0.4; group.add(m);
  }

  // Lighting: one directional (moon) + hemi + neon points
  const hemi = new THREE.HemisphereLight(0x8ec8e8, 0x1a1420, 1.15);
  group.add(hemi);
  const moon = new THREE.DirectionalLight(0xd8e8ff, 1.15);
  moon.position.set(-12, 22, 8);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.near = 1; moon.shadow.camera.far = 60;
  moon.shadow.camera.left = -22; moon.shadow.camera.right = 22;
  moon.shadow.camera.top = 22; moon.shadow.camera.bottom = -22;
  moon.shadow.bias = -0.0008;
  group.add(moon); group.add(moon.target);
  // unshadowed fill so swiftshader / umbrella shadows can't crush the deck
  const fill = new THREE.DirectionalLight(0x88b8d8, 0.55);
  fill.position.set(8, 14, 10); fill.castShadow = false; group.add(fill);
  const neonM = new THREE.PointLight(0xff3d8a, 8, 40, 1.2); neonM.position.set(-14, 10, -8); group.add(neonM);
  const neonC = new THREE.PointLight(0x3df0ff, 8, 40, 1.2); neonC.position.set(-10, 8, -6); group.add(neonC);
  const roofFill = new THREE.PointLight(0xa8c8e0, 2.2, 24, 1.4); roofFill.position.set(0, 6, 2); group.add(roofFill);

  // Fog is set on the scene in load()
  const rain = createRain(ctx.tuning, group);

  // C1 AI spawns (soldiers replace the old training dummy). Wired in main via bootLevelAI.
  // Lower connecting roof only: keeps the main-deck vault/sprint lane clear of incoming fire
  // so L1–L4 locomotion tests are not interrupted by hit reactions.
  const V = (x, z) => [x, 0, z];
  const spawns = [
    { kind: 'soldier', position: V(4.2, 16.5), patrol: [V(4.2, 16.5), V(5.8, 19.5)], yaw: 0 },
    { kind: 'soldier', position: V(-4.2, 16.5), patrol: [V(-4.2, 16.5), V(-5.8, 19.5)], yaw: 0 },
    { kind: 'soldier', position: V(0.0, 19.2), patrol: [V(-5.0, 19.2), V(5.0, 19.2)], yaw: 0 },
    { kind: 'drone', position: V(0, 17), patrol: [V(-5.5, 15), V(5.5, 15), V(5.5, 20), V(-5.5, 20)] },
  ];

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
    ...nav.asLevel(),
    spawns,
    fog: { color: 0x0a141c, near: 8, far: 70 },
    clearColor: 0x070c12,
    update(dt, playerPos) {
      rain.setOrigin(playerPos);
      rain.update(dt);
    },
    unload() {
      rain.dispose();
      scene.remove(group);
      for (const id of ids) physics.remove(id);
    },
  };
}
