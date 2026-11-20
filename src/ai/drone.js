// Directorate drone: flies a patrol circuit, scans with a downward sight cone (spotlight), spots for the squad
// (shares confirmed positions continuously) and orbits the target at standoff range keeping line of sight.
// Not on the navmesh: free 3D steering with ray-based obstacle avoidance and altitude hold over the ground.
//
// Attack (cfg.dive): a beat-telegraphed DIVE the player can read and sidestep.
//   orbit --(every `everyBeats`, on a beat, target in sight)--> WINDUP: stops, rears up, glows, for `windupBeats`
//     (`enemyTelegraph {kind:'dive', time}`), tracking the player
//   on the commit beat the dive LINE is locked onto where the player stands right then (`enemyAttack {kind:'dive',
//     from, to}`) and never corrected: move off the line and it misses
//   after the pass it RECOVERS low over the ground for `recoverTime`, sluggish and taking `vulnerableMult` damage.
// With `dive.keepGun` (or no dive block) it also fires light bursts from weapon.js.
import * as THREE from 'three';
import { Enemy } from './enemy.js';
import { Perception } from './perception.js';
import { Weapon } from './weapon.js';
import { yawTo, angleDelta, flatDist, clamp } from './util.js';

const _desired = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _chest = new THREE.Vector3();

export class Drone extends Enemy {
  /**
   * @param {object} o
   * @param {object} o.bus, o.nav, o.los
   * @param {object} o.cfg        enemies.json "drone"
   * @param {object} o.ghostCfg
   * @param {Vector3} o.position
   * @param {Vector3[]} [o.patrol] circuit points (y ignored; altitude from cfg)
   * @param {Object3D} [o.view]
   */
  constructor(o) {
    super({ kind: 'drone', bus: o.bus, cfg: o.cfg, view: o.view, position: o.position });
    this.nav = o.nav;
    this.los = o.los;
    this.perception = new Perception({ owner: this, cfg: o.cfg, bus: o.bus, los: o.los, ghostCfg: o.ghostCfg });
    const D = o.cfg.dive;
    this.weapon = !D || D.keepGun ? new Weapon({ owner: this, cfg: o.cfg.weapon, bus: o.bus, los: o.los }) : null;
    this.patrol = o.patrol ?? [];
    this.patrolIdx = 0;
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.spotlight = true; // VFX hook: cone light on while true
    this.groundY = this.position.y;
    this._reportT = 0;
    this._groundT = 0;
    this._crashed = false;
    this.position.y = this.groundY + o.cfg.altitude;
    // dive attack
    this.dive = null; // { phase:'windup'|'dive'|'recover', t, dur, from, to, dir, hit }
    this._beatsSinceDive = Math.floor(Math.random() * 3);
    this._beatDur = 60 / 174;
    this.hitSeq = 0;
    this.lastHit = null;
    // visual attitude (view layer / syncView)
    this.bank = 0;
    this.tilt = 0;
    this._bobT = Math.random() * 10;
    this._prevVel = new THREE.Vector3();
    this._yawRate = 0;
    this._offs = [o.bus.on('beat', (b) => this._onBeat(b))];
  }

  _ground() {
    const p = this.nav.closest(_tmp.set(this.position.x, this.position.y, this.position.z), { x: 3, y: 40, z: 3 });
    if (p) this.groundY = p.y;
    return this.groundY;
  }

  // ---------- dive ----------
  _onBeat(b) {
    if (b?.bpm) this._beatDur = 60 / b.bpm;
    const D = this.cfg.dive;
    if (!D || this.dead) return;
    if (this.dive?.phase === 'windup') {
      if (--this.dive.beats <= 0) this._commitDive();
      return;
    }
    if (this.dive || this.ducked || this.state !== 'combat') return;
    this._beatsSinceDive++;
    const pl = this.target;
    const per = this.perception;
    if (this._beatsSinceDive < D.everyBeats || !pl || pl.hp <= 0 || !per.canSee || per.fooledByGhost) return;
    if (flatDist(this.position, pl.position) > D.maxRange) return;
    this._beatsSinceDive = 0;
    const time = D.windupBeats * this._beatDur;
    this.dive = { phase: 'windup', beats: D.windupBeats, t: 0, dur: time };
    this.bus.emit('enemyTelegraph', { id: this.id, kind: 'dive', pos: this.position.clone(), time, target: pl.position.clone() });
  }

  _commitDive() {
    const D = this.cfg.dive;
    const pl = this.target;
    if (!pl || pl.hp <= 0) {
      this.dive = null;
      return;
    }
    const from = this.position.clone();
    const aim = pl.position.clone().setY(pl.position.y + D.aimHeight);
    const dir = aim.clone().sub(from);
    const len = dir.length();
    if (len < 0.5) {
      this.dive = null;
      return;
    }
    dir.divideScalar(len);
    // fly through the locked point and a little past it, but never into the floor
    const to = aim.clone().addScaledVector(dir, D.overshoot);
    to.y = Math.max(to.y, pl.position.y + D.minPassHeight);
    const total = from.distanceTo(to);
    this.dive = { phase: 'dive', t: 0, dur: total / D.speed, from, to, dir: to.clone().sub(from).normalize(), hit: false };
    this.bus.emit('enemyAttack', { id: this.id, kind: 'dive', from: from.clone(), to: to.clone(), time: this.dive.dur });
    this.bus.emit('noise', { pos: from.clone(), radius: 14, kind: 'droneDive' });
  }

  _diveTick(dt, player) {
    const D = this.cfg.dive;
    const d = this.dive;
    d.t += dt;
    if (d.phase === 'windup') {
      // hold position, rear up, keep the nose on the target
      _desired.copy(this.position);
      _desired.y = this.groundY + this.cfg.altitude + D.windupRise;
      this._steerTo(_desired, dt, 0.6);
      this._turn(yawTo(this.position, player.position), dt * 2.5);
      return;
    }
    if (d.phase === 'dive') {
      const step = D.speed * dt;
      const blocked = this.los.probe(this.position, d.dir, step + this.cfg.radius);
      this.velocity.copy(d.dir).multiplyScalar(D.speed);
      if (!blocked) this.position.addScaledVector(d.dir, step);
      this.yaw = Math.atan2(d.dir.x, d.dir.z);
      if (!d.hit && player.hp > 0) {
        _chest.copy(player.position).setY(player.position.y + D.aimHeight);
        if (_chest.distanceTo(this.position) <= D.hitRadius) {
          d.hit = true;
          const dealt = player.takeDamage?.(D.damage, this);
          if (dealt) player.applyImpulse?.(new THREE.Vector3(d.dir.x * D.push, D.pushUp, d.dir.z * D.push));
        }
      }
      if (d.t >= d.dur || blocked) {
        this.dive = { phase: 'recover', t: 0, dur: D.recoverTime };
        this.velocity.multiplyScalar(0.15);
        this.bus.emit('noise', { pos: this.position.clone(), radius: 10, kind: 'droneRecover' });
      }
      return;
    }
    // recover: wallow low, easy to hit
    _desired.copy(this.position);
    _desired.y = this.groundY + D.recoverAltitude;
    _desired.x += Math.sin(this.now * 9) * 0.35;
    _desired.z += Math.cos(this.now * 7) * 0.35;
    this._steerTo(_desired, dt, 0.45);
    if (d.t >= d.dur) this.dive = null;
  }

  /** While recovering from a dive the drone is exposed. */
  takeDamage(n, src) {
    const mult = this.dive?.phase === 'recover' ? (this.cfg.dive?.vulnerableMult ?? 1) : 1;
    return super.takeDamage(n * mult, src);
  }

  // ---------- main tick ----------
  update(dt, now, player) {
    this.now = now;
    this.target = player;
    const c = this.cfg;
    if (this.knockback.lengthSq() > 0.01) {
      this.velocity.add(this.knockback);
      this.knockback.set(0, 0, 0);
    }
    if (this.dead) {
      this._fall(dt);
      return;
    }
    this._groundT -= dt;
    if (this._groundT <= 0) {
      this._groundT = 0.25;
      this._ground();
    }
    const yaw0 = this.yaw;
    this._prevVel.copy(this.velocity);

    const per = this.perception;
    if (!this.ducked) per.update(dt, now, player);
    this._reportT -= dt;
    if (per.canSee && !per.fooledByGhost && per.state === 'alert' && this._reportT <= 0) {
      this._reportT = c.spotShareInterval;
      this.squad?.report(this, per.lastKnown, true);
    }

    const squadMode = this.squad?.mode ?? 'idle';
    const role = this.squad?.roleOf(this) ?? { role: 'none' };
    const threat = per.believedTarget ?? this.squad?.target;
    let altitude = c.altitude;
    let firing = false;

    if (this.ducked) {
      this.state = 'ducked';
      if (this.dive?.phase === 'windup') this.dive = null; // stunned out of the wind-up
      altitude = c.minAltitude; // sags, wobbles
      _desired.copy(this.position).setY(this.groundY + altitude);
      _desired.x += Math.sin(now * 17) * 0.6;
      _desired.z += Math.cos(now * 13) * 0.6;
      if (this.dive?.phase !== 'dive') this._steerTo(_desired, dt);
    } else if (this.dive) {
      this.state = 'combat';
      this._diveTick(dt, player);
    } else {
      if ((per.state === 'alert' || squadMode === 'engaged') && threat && role.role !== 'search') {
        this.state = 'combat';
        // orbit the target at standoff range; slide faster around the orbit when line of sight is blocked
        this.orbitAngle += dt * (per.canSee ? 0.25 : 0.9);
        _desired.set(threat.x + Math.sin(this.orbitAngle) * c.standoff, this.groundY + altitude, threat.z + Math.cos(this.orbitAngle) * c.standoff);
        firing = !!this.weapon && (per.canSee || per.fooledByGhost) && flatDist(this.position, threat) < c.weapon.range;
      } else if (role.role === 'search' && role.searchPoint) {
        this.state = 'search';
        this.orbitAngle += dt * 0.5;
        _desired.set(role.searchPoint.x + Math.sin(this.orbitAngle) * 5, this.groundY + altitude, role.searchPoint.z + Math.cos(this.orbitAngle) * 5);
      } else if (per.state === 'suspicious' && per.lastKnown) {
        this.state = 'investigate';
        _desired.copy(per.lastKnown).setY(this.groundY + altitude);
      } else {
        this.state = 'patrol';
        const wp = this.patrol[this.patrolIdx];
        if (wp) {
          _desired.set(wp.x, this.groundY + altitude, wp.z);
          if (flatDist(this.position, wp) < 1.5) this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
        } else _desired.copy(this.position).setY(this.groundY + altitude);
      }
      this._steerTo(_desired, dt);
      // face: target while fighting, else direction of travel
      if (this.state === 'combat' && threat) this._turn(yawTo(this.position, threat), dt);
      else if (Math.hypot(this.velocity.x, this.velocity.z) > 0.5) this._turn(Math.atan2(this.velocity.x, this.velocity.z), dt);
    }

    if (this.weapon) {
      const muzzle = _tmp.copy(this.position).setY(this.position.y - 0.3);
      this.weapon.update(dt, { wantFire: firing && !this.ducked && !this.dive, aimPos: threat, target: player, atGhost: per.fooledByGhost, muzzle, suppression: 0 });
    }
    this.spotlight = !this.ducked;
    const phase = this.dive?.phase;
    this.animState = this.ducked ? 'ducked' : phase === 'windup' ? 'diveWindup' : phase === 'dive' ? 'dive' : phase === 'recover' ? 'recover' : firing ? 'fire' : 'hover';
    this._attitude(dt, yaw0);
    this.syncView();
  }

  /** Banking into turns, pitching with acceleration, hover bob: read by syncView. */
  _attitude(dt, yaw0) {
    const V = this.cfg.visual ?? {};
    const inv = 1 / Math.max(dt, 1e-4);
    this._yawRate += (angleDelta(yaw0, this.yaw) * inv - this._yawRate) * Math.min(1, dt * 8);
    // acceleration in the drone's own frame
    const ax = (this.velocity.x - this._prevVel.x) * inv;
    const az = (this.velocity.z - this._prevVel.z) * inv;
    const s = Math.sin(this.yaw);
    const co = Math.cos(this.yaw);
    const fwdAcc = ax * s + az * co;
    const sideAcc = ax * co - az * s;
    const fwdVel = this.velocity.x * s + this.velocity.z * co;
    let bankT = clamp(-this._yawRate * (V.bankPerYawRate ?? 0.25) - sideAcc * (V.bankPerAccel ?? 0.03), -0.7, 0.7);
    let tiltT = clamp(fwdAcc * (V.tiltPerAccel ?? 0.03) + fwdVel * (V.tiltPerSpeed ?? 0.035), -0.6, 0.6);
    const phase = this.dive?.phase;
    if (phase === 'windup') tiltT = -(V.windupTilt ?? 0.5) * clamp(this.dive.t / Math.max(0.05, this.dive.dur), 0, 1);
    else if (phase === 'dive') tiltT = Math.asin(clamp(-this.dive.dir.y, -1, 1));
    else if (phase === 'recover' || this.ducked) {
      bankT += Math.sin(this.now * 11) * 0.25;
      tiltT += Math.cos(this.now * 8) * 0.18;
    }
    const k = Math.min(1, dt * (phase === 'dive' ? 18 : 6));
    this.bank += (bankT - this.bank) * k;
    this.tilt += (tiltT - this.tilt) * k;
    this._bobT += dt;
  }

  syncView() {
    if (!this.view) return;
    const V = this.cfg.visual ?? {};
    const calm = this.dive?.phase === 'dive' ? 0 : 1;
    this.view.position.copy(this.position);
    this.view.position.y += Math.sin(this._bobT * (V.bobHz ?? 0.9) * Math.PI * 2) * (V.bobAmp ?? 0.12) * calm;
    this.view.rotation.order = 'YXZ';
    this.view.rotation.set(this.dead ? this.view.rotation.x : this.tilt, this.yaw, this.dead ? this.view.rotation.z : this.bank);
  }

  _turn(target, dt) {
    const d = angleDelta(this.yaw, target);
    const step = this.cfg.turnRate * dt;
    this.yaw += Math.abs(d) < step ? d : Math.sign(d) * step;
  }

  _steerTo(target, dt, speedScale = 1) {
    const c = this.cfg;
    _steer.subVectors(target, this.position);
    const dist = _steer.length();
    // arrive: slow down inside 3 m
    const speed = c.speed * speedScale * Math.min(1, dist / 3);
    _steer.setLength(speed).sub(this.velocity);

    // obstacle avoidance: probe along the velocity
    const v = this.velocity.length();
    if (v > 0.2) {
      _dir.copy(this.velocity).divideScalar(v);
      const hit = this.los.probe(this.position, _dir, c.avoidDistance + v * 0.5);
      if (hit) {
        const n = hit.normal ?? _dir.clone().negate();
        _steer.addScaledVector(n, c.acceleration * 1.5);
        _steer.y += c.acceleration * 0.5; // prefer climbing over things
      }
    }
    // never sink below min altitude (except when wallowing after a dive)
    const floor = this.dive?.phase === 'recover' ? (c.dive?.recoverAltitude ?? 1) * 0.7 : c.minAltitude;
    if (this.position.y < this.groundY + floor) _steer.y += c.acceleration;

    _steer.clampLength(0, c.acceleration * (this.dive?.phase === 'recover' ? 1.6 : 1));
    this.velocity.addScaledVector(_steer, dt);
    this.velocity.clampLength(0, Math.max(c.speed, v * (1 - 3 * dt)));
    this.position.addScaledVector(this.velocity, dt);
  }

  _fall(dt) {
    if (this._crashed) return;
    this.velocity.y -= this.cfg.fallGravity * dt;
    this.position.addScaledVector(this.velocity, dt);
    this.yaw += dt * 6;
    if (this.view) {
      this.view.rotation.x += dt * 4;
      this.view.rotation.z += dt * 2.5;
    }
    if (this.position.y <= this.groundY + 0.2) {
      this.position.y = this.groundY + 0.2;
      this._crashed = true;
      this.velocity.set(0, 0, 0);
      this.bus.emit('noise', { pos: this.position.clone(), radius: 20, kind: 'crash' });
    }
    this.syncView();
  }

  onHurt(n, src) {
    const pos = this.sourcePosition(src);
    if (pos) {
      this.squad?.report(this, pos, true);
      // knocked away from the blow
      const H = this.cfg.hit ?? {};
      _tmp.set(this.position.x - pos.x, 0, this.position.z - pos.z);
      if (_tmp.lengthSq() > 1e-4) this.velocity.addScaledVector(_tmp.normalize(), Math.min(H.knockbackMax ?? 7, n * (H.knockbackPerDamage ?? 0.25)));
    }
    if (this.dive?.phase === 'windup') {
      this.dive = null; // hit out of the wind-up
      this._beatsSinceDive = 0;
    }
    this.lastHit = { amount: n, onBeat: !!src?.onBeat };
    this.hitSeq++;
  }

  onDeath(src) {
    this.spotlight = false;
    this.dive = null;
    this.lastHit = { amount: this.hpMax, fatal: true };
    this.hitSeq++;
    const pos = this.sourcePosition(src);
    if (pos) {
      _tmp.set(this.position.x - pos.x, 0, this.position.z - pos.z);
      if (_tmp.lengthSq() > 1e-4) this.velocity.addScaledVector(_tmp.normalize(), 5);
    }
    this.velocity.y = Math.max(this.velocity.y, 2.5);
    this.squad?.onMemberDied(this);
  }

  dispose() {
    this._offs.forEach((off) => off?.());
    this.perception.dispose();
  }
}
