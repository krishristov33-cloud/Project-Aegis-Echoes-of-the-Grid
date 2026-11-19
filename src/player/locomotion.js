// Phase-synced idle/walk/jog/run/sprint blend, smooth turning with lean.
// Adapted from Aether's Kanemori CharacterAnimator (motion/v03/locomotion.js)
// for Mixamo-compatible humanoids. Missing clips are time-scaled / weight-blended.
import * as THREE from 'three';
import { collectBones, applyFootIK } from './ik.js';
import { animTuning, critDamp, critDampAngle } from './animTuning.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));

class Layer {
  constructor(action, clip, opts = {}) {
    this.action = action; this.clip = clip;
    this.t = opts.startAt || 0; this.w = (opts.fade ?? 0.08) > 0 ? 0 : 1;
    this.fadeIn = opts.fade ?? 0.08; this.fadeOut = opts.fadeOut ?? 0.15;
    this.loop = opts.loop ?? false;
    this.timeScale = opts.timeScale ?? 1;
    this.onDone = opts.onDone; this.name = opts.name || clip.name;
    this.leaving = false; this.done = false;
    action.reset(); action.enabled = true; action.setEffectiveTimeScale(0); action.setEffectiveWeight(0); action.play();
  }
  leave(fade) { if (!this.leaving) { this.leaving = true; this.fadeOut = fade ?? this.fadeOut; } }
  step(dt) {
    const d = this.clip.duration;
    this.t += dt * this.timeScale;
    if (!this.loop && this.t >= d - this.fadeOut) this.leaving = true;
    if (this.leaving) this.w = this.fadeOut > 0 ? this.w - dt / this.fadeOut : 0;
    else this.w = this.fadeIn > 0 ? Math.min(1, this.w + dt / this.fadeIn) : 1;
    if (this.w <= 0 && this.leaving) { this.w = 0; this.done = true; }
    if (!this.loop && this.t >= d && this.fadeOut <= 0) { this.done = true; this.w = 0; }
    this.action.time = this.loop ? (d > 0 ? this.t % d : 0) : Math.min(this.t, Math.max(0, d - 1e-4));
  }
}

export class Locomotion {
  /**
   * @param {object} loaded  result of loadRole()
   * @param {THREE.Object3D} object  moving wrapper (feet at origin)
   * @param {object} opts    { tuning, onFootstep }
   */
  constructor(loaded, object, opts = {}) {
    this.object = object;
    this.root = loaded.root;
    this.fallback = !!loaded.fallback;
    this.tuning = opts.tuning || {};
    this.anim = animTuning;
    const locoT = this.anim.loco;
    this.clipSpeeds = { ...locoT.clipSpeeds };
    this.mixer = this.fallback ? null : new THREE.AnimationMixer(this.root);
    this.clips = { ...(loaded.clips || {}) };
    this.clipMap = loaded.clipMap || {};
    this.bones = this.fallback ? {} : (loaded.bones && loaded.bones.hips ? loaded.bones : collectBones(this.root, loaded.boneMap));
    this.onFootstep = opts.onFootstep;

    this.loco = [];
    if (this.mixer) this._buildLoco();

    this.phase = 0; this.idleT = 0;
    this.speed = 0; this.targetSpeed = 0; this.prevSpeed = 0;
    this._spd = { p: 0, v: 0 };
    this.yaw = this.object.rotation.y; this.targetYaw = this.yaw; this.yawVel = 0;
    this._yawS = { p: this.yaw, v: 0 };
    this.lean = 0; this.pitchLean = 0;
    this._lean = { p: 0, v: 0 }; this._pitch = { p: 0, v: 0 };
    this.full = [];
    this.ikWeight = 1;
    this.grounded = true; this.vy = 0;
    this.anticipate = 0; this.startPush = 0; this.stopSettle = 0;
    this._pushed = false; this._settling = false;
    this.hipProcY = 0; this.airPitch = 0;
    this._air = { p: 0, v: 0 }; this._land = { p: 0, v: 0 };
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
  }

  _resolveClip(logical) {
    const name = this.clipMap[logical];
    if (name && this.clips[name]) return { logical, clip: this.clips[name], clipName: name };
    return null;
  }

  _buildLoco() {
    // Unique source clips only (mixer has one action per clip).
    const order = ['idle', 'walk', 'jog', 'run', 'sprint'];
    const used = new Set();
    for (const logical of order) {
      let resolved = this._resolveClip(logical);
      if (!resolved) {
        // fall back to nearest available loco clip
        const prefer = logical === 'sprint' || logical === 'jog' ? ['run', 'walk'] : (logical === 'run' ? ['walk'] : ['idle', 'walk']);
        for (const p of prefer) {
          const r = this._resolveClip(p);
          if (r && !used.has(r.clipName)) { resolved = { logical, clip: r.clip, clipName: r.clipName }; break; }
          if (r && used.has(r.clipName)) { resolved = null; break; } // already in blend; skip duplicate
        }
      }
      if (!resolved) continue;
      if (used.has(resolved.clipName)) continue;
      used.add(resolved.clipName);
      const action = this.mixer.clipAction(resolved.clip);
      action.play(); action.setEffectiveTimeScale(0); action.setEffectiveWeight(0);
      this.loco.push({
        name: logical,
        clipName: resolved.clipName,
        clip: resolved.clip,
        action,
        v: this.clipSpeeds[logical] ?? 0,
        w: logical === 'idle' ? 1 : 0,
      });
    }
    if (!this.loco.length) this.fallback = true;
  }

  setMove(speed, yaw) {
    this.targetSpeed = Math.max(0, speed);
    if (yaw !== undefined) this.targetYaw = yaw;
  }
  setYaw(yaw, snap = false) {
    this.targetYaw = yaw;
    if (snap) {
      this.yaw = yaw; this._yawS.p = yaw; this._yawS.v = 0;
      this.object.rotation.y = yaw;
    }
  }
  setVertical(vy, grounded) {
    this.vy = vy;
    this.grounded = !!grounded;
  }
  beginJump() { this.anticipate = 1; this.grounded = false; }
  land(impact) {
    const J = this.anim.jump;
    const depth = -Math.min(J.landMax, Math.max(0, impact) * J.landGain);
    this._land.p = Math.min(this._land.p, depth);
    this.anticipate = 0;
    this.grounded = true;
  }

  play(logical, opts = {}) {
    if (!this.mixer) {
      const dummy = { name: logical, done: false, leave() {}, t: 0 };
      setTimeout(() => { dummy.done = true; opts.onDone?.(dummy); }, (opts.duration || 0.4) * 1000);
      this.full.push(dummy);
      return dummy;
    }
    const resolved = this._resolveClip(logical) || (this.clips[logical] && { clip: this.clips[logical], clipName: logical, logical });
    if (!resolved) return null;
    for (const l of this.full) l.leave(opts.fade ?? 0.08);
    const action = this.mixer.clipAction(resolved.clip);
    const old = this.full.find((l) => l.action === action);
    if (old) this.full.splice(this.full.indexOf(old), 1);
    const L = new Layer(action, resolved.clip, { ...opts, name: logical });
    this.full.push(L);
    return L;
  }
  stop(fade = 0.15) { for (const l of this.full) l.leave(fade); }
  get isBusy() { return this.full.some((l) => !l.leaving); }

  update(dt, { physics, ikTuning } = {}) {
    if (dt <= 0) return;
    this.prevSpeed = this.speed;
    const L = this.anim.loco;
    const omegaSpd = this.targetSpeed > this._spd.p ? L.speedOmegaUp : L.speedOmegaDown;
    this.speed = critDamp(this._spd, this.targetSpeed, omegaSpd, dt);
    if (this.speed < 0) { this.speed = 0; this._spd.p = 0; if (this._spd.v < 0) this._spd.v = 0; }

    const prevYaw = this.yaw;
    const maxRate = THREE.MathUtils.degToRad(L.maxTurnRateDeg) * (this.isBusy ? L.busyTurnScale : 1);
    critDampAngle(this._yawS, this.targetYaw, L.turnOmega, dt);
    let dy = wrapPi(this._yawS.p - prevYaw);
    const maxStep = maxRate * dt;
    if (Math.abs(dy) > maxStep) {
      this._yawS.p = wrapPi(prevYaw + Math.sign(dy) * maxStep);
      this._yawS.v = clamp(this._yawS.v, -maxRate, maxRate);
      dy = wrapPi(this._yawS.p - prevYaw);
    }
    this.yaw = this._yawS.p;
    this.object.rotation.y = this.yaw;
    this.yawVel = dt > 1e-5 ? dy / dt : this._yawS.v;

    const leanTgt = clamp(this.yawVel * this.speed * L.leanGain, -L.maxLean, L.maxLean);
    this.lean = critDamp(this._lean, leanTgt, L.leanOmega, dt);
    const accel = (this.speed - this.prevSpeed) / Math.max(dt, 1e-4);
    const accelTgt = clamp(accel * L.accelLeanGain, -L.accelLeanMax, L.accelLeanMax);
    this.pitchLean = critDamp(this._pitch, accelTgt, L.accelLeanOmega, dt);

    // Start push / stop settle envelopes
    if (!this._pushed && this.targetSpeed > L.startPushSpeed && this.prevSpeed < L.startPushFrom && this.speed >= this.prevSpeed) {
      this.startPush = 1; this._pushed = true;
    }
    if (this.speed < L.startPushFrom && this.targetSpeed < 0.2) this._pushed = false;
    this.startPush = Math.max(0, this.startPush - dt / L.startPushDur);

    if (!this._settling && this.targetSpeed < 0.15 && this.prevSpeed > L.stopSettleFrom && this.speed < this.prevSpeed) {
      this.stopSettle = clamp(this.prevSpeed / Math.max(0.01, this.clipSpeeds.run), 0.35, 1);
      this._settling = true;
    }
    if (this.targetSpeed > 0.3) this._settling = false;
    if (this._settling) this.stopSettle = Math.max(0, this.stopSettle - dt / L.stopSettleDur);
    if (this.stopSettle <= 0) this._settling = false;

    // Loco weights + shared phase; playback rate matches ground speed so feet don't skate.
    const moving = this.loco.filter((l) => l.v > 0);
    const v = this.speed;
    const w = this.loco.map(() => 0);
    let rate = 0;
    const strideOf = (l) => Math.max(1e-3, l.v * l.clip.duration);
    if (moving.length) {
      const first = moving[0];
      if (v <= first.v) {
        const a = first.v > 0 ? v / first.v : 0;
        const i0 = this.loco.findIndex((l) => l.name === 'idle');
        const i1 = this.loco.indexOf(first);
        if (i0 >= 0) w[i0] = 1 - a;
        if (i1 >= 0) w[i1] = i0 >= 0 ? a : 1;
        rate = v / strideOf(first);
      } else {
        let k = moving.length - 1;
        for (let i = 0; i < moving.length - 1; i++) if (v <= moving[i + 1].v) { k = i; break; }
        const A = moving[k], B = moving[k + 1] || moving[k];
        const a = B === A ? 1 : clamp((v - A.v) / (B.v - A.v), 0, 1);
        w[this.loco.indexOf(A)] = 1 - a;
        w[this.loco.indexOf(B)] = a;
        const stride = strideOf(A) * (1 - a) + strideOf(B) * a;
        rate = v / Math.max(1e-3, stride);
      }
    } else if (this.loco[0]) w[0] = 1;

    const blendLam = L.blendLambda;
    this.loco.forEach((l, i) => { l.w = damp(l.w, w[i], blendLam, dt); });
    const prevPhase = this.phase;
    this.phase = (this.phase + rate * dt) % 1;
    this.idleT += dt;
    if (this.onFootstep && v > 0.3) {
      if (prevPhase > this.phase) this.onFootstep('L');
      else if (prevPhase < 0.5 && this.phase >= 0.5) this.onFootstep('R');
    }

    if (this.mixer) {
      for (const lyr of this.full) lyr.step(dt);
      for (const lyr of this.full.filter((l) => l.done)) { lyr.action.setEffectiveWeight(0); lyr.action.stop(); lyr.onDone?.(lyr); }
      this.full = this.full.filter((l) => !l.done);
      const sumF = this.full.reduce((a, l) => a + l.w, 0), F = Math.min(1, sumF);
      for (const l of this.full) l.action.setEffectiveWeight(sumF > 1 ? l.w / sumF : l.w);
      const tot = this.loco.reduce((a, l) => a + l.w, 0) || 1;
      for (const l of this.loco) {
        const t = l.name === 'idle' ? this.idleT % l.clip.duration : this.phase * l.clip.duration;
        l.action.time = t;
        l.action.setEffectiveWeight((l.w / tot) * (1 - F));
      }
      this.mixer.update(dt); // timeScale is 0 on loco actions; we set .time ourselves
    }

    this._applyProcedural(dt);
    this._applyLean();
    if (physics && !this.fallback && this.ikWeight > 0) {
      applyFootIK(this.root, this.bones, physics, {
        ...this.anim.ik,
        ...(ikTuning || {}),
        hipOffsetY: this.hipProcY,
      }, this.ikWeight, dt);
    } else {
      this._applyHipOffset();
    }
  }

  _applyProcedural(dt) {
    const J = this.anim.jump;
    const L = this.anim.loco;
    this.anticipate = Math.max(0, this.anticipate - dt / J.anticipateDur);
    const airTgt = this.grounded ? 0 : clamp(this.vy * J.airVyPitch, -J.airTuckPitch, J.airStretchPitch);
    this.airPitch = critDamp(this._air, airTgt, J.airPoseOmega, dt);
    critDamp(this._land, 0, J.landOmega, dt);
    const airY = this.grounded ? 0 : clamp(this.vy * J.airVyHip, -J.airTuckHip, J.airStretchHip);
    this.hipProcY = -this.anticipate * J.anticipateHip
      - this.startPush * L.startPushHip
      - this.stopSettle * L.stopSettleHip
      + airY
      + this._land.p;
  }

  _applyHipOffset() {
    const hips = this.bones && this.bones.hips;
    if (!hips) return;
    if (!hips._ikRest) hips._ikRest = hips.position.clone();
    hips.position.copy(hips._ikRest);
    hips.position.y += this.hipProcY;
    hips.updateMatrixWorld(true);
  }

  _applyLean() {
    const b = this.bones; if (!b.hips && !b.spine) return;
    const L = this.anim.loco;
    const k = 1 - Math.min(1, this.full.reduce((a, l) => a + (l.w || 0), 0)) * 0.7;
    const lean = THREE.MathUtils.degToRad(this.lean) * k;
    const pitch = THREE.MathUtils.degToRad(
      this.pitchLean + this.startPush * L.startPushPitch + this.stopSettle * L.stopSettlePitch + this.airPitch
    ) * k;
    const add = (bone, x, y, z) => {
      if (!bone) return;
      this._q.setFromEuler(this._e.set(x, y, z));
      bone.quaternion.multiply(this._q);
    };
    add(b.hips, 0, 0, -lean * 0.35);
    add(b.spine, pitch * 0.5, lean * 0.25, -lean * 0.45);
    add(b.upperChest || b.chest, pitch * 0.3, lean * 0.2, -lean * 0.2);
    add(b.head, -pitch * 0.4, lean * 0.4, lean * 0.5);
  }

  gaitName() {
    const v = this.speed;
    if (v < 0.2) return 'idle';
    if (v < (this.clipSpeeds.walk + this.clipSpeeds.jog) * 0.5) return 'walk';
    if (v < (this.clipSpeeds.jog + this.clipSpeeds.run) * 0.5) return 'jog';
    if (v < (this.clipSpeeds.run + this.clipSpeeds.sprint) * 0.5) return 'run';
    return 'sprint';
  }
}
