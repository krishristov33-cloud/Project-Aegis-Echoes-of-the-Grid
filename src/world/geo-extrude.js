// C3: floor geometry that moves. Signatures kept from the L3 stub so callers don't change.
//
//   extrudeTiles({ physics, scene, origin, facing, width, columns, height, depth, holdTime, ... }) -> Extrusion
//     A row of floor columns slides up out of the ground in a wave (centre first), holds, and sinks back.
//     Each column is a kinematic Rapier box registered as a solid + ground body, so movement, AI line of sight,
//     enemy bullets and cover all respect it; you can stand on it. One InstancedMesh = one draw call.
//   createLaunchpad(...) -> see src/player/powers/launchpad.js (re-exported here for the stub's callers)
//   decayExtrusions(dt)  -> advances every live extrusion (call once per frame)
import * as THREE from 'three';

const live = new Set();
const easeOutBack = (k, s) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
const easeIn = (k) => k * k * k;
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
let nextId = 1;

export class Extrusion {
  constructor(o) {
    const c = {
      width: 6, columns: 11, height: 2.2, depth: 0.7, stagger: 0.035, riseTime: 0.22, overshoot: 1.6,
      holdTime: 4, sinkTime: 0.5, ripple: 0.12, ...o,
    };
    this.c = c;
    this.physics = c.physics;
    this.id = `extrude-${nextId++}`;
    this.t = 0;
    this.sinkAt = null;
    this.done = false;
    const facing = new THREE.Vector3(c.facing.x, 0, c.facing.z).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), facing).normalize();
    // columns are axis-aligned boxes in physics (the AABB-based helpers stay exact); visuals match
    const alongX = Math.abs(right.x) >= Math.abs(right.z);
    const colW = c.width / c.columns;
    const mid = (c.columns - 1) / 2;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      c.material ?? new THREE.MeshStandardMaterial({ color: 0x1b2638, emissive: 0x3df0ff, emissiveIntensity: 0.25, roughness: 0.35, metalness: 0.4 }),
      c.columns,
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.cols = [];
    for (let i = 0; i < c.columns; i++) {
      const base = c.origin.clone().addScaledVector(right, (i - mid) * colW);
      const g = this.physics.raycast(base.clone().setY(c.origin.y + 1.5), DOWN, 5, { ground: true });
      const floor = g ? g.point.y : c.origin.y;
      const h = c.height * (1 + c.ripple * (Math.sin((i / Math.max(1, c.columns - 1)) * Math.PI) - 0.5));
      const size = alongX ? new THREE.Vector3(colW * 0.94, h, c.depth) : new THREE.Vector3(c.depth, h, colW * 0.94);
      const buriedY = floor - h / 2 - 0.05;
      const raisedY = floor + h / 2;
      const pos = new THREE.Vector3(base.x, buriedY, base.z);
      const bodyId = this.physics.addKinematicBox({
        id: `${this.id}-${i}`,
        center: pos,
        halfExtents: size.clone().multiplyScalar(0.5),
        userData: { solid: true, ground: true, layer: 'shield', extrusion: this.id },
      });
      this.cols.push({ pos, size, buriedY, raisedY, delay: Math.abs(i - mid) * c.stagger, bodyId, k: 0 });
    }
    this._write();
    c.scene.add(this.mesh);
    live.add(this);
  }

  get raised() {
    return this.cols.some((col) => col.k > 0.5);
  }

  lower() {
    if (this.sinkAt === null) this.sinkAt = this.t;
  }

  /** @returns {boolean} alive */
  update(dt) {
    if (this.done) return false;
    const c = this.c;
    this.t += dt;
    const riseEnd = Math.max(...this.cols.map((col) => col.delay)) + c.riseTime;
    if (this.sinkAt === null && this.t >= riseEnd + c.holdTime) this.sinkAt = this.t;
    let alive = false;
    for (const col of this.cols) {
      let k;
      if (this.sinkAt === null) {
        const lt = (this.t - col.delay) / c.riseTime;
        k = lt <= 0 ? 0 : lt >= 1 ? 1 : easeOutBack(lt, c.overshoot);
      } else {
        const lt = (this.t - this.sinkAt - col.delay * 0.5) / c.sinkTime;
        k = lt <= 0 ? col.k : Math.max(0, 1 - easeIn(Math.min(1, lt)));
      }
      if (this.sinkAt === null || k > 0) alive = true;
      col.k = k;
      col.pos.y = col.buriedY + (col.raisedY - col.buriedY) * k;
      this.physics.moveKinematic(col.bodyId, col.pos);
    }
    this._write();
    if (!alive) this.dispose();
    return alive;
  }

  _write() {
    this.cols.forEach((col, i) => {
      _m.compose(col.pos, new THREE.Quaternion(), _s.copy(col.size));
      this.mesh.setMatrixAt(i, _m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this.done) return;
    this.done = true;
    for (const col of this.cols) this.physics.remove(col.bodyId);
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    live.delete(this);
  }
}

export function extrudeTiles(opts) {
  if (!opts?.physics?.addKinematicBox) {
    console.warn('[geo-extrude] needs the Rapier physics world (src/physics/rapier-world.js)');
    return null;
  }
  return new Extrusion(opts);
}

export function decayExtrusions(dt) {
  for (const e of [...live]) e.update(dt);
}

export { createLaunchpads as createLaunchpad } from '../player/powers/launchpad.js';
