// Reads a level out of the physics world (src/core/physics.js API) so the AI needs no per-level wiring:
//  - navmesh input: every solid/ground body as world-space triangles (boxes -> 12 tris, meshes -> their geometry)
//  - cover boxes: solid boxes tall enough to hide behind
//  - line of sight: physics.raycast(..., { solid: true })
// Works with the AABB world on main and with C3's Rapier world, since C3 keeps the same API.
import * as THREE from 'three';

// unit box with three's outward (counter-clockwise) winding, which is what recast expects
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * @param {object} physics   PhysicsWorld (needs .bodies Map of { kind, center, half, min, max, mesh?, userData })
 * @param {object} [o]
 * @param {number} [o.lowCover]  min height of a cover box
 * @returns {{ positions:number[], indices:number[], coverBoxes:THREE.Box3[] }}
 */
export function levelFromPhysics(physics, { lowCover = 0.72 } = {}) {
  const positions = [];
  const indices = [];
  const coverBoxes = [];
  const v = new THREE.Vector3();
  for (const b of physics.bodies.values()) {
    const u = b.userData || {};
    if (u.trigger || !(u.solid || u.ground)) continue;
    if (b.kind === 'mesh' && b.mesh) {
      // ground meshes registered alongside a box (greybox "_mesh" twins) would duplicate the box: skip those
      if (b.mesh.userData?._physId && physics.bodies.has(b.mesh.userData._physId)) continue;
      b.mesh.updateWorldMatrix(true, true);
      b.mesh.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        const pos = o.geometry.attributes.position;
        const base = positions.length / 3;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          positions.push(v.x, v.y, v.z);
        }
        if (o.geometry.index) for (const i of o.geometry.index.array) indices.push(base + i);
        else for (let i = 0; i < pos.count; i++) indices.push(base + i);
      });
      continue;
    }
    if (b.kind !== 'box') continue;
    const { min, max } = b;
    const base = positions.length / 3;
    const up = UNIT_BOX.attributes.position;
    for (let i = 0; i < up.count; i++) {
      positions.push(
        b.center.x + up.getX(i) * b.half.x * 2,
        b.center.y + up.getY(i) * b.half.y * 2,
        b.center.z + up.getZ(i) * b.half.z * 2,
      );
    }
    for (const i of UNIT_BOX.index.array) indices.push(base + i);
    if (u.solid && max.y - min.y >= lowCover) coverBoxes.push(new THREE.Box3(min.clone(), max.clone()));
  }
  return { positions, indices, coverBoxes };
}

/** Line-of-sight tester backed by physics.raycast. Same interface as util.js LineOfSight. */
export class PhysicsLineOfSight {
  constructor(physics) {
    this.physics = physics;
    this.extra = []; // extra occluder meshes (e.g. Wave-Shield columns) tested with a three Raycaster
    this._dir = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this.casts = 0;
  }

  /** Kept for API parity with LineOfSight (drone avoidance). */
  get occluders() {
    return this.extra;
  }

  blocked(from, to) {
    this._dir.subVectors(to, from);
    const dist = this._dir.length();
    if (dist < 1e-4) return false;
    this._dir.divideScalar(dist);
    this.casts++;
    if (this.physics.raycast(from, this._dir, dist - 0.05, { solid: true })) return true;
    if (this.extra.length) {
      this._ray.set(from, this._dir);
      this._ray.far = dist - 0.05;
      if (this._ray.intersectObjects(this.extra, true).length) return true;
    }
    return false;
  }

  /** Ground height under p (navmesh heights are approximate), or null. */
  groundAt(p, up = 1.0, down = 3.0) {
    const h = this.physics.raycast(this._from.set(p.x, p.y + up, p.z), DOWN, up + down, { ground: true });
    return h ? h.point.y : null;
  }

  /** First obstacle along a ray: { distance, normal } or null (drone avoidance). */
  probe(from, dir, maxDist) {
    const h = this.physics.raycast(from, dir, maxDist, { solid: true });
    return h ? { distance: h.distance, normal: h.normal } : null;
  }
}
