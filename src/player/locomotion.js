// Phase-synced idle/walk/jog/run/sprint blend, smooth turning with lean.
// Adapted from Aether's Kanemori CharacterAnimator (motion/v03/locomotion.js)
// for Mixamo-compatible humanoids. Missing clips are time-scaled / weight-blended.
import * as THREE from 'three';
import { collectBones, applyFootIK } from './ik.js';

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
    const locoT = this.tuning.loco || {};
    this.clipSpeeds = { idle: 0, walk: 1.4, jog: 2.8, run: 5.0, sprint: 7.5, ...(locoT.clipSpeeds || {}) };
    this.mixer = this.fallback ? null : new THREE.AnimationMixer(this.root);
    this.clips = { ...(loaded.clips || {}) };
    this.clipMap = loaded.clipMap || {};
    this.bones = this.fallback ? {} : (loaded.bones && loaded.bones.hips ? loaded.bones : collectBones(this.root, loaded.boneMap));
    this.onFootstep = opts.onFootstep;

    this.loco = [];
    if (this.mixer) this._buildLoco();

    this.phase = 0; this.idleT = 0;
    this.speed = 0; this.targetSpeed = 0; this.prevSpeed = 0;
    this.yaw = this.object.rotation.y; this.targetYaw = this.yaw; this.yawVel = 0;
    this.lean = 0; this.pitchLean = 0;
    this.full = [];
    this.ikWeight = 1;
    this.busy = false;
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
    if (snap) { this.yaw = yaw; this.object.rotation.y = yaw; }
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
    const up = this.tuning.loco?.speedLambdaUp ?? 7;
    const down = this.tuning.loco?.speedLambdaDown ?? 9;
    this.speed = damp(this.speed, this.targetSpeed, this.targetSpeed > this.speed ? up : down, dt);

    const turnRate = THREE.MathUtils.degToRad(this.tuning.player?.turnRateDeg ?? 720);
    const diff = wrapPi(this.targetYaw - this.yaw);
    const maxRate = turnRate * (this.isBusy ? 0.35 : 1);
    const yawRate = clamp(diff * 10, -maxRate, maxRate);
    this.yaw = wrapPi(this.yaw + yawRate * dt);
    this.object.rotation.y = this.yaw;
    this.yawVel = damp(this.yawVel, yawRate, 8, dt);
    const leanGain = this.tuning.loco?.leanGain ?? 0.06;
    const maxLean = this.tuning.loco?.maxLean ?? 16;
    const leanTgt = clamp(this.yawVel * this.speed * leanGain * 57.3 / 10, -maxLean, maxLean);
    this.lean = damp(this.lean, leanTgt, 8, dt);
    this.pitchLean = damp(this.pitchLean, clamp((this.speed - this.prevSpeed) / Math.max(dt, 1e-4) * 1.2, -10, 10), 6, dt);

    // Loco weights + shared phase so feet stay planted at authored speeds
    const moving = this.loco.filter((l) => l.v > 0);
    const v = this.speed;
    const w = this.loco.map(() => 0);
    let rate = 0;
    const idx = (n) => this.loco.findIndex((l) => l.name === n);
    if (moving.length) {
      const first = moving[0];
      if (v <= first.v) {
        const a = first.v > 0 ? v / first.v : 0;
        const i0 = idx('idle'), i1 = this.loco.indexOf(first);
        if (i0 >= 0) w[i0] = 1 - a;
        if (i1 >= 0) w[i1] = i0 >= 0 ? a : 1;
        rate = Math.max(0.65, a) / Math.max(0.01, first.clip.duration);
      } else {
        let k = moving.length - 1;
        for (let i = 0; i < moving.length - 1; i++) if (v <= moving[i + 1].v) { k = i; break; }
        const A = moving[k], B = moving[k + 1] || moving[k];
        const a = B === A ? 1 : clamp((v - A.v) / (B.v - A.v), 0, 1);
        w[this.loco.indexOf(A)] = 1 - a;
        w[this.loco.indexOf(B)] = a;
        const T = A.clip.duration * (1 - a) + B.clip.duration * a;
        rate = (1 / Math.max(0.01, T)) * (B === A || v > B.v ? v / B.v : 1);
      }
    } else if (this.loco[0]) w[0] = 1;

    const blendLam = this.tuning.loco?.blendLambda ?? 14;
    this.loco.forEach((l, i) => { l.w = damp(l.w, w[i], blendLam, dt); });
    const prevPhase = this.phase;
    this.phase = (this.phase + rate * dt) % 1;
    this.idleT += dt;
    if (this.onFootstep && v > 0.3) {
      if (prevPhase > this.phase) this.onFootstep('L');
      else if (prevPhase < 0.5 && this.phase >= 0.5) this.onFootstep('R');
    }

    if (this.mixer) {
      for (const L of this.full) L.step(dt);
      for (const L of this.full.filter((l) => l.done)) { L.action.setEffectiveWeight(0); L.action.stop(); L.onDone?.(L); }
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

    this._applyLean();
    if (physics && !this.fallback && this.ikWeight > 0) {
      applyFootIK(this.root, this.bones, physics, ikTuning || this.tuning.ik || {}, this.ikWeight);
    }
  }

  _applyLean() {
    const b = this.bones; if (!b.hips && !b.spine) return;
    const k = 1 - Math.min(1, this.full.reduce((a, l) => a + (l.w || 0), 0)) * 0.7;
    const lean = THREE.MathUtils.degToRad(this.lean) * k;
    const pitch = THREE.MathUtils.degToRad(this.pitchLean) * k;
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
