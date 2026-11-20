import * as THREE from 'three';
import { consumeMouse, input } from '../core/input.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// cheap smooth 1D noise for the shake (sum of incommensurate sines)
const wobble = (t, s) => Math.sin(t * 31.7 + s) * 0.55 + Math.sin(t * 57.3 + s * 2.3) * 0.3 + Math.sin(t * 91.1 + s * 4.1) * 0.15;

/**
 * Over-the-shoulder orbit camera.
 *  - the pivot follows the player through a spring (tight sideways, softer vertically, so jumps and
 *    landings read as motion instead of the whole frame snapping)
 *  - distance and FOV open up with speed
 *  - trauma-based shake (addTrauma) and a decaying pitch kick (kick) for impacts
 *  - a ray keeps the camera in front of walls, pulling in fast and easing back out
 */
export class ThirdPersonCamera {
  constructor(camera, tuning) {
    this.camera = camera;
    const t = tuning.camera || {};
    this.t = t;
    this.yaw = 0;
    this.pitch = 0.28;
    this.distance = t.distance ?? 4.4;
    this._dist = this.distance;
    this._pivot = new THREE.Vector3();
    this._hasPivot = false;
    this._look = new THREE.Vector3();
    this._off = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.baseFov = camera.fov;
    this._fov = camera.fov;
    this._speedK = 0;
    this.speed = 0;
    this.trauma = 0;
    this._kick = 0;
    this._time = 0;
  }

  setLook(yaw, pitch) {
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = pitch;
    this._hasPivot = false; // next update snaps to the target (level change, teleport)
  }

  /** 0..1 shake energy; decays on its own. */
  addTrauma(a) { this.trauma = Math.min(1, this.trauma + a); }
  /** Brief pitch punch in radians (positive tips the view up). */
  kick(a) { this._kick += a; }
  /** Horizontal speed of the target in m/s, for the speed-driven framing. */
  setSpeed(v) { this.speed = v; }

  update(dt, targetPos, physics) {
    const t = this.t;
    this._time += dt;
    const { x: mdx, y: mdy } = consumeMouse();
    if (input.locked || input._scripting) {
      this.yaw -= mdx * (t.sensitivity ?? 0.0022);
      this.pitch += mdy * (t.sensitivity ?? 0.0022);
    }
    this.pitch = clamp(this.pitch, t.pitchMin ?? -0.4, t.pitchMax ?? 1.15);
    this.yaw = wrapPi(this.yaw);

    // spring the pivot toward the player
    const p = this._pivot;
    if (!this._hasPivot || p.distanceToSquared(targetPos) > (t.snapDistance ?? 9) ** 2) {
      p.copy(targetPos); this._hasPivot = true;
    } else if (dt > 0) {
      const lh = t.followLambda ?? 22, lv = t.followLambdaY ?? 9;
      p.x = damp(p.x, targetPos.x, lh, dt);
      p.z = damp(p.z, targetPos.z, lh, dt);
      p.y = damp(p.y, targetPos.y, lv, dt);
      // never let the player drift far out of frame vertically (long falls)
      const maxLag = t.maxLagY ?? 1.1;
      p.y = clamp(p.y, targetPos.y - maxLag, targetPos.y + maxLag);
    }

    const sprintFrom = t.speedFrom ?? 5.2, sprintTo = t.speedTo ?? 7.5;
    this._speedK = damp(this._speedK, clamp((this.speed - sprintFrom) / Math.max(0.1, sprintTo - sprintFrom), 0, 1), t.speedLambda ?? 3.5, dt);

    const height = t.height ?? 1.55;
    const shoulder = t.shoulder ?? 0.48;
    const look = this._look.copy(p); look.y += height;

    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    const off = this._off.set(-Math.sin(this.yaw) * cosP, sinP, -Math.cos(this.yaw) * cosP);
    this._right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    look.addScaledVector(this._right, shoulder);

    const desired = (this.distance ?? t.distance ?? 4.4) + this._speedK * (t.speedDistance ?? 0.5);
    let dist = desired;
    const pad = t.collisionPad ?? 0.22;
    const minD = t.minDistance ?? 0.5;
    if (physics) {
      const hit = physics.raycast(look, off, desired + pad, { solid: true });
      if (hit) dist = Math.max(minD, Math.min(desired, hit.distance - pad));
    }
    const lam = dist < this._dist ? (t.pullLambda ?? 14) : (t.returnLambda ?? 6);
    this._dist = dt > 0 ? damp(this._dist, dist, lam, dt) : this._dist;
    if (this._dist > dist + 0.6) this._dist = dist + 0.6; // never sit deep inside a wall while easing

    this.camera.position.copy(look).addScaledVector(off, this._dist);
    this.camera.lookAt(look);

    // shake + kick (applied after lookAt so they never fight the framing)
    this.trauma = Math.max(0, this.trauma - (t.traumaDecay ?? 1.9) * dt);
    this._kick = damp(this._kick, 0, t.kickLambda ?? 11, dt);
    const sh = this.trauma * this.trauma;
    if (sh > 1e-4 || Math.abs(this._kick) > 1e-4) {
      const a = t.shakeAngle ?? 0.035, tm = this._time;
      this.camera.rotateX(wobble(tm, 1.3) * a * sh + this._kick);
      this.camera.rotateY(wobble(tm, 4.7) * a * sh);
      this.camera.rotateZ(wobble(tm, 8.9) * a * 0.6 * sh);
      const ps = (t.shakeOffset ?? 0.07) * sh;
      this.camera.position.x += wobble(tm, 12.1) * ps;
      this.camera.position.y += wobble(tm, 17.3) * ps;
    }

    const fov = this.baseFov + this._speedK * (t.speedFov ?? 7);
    this._fov = damp(this._fov, fov, 8, dt);
    if (Math.abs(this.camera.fov - this._fov) > 0.01) { this.camera.fov = this._fov; this.camera.updateProjectionMatrix(); }
    return { yaw: this.yaw, pitch: this.pitch, distance: this._dist };
  }
}
