// Perception: sight cone + peripheral vision with line of sight, hearing from bus `noise` events,
// an awareness meter, last-known position, and ghost-decoy belief from bus `blink` events.
//
// Awareness 0..1:   0 unaware   >= suspicious -> "suspicious"   1 -> "alert" (target confirmed)
// Sight raises awareness faster when close and in the centre of the cone; it decays when nothing is seen.
import * as THREE from 'three';
import { DEG, clamp } from './util.js';

const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _aim = new THREE.Vector3();

export class Perception {
  /**
   * @param {object} o
   * @param {object} o.owner      enemy with .position (Vector3), .yaw (radians), optional .pitch
   * @param {object} o.cfg        { sight, hearing, awareness } from enemies.json
   * @param {object} o.bus        event bus with on(type, fn) -> off()
   * @param {LineOfSight} o.los
   * @param {object} o.ghostCfg   { belief } seconds the AI keeps shooting a blink ghost
   */
  constructor({ owner, cfg, bus, los, ghostCfg }) {
    this.owner = owner;
    this.cfg = cfg;
    this.los = los;
    this.ghostBelief = ghostCfg?.belief ?? 2.5;

    this.awareness = 0;
    this.canSee = false; // target visible on the last sight tick
    this.lastKnown = null; // Vector3
    this.lastSeenAt = -Infinity;
    this.lastHeard = null; // { pos, kind, at }
    this.ghost = null; // { pos, until, id } — when set, the AI believes this is the target
    this.sharedAt = -Infinity; // time the squad last shared a position with us

    this._tickEvery = 1 / (cfg.sight.tickHz ?? 10);
    this._tickT = Math.random() * this._tickEvery; // stagger agents across frames
    this._now = 0;

    this._offs = [
      bus.on('noise', (e) => this._onNoise(e)),
      bus.on('blink', (e) => this._onBlink(e)),
    ];
  }

  dispose() {
    this._offs.forEach((off) => off?.());
  }

  get state() {
    if (this.awareness >= 1) return 'alert';
    if (this.awareness >= this.cfg.awareness.suspicious) return 'suspicious';
    return 'unaware';
  }

  /** Where the AI should aim/move: the ghost while it believes it, else the last known position. */
  get believedTarget() {
    if (this.ghost && this._now < this.ghost.until) return this.ghost.pos;
    return this.lastKnown;
  }

  get fooledByGhost() {
    return !!(this.ghost && this._now < this.ghost.until);
  }

  /** Squad comms: another member reports a position. Raises awareness without needing our own sight. */
  share(pos, now, confirmed) {
    this.lastKnown = (this.lastKnown ?? new THREE.Vector3()).copy(pos);
    this.sharedAt = now;
    if (confirmed) this.awareness = Math.max(this.awareness, 1);
    else this.awareness = Math.max(this.awareness, this.cfg.awareness.suspicious + 0.01);
  }

  /** Eye position in world space. */
  eye(out = _eye) {
    return out.copy(this.owner.position).setY(this.owner.position.y + (this.cfg.sight.eyeHeight ?? 1.6));
  }

  /** Can this agent see `point` right now (cone + range + LOS)? Returns 0 (no) or a 0..1 visibility weight. */
  visibility(point) {
    const s = this.cfg.sight;
    const eye = this.eye();
    _to.subVectors(point, eye);
    const dist = _to.length();
    if (dist > s.range) return 0;
    _to.divideScalar(dist || 1);

    const yaw = this.owner.yaw ?? 0;
    const pitch = -(s.pitchDown ?? 0) * DEG;
    _fwd.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const ang = Math.acos(clamp(_fwd.dot(_to), -1, 1));

    const inMain = ang <= (s.fov * DEG) / 2;
    const inPeripheral = !inMain && ang <= (s.peripheralFov * DEG) / 2 && dist <= s.peripheralRange;
    if (!inMain && !inPeripheral) return 0;

    // check the chest and the head so low cover still hides a crouched target but not a standing one
    if (this.los.blocked(eye, point, this.owner.view) && this.los.blocked(eye, _aim.copy(point).setY(point.y + 0.5), this.owner.view)) return 0;

    const distW = 1 - dist / s.range; // 1 close, 0 at max range
    const centreW = inMain ? 1 - ang / ((s.fov * DEG) / 2) * 0.5 : 0.35;
    return clamp(distW * centreW, 0.05, 1);
  }

  /**
   * @param {number} dt
   * @param {number} now     seconds
   * @param {object} target  player-like: { position (feet), velocity?, isHidden? }
   */
  update(dt, now, target) {
    this._now = now;
    const a = this.cfg.awareness;

    this._tickT -= dt;
    if (this._tickT <= 0) {
      this._tickT += this._tickEvery;
      const chest = _aim.copy(target.position).setY(target.position.y + 1.1);
      const vis = target.isHidden ? 0 : this.visibility(chest);
      this._vis = vis;
      this.canSee = vis > 0;
      if (this.canSee) {
        // seeing the real player clears ghost belief once the ghost is stale-ish
        if (this.ghost && now > this.ghost.until - this.ghostBelief * 0.3) this.ghost = null;
        if (!this.ghost) {
          this.lastKnown = (this.lastKnown ?? new THREE.Vector3()).copy(target.position);
          this.lastSeenAt = now;
        }
      }
    }

    if (this.canSee && !this.fooledByGhost) {
      const gain = a.gainFar + (a.gainNear - a.gainFar) * (this._vis ?? 0);
      this.awareness = Math.min(1, this.awareness + gain * dt);
    } else if (now - Math.max(this.lastSeenAt, this.sharedAt) > a.forgetAfter || this.awareness < 1) {
      this.awareness = Math.max(0, this.awareness - a.decay * dt);
    }
    if (this.ghost && now >= this.ghost.until) this.ghost = null;
  }

  _onNoise({ pos, radius, kind }) {
    if (!pos) return;
    if (kind === 'enemyShot' && this.owner.isEnemy) return; // ignore our own side's gunfire as a stimulus
    const r = radius * (this.cfg.hearing.multiplier ?? 1);
    const d = this.owner.position.distanceTo(pos);
    if (d > r) return;
    const strength = 1 - d / r;
    this.lastHeard = { pos: new THREE.Vector3(pos.x, pos.y, pos.z), kind, at: this._now };
    // hearing alone never makes the AI fully alert: it gets it to "suspicious" (or a bit beyond for loud close noises)
    const cap = kind === 'shot' ? 0.95 : 0.75;
    this.awareness = Math.max(this.awareness, Math.min(cap, this.cfg.awareness.suspicious + strength * 0.6));
    if (this.awareness < 1) this.lastKnown = (this.lastKnown ?? new THREE.Vector3()).copy(this.lastHeard.pos);
  }

  _onBlink({ from, ghostId }) {
    // Only agents who were watching the player get fooled: they keep shooting at the ghost frame.
    if (!from || !(this.canSee && this.awareness >= this.cfg.awareness.suspicious)) return;
    this.ghost = { pos: new THREE.Vector3(from.x, from.y, from.z), until: this._now + this.ghostBelief, id: ghostId };
    this.canSee = false;
  }
}
