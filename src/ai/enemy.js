// Base class for every enemy. Implements the Enemy API from docs/TASKS.md:
//   id, position, hp, state, duck(sec), takeDamage(n, src)
// plus: kind, dead, yaw, view (Object3D), animState (for Aether's animation layer).
//
// Bus events emitted here (see docs/TASKS.md contracts):
//   enemyDucked  {id, until}
//   enemyHit     {id, kind, amount, hp, hpMax, pos, src}
//   enemyKilled  {id, kind, pos}
import * as THREE from 'three';
import { newId } from './util.js';

export class Enemy {
  constructor({ kind, bus, cfg, view, position }) {
    this.id = newId(kind);
    this.kind = kind;
    this.isEnemy = true;
    this.bus = bus;
    this.cfg = cfg;
    this.hpMax = cfg.hp;
    this.hp = cfg.hp;
    this.state = 'idle';
    this.animState = 'idle';
    this.dead = false;
    this.position = new THREE.Vector3().copy(position ?? new THREE.Vector3());
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.view = view ?? null; // Object3D the renderer shows; AI writes its transform
    if (this.view) this.view.userData.enemy = this; // lets raycasts map a hit mesh back to its enemy
    this.knockback = new THREE.Vector3(); // from Sub-Bass Blast (combat.js calls applyImpulse)
    this.target = null; // the player, set every update; used when damage arrives without a position
    this.duckedUntil = -Infinity;
    this.now = 0;
  }

  /** Same field name as the greybox dummy so level code can treat all enemies alike. */
  get object() {
    return this.view;
  }

  /** Knockback (combat.js Sub-Bass Blast). Horizontal part slides the enemy; subclasses consume it. */
  applyImpulse(v) {
    if (this.dead) return;
    this.knockback.add(v);
  }

  /** Where the damage came from: a src with a position, or the player for player-sourced hits ({source:'player'}). */
  sourcePosition(src) {
    if (src?.position) return src.position;
    if (src === 'player' || src?.source === 'player' || src?.id === 'player') return this.target?.position ?? null;
    return null;
  }

  get ducked() {
    return this.now < this.duckedUntil;
  }

  /** Sidechain duck: the enemy is stunned / ear-ringing for `sec` seconds (punish window). */
  duck(sec = this.cfg.duckDefault) {
    if (this.dead) return;
    this.duckedUntil = Math.max(this.duckedUntil, this.now + sec);
    this.bus.emit('enemyDucked', { id: this.id, until: this.duckedUntil });
    this.onDucked?.(sec);
  }

  takeDamage(n, src) {
    if (this.dead || !(n > 0)) return;
    this.hp = Math.max(0, this.hp - n);
    this.bus.emit('enemyHit', { id: this.id, kind: this.kind, amount: n, hp: this.hp, hpMax: this.hpMax, pos: this.position.clone(), src });
    if (this.hp <= 0) {
      this.dead = true;
      this.state = 'dead';
      this.animState = 'dead';
      this.onDeath?.(src);
      this.bus.emit('enemyKilled', { id: this.id, kind: this.kind, pos: this.position.clone() });
    } else {
      this.onHurt?.(n, src);
    }
  }

  syncView() {
    if (!this.view) return;
    this.view.position.copy(this.position);
    this.view.rotation.y = this.yaw;
  }

  dispose() {}
}
