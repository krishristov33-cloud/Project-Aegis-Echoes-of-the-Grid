import * as THREE from 'three';
import { Locomotion } from './locomotion.js';
import { Combat, createCombatFx } from './combat.js';
import { moveAxis, wantsSprint, wantsWalk, wantsJump, wantsMelee, wantsBlast } from '../core/input.js';
import { animTuning } from './animTuning.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Player pawn. Exposes the game.player contract:
 *   position, velocity, isGrounded, hp, state, applyImpulse(v), takeDamage(n, src)
 */
export function createPlayer(ctx) {
  const { scene, physics, bus, clock, tuning, loaded, getEnemies } = ctx;
  const T = tuning.player;

  const object = new THREE.Group();
  object.name = 'player';
  object.add(loaded.root);
  scene.add(object);

  const loco = new Locomotion(loaded, object, {
    tuning,
    onFootstep: (side) => {
      bus.emit('noise', { pos: object.position.clone(), radius: 3.5, kind: 'footstep', side });
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
    _impulse: new THREE.Vector3(),
    _coyote: 0,
    _jumpBuf: 0,
    _vault: null,
    _landT: 0,
    _spawn: new THREE.Vector3(),
    _checkpoint: new THREE.Vector3(),
    _deadT: 0,
    _iframe: 0,
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

  function setSpawn(p) {
    player._spawn.copy(p);
    player._checkpoint.copy(p);
    object.position.copy(p);
    player.velocity.set(0, 0, 0);
    player._deadT = 0;
  }

  function setCheckpoint(p = object.position) {
    player._checkpoint.copy(p);
  }

  function face(yaw, snap = true) {
    player.yaw = yaw;
    loco.setYaw(yaw, snap);
  }

  function jump() { player._jumpBuf = T.jumpBuffer ?? 0.12; }

  function tryVault(camYaw) {
    if (player._vault || !player.isGrounded) return false;
    const axis = moveAxis();
    let dir;
    if (axis.moving) {
      const fw = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
      const rt = new THREE.Vector3(-Math.cos(camYaw), 0, Math.sin(camYaw));
      dir = fw.multiplyScalar(axis.forward).add(rt.multiplyScalar(axis.right));
    } else {
      dir = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    }
    if (dir.lengthSq() < 1e-6) return false;
    dir.normalize();
    const found = physics.findVault(object.position, dir, player.radius, player.height, {
      height: T.vaultHeight, minHeight: T.vaultMinHeight, depth: T.vaultDepth,
    });
    if (!found) return false;
    const from = object.position.clone();
    const mid = from.clone().lerp(found.landing, 0.5);
    mid.y = Math.max(from.y, found.landing.y) + 0.55 + found.height * 0.15;
    player._vault = { t: 0, dur: T.vaultDuration ?? 0.55, from, mid, to: found.landing.clone(), yaw: Math.atan2(dir.x, dir.z) };
    player.isGrounded = true;
    loco.ikWeight = 0;
    loco.setMove(0, player._vault.yaw);
    loco.play('vault', { fade: 0.08, fadeOut: 0.12, timeScale: 1.1 });
    player.state = 'vault';
    return true;
  }

  function update(dt, camYaw) {
    if (player._iframe > 0) player._iframe = Math.max(0, player._iframe - dt);

    if (player.hp <= 0) {
      player.state = 'dead';
      player._vault = null;
      loco.setMove(0);
      loco.setVertical(0, player.isGrounded);
      loco.update(dt, { physics, ikTuning: animTuning.ik });
      player._deadT += dt;
      if (player._deadT >= 2) {
        object.position.copy(player._checkpoint);
        player.velocity.set(0, 0, 0);
        player.heal(player.hpMax);
        player.state = 'idle';
        if (player.combat) player.combat.state = 'idle';
        player._deadT = 0;
        player._iframe = 1.25;
        player.isGrounded = true;
      }
      return;
    }
    player._deadT = 0;

    // respawn if we fell off the world
    if (object.position.y < (tuning.levels?.voidY ?? -24)) {
      object.position.copy(player._checkpoint);
      player.velocity.set(0, 0, 0);
    }

    if (player._jumpBuf > 0) player._jumpBuf -= dt;
    if (player.isGrounded) player._coyote = T.coyoteTime ?? 0.12;
    else player._coyote = Math.max(0, player._coyote - dt);

    if (wantsMelee()) combat.requestMelee();
    if (wantsBlast()) combat.requestBlast();

    // Vault / jump. Prefer vault when a waist-high ledge is in front.
    const jumpPressed = wantsJump() || player._jumpBuf > 0;
    if (jumpPressed && !player._vault && !combat.locked) {
      if (player.isGrounded && tryVault(camYaw)) {
        player._jumpBuf = 0;
      } else if ((player.isGrounded || player._coyote > 0) && !player._vault) {
        player.velocity.y = T.jumpSpeed;
        player.isGrounded = false;
        player._coyote = 0;
        player._jumpBuf = 0;
        player.state = 'jump';
        loco.ikWeight = 0;
        loco.beginJump();
        loco.play('jump', { fade: 0.06, fadeOut: 0.1 });
      }
    }

    if (player._vault) {
      const v = player._vault;
      v.t += dt;
      const u = Math.min(1, v.t / v.dur);
      const omu = 1 - u;
      // quadratic bezier arc
      const x = omu * omu * v.from.x + 2 * omu * u * v.mid.x + u * u * v.to.x;
      const y = omu * omu * v.from.y + 2 * omu * u * v.mid.y + u * u * v.to.y;
      const z = omu * omu * v.from.z + 2 * omu * u * v.mid.z + u * u * v.to.z;
      object.position.set(x, y, z);
      player.velocity.set(0, 0, 0);
      loco.setMove(0, v.yaw);
      player.yaw = v.yaw;
      player.state = 'vault';
      loco.setVertical(0, true);
      loco.update(dt, { physics: null, ikTuning: animTuning.ik });
      combat.update(dt, player);
      fx.update(combat, player);
      if (u >= 1) {
        object.position.copy(v.to);
        player._vault = null;
        player.isGrounded = true;
        loco.ikWeight = 1;
        player._landT = 0.15;
        setCheckpoint(v.to);
      }
      return;
    }

    const axis = moveAxis();
    const fw = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    const rt = new THREE.Vector3(-Math.cos(camYaw), 0, Math.sin(camYaw));
    const wish = fw.multiplyScalar(axis.forward).add(rt.multiplyScalar(axis.right));
    const moving = wish.lengthSq() > 1e-6;
    if (moving) wish.normalize();

    let target = 0;
    if (moving && !combat.locked) {
      if (wantsSprint()) target = T.sprintSpeed;
      else if (wantsWalk()) target = T.walkSpeed;
      else target = T.runSpeed;
    }
    const hz = new THREE.Vector3(player.velocity.x, 0, player.velocity.z);
    const cur = hz.length();
    const acc = player.isGrounded ? (target > cur ? T.accel : T.decel) : T.airAccel;
    let next = cur;
    if (player.isGrounded) {
      if (target > cur) next = Math.min(target, cur + acc * dt);
      else next = Math.max(target, cur - acc * dt);
    } else {
      // air: nudge toward wish * airControl
      if (moving) {
        const airT = target * (T.airControl ?? 0.45);
        next = cur + Math.sign(airT - cur) * Math.min(Math.abs(airT - cur), T.airAccel * dt);
      }
    }
    if (combat.locked && player.isGrounded) next *= 0.15;

    if (moving) {
      const intended = wish.multiplyScalar(Math.max(next, 0));
      if (player.isGrounded) {
        hz.copy(intended);
      } else {
        hz.lerp(intended, 1 - Math.exp(-(T.airAccel ?? 5) * dt));
      }
      player.yaw = Math.atan2(wish.x || hz.x, wish.z || hz.z);
      // wish was mutated; recompute yaw from velocity if needed
      if (hz.lengthSq() > 1e-6) player.yaw = Math.atan2(hz.x, hz.z);
    } else if (player.isGrounded) {
      hz.set(0, 0, 0);
    }
    player.velocity.x = hz.x;
    player.velocity.z = hz.z;

    // gravity + impulses
    player.velocity.add(player._impulse);
    player._impulse.set(0, 0, 0);
    if (!player.isGrounded) player.velocity.y -= T.gravity * dt;
    else if (player.velocity.y < 0) player.velocity.y = 0;

    const disp = player.velocity.clone().multiplyScalar(dt);
    const res = physics.moveCapsule(object.position, disp, player.radius, player.height, {
      solid: true,
      stepHeight: T.stepHeight,
      maxSlopeDeg: T.maxSlopeDeg,
    });
    object.position.copy(res.position);

    const wasGrounded = player.isGrounded;
    player.isGrounded = res.grounded;
    if (res.grounded) {
      if (!wasGrounded && player.state !== 'vault') {
        const impact = Math.max(0, -player.velocity.y);
        player._landT = 0.22;
        loco.land(impact);
        loco.play('land', { fade: 0.05, fadeOut: 0.15 });
        bus.emit('noise', { pos: object.position.clone(), radius: 5, kind: 'land' });
      }
      if (player.velocity.y < 0) player.velocity.y = 0;
      loco.ikWeight = 1;
    } else {
      loco.ikWeight = 0.15;
    }

    const spd = Math.hypot(player.velocity.x, player.velocity.z);
    loco.setMove(player.isGrounded ? spd : Math.max(spd, 0.5), player.yaw);
    loco.setVertical(player.velocity.y, player.isGrounded);
    loco.update(dt, { physics, ikTuning: animTuning.ik });
    combat.update(dt, player);
    fx.update(combat, player);

    // state label for HUD
    if (combat.locked) player.state = combat.state;
    else if (player._vault) player.state = 'vault';
    else if (!player.isGrounded) player.state = player.velocity.y > 0.4 ? 'jump' : 'fall';
    else if (player._landT > 0) { player._landT -= dt; player.state = 'land'; }
    else player.state = loco.gaitName();
  }

  return { player, update, setSpawn, setCheckpoint, face, jump, tryVault, loco, combat, fx };
}
