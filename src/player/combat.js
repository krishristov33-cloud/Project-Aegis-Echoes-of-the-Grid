import * as THREE from 'three';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Player combat (L4).
 * States: idle (locomotion owns the body), melee1/2/3, blast, hit (heavy stagger), cast (power gestures).
 *
 * Feel rules:
 *  - every attack snaps to the best target in front of the stick / facing and lunges to striking distance
 *  - presses are buffered; the next combo hit starts at the earliest cancel point, not at the end of the clip
 *  - contact frames come from tuning (matching the authored clips), and each hit that lands emits `impact`
 *    (hit-stop, camera shake, sfx and vfx all hang off that one event)
 *  - light damage only flinches the upper body; heavy damage staggers
 * On-beat rule: |phase| < window or > 1-window → damage × onBeatMult + shockwave.
 * Emits playerDamaged / playerHealed / sidechain / noise / impact / comboChanged / playerAction on the bus.
 */
export class Combat {
  constructor({ bus, clock, tuning, loco, object, getEnemies }) {
    this.bus = bus;
    this.clock = clock;
    this.t = tuning.combat || {};
    this.playerT = tuning.player || {};
    this.loco = loco;
    this.object = object;
    this.getEnemies = getEnemies || (() => []);
    this.state = 'idle';
    this.combo = 0;
    this.time = 0;
    this.dur = 0;
    this.queued = false;
    this.buffer = 0;          // seconds a melee press stays valid
    this.blastCd = 0;
    this.struck = false;
    this.shockwaves = [];
    this.target = null;
    this.faceYaw = null;      // yaw the body should hold during the current action
    this.lunge = new THREE.Vector3();
    this.lungeT = 0;
    this.hits = 0;            // landed hits in the current streak
    this.beatStreak = 0;
    this.streakT = 0;
    this.layer = null;
  }

  get locked() {
    return this.state !== 'idle';
  }

  /** The current action may be interrupted by a dodge or a jump. */
  get canCancel() {
    if (this.state === 'idle') return true;
    if (this.state === 'hit') return false;
    if (this.state === 'blast') return this.time >= (this.t.blastCancel ?? 0.38);
    if (this.state === 'cast') return this.time >= this.dur * 0.6;
    return this.time >= ((this.t.meleeCancel || [])[this.combo] ?? 0.2);
  }

  isOnBeat() { return this.clock?.isOnBeat?.() ?? false; }

  /** @param {THREE.Vector3|null} wish  stick direction (unit, world) or null */
  requestMelee(wish = null) {
    this._wish = wish ? wish.clone() : null;
    this.buffer = this.t.inputBuffer ?? 0.22;
  }

  requestBlast(wish = null) {
    if (this.blastCd > 0 || this.state === 'hit' || this.state === 'blast') return false;
    if (this.state !== 'idle' && !this.canCancel) return false;
    const dur = this.t.blastDuration ?? 0.62;
    this._aim(wish, this.t.blastRange ?? 8, (this.t.blastAngleDeg ?? 55) + 50);
    this.lungeT = 0;
    this._enter('blast', 'blast', dur, { fade: 0.06, fadeOut: 0.2 });
    this.struck = false;
    this.blastCd = this.t.blastCooldown ?? 2.5;
    this.bus.emit('playerAction', { name: 'blastCharge' });
    return true;
  }

  /** Power gesture: lock the body for `lock` seconds while `logical` plays. */
  cast(logical, lock = 0.3, opts = {}) {
    if (this.state === 'hit') return;
    this.queued = false; this.buffer = 0; this.lungeT = 0;
    this.faceYaw = opts.yaw ?? null;
    this._enter('cast', logical, lock, { fade: 0.05, fadeOut: 0.18, natural: true });
  }

  interrupt(fade = 0.1) {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.queued = false; this.buffer = 0; this.lungeT = 0; this.faceYaw = null;
    this.layer?.leave?.(fade);
    this.layer = null;
  }

  /** Best enemy for an attack thrown along `dir` (or the facing). */
  pickTarget(dir, range, angleDeg) {
    const origin = this.object.position;
    const fwd = dir && dir.lengthSq() > 1e-6 ? dir : this._forward();
    const cosMax = Math.cos((angleDeg * Math.PI / 180) * 0.5);
    let best = null, bestScore = Infinity;
    for (const e of this.getEnemies()) {
      if (!e || e.hp <= 0 || e.dead) continue;
      const dx = e.position.x - origin.x, dz = e.position.z - origin.z;
      const dist = Math.hypot(dx, dz);
      const rad = e.cfg?.radius ?? e.radius ?? 0.35;
      if (dist - rad > range) continue;
      if (Math.abs(e.position.y - origin.y) > 2.6) continue;
      const dot = dist > 1e-3 ? (dx * fwd.x + dz * fwd.z) / dist : 1;
      if (dot < cosMax && dist > 1.2) continue;
      const score = dist * (1.6 - dot * 0.6);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  _aim(wish, range, angleDeg) {
    const tgt = this.pickTarget(wish, range, angleDeg);
    this.target = tgt;
    const origin = this.object.position;
    if (tgt) this.faceYaw = Math.atan2(tgt.position.x - origin.x, tgt.position.z - origin.z);
    else if (wish && wish.lengthSq() > 1e-6) this.faceYaw = Math.atan2(wish.x, wish.z);
    else this.faceYaw = this.object.rotation.y;
    return tgt;
  }

  _enterMelee(i) {
    this.combo = i;
    this.struck = false;
    this.queued = false;
    const names = ['melee1', 'melee2', 'melee3'];
    const dur = (this.t.meleeDuration || [])[i] ?? 0.45;
    const hitT = (this.t.meleeHitTime || [])[i] ?? 0.12;
    const tgt = this._aim(this._wish, this.t.lockRange ?? 4.2, this.t.lockAngleDeg ?? 150);
    // lunge so the contact frame happens at striking distance
    const origin = this.object.position;
    const fy = this.faceYaw;
    let travel = (this.t.meleeStep || [])[i] ?? 0.5;
    if (tgt) {
      const rad = tgt.cfg?.radius ?? tgt.radius ?? 0.35;
      const dist = Math.hypot(tgt.position.x - origin.x, tgt.position.z - origin.z);
      travel = Math.max(-0.4, Math.min(this.t.lungeMax ?? 2.6, dist - rad - (this.t.meleeReach ?? 0.85)));
    }
    this.lunge.set(Math.sin(fy), 0, Math.cos(fy)).multiplyScalar(travel / Math.max(0.05, hitT));
    this.lungeT = hitT;
    this._enter(names[i], names[i], dur, { fade: i === 0 ? 0.06 : 0.05, fadeOut: 0.16 });
    this.bus.emit('playerAction', { name: 'swing', index: i });
  }

  _enter(state, logical, dur, opts = {}) {
    this.state = state;
    this.time = 0;
    this.dur = dur;
    const res = this.loco._resolveClip?.(logical);
    // time-scale so the authored clip fits the tuned duration (keeps contact frames aligned)
    const ts = res && !opts.natural ? res.clip.duration / Math.max(0.05, dur) : 1;
    this.layer = this.loco.play(logical, { fade: opts.fade, fadeOut: opts.fadeOut, timeScale: ts || 1 });
  }

  /** @returns {number} damage dealt */
  takeDamage(amount, src, player) {
    if (player.hp <= 0) return 0;
    if (player.invulnerable || (player._iframe ?? 0) > 0) return 0;
    const hpMax = player.hpMax;
    const dealt = Math.max(0, amount);
    if (dealt <= 0) return 0;
    player.hp = Math.max(0, player.hp - dealt);
    player._iframe = Math.max(player._iframe ?? 0, this.t.hurtIframe ?? 0.25);
    this.hits = 0; this.beatStreak = 0; this.streakT = 0;
    this.bus.emit('comboChanged', { count: 0, onBeatStreak: 0 });
    this.bus.emit('playerDamaged', { amount: dealt, hp: player.hp, hpMax, src });
    const from = src?.position ?? src?.pos ?? src?.from ?? null;
    this.bus.emit('impact', { pos: player.position.clone().setY(player.position.y + 1.2), strength: Math.min(1, dealt / 30), kind: 'hurt', onBeat: false, from });
    if (player.hp <= 0) return dealt;
    const heavy = dealt >= (this.t.heavyHit ?? 18);
    if (heavy) {
      this.queued = false; this.buffer = 0; this.lungeT = 0;
      this._enter('hit', 'hit', this.t.hitStun ?? 0.32, { fade: 0.04, fadeOut: 0.2, natural: true });
      if (from && player.applyImpulse) {
        const kx = player.position.x - from.x, kz = player.position.z - from.z;
        const kl = Math.hypot(kx, kz) || 1;
        const kb = this.t.hurtKnockback ?? 3.5;
        this.faceYaw = Math.atan2(-kx, -kz);
        this.lunge.set((kx / kl) * kb, 0, (kz / kl) * kb);
        this.lungeT = 0.16;
      } else this.faceYaw = null;
    } else {
      // light hit: flinch over whatever the body is doing, no loss of control
      this.loco.play('hit', { partial: true, fade: 0.04, fadeOut: 0.22, timeScale: 1.25 });
    }
    return dealt;
  }

  heal(amount, player) {
    const hpMax = player.hpMax;
    const add = Math.max(0, amount);
    player.hp = Math.min(hpMax, player.hp + add);
    this.bus.emit('playerHealed', { amount: add, hp: player.hp, hpMax });
  }

  update(dt, player) {
    this.time += dt;
    if (this.blastCd > 0) this.blastCd = Math.max(0, this.blastCd - dt);
    if (this.buffer > 0) this.buffer -= dt;
    if (this.lungeT > 0) this.lungeT -= dt;
    if (this.streakT > 0) {
      this.streakT -= dt;
      if (this.streakT <= 0 && this.hits) {
        this.hits = 0; this.beatStreak = 0;
        this.bus.emit('comboChanged', { count: 0, onBeatStreak: 0 });
      }
    }

    // buffered melee: start a combo, or chain at the cancel point
    if (this.buffer > 0 && player.hp > 0) {
      if (this.state === 'idle') {
        if (player.isGrounded && !player.busy) { this.buffer = 0; this._enterMelee(0); }
      } else if (this.state.startsWith('melee')) {
        this.queued = true;
      }
    }
    if (this.state.startsWith('melee')) {
      const i = this.combo;
      const cancel = (this.t.meleeCancel || [])[i] ?? 0.2;
      if (this.queued && this.time >= cancel) {
        this.buffer = 0;
        this._enterMelee(i < 2 ? i + 1 : 0);
      } else if (!this.struck && this.time >= ((this.t.meleeHitTime || [])[i] ?? 0.12)) {
        this.struck = true;
        this._strike(player, 'melee', (this.t.meleeDamage || [12, 16, 24])[i] ?? 12, this.t.sidechainStrengthMelee ?? 0.6);
      }
    }
    if (this.state === 'blast' && !this.struck && this.time >= (this.t.blastHitTime ?? 0.16)) {
      this.struck = true;
      this._blast(player);
    }
    if (this.state !== 'idle' && this.time >= this.dur) {
      this.state = 'idle';
      this.combo = 0;
      this.queued = false;
      this.faceYaw = null;
      this.layer = null;
    }

    for (const s of this.shockwaves) s.t += dt;
    this.shockwaves = this.shockwaves.filter((s) => s.t < s.life);
  }

  _forward() {
    const y = this.faceYaw ?? this.object.rotation.y;
    return new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
  }

  _landed(e, dmg, kind, onBeat, strength) {
    const killed = e.hp <= 0 || e.dead;
    this.hits++;
    this.beatStreak = onBeat ? this.beatStreak + 1 : 0;
    this.streakT = this.t.comboWindow ?? 2.4;
    const pos = e.position.clone();
    pos.y += Math.min(1.3, (e.cfg?.height ?? 1.8) * 0.65);
    this.bus.emit('impact', { pos, strength: Math.min(1, strength * (onBeat ? 1.25 : 1) * (killed ? 1.3 : 1)), kind: killed ? 'kill' : kind, onBeat, id: e.id });
  }

  _strike(player, kind, baseDamage, strength) {
    const onBeat = this.isOnBeat();
    const mult = onBeat ? (this.t.onBeatMult ?? 1.5) : 1;
    const dmg = baseDamage * mult;
    const range = this.t.meleeRange ?? 1.9;
    const ang = (this.t.meleeAngleDeg ?? 100) * Math.PI / 180;
    const fwd = this._forward();
    const origin = player.position;
    const finisher = this.combo === 2;
    let any = 0;
    for (const e of this.getEnemies()) {
      if (!e || e.hp <= 0) continue;
      const dx = e.position.x - origin.x, dz = e.position.z - origin.z;
      const dist = Math.hypot(dx, dz);
      const rad = e.cfg?.radius ?? e.radius ?? 0.35;
      if (dist - rad > range) continue;
      if (Math.abs(e.position.y - origin.y) > 2.6) continue;
      if (dist > 0.05 + rad) {
        const dot = (dx * fwd.x + dz * fwd.z) / dist;
        if (dot < Math.cos(ang * 0.5)) continue;
      }
      e.takeDamage(dmg, { kind, onBeat, source: 'player', finisher });
      if (onBeat && e.duck) e.duck(this.t.duckWindow ?? 0.35);
      if (finisher && e.applyImpulse) {
        const kb = this.t.finisherKnockback ?? 7;
        e.applyImpulse(new THREE.Vector3((dx / (dist || 1)) * kb, 2, (dz / (dist || 1)) * kb));
      }
      any++;
      this._landed(e, dmg, kind, onBeat, 0.35 + this.combo * 0.2);
    }
    if (any) this.bus.emit('comboChanged', { count: this.hits, onBeatStreak: this.beatStreak });
    this.bus.emit('sidechain', { source: kind, strength: strength * (onBeat ? 1.2 : 1), onBeat });
    this.bus.emit('noise', { pos: origin.clone(), radius: 6, kind });
    if (onBeat && any) this.shockwaves.push({ pos: origin.clone(), t: 0, life: 0.35, r: 3 });
    return any > 0;
  }

  _blast(player) {
    const onBeat = this.isOnBeat();
    const mult = onBeat ? (this.t.onBeatMult ?? 1.5) : 1;
    const dmg = (this.t.blastDamage ?? 28) * mult;
    const range = this.t.blastRange ?? 8;
    const ang = (this.t.blastAngleDeg ?? 55) * Math.PI / 180;
    const fwd = this._forward();
    const origin = player.position;
    const kb = this.t.blastKnockback ?? 14;
    let any = 0;
    for (const e of this.getEnemies()) {
      if (!e || e.hp <= 0) continue;
      const to = new THREE.Vector3(e.position.x - origin.x, 0, e.position.z - origin.z);
      const dist = to.length();
      const rad = e.cfg?.radius ?? e.radius ?? 0.35;
      if (dist - rad > range || dist < 1e-4) continue;
      to.multiplyScalar(1 / dist);
      if (to.dot(fwd) < Math.cos(ang * 0.5) && dist > 1.4 + rad) continue;
      e.takeDamage(dmg, { kind: 'blast', onBeat, source: 'player' });
      const fall = Math.max(0.25, 1 - dist / range);
      if (e.applyImpulse) e.applyImpulse(to.clone().multiplyScalar(kb * fall).setY(3));
      else if (e.velocity) e.velocity.add(to.clone().multiplyScalar(kb).setY(3));
      if (e.duck) e.duck(this.t.duckWindow ?? 0.35);
      any++;
      this._landed(e, dmg, 'blast', onBeat, 0.7);
    }
    if (any) this.bus.emit('comboChanged', { count: this.hits, onBeatStreak: this.beatStreak });
    // the release itself kicks, hit or not
    this.bus.emit('impact', { pos: origin.clone().addScaledVector(fwd, 1.2).setY(origin.y + 1.2), strength: any ? 0.3 : 0.55, kind: 'blast', onBeat, release: true });
    this.bus.emit('sidechain', { source: 'blast', strength: (this.t.sidechainStrengthBlast ?? 1) * (onBeat ? 1.2 : 1), onBeat });
    this.bus.emit('noise', { pos: origin.clone(), radius: 12, kind: 'blast' });
    this.shockwaves.push({ pos: origin.clone().add(fwd), t: 0, life: 0.45, r: range, fwd: fwd.clone(), ang, onBeat });
    // recoil: a short shove backwards
    this.lunge.copy(fwd).multiplyScalar(-(this.t.blastRecoil ?? 2.2));
    this.lungeT = 0.12;
  }
}

/** Ground ring for on-beat hits (the blast cone and swing arcs are Aether's, in src/fx). */
export function createCombatFx() {
  const group = new THREE.Group();
  group.name = 'combatFx';
  const ringGeom = new THREE.RingGeometry(0.62, 0.7, 48);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x3df0ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.visible = false;
  group.add(ring);
  return {
    group,
    update(combat, player) {
      let ringOp = 0, ringS = 1;
      for (const s of combat.shockwaves) {
        if (s.fwd) continue;
        const a = 1 - s.t / s.life;
        if (a * 0.5 > ringOp) { ringOp = a * a * 0.5; ringS = 1 + s.t * 9; group.position.copy(s.pos); }
      }
      group.position.y = player.position.y + 0.06;
      ringMat.opacity = ringOp; ring.scale.setScalar(ringS); ring.visible = ringOp > 0.003;
    },
  };
}
