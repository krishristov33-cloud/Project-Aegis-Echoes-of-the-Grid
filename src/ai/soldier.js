// Directorate soldier: patrol -> investigate -> combat (cover / peek / suppress / flank / advance) -> search.
// Movement runs on the detour crowd; the squad hands out roles; the weapon resolves shots.
import * as THREE from 'three';
import { Enemy } from './enemy.js';
import { Perception } from './perception.js';
import { Weapon } from './weapon.js';
import { randRange, yawTo, angleDelta, flatDist } from './util.js';

const _muzzle = new THREE.Vector3();

export class Soldier extends Enemy {
  /**
   * @param {object} o
   * @param {object} o.bus, o.nav, o.cover, o.los
   * @param {object} o.cfg          enemies.json "soldier"
   * @param {object} o.ghostCfg     enemies.json "ghost"
   * @param {Vector3} o.position
   * @param {Vector3[]} [o.patrol]  patrol route
   * @param {Object3D} [o.view]
   */
  constructor(o) {
    super({ kind: 'soldier', bus: o.bus, cfg: o.cfg, view: o.view, position: o.position });
    this.nav = o.nav;
    this.cover = o.cover;
    this.los = o.los;
    this.perception = new Perception({ owner: this, cfg: o.cfg, bus: o.bus, los: o.los, ghostCfg: o.ghostCfg });
    this.weapon = new Weapon({ owner: this, cfg: o.cfg.weapon, bus: o.bus, los: o.los });
    this.agent = this.nav.addAgent(this.position, {
      radius: o.cfg.radius,
      height: o.cfg.height,
      maxSpeed: o.cfg.walkSpeed,
      maxAcceleration: o.cfg.acceleration,
    });
    this.patrol = o.patrol ?? [];
    this.patrolIdx = 0;
    this.yaw = o.yaw ?? 0;
    this.crouched = false;
    this.suppression = 0;
    this.combat = 'seekCover'; // seekCover | moving | hide | peek | advance
    this.coverPoint = null;
    this.timer = 0;
    this.moveTarget = null;
    this.hitTimer = 0;
    this._reportT = 0;
    this._lastAwState = 'unaware';
    this._lookYaw = null;
    this._coverCheckT = 0;
    this._searchIdx = 0;
    this._badCover = new Set(); // cover points with no view of the target; cleared when the target moves on
    this._blindPeeks = 0;
    this._peekSaw = false;
    this._offs = [o.bus.on('noise', (e) => this._onNoise(e))];
  }

  // ---------- movement helpers ----------
  moveTo(p, run) {
    this.agent.maxSpeed = run ? this.cfg.runSpeed : this.cfg.walkSpeed;
    const snapped = this.nav.closest(p) ?? p;
    if (!this.moveTarget || this.moveTarget.distanceTo(snapped) > 0.3) {
      this.agent.requestMoveTarget(snapped);
      this.moveTarget = snapped.clone();
    }
  }

  stop() {
    if (this.moveTarget) {
      this.agent.resetMoveTarget();
      this.moveTarget = null;
    }
  }

  arrived(eps = 0.6) {
    return !this.moveTarget || flatDist(this.position, this.moveTarget) < eps;
  }

  faceTowards(p, dt) {
    if (!p) return;
    this._turn(yawTo(this.position, p), dt);
  }

  _turn(target, dt) {
    const d = angleDelta(this.yaw, target);
    const step = this.cfg.turnRate * dt;
    this.yaw += Math.abs(d) < step ? d : Math.sign(d) * step;
  }

  // ---------- main tick ----------
  update(dt, now, player) {
    this.now = now;
    if (this.dead) return;

    const ap = this.agent.position();
    this.position.set(ap.x, ap.y, ap.z);
    const v = this.agent.velocity();
    this.velocity.set(v.x, v.y, v.z);

    const per = this.perception;
    per.update(dt, now, player);
    this.suppression = Math.max(0, this.suppression - this.cfg.suppressionDecay * dt);
    this.hitTimer -= dt;
    this._report(dt, now);

    if (this.ducked) {
      this.state = 'ducked';
      this.animState = 'ducked';
      this.stop();
      this.syncView();
      return;
    }

    const role = this.squad?.roleOf(this) ?? { role: 'none' };
    const squadMode = this.squad?.mode ?? 'idle';
    let next;
    if (per.state === 'alert' || squadMode === 'engaged') next = role.role === 'search' ? 'search' : 'combat';
    else if (role.role === 'search') next = 'search';
    else if (per.state === 'suspicious') next = 'investigate';
    else next = 'patrol';
    if (next !== this.state) this._enter(next);

    let firing = false;
    if (this.state === 'patrol') this._patrol(dt);
    else if (this.state === 'investigate') this._investigate(dt);
    else if (this.state === 'search') this._search(dt, role);
    else if (this.state === 'combat') firing = this._combat(dt, player, role);

    // weapon
    const aim = per.believedTarget ?? this.squad?.target;
    _muzzle.copy(this.position).setY(this.position.y + (this.crouched ? 1.0 : 1.4));
    _muzzle.x += Math.sin(this.yaw) * 0.4;
    _muzzle.z += Math.cos(this.yaw) * 0.4;
    const shot = this.weapon.update(dt, { wantFire: firing, aimPos: aim, target: player, atGhost: per.fooledByGhost, muzzle: _muzzle, suppression: this.suppression });
    if (shot === 'reload') this.squad?.say(this, 'reloading');

    // facing: look where we move unless fighting from a spot
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.state === 'combat' && (firing || this.combat === 'hide' || speed < 0.5)) this.faceTowards(aim, dt);
    else if (speed > 0.3) this._turn(Math.atan2(this.velocity.x, this.velocity.z), dt);
    else if (this._lookYaw !== null) this._turn(this._lookYaw, dt);

    this.animState = this._anim(speed, firing);
    this.syncView();
  }

  _anim(speed, firing) {
    if (this.hitTimer > 0) return 'hit';
    if (this.weapon.reloading) return this.crouched ? 'crouchReload' : 'reload';
    if (firing) return this.crouched ? 'crouchFire' : 'fire';
    if (speed > this.cfg.walkSpeed + 0.4) return 'run';
    if (speed > 0.3) return this.state === 'combat' ? 'aimWalk' : 'walk';
    if (this.crouched) return 'crouch';
    return this.state === 'combat' ? 'aim' : 'idle';
  }

  _enter(state) {
    const prev = this.state;
    this.state = state;
    this.timer = 0;
    this.crouched = false;
    this._lookYaw = null;
    if (state !== 'combat') {
      this.cover.release(this.id);
      this.coverPoint = null;
    }
    if (state === 'combat') this.combat = 'seekCover';
    if (state === 'investigate' && prev === 'patrol') this.squad?.say(this, 'heard');
    if (state === 'search') this._searchIdx = 0;
    this.stop();
  }

  _report(dt, now) {
    const per = this.perception;
    const s = per.state;
    this._reportT -= dt;
    if (per.canSee && !per.fooledByGhost && s === 'alert' && this._reportT <= 0) {
      this._reportT = 0.5;
      this.squad?.report(this, per.lastKnown, true);
    } else if (s === 'suspicious' && this._lastAwState === 'unaware' && per.lastKnown) {
      this.squad?.report(this, per.lastKnown, false);
    }
    this._lastAwState = s;
  }

  // ---------- states ----------
  _patrol(dt) {
    if (!this.patrol.length) {
      // idle sentry: slowly scan left/right
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = randRange(this.cfg.patrol.waitTime);
        this._lookYaw = this.yaw + (Math.random() - 0.5) * 2.0;
      }
      return;
    }
    if (this.timer > 0) {
      this.timer -= dt;
      return;
    }
    const wp = this.patrol[this.patrolIdx];
    this.moveTo(wp, false);
    if (this.arrived(0.5)) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
      this.timer = randRange(this.cfg.patrol.waitTime);
      this._lookYaw = this.yaw + (Math.random() - 0.5) * 1.5;
      this.stop();
    }
  }

  _investigate(dt) {
    const p = this.perception.lastKnown;
    if (!p) return;
    if (this.timer === 0 && !this.arrived(1.2)) {
      this.moveTo(p, false);
      return;
    }
    if (this.timer === 0) {
      this.squad?.say(this, 'investigate');
      this.stop();
    }
    this.timer += dt;
    // look around while at the spot
    this._lookYaw = this.yaw + Math.sin(this.timer * 1.3) * 0.8;
  }

  _search(dt, role) {
    const pts = [role.searchPoint, ...(role.extra ?? [])].filter(Boolean);
    const p = pts[this._searchIdx % Math.max(1, pts.length)];
    if (!p) return;
    if (this.timer > 0) {
      this.timer -= dt;
      this._lookYaw = this.yaw + Math.sin(this.timer * 2) * 0.9;
      if (this.timer <= 0) this._searchIdx++;
      return;
    }
    this.moveTo(p, false);
    if (this.arrived(0.8)) {
      this.stop();
      this.timer = this.cfg.investigate.lookTime;
    }
  }

  /** @returns {boolean} wants to fire this frame */
  _combat(dt, player, role) {
    const per = this.perception;
    const threat = per.believedTarget ?? this.squad?.target;
    if (!threat) return false;
    const cc = this.cfg.cover;
    this.timer -= dt;
    this._coverCheckT -= dt;
    const seesTarget = per.canSee || per.fooledByGhost;

    // cover compromised? (target moved round it) -> find new cover
    if (this.coverPoint && this._coverCheckT <= 0 && (this.combat === 'hide' || this.combat === 'peek')) {
      this._coverCheckT = 1.0;
      if (!this.cover.protects(this.coverPoint, threat)) {
        this.squad?.say(this, 'moving');
        this.combat = 'seekCover';
      }
    }
    // a new flank order replaces the current position
    if (role.role === 'flank' && this._flankOrder !== role.flank) {
      this._flankOrder = role.flank;
      this.combat = 'seekCover';
    }

    switch (this.combat) {
      case 'seekCover': {
        const flank = role.role === 'flank' ? role.flank : null;
        const avoid = (this.squad?.alive ?? []).filter((m) => m !== this).map((m) => m.position);
        const point = this.cover.find({
          from: this.position,
          threat,
          agentId: this.id,
          searchRadius: flank ? cc.searchRadius * 1.6 : cc.searchRadius,
          preferredMin: cc.preferredMin,
          preferredMax: cc.preferredMax,
          flank,
          avoid,
          exclude: this._badCover,
        });
        if (point) {
          this.cover.claim(point, this.id);
          this.coverPoint = point;
          this.moveTo(point.pos, true);
          this.combat = 'moving';
        } else {
          this.cover.release(this.id);
          this.coverPoint = null;
          this.combat = 'advance';
          this.timer = 2.5;
        }
        return false;
      }
      case 'moving': {
        this.crouched = false;
        // shoot on the move only when suppressing and we can see the target
        if (this.arrived(0.5)) {
          this.stop();
          this.combat = 'hide';
          this.timer = randRange(cc.hideTime) * 0.5;
        }
        return role.role === 'suppress' && seesTarget && flatDist(this.position, threat) < this.cfg.weapon.range * 0.6;
      }
      case 'hide': {
        this.crouched = true;
        if (this.weapon.reloading) {
          this.timer = Math.max(this.timer, 0.2);
          return false;
        }
        if (this.timer <= 0) {
          this.combat = 'peek';
          this._peekSaw = false;
          const peek = randRange(cc.peekTime);
          this.timer = role.role === 'suppress' ? peek * 1.6 : peek;
        }
        return false;
      }
      case 'peek': {
        this.crouched = false; // stand up over low cover / lean out of high cover to shoot
        const suppressing = role.role === 'suppress';
        if (seesTarget) this._peekSaw = true;
        if (this.timer <= 0 && !this._peekSaw && ++this._blindPeeks >= 2) {
          // two peeks without a view of the target: this spot is useless, relocate
          this._blindPeeks = 0;
          if (this.coverPoint) this._badCover.add(this.coverPoint);
          if (this._badCover.size > 8) this._badCover.clear();
          this.squad?.say(this, 'moving');
          this.combat = 'seekCover';
          return false;
        }
        if (this._peekSaw) this._blindPeeks = 0;
        if (this.timer <= 0 || this.weapon.reloading || this.suppression > 0.7) {
          this.combat = 'hide';
          this.timer = this.suppression > 0.7 ? cc.suppressedHideTime + randRange(cc.hideTime) : randRange(cc.hideTime);
          return false;
        }
        // suppressors keep firing at the last known spot even without a clear view
        return seesTarget || (suppressing && per.lastKnown && this.now - per.lastSeenAt < 4);
      }
      case 'advance': {
        // no cover available: push to a spot inside the preferred range and fight standing
        const d = flatDist(this.position, threat);
        if (!seesTarget || d > cc.preferredMax) this.moveTo(threat, true);
        else this.stop();
        if (this.timer <= 0) this.combat = 'seekCover';
        return seesTarget && d < this.cfg.weapon.range;
      }
    }
    return false;
  }

  // ---------- reactions ----------
  onHurt(n, src) {
    this.hitTimer = 0.25;
    this.suppression = Math.min(1, this.suppression + 0.35);
    const pos = src?.position;
    if (pos) {
      this.perception.share(pos, this.now, true);
      this.squad?.report(this, pos, true);
    }
    if (this.combat === 'peek') {
      this.combat = 'hide';
      this.timer = this.cfg.cover.suppressedHideTime;
    }
  }

  onDucked() {
    if (Math.random() < 0.5) this.squad?.say(this, 'ducked');
  }

  onDeath() {
    this.cover.release(this.id);
    this.nav.removeAgent(this.agent);
    this.squad?.onMemberDied(this);
    this.syncView();
  }

  _onNoise({ pos, kind }) {
    if (this.dead || !pos || kind === 'enemyShot') return;
    // player gunfire / sub-bass close by suppresses
    if ((kind === 'shot' || kind === 'subBass') && this.position.distanceTo(pos) < 6) this.suppression = Math.min(1, this.suppression + 0.25);
  }

  dispose() {
    this._offs.forEach((off) => off?.());
    this.perception.dispose();
    if (!this.dead) this.nav.removeAgent(this.agent);
  }
}
