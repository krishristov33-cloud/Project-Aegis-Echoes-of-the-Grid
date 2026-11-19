// Small shared helpers for the AI modules.
import * as THREE from 'three';

export const rand = (a, b) => a + Math.random() * (b - a);
export const randRange = (pair) => rand(pair[0], pair[1]);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const DEG = Math.PI / 180;

/** Horizontal (XZ) distance. */
export const flatDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Yaw (radians) that faces from `a` to `b` around +Y, with 0 = +Z. */
export const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);

/** Shortest signed angle from `a` to `b`. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Line-of-sight tester against a list of occluder meshes.
 * One Raycaster is shared; `blocked(from, to)` is true if anything sits between the points.
 */
export class LineOfSight {
  constructor(occluders = []) {
    this.occluders = occluders;
    this.ray = new THREE.Raycaster();
    this._dir = new THREE.Vector3();
    this.casts = 0; // per-frame counter for the perf HUD; reset by the owner
  }

  blocked(from, to, ignore = null) {
    this._dir.subVectors(to, from);
    const dist = this._dir.length();
    if (dist < 1e-4) return false;
    this._dir.divideScalar(dist);
    this.ray.set(from, this._dir);
    this.ray.near = 0;
    this.ray.far = dist - 0.05;
    this.casts++;
    const hits = this.ray.intersectObjects(this.occluders, true);
    for (const h of hits) if (h.object !== ignore && h.object.visible !== false) return true;
    return false;
  }
}

let nextId = 1;
export const newId = (prefix) => `${prefix}-${nextId++}`;
