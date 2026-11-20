import * as THREE from 'three';
import { bus, Events } from './core/events.js';
import { Time } from './core/time.js';
import { input, bindInput, endFrame, setScriptedInput, clearScriptedInput, keyJust, wantsBlink, wantsPhaseSkip, wantsWaveShield, wantsLaunchpad } from './core/input.js';
import { loadManifest, loadRole, initAssets, loadProp } from './core/assets.js';
import { createAudioClock } from './core/audio-clock.js';
import { initRapier, RapierWorld } from './physics/rapier-world.js';
import { createPlayer } from './player/controller.js';
import { ThirdPersonCamera } from './player/camera.js';
import { createRooftop } from './world/rooftop.js';
import { createEncounterFlow } from './world/encounter-flow.js';
import { createCradle } from './world/cradle.js';
import { createChamber } from './world/chamber.js';
import { createArena } from './world/arena.js';
import { createHud } from './ui/hud.js';
import { createTempoWidget } from './ui/tempo-widget.js';
import { initFX } from './fx/index.js';
import { createEncounters } from './ai/encounters.js';
import { createBlink } from './player/powers/blink.js';
import { createPowers } from './player/powers/powers.js';
import { createMixHealth } from './audio/mixhealth.js';
import { createSidechain } from './audio/sidechain.js';
import { createPost } from './fx/post.js';
import { createSfx } from './audio/sfx.js';

const QS = new URLSearchParams(location.search);
const DEBUG = QS.has('debug') || QS.has('shots');
const SHOTS = QS.has('shots');

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

function resize(renderer, camera, post) {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  post?.resize?.(w, h);
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
  const post = createPost({ renderer, scene, camera, tuning, bus });
  resize(renderer, camera, post);
  addEventListener('resize', () => resize(renderer, camera, post));

  await initAssets(renderer);

  const PROP_NAMES = ['hvac_neon', 'speaker_stack', 'panel_block', 'crate', 'resonance_ring', 'monolith', 'gate_arch', 'crystals', 'altar'];
  const props = {};
  await Promise.all(PROP_NAMES.map(async (n) => {
    try { props[n] = await loadProp(n, manifest); }
    catch (err) { console.warn('[assets] prop', n, err); }
  }));

  await initRapier();
  const physics = new RapierWorld();
  const time = new Time();
  if (SHOTS) time.maxDt = 0.08; // headless swiftshader runs few frames; let sim catch up
  const clock = createAudioClock(bus, tuning);
  createMixHealth(bus);
  createSidechain(bus);
  const sfx = createSfx({ bus, clock, tuning });

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
  const enemies = [];
  const getEnemies = () => enemies;

  const pawn = createPlayer({
    scene, physics, bus, clock, tuning, loaded: loadedPlayer, getEnemies,
  });
  const { player } = pawn;

  const orbit = new ThirdPersonCamera(camera, tuning);

  // Character lights: a cool rim from beyond the player and a soft fill from the camera, so the hero and
  // anything close to him read against the dark levels. Short range, no shadows.
  const CL = tuning.characterLight || {};
  const rimLight = new THREE.PointLight(new THREE.Color(CL.rimColor ?? '#a8ecff'), CL.rimIntensity ?? 26, CL.rimDistance ?? 7, 2);
  const fillLight = new THREE.PointLight(new THREE.Color(CL.fillColor ?? '#ffe6d0'), CL.fillIntensity ?? 9, CL.fillDistance ?? 9, 2);
  scene.add(rimLight, fillLight);
  const _camFwd = new THREE.Vector3();
  function placeCharacterLights() {
    camera.getWorldDirection(_camFwd).setY(0).normalize();
    rimLight.position.copy(player.position).addScaledVector(_camFwd, CL.rimBack ?? 2.2);
    rimLight.position.x += -_camFwd.z * (CL.rimSide ?? 1.1); rimLight.position.z += _camFwd.x * (CL.rimSide ?? 1.1);
    rimLight.position.y += CL.rimUp ?? 2.4;
    fillLight.position.copy(camera.position); fillLight.position.y += CL.fillUp ?? 0.6;
  }

  const encounters = createEncounters({
    bus, scene, physics, player, enemies, manifest,
    data: { enemies: QS.has('noai') ? { ...enemiesData, encounters: {} } : enemiesData, strings },
  });

  const flow = createEncounterFlow({ bus, scene, player, enemies, strings });


  const blink = createBlink({
    bus, player, physics, scene, clock, time,
    cfg: { ...(powers.blink || {}), bindKey: null },
  });
  blink.aimYaw = () => orbit.yaw;

  const c3 = createPowers({
    bus, physics, scene, player, clock, cfg: { ...powers, bindKeys: false },
    aimYaw: () => orbit.yaw,
  });

  const levelCtx = { scene, physics, strings, enemiesData, powers, puzzle, tuning, bus, manifest, props, renderer };
  const factories = {
    rooftop: createRooftop,
    cradle: createCradle,
    chamber: createChamber,
    arena: createArena,
  };
  let current = null;

  function goto(name) {
    if (!factories[name]) { console.warn('unknown level', name); return; }
    if (current) {
      current.unload();
      current = null;
    }
    const level = factories[name](levelCtx);
    current = level;
    if (level.fog) {
      scene.fog = (level.fog.density != null)
        ? new THREE.FogExp2(level.fog.color, level.fog.density)
        : new THREE.Fog(level.fog.color, level.fog.near, level.fog.far);
      renderer.setClearColor(level.clearColor ?? level.fog.color, 1);
    } else {
      scene.fog = null;
    }
    renderer.toneMappingExposure = level.exposure ?? 1.25;
    if (level.far) { camera.far = level.far; camera.updateProjectionMatrix(); }
    pawn.setSpawn(level.spawn);
    pawn.face(level.faceYaw ?? 0, true);
    orbit.setLook(level.faceYaw ?? 0, 0.28);
    bus.emit('levelState', { level: name, phase: 'enter' });
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
    get ai() { return encounters.ai; },
    encounters,
    blink,
    powers: c3,
    goto,
    tuning,
    strings,
    manifest,
    enemies,
    post,
    sfx,
    orbit,
    paused: false,
    /** Freeze the sim for `sec` real seconds (hit-stop). Longest request wins. */
    hitstop(sec) { hitstopUntil = Math.max(hitstopUntil, performance.now() / 1000 + sec); },
    /** Seconds left on each power, for the HUD: { blink, phaseSkip, waveShield, launchpad, blast } each {left, total}. */
    cooldowns() {
      return {
        blast: { left: player.combat.blastCd, total: tuning.combat?.blastCooldown ?? 2.5 },
        blink: { left: blink.cooldownLeft ?? 0, total: powers.blink?.cooldown ?? 2.8 },
        phaseSkip: { left: c3.phaseSkip.cooldownLeft ?? 0, total: powers.phaseSkip?.cooldown ?? 3.2 },
        waveShield: { left: c3.waveShield.cooldownLeft ?? 0, total: powers.waveShield?.cooldown ?? 8 },
        launchpad: { left: c3.launchpad.cooldownLeft ?? 0, total: powers.launchpad?.cooldown ?? 3 },
      };
    },
  };
  let hitstopUntil = 0;
  window.game = game;

  // One event drives all the hit feel: freeze frames, camera shake and kick (sfx, vfx and post listen too).
  const HS = tuning.combat?.hitstop || {};
  const CT = tuning.camera || {};
  bus.on('impact', (e) => {
    const s = Math.max(0, Math.min(1, e?.strength ?? 0.3));
    if (e.kind === 'land') { orbit.addTrauma(s * (CT.landTrauma ?? 0.35)); orbit.kick(-s * 0.02); return; }
    if (e.kind === 'hurt') { orbit.addTrauma(0.2 + s * (CT.hurtTrauma ?? 0.5)); game.hitstop(0.03 + s * 0.04); return; }
    orbit.addTrauma(s * (CT.impactTrauma ?? 0.42));
    orbit.kick((CT.impactKick ?? 0.012) * (0.5 + s));
    if (e.release) return; // the blast release shakes; only landed hits freeze
    game.hitstop((HS.base ?? 0.035) + s * (HS.perStrength ?? 0.07) + (e.kind === 'kill' ? (HS.kill ?? 0.05) : 0) + (e.onBeat ? (HS.onBeat ?? 0.02) : 0));
  });
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
    get ai() { return encounters.ai; },
    get encounters() { return encounters; },
    get blink() { return blink; },
    get powers() { return c3; },
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
    dodge() { pawn.dodge(); },
    tryVault() { return pawn.tryVault(orbit.yaw); },
    pose(name, t) { return pawn.loco.debugPose(name, t); },
    attack() { player.combat.requestMelee(); },
    pawn,
    blast() { player.combat.requestBlast(); },
    blinkNow() { return blink.trigger(orbit.yaw); },
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
    time.scale = performance.now() / 1000 < hitstopUntil ? 0.04 : (game.timeScale ?? 1);
    const dt = time.tick();
    if (game.paused) {
      // menus own the screen: keep drawing the frozen frame, drop gameplay input
      post.render(0);
      endFrame();
      return;
    }
    clock.update(dt);

    if (DEBUG && keyJust('Digit1')) goto('rooftop');
    if (DEBUG && keyJust('Digit2')) goto('cradle');
    if (DEBUG && keyJust('Digit3')) goto('chamber');
    if (DEBUG && keyJust('Digit4')) goto('arena');

    pawn.update(dt, orbit.yaw, orbit.pitch);
    orbit.setSpeed(Math.hypot(player.velocity.x, player.velocity.z));
    orbit.update(dt, player.position, physics);
    placeCharacterLights();
    if (wantsBlink()) blink.trigger(orbit.yaw);
    if (wantsPhaseSkip()) c3.phaseSkip.trigger(orbit.yaw);
    if (wantsWaveShield()) c3.waveShield.trigger(orbit.yaw);
    if (wantsLaunchpad()) c3.launchpad.place(orbit.yaw);
    blink.update(dt);
    c3.update(dt);
    current?.update?.(dt, player.position, bus);
    flow.update(dt, current);
    encounters.update(dt);
    fx.update(dt);

    if (portalLock > 0) portalLock -= dt;
    if (current?.portals && portalLock <= 0) {
      for (const p of current.portals) {
        if (p.locked) continue;
        const d = player.position.distanceTo(p.pos);
        if (d < (p.radius ?? 1.6) + 0.4) {
          hud.setPrompt(`${p.label || p.to}  ·  ${strings.hud?.walkIn || 'walk in'}`);
          if (d < p.radius) { portalLock = 1.0; goto(p.to); hud.setPrompt(''); break; }
        } else {
          hud.setPrompt('');
        }
      }
    }

    sfx.update?.(dt);
    post.render(dt);

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
      boss: (() => {
        const h = enemies.find((e) => e.kind === 'hulk' && !e.dead);
        return h ? { hp: h.hp, hpMax: h.hpMax, weak: !!h.weakOpen } : null;
      })(),
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
