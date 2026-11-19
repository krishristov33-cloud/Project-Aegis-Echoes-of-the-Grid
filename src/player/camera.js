import * as THREE from 'three';
import { consumeMouse, input } from '../core/input.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));

export class ThirdPersonCamera {
  constructor(camera, tuning) {
    this.camera = camera;
    const t = tuning.camera || {};
    this.t = t;
    this.yaw = 0;
    this.pitch = 0.28;
    this.distance = t.distance ?? 4.4;
    this._dist = this.distance;
    this._look = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  setLook(yaw, pitch) {
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = pitch;
  }

  update(dt, targetPos, physics) {
    const t = this.t;
    const { x: mdx, y: mdy } = consumeMouse();
    if (input.locked || input._scripting) {
      this.yaw -= mdx * (t.sensitivity ?? 0.0022);
      this.pitch += mdy * (t.sensitivity ?? 0.0022);
    }
    this.pitch = Math.max(t.pitchMin ?? -0.4, Math.min(t.pitchMax ?? 1.15, this.pitch));
    this.yaw = wrapPi(this.yaw);

    const height = t.height ?? 1.55;
    const shoulder = t.shoulder ?? 0.48;
    const look = this._look.copy(targetPos); look.y += height;

    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    const off = new THREE.Vector3(
      -Math.sin(this.yaw) * cosP,
      sinP,
      -Math.cos(this.yaw) * cosP,
    );
    // shoulder offset along camera-right
    this._right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    look.addScaledVector(this._right, shoulder);

    const desired = t.distance ?? 4.4;
    let dist = desired;
    const pad = t.collisionPad ?? 0.22;
    if (physics) {
      const hit = physics.raycast(look, off, desired, { solid: true });
      if (hit && hit.distance > (t.minDistance ?? 0.5)) dist = Math.max(t.minDistance ?? 0.5, hit.distance - pad);
      else if (hit) dist = t.minDistance ?? 0.5;
    }
    const lam = dist < this._dist ? (t.pullLambda ?? 14) : (t.returnLambda ?? 6);
    this._dist = damp(this._dist, dist, lam, dt);

    const want = this._want.copy(look).addScaledVector(off, this._dist);
    this.camera.position.copy(want);
    this.camera.lookAt(look);
    return { yaw: this.yaw, pitch: this.pitch, distance: this._dist };
  }
}
