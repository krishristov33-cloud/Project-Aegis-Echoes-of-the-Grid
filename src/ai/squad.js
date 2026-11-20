// Squad tactics: shared knowledge with comms delay, role assignment (suppress / flank / assault / search),
// and callouts emitted on the bus as `callout {speaker, text, pos, key}`.
import * as THREE from 'three';
import { DEG, pick, yawTo, angleDelta, flatDist } from './util.js';

export class Squad {
  /**
   * @param {object} o
   * @param {object} o.bus
   * @param {object} o.cfg       enemies.json "squad"
   * @param {object} o.strings   strings.json "callouts"
   * @param {object} o.nav       for search points
   * @param {string} [o.name]
   */
  constructor({ bus, cfg, strings, nav, name = 'squad', tokens = null }) {
    this.tokens = tokens; // attack tokens shared by every squad in the level (weapon.js)
    this.bus = bus;
    this.cfg = cfg;
    this.strings = strings;
    this.nav = nav;
    this.name = name;
    this.members = [];
    this.mode = 'idle'; // idle | alert | engaged | search
    this.target = null; // Vector3, squad's best estimate of the player
    this.targetConfirmedAt = -Infinity;
    this.roles = new Map(); // memberId -> { role, flank?: {centre,minAngle,maxAngle,side}, searchPoint? }
    this._pending = []; // delayed comms { at, pos, confirmed, from }
    this._lastCallout = new Map(); // key -> time
    this._roleT = 0;
    this._flankAssignedAt = -Infinity;
    this._searchStartedAt = -Infinity;
    this._now = 0;
  }

  add(member) {
    this.members.push(member);
    member.squad = this;
  }

  remove(member) {
    this.members = this.members.filter((m) => m !== member);
    this.roles.delete(member.id);
  }

  get alive() {
    return this.members.filter((m) => !m.dead);
  }

  roleOf(member) {
    return this.roles.get(member.id) ?? { role: 'none' };
  }

  /** A member reports the player position. Others learn it after the comms delay. */
  report(from, pos, confirmed) {
    const now = this._now;
    if (confirmed) {
      const wasEngaged = this.mode === 'engaged';
      this.target = (this.target ?? new THREE.Vector3()).copy(pos);
      this.targetConfirmedAt = now;
      if (!wasEngaged) {
        this.mode = 'engaged';
        this.say(from, from.kind === 'drone' ? 'droneSpotted' : 'contact', true);
        this._roleT = 0;
      }
    } else if (this.mode === 'idle') {
      this.mode = 'alert';
      this.target = (this.target ?? new THREE.Vector3()).copy(pos);
    }
    this._pending.push({ at: now + this.cfg.commsDelay, pos: pos.clone(), confirmed, from });
  }

  /** Emit a callout line (rate-limited per key unless `force`). */
  say(member, key, force = false) {
    if (!member || member.dead && key !== 'manDown') return;
    const last = this._lastCallout.get(key) ?? -Infinity;
    if (!force && this._now - last < this.cfg.calloutCooldown) return;
    const lines = this.strings[key];
    if (!lines?.length) return;
    this._lastCallout.set(key, this._now);
    this.bus.emit('callout', { speaker: member.id, text: pick(lines), pos: member.position.clone(), key });
  }

  onMemberDied(member) {
    const witness = this.alive.find((m) => m !== member && m.position.distanceTo(member.position) < 25);
    if (witness) this.say(witness, member.kind === 'drone' ? 'droneDown' : 'manDown', true);
    this.roles.delete(member.id);
    this.tokens?.release(member);
    this._roleT = 0;
  }

  update(dt, now) {
    this._now = now;
    // deliver delayed comms
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const msg = this._pending[i];
      if (msg.at > now) continue;
      this._pending.splice(i, 1);
      for (const m of this.alive) if (m !== msg.from) m.perception.share(msg.pos, now, msg.confirmed);
    }

    const alive = this.alive;
    if (!alive.length) return;

    if (this.mode === 'engaged') {
      const anySees = alive.some((m) => m.perception.canSee && !m.perception.fooledByGhost);
      if (!anySees && now - this.targetConfirmedAt > 3) {
        this.say(alive[0], 'lostVisual');
        this._startSearch(now);
      }
    } else if (this.mode === 'search') {
      if (now - this._searchStartedAt > this.cfg.searchDuration) {
        this.mode = 'idle';
        this.roles.clear();
        this.say(alive[0], 'allClear');
      }
    } else if (this.mode === 'alert' && alive.every((m) => m.perception.state === 'unaware')) {
      this.mode = 'idle';
    }

    this._roleT -= dt;
    if (this.mode === 'engaged' && this._roleT <= 0) {
      this._roleT = 1.0;
      this._assignCombatRoles(now);
    }
  }

  _assignCombatRoles(now) {
    const target = this.target;
    if (!target) return;
    const fighters = this.alive.filter((m) => m.kind === 'soldier');
    const prev = this.roles;
    this.roles = new Map();
    for (const d of this.alive.filter((m) => m.kind === 'drone')) this.roles.set(d.id, { role: 'spot' });

    // suppressors: members that currently see the target, closest first
    const seers = fighters.filter((m) => m.perception.canSee).sort((a, b) => a.position.distanceTo(target) - b.position.distanceTo(target));
    const suppressors = seers.slice(0, this.cfg.maxSuppressors);
    for (const s of suppressors) {
      this.roles.set(s.id, { role: 'suppress' });
      if (prev.get(s.id)?.role !== 'suppress') this.say(s, 'suppressing');
    }

    // flanker: keep the current one unless it is stale, otherwise choose the non-suppressor best placed to swing round
    const remaining = fighters.filter((m) => !this.roles.has(m.id));
    let flanker = remaining.find((m) => prev.get(m.id)?.role === 'flank');
    const stale = now - this._flankAssignedAt > this.cfg.flankRetarget;
    if ((!flanker || stale) && fighters.length >= this.cfg.flankMinMembers && remaining.length) {
      // pick the remaining member whose bearing from the target differs most from the suppressors' bearing
      const centre = this._bearing(suppressors.length ? suppressors : fighters, target);
      remaining.sort((a, b) => Math.abs(angleDelta(centre, yawTo(target, b.position))) - Math.abs(angleDelta(centre, yawTo(target, a.position))));
      flanker = remaining[0];
      this._flankAssignedAt = now;
      const side = angleDelta(centre, yawTo(target, flanker.position)) >= 0 ? 'Left' : 'Right';
      this.roles.set(flanker.id, {
        role: 'flank',
        flank: { centre, minAngle: this.cfg.flankMinAngle * DEG, maxAngle: this.cfg.flankMaxAngle * DEG, side },
      });
      const prevFlank = prev.get(flanker.id)?.flank;
      if (!prevFlank || prevFlank.side !== side) this.say(flanker, `flank${side}`, true);
    } else if (flanker) {
      this.roles.set(flanker.id, prev.get(flanker.id));
    }

    for (const m of fighters) if (!this.roles.has(m.id)) this.roles.set(m.id, { role: 'assault' });
  }

  _bearing(members, target) {
    let x = 0;
    let z = 0;
    for (const m of members) {
      const y = yawTo(target, m.position);
      x += Math.sin(y);
      z += Math.cos(y);
    }
    return Math.atan2(x, z);
  }

  _startSearch(now) {
    this.mode = 'search';
    this._searchStartedAt = now;
    this.roles = new Map();
    const centre = this.target;
    const fighters = this.alive;
    const pts = [];
    for (let i = 0; i < this.cfg.searchPoints; i++) {
      const p = this.nav.randomPointAround(centre, this.cfg.searchRadius);
      if (p) pts.push(p);
    }
    // nearest unassigned point per member; the first goes straight to the last known position
    fighters.forEach((m, i) => {
      if (m.kind === 'drone') {
        this.roles.set(m.id, { role: 'search', searchPoint: centre.clone() });
        return;
      }
      let best = i === 0 ? centre.clone() : null;
      if (!best) {
        let bd = Infinity;
        let bi = -1;
        pts.forEach((p, j) => {
          const d = flatDist(p, m.position);
          if (d < bd) [bd, bi] = [d, j];
        });
        if (bi >= 0) best = pts.splice(bi, 1)[0];
      }
      this.roles.set(m.id, { role: 'search', searchPoint: best ?? centre.clone(), extra: pts });
    });
    this.say(fighters[0], 'search');
  }
}
