// Per-level enemy encounters. One object for the whole game; on every `levelState {level, phase:'enter'}` it tears
// down the previous level's AI, builds a new director from the physics world (navmesh, cover, line of sight), and
// spawns the squads listed in enemies.json `encounters[level]`. Enemies are pushed into the game's enemy list so
// combat.js hits them like the training dummy.
//
//   import { createEncounters } from './ai/encounters.js';
//   const encounters = createEncounters({ bus, scene, physics, player, enemies, manifest, data: { enemies: enemiesData, strings } });
//   // in tick(): encounters.update(dt);
//
// Models come only from manifest roles (`soldier`, `drone`, `hulk`). Facing is detected from the canonical foot/toe
// bones, so any rig walks forwards without hardcoded bone names. This file is also the enemy VIEW layer: it turns
// each brain's animState / aim / hit / cue outputs into animation (enemy-anim.js), a rifle held by arm IK that
// really points at the aim point, hit flashes, death collapse + corpse sink-out, and the attack VFX (enemy-fx.js).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadRole } from '../core/assets.js';
import { createAI } from './director.js';
import { createHulk } from './hulk.js';
import { EnemyAnimator, solveLimb, rotateWorld, wrapPi, damp } from './enemy-anim.js';
import { createEnemyFx } from './enemy-fx.js';
import { fixLimbBleed, findHeldWeapon } from './skin-fix.js';

const V = (a) => new THREE.Vector3(a[0], a[1] ?? 0, a[2]);
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const RED = new THREE.Color(0xff3a1e);

/** One-shot fallbacks while a role lacks a clip (first that exists plays). */
const SHOT_FALLBACK = {
  stagger: ['stagger', 'hit'],
  shove: ['melee1', 'melee2'],
  reload: ['reload'],
  death: ['death'],
  hulkSlam: ['hulkSlam', 'melee3', 'melee1'],
  hulkThrow: ['hulkThrow', 'castThrow', 'melee2'],
  hulkRoar: ['hulkRoar', 'blast'],
  hulkStagger: ['hulkStagger', 'stagger', 'hit'],
};

/** Yaw (radians) that turns this model so its feet point down +Z (the game's forward). */
function detectYawOffset(loaded) {
  const foot = loaded.bones?.leftFoot ?? loaded.bones?.rightFoot;
  const toes = loaded.bones?.leftToes ?? loaded.bones?.rightToes;
  if (!foot || !toes) return 0;
  loaded.root.updateWorldMatrix(true, true);
  const a = foot.getWorldPosition(new THREE.Vector3());
  const b = toes.getWorldPosition(new THREE.Vector3());
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-4) return 0;
  return -Math.atan2(dx, dz); // rotate the model so (dx, dz) lines up with +Z
}

let rifleProto = null;
/** Directorate rifle: one merged mesh, barrel along +Z, grip at the origin. Shared geometry + material. */
function makeRifle(scale = 1) {
  if (!rifleProto) {
    const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const geo = mergeGeometries([
      box(0.055, 0.09, 0.42, 0, 0.05, 0.12), // receiver
      box(0.03, 0.03, 0.34, 0, 0.065, 0.48), // barrel
      box(0.045, 0.07, 0.24, 0, 0.03, -0.2), // stock
      box(0.04, 0.14, 0.06, 0, -0.06, 0.1), // magazine
      box(0.035, 0.1, 0.045, 0, -0.045, -0.02), // grip
      box(0.03, 0.035, 0.1, 0, 0.115, 0.08), // sight
    ]);
    const mat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.38, metalness: 0.6, emissive: 0xff2d6f, emissiveIntensity: 0.12 });
    rifleProto = { geo, mat };
  }
  const m = new THREE.Mesh(rifleProto.geo, rifleProto.mat);
  m.castShadow = true;
  m.scale.setScalar(scale);
  m.name = 'ai-rifle';
  return m;
}

async function makeView(role, manifest, animCfg) {
  const loaded = await loadRole(role, manifest);
  const holder = new THREE.Group();
  holder.name = `ai-${role}`;
  const inner = new THREE.Group();
  inner.rotation.y = detectYawOffset(loaded);
  inner.add(loaded.root);
  holder.add(inner);
  const bled = fixLimbBleed(loaded.root, loaded.bones);
  if (bled && globalThis.game) (globalThis.game.__skinFix ??= {})[role] = bled;
  const anim = new EnemyAnimator(loaded, { cfg: animCfg, height: loaded.height });
  holder.userData.deathClip = anim.ok && anim.has('death');
  return { holder, inner, loaded, anim, yaw: null, yawRate: 0, armW: 0, deadT: 0, seq: { hit: 0, shove: 0, reload: 0, cue: 0 }, muzzle: new THREE.Vector3(), rifleDir: new THREE.Vector3(0, 0, 1) };
}

export function createEncounters({ bus, scene, physics, player, enemies, manifest, data }) {
  let ai = null;
  let views = []; // { enemy, holder, inner, loaded, anim, rifle, ... }
  let token = 0;
  let debugNav = null;
  const A = data.enemies.anim ?? {};
  const fx = createEnemyFx({ bus, scene, cfg: data.enemies.fx });

  function teardown() {
    for (const v of views) {
      v.holder.removeFromParent();
      v.rifle?.removeFromParent();
      v.anim?.dispose();
    }
    views = [];
    fx.clear();
    if (ai) {
      for (const e of ai.enemies) {
        const i = enemies.indexOf(e);
        if (i >= 0) enemies.splice(i, 1);
      }
      ai.dispose();
      ai = null;
    }
    debugNav?.removeFromParent();
    debugNav = null;
  }

  async function enter(level) {
    const my = ++token;
    teardown();
    const spec = data.enemies.encounters?.[level];
    if (!spec?.squads?.length && !spec?.boss) return;
    let next;
    try {
      next = await createAI({ bus, player, physics, data });
    } catch (err) {
      console.warn('[ai] could not build AI for', level, err);
      return;
    }
    if (my !== token) return next.dispose(); // level changed while the navmesh was building
    ai = next;
    // the whole level's roster joins the game's enemy list in one go, so wave logic never sees half a squad
    const roster = [];
    for (const sq of spec.squads ?? []) {
      const squad = ai.createSquad(sq.name ?? level);
      for (const s of sq.soldiers ?? []) {
        const v = await makeView('soldier', manifest, A);
        if (my !== token) return;
        scene.add(v.holder);
        // most generated soldiers already hold a rifle that is part of the mesh; only arm the empty-handed ones
        const hand = v.loaded.bones?.rightHand;
        v.gun = hand ? findHeldWeapon(v.loaded.root, hand, { THREE }) : null;
        if (!v.gun) {
          v.rifle = makeRifle((v.loaded.height ?? 1.8) / 1.8);
          scene.add(v.rifle);
        }
        const e = ai.spawnSoldier({ position: V(s.pos), yaw: s.yaw ?? 0, patrol: (s.patrol ?? []).map(V), squad, view: v.holder });
        e.muzzleWorld = v.muzzle.copy(e.position).setY(e.position.y + 1.4);
        views.push({ enemy: e, ...v });
        roster.push(e);
      }
      for (const d of sq.drones ?? []) {
        const v = await makeView('drone', manifest, A);
        if (my !== token) return;
        scene.add(v.holder);
        const e = ai.spawnDrone({ position: V(d.pos), patrol: (d.patrol ?? []).map(V), squad, view: v.holder });
        views.push({ enemy: e, ...v });
        roster.push(e);
      }
    }
    // boss: { type: 'hulk', pos, yaw, role? } — gets the level's destructible floor tiles (userData.destructible)
    if (spec.boss?.type === 'hulk') {
      const v = await makeView(spec.boss.role ?? 'hulk', manifest, A);
      if (my !== token) return;
      scene.add(v.holder);
      const tiles = [];
      scene.traverse((o) => o.isMesh && o.userData?.destructible && tiles.push(o));
      const h = createHulk({
        bus, physics, scene, view: v.holder, position: V(spec.boss.pos), yaw: spec.boss.yaw ?? 0,
        cfg: data.enemies.hulk, clock: globalThis.game?.clock, tiles,
      });
      ai.register(h);
      // weak points ride the skeleton (shoulders + upper back) instead of floating at fixed offsets
      v.holder.updateMatrixWorld(true);
      const hb = v.loaded.bones ?? {};
      const mounts = [hb.leftShoulder ?? hb.leftUpperArm, hb.rightShoulder ?? hb.rightUpperArm, hb.upperChest ?? hb.chest ?? hb.spine];
      h.weakPoints.forEach((w, i) => mounts[i] && mounts[i].attach(w));
      views.push({ enemy: h, ...v });
      roster.push(h);
    }
    enemies.push(...roster);
  }

  // ---------- view updates ----------
  function playShot(v, key, opts) {
    for (const name of SHOT_FALLBACK[key] ?? [key]) if (v.anim.play(name, opts)) return true;
    return false;
  }

  /** Smooth the brain's yaw for display; returns the yaw rate (rad/s). */
  function smoothYaw(v, e, dt) {
    if (v.yaw === null) v.yaw = e.yaw;
    const prev = v.yaw;
    v.yaw = wrapPi(v.yaw + wrapPi(e.yaw - v.yaw) * (1 - Math.exp(-(A.yawSmooth ?? 14) * dt)));
    v.holder.rotation.y = v.yaw;
    v.yawRate = damp(v.yawRate, wrapPi(v.yaw - prev) / Math.max(dt, 1e-4), 10, dt);
    return v.yawRate;
  }

  /** Corpse: finish the collapse, rest, sink into the floor, disappear. True while it still needs drawing. */
  function corpse(v, dt, clipTime) {
    v.deadT += dt;
    const rest = A.corpseTime ?? 3.5;
    const sink = A.corpseSink ?? 1.4;
    if (v.deadT <= clipTime + 0.25) v.anim.update(dt);
    else if (!v.anim.frozen) v.anim.freeze();
    if (v.deadT > clipTime + rest) {
      const u = (v.deadT - clipTime - rest) / sink;
      v.inner.position.y = -1.3 * u * u;
      if (u >= 1) {
        v.holder.visible = false;
        v.rifle && (v.rifle.visible = false);
        v.gone = true;
      }
    }
  }

  function hitReaction(v, e) {
    if (v.seq.hit === e.hitSeq) return;
    v.seq.hit = e.hitSeq;
    const h = e.lastHit ?? {};
    v.anim.flash(h.fatal || h.heavy || h.weak ? 1.6 : 1);
    if (h.dir) {
      // push direction in the body's local frame (z forward)
      const s = Math.sin(e.yaw);
      const c = Math.cos(e.yaw);
      const lx = h.dir.x * c - h.dir.z * s;
      const lz = h.dir.x * s + h.dir.z * c;
      v.anim.flinch(lx, lz, h.heavy ? 1.3 : 0.8);
    } else v.anim.flinch(0, -1, 0.5);
    fx.pop(_v.copy(e.position).setY(e.position.y + (e.kind === 'drone' ? 0 : (v.loaded.height ?? 1.8) * 0.65)), h.heavy || h.fatal ? 0.34 : 0.2, h.onBeat ? 0x3df0ff : 0xffffff, 0.1);
    return h;
  }

  function updateSoldier(v, dt) {
    const e = v.enemy;
    const anim = v.anim;
    if (e.dead) {
      if (!v.deathStarted) {
        v.deathStarted = true;
        v.holder.rotation.y = v.yaw = e.yaw;
        hitReaction(v, e);
        v.deathClip = playShot(v, 'death', { hold: true, fade: 0.08 }) ? (anim.playing ? anim.shot.ch.dur : 1.3) : 0.6;
        anim.setAim(0, 0, 0);
        anim.setLook(0, 0, 0);
      }
      corpse(v, dt, v.deathClip);
      if (!v.gone) placeRifle(v, e, dt, 0);
      return;
    }
    const yawRate = smoothYaw(v, e, dt);
    const speed = Math.hypot(e.velocity.x, e.velocity.z);
    anim.setMotion(speed, yawRate);

    const st = e.animState;
    const moving = speed > 0.3;
    let lower = 'loco';
    let upper = 'loco';
    let arms = 0;
    switch (st) {
      case 'aim': lower = 'aim'; upper = 'aim'; arms = 1; break;
      case 'aimWalk': upper = 'aim'; arms = 1; break;
      case 'fire': lower = moving ? 'loco' : 'aim'; upper = 'fire'; arms = 1; break;
      case 'crouch': lower = upper = 'crouch'; break;
      case 'crouchAim': lower = upper = 'crouchAim'; arms = 1; break;
      case 'crouchFire': lower = 'crouchAim'; upper = 'fire'; arms = 1; break;
      case 'reload': lower = moving ? 'loco' : 'aim'; upper = 'aim'; break;
      case 'crouchReload': lower = 'crouch'; upper = 'crouchAim'; break;
      case 'ducked': case 'stagger': lower = upper = 'ducked'; break;
      default: break;
    }
    anim.setPose(lower, upper);

    hitReaction(v, e) && !e.dead && playShot(v, 'stagger', { duration: Math.max(0.3, Math.min(0.9, e.staggerT || 0.45)), fade: 0.05, fadeOut: 0.16 });
    if (v.seq.shove !== e.shoveSeq) {
      v.seq.shove = e.shoveSeq;
      const S = e.cfg.shove ?? {};
      playShot(v, 'shove', { duration: (S.windup ?? 0.5) / (A.shoveStrikeAt ?? 0.3), fade: 0.08, fadeOut: 0.2 });
    }
    if ((e.reloadSeq ?? 0) !== v.seq.reload) {
      v.seq.reload = e.reloadSeq ?? 0;
      playShot(v, 'reload', { duration: e.weapon.cfg.reloadTime, upperOnly: true, fade: 0.15, fadeOut: 0.2 });
    }
    if (anim.playing) arms = 0;

    // torso aim + head look
    const chestY = (v.loaded.height ?? 1.8) * (e.crouched ? 0.5 : 0.76);
    if (e.aimWorld && arms) {
      _a.copy(e.aimWorld).sub(_v.copy(e.position).setY(e.position.y + chestY));
      anim.setAim(wrapPi(Math.atan2(_a.x, _a.z) - v.yaw), Math.atan2(_a.y, Math.hypot(_a.x, _a.z)), 1);
      anim.setLook(0, 0, 0);
    } else {
      anim.setAim(0, 0, 0);
      const look = e.lookWorld;
      if (look) {
        _a.copy(look).setY(look.y + 1.2).sub(_v.copy(e.position).setY(e.position.y + chestY + 0.3));
        anim.setLook(wrapPi(Math.atan2(_a.x, _a.z) - v.yaw), Math.atan2(_a.y, Math.hypot(_a.x, _a.z)), 1);
      } else anim.setLook(0, 0, 0);
    }
    anim.update(dt);
    v.armW = damp(v.armW, e.aimWorld ? arms : 0, A.armBlend ?? 10, dt);
    placeRifle(v, e, dt, v.armW);
  }

  /**
   * Hands on the rifle and the rifle on target. With weight 1 both arms are solved onto a grip frame built from
   * the chest and the aim direction, so the barrel (and the muzzle the weapon fires from) really points at the
   * aim point whatever the clip does. With weight 0 the rifle is carried low in the right hand.
   */
  function placeRifle(v, e, dt, w) {
    const b = v.loaded.bones ?? {};
    if (!b.rightHand || !b.rightUpperArm || !b.leftUpperArm) return;
    const k = (v.loaded.height ?? 1.8) / 1.8;
    v.loaded.root.updateMatrixWorld(true);
    const chest = (b.upperChest ?? b.chest ?? b.spine ?? b.rightHand).getWorldPosition(new THREE.Vector3());
    const bodyF = _f.set(Math.sin(v.yaw ?? e.yaw), 0, Math.cos(v.yaw ?? e.yaw));
    let dir = null;
    if (w > 0.01 && e.aimWorld) {
      dir = _b.copy(e.aimWorld).sub(chest);
      if (dir.lengthSq() < 0.04) dir = null;
      else {
        dir.normalize();
        // never aim through our own back: keep the barrel inside the front hemisphere
        if (dir.dot(bodyF) < 0.15) dir.lerp(bodyF, 0.6).normalize();
      }
    }
    const gun = v.gun;
    if (dir) {
      const right = new THREE.Vector3().crossVectors(dir, UP).normalize(); // character right
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      const back = gun ? Math.min(0.3, gun.back) : 0.2;
      const grip = chest.clone().addScaledVector(dir, (0.06 + back) * k).addScaledVector(right, 0.15 * k).addScaledVector(up, -0.17 * k);
      const rs = b.rightUpperArm.getWorldPosition(new THREE.Vector3());
      const ls = b.leftUpperArm.getWorldPosition(new THREE.Vector3());
      const poleR = rs.clone().addScaledVector(right, 0.5).addScaledVector(up, -0.8).addScaledVector(dir, -0.1);
      const poleL = ls.clone().addScaledVector(right, -0.45).addScaledVector(up, -0.8).addScaledVector(dir, 0.1);
      solveLimb(b.rightUpperArm, b.rightLowerArm, b.rightHand, grip, poleR, w);
      if (gun) {
        // swing the hand so the modelled rifle's barrel lies on the aim line
        b.rightHand.updateWorldMatrix(true, false);
        const cur = _v.copy(gun.axis).applyQuaternion(b.rightHand.getWorldQuaternion(_q)).normalize();
        const swing = new THREE.Quaternion().setFromUnitVectors(cur, dir);
        rotateWorld(b.rightHand, new THREE.Quaternion().slerp(swing, w));
        b.rightHand.updateWorldMatrix(false, true);
      }
      const hand0 = b.rightHand.getWorldPosition(new THREE.Vector3());
      const fore = gun ? Math.min(0.36, gun.front * 0.5) : 0.33;
      const support = hand0.addScaledVector(dir, fore * k).addScaledVector(up, -0.02 * k).addScaledVector(right, -0.02 * k);
      solveLimb(b.leftUpperArm, b.leftLowerArm, b.leftHand, support, poleL, w);
    }
    const hand = b.rightHand.getWorldPosition(new THREE.Vector3());
    if (gun) {
      b.rightHand.updateWorldMatrix(true, false);
      const z = _v.copy(gun.axis).applyQuaternion(b.rightHand.getWorldQuaternion(_q)).normalize();
      v.rifleDir.copy(z);
      v.muzzle.copy(hand).addScaledVector(z, gun.front);
      return;
    }
    if (!v.rifle) return;
    // box rifle: carried along the forearm, tipped forward and down; on the aim line while aiming
    const carry = _v.copy(hand).sub(b.rightLowerArm.getWorldPosition(_a)).normalize().multiplyScalar(0.55).addScaledVector(bodyF, 0.7).add(_u.set(0, -0.35, 0)).normalize();
    const want = dir ? carry.lerp(dir, Math.min(1, w * 1.15)).normalize() : carry;
    v.rifleDir.lerp(want, 1 - Math.exp(-22 * dt)).normalize();
    const z = v.rifleDir;
    const x = _r.crossVectors(UP, z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = _u.crossVectors(z, x);
    v.rifle.quaternion.setFromRotationMatrix(_m.makeBasis(x, y, z));
    v.rifle.position.copy(hand).addScaledVector(y, 0.02 * k).addScaledVector(z, 0.02 * k);
    v.muzzle.copy(v.rifle.position).addScaledVector(z, 0.66 * k).addScaledVector(y, 0.065 * k);
  }

  function updateHulk(v, dt) {
    const e = v.enemy;
    const anim = v.anim;
    if (v.seq.cue !== e.cue.seq) {
      v.seq.cue = e.cue.seq;
      const c = e.cue;
      if (c.name === 'death') {
        v.holder.userData.deathClip = playShot(v, 'death', { hold: true, fade: 0.15, duration: Math.max(1.6, (e.cfg.deathTime ?? 2.6) * 0.75) });
        v.deathClip = e.cfg.deathTime ?? 2.6;
      } else if (c.name) playShot(v, c.name, { duration: c.duration ?? undefined, fade: 0.12, fadeOut: 0.25 });
    }
    if (v.seq.hit !== e.hitSeq) {
      v.seq.hit = e.hitSeq;
      const h = e.lastHit ?? {};
      anim.flash(h.weak ? 1.5 : 0.5);
      anim.flinch(0, -1, h.weak ? 0.9 : 0.25);
      fx.pop(_v.copy(e.position).setY(e.position.y + e.cfg.height * 0.7), h.weak ? 0.9 : 0.4, h.weak ? 0x3df0ff : 0xffffff, 0.12);
    }
    if (e.dead) {
      v.deadT += dt;
      // the body stays (victory beat); just stop animating once it has settled
      if (v.deadT <= (v.deathClip ?? 2.6) + 0.5) anim.update(dt);
      else if (!anim.frozen) anim.freeze();
      return;
    }
    const yawRate = smoothYaw(v, e, dt);
    const moving = e.animState === 'walk';
    anim.setMotion(moving ? e.cfg.speed[e.phase - 1] : 0, yawRate);
    anim.setPose(e.ducked && !anim.playing ? 'ducked' : 'loco');
    // the head follows the player
    const pl = ai?.player;
    if (pl && !e.ducked) {
      _a.copy(pl.position).setY(pl.position.y + 1.2).sub(_v.copy(e.position).setY(e.position.y + e.cfg.height * 0.85));
      anim.setLook(wrapPi(Math.atan2(_a.x, _a.z) - v.yaw), Math.atan2(_a.y, Math.hypot(_a.x, _a.z)), 0.8);
    } else anim.setLook(0, 0, 0);
    anim.update(dt);
  }

  function updateDrone(v, dt) {
    const e = v.enemy;
    const anim = v.anim;
    if (v.seq.hit !== e.hitSeq) {
      v.seq.hit = e.hitSeq;
      anim.flash(e.lastHit?.fatal ? 2 : 1.2);
      fx.pop(e.position, e.lastHit?.fatal ? 0.9 : 0.4, e.lastHit?.onBeat ? 0x3df0ff : 0xffffff, 0.12);
    }
    if (e.dead) {
      v.deadT += dt;
      if (e._crashed && !v.crashPop) {
        v.crashPop = true;
        fx.pop(e.position, 1.2, 0xff7a2d, 0.2);
      }
      if (e._crashed && v.deadT > (A.corpseTime ?? 3.5) + 1) {
        v.holder.visible = false;
        v.gone = true;
      }
      anim.update(dt);
      return;
    }
    // glow hot while winding up a dive
    const d = e.dive;
    if (d?.phase === 'windup') {
      anim.tint(RED, 0.3 + 1.2 * Math.min(1, d.t / Math.max(0.05, d.dur)));
      v.tinted = true;
    } else if (d?.phase === 'dive') {
      anim.tint(RED, 1.6);
      v.tinted = true;
    } else if (v.tinted) {
      anim.tint(null);
      v.tinted = false;
    }
    if (!v.tinted) anim.update(dt);
  }

  const off = bus.on('levelState', (e) => {
    if (e?.phase === 'enter') enter(e.level);
  });

  return {
    get ai() {
      return ai;
    },
    /** Debug / tests: the live view records. */
    get views() {
      return views;
    },
    fx,

    update(dt) {
      if (!ai) return;
      ai.update(dt);
      for (const v of views) {
        const e = v.enemy;
        if (v.rifle) v.rifle.visible = !e._flowPark && !v.gone;
        if (v.gone || e._flowPark) continue;
        if (e.kind === 'soldier') updateSoldier(v, dt);
        else if (e.kind === 'hulk') updateHulk(v, dt);
        else updateDrone(v, dt);
      }
      fx.update(dt, ai.enemies, ai.player);
    },

    /** Debug: show the navmesh of the current level. */
    showNavmesh(on = true) {
      if (!ai) return;
      if (on && !debugNav) scene.add((debugNav = ai.nav.debugObject()));
      if (!on && debugNav) {
        debugNav.removeFromParent();
        debugNav = null;
      }
    },

    dispose() {
      off?.();
      token++;
      teardown();
      fx.dispose();
    },
  };
}
