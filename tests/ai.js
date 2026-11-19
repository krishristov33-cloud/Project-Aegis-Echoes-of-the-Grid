// C1 test page: greybox rooftop arena, one Directorate squad (4 soldiers + drone), stub player.
import * as THREE from 'three';
import { createStage, box } from './harness/stage.js';
import { createBus } from './harness/bus.js';
import { PlayerStub } from './harness/player-stub.js';
import { createAI } from '../src/ai/director.js';

const [enemies, strings] = await Promise.all(['../src/data/enemies.json', '../src/data/strings.json'].map((u) => fetch(u).then((r) => r.json())));

const stage = createStage();
const { scene } = stage;
const bus = createBus();

// ---------- level greybox ----------
const floor = box(scene, { w: 64, h: 0.4, d: 64, x: 0, y: -0.4, z: 0, color: 0x1c222c });
const occluders = [];
const L = (o) => occluders.push(box(scene, o));
// high walls / vents
L({ w: 8, h: 2.6, d: 0.6, x: -10, z: -4 });
L({ w: 0.6, h: 2.6, d: 7, x: 9, z: -9 });
L({ w: 6, h: 2.6, d: 0.6, x: 3, z: 6, color: 0x46506a });
L({ w: 3, h: 3.2, d: 3, x: -18, z: 10, color: 0x46506a });
L({ w: 3, h: 3.2, d: 3, x: 18, z: 4, color: 0x46506a });
L({ w: 10, h: 2.6, d: 0.6, x: 0, z: -18 });
// low cover: crates / AC units
for (const [x, z] of [[-4, 12], [6, 14], [-12, 4], [13, -2], [-6, -11], [4, -10], [15, 12], [-15, -12], [0, 0], [-20, -2], [20, -14], [10, 22], [-10, 20]])
  L({ w: 1.6, h: 1.0, d: 1.6, x, z, color: 0x5a4a38 });
L({ w: 4, h: 1.2, d: 1.4, x: -3, z: 4, color: 0x52606e });
L({ w: 1.4, h: 1.2, d: 4, x: 22, z: -4, color: 0x52606e });

// ---------- AI ----------
const status = document.getElementById('status');
let ai;
try {
  ai = await createAI({ bus, player: null, level: { navMeshes: [floor, ...occluders], occluders, coverMeshes: occluders }, data: { enemies, strings } });
} catch (err) {
  status.textContent = `AI init failed: ${err.message}`;
  throw err;
}

const player = new PlayerStub({ bus, scene, nav: ai.nav, noise: enemies.noise, position: new THREE.Vector3(0, 0, 26) });
ai.player = player; // the stub clamps to the navmesh, so it is built after the AI
stage.follow(player.view);

function soldierView() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 4, 8).translate(0, 0.9, 0), new THREE.MeshStandardMaterial({ color: 0xc8344a }));
  body.castShadow = true;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.7), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  gun.position.set(0.18, 1.3, 0.4);
  g.add(body, gun);
  g.userData.body = body;
  scene.add(g);
  return g;
}

function droneView() {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.9), new THREE.MeshStandardMaterial({ color: 0x9aa4b4, emissive: 0x220000 }));
  g.add(hull);
  for (const [x, z] of [[0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]]) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 12), new THREE.MeshBasicMaterial({ color: 0x334 }));
    r.position.set(x, 0.12, z);
    g.add(r);
  }
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(2.2, 7, 20, 1, true).translate(0, -3.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
  );
  cone.rotation.x = -(Math.PI / 2 - 35 * (Math.PI / 180)); // pitch the beam forward/down
  g.add(cone);
  g.userData.cone = cone;
  g.userData.body = hull;
  scene.add(g);
  return g;
}

const V = (x, z) => new THREE.Vector3(x, 0, z);
const squad = ai.createSquad('alpha');
ai.spawnSoldier({ position: V(-8, -14), patrol: [V(-8, -14), V(-16, -6), V(-8, 2)], squad, view: soldierView() });
ai.spawnSoldier({ position: V(6, -14), patrol: [V(6, -14), V(14, -8), V(6, -4)], squad, view: soldierView() });
ai.spawnSoldier({ position: V(-2, -22), squad, view: soldierView(), yaw: 0 });
ai.spawnSoldier({ position: V(16, -18), patrol: [V(16, -18), V(22, -10)], squad, view: soldierView() });
ai.spawnDrone({ position: V(0, -6), patrol: [V(-14, -14), V(14, -14), V(14, 8), V(-14, 8)], squad, view: droneView() });

// ---------- debug visuals ----------
const navDebug = ai.nav.debugObject();
navDebug.visible = false;
scene.add(navDebug);
const coverDebug = ai.cover.debugObject();
coverDebug.visible = false;
scene.add(coverDebug);

const cones = new Map();
function coneFor(e) {
  if (cones.has(e.id)) return cones.get(e.id);
  const s = e.cfg.sight;
  const seg = 24;
  const verts = [0, 0, 0];
  for (let i = 0; i <= seg; i++) {
    const a = (-s.fov / 2 + (s.fov * i) / seg) * (Math.PI / 180);
    verts.push(Math.sin(a) * s.range, 0, Math.cos(a) * s.range);
  }
  const idx = [];
  for (let i = 1; i <= seg; i++) idx.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x40ff90, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
  m.visible = false;
  scene.add(m);
  cones.set(e.id, m);
  return m;
}

// tracers
const tracers = [];
bus.on('enemyShot', ({ from, to, hit, targetGhost }) => {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: targetGhost ? 0xb48cff : hit ? 0xff4060 : 0xffe080, transparent: true }));
  scene.add(l);
  tracers.push({ l, t: 0.09 });
});

// ghost decoy
let ghost = null;
function blink() {
  const from = player.position.clone();
  const dir = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  const to = ai.nav.closest(from.clone().addScaledVector(dir, 6)) ?? from.clone();
  if (ghost) scene.remove(ghost.mesh);
  const mesh = player.view.clone();
  mesh.traverse((o) => {
    if (o.material) o.material = new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.45 });
  });
  scene.add(mesh);
  ghost = { mesh, until: ai.now + enemies.ghost.belief };
  player.teleport(to);
  bus.emit('blink', { from, to, ghostId: 'ghost-' + Math.round(ai.now * 1000) });
}

// ---------- log + HUD ----------
const logEl = document.getElementById('log');
const sub = document.getElementById('subtitle');
let subT = 0;
function log(text, cls = 'event') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = `${ai.now.toFixed(1).padStart(6)}  ${text}`;
  logEl.prepend(d);
  while (logEl.children.length > 40) logEl.lastChild.remove();
}
const events = [];
bus.on('*', (type, p) => events.push({ t: ai.now, type, p }));
bus.on('callout', ({ speaker, text, key }) => {
  log(`${speaker}: "${text}"  [${key}]`, 'callout');
  sub.textContent = text;
  subT = 2.5;
});
bus.on('enemyDucked', ({ id, until }) => log(`${id} ducked ${(until - ai.now).toFixed(1)}s`));
bus.on('enemyKilled', ({ id }) => log(`${id} killed`, 'bad'));
bus.on('playerDamaged', ({ hp }) => {
  if (hp <= 0) log('PLAYER DOWN (press H to heal)', 'bad');
});

// ---------- input actions ----------
addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const views = ai.enemies.filter((x) => !x.dead).map((x) => x.view);
  const hit = stage.pick([...views, ...occluders]);
  bus.emit('noise', { pos: player.position.clone(), radius: enemies.noise.shot, kind: 'shot' });
  if (!hit) return;
  let o = hit.object;
  while (o && !o.userData.enemy) o = o.parent;
  if (o?.userData.enemy) o.userData.enemy.takeDamage(25, player);
});
addEventListener('pointermove', (e) => {
  const c = document.getElementById('crosshair');
  c.style.left = e.clientX + 'px';
  c.style.top = e.clientY + 'px';
});
addEventListener('contextmenu', (e) => e.preventDefault());

const show = { cones: true };
let frames = 0;
let fpsT = 0;
let fps = 0;

stage.loop((dt) => {
  const k = stage.pressed;
  if (k.has('KeyG')) log(`god mode ${(player.god = !player.god) ? 'ON' : 'off'}`);
  if (k.has('KeyH')) player.heal(100);
  if (k.has('KeyN')) navDebug.visible = !navDebug.visible;
  if (k.has('KeyC')) coverDebug.visible = !coverDebug.visible;
  if (k.has('KeyV')) show.cones = !show.cones;
  if (k.has('KeyR')) location.reload();
  if (k.has('KeyQ')) blink();
  if (k.has('KeyE') || k.has('KeyF')) {
    bus.emit('noise', { pos: player.position.clone(), radius: 12, kind: 'subBass' });
    bus.emit('sidechain', { source: { pos: player.position.clone(), radius: 5 }, strength: 1, onBeat: k.has('KeyF') });
    log(`sub-bass blast${k.has('KeyF') ? ' (on beat)' : ''}`);
  }

  player.update(dt, stage.moveInput(), stage.keys.has('ShiftLeft') || stage.keys.has('ShiftRight'));
  ai.update(dt);

  // visuals
  if (ghost && ai.now > ghost.until) {
    scene.remove(ghost.mesh);
    ghost = null;
  }
  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].t -= dt;
    if (tracers[i].t <= 0) {
      scene.remove(tracers[i].l);
      tracers[i].l.geometry.dispose();
      tracers.splice(i, 1);
    }
  }
  if (coverDebug.visible) ai.cover.updateDebug();
  for (const e of ai.enemies) {
    const cone = coneFor(e);
    cone.visible = show.cones && !e.dead;
    cone.position.copy(e.position).setY(e.kind === 'drone' ? 0.05 : e.position.y + 0.05);
    cone.rotation.y = e.yaw;
    const st = e.perception.state;
    cone.material.color.set(st === 'alert' ? 0xff4060 : st === 'suspicious' ? 0xffd040 : 0x40ff90);
    const body = e.view.userData.body;
    if (e.kind === 'soldier') {
      e.view.scale.y = e.dead ? 0.15 : e.crouched ? 0.65 : 1;
      body.material.color.set(e.dead ? 0x333333 : e.ducked ? 0x9a6cff : e.animState === 'hit' ? 0xffffff : 0xc8344a);
    } else {
      e.view.userData.cone.visible = e.spotlight;
      body.material.emissive.set(e.ducked ? 0x5020a0 : st === 'alert' ? 0x880000 : 0x111111);
    }
    const role = e.squad?.roleOf(e).role ?? '';
    const cls = e.dead ? 'dead' : e.ducked ? 'ducked' : st;
    const txt = e.dead ? `${e.id} ✕` : `${e.id} ${e.state}${e.kind === 'soldier' && e.state === 'combat' ? '/' + e.combat : ''} ${role} ${(e.perception.awareness * 100) | 0}%${e.perception.fooledByGhost ? ' GHOST' : ''}`;
    stage.label(e.id, e.position.clone().setY(e.position.y + 2.3), txt, cls);
  }

  // HUD
  document.querySelector('#hp > div').style.width = `${(player.hp / player.hpMax) * 100}%`;
  subT -= dt;
  if (subT <= 0) sub.textContent = '';
  frames++;
  fpsT += dt;
  if (fpsT >= 0.5) {
    fps = Math.round(frames / fpsT);
    frames = 0;
    fpsT = 0;
  }
  const info = stage.renderer.info.render;
  status.textContent =
    `fps ${fps}   draw calls ${info.calls}   LOS rays/frame ${ai.los.casts}\n` +
    `player hp ${player.hp.toFixed(0)}  ${player.state}${player.god ? '  GOD' : ''}\n` +
    `squad ${squad.name}: ${squad.mode}\n` +
    ai.enemies.map((e) => `${e.id.padEnd(10)} ${e.state.padEnd(11)} ${(e.squad?.roleOf(e).role ?? '').padEnd(8)} hp ${String(e.hp).padStart(3)}  aw ${((e.perception.awareness * 100) | 0).toString().padStart(3)}%`).join('\n') +
    `\ncover points ${ai.cover.points.length}`;
});

window.__test = { ai, player, bus, events, squad, THREE };
