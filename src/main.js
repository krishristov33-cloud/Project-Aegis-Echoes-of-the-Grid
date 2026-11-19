import * as THREE from 'three';
import { bus, Events } from './core/events.js';
import { Time } from './core/time.js';
import { input, bindInput, endFrame, setScriptedInput, clearScriptedInput, keyJust } from './core/input.js';
import { loadManifest, loadRole } from './core/assets.js';
import { createAudioClock } from './core/audio-clock.js';
import { PhysicsWorld } from './core/physics.js';
import { createPlayer } from './player/controller.js';
import { ThirdPersonCamera } from './player/camera.js';
import { createRooftop } from './world/rooftop.js';
import { createCradle } from './world/cradle.js';
import { createChamber } from './world/chamber.js';
import { createArena } from './world/arena.js';
import { createHud } from './ui/hud.js';
import { createTempoWidget } from './ui/tempo-widget.js';
import { bootLevelAI, tickEnemyViews } from './world/ai-hook.js';
import { initFX } from './fx/index.js';
import { createMixHealth } from './audio/mixhealth.js';
import { createSidechain } from './audio/sidechain.js';

const QS = new URLSearchParams(location.search);
const DEBUG = QS.has('debug') || QS.has('shots');
const SHOTS = QS.has('shots');

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

function resize(renderer, camera) {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

async function boot() {
  const [tuning, strings, enemiesData, powers, puzzle, manifest] = await Promise.all([
    loadJSON('src/data/tuning.json'),
    loadJSON('src/data/strings.json'),
    loadJSON('src/data/enemies.json'),
    loadJSON('src/data/powers.json'),
    loadJSON('src/data/puzzle.json'),
    loadManifest('assets/manifest.json'),
  ]);

  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(tuning.camera?.fov ?? 60, 1, 0.1, 200);
  resize(renderer, camera);
  addEventListener('resize', () => resize(renderer, camera));

  const physics = new PhysicsWorld();
  const time = new Time();
  if (SHOTS) time.maxDt = 0.08; // headless swiftshader runs few frames; let sim catch up
  const clock = createAudioClock(bus, tuning);
  createMixHealth(bus);
  createSidechain(bus);

  const hud = createHud({ root: document.getElementById('hud'), strings, bus, debug: DEBUG });
  const tempo = createTempoWidget({ root: document.getElementById('hud'), bus, strings });
  const titleEl = document.getElementById('title-text');
  const subEl = document.getElementById('subtitle-text');
  if (titleEl) titleEl.textContent = strings.title || 'Project Aegis';
  if (subEl) subEl.textContent = strings.subtitle || '';

  bindInput(canvas, {
    onLock: () => hud.hideStart(),
    onUnlock: () => { if (!SHOTS) hud.showStart(); },
  });

  // Assets via manifest only
  let loadedPlayer;
  try { loadedPlayer = await loadRole('player', manifest); }
  catch (err) {
    console.warn('[aegis] player load failed', err);
    loadedPlayer = await loadRole('player', { roles: { player: { url: null, fallback: 'capsule', height: 1.8, radius: 0.32, clipMap: {} } } });
  }
  let loadedSoldier = null;
  try { loadedSoldier = await loadRole('soldier', manifest); }
  catch (err) { console.warn('[aegis] soldier load failed', err); }
  let loadedDrone = null;
  try {
    loadedDrone = await loadRole('drone', manifest);
    if (!loadedDrone?.entry?.url) loadedDrone = null;
  } catch (err) { console.warn('[aegis] drone load failed', err); }

  const enemies = [];
  const getEnemies = () => enemies;

  const pawn = createPlayer({
    scene, physics, bus, clock, tuning, loaded: loadedPlayer, getEnemies,
  });
  const { player } = pawn;

  const orbit = new ThirdPersonCamera(camera, tuning);

  const levelCtx = { scene, physics, strings, enemiesData, powers, puzzle, tuning, loadedSoldier, bus };
  const factories = {
    rooftop: createRooftop,
    cradle: createCradle,
    chamber: createChamber,
    arena: createArena,
  };
  let current = null;
  let gotoToken = 0;

  async function goto(name) {
    if (!factories[name]) { console.warn('unknown level', name); return; }
    const token = ++gotoToken;
    if (current) {
      current.ai?.dispose();
      current.ai = null;
      enemies.length = 0;
      current.unload();
      current = null;
    }
    const level = factories[name](levelCtx);
    current = level;
    if (current.enemies) enemies.push(...current.enemies);
    if (level.fog) {
      scene.fog = new THREE.Fog(level.fog.color, level.fog.near, level.fog.far);
      renderer.setClearColor(level.clearColor ?? level.fog.color, 1);
    }
    pawn.setSpawn(level.spawn);
    pawn.face(level.faceYaw ?? 0, true);
    orbit.setLook(level.faceYaw ?? 0, 0.28);
    bus.emit('levelState', { level: name, phase: 'enter' });
    if (level.navMeshes?.length && level.spawns?.length) {
      try {
        const ai = await bootLevelAI(level, {
          bus, player, enemiesData, strings, loadedSoldier, loadedDrone,
        });
        if (token !== gotoToken) { ai?.dispose(); return; }
        if (ai) {
          enemies.length = 0;
          enemies.push(...ai.enemies);
        }
      } catch (err) {
        console.warn('[aegis] AI boot failed', err);
      }
    }
  }

  // game.player contract + debug hooks
  const game = {
    bus,
    player,
    scene,
    camera,
    renderer,
    physics,
    time,
    clock,
    input,
    get level() { return current?.name; },
    get ai() { return current?.ai || null; },
    goto,
    tuning,
    strings,
    manifest,
    enemies,
  };
  window.game = game;
  const fx = initFX(game);
  window.AG = {
    version: '0.1.0',
    ready: false,
    modelLoaded: player.modelLoaded,
    get player() { return player; },
    get camera() { return camera; },
    get bus() { return bus; },
    get game() { return game; },
    get clock() { return clock; },
    get ai() { return current?.ai || null; },
    Events,
    state() {
      return {
        state: player.state,
        speed: Math.hypot(player.velocity.x, player.velocity.z),
        fps: time.fps,
        grounded: player.isGrounded,
        pos: player.position.toArray(),
        hp: player.hp,
        level: current?.name,
        modelLoaded: player.modelLoaded,
        yaw: player.yaw,
        bpm: clock.getBpm(),
        phase: clock.getPhase(),
        onBeat: clock.isOnBeat(),
        enemies: enemies.length,
      };
    },
    tp(x, z, y) {
      if (y === undefined) {
        const fromY = Math.max(player.position.y + 4, 10);
        const hit = physics.raycast(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0), fromY + 12, { ground: true });
        y = hit ? hit.point.y : 0;
      }
      player.position.set(x, y, z);
      player.velocity.set(0, 0, 0);
      player.isGrounded = true;
    },
    cam(yaw, pitch, dist) { orbit.setLook(yaw, pitch); if (dist) { orbit.distance = dist; orbit._dist = dist; } },
    face(yaw) { pawn.face(yaw, true); },
    setInput: setScriptedInput,
    clearInput: clearScriptedInput,
    jump() { pawn.jump(); },
    tryVault() { return pawn.tryVault(orbit.yaw); },
    attack() { player.combat.requestMelee(); },
    blast() { player.combat.requestBlast(); },
    damage(n) { player.takeDamage(n ?? 10, 'debug'); },
    goto,
  };

  goto('rooftop');
  hud.hideLoading();
  if (SHOTS || DEBUG) {
    hud.hideStart();
  } else {
    hud.showStart();
  }

  const startEl = document.getElementById('start');
  startEl?.addEventListener('click', () => {
    hud.hideStart();
    canvas.requestPointerLock?.();
  });

  let portalLock = 0;
  function tick() {
    requestAnimationFrame(tick);
    const dt = time.tick();
    clock.update(dt);

    if (DEBUG && keyJust('Digit1')) goto('rooftop');
    if (DEBUG && keyJust('Digit2')) goto('cradle');
    if (DEBUG && keyJust('Digit3')) goto('chamber');
    if (DEBUG && keyJust('Digit4')) goto('arena');

    pawn.update(dt, orbit.yaw);
    orbit.update(dt, player.position, physics);
    current?.ai?.update(dt);
    tickEnemyViews(current?.ai, dt);
    current?.update?.(dt, player.position, bus);
    fx.update(dt);

    if (portalLock > 0) portalLock -= dt;
    if (current?.portals && portalLock <= 0) {
      for (const p of current.portals) {
        const d = player.position.distanceTo(p.pos);
        if (d < (p.radius ?? 1.6) + 0.4) {
          hud.setPrompt(`${p.label || p.to}  ·  walk in`);
          if (d < p.radius) { portalLock = 1.0; goto(p.to); hud.setPrompt(''); break; }
        } else {
          hud.setPrompt('');
        }
      }
    }

    renderer.render(scene, camera);

    hud.update({
      state: player.state,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      fps: time.fps,
      grounded: player.isGrounded,
      hp: player.hp,
      hpMax: player.hpMax,
      model: player.modelLoaded ? (player.role || 'player') : 'capsule fallback',
      level: current?.name,
      bpm: clock.getBpm(),
      phase: clock.getPhase(),
      onBeat: clock.isOnBeat(),
      dt,
    });
    tempo.update(dt);
    endFrame();
    if (!AG.ready) { AG.ready = true; window.__AG_BOOTED = true; }
  }
  tick();
}

boot().catch((err) => {
  console.error(err);
  const d = document.getElementById('err') || document.body.appendChild(document.createElement('div'));
  d.id = 'err';
  d.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;background:#200;color:#fff;padding:12px;z-index:50;white-space:pre-wrap';
  d.textContent = 'Aegis failed to start:\n' + (err && err.stack || err);
});
