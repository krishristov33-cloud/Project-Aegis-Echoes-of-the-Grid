// Directorate drone: flies a patrol circuit, scans with a downward sight cone (spotlight),
// spots for the squad (shares confirmed positions continuously), orbits the target at standoff range
// keeping line of sight, fires light bursts, and crashes when destroyed. Not on the navmesh: free 3D steering
// with ray-based obstacle avoidance and altitude hold over the ground.
import * as THREE from 'three';
import { Enemy } from './enemy.js';
import { Perception } from './perception.js';
import { Weapon } from './weapon.js';
import { yawTo, angleDelta, flatDist } from './util.js';

const _desired = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

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
    this.weapon = new Weapon({ owner: this, cfg: o.cfg.weapon, bus: o.bus, los: o.los });
    this.patrol = o.patrol ?? [];
    this.patrolIdx = 0;
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.spotlight = true; // VFX hook: cone light on while true
    this.groundY = this.position.y;
    this._reportT = 0;
    this._groundT = 0;
    this._crashed = false;
    this.position.y = this.groundY + o.cfg.altitude;
  }

  _ground() {
    const p = this.nav.closest(_tmp.set(this.position.x, this.position.y, this.position.z), { x: 3, y: 40, z: 3 });
    if (p) this.groundY = p.y;
    return this.groundY;
  }

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
      altitude = c.minAltitude; // sags, wobbles
      _desired.copy(this.position).setY(this.groundY + altitude);
      _desired.x += Math.sin(now * 17) * 0.6;
      _desired.z += Math.cos(now * 13) * 0.6;
    } else if ((per.state === 'alert' || squadMode === 'engaged') && threat && role.role !== 'search') {
      this.state = 'combat';
      // orbit the target at standoff range; slide faster around the orbit when line of sight is blocked
      this.orbitAngle += dt * (per.canSee ? 0.25 : 0.9);
      _desired.set(threat.x + Math.sin(this.orbitAngle) * c.standoff, this.groundY + altitude, threat.z + Math.cos(this.orbitAngle) * c.standoff);
      firing = (per.canSee || per.fooledByGhost) && flatDist(this.position, threat) < c.weapon.range;
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

    const muzzle = _tmp.copy(this.position).setY(this.position.y - 0.3);
    this.weapon.update(dt, { wantFire: firing && !this.ducked, aimPos: threat, target: player, atGhost: per.fooledByGhost, muzzle, suppression: 0 });
    this.spotlight = !this.ducked;
    this.animState = this.ducked ? 'ducked' : firing ? 'fire' : 'hover';
    this.syncView();
  }

  _turn(target, dt) {
    const d = angleDelta(this.yaw, target);
    const step = this.cfg.turnRate * dt;
    this.yaw += Math.abs(d) < step ? d : Math.sign(d) * step;
  }

  _steerTo(target, dt) {
    const c = this.cfg;
    _steer.subVectors(target, this.position);
    const dist = _steer.length();
    // arrive: slow down inside 3 m
    const speed = c.speed * Math.min(1, dist / 3);
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
    // never sink below min altitude
    if (this.position.y < this.groundY + c.minAltitude) _steer.y += c.acceleration;

    _steer.clampLength(0, c.acceleration);
    this.velocity.addScaledVector(_steer, dt);
    this.velocity.clampLength(0, c.speed);
    this.position.addScaledVector(this.velocity, dt);
  }

  _fall(dt) {
    if (this._crashed) return;
    this.velocity.y -= this.cfg.fallGravity * dt;
    this.position.addScaledVector(this.velocity, dt);
    this.yaw += dt * 6;
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
    if (pos) this.squad?.report(this, pos, true);
  }

  onDeath() {
    this.spotlight = false;
    this.squad?.onMemberDied(this);
  }

  dispose() {
    this.perception.dispose();
  }
}
