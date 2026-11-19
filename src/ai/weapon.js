// Hitscan rifle shared by soldiers and drones: bursts, magazine, reload, reaction time,
// distance / motion / suppression accuracy, cover-aware hits, ghost-decoy misses.
// Emits `enemyShot {id, from, to, hit, targetGhost}` (VFX/audio tracers) and `noise {pos, radius, kind:'enemyShot'}`.
import * as THREE from 'three';
import { randRange, clamp } from './util.js';

const _to = new THREE.Vector3();
const _spread = new THREE.Vector3();
const _chest = new THREE.Vector3();

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
    this.pause = 0;
    this.trackedFor = 0; // seconds the current target has been tracked (reaction time)
  }

  get reloading() {
    return this.reloadLeft > 0;
  }

  startReload() {
    if (this.reloading || this.ammo === this.cfg.magazine || !this.cfg.reloadTime) return false;
    this.reloadLeft = this.cfg.reloadTime;
    return true;
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
   * @returns {'fired'|'reload'|null}
   */
  update(dt, { wantFire, aimPos, target, atGhost, muzzle, suppression = 0 }) {
    const c = this.cfg;
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.ammo = c.magazine;
      return null;
    }
    if (target && target.hp <= 0) wantFire = false; // don't keep shooting a downed player
    this.trackedFor = wantFire ? this.trackedFor + dt : 0;
    this.cooldown -= dt;
    this.pause -= dt;
    if (!wantFire || !aimPos || this.trackedFor < c.reactionTime || this.pause > 0 || this.cooldown > 0) return null;

    if (this.ammo <= 0) return this.startReload() ? 'reload' : null;
    if (this.burstLeft <= 0) this.burstLeft = Math.round(randRange(c.burst));

    this.cooldown = 1 / c.rof;
    this.ammo--;
    this.burstLeft--;
    if (this.burstLeft <= 0) this.pause = randRange(c.burstPause);

    _chest.copy(aimPos).setY(aimPos.y + 1.1);
    const dist = muzzle.distanceTo(_chest);
    let chance = 0;
    if (!atGhost && dist <= c.range) {
      chance = c.accuracyNear + (c.accuracyFar - c.accuracyNear) * clamp(dist / c.range, 0, 1);
      const speed = target.velocity ? Math.hypot(target.velocity.x, target.velocity.z) : 0;
      chance *= 1 - c.movingTargetPenalty * clamp(speed / 6, 0, 1);
      chance *= 1 - c.suppressedPenalty * suppression;
      // the real player must be in line of fire (cover protects)
      const real = _to.copy(target.position).setY(target.position.y + 1.1);
      if (real.distanceTo(_chest) > 1.5 || this.los.blocked(muzzle, real, this.owner.view)) chance = 0;
    }
    const hit = Math.random() < chance;
    const to = hit ? _chest.clone() : _chest.clone().add(_spread.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(1.2 + dist * 0.06));
    if (hit) target.takeDamage?.(c.damage, this.owner);

    this.bus.emit('enemyShot', { id: this.owner.id, from: muzzle.clone(), to, hit, targetGhost: !!atGhost });
    this.bus.emit('noise', { pos: muzzle.clone(), radius: c.noiseRadius, kind: 'enemyShot' });
    if (this.ammo <= 0 && c.reloadTime) {
      this.startReload();
      return 'reload';
    }
    return 'fired';
  }
}
