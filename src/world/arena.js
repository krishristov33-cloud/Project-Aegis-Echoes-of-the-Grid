// Dissonant Hulk arena: a reactor pit under a broken resonance ring. Hot seams glow between the floor plates,
// embers rise, and the room's colour follows the fight (bossPhase / bossDefeated).
// The floor plates stay individual BoxGeometry meshes with userData.destructible: src/ai/hulk.js cracks, voids
// and throws them, and swaps their material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addBox, makeMat } from './greybox.js';
import { placeProp, makeEnv, skyDome, lightCone, glowSprite, createMotes, detailNormal } from './kit.js';

const TILE = 4.2;
const WHITE = new THREE.Color(0xffffff);
const EMBER = new THREE.Color(0xffa040);

/** Glowing seam grid that shows through the gaps between plates (and where a plate has been ripped out). */
function seamTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const cells = 7;
  const step = S / cells;
  // molten mottling under the plates
  let s = 0x51DE;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * S, r = 20 + rnd() * 70;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,${40 + rnd() * 70},${40 + rnd() * 40},${0.1 + rnd() * 0.16})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.shadowColor = '#ff2a55'; g.shadowBlur = 14;
  g.strokeStyle = '#ffd0d8'; g.lineWidth = 3;
  for (let i = 0; i <= cells; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, S); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(S, i * step); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Plate albedo: brushed dark metal with a bevelled edge and corner bolts. */
function plateTexture() {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#3a2c32'; g.fillRect(0, 0, S, S);
  let s = 0xBEEF;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rnd() > 0.5 ? `rgba(255,230,235,${0.02 + rnd() * 0.04})` : `rgba(0,0,0,${0.05 + rnd() * 0.1})`;
    g.fillRect(rnd() * S, rnd() * S, 6 + rnd() * 30, 1);
  }
  g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = 10; g.strokeRect(0, 0, S, S);
  g.strokeStyle = 'rgba(255,200,210,0.16)'; g.lineWidth = 2; g.strokeRect(12, 12, S - 24, S - 24);
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(S / 2, 14); g.lineTo(S / 2, S - 14); g.moveTo(14, S / 2); g.lineTo(S - 14, S / 2); g.stroke();
  for (const [x, y] of [[26, 26], [S - 26, 26], [26, S - 26], [S - 26, S - 26]]) {
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,220,225,0.25)'; g.beginPath(); g.arc(x - 1, y - 1, 3, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createArena(ctx) {
  const { scene, physics, props, renderer, bus } = ctx;
  const group = new THREE.Group(); group.name = 'arena';
  const ids = [];
  const plateMap = plateTexture();
  const mats = {
    floor: makeMat({ color: 0x0a0507, roughness: 0.6, metalness: 0.2 }),
    wall: makeMat({ color: 0x150d11, roughness: 0.45, metalness: 0.55, emissive: 0x1c0610, emissiveIntensity: 0.35 }),
    tile: new THREE.MeshStandardMaterial({ color: 0xb8a4ac, map: plateMap, roughness: 0.38, metalness: 0.7, normalMap: detailNormal(), normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 1.5 }),
  };
  mats.concrete = mats.wall;
  mats.wall.envMapIntensity = 1.4;
  const box = (opts) => { const r = addBox({ group, physics, mats }, opts); if (r.id) ids.push(r.id); return r; };

  // ---------- colliders ----------
  box({ id: 'arena-floor', size: [36, 0.8, 36], pos: [0, -0.4, 0], mat: mats.floor, userData: { solid: true, ground: true }, cast: false });
  const wallH = 7;
  box({ size: [36, wallH, 1.2], pos: [0, wallH / 2, -18], mat: mats.wall, userData: { solid: true }, cast: false });
  box({ size: [36, wallH, 1.2], pos: [0, wallH / 2, 18], mat: mats.wall, userData: { solid: true }, cast: false });
  box({ size: [1.2, wallH, 36], pos: [-18, wallH / 2, 0], mat: mats.wall, userData: { solid: true }, cast: false });
  box({ size: [1.2, wallH, 36], pos: [18, wallH / 2, 0], mat: mats.wall, userData: { solid: true }, cast: false });

  // ---------- floor: hot seams under destructible plates ----------
  const seamMat = new THREE.MeshBasicMaterial({ map: seamTexture(), color: new THREE.Color(0xff3050).multiplyScalar(1.6) });
  seamMat.polygonOffset = true; seamMat.polygonOffsetFactor = -1; seamMat.polygonOffsetUnits = -1;
  const seams = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 7, TILE * 7), seamMat);
  seams.rotation.x = -Math.PI / 2; seams.position.y = 0.004;
  group.add(seams);
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (x === 0 && z === 0) continue;
    const tile = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.08, 3.8), mats.tile);
    tile.position.set(x * TILE, 0.02, z * TILE);
    tile.receiveShadow = true;
    tile.userData = { destructible: true, tile: `${x},${z}` };
    group.add(tile);
  }
  // the open centre cell: the reactor eye
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a55).multiplyScalar(2.2), transparent: true, opacity: 0.95 });
  const eye = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.6, 6), eyeMat);
  eye.rotation.x = -Math.PI / 2; eye.position.y = 0.02; group.add(eye);
  const eyeGlow = glowSprite(0xff2a55, 9, 0.4); eyeGlow.position.set(0, 0.6, 0); group.add(eyeGlow);
  const eyeLight = new THREE.PointLight(0xff2a55, 30, 26, 1.5); eyeLight.position.set(0, 1.6, 0); group.add(eyeLight);

  // ---------- walls: buttresses and light strips (one merged mesh each) ----------
  const strips = [];
  const butts = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    for (let k = -3; k <= 3; k++) {
      const b = new THREE.BoxGeometry(1.4, wallH + 5, 1.6);
      b.translate(k * 5, (wallH + 5) / 2, -18.15);
      b.rotateY(a);
      butts.push(b);
      const s = new THREE.BoxGeometry(0.12, wallH + 3.4, 0.08);
      s.translate(k * 5, (wallH + 3.4) / 2 + 0.4, -17.3);
      s.rotateY(a);
      strips.push(s);
    }
    const cap = new THREE.BoxGeometry(37.5, 0.5, 2.0);
    cap.translate(0, wallH + 0.25, -18);
    cap.rotateY(a);
    butts.push(cap);
  }
  const buttMesh = new THREE.Mesh(mergeGeometries(butts), mats.wall);
  butts.forEach((g) => g.dispose());
  buttMesh.receiveShadow = true;
  group.add(buttMesh);
  const stripMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a55).multiplyScalar(1.8) });
  const stripMesh = new THREE.Mesh(mergeGeometries(strips), stripMat);
  strips.forEach((g) => g.dispose());
  group.add(stripMesh);

  // ---------- props ----------
  const P = (name, x, z, o) => placeProp(group, physics, ids, props, name, x, z, o);
  P('speaker_stack', -15.2, -15.2, { yaw: Math.PI / 4, collide: true, scale: 1.3 });
  P('speaker_stack', 15.2, -15.2, { yaw: -Math.PI / 4, collide: true, scale: 1.3 });
  P('speaker_stack', -15.2, 15.2, { yaw: (3 * Math.PI) / 4, collide: true, scale: 1.3 });
  P('speaker_stack', 15.2, 15.2, { yaw: (-3 * Math.PI) / 4, collide: true, scale: 1.3 });
  P('monolith', -27, 6, { yaw: 1.3, y: -1 });
  P('monolith', 27, -4, { yaw: -1.5, y: -1 });
  P('monolith', 3, 29, { yaw: 3.0, scale: 1.2, y: -1 });
  P('panel_block', -6, -40, { yaw: 0.2, y: -6 });
  // the broken ring that used to tune this place
  const ring = P('resonance_ring', 0, 2, { scale: 1.7, y: 12.5 });
  if (ring) ring.rotation.x = 0.32;
  const sun = glowSprite(0xff3050, 26, 0.4); sun.position.set(0, 14.5, 2); group.add(sun);
  const shaft = lightCone({ color: 0xff3050, height: 15, radius: 6, topRadius: 1.4, opacity: 0.16 });
  shaft.position.set(0, 15, 1); group.add(shaft);

  // ---------- sky + air ----------
  const sky = skyDome({ top: 0x050104, horizon: 0x1c060c, glow: 0x4a0c18, glowPower: 4, stars: 0.5, radius: 150 });
  group.add(sky);
  const embers = createMotes(group, { count: 420, area: 40, height: 14, color: 0xff7a3a, size: 0.07, velocity: [0.15, 0.9, 0.1], sway: 0.6, opacity: 0.9, twinkle: 0.6 });

  // ---------- lighting ----------
  const hemi = new THREE.HemisphereLight(0xff8098, 0x0a0406, 0.55); group.add(hemi);
  const key = new THREE.DirectionalLight(0xffd6cc, 1.5);
  key.position.set(8, 22, -10); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.camera.left = -21; key.shadow.camera.right = 21; key.shadow.camera.top = 21; key.shadow.camera.bottom = -21;
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.03; key.shadow.radius = 3;
  group.add(key); group.add(key.target);
  const rimHot = new THREE.DirectionalLight(0xff2d6a, 0.95); rimHot.position.set(-4, 8, 16); group.add(rimHot);
  const rimCool = new THREE.DirectionalLight(0x3df0ff, 1.2); rimCool.position.set(6, 7, -16); group.add(rimCool);

  let envRT = null;
  if (renderer) {
    envRT = makeEnv(renderer, {
      sky: 0x12060a, hemiTop: 0xa04858, hemiBottom: 0x0a0406, hemi: 0.9,
      cards: [
        { color: 0xff3050, gain: 2.4, pos: [0, 16, 2], size: [12, 12] },
        { color: 0xff2d6a, gain: 1.6, pos: [-16, 4, 12], size: [3, 12] },
        { color: 0x3df0ff, gain: 1.2, pos: [14, 5, -14], size: [3, 10] },
        { color: 0xff7a3a, gain: 1.2, pos: [0, -6, 0], size: [20, 20] },
      ],
    });
    scene.environment = envRT.texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.75;
  }

  // ---------- the room follows the fight ----------
  const HOT = [new THREE.Color(0xff3050), new THREE.Color(0xff3050), new THREE.Color(0xff5a2a), new THREE.Color(0xff1a8a)];
  const CALM = new THREE.Color(0x3df0ff);
  const mood = new THREE.Color().copy(HOT[1]);
  const moodTarget = new THREE.Color().copy(HOT[1]);
  let heat = 1; // seam brightness multiplier, rises with the boss phase
  let heatTarget = 1;
  let beatPulse = 0;
  let slam = 0;
  const offs = [
    bus.on('beat', () => { beatPulse = 1; }),
    bus.on('bossPhase', (e) => {
      const p = Math.max(1, Math.min(3, e?.phase ?? 1));
      moodTarget.copy(HOT[p]);
      heatTarget = 1 + (p - 1) * 0.45;
    }),
    bus.on('bossAttack', () => { slam = 1; }),
    bus.on('bossDefeated', () => { moodTarget.copy(CALM); heatTarget = 0.7; }),
  ];

  scene.add(group);
  let t = 0;
  const tmp = new THREE.Color();
  return {
    name: 'arena', group, spawn: new THREE.Vector3(0, 0, -12), faceYaw: 0, portals: [], enemies: [], physicsIds: ids,
    fog: { color: 0x16070b, density: 0.013 }, clearColor: 0x070204,
    exposure: 1.15, far: 220,
    update(dt, playerPos) {
      t += dt;
      beatPulse = Math.max(0, beatPulse - dt * 4.5);
      slam = Math.max(0, slam - dt * 2.5);
      mood.lerp(moodTarget, Math.min(1, dt * 1.5));
      heat += (heatTarget - heat) * Math.min(1, dt * 1.5);
      const k = heat * (0.85 + beatPulse * 0.35 + slam * 0.8);
      seamMat.color.copy(mood).multiplyScalar(1.15 * k);
      stripMat.color.copy(mood).multiplyScalar(1.5 * k);
      eyeMat.color.copy(mood).multiplyScalar(2.0 * k);
      eye.rotation.z = t * 0.4;
      eyeLight.color.copy(mood); eyeLight.intensity = 15 * k;
      eyeGlow.material.color.copy(mood); eyeGlow.material.opacity = 0.3 + 0.12 * k;
      sun.material.color.copy(mood); sun.material.opacity = 0.3 + 0.1 * k;
      shaft.material.uniforms.uColor.value.copy(mood);
      rimHot.color.copy(mood);
      hemi.color.copy(tmp.copy(mood).lerp(WHITE, 0.6));
      embers.points.material.uniforms.uColor.value.copy(tmp.copy(mood).lerp(EMBER, 0.5));
      embers.update(dt, playerPos, -0.2);
      if (ring) { ring.rotation.y = t * 0.12; ring.rotation.x = 0.32 + Math.sin(t * 0.5) * 0.04; }
      sky.position.set(playerPos.x, 0, playerPos.z);
    },
    unload() {
      offs.forEach((off) => off?.());
      embers.dispose();
      plateMap.dispose(); seamMat.map?.dispose();
      if (envRT && scene.environment === envRT.texture) scene.environment = null;
      envRT?.dispose(); envRT = null;
      scene.remove(group);
      for (const id of ids) physics.remove(id);
    },
  };
}
