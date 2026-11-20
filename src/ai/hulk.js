// C2: the Dissonant Hulk. A boss that fights on the beat.
//
// Every attack is chosen on a beat, telegraphed for `windupBeats`, and lands exactly on a later beat, so the player
// learns the rhythm. Phases by health:
//   1 (100-66%)  chase, STOMP (shockwave; jump to dodge), THROW (rips a floor tile and hurls it at the player)
//   2 (66-33%)   + stomps crack nearby floor tiles; cracked tiles turn to dissonant VOID that hurts to stand on
//   3 (<33%)     + GRAVITY WELL (pulls Kael and debris toward the Hulk, hurts in the core), faster
// Armor: hits do `armor` x damage. Weak points (3 glowing nodes) OPEN only when the Hulk is ducked ON THE BEAT
// (an on-beat melee hit or a Sub-Bass blast on the beat); while open, hits do `weakMult` x damage.
// Between phases it roars (invulnerable for `roarBeats`).
//
// Enemy API: id, position, hp, state, duck(sec), takeDamage(n, src) (+ kind 'hulk', phase, weakOpen).
// Emits: bossPhase {id, phase}, bossTelegraph {id, kind, pos, radius, beats}, bossAttack {id, kind, pos},
//        bossDefeated {id, pos}, plus the C1 enemy events (enemyHit with {weak}, enemyKilled, enemyDucked).
import * as THREE from 'three';
import { Enemy } from './enemy.js';
import { yawTo, angleDelta, flatDist } from './util.js';

export const HULK_DEFAULTS = {
  hp: 1200,
  radius: 0.9,
  height: 3.2,
  speed: [1.8, 2.4, 3.1],
  turnRate: 2.2,
  keepDistance: 2.6,
  aggroRange: 30,
  attackEvery: [4, 3, 2], // beats between attacks, per phase
  windupBeats: 2,
  phaseAt: [0.66, 0.33],
  roarBeats: 4,
  armor: 0.1,
  weakMult: 2,
  weakOpenTime: 1.8,
  offBeatDuck: 0.3,
  stomp: { range: 5, damage: 22, knockUp: 6, crackRadius: 6 },
  throw: { damage: 20, radius: 1.8, flightBeats: 2, minRange: 6, chunk: 1.1 },
  well: { radius: 13, pull: 5.5, coreRadius: 2.6, coreDamage: 8, beats: 8, cooldownBeats: 16 },
  void: { damage: 5, crackBeats: 2 },
  debrisLife: 8,
  deathTime: 2.6, // seconds of death sequence before bossDefeated
  // clip fractions where the blow lands / the chunk leaves the hand (clips are time-fitted to the beat wind-up)
  anim: { slamAt: 0.6, throwAt: 0.55, staggerTime: 0.8 },
};

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...a[k], ...v } : v;
  return out;
};

const DOWN = new THREE.Vector3(0, -1, 0);

export class Hulk extends Enemy {
  /**
   * @param {object} o
   * @param {object} o.bus, o.physics, o.scene
   * @param {object} [o.cfg]      enemies.json "hulk" (merged over HULK_DEFAULTS)
   * @param {object} [o.clock]    Tempo Sync clock (isOnBeat, getBpm); falls back to game.clock
   * @param {THREE.Object3D[]} [o.tiles]  destructible floor tiles (arena meshes with userData.destructible)
   */
  constructor(o) {
    const cfg = merge(HULK_DEFAULTS, o.cfg);
    super({ kind: 'hulk', bus: o.bus, cfg, view: o.view, position: o.position });
    this.physics = o.physics;
    this.scene = o.scene;
    this.clock = o.clock ?? globalThis.game?.clock ?? null;
    this.yaw = o.yaw ?? 0;
    this.phase = 1;
    this.state = 'idle'; // idle | chase | windup | roar | stagger | dead
    this.attack = null; // { kind, beatsLeft, target }
    this.beatsSinceAttack = 0;
    this.wellCooldown = 0;
    this.well = null; // { center, beatsLeft }
    this.weakOpenUntil = -Infinity;
    this.roarBeats = 0;
    this.projectiles = [];
    this.debris = [];
    this.fx = new THREE.Group();
    this.scene.add(this.fx);
    this.tiles = (o.tiles ?? []).map((mesh) => ({ mesh, state: 'intact', crackBeats: 0, baseMat: mesh.material }));
    this._voidMat = new THREE.MeshStandardMaterial({ color: 0x07020a, emissive: 0xff2266, emissiveIntensity: 0.18, roughness: 0.2 });
    this._crackMat = new THREE.MeshStandardMaterial({ color: 0x2a1018, emissive: 0xff3d8a, emissiveIntensity: 0.07, roughness: 0.4 });
    this._buildWeakPoints();
    this._offs = [o.bus.on('beat', (b) => this._onBeat(b))];
    this.target = null;
    // animation cues for the view layer (encounters.js): { name, seq, duration, hold }
    this.cue = { name: null, seq: 0 };
    this.hitSeq = 0;
    this.lastHit = null;
    this._deathT = 0;
    this._defeatSent = false;
    this._weakStaggered = false;
  }

  /** Ask the view layer for a one-shot clip fitted into `duration` seconds. */
  _cue(name, duration, hold = false) {
    this.cue = { name, seq: this.cue.seq + 1, duration, hold };
  }

  get weakOpen() {
    return this.now < this.weakOpenUntil && !this.dead;
  }

  _onBeatNow() {
    return !!this.clock?.isOnBeat?.();
  }

  _beatDur() {
    return 60 / (this.clock?.getBpm?.() || 174);
  }

  // ---------- visuals ----------
  _buildWeakPoints() {
    this.weakPoints = [];
    if (!this.view) return;
    const h = this.cfg.height;
    for (const [x, y, z] of [[0.75, h * 0.8, -0.1], [-0.75, h * 0.8, -0.1], [0, h * 0.6, -0.65]]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshBasicMaterial({ color: 0x551122, toneMapped: false }));
      m.position.set(x, y, z);
      this.view.add(m);
      this.weakPoints.push(m);
    }
  }

  _ring(pos, radius, color, life) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.05, radius - 0.18), radius, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.copy(pos).setY(pos.y + 0.06);
    m.userData = { t: 0, life };
    this.fx.add(m);
    return m;
  }

  // ---------- floor ----------
  _tileAt(p) {
    for (const t of this.tiles) {
      const b = t.mesh.geometry.parameters;
      if (Math.abs(p.x - t.mesh.position.x) <= b.width / 2 && Math.abs(p.z - t.mesh.position.z) <= b.depth / 2) return t;
    }
    return null;
  }

  _crackAround(center, radius) {
    for (const t of this.tiles) {
      if (t.state !== 'intact') continue;
      if (flatDist(t.mesh.position, center) <= radius) {
        t.state = 'cracked';
        t.crackBeats = this.cfg.void.crackBeats;
        t.mesh.material = this._crackMat;
      }
    }
  }

  _voidTile(t) {
    t.state = 'void';
    t.mesh.material = this._voidMat;
  }

  // ---------- beat logic ----------
  _onBeat() {
    if (this.dead) return;
    const c = this.cfg;
    // floor: cracks become void; void hurts whoever stands on it
    for (const t of this.tiles) if (t.state === 'cracked' && --t.crackBeats <= 0) this._voidTile(t);
    const pl = this.target;
    if (pl && pl.hp > 0 && pl.isGrounded !== false) {
      const t = this._tileAt(pl.position);
      if (t?.state === 'void') pl.takeDamage?.(c.void.damage, this);
    }
    // gravity well
    if (this.well) {
      if (pl && flatDist(pl.position, this.well.center) < c.well.coreRadius) pl.takeDamage?.(c.well.coreDamage, this);
      if (--this.well.beatsLeft <= 0) this._endWell();
    }
    this.wellCooldown = Math.max(0, this.wellCooldown - 1);

    if (this.state === 'roar') {
      if (--this.roarBeats <= 0) this.state = 'chase';
      return;
    }
    if (this.state === 'idle' || this.ducked) return;

    if (this.attack) {
      if (--this.attack.beatsLeft <= 0) this._execute(this.attack);
      return;
    }
    this.beatsSinceAttack++;
    if (this.beatsSinceAttack >= c.attackEvery[this.phase - 1]) this._chooseAttack();
  }

  _chooseAttack() {
    const c = this.cfg;
    const pl = this.target;
    if (!pl) return;
    const d = flatDist(this.position, pl.position);
    let kind;
    if (this.phase >= 3 && this.wellCooldown <= 0 && !this.well) kind = 'well';
    else if (d <= c.stomp.range + 0.5) kind = 'stomp';
    else if (d >= c.throw.minRange && this._throwableTile()) kind = 'throw';
    else kind = 'stomp';
    const target = kind === 'stomp' || kind === 'well' ? this.position.clone() : pl.position.clone();
    const radius = kind === 'stomp' ? c.stomp.range : kind === 'well' ? c.well.radius : c.throw.radius;
    this.attack = { kind, beatsLeft: c.windupBeats, target, telegraph: this._ring(target, radius, kind === 'well' ? 0x9c4dff : 0xff3d8a, c.windupBeats * this._beatDur()) };
    this.state = 'windup';
    const wind = c.windupBeats * this._beatDur();
    // fit the clip so the blow / release lands exactly on the execute beat
    if (kind === 'stomp') this._cue('hulkSlam', wind / c.anim.slamAt);
    else if (kind === 'throw') this._cue('hulkThrow', wind / c.anim.throwAt);
    else this._cue('hulkRoar', wind * 1.25);
    this.bus.emit('bossTelegraph', { id: this.id, kind, pos: target.clone(), radius, beats: c.windupBeats });
    this.bus.emit('enemyTelegraph', { id: this.id, kind: kind === 'stomp' ? 'slam' : kind, pos: target.clone(), time: wind, radius });
  }

  _throwableTile() {
    return this.tiles.some((t) => t.state === 'intact' && flatDist(t.mesh.position, this.position) < 7);
  }

  _execute(a) {
    const c = this.cfg;
    const pl = this.target;
    this.attack = null;
    this.beatsSinceAttack = 0;
    this.state = 'chase';
    a.telegraph?.removeFromParent();
    this.bus.emit('bossAttack', { id: this.id, kind: a.kind, pos: a.target.clone() });
    if (a.kind === 'stomp') {
      this._ring(this.position, c.stomp.range, 0xffffff, 0.35);
      this.bus.emit('noise', { pos: this.position.clone(), radius: 25, kind: 'stomp' });
      if (pl && pl.hp > 0 && pl.isGrounded !== false && flatDist(pl.position, this.position) <= c.stomp.range) {
        // a dodge (i-frames) takes no damage and is not thrown
        if (pl.takeDamage?.(c.stomp.damage, this)) pl.applyImpulse?.(new THREE.Vector3(0, c.stomp.knockUp, 0));
      }
      if (this.phase >= 2) this._crackAround(this.position, c.stomp.crackRadius);
    } else if (a.kind === 'throw') {
      this._throw(pl ? pl.position.clone() : a.target);
    } else if (a.kind === 'well') {
      this.well = { center: this.position.clone(), beatsLeft: c.well.beats, ring: this._ring(this.position, c.well.radius, 0x9c4dff, c.well.beats * this._beatDur()) };
      this.wellCooldown = c.well.cooldownBeats;
      this.bus.emit('noise', { pos: this.position.clone(), radius: 30, kind: 'gravityWell' });
    }
  }

  _endWell() {
    this.well?.ring?.removeFromParent();
    this.well = null;
  }

  /** Rip the nearest intact tile out of the floor and hurl it so it lands on the beat. */
  _throw(target) {
    const c = this.cfg;
    let tile = null;
    let best = Infinity;
    for (const t of this.tiles) {
      if (t.state !== 'intact') continue;
      const d = flatDist(t.mesh.position, this.position);
      if (d < best) [best, tile] = [d, t];
    }
    if (tile) this._voidTile(tile);
    const size = c.throw.chunk;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.5, size), tile?.baseMat ?? new THREE.MeshStandardMaterial({ color: 0x221418 }));
    mesh.castShadow = true;
    const from = this.position.clone().setY(this.position.y + this.cfg.height * 0.9);
    mesh.position.copy(from);
    this.fx.add(mesh);
    const flight = c.throw.flightBeats * this._beatDur();
    // land exactly on the beat: solve the ballistic arc for the flight time
    const g = 18;
    const v = new THREE.Vector3((target.x - from.x) / flight, (target.y - from.y) / flight + 0.5 * g * flight, (target.z - from.z) / flight);
    const marker = this._ring(target, c.throw.radius, 0xff8a3d, flight);
    this.projectiles.push({ mesh, v, g, t: 0, flight, target, marker });
  }

  _updateProjectiles(dt) {
    const c = this.cfg;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      p.v.y -= p.g * dt;
      p.mesh.position.addScaledVector(p.v, dt);
      p.mesh.rotation.x += dt * 4;
      p.mesh.rotation.z += dt * 3;
      if (p.t < p.flight) continue;
      // impact
      this.projectiles.splice(i, 1);
      p.marker?.removeFromParent();
      p.mesh.removeFromParent();
      this.bus.emit('noise', { pos: p.target.clone(), radius: 18, kind: 'impact' });
      const pl = this.target;
      if (pl && pl.hp > 0 && flatDist(pl.position, p.target) <= c.throw.radius && Math.abs(pl.position.y - p.target.y) < 2) {
        pl.takeDamage?.(c.throw.damage, this);
      }
      this._spawnDebris(p.target, p.mesh);
    }
  }

  _spawnDebris(at, proto) {
    if (!this.physics?.addDynamicBox) return;
    const s = this.cfg.throw.chunk;
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s * 0.45, s * 0.25, s * 0.45), proto.material);
      m.castShadow = true;
      this.fx.add(m);
      const id = this.physics.addDynamicBox({
        center: new THREE.Vector3(at.x + (Math.random() - 0.5), at.y + 0.6 + k * 0.3, at.z + (Math.random() - 0.5)),
        halfExtents: new THREE.Vector3(s * 0.225, s * 0.125, s * 0.225),
        mass: 25,
        mesh: m,
        velocity: new THREE.Vector3((Math.random() - 0.5) * 4, 3 + Math.random() * 2, (Math.random() - 0.5) * 4),
      });
      this.debris.push({ id, mesh: m, until: this.now + this.cfg.debrisLife });
    }
  }

  // ---------- frame update ----------
  update(dt, now, player) {
    this.now = now;
    this.target = player;
    const c = this.cfg;
    // fx life
    for (const m of [...this.fx.children]) {
      if (m.userData?.life === undefined) continue;
      m.userData.t += dt;
      const u = m.userData.t / m.userData.life;
      m.material.opacity = 0.85 * (1 - Math.max(0, u - 0.7) / 0.3);
      if (u >= 1 && m !== this.well?.ring && m !== this.attack?.telegraph) m.removeFromParent();
    }
    this._updateProjectiles(dt);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      if (now < this.debris[i].until) continue;
      this.physics.remove(this.debris[i].id);
      this.debris[i].mesh.removeFromParent();
      this.debris.splice(i, 1);
    }
    if (this.dead) {
      // death sequence: collapse (clip, or a slow topple without one), then the boss is officially defeated
      if (this.view && !this.view.userData.deathClip) this.view.rotation.x = Math.max(this.view.rotation.x - dt * 1.2, -Math.PI / 2);
      this._deathT += dt;
      if (!this._defeatSent && this._deathT >= c.deathTime) {
        this._defeatSent = true;
        this.bus.emit('bossDefeated', { id: this.id, pos: this.position.clone() });
      }
      return;
    }
    if (!player) return;

    // weak points
    const open = this.weakOpen;
    for (const w of this.weakPoints) {
      w.material.color.set(open ? 0x3df0ff : 0x551122);
      w.scale.setScalar(open ? 1.5 + 0.3 * Math.sin(now * 20) : 1);
    }

    const d = flatDist(this.position, player.position);
    if (this.state === 'idle') {
      if (d < c.aggroRange) {
        this.state = 'roar';
        this.roarBeats = 2;
        this._cue('hulkRoar', 2 * this._beatDur() + 0.2);
        this.bus.emit('bossPhase', { id: this.id, phase: this.phase });
      }
      this.syncView();
      return;
    }

    // gravity well pulls Kael (and debris) toward the core
    if (this.well) {
      const w = this.well;
      const to = new THREE.Vector3(w.center.x - player.position.x, 0, w.center.z - player.position.z);
      const dist = to.length();
      if (dist < c.well.radius && dist > 0.2) {
        const strength = c.well.pull * (1 - dist / c.well.radius) + c.well.pull * 0.4;
        player.applyImpulse?.(to.normalize().multiplyScalar(strength)); // controller adds this to velocity for the frame
      }
      for (const db of this.debris) {
        const b = this.physics.bodies?.get(db.id);
        if (!b) continue;
        const v = new THREE.Vector3(w.center.x - b.center.x, 0.4, w.center.z - b.center.z).normalize().multiplyScalar(30 * dt);
        this.physics.applyImpulse?.(db.id, v);
      }
    }

    // movement: chase between attacks, stand still while winding up, ducked or roaring
    const moving = this.state === 'chase' && !this.ducked && d > c.keepDistance;
    const desiredYaw = yawTo(this.position, player.position);
    const turn = angleDelta(this.yaw, desiredYaw);
    if (this.state !== 'roar' && !this.ducked) this.yaw += Math.sign(turn) * Math.min(Math.abs(turn), c.turnRate * dt);
    if (moving) {
      const sp = c.speed[this.phase - 1];
      const disp = new THREE.Vector3(Math.sin(this.yaw) * sp * dt, -0.2 * dt, Math.cos(this.yaw) * sp * dt);
      if (this.physics?.moveCapsule) {
        const r = this.physics.moveCapsule(this.position, disp, c.radius, c.height, { solid: true, stepHeight: 0.5, maxSlopeDeg: 40 });
        this.position.copy(r.position);
      } else this.position.add(disp.setY(0));
    }
    this.velocity.set(moving ? Math.sin(this.yaw) : 0, 0, moving ? Math.cos(this.yaw) : 0);
    this.animState = this.ducked ? 'stagger' : this.state === 'windup' ? `windup_${this.attack?.kind}` : this.state === 'roar' ? 'roar' : moving ? 'walk' : 'idle';
    this.syncView();
  }

  /** Far too heavy for knockback. */
  applyImpulse() {}

  // ---------- damage / duck ----------
  duck(sec = this.cfg.offBeatDuck) {
    if (this.dead || this.state === 'roar') return;
    const onBeat = this._onBeatNow();
    // only an on-beat duck opens the weak points; it also staggers the Hulk and cancels its wind-up
    if (onBeat) {
      this.weakOpenUntil = this.now + this.cfg.weakOpenTime;
      this._weakStaggered = false;
      this._cue('hulkStagger', Math.min(this.cfg.weakOpenTime, this.cfg.anim.staggerTime * 1.6));
      if (this.attack) {
        this.attack.telegraph?.removeFromParent();
        this.attack = null;
        this.state = 'chase';
        this.beatsSinceAttack = 0;
      }
      super.duck(this.cfg.weakOpenTime);
    } else super.duck(Math.min(sec, this.cfg.offBeatDuck));
  }

  takeDamage(n, src) {
    if (this.dead || !(n > 0) || this.state === 'roar') return 0;
    const weak = this.weakOpen;
    const dealt = n * (weak ? this.cfg.weakMult : this.cfg.armor);
    this.hp = Math.max(0, this.hp - dealt);
    this.bus.emit('enemyHit', { id: this.id, kind: this.kind, amount: dealt, hp: this.hp, hpMax: this.hpMax, pos: this.position.clone(), src, weak });
    this.lastHit = { amount: dealt, weak, onBeat: !!src?.onBeat, fatal: this.hp <= 0 };
    this.hitSeq++;
    if (this.state === 'idle') this.state = 'chase';
    if (this.hp <= 0) {
      this.dead = true;
      this.state = 'dead';
      this.animState = 'dead';
      this.attack?.telegraph?.removeFromParent();
      this.attack = null;
      this._endWell();
      for (const p of this.projectiles) {
        p.marker?.removeFromParent();
        p.mesh.removeFromParent();
      }
      this.projectiles.length = 0;
      this._cue('death', null, true);
      for (const w of this.weakPoints) w.visible = false;
      this.bus.emit('enemyKilled', { id: this.id, kind: this.kind, pos: this.position.clone() });
      // bossDefeated follows after the death sequence (update -> deathTime)
      return dealt;
    }
    // the first blow into an open weak point rocks it
    if (weak && !this._weakStaggered) {
      this._weakStaggered = true;
      this._cue('hulkStagger', this.cfg.anim.staggerTime);
    }
    const ratio = this.hp / this.hpMax;
    const next = ratio <= this.cfg.phaseAt[1] ? 3 : ratio <= this.cfg.phaseAt[0] ? 2 : 1;
    if (next > this.phase) {
      this.phase = next;
      this.state = 'roar';
      this.roarBeats = this.cfg.roarBeats;
      this._cue('hulkRoar', this.cfg.roarBeats * this._beatDur());
      this.weakOpenUntil = -Infinity;
      this.attack?.telegraph?.removeFromParent();
      this.attack = null;
      this._crackAround(this.position, this.cfg.stomp.crackRadius + 2 * (next - 1));
      this.bus.emit('bossPhase', { id: this.id, phase: next });
    }
    return dealt;
  }

  dispose() {
    this._offs.forEach((o) => o?.());
    this._endWell();
    for (const d of this.debris) {
      this.physics.remove(d.id);
      d.mesh.removeFromParent();
    }
    this.fx.removeFromParent();
    for (const t of this.tiles) t.mesh.material = t.baseMat;
  }
}

export function createHulk(o) {
  return new Hulk(o);
}
