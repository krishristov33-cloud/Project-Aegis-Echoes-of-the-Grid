// Cover-point generation and queries.
// Generation: walk the footprint (world AABB) of every cover mesh, drop a point every `spacing` metres
// just outside each face, snap it to the navmesh, and record the face normal + cover height (low/high).
// Queries score candidates against a threat; LOS is verified with a raycast for the best few only.
import * as THREE from 'three';
import { flatDist } from './util.js';

const _box = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class CoverSystem {
  /**
   * @param {object} o
   * @param {object} o.nav      from createNav()
   * @param {LineOfSight} o.los
   * @param {object} o.cfg      enemies.json "cover"
   */
  constructor({ nav, los, cfg }) {
    this.nav = nav;
    this.los = los;
    this.cfg = cfg;
    this.points = []; // { id, pos, normal, height: 'low'|'high', claimedBy }
  }

  /** Generate points around these obstacles (THREE.Box3 or Object3D: crates, walls, AC units...). Call once per level. */
  generate(items) {
    const { spacing, offset, lowHeight, highHeight, snapMax } = this.cfg;
    for (const item of items) {
      if (item.isBox3) _box.copy(item);
      else {
        item.updateMatrixWorld(true);
        _box.setFromObject(item);
      }
      const h = _box.max.y - _box.min.y;
      if (h < lowHeight * 0.8) continue; // too short to hide behind
      const height = h >= highHeight ? 'high' : 'low';
      const y = _box.min.y;
      const faces = [
        // [start corner, end corner, outward normal]
        [[_box.min.x, _box.min.z], [_box.max.x, _box.min.z], [0, -1]],
        [[_box.max.x, _box.min.z], [_box.max.x, _box.max.z], [1, 0]],
        [[_box.max.x, _box.max.z], [_box.min.x, _box.max.z], [0, 1]],
        [[_box.min.x, _box.max.z], [_box.min.x, _box.min.z], [-1, 0]],
      ];
      for (const [s, e, n] of faces) {
        const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
        const count = Math.max(1, Math.floor(len / spacing));
        for (let i = 0; i < count; i++) {
          const t = (i + 0.5) / count;
          const raw = new THREE.Vector3(s[0] + (e[0] - s[0]) * t + n[0] * offset, y, s[1] + (e[1] - s[1]) * t + n[1] * offset);
          const snapped = this.nav.closest(raw, { x: snapMax, y: 2, z: snapMax });
          if (!snapped || flatDist(snapped, raw) > snapMax) continue;
          this.points.push({
            id: this.points.length,
            pos: snapped,
            normal: new THREE.Vector3(n[0], 0, n[1]),
            height,
            claimedBy: null,
          });
        }
      }
    }
    return this.points;
  }

  /** True if an obstacle sits between the threat and a body at this cover point. */
  protects(point, threatPos) {
    // threat must be on the obstacle side of the point
    _a.subVectors(threatPos, point.pos).setY(0).normalize();
    if (_a.dot(point.normal) > -0.25) return false;
    const bodyY = point.height === 'low' ? 0.7 : 1.3; // crouched behind low, standing behind high
    _a.copy(point.pos).setY(point.pos.y + bodyY);
    _b.copy(threatPos).setY(threatPos.y + 1.2);
    return this.los.blocked(_b, _a);
  }

  /** Can someone at this point lean out and see the threat? (peek check: offset sideways / stand up) */
  canPeek(point, threatPos) {
    _b.copy(threatPos).setY(threatPos.y + 1.2);
    if (point.height === 'low') {
      _a.copy(point.pos).setY(point.pos.y + 1.6);
      return !this.los.blocked(_a, _b);
    }
    const side = new THREE.Vector3(-point.normal.z, 0, point.normal.x);
    for (const s of [1, -1]) {
      _a.copy(point.pos).addScaledVector(side, s * 0.9).setY(point.pos.y + 1.5);
      if (!this.los.blocked(_a, _b)) return true;
    }
    return false;
  }

  claim(point, agentId) {
    this.release(agentId);
    if (point) point.claimedBy = agentId;
  }

  release(agentId) {
    for (const p of this.points) if (p.claimedBy === agentId) p.claimedBy = null;
  }

  /**
   * Best cover for `agent` against `threatPos`.
   * @param {object} q
   * @param {Vector3} q.from        agent position
   * @param {Vector3} q.threat      threat position (feet)
   * @param {string}  q.agentId
   * @param {number}  q.searchRadius
   * @param {number}  q.preferredMin / preferredMax distance band to the threat
   * @param {object}  [q.flank]     { centre yaw (radians, threat->point), minAngle, maxAngle (radians) }
   * @param {boolean} [q.needPeek=true] the point must allow shooting from it
   * @param {Array<Vector3>} [q.avoid] positions of squadmates to spread from
   * @param {Set} [q.exclude]       points this agent gave up on (no view of the target from there)
   */
  find(q) {
    const cands = [];
    for (const p of this.points) {
      if (p.claimedBy && p.claimedBy !== q.agentId) continue;
      if (q.exclude?.has(p)) continue;
      const dAgent = flatDist(p.pos, q.from);
      if (dAgent > q.searchRadius) continue;
      const dThreat = flatDist(p.pos, q.threat);
      if (dThreat < 3) continue;
      _a.subVectors(q.threat, p.pos).setY(0).normalize();
      if (_a.dot(p.normal) > -0.25) continue; // wrong side of the obstacle

      let score = dAgent * 1.0;
      if (dThreat < q.preferredMin) score += (q.preferredMin - dThreat) * 3;
      if (dThreat > q.preferredMax) score += (dThreat - q.preferredMax) * 1.5;
      if (p.height === 'high') score -= 1.5;
      if (q.flank) {
        const ang = Math.atan2(p.pos.x - q.threat.x, p.pos.z - q.threat.z);
        let d = Math.abs(((ang - q.flank.centre + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < q.flank.minAngle || d > q.flank.maxAngle) continue;
        score -= 2;
      }
      if (q.avoid) for (const o of q.avoid) score += Math.max(0, 3 - flatDist(o, p.pos)) * 2;
      // don't run *towards* the threat to reach cover
      if (dAgent > 1 && flatDist(q.from, q.threat) - dThreat > dAgent * 0.7) score += 4;
      cands.push({ p, score });
    }
    cands.sort((x, y) => x.score - y.score);
    // verify the best few with raycasts (expensive). Prefer cover you can shoot from; fall back to cover that only hides.
    let blind = null;
    for (let i = 0; i < Math.min(12, cands.length); i++) {
      const p = cands[i].p;
      if (!this.reachable(q.from, p)) continue; // e.g. on another roof: the agent would just pile up at the edge
      if (!this.protects(p, q.threat)) continue;
      if (q.needPeek === false || this.canPeek(p, q.threat)) return p;
      blind ??= p;
    }
    return blind;
  }

  /** Can an agent standing at `from` walk to cover point `p`? (the navmesh path must end at the point) */
  reachable(from, p) {
    if (!this.nav?.path) return true;
    const path = this.nav.path(from, p.pos);
    if (!path.length) return false;
    const end = path[path.length - 1];
    return Math.hypot(end.x - p.pos.x, end.z - p.pos.z) < 0.9 && Math.abs(end.y - p.pos.y) < 1.2;
  }

  debugObject() {
    const geo = new THREE.SphereGeometry(0.12, 6, 4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, this.points.length));
    const m = new THREE.Matrix4();
    const lowC = new THREE.Color(0xffc040);
    const highC = new THREE.Color(0x40a0ff);
    this.points.forEach((p, i) => {
      m.makeTranslation(p.pos.x, p.pos.y + 0.12, p.pos.z);
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, p.height === 'low' ? lowC : highC);
    });
    inst.count = this.points.length;
    this._debug = inst;
    return inst;
  }

  /** Recolour claimed points (debug view). */
  updateDebug() {
    if (!this._debug) return;
    const claimed = new THREE.Color(0xff3060);
    const lowC = new THREE.Color(0xffc040);
    const highC = new THREE.Color(0x40a0ff);
    this.points.forEach((p, i) => this._debug.setColorAt(i, p.claimedBy ? claimed : p.height === 'low' ? lowC : highC));
    this._debug.instanceColor.needsUpdate = true;
  }
}
