// Hitscan rifle shared by soldiers (and optionally drones). Built to be read and dodged:
//
//   idle -> AIM (wind-up, laser on, `enemyTelegraph {kind:'aim'}`) -> BURST -> PAUSE -> RE-AIM (short,
//   `enemyTelegraph {kind:'burst'}`) -> BURST ...
//
// The gun does not roll dice against the player directly. It drags an AIM POINT after the target at a limited
// speed (`trackSpeed`, slower while firing), and a bullet hits only when the line muzzle -> aim point passes within
// `hitRadius` of the target's chest with a clear line of fire. Standing still lets the aim point settle on you;
// sprinting sideways, jumping or dodging outruns it, and you can see it coming because the laser shows the aim point.
// A per-shot accuracy roll (distance, suppression, airborne) is applied on top.
//
// Firing needs an attack token from the squad (`tokens`, capped by squad.maxShooters) so only a few enemies shoot
// at once; a shooter rests after its burst so the others get a turn.
//
// Emits `enemyTelegraph {id, kind, pos, time}`, `enemyShot {id, from, to, hit, targetGhost, dodged}` and
// `noise {pos, radius, kind:'enemyShot'}`.
import * as THREE from 'three';
import { randRange, clamp } from './util.js';

const _chest = new THREE.Vector3();
const _real = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _spread = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/** Distance from point p to segment a-b. */
function distToSegment(p, a, b) {
  _ab.subVectors(b, a);
  const len2 = _ab.lengthSq();
  const t = len2 > 1e-8 ? clamp(_ap.subVectors(p, a).dot(_ab) / len2, 0, 1.15) : 0;
  return _tmp.copy(a).addScaledVector(_ab, t).distanceTo(p);
}

export class Weapon {
  constructor({ owner, cfg, bus, los }) {
    this.owner = owner;
    this.cfg = cfg;
    this.bus = bus;
    this.los = los;
    this.ammo = cfg.magazine;
    this.reloadLeft = 0;
    this.burstLeft = 0;
    this.cooldown = 0;
    this.phase = 'idle'; // idle | aim | burst | pause
    this.timer = 0;
    this.aimDur = 0;
    this.aimPoint = new THREE.Vector3();
    this.hasAim = false;
    this.lostFor = 0;
    this.restUntil = -Infinity;
    this.firstBurst = true;
    // encounter-flow.js reads `trackedFor` for its own telegraph line; the laser replaces it, so it stays 0
    this.trackedFor = 0;
  }

  get reloading() {
    return this.reloadLeft > 0;
  }

  /** 0..1 through the current wind-up (laser brightness). */
  get aimProgress() {
    return this.phase === 'aim' ? clamp(1 - this.timer / Math.max(0.05, this.aimDur), 0, 1) : this.phase === 'burst' ? 1 : 0;
  }

  /** True while the laser should show. */
  get aiming() {
    return this.hasAim && (this.phase === 'aim' || this.phase === 'burst');
  }

  startReload() {
    if (this.reloading || this.ammo === this.cfg.magazine || !this.cfg.reloadTime) return false;
    this.reloadLeft = this.cfg.reloadTime;
    this._stand('idle');
    return true;
  }

  /** Hit, stun or lost target: drop the wind-up and hand the token back. */
  interrupt(rest = 0) {
    this._stand('idle');
    this.firstBurst = true;
    this.hasAim = false;
    if (rest > 0) this.restUntil = Math.max(this.restUntil, (this.owner.now ?? 0) + rest);
  }

  _stand(phase) {
    this.phase = phase;
    this.burstLeft = 0;
    this.owner.squad?.tokens?.release(this.owner);
  }

  _telegraph(kind, time, muzzle) {
    this.bus.emit('enemyTelegraph', { id: this.owner.id, kind, pos: muzzle.clone(), time, target: this.aimPoint.clone() });
  }

  /**
   * @param {number} dt
   * @param {object} p
   * @param {boolean} p.wantFire     the brain wants to shoot this frame
   * @param {Vector3} p.aimPos       believed target position (feet)
   * @param {object}  p.target       real player (gets takeDamage on a hit)
   * @param {boolean} p.atGhost      aiming at a blink ghost: shots can't hit the player
   * @param {Vector3} p.muzzle       world muzzle position
   * @param {number}  p.suppression  0..1 owner's suppression
   * @param {boolean} [p.offscreen]  the player cannot see this shooter: longer wind-up
   * @returns {'fired'|'reload'|null}
   */
  update(dt, { wantFire, aimPos, target, atGhost, muzzle, suppression = 0, offscreen = false }) {
    const c = this.cfg;
    const now = this.owner.now ?? 0;
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.ammo = c.magazine;
      return null;
    }
    if (target && target.hp <= 0) wantFire = false; // don't keep shooting a downed player
    this.cooldown -= dt;

    if (!wantFire || !aimPos) {
      // a short loss of sight keeps the wind-up; a long one starts over with the full reaction time
      this.lostFor += dt;
      if (this.phase !== 'idle' && this.lostFor > (c.loseAimAfter ?? 0.6)) this.interrupt();
      if (this.lostFor > (c.forgetAimAfter ?? 2.5)) this.firstBurst = true;
      return null;
    }
    this.lostFor = 0;

    // --- aim point: chases the believed chest position at a limited speed ---
    _chest.copy(aimPos).setY(aimPos.y + (c.aimHeight ?? 1.1));
    if (!this.hasAim) {
      // start off-target so the laser visibly sweeps on
      const side = Math.random() < 0.5 ? -1 : 1;
      const dx = _chest.x - muzzle.x;
      const dz = _chest.z - muzzle.z;
      const len = Math.hypot(dx, dz) || 1;
      const off = c.aimStartOffset ?? 1.8;
      this.aimPoint.set(_chest.x + (-dz / len) * off * side, _chest.y - 0.9, _chest.z + (dx / len) * off * side);
      this.hasAim = true;
    }
    const firing = this.phase === 'burst';
    const track = (firing ? (c.trackSpeedFiring ?? 2.6) : (c.trackSpeed ?? 5)) * (1 - 0.5 * suppression);
    _tmp.subVectors(_chest, this.aimPoint);
    const gap = _tmp.length();
    if (gap > 1e-4) this.aimPoint.addScaledVector(_tmp, Math.min(1, (track * dt) / gap));

    if (this.phase === 'idle') {
      if (now < this.restUntil) return null;
      if (this.ammo <= 0) return this.startReload() ? 'reload' : null;
      const tokens = this.owner.squad?.tokens;
      if (tokens && !tokens.request(this.owner, now)) return null;
      this.phase = 'aim';
      this.aimDur = (this.firstBurst ? c.reactionTime : (c.reaimTime ?? 0.45)) * (offscreen ? (c.offscreenAimMult ?? 1.6) : 1);
      this.timer = this.aimDur;
      this._telegraph(this.firstBurst ? 'aim' : 'burst', this.aimDur, muzzle);
      return null;
    }

    if (this.phase === 'aim') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.phase = 'burst';
        this.firstBurst = false;
        this.burstLeft = Math.round(randRange(c.burst));
        this.cooldown = 0;
      }
      return null;
    }

    if (this.phase === 'pause') {
      this.timer -= dt;
      if (this.timer <= 0) this.phase = 'idle';
      return null;
    }

    // --- burst ---
    if (this.cooldown > 0) return null;
    if (this.ammo <= 0) return this.startReload() ? 'reload' : null;
    this.cooldown = 1 / c.rof;
    this.ammo--;
    this.burstLeft--;

    const dist = muzzle.distanceTo(_chest);
    let chance = 0;
    let dodged = false;
    if (!atGhost && dist <= c.range) {
      _real.copy(target.position).setY(target.position.y + (c.aimHeight ?? 1.1));
      const miss = distToSegment(_real, muzzle, this.aimPoint);
      if (miss <= (c.hitRadius ?? 0.5) && !this.los.blocked(muzzle, _real, this.owner.view)) {
        chance = c.accuracyNear + (c.accuracyFar - c.accuracyNear) * clamp(dist / c.range, 0, 1);
        chance *= 1 - c.suppressedPenalty * suppression;
        if (target.isGrounded === false) chance *= 1 - (c.airbornePenalty ?? 0.6);
        const speed = target.velocity ? Math.hypot(target.velocity.x, target.velocity.z) : 0;
        chance *= 1 - (c.movingTargetPenalty ?? 0) * clamp(speed / 7.5, 0, 1);
        if ((target._iframe ?? 0) > 0 || target.invulnerable) {
          dodged = chance > 0;
          chance = 0;
        }
      }
    }
    const hit = Math.random() < chance;
    // tracers follow the aim point (what the laser showed), scattered a little; a hit goes to the chest
    const scatter = hit ? 0 : 0.25 + dist * 0.035;
    const to = hit ? _real.clone() : this.aimPoint.clone().add(_spread.set(Math.random() - 0.5, Math.random() - 0.4, Math.random() - 0.5).multiplyScalar(scatter * 2));
    if (hit) target.takeDamage?.(c.damage, this.owner);
    if (dodged) this._dodged = true;

    this.bus.emit('enemyShot', { id: this.owner.id, from: muzzle.clone(), to, hit, targetGhost: !!atGhost, dodged });
    this.bus.emit('noise', { pos: muzzle.clone(), radius: c.noiseRadius, kind: 'enemyShot' });

    let out = 'fired';
    if (this.ammo <= 0 && c.reloadTime) {
      this.startReload();
      out = 'reload';
    } else if (this.burstLeft <= 0) {
      // burst over: rest (longer when the target slipped it: a dodged burst is not retried at once), let someone else shoot
      this.phase = 'pause';
      this.timer = randRange(c.burstPause) * (this._dodged ? (c.dodgedPauseMult ?? 1.5) : 1);
      this._dodged = false;
      this.restUntil = now + this.timer;
      this.owner.squad?.tokens?.release(this.owner, now, c.tokenRest ?? 0.8);
    }
    return out;
  }
}

/**
 * Attack tokens: at most `max` holders at once. A holder that hands its token back waits `rest` seconds before it
 * can ask again, so the turn passes round the squad.
 */
export function createTokens(max = 2) {
  const holders = new Set();
  const rest = new Map();
  return {
    max,
    holders,
    request(owner, now = 0) {
      if (holders.has(owner)) return true;
      for (const h of holders) if (h.dead) holders.delete(h);
      if (holders.size >= this.max) return false;
      if ((rest.get(owner) ?? -Infinity) > now) return false;
      holders.add(owner);
      return true;
    },
    release(owner, now = 0, wait = 0) {
      if (holders.delete(owner) && wait > 0) rest.set(owner, now + wait);
    },
    has(owner) {
      return holders.has(owner);
    },
  };
}
