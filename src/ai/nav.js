// Navigation: recast/detour navmesh + crowd, wrapped so the rest of the AI never touches recast directly.
//   const nav = await createNav({ positions, indices }, { agentRadius: 0.4 });
// Geometry comes from level-geometry.js (built from the physics world), so any level works.
//
// recast-navigation is loaded from jsDelivr's `+esm` bundles (exact version) so index.html's import map
// needs no change. If Lumen would rather map it, swap these two URLs for bare specifiers.
import * as THREE from 'three';
import { init, NavMeshQuery, Crowd, getNavMeshPositionsAndIndices } from 'https://cdn.jsdelivr.net/npm/@recast-navigation/core@0.43.1/+esm';
import { generateSoloNavMesh } from 'https://cdn.jsdelivr.net/npm/@recast-navigation/generators@0.43.1/+esm';

let initPromise = null;
const ensureInit = () => (initPromise ??= init());

const toV3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

/**
 * @param {{positions: ArrayLike<number>, indices: ArrayLike<number>}} geo  world-space triangle soup
 * @param {object} opts  agentRadius, agentHeight, maxClimb, maxSlope, cellSize, cellHeight, maxAgents
 */
export async function createNav(geo, opts = {}) {
  await ensureInit();
  const agentRadius = opts.agentRadius ?? 0.4;
  const cs = opts.cellSize ?? 0.15;
  const ch = opts.cellHeight ?? 0.1;
  const { success, navMesh } = generateSoloNavMesh(geo.positions, geo.indices, {
    cs,
    ch,
    walkableRadius: Math.ceil(agentRadius / cs),
    walkableHeight: Math.ceil((opts.agentHeight ?? 1.8) / ch),
    walkableClimb: Math.ceil((opts.maxClimb ?? 0.35) / ch),
    walkableSlopeAngle: opts.maxSlope ?? 40,
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

    /** Translucent mesh of the navmesh for debug views. */
    debugObject() {
      const [positions, indices] = getNavMeshPositionsAndIndices(navMesh);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setIndex(indices);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x2bd4a8, transparent: true, opacity: 0.25, depthWrite: false }));
      m.position.y = 0.03;
      m.renderOrder = 2;
      return m;
    },

    dispose() {
      crowd.destroy?.();
      query.destroy?.();
      navMesh.destroy?.();
    },
  };
}
