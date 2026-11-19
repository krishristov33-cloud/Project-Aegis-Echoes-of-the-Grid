import * as THREE from 'three';

/**
 * Narrow collider API for the world.
 * L1–L4 use an AABB + mesh-raycast implementation.
 * C3 should replace the internals with Rapier and keep these method names
 * and hit shapes so the controller, camera and vault checks stay unchanged:
 *
 *   addBox({ id, center, halfExtents, userData })
 *   addMesh(id, mesh, userData)
 *   remove(id)
 *   raycast(origin, dir, maxDist, filter) -> Hit | null
 *   moveCapsule(pos, disp, radius, height, filter) -> MoveResult
 *   overlapCapsule(pos, radius, height, filter) -> Hit[]
 *
 * Hit: { point:Vector3, normal:Vector3, distance:number, id, userData }
 * userData flags: { solid, ground, vaultable, trigger, layer }
 * filter: { excludeIds?:string[], solid?:boolean, ground?:boolean, groups?:string[] }
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ray = new THREE.Raycaster();

function aabbFromCenterHalf(center, half) {
  return {
    min: new THREE.Vector3(center.x - half.x, center.y - half.y, center.z - half.z),
    max: new THREE.Vector3(center.x + half.x, center.y + half.y, center.z + half.z),
  };
}

function passFilter(body, filter) {
  if (!filter) return true;
  if (filter.excludeIds && filter.excludeIds.includes(body.id)) return false;
  const u = body.userData || {};
  if (filter.solid && !u.solid && !u.ground) return false;
  if (filter.ground && !u.ground) return false;
  if (filter.vaultable && !u.vaultable) return false;
  if (filter.groups && !filter.groups.includes(u.layer)) return false;
  return true;
}

export class PhysicsWorld {
  constructor() {
    this.bodies = new Map();
    this._meshList = [];
    this._groundMeshes = [];
    this._id = 0;
  }

  _uid(id) { return id || ('col_' + (++this._id)); }

  addBox({ id, center, halfExtents, userData = {} } = {}) {
    id = this._uid(id);
    const c = center.clone ? center.clone() : new THREE.Vector3(center.x, center.y, center.z);
    const h = halfExtents.clone ? halfExtents.clone() : new THREE.Vector3(halfExtents.x, halfExtents.y, halfExtents.z);
    const { min, max } = aabbFromCenterHalf(c, h);
    const body = { id, kind: 'box', center: c, half: h, min, max, userData };
    this.bodies.set(id, body);
    return id;
  }

  /** Register a render mesh for raycasts (ramps, uneven ground). */
  addMesh(id, mesh, userData = {}) {
    id = this._uid(id);
    mesh.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const body = { id, kind: 'mesh', mesh, center, half, min: box.min.clone(), max: box.max.clone(), userData };
    this.bodies.set(id, body);
    this._meshList.push(body);
    if (userData.ground) this._groundMeshes.push(mesh);
    return id;
  }

  remove(id) {
    const b = this.bodies.get(id); if (!b) return;
    this.bodies.delete(id);
    this._meshList = this._meshList.filter((x) => x.id !== id);
    if (b.mesh) this._groundMeshes = this._groundMeshes.filter((m) => m !== b.mesh);
  }

  raycast(origin, dir, maxDist = 10, filter) {
    // Mesh raycasts first (accurate for ramps), then AABB fallback.
    _ray.set(origin, dir.clone().normalize());
    _ray.far = maxDist;
    const meshes = [];
    for (const b of this.bodies.values()) {
      if (!passFilter(b, filter)) continue;
      if (b.mesh) meshes.push(b.mesh);
    }
    if (meshes.length) {
      const hits = _ray.intersectObjects(meshes, true);
      if (hits.length) {
        const h = hits[0];
        let body = null;
        for (const b of this._meshList) {
          if (h.object === b.mesh || (b.mesh && b.mesh.getObjectById?.(h.object.id)) || ancestorHas(h.object, b.mesh)) { body = b; break; }
        }
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() : new THREE.Vector3(0, 1, 0);
        return { point: h.point.clone(), normal: n, distance: h.distance, id: body?.id, userData: body?.userData || {} };
      }
    }
    // AABB slab raycast for boxes without meshes
    let best = null, bestT = maxDist;
    const d = dir.clone().normalize();
    const inv = new THREE.Vector3(d.x !== 0 ? 1 / d.x : Infinity, d.y !== 0 ? 1 / d.y : Infinity, d.z !== 0 ? 1 / d.z : Infinity);
    for (const b of this.bodies.values()) {
      if (b.kind !== 'box' || !passFilter(b, filter)) continue;
      const t = rayAabb(origin, inv, b.min, b.max);
      if (t !== null && t >= 0 && t < bestT) {
        bestT = t;
        const point = origin.clone().addScaledVector(d, t);
        const normal = aabbNormal(point, b.min, b.max);
        best = { point, normal, distance: t, id: b.id, userData: b.userData || {} };
      }
    }
    return best;
  }

  overlapCapsule(pos, radius, height, filter) {
    const feetY = pos.y, topY = pos.y + height;
    const hits = [];
    for (const b of this.bodies.values()) {
      if (!passFilter(b, filter)) continue;
      const closest = closestOnAabb(_v.set(pos.x, clamp(pos.y + height * 0.5, b.min.y, b.max.y), pos.z), b.min, b.max);
      // distance from capsule segment (pos.y+r .. pos.y+h-r)
      const y0 = feetY + radius, y1 = topY - radius;
      const cy = clamp(closest.y, y0, y1);
      const dx = closest.x - pos.x, dy = closest.y - cy, dz = closest.z - pos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < radius - 1e-5) {
        const n = dist > 1e-6 ? _n.set(dx, dy, dz).multiplyScalar(-1 / dist).clone() : new THREE.Vector3(0, 1, 0);
        hits.push({ point: closest.clone(), normal: n, distance: dist, id: b.id, userData: b.userData || {} });
      }
    }
    return hits;
  }

  /**
   * Move a vertical capsule (feet at pos, total height, radius).
   * Returns { position, grounded, groundNormal, groundId, blocked, hit }.
   */
  moveCapsule(pos, disp, radius, height, filter = { solid: true }) {
    const out = pos.clone();
    const step = filter.stepHeight ?? 0.38;
    let blocked = false;
    let hit = null;

    // Horizontal first
    out.x += disp.x; out.z += disp.z;
    const resolved = this._resolveXZ(out, radius, height, filter);
    if (resolved.blocked) { blocked = true; hit = resolved.hit; out.copy(resolved.pos); }

    // Ground probe
    const probeFrom = new THREE.Vector3(out.x, out.y + Math.max(height * 0.55, step + radius + 0.05), out.z);
    const maxDist = height * 0.55 + Math.max(0, -disp.y) + step + 0.8;
    const gh = this.raycast(probeFrom, new THREE.Vector3(0, -1, 0), maxDist, { ground: true });
    let grounded = false;
    let groundNormal = new THREE.Vector3(0, 1, 0);
    let groundId = null;
    const vy = disp.y;
    if (gh) {
      const gy = gh.point.y;
      const n = gh.normal;
      const slopeOk = n.y >= Math.cos((filter.maxSlopeDeg ?? 50) * Math.PI / 180);
      const goingDown = vy <= 0.01;
      if (slopeOk && goingDown && gy <= out.y + step && gy >= out.y - 0.15 - Math.max(0, -vy)) {
        out.y = gy;
        grounded = true;
        groundNormal = n;
        groundId = gh.id;
      } else if (!goingDown) {
        // rising, leave y integration to caller unless we bonked a ceiling
        out.y += vy;
        const ceil = this.raycast(new THREE.Vector3(out.x, out.y + height - radius, out.z), new THREE.Vector3(0, 1, 0), radius + 0.1, { solid: true });
        if (ceil) { out.y = Math.min(out.y, ceil.point.y - height); }
      } else {
        out.y += vy;
      }
    } else {
      out.y += vy;
    }

    // Final solid separation (don't sink into walls)
    const sep = this._resolveXZ(out, radius, height, filter);
    if (sep.blocked) { out.copy(sep.pos); blocked = true; hit = sep.hit; }

    return { position: out, grounded, groundNormal, groundId, blocked, hit };
  }

  _resolveXZ(pos, radius, height, filter) {
    const p = pos.clone();
    let blocked = false, hit = null;
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      for (const b of this.bodies.values()) {
        if (!b.userData?.solid || !passFilter(b, filter)) continue;
        // 2D XZ overlap against AABB expanded by radius, ignoring top if we are standing on it
        const y0 = p.y + radius * 0.5, y1 = p.y + height - radius;
        if (y1 < b.min.y || y0 > b.max.y) continue;
        // If this is a ground we are clearly on top of, skip side push
        if (b.userData.ground && p.y >= b.max.y - 0.08 && p.y <= b.max.y + 0.5) continue;
        const cx = clamp(p.x, b.min.x, b.max.x);
        const cz = clamp(p.z, b.min.z, b.max.z);
        let dx = p.x - cx, dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < radius * radius) {
          const d = Math.sqrt(d2);
          if (d < 1e-6) {
            // push out toward nearest face
            const left = p.x - b.min.x, right = b.max.x - p.x, near = p.z - b.min.z, far = b.max.z - p.z;
            const m = Math.min(left, right, near, far);
            if (m === left) dx = -1, dz = 0;
            else if (m === right) dx = 1, dz = 0;
            else if (m === near) dx = 0, dz = -1;
            else dx = 0, dz = 1;
            p.x += dx * (radius + 0.002);
            p.z += dz * (radius + 0.002);
          } else {
            const push = (radius - d + 0.002) / d;
            p.x += dx * push; p.z += dz * push;
          }
          pushed = true; blocked = true;
          hit = { id: b.id, userData: b.userData, point: new THREE.Vector3(cx, clamp(p.y + 0.8, b.min.y, b.max.y), cz), normal: new THREE.Vector3(dx, 0, dz).normalize() };
        }
      }
      if (!pushed) break;
    }
    return { pos: p, blocked, hit };
  }

  /** Forward vault probe: low ray hits a vaultable, high ray is clear, landing exists. */
  findVault(origin, dir, radius, height, vault) {
    const fwd = dir.clone().setY(0).normalize();
    if (fwd.lengthSq() < 1e-6) return null;
    const minH = vault.minHeight ?? 0.45, maxH = vault.height ?? 1.15, depth = vault.depth ?? 1.5;
    const low = this.raycast(origin.clone().setY(origin.y + minH + 0.1), fwd, 1.15, { solid: true });
    if (!low || !low.userData?.vaultable) return null;
    if (low.distance > 1.1) return null;
    const high = this.raycast(origin.clone().setY(origin.y + maxH + 0.15), fwd, 1.2, { solid: true });
    if (high && high.distance < low.distance + 0.4) return null;
    // landing on the far side or on top
    const over = origin.clone().addScaledVector(fwd, low.distance + radius + 0.55);
    const top = this.raycast(over.clone().setY(origin.y + maxH + 0.4), new THREE.Vector3(0, -1, 0), maxH + 1.2, { ground: true });
    if (!top) return null;
    if (top.point.y - origin.y > maxH) return null;
    // prefer the far side if the obstacle is shallow
    const far = origin.clone().addScaledVector(fwd, low.distance + Math.min(depth, estimateDepth(low, fwd) + radius + 0.35));
    const land = this.raycast(far.clone().setY(origin.y + maxH + 0.5), new THREE.Vector3(0, -1, 0), maxH + 1.6, { ground: true });
    const landing = (land && Math.abs(land.point.y - origin.y) < 0.7) ? land.point : top.point.clone().addScaledVector(fwd, 0.15);
    return { hit: low, landing: landing.clone(), height: top.point.y - origin.y };
  }
}

function estimateDepth(hit, fwd) {
  const u = hit.userData || {};
  return 0.9;
}

function ancestorHas(obj, root) {
  let o = obj;
  while (o) { if (o === root) return true; o = o.parent; }
  return false;
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function closestOnAabb(p, min, max) {
  return new THREE.Vector3(clamp(p.x, min.x, max.x), clamp(p.y, min.y, max.y), clamp(p.z, min.z, max.z));
}

function rayAabb(origin, inv, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (const a of ['x', 'y', 'z']) {
    const t1 = (min[a] - origin[a]) * inv[a];
    const t2 = (max[a] - origin[a]) * inv[a];
    const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
    tmin = Math.max(tmin, lo); tmax = Math.min(tmax, hi);
    if (tmax < tmin) return null;
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
}

function aabbNormal(p, min, max) {
  const dx = Math.min(Math.abs(p.x - min.x), Math.abs(p.x - max.x));
  const dy = Math.min(Math.abs(p.y - min.y), Math.abs(p.y - max.y));
  const dz = Math.min(Math.abs(p.z - min.z), Math.abs(p.z - max.z));
  const m = Math.min(dx, dy, dz);
  if (m === dy) return new THREE.Vector3(0, p.y < (min.y + max.y) * 0.5 ? -1 : 1, 0);
  if (m === dx) return new THREE.Vector3(p.x < (min.x + max.x) * 0.5 ? -1 : 1, 0, 0);
  return new THREE.Vector3(0, 0, p.z < (min.z + max.z) * 0.5 ? -1 : 1);
}
