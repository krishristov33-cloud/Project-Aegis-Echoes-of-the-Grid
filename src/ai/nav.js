// Navigation: recast/detour navmesh + crowd, wrapped so the rest of the AI never touches recast directly.
// Build once per level from the level's walkable + obstacle meshes:
//   const nav = await createNav(levelMeshes, { agentRadius: 0.4 });
// Requires import-map entries for `recast-navigation` and `@recast-navigation/*` (see tests/ai.html).
import * as THREE from 'three';
import { init, NavMeshQuery, Crowd } from 'recast-navigation';
import { threeToSoloNavMesh, NavMeshHelper } from '@recast-navigation/three';

let initPromise = null;
const ensureInit = () => (initPromise ??= init());

const toV3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

export async function createNav(meshes, opts = {}) {
  await ensureInit();
  const agentRadius = opts.agentRadius ?? 0.4;
  const cs = opts.cellSize ?? 0.2;
  const ch = opts.cellHeight ?? 0.2;
  meshes.forEach((m) => m.updateMatrixWorld(true));
  const { success, navMesh } = threeToSoloNavMesh(meshes, {
    cs,
    ch,
    walkableRadius: Math.ceil(agentRadius / cs),
    walkableHeight: Math.ceil((opts.agentHeight ?? 1.8) / ch),
    walkableClimb: Math.ceil((opts.maxClimb ?? 0.4) / ch),
    walkableSlopeAngle: opts.maxSlope ?? 45,
    ...opts.recast,
  });
  if (!success) throw new Error('nav: navmesh generation failed');

  const query = new NavMeshQuery(navMesh);
  const crowd = new Crowd(navMesh, { maxAgents: opts.maxAgents ?? 32, maxAgentRadius: opts.maxAgentRadius ?? 1.0 });
  const halfExtents = { x: 2, y: 4, z: 2 };

  return {
    navMesh,
    query,
    crowd,

    /** Closest point on the navmesh, or null if nothing within the search box. */
    closest(p, extents = halfExtents) {
      const r = query.findClosestPoint(p, { halfExtents: extents });
      return r.success && r.polyRef ? toV3(r.point) : null;
    },

    /** Straight path (array of Vector3) or [] if unreachable. */
    path(from, to) {
      const r = query.computePath(from, to, { halfExtents });
      return r.success ? r.path.map(toV3) : [];
    },

    /** Path length along the navmesh (Infinity if unreachable). Use sparingly: one computePath per call. */
    pathLength(from, to) {
      const pts = this.path(from, to);
      if (!pts.length) return Infinity;
      let d = 0;
      for (let i = 1; i < pts.length; i++) d += pts[i].distanceTo(pts[i - 1]);
      // computePath ends at the nearest reachable point; treat a big gap as unreachable
      return pts[pts.length - 1].distanceTo(to) > 1.0 ? Infinity : d;
    },

    randomPointAround(center, radius) {
      const r = query.findRandomPointAroundCircle(center, radius, { halfExtents });
      return r.success ? toV3(r.randomPoint) : null;
    },

    addAgent(position, params) {
      const p = this.closest(position) ?? position;
      return crowd.addAgent(p, {
        radius: params.radius ?? agentRadius,
        height: params.height ?? 1.8,
        maxSpeed: params.maxSpeed ?? 3.5,
        maxAcceleration: params.maxAcceleration ?? 8,
        collisionQueryRange: (params.radius ?? agentRadius) * 8,
        pathOptimizationRange: (params.radius ?? agentRadius) * 30,
        separationWeight: params.separationWeight ?? 1.5,
      });
    },

    removeAgent(agent) {
      crowd.removeAgent(agent);
    },

    update(dt) {
      crowd.update(Math.min(dt, 0.1));
    },

    debugObject() {
      const helper = new NavMeshHelper(navMesh, {
        navMeshMaterial: new THREE.MeshBasicMaterial({ color: 0x2bd4a8, transparent: true, opacity: 0.25, depthWrite: false }),
      });
      helper.position.y += 0.03;
      return helper;
    },

    dispose() {
      crowd.destroy?.();
      query.destroy?.();
      navMesh.destroy?.();
    },
  };
}
