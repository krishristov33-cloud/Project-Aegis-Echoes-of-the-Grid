// C3: Rapier under the L1 collider API. `RapierWorld` extends core's PhysicsWorld, keeps its body bookkeeping
// (`bodies`, ids, userData flags, hit shapes, findVault) and replaces the queries and movement with Rapier:
//
//   addBox / addMesh / remove           -> fixed Rapier colliders (cuboid / trimesh), same ids + userData
//   raycast(origin, dir, maxDist, filter)-> Rapier ray, same { point, normal, distance, id, userData } hit
//   overlapCapsule(pos, r, h, filter)   -> Rapier shape intersection, same Hit[]
//   moveCapsule(pos, disp, r, h, filter)-> Rapier KinematicCharacterController (slopes, steps, ground snap, sliding)
//
// Swap in main.js:  `await initRapier(); const physics = new RapierWorld();`  (nothing else changes).
// Extras the powers / boss use: dynamic + kinematic boxes, capsule casts, collision layers, step(dt).
//
// Layers come from userData: solid/ground -> STATIC, thin solid walls -> PHASEABLE (or userData.phaseable),
// trigger -> sensor, userData.layer 'shield' | 'prop' | 'enemy' for the extras.
import * as THREE from 'three';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs';
import { PhysicsWorld } from '../core/physics.js';

export const LAYER = {
  STATIC: 0x0001,
  PHASEABLE: 0x0002,
  TRIGGER: 0x0004,
  PROP: 0x0008,
  SHIELD: 0x0010,
  ENEMY: 0x0020,
  PLAYER: 0x0040,
  ALL: 0xffff,
};
const groups = (membership, filter = LAYER.ALL) => ((membership & 0xffff) << 16) | (filter & 0xffff);

let initPromise = null;
/** Load the Rapier wasm once. Await before constructing a RapierWorld. */
export const initRapier = () => (initPromise ??= RAPIER.init());

const DEFAULTS = { gravity: -24, stepHz: 60, maxPhaseThickness: 0.7, kccOffset: 0.01 };

/** Same rules as core/physics.js passFilter (kept local: core does not export it). */
function passFilter(body, filter) {
  if (!filter) return true;
  if (filter.excludeIds && filter.excludeIds.includes(body.id)) return false;
  const u = body.userData || {};
  if (filter.solid && !u.solid && !u.ground) return false;
  if (filter.ground && !u.ground) return false;
  if (filter.vaultable && !u.vaultable) return false;
  if (filter.groups && !filter.groups.includes(u.layer)) return false;
  if (filter.predicate && !filter.predicate(body)) return false;
  return true;
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();

export class RapierWorld extends PhysicsWorld {
  constructor(opts = {}) {
    super();
    if (!initPromise) throw new Error('RapierWorld: await initRapier() first');
    this.cfg = { ...DEFAULTS, ...opts };
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: this.cfg.gravity, z: 0 });
    this.world.timestep = 1 / this.cfg.stepHz;
    this._byHandle = new Map(); // collider handle -> body record
    this._dynamic = []; // { body, rb, mesh }
    this._capsules = new Map(); // "r|h" -> { collider, kcc }
    this._acc = 0;
  }

  // ---------- registration ----------
  _layerFor(u, size) {
    if (u.trigger) return LAYER.TRIGGER;
    if (u.layer === 'shield') return LAYER.SHIELD;
    if (u.layer === 'prop') return LAYER.PROP;
    if (u.layer === 'enemy') return LAYER.ENEMY;
    const thin = size && Math.min(size.x, size.z) <= this.cfg.maxPhaseThickness && size.y > 1.0 && !u.ground;
    if (u.phaseable ?? thin) return LAYER.PHASEABLE;
    return LAYER.STATIC;
  }

  _attach(rec, desc, rbDesc = RAPIER.RigidBodyDesc.fixed()) {
    const u = rec.userData || {};
    const size = rec.half ? new THREE.Vector3().copy(rec.half).multiplyScalar(2) : null;
    const layer = this._layerFor(u, size);
    rec.layer = layer;
    if (layer === LAYER.PHASEABLE) u.phaseable = true;
    desc.setCollisionGroups(groups(layer));
    if (u.trigger) desc.setSensor(true);
    const rb = this.world.createRigidBody(rbDesc);
    rec.rb = rb;
    rec.collider = this.world.createCollider(desc, rb);
    this._byHandle.set(rec.collider.handle, rec);
    return rec;
  }

  addBox(opts = {}) {
    const id = super.addBox(opts);
    const rec = this.bodies.get(id);
    const desc = RAPIER.ColliderDesc.cuboid(rec.half.x, rec.half.y, rec.half.z).setTranslation(rec.center.x, rec.center.y, rec.center.z);
    this._attach(rec, desc);
    return id;
  }

  addMesh(id, mesh, userData = {}) {
    id = super.addMesh(id, mesh, userData);
    const rec = this.bodies.get(id);
    // greybox registers a mesh "twin" for ground boxes so three raycasts hit the same surface: Rapier already has the box
    if (mesh.userData?._physId && this.bodies.get(mesh.userData._physId)?.collider) return id;
    const pos = [];
    const idx = [];
    mesh.updateWorldMatrix(true, true);
    mesh.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const p = o.geometry.attributes.position;
      const base = pos.length / 3;
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        pos.push(_v.x, _v.y, _v.z);
      }
      if (o.geometry.index) for (const i of o.geometry.index.array) idx.push(base + i);
      else for (let i = 0; i < p.count; i++) idx.push(base + i);
    });
    if (!idx.length) return id;
    this._attach(rec, RAPIER.ColliderDesc.trimesh(new Float32Array(pos), new Uint32Array(idx)));
    return id;
  }

  remove(id) {
    const rec = this.bodies.get(id);
    if (rec?.rb) {
      this._byHandle.delete(rec.collider.handle);
      this.world.removeRigidBody(rec.rb);
      const di = this._dynamic.findIndex((d) => d.rec === rec);
      if (di >= 0) this._dynamic.splice(di, 1);
    }
    super.remove(id);
  }

  /**
   * Dynamic box (floor chunks, crates). Registered like addBox so raycasts/AI see it; `mesh` follows the body.
   * @returns {string} id
   */
  addDynamicBox({ id, center, halfExtents, mass = 20, userData = { solid: true, layer: 'prop' }, mesh = null, velocity = null }) {
    id = this._uid(id);
    const c = new THREE.Vector3().copy(center);
    const h = new THREE.Vector3().copy(halfExtents);
    const rec = { id, kind: 'box', center: c, half: h, min: c.clone().sub(h), max: c.clone().add(h), userData, dynamic: true };
    this.bodies.set(id, rec);
    const rbDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, c.y, c.z).setCcdEnabled(true);
    if (velocity) rbDesc.setLinvel(velocity.x, velocity.y, velocity.z);
    this._attach(rec, RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z).setMass(mass).setFriction(0.8), rbDesc);
    this._dynamic.push({ rec, mesh });
    return id;
  }

  /** Kinematic box moved by code (Wave-Shield columns, moving platforms). */
  addKinematicBox({ id, center, halfExtents, rotation = null, userData = { solid: true, layer: 'shield' } }) {
    id = this._uid(id);
    const c = new THREE.Vector3().copy(center);
    const h = new THREE.Vector3().copy(halfExtents);
    const rec = { id, kind: 'box', center: c, half: h, min: c.clone().sub(h), max: c.clone().add(h), userData, kinematic: true };
    this.bodies.set(id, rec);
    const rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(c.x, c.y, c.z);
    if (rotation) rbDesc.setRotation(rotation);
    this._attach(rec, RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z), rbDesc);
    return id;
  }

  /** Move a kinematic box; keeps the AABB bookkeeping (AI cover, findVault) in step. */
  moveKinematic(id, center) {
    const rec = this.bodies.get(id);
    if (!rec?.rb) return;
    rec.rb.setNextKinematicTranslation({ x: center.x, y: center.y, z: center.z });
    rec.rb.setTranslation({ x: center.x, y: center.y, z: center.z }, false); // queries this frame see the new spot
    rec.center.copy(center);
    rec.min.copy(center).sub(rec.half);
    rec.max.copy(center).add(rec.half);
  }

  applyImpulse(id, v) {
    this.bodies.get(id)?.rb?.applyImpulse({ x: v.x, y: v.y, z: v.z }, true);
  }

  // ---------- queries ----------
  _predicate(filter) {
    return (col) => {
      const rec = this._byHandle.get(col.handle);
      return !!rec && passFilter(rec, filter); // passFilter(rec, undefined) is true; unknown colliders (movement probes) never match a query
    };
  }

  _hit(rec, point, normal, distance) {
    return { point, normal, distance, id: rec?.id, userData: rec?.userData || {} };
  }

  raycast(origin, dir, maxDist = 10, filter) {
    const d = dir.clone().normalize();
    const ray = new RAPIER.Ray(origin, d);
    // solid=false: a ray starting inside a shape reports where it leaves it (same as the AABB slab test)
    const h = this.world.castRayAndGetNormal(ray, maxDist, false, undefined, undefined, undefined, undefined, this._predicate(filter));
    if (!h) return null;
    const rec = this._byHandle.get(h.collider.handle);
    const t = h.timeOfImpact;
    return this._hit(rec, origin.clone().addScaledVector(d, t), new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z), t);
  }

  overlapCapsule(pos, radius, height, filter) {
    const half = Math.max(0.01, height / 2 - radius);
    const center = { x: pos.x, y: pos.y + height / 2, z: pos.z };
    const hits = [];
    this.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(half, radius), (col) => {
      const rec = this._byHandle.get(col.handle);
      if (!rec) return true;
      const cp = new THREE.Vector3(clamp(pos.x, rec.min.x, rec.max.x), clamp(center.y, rec.min.y, rec.max.y), clamp(pos.z, rec.min.z, rec.max.z));
      const n = new THREE.Vector3(pos.x - cp.x, 0, pos.z - cp.z);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      else n.normalize();
      hits.push(this._hit(rec, cp, n, n.length()));
      return true;
    }, undefined, undefined, undefined, undefined, this._predicate(filter));
    return hits;
  }

  /**
   * Sweep a vertical capsule (feet at `pos`) along `dir` (unit) up to `maxDist`.
   * @returns {{distance, point, normal, id, userData}|null}
   */
  castCapsule(pos, dir, maxDist, radius, height, filter) {
    const half = Math.max(0.01, height / 2 - radius);
    const center = { x: pos.x, y: pos.y + height / 2, z: pos.z };
    const h = this.world.castShape(center, { x: 0, y: 0, z: 0, w: 1 }, dir, new RAPIER.Capsule(half, radius), 0, maxDist, true, undefined, undefined, undefined, undefined, this._predicate(filter));
    if (!h) return null;
    const rec = this._byHandle.get(h.collider.handle);
    return this._hit(rec, new THREE.Vector3(h.witness1.x, h.witness1.y, h.witness1.z), new THREE.Vector3(h.normal1.x, h.normal1.y, h.normal1.z), h.time_of_impact);
  }

  /** Every body a ray passes through (Phase-Skip "what did I go through"). */
  raycastAll(origin, dir, maxDist, filter) {
    const out = [];
    const d = dir.clone().normalize();
    this.world.intersectionsWithRay(new RAPIER.Ray(origin, d), maxDist, false, (h) => {
      const rec = this._byHandle.get(h.collider.handle);
      if (rec) out.push(this._hit(rec, origin.clone().addScaledVector(d, h.timeOfImpact), new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z), h.timeOfImpact));
      return true;
    }, undefined, undefined, undefined, undefined, this._predicate(filter));
    return out.sort((a, b) => a.distance - b.distance);
  }

  // ---------- character movement ----------
  _capsule(radius, height) {
    const key = `${radius.toFixed(3)}|${height.toFixed(3)}`;
    let c = this._capsules.get(key);
    if (!c) {
      const half = Math.max(0.01, height / 2 - radius);
      // parentless collider: its pose updates immediately when set, which is what a query-only probe needs
      const collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(half, radius).setCollisionGroups(groups(LAYER.PLAYER, 0)));
      const kcc = this.world.createCharacterController(this.cfg.kccOffset);
      kcc.setUp({ x: 0, y: 1, z: 0 });
      kcc.setSlideEnabled(true);
      kcc.setApplyImpulsesToDynamicBodies(true);
      c = { collider, kcc, half, height, radius };
      this._capsules.set(key, c);
    }
    return c;
  }

  /**
   * Same contract as PhysicsWorld.moveCapsule: feet at `pos`, returns
   * { position, grounded, groundNormal, groundId, blocked, hit }.
   */
  moveCapsule(pos, disp, radius, height, filter = { solid: true }) {
    const c = this._capsule(radius, height);
    const step = filter.stepHeight ?? 0.38;
    const maxSlope = ((filter.maxSlopeDeg ?? 50) * Math.PI) / 180;
    c.kcc.setMaxSlopeClimbAngle(maxSlope);
    c.kcc.setMinSlopeSlideAngle(maxSlope + 0.05);
    c.kcc.enableAutostep(step, radius * 0.5, false);
    c.kcc.enableSnapToGround(step);
    c.collider.setTranslation({ x: pos.x, y: pos.y + height / 2 + this.cfg.kccOffset, z: pos.z });

    // move against solid bodies only (triggers / non-solid decor are passed through, as in the AABB world)
    const pred = this._predicate({ ...filter, solid: true });
    c.kcc.computeColliderMovement(c.collider, { x: disp.x, y: disp.y, z: disp.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, pred);
    const m = c.kcc.computedMovement();
    const out = new THREE.Vector3(pos.x + m.x, pos.y + m.y, pos.z + m.z);

    let blocked = false;
    let hit = null;
    for (let i = 0; i < c.kcc.numComputedCollisions(); i++) {
      const col = c.kcc.computedCollision(i);
      const n = col?.normal1;
      if (!n || Math.abs(n.y) > 0.7) continue; // floors / ceilings are not "blocked"
      const rec = this._byHandle.get(col.collider?.handle);
      blocked = true;
      hit = this._hit(rec, new THREE.Vector3(col.witness1.x, col.witness1.y, col.witness1.z), new THREE.Vector3(n.x, 0, n.z).normalize(), 0);
      break;
    }

    // ground: the KCC decides contact; a short ray gives the exact height, normal and id the controller expects
    let grounded = false;
    let groundNormal = UP.clone();
    let groundId = null;
    const goingDown = disp.y <= 0.01;
    if (goingDown) {
      const from = new THREE.Vector3(out.x, out.y + step + 0.05, out.z);
      const gh = this.raycast(from, new THREE.Vector3(0, -1, 0), step + 0.25 + Math.max(0, -disp.y), { ground: true });
      if (gh && gh.normal.y >= Math.cos(maxSlope) && (c.kcc.computedGrounded() || gh.point.y >= out.y - 0.12)) {
        out.y = gh.point.y;
        grounded = true;
        groundNormal = gh.normal;
        groundId = gh.id;
      }
    }
    return { position: out, grounded, groundNormal, groundId, blocked, hit };
  }

  // ---------- simulation ----------
  /** Fixed-step simulation for dynamic / kinematic bodies. Call once per frame. */
  step(dt) {
    this._acc += Math.min(dt, 0.1);
    let n = 0;
    while (this._acc >= this.world.timestep && n < 4) {
      this.world.step();
      this._acc -= this.world.timestep;
      n++;
    }
    for (const { rec, mesh } of this._dynamic) {
      const t = rec.rb.translation();
      const r = rec.rb.rotation();
      rec.center.set(t.x, t.y, t.z);
      // AABB of the (possibly rotated) box for the AABB-based helpers
      const ext = new THREE.Vector3();
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      for (const ax of [new THREE.Vector3(rec.half.x, 0, 0), new THREE.Vector3(0, rec.half.y, 0), new THREE.Vector3(0, 0, rec.half.z)]) {
        ax.applyQuaternion(q);
        ext.x += Math.abs(ax.x);
        ext.y += Math.abs(ax.y);
        ext.z += Math.abs(ax.z);
      }
      rec.min.copy(rec.center).sub(ext);
      rec.max.copy(rec.center).add(ext);
      if (mesh) {
        mesh.position.copy(rec.center);
        mesh.quaternion.copy(q);
      }
    }
  }
}
