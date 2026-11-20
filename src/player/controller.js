import * as THREE from 'three';
import { Locomotion } from './locomotion.js';
import { Combat, createCombatFx } from './combat.js';
import { moveAxis, wantsSprint, wantsWalk, wantsJump, jumpHeld, wantsMelee, wantsBlast, wantsDodge } from '../core/input.js';
import { animTuning } from './animTuning.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const D2R = Math.PI / 180;

/**
 * Player pawn. Exposes the game.player contract:
 *   position, velocity, isGrounded, hp, state, applyImpulse(v), takeDamage(n, src)
 *
 * Movement model: the stick sets a wish direction; on the ground the velocity turns toward it at a rate that
 * drops with speed (weight without mush), reversals at speed plant and skid, the jump is buffered, has coyote
 * time and a variable height, hard landings roll out their momentum, and a dodge gives a burst with i-frames.
 * Emits `playerAction {name, ...}`, `playerDied`, `playerRespawned` and `noise`.
 */
export function createPlayer(ctx) {
  const { scene, physics, bus, clock, tuning, loaded, getEnemies } = ctx;
  const T = tuning.player;
  const DG = tuning.dodge || {};

  const object = new THREE.Group();
  object.name = 'player';
  object.add(loaded.root);
  scene.add(object);

  const loco = new Locomotion(loaded, object, {
    tuning,
    onFootstep: (side, speed) => {
      bus.emit('noise', { pos: object.position.clone(), radius: speed > T.runSpeed + 0.5 ? 6 : 3.5, kind: 'footstep', side, speed });
    },
  });

  const player = {
    object,
    position: object.position,
    velocity: new THREE.Vector3(),
    isGrounded: true,
    hp: T.hpMax,
    hpMax: T.hpMax,
    state: 'idle',
    modelLoaded: !loaded.fallback,
    role: loaded.role,
    radius: loaded.radius || T.radius,
    height: loaded.height || T.height,
    yaw: 0,
    loco,
    combat: null,
    busy: false,       // dodge / roll / vault own the body
    dodging: false,
    _impulse: new THREE.Vector3(),
    _coyote: 0,
    _jumpBuf: 0,
    _dodgeBuf: 0,
    _dodgeCd: 0,
    _vault: null,
    _dodge: null,
    _roll: null,
    _landT: 0,
    _landLock: 0,
    _jumping: false,
    _skid: 0,
    _fallFrom: 0,
    _spawn: new THREE.Vector3(),
    _checkpoint: new THREE.Vector3(),
    _cpT: 0,
    _deadT: 0,
    _dead: false,
    _iframe: 0,
    _dashT: 0,
    _sinceHurt: 0,
    _regenT: 0,
    applyImpulse(v) {
      this._impulse.add(v);
    },
    takeDamage(n, src) {
      return this.combat.takeDamage(n, src, this);
    },
    heal(n) { this.combat.heal(n, this); },
  };

  const combat = new Combat({ bus, clock, tuning, loco, object, getEnemies });
  player.combat = combat;
  const fx = createCombatFx();
  scene.add(fx.group);

  const dir = new THREE.Vector3(0, 0, 1); // ground travel direction (unit)
  const _wish = new THREE.Vector3();
  const _v = new THREE.Vector3();

  // Power gestures: the powers move the body, the animation layer shows the effort.
  const P = tuning.powerAnim || {};
  const offs = [
    bus.on('playerDamaged', () => { player._sinceHurt = 0; }),
    bus.on('blink', () => { if (player.hp > 0) loco.play('blinkIn', { fade: 0.02, fadeOut: 0.22 }); }),
    bus.on('phaseSkip', () => {
      if (player.hp <= 0) return;
      combat.interrupt(0.05);
      loco.play('dash', { fade: 0.04, fadeOut: 0.16, loop: true });
      player._dashT = P.phaseSkipHold ?? 0.34;
    }),
    bus.on('waveShield', (e) => {
      if (player.hp <= 0) return;
      const yaw = e?.dir ? Math.atan2(e.dir.x, e.dir.z) : null;
      combat.cast('castGround', P.shieldLock ?? 0.42, { yaw });
    }),
    bus.on('launchpad', (e) => {
      if (player.hp <= 0 || e?.burst || !player.isGrounded) return;
      const moving = Math.hypot(player.velocity.x, player.velocity.z) > 1;
      if (moving) loco.play('castThrow', { partial: true, fade: 0.05, fadeOut: 0.2 });
      else combat.cast('castThrow', P.padLock ?? 0.26);
    }),
  ];

  function setSpawn(p) {
    player._spawn.copy(p);
    player._checkpoint.copy(p);
    object.position.copy(p);
    player.velocity.set(0, 0, 0);
    player._deadT = 0;
    player._vault = null; player._dodge = null; player._roll = null;
    player.isGrounded = true;
    combat.interrupt(0);
    loco.reset();
  }

  function setCheckpoint(p = object.position) {
    player._checkpoint.copy(p);
  }

  function face(yaw, snap = true) {
    player.yaw = yaw;
    dir.set(Math.sin(yaw), 0, Math.cos(yaw));
    loco.setYaw(yaw, snap);
  }

  function jump() { player._jumpBuf = T.jumpBuffer ?? 0.12; player._jumpFull = true; }
  function dodge() { player._dodgeBuf = DG.buffer ?? 0.15; }

  function wishFrom(camYaw) {
    const axis = moveAxis();
    const s = Math.sin(camYaw), c = Math.cos(camYaw);
    _wish.set(s * axis.forward - c * axis.right, 0, c * axis.forward + s * axis.right);
    const moving = _wish.lengthSq() > 1e-6;
    const mag = Math.min(1, _wish.length());
    if (moving) _wish.normalize();
    return { moving, mag };
  }

  function tryVault(camYaw) {
    if (player._vault || !player.isGrounded) return false;
    const { moving } = wishFrom(camYaw);
    const d = moving ? _wish.clone() : new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    if (d.lengthSq() < 1e-6) return false;
    const found = physics.findVault(object.position, d, player.radius, player.height, {
      height: T.vaultHeight, minHeight: T.vaultMinHeight, depth: T.vaultDepth,
    });
    if (!found) return false;
    const from = object.position.clone();
    const mid = from.clone().lerp(found.landing, 0.5);
    mid.y = Math.max(from.y, found.landing.y) + 0.55 + found.height * 0.15;
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    // carry more speed through a vault taken at a run
    const dur = (T.vaultDuration ?? 0.55) * (speed > T.runSpeed * 0.8 ? 0.86 : 1);
    player._vault = { t: 0, dur, from, mid, to: found.landing.clone(), yaw: Math.atan2(d.x, d.z), exit: Math.max(speed, T.runSpeed * 0.7) };
    player.isGrounded = true;
    player.busy = true;
    combat.interrupt(0.05);
    dir.copy(d);
    const clip = loco._resolveClip('vault');
    loco.play('vault', { fade: 0.07, fadeOut: 0.14, timeScale: clip ? clip.clip.duration / dur : 1 });
    player.state = 'vault';
    bus.emit('playerAction', { name: 'vault' });
    return true;
  }

  function startDodge(moving) {
    const onBeat = clock?.isOnBeat?.() ?? false;
    const back = !moving;
    const d = back ? new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)) : _wish.clone();
    const dur = DG.duration ?? 0.4;
    const dist = (DG.distance ?? 4.4) * (back ? (DG.backScale ?? 0.7) : 1);
    player._dodge = { t: 0, dur, dir: d, dist, back };
    player._dodgeBuf = 0;
    player._dodgeCd = dur + (DG.cooldown ?? 0.3);
    player._iframe = Math.max(player._iframe, (DG.iframe ?? 0.3) * (onBeat ? (DG.onBeatIframeMult ?? 1.4) : 1));
    player.busy = true; player.dodging = true;
    combat.interrupt(0.04);
    if (!back) { dir.copy(d); player.yaw = Math.atan2(d.x, d.z); }
    const name = back ? 'dodgeBack' : 'dodge';
    const clip = loco._resolveClip(name);
    loco.play(name, { fade: 0.05, fadeOut: 0.14, timeScale: clip ? clip.clip.duration / dur : 1 });
    bus.emit('playerAction', { name: 'dodge', onBeat, back });
    bus.emit('noise', { pos: object.position.clone(), radius: 4, kind: 'dodge' });
  }

  function die() {
    player._dead = true;
    player._deadT = 0;
    player._vault = null; player._dodge = null; player._roll = null;
    player.busy = false; player.dodging = false;
    combat.interrupt(0.05);
    loco.play('death', { fade: 0.08, hold: true });
    bus.emit('playerAction', { name: 'death' });
    bus.emit('playerDied', { pos: object.position.clone() });
  }

  function respawn() {
    object.position.copy(player._checkpoint);
    player.velocity.set(0, 0, 0);
    player._dead = false;
    player._deadT = 0;
    loco.reset();
    player.heal(player.hpMax);
    player.state = 'idle';
    combat.state = 'idle';
    player._iframe = T.respawnIframe ?? 1.5;
    player.isGrounded = true;
    bus.emit('playerAction', { name: 'respawn' });
    bus.emit('playerRespawned', { pos: object.position.clone() });
  }

  /** Move the capsule by the current velocity; returns the physics result. */
  function integrate(dt, gravity = true) {
    player.velocity.add(player._impulse);
    if (player._impulse.y > 0.5) player.isGrounded = false;
    player._impulse.set(0, 0, 0);
    if (gravity) {
      if (!player.isGrounded) player.velocity.y = Math.max(-(T.terminalSpeed ?? 40), player.velocity.y - T.gravity * dt);
      else if (player.velocity.y < 0) player.velocity.y = 0;
    }
    const disp = _v.copy(player.velocity).multiplyScalar(dt);
    const res = physics.moveCapsule(object.position, disp, player.radius, player.height, {
      solid: true, stepHeight: T.stepHeight, maxSlopeDeg: T.maxSlopeDeg,
    });
    object.position.copy(res.position);
    return res;
  }

  function nearestThreat(range) {
    let best = null, bd = range;
    for (const e of getEnemies()) {
      if (!e || e.hp <= 0 || e.dead) continue;
      const d = Math.hypot(e.position.x - object.position.x, e.position.z - object.position.z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function animate(dt, usePhysics = true) {
    loco.update(dt, { physics: usePhysics ? physics : null, ikTuning: animTuning.ik });
    combat.update(dt, player);
    fx.update(combat, player);
  }

  function update(dt, camYaw, camPitch = 0) {
    if (player._iframe > 0) player._iframe = Math.max(0, player._iframe - dt);
    if (player._dodgeCd > 0) player._dodgeCd -= dt;
    if (player._landLock > 0) player._landLock -= dt;
    if (player._dashT > 0) {
      player._dashT -= dt;
      if (player._dashT <= 0) loco.current('dash')?.leave(0.16);
    }

    // ---- death / respawn ----
    if (player.hp <= 0) {
      if (!player._dead) die();
      player.state = 'dead';
      player._deadT += dt;
      player.velocity.x *= Math.max(0, 1 - 8 * dt); player.velocity.z *= Math.max(0, 1 - 8 * dt);
      const res = integrate(dt);
      player.isGrounded = res.grounded;
      loco.setMove(0);
      loco.setVertical(0, true);
      loco.setLook(0, 0, 0);
      animate(dt, false);
      if (player._deadT >= (T.respawnDelay ?? 2.4)) respawn();
      return;
    }
    player._dead = false;

    // fell off the world
    if (object.position.y < (tuning.levels?.voidY ?? -24)) {
      object.position.copy(player._checkpoint);
      player.velocity.set(0, 0, 0);
      player.takeDamage(T.voidDamage ?? 15, 'void');
      player._iframe = 1;
      loco.reset();
      bus.emit('playerRespawned', { pos: object.position.clone(), fall: true });
    }

    if (player._jumpBuf > 0) player._jumpBuf -= dt;
    if (player._dodgeBuf > 0) player._dodgeBuf -= dt;
    if (player.isGrounded) player._coyote = T.coyoteTime ?? 0.12;
    else player._coyote = Math.max(0, player._coyote - dt);

    const { moving, mag } = wishFrom(camYaw);
    if (wantsJump()) player._jumpBuf = T.jumpBuffer ?? 0.12;
    if (wantsDodge()) player._dodgeBuf = DG.buffer ?? 0.15;
    if (wantsMelee()) combat.requestMelee(moving ? _wish : null);
    if (wantsBlast()) combat.requestBlast(moving ? _wish : null);

    // ---- vault (scripted arc) ----
    if (player._vault) {
      const v = player._vault;
      v.t += dt;
      const u = Math.min(1, v.t / v.dur);
      const omu = 1 - u;
      object.position.set(
        omu * omu * v.from.x + 2 * omu * u * v.mid.x + u * u * v.to.x,
        omu * omu * v.from.y + 2 * omu * u * v.mid.y + u * u * v.to.y,
        omu * omu * v.from.z + 2 * omu * u * v.mid.z + u * u * v.to.z,
      );
      player.velocity.set(0, 0, 0);
      player.yaw = v.yaw;
      player.state = 'vault';
      loco.ikWeight = 0;
      loco.setMove(0, v.yaw);
      loco.setVertical(0, true);
      loco.setLook(v.yaw, 0, 0);
      animate(dt, false);
      if (u >= 1) {
        object.position.copy(v.to);
        player._vault = null;
        player.busy = false;
        player.isGrounded = true;
        loco.ikWeight = 1;
        // land running: keep the momentum the approach had
        const keep = moving ? v.exit : 0;
        player.velocity.set(Math.sin(v.yaw) * keep, 0, Math.cos(v.yaw) * keep);
        loco._spd.p = keep; loco.speed = keep;
        setCheckpoint(v.to);
        bus.emit('noise', { pos: object.position.clone(), radius: 4, kind: 'land', strength: 0.3 });
      }
      return;
    }

    // ---- start a dodge ----
    if (player._dodgeBuf > 0 && player._dodgeCd <= 0 && player.isGrounded && !player._dodge && !player._roll && combat.canCancel) {
      startDodge(moving);
    }

    // ---- jump / vault ----
    if (player._jumpBuf > 0 && !player._dodge && !player._roll && combat.canCancel && player._landLock <= 0) {
      if (player.isGrounded && tryVault(camYaw)) {
        player._jumpBuf = 0;
        animate(dt, false);
        return;
      } else if (player.isGrounded || player._coyote > 0) {
        combat.interrupt(0.06);
        player.velocity.y = T.jumpSpeed;
        player.isGrounded = false;
        player._coyote = 0;
        player._jumpBuf = 0;
        player._jumping = true;
        player.state = 'jump';
        loco.beginJump();
        loco.play('jump', { fade: 0.05, fadeOut: 0.22 });
        bus.emit('playerAction', { name: 'jump' });
      }
    }
    // variable height: letting go early cuts the rise
    if (player._jumping && !player._jumpFull && !player.isGrounded && player.velocity.y > 0 && !jumpHeld()) {
      player.velocity.y *= T.jumpCutMult ?? 0.5;
      player._jumping = false;
    }
    if (player.velocity.y <= 0) player._jumping = false;

    const hx = player.velocity.x, hz0 = player.velocity.z;
    let cur = Math.hypot(hx, hz0);
    if (cur > 0.3 && player.isGrounded) dir.set(hx / cur, 0, hz0 / cur);
    let faceYaw = null;
    let sprinting = false;
    let carry = false; // leaving a burst: the legs pick up at the speed the body already has

    if (player._dodge) {
      // ---- dodge: fast burst that bleeds down to run speed ----
      const d = player._dodge;
      d.t += dt;
      const u = Math.min(1, d.t / d.dur);
      const sp = (d.dist / d.dur) * (1.5 - u);
      player.velocity.x = d.dir.x * sp; player.velocity.z = d.dir.z * sp;
      if (!d.back) faceYaw = Math.atan2(d.dir.x, d.dir.z);
      if (u >= 1) {
        player._dodge = null; player.busy = false; player.dodging = false;
        if (!moving) { player.velocity.x *= 0.3; player.velocity.z *= 0.3; }
        carry = true;
      }
    } else if (player._roll) {
      // ---- landing roll ----
      const r = player._roll;
      r.t += dt;
      const u = Math.min(1, r.t / r.dur);
      const sp = r.speed * (1 - 0.35 * u);
      player.velocity.x = r.dir.x * sp; player.velocity.z = r.dir.z * sp;
      faceYaw = Math.atan2(r.dir.x, r.dir.z);
      if (u >= 1) { player._roll = null; player.busy = false; carry = true; }
    } else if (combat.locked) {
      // ---- attacks, casts, staggers: combat drives the feet ----
      if (combat.lungeT > 0) { player.velocity.x = combat.lunge.x; player.velocity.z = combat.lunge.z; }
      else {
        const k = Math.max(0, 1 - (T.attackFriction ?? 14) * dt);
        player.velocity.x *= k; player.velocity.z *= k;
      }
      faceYaw = combat.faceYaw;
    } else if (player.isGrounded) {
      // ---- ground locomotion ----
      let target = 0;
      if (moving && player._landLock <= 0) {
        sprinting = wantsSprint();
        if (sprinting) target = T.sprintSpeed;
        else if (wantsWalk()) target = T.walkSpeed;
        else target = T.runSpeed * (mag < 0.6 ? 0.56 : 1);
      }
      if (moving) {
        const ang = Math.acos(clamp(dir.x * _wish.x + dir.z * _wish.z, -1, 1));
        if (cur > (T.skidSpeed ?? 4) && ang > (T.skidAngleDeg ?? 130) * D2R) player._skid = T.skidTime ?? 0.16;
        if (player._skid > 0 && cur > 1.2) {
          // plant and brake before going the other way
          player._skid -= dt;
          cur = Math.max(0, cur - (T.skidDecel ?? 34) * dt);
          if (cur <= 1.2) player._skid = 0;
        } else {
          player._skid = 0;
          // turn the travel direction toward the stick; slower at speed
          const tr = THREE.MathUtils.lerp(T.turnRateDeg ?? 900, T.sprintTurnRateDeg ?? 420, clamp((cur - T.runSpeed * 0.6) / Math.max(0.1, T.sprintSpeed - T.runSpeed * 0.6), 0, 1)) * D2R;
          if (cur < 0.6 || ang < 1e-3) dir.copy(_wish);
          else {
            const cross = dir.x * _wish.z - dir.z * _wish.x;
            const step = Math.min(ang, tr * dt) * (cross >= 0 ? -1 : 1);
            dir.applyAxisAngle(THREE.Object3D.DEFAULT_UP, step);
          }
          const acc = target > cur ? T.accel : T.decel;
          cur = target > cur ? Math.min(target, cur + acc * dt) : Math.max(target, cur - acc * dt);
        }
      } else {
        player._skid = 0;
        cur = Math.max(0, cur - T.decel * dt);
      }
      player.velocity.x = dir.x * cur; player.velocity.z = dir.z * cur;
      if (cur > 0.25) faceYaw = Math.atan2(dir.x, dir.z);
      else if (moving) faceYaw = Math.atan2(_wish.x, _wish.z);
    } else {
      // ---- air control ----
      if (moving) {
        const want = Math.max(cur, T.runSpeed * (T.airControl ?? 0.45));
        const k = 1 - Math.exp(-(T.airAccel ?? 5) * dt);
        player.velocity.x += (_wish.x * want - player.velocity.x) * k;
        player.velocity.z += (_wish.z * want - player.velocity.z) * k;
        faceYaw = Math.atan2(_wish.x, _wish.z);
      }
    }

    const wasGrounded = player.isGrounded;
    const vyBefore = player.velocity.y;
    const px = object.position.x, pz = object.position.z;
    const res = integrate(dt);
    // what the body actually covered (walls and corners eat speed); the legs follow this, not the stick
    const moved = dt > 1e-5 ? Math.hypot(object.position.x - px, object.position.z - pz) / dt : 0;
    player.isGrounded = res.grounded;

    if (res.grounded) {
      if (!wasGrounded) {
        const impact = Math.max(0, -vyBefore);
        const hs = Math.hypot(player.velocity.x, player.velocity.z);
        const strength = clamp((impact - 3) / 14, 0, 1);
        loco.land(impact);
        player._landT = 0.22;
        player._jumping = false;
        player._jumpFull = false;
        if (impact >= (T.hardLandSpeed ?? 12.5)) {
          if (hs > (T.rollMinSpeed ?? 2.2) && moving) {
            const rd = new THREE.Vector3(player.velocity.x, 0, player.velocity.z).normalize();
            const clip = loco._resolveClip('landRoll');
            const dur = T.rollDuration ?? 0.62;
            player._roll = { t: 0, dur, dir: rd, speed: Math.max(hs, T.rollSpeed ?? 5.2) };
            player.busy = true;
            player._iframe = Math.max(player._iframe, 0.2);
            loco.play('landRoll', { fade: 0.04, fadeOut: 0.14, timeScale: clip ? clip.clip.duration / dur : 1 });
          } else {
            player._landLock = T.hardLandLock ?? 0.32;
            player.velocity.x *= 0.2; player.velocity.z *= 0.2;
            loco.play('land', { fade: 0.03, fadeOut: 0.16, timeScale: 0.8 });
          }
        } else if (impact >= (T.softLandSpeed ?? 4)) {
          // soft landing: absorb with the upper body only when running through it
          loco.play('land', { fade: 0.04, fadeOut: 0.16, timeScale: 1.25, partial: hs > 2.5 });
        } else {
          loco.stop(0.1);
        }
        bus.emit('playerAction', { name: 'land', strength, roll: !!player._roll });
        bus.emit('noise', { pos: object.position.clone(), radius: 4 + strength * 5, kind: 'land', strength });
        if (strength > 0.25) bus.emit('impact', { pos: object.position.clone(), strength: strength * 0.6, kind: 'land', onBeat: false });
      }
      if (player.velocity.y < 0) player.velocity.y = 0;
      loco.ikWeight = 1;
      // safe ground becomes the checkpoint
      player._cpT += dt;
      if (player._cpT > 1.5 && !combat.locked && !nearestThreat(T.checkpointClear ?? 12)) { player._cpT = 0; setCheckpoint(); }
    } else {
      loco.ikWeight = 0;
      player._cpT = 0;
    }
    if (res.blocked && (player._dodge || player._roll)) {
      // hit a wall mid-burst: stop pushing into it
      if (player._dodge) player._dodge.dist *= 0.5;
    }

    // ---- out-of-combat recovery: the mix cleans itself up when nothing has hit Kael for a while ----
    if (player.hp < player.hpMax) {
      player._sinceHurt += dt;
      if (player._sinceHurt > (T.regenDelay ?? 5)) {
        player.hp = Math.min(player.hpMax, player.hp + (T.regenRate ?? 9) * dt);
        player._regenT -= dt;
        if (player._regenT <= 0 || player.hp >= player.hpMax) {
          player._regenT = 0.4;
          bus.emit('playerHealed', { amount: 0, hp: player.hp, hpMax: player.hpMax, regen: true });
        }
      }
    }

    // ---- facing, look-at, stance ----
    if (faceYaw !== null && faceYaw !== undefined) player.yaw = faceYaw;
    const spd = Math.hypot(player.velocity.x, player.velocity.z);
    const animSpd = player._dodge || player._roll || combat.locked ? 0 : (player.isGrounded ? Math.min(spd, moved * 1.1 + 0.4) : Math.max(spd, 0.5));
    loco.setMove(animSpd, player.yaw);
    if (carry) { loco._spd.p = spd; loco._spd.v = 0; loco.speed = spd; }
    loco.setVertical(player.velocity.y, player.isGrounded);
    loco.setSprint(sprinting && spd > T.runSpeed + 0.4 ? 1 : 0);
    const threat = nearestThreat(T.threatRange ?? 11);
    loco.setCombatIdle(threat ? 1 : 0);
    if (threat) {
      const ty = Math.atan2(threat.position.x - object.position.x, threat.position.z - object.position.z);
      loco.setLook(ty, 0, 1);
    } else {
      loco.setLook(camYaw, clamp((camPitch - 0.25) * 0.6, -0.4, 0.4), spd < T.sprintSpeed - 1 ? 0.85 : 0.4);
    }
    animate(dt, true);

    // state label (HUD, sfx, tests)
    if (player._dodge) player.state = 'dodge';
    else if (player._roll) player.state = 'roll';
    else if (combat.locked) player.state = combat.state;
    else if (!player.isGrounded) player.state = player.velocity.y > 0.4 ? 'jump' : 'fall';
    else if (player._landT > 0) { player._landT -= dt; player.state = 'land'; }
    else if (player._skid > 0) player.state = 'skid';
    else player.state = loco.gaitName();
  }

  function dispose() { offs.forEach((off) => off?.()); }

  return { player, update, setSpawn, setCheckpoint, face, jump, dodge, tryVault, loco, combat, fx, dispose };
}
