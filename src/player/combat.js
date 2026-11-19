import * as THREE from 'three';

/**
 * Combat state machine with crossfades (L4).
 * States: idle (loco owns motion), melee1/2/3, blast, hit.
 * On-beat rule: |phase| < window or > 1-window → damage × onBeatMult + shockwave.
 * Emits playerDamaged / playerHealed / sidechain / noise on the bus.
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
    this.queued = null;
    this.blastCd = 0;
    this.struck = false;
    this.shockwaves = [];
  }

  get locked() {
    return this.state === 'melee1' || this.state === 'melee2' || this.state === 'melee3' || this.state === 'blast' || this.state === 'hit';
  }

  isOnBeat() { return this.clock?.isOnBeat?.() ?? false; }

  requestMelee() {
    if (this.state === 'hit') return;
    if (this.state === 'blast') return;
    if (this.state === 'idle' || this.state.startsWith('jump') || this.state === 'loco') {
      this._enterMelee(0);
      return;
    }
    if (this.state.startsWith('melee')) {
      const i = this.combo;
      const cancel = (this.t.meleeCancel || [0.2, 0.22, 0.36])[i] ?? 0.2;
      const dur = (this.t.meleeDuration || [0.42, 0.44, 0.62])[i] ?? 0.45;
      if (this.time >= cancel && this.time <= dur && i < 2) this.queued = i + 1;
    }
  }

  requestBlast() {
    if (this.blastCd > 0 || this.state === 'hit') return false;
    this._enter('blast', 'blast', { fade: 0.08, fadeOut: 0.16, timeScale: 1.15 });
    this.struck = false;
    this.blastCd = this.t.blastCooldown ?? 2.5;
    return true;
  }

  hitReact() {
    this.queued = null;
    this._enter('hit', 'hit', { fade: 0.05, fadeOut: 0.18, timeScale: 1.2 });
  }

  _enterMelee(i) {
    this.combo = i;
    this.struck = false;
    const names = ['melee1', 'melee2', 'melee3'];
    const dur = (this.t.meleeDuration || [])[i] ?? 0.45;
    const clip = this.loco._resolveClip?.(names[i]);
    // If the clip is longer/shorter, time-scale so the authored window fits
    let ts = 1;
    if (clip) ts = clip.clip.duration / dur;
    this._enter(names[i], names[i], { fade: 0.07, fadeOut: 0.12, timeScale: ts || 1 });
  }

  _enter(state, logical, opts) {
    this.state = state;
    this.time = 0;
    const layer = this.loco.play(logical, {
      ...opts,
      onDone: () => {
        if (this.state === state) {
          if (this.queued !== null && state.startsWith('melee')) {
            const n = this.queued; this.queued = null; this._enterMelee(n);
          } else {
            this.state = 'idle';
            this.combo = 0;
            this.queued = null;
          }
        }
      },
    });
    if (!layer) {
      // no clip: hold the state for the configured duration then return
      this._hold = (this.t.meleeDuration || [0.4])[this.combo] || 0.4;
      if (state === 'blast') this._hold = 0.45;
      if (state === 'hit') this._hold = this.t.hitStun ?? 0.4;
    } else {
      this._hold = null;
    }
  }

  takeDamage(amount, src, player) {
    const hpMax = player.hpMax;
    const dealt = Math.max(0, amount);
    player.hp = Math.max(0, player.hp - dealt);
    this.bus.emit('playerDamaged', { amount: dealt, hp: player.hp, hpMax, src });
    this.hitReact();
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

    if (this._hold !== null && this.time >= this._hold) {
      this._hold = null;
      if (this.queued !== null && this.state.startsWith('melee')) {
        const n = this.queued; this.queued = null; this._enterMelee(n);
      } else if (this.state !== 'idle') {
        this.state = 'idle'; this.combo = 0;
      }
    }

    if (this.state.startsWith('melee') && !this.struck && this.time >= 0.12) {
      this.struck = true;
      this._strike(player, 'melee', (this.t.meleeDamage || [12, 16, 24])[this.combo] ?? 12, this.t.sidechainStrengthMelee ?? 0.6);
    }
    if (this.state === 'blast' && !this.struck && this.time >= 0.1) {
      this.struck = true;
      this._blast(player);
    }

    for (const s of this.shockwaves) s.t += dt;
    this.shockwaves = this.shockwaves.filter((s) => s.t < s.life);
  }

  _forward() {
    const y = this.object.rotation.y;
    return new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
  }

  _strike(player, kind, baseDamage, strength) {
    const onBeat = this.isOnBeat();
    const mult = onBeat ? (this.t.onBeatMult ?? 1.5) : 1;
    const dmg = baseDamage * mult;
    const range = this.t.meleeRange ?? 1.9;
    const ang = (this.t.meleeAngleDeg ?? 100) * Math.PI / 180;
    const fwd = this._forward();
    const origin = player.position;
    let any = false;
    for (const e of this.getEnemies()) {
      if (!e || e.hp <= 0) continue;
      const dx = e.position.x - origin.x, dz = e.position.z - origin.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      if (dist > 0.05) {
        const dir = new THREE.Vector3(dx, 0, dz).normalize();
        if (dir.dot(fwd) < Math.cos(ang * 0.5)) continue;
      }
      e.takeDamage(dmg, { kind, onBeat, source: 'player' });
      if (onBeat && e.duck) e.duck(this.t.duckWindow ?? 0.35);
      any = true;
    }
    this.bus.emit('sidechain', { source: kind, strength: strength * (onBeat ? 1.2 : 1), onBeat });
    this.bus.emit('noise', { pos: origin.clone(), radius: 6, kind });
    if (onBeat) this.shockwaves.push({ pos: origin.clone(), t: 0, life: 0.35, r: 3 });
    return any;
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
    for (const e of this.getEnemies()) {
      if (!e || e.hp <= 0) continue;
      const to = new THREE.Vector3(e.position.x - origin.x, 0, e.position.z - origin.z);
      const dist = to.length();
      if (dist > range || dist < 1e-4) continue;
      to.multiplyScalar(1 / dist);
      if (to.dot(fwd) < Math.cos(ang * 0.5)) continue;
      e.takeDamage(dmg, { kind: 'blast', onBeat, source: 'player' });
      if (e.applyImpulse) e.applyImpulse(to.multiplyScalar(kb * (1 - dist / range) + 0 * 0).setY(3));
      else if (e.velocity) e.velocity.add(to.clone().multiplyScalar(kb).setY(3));
      if (e.duck) e.duck(this.t.duckWindow ?? 0.35);
    }
    this.bus.emit('sidechain', { source: 'blast', strength: (this.t.sidechainStrengthBlast ?? 1) * (onBeat ? 1.2 : 1), onBeat });
    this.bus.emit('noise', { pos: origin.clone(), radius: 12, kind: 'blast' });
    this.shockwaves.push({ pos: origin.clone().add(fwd), t: 0, life: 0.45, r: range, fwd: fwd.clone(), ang, onBeat });
  }
}

/** Simple expanding ring / cone placeholders until Aether's VFX (A2). */
export function createCombatFx() {
  const group = new THREE.Group();
  group.name = 'combatFx';
  const ringGeom = new THREE.RingGeometry(0.6, 0.75, 32);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x3df0ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  group.add(ring);
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 7, 16, 1, true), coneMat);
  cone.rotation.x = -Math.PI / 2;
  cone.position.z = 3.5;
  group.add(cone);
  return {
    group,
    update(combat, player) {
      group.position.copy(player.position);
      group.position.y += 0.05;
      group.rotation.y = player.object?.rotation.y ?? 0;
      let ringOp = 0, ringS = 1, coneOp = 0;
      for (const s of combat.shockwaves) {
        const a = 1 - s.t / s.life;
        if (s.fwd) { coneOp = Math.max(coneOp, a * 0.45); }
        else { ringOp = Math.max(ringOp, a * 0.7); ringS = 1 + s.t * 10; }
      }
      ringMat.opacity = ringOp; ring.scale.setScalar(ringS);
      coneMat.opacity = coneOp;
    },
  };
}
