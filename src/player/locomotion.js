// Character animation layer for a humanoid loaded through loadRole().
//
//   base      phase-synced idle / walk / jog / run / sprint blend (playback rate follows ground speed, so
//             feet don't skate) with a combat-ready idle mixed in while enemies are near
//   full      one-shot and looping full-body layers (attacks, jump, fall, vault, roll, death) with eased fades
//   partial   upper-body layers that play over the legs (flinches, casts on the move)
//   additive  procedural detail written after the mixer: breathing, turn / accel lean, air pose, start push,
//             stop settle, landing compression, head and chest look-at
//   IK        feet planted on the real ground, pelvis lowered to reach, feet pitched to the slope
//
// Originally adapted from Aether's Kanemori CharacterAnimator (motion/v03/locomotion.js).
import * as THREE from 'three';
import { collectBones, applyFootIK } from './ik.js';
import { animTuning, critDamp, critDampAngle } from './animTuning.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
const smooth = (x) => x * x * (3 - 2 * x);
const D2R = Math.PI / 180;

// Bones an upper-body layer drives (canonical names; resolved through the bone map).
const UPPER = ['spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
const PARTIAL_GAIN = 12; // weight boost so a partial layer wins over the base on the bones it owns

class Layer {
  constructor(action, clip, opts = {}) {
    this.action = action; this.clip = clip;
    this.t = opts.startAt || 0;
    this.fadeIn = opts.fade ?? 0.08; this.fadeOut = opts.fadeOut ?? 0.15;
    this.k = this.fadeIn > 0 ? 0 : 1;      // linear fade progress 0..1
    this.w = this.k;                        // eased weight
    this.loop = opts.loop ?? false;
    this.hold = opts.hold ?? false;         // stay on the last frame until leave()
    this.timeScale = opts.timeScale ?? 1;
    this.partial = !!opts.partial;
    this.onDone = opts.onDone; this.name = opts.name || clip.name;
    this.leaving = false; this.done = false;
    action.reset(); action.enabled = true; action.setEffectiveTimeScale(0); action.setEffectiveWeight(0); action.play();
  }
  leave(fade) { if (!this.leaving) { this.leaving = true; this.fadeOut = fade ?? this.fadeOut; } }
  step(dt) {
    const d = this.clip.duration;
    this.t += dt * this.timeScale;
    if (!this.loop && !this.hold && this.t >= d - this.fadeOut * this.timeScale) this.leaving = true;
    if (this.leaving) this.k = this.fadeOut > 0 ? this.k - dt / this.fadeOut : 0;
    else this.k = this.fadeIn > 0 ? Math.min(1, this.k + dt / this.fadeIn) : 1;
    if (this.k <= 0 && this.leaving) { this.k = 0; this.done = true; }
    this.w = smooth(clamp(this.k, 0, 1));
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
    this.guard = null;
    if (this.mixer) this._buildLoco();

    this.phase = 0; this.idleT = 0; this.time = 0;
    this.speed = 0; this.targetSpeed = 0; this.prevSpeed = 0;
    this._spd = { p: 0, v: 0 };
    this.yaw = this.object.rotation.y; this.targetYaw = this.yaw; this.yawVel = 0;
    this._yawS = { p: this.yaw, v: 0 };
    this.lean = 0; this.pitchLean = 0;
    this._lean = { p: 0, v: 0 }; this._pitch = { p: 0, v: 0 };
    this.full = [];
    this.fullWeight = 0;
    this.ikWeight = 1;
    this.grounded = true; this.vy = 0; this.airT = 0;
    this.anticipate = 0; this.startPush = 0; this.stopSettle = 0;
    this._pushed = false; this._settling = false;
    this.hipProcY = 0; this.airPitch = 0;
    this._air = { p: 0, v: 0 }; this._land = { p: 0, v: 0 };
    this.combatIdle = 0; this._guardW = 0;
    this.sprint = 0; this._sprint = 0;
    this.look = { yaw: 0, pitch: 0, weight: 0 };
    this._lookYaw = { p: 0, v: 0 }; this._lookPitch = { p: 0, v: 0 }; this._lookW = 0;
    this._partialCache = new Map();
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._qb = new THREE.Quaternion(); this._qbi = new THREE.Quaternion(); this._qp = new THREE.Quaternion(); this._qw = new THREE.Quaternion();
    // metres per unit of hips.position (the pelvis may sit under scaled parents)
    this.hipUnit = 1;
    const hp = this.bones?.hips?.parent;
    if (hp) { hp.updateWorldMatrix(true, false); this.hipUnit = new THREE.Vector3().setFromMatrixScale(hp.matrixWorld).y || 1; }
  }

  _resolveClip(logical) {
    const name = this.clipMap[logical];
    if (name && this.clips[name]) return { logical, clip: this.clips[name], clipName: name };
    if (this.clips[logical]) return { logical, clip: this.clips[logical], clipName: logical };
    return null;
  }
  hasClip(logical) { return !!this._resolveClip(logical); }

  _buildLoco() {
    // Unique source clips only (mixer has one action per clip).
    const order = ['idle', 'walk', 'jog', 'run', 'sprint'];
    const used = new Set();
    for (const logical of order) {
      let resolved = this._resolveClip(logical);
      if (!resolved) {
        const prefer = logical === 'sprint' || logical === 'jog' ? ['run', 'walk'] : (logical === 'run' ? ['walk'] : ['idle', 'walk']);
        for (const p of prefer) {
          const r = this._resolveClip(p);
          if (r && !used.has(r.clipName)) { resolved = { logical, clip: r.clip, clipName: r.clipName }; break; }
          if (r && used.has(r.clipName)) { resolved = null; break; }
        }
      }
      if (!resolved) continue;
      if (used.has(resolved.clipName)) continue;
      used.add(resolved.clipName);
      const action = this.mixer.clipAction(resolved.clip);
      action.play(); action.setEffectiveTimeScale(0); action.setEffectiveWeight(0);
      this.loco.push({
        name: logical, clipName: resolved.clipName, clip: resolved.clip, action,
        v: this.clipSpeeds[logical] ?? 0, w: logical === 'idle' ? 1 : 0,
      });
    }
    const g = this._resolveClip('guard');
    if (g && !used.has(g.clipName)) {
      const action = this.mixer.clipAction(g.clip);
      action.play(); action.setEffectiveTimeScale(0); action.setEffectiveWeight(0);
      this.guard = { clip: g.clip, action };
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
  /** 0..1: how much of the idle is the combat-ready stance. */
  setCombatIdle(w) { this.combatIdle = clamp(w, 0, 1); }
  /** 0..1: sprint effort (extra forward lean). */
  setSprint(w) { this.sprint = clamp(w, 0, 1); }
  /** World-space direction the head should favour. weight 0 releases it. */
  setLook(yawWorld, pitch = 0, weight = 1) { this.look.yaw = yawWorld; this.look.pitch = pitch; this.look.weight = weight; }
  beginJump() { this.anticipate = 1; this.grounded = false; }
  land(impact) {
    const J = this.anim.jump;
    const depth = -Math.min(J.landMax, Math.max(0, impact) * J.landGain);
    this._land.p = Math.min(this._land.p, depth);
    this.anticipate = 0;
    this.grounded = true;
  }

  _partialClip(clip) {
    let c = this._partialCache.get(clip);
    if (c) return c;
    const names = new Set(UPPER.map((k) => this.bones[k]?.name).filter(Boolean));
    const tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') && names.has(t.name.slice(0, t.name.lastIndexOf('.'))));
    c = new THREE.AnimationClip(clip.name + '@upper', clip.duration, tracks);
    this._partialCache.set(clip, c);
    return c;
  }

  /**
   * Play a clip by logical name.
   * opts: fade, fadeOut, timeScale, loop, hold (freeze on the last frame), partial (upper body only, the legs keep
   * running the base blend), startAt, onDone.
   */
  play(logical, opts = {}) {
    if (!this.mixer) {
      const dummy = { name: logical, done: false, leaving: false, w: 0, leave() { this.leaving = true; }, t: 0 };
      setTimeout(() => { dummy.done = true; opts.onDone?.(dummy); }, (opts.duration || 0.4) * 1000);
      this.full.push(dummy);
      return dummy;
    }
    const resolved = this._resolveClip(logical);
    if (!resolved) return null;
    const clip = opts.partial ? this._partialClip(resolved.clip) : resolved.clip;
    // a new full-body layer replaces the others; a partial one only replaces other partials
    for (const l of this.full) if (!opts.partial || l.partial) l.leave(opts.fade ?? 0.08);
    const action = this.mixer.clipAction(clip);
    const old = this.full.find((l) => l.action === action);
    if (old) this.full.splice(this.full.indexOf(old), 1);
    const L = new Layer(action, clip, { ...opts, name: logical });
    this.full.push(L);
    return L;
  }
  stop(fade = 0.15) { for (const l of this.full) l.leave(fade); }
  /** Drop every layer at once (respawn, teleport). */
  reset() {
    for (const l of this.full) { l.action?.setEffectiveWeight(0); l.action?.stop(); }
    this.full = [];
    this._land.p = 0; this._land.v = 0; this.anticipate = 0; this.startPush = 0; this.stopSettle = 0;
  }
  /** Debug: freeze a clip at time t (seconds) at full weight; pass null to release. */
  debugPose(logical, t = 0) {
    this.reset();
    this._debug = !!logical;
    if (!logical) return null;
    const L = this.play(logical, { fade: 0, fadeOut: 0, timeScale: 0, loop: true, startAt: t });
    return L ? L.clip.duration : null;
  }
  /** A full-body layer that has not started fading out is playing. */
  get isBusy() { return this.full.some((l) => !l.leaving && !l.partial && !l._air); }
  current(name) { return this.full.find((l) => l.name === name && !l.leaving) || null; }

  update(dt, { physics, ikTuning } = {}) {
    if (dt <= 0) return;
    this.time += dt;
    this.prevSpeed = this.speed;
    const L = this.anim.loco;
    const omegaSpd = this.targetSpeed > this._spd.p ? L.speedOmegaUp : L.speedOmegaDown;
    this.speed = critDamp(this._spd, this.targetSpeed, omegaSpd, dt);
    if (this.speed < 0) { this.speed = 0; this._spd.p = 0; if (this._spd.v < 0) this._spd.v = 0; }

    const prevYaw = this.yaw;
    const maxRate = L.maxTurnRateDeg * D2R * (this.isBusy ? L.busyTurnScale : 1);
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
    this._sprint = damp(this._sprint, this.sprint, L.sprintLambda, dt);

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
        // below walking pace keep the cadence up and shorten the stride instead of moving in slow motion
        rate = Math.max(v / strideOf(first), a > 0.02 ? (L.minCadence * Math.sqrt(a)) / first.clip.duration : 0);
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

    // Turning on the spot: shuffle the feet round instead of pivoting on locked soles.
    const turn = this.grounded && v < L.turnStepMaxSpeed ? clamp((Math.abs(this.yawVel) - L.turnStepFrom) / L.turnStepRange, 0, 1) : 0;
    if (turn > 0 && moving.length) {
      const i0 = this.loco.findIndex((l) => l.name === 'idle');
      const i1 = this.loco.indexOf(moving[0]);
      const add = Math.max(0, turn * L.turnStepWeight - w[i1]);
      if (add > 0) { w[i1] += add; if (i0 >= 0) w[i0] = Math.max(0, w[i0] - add); }
      rate = Math.max(rate, (Math.abs(this.yawVel) * L.turnStepCadence) / moving[0].clip.duration);
    }

    const blendLam = L.blendLambda;
    this.loco.forEach((l, i) => { l.w = damp(l.w, w[i], blendLam, dt); });
    this._guardW = damp(this._guardW, this.combatIdle, L.guardLambda, dt);
    const prevPhase = this.phase;
    this.phase = (this.phase + rate * dt) % 1;
    this.idleT += dt;
    if (this.onFootstep && v > 0.3 && this.grounded) {
      if (prevPhase > this.phase) this.onFootstep('L', v);
      else if (prevPhase < 0.5 && this.phase >= 0.5) this.onFootstep('R', v);
    }

    // Airborne without a clip of its own: hold the fall loop.
    this.airT = this.grounded ? 0 : this.airT + dt;
    if (this.mixer && !this._debug) {
      const air = this.full.find((l) => l._air && !l.leaving);
      if (!this.grounded && this.airT > L.fallDelay && !this.isBusy && !air) {
        const lyr = this.play('fall', { loop: true, fade: L.fallFade, fadeOut: 0.12 });
        if (lyr) lyr._air = true;
      } else if (this.grounded && air) air.leave(0.1);
    }

    if (this.mixer) {
      for (const lyr of this.full) lyr.step(dt);
      for (const lyr of this.full.filter((l) => l.done)) { lyr.action.setEffectiveWeight(0); lyr.action.stop(); lyr.onDone?.(lyr); }
      this.full = this.full.filter((l) => !l.done);
      let sumF = 0;
      for (const l of this.full) if (!l.partial) sumF += l.w;
      const F = Math.min(1, sumF);
      for (const l of this.full) {
        if (l.partial) l.action.setEffectiveWeight(l.w * PARTIAL_GAIN * (1 - F * 0.9));
        else l.action.setEffectiveWeight(sumF > 1 ? l.w / sumF : l.w);
      }
      const tot = this.loco.reduce((a, l) => a + l.w, 0) || 1;
      for (const l of this.loco) {
        const t = l.name === 'idle' ? this.idleT % l.clip.duration : this.phase * l.clip.duration;
        let wt = l.w / tot;
        if (l.name === 'idle' && this.guard) wt *= 1 - this._guardW;
        l.action.time = t;
        l.action.setEffectiveWeight(wt * (1 - F));
      }
      if (this.guard) {
        const idle = this.loco.find((l) => l.name === 'idle');
        this.guard.action.time = this.idleT % this.guard.clip.duration;
        this.guard.action.setEffectiveWeight((idle ? idle.w / tot : 0) * this._guardW * (1 - F));
      }
      this.fullWeight = F;
      this.mixer.update(dt); // timeScale is 0 on every action; we set .time ourselves
    }

    this._applyProcedural(dt);
    this._applyAdditive(dt);
    const ikW = this.ikWeight * (1 - this.fullWeight * this.anim.ik.busyRelease);
    if (physics && !this.fallback && ikW > 0.01) {
      applyFootIK(this.root, this.bones, physics, {
        ...this.anim.ik,
        ...(ikTuning || {}),
        hipOffsetY: this.hipProcY,
        hipUnit: this.hipUnit,
      }, ikW, dt);
    } else {
      this._applyHipOffset();
    }
  }

  _applyProcedural(dt) {
    const J = this.anim.jump;
    const L = this.anim.loco;
    this.anticipate = Math.max(0, this.anticipate - dt / J.anticipateDur);
    const free = 1 - this.fullWeight; // authored clips carry their own body mechanics
    const airTgt = this.grounded ? 0 : clamp(this.vy * J.airVyPitch, -J.airTuckPitch, J.airStretchPitch);
    this.airPitch = critDamp(this._air, airTgt, J.airPoseOmega, dt);
    critDamp(this._land, 0, J.landOmega, dt);
    const airY = this.grounded ? 0 : clamp(this.vy * J.airVyHip, -J.airTuckHip, J.airStretchHip);
    const breathe = Math.sin(this.time * L.breathRate * Math.PI * 2) * L.breathHip * clamp(1 - this.speed / 2, 0, 1);
    this.hipProcY = (-this.anticipate * J.anticipateHip
      - this.startPush * L.startPushHip
      - this.stopSettle * L.stopSettleHip
      + airY * free
      + breathe) * (0.35 + 0.65 * free)
      + this._land.p * (0.4 + 0.6 * free);
  }

  _applyHipOffset() {
    const hips = this.bones && this.bones.hips;
    if (!hips) return;
    hips.position.y += this.hipProcY / this.hipUnit;
    hips.updateMatrixWorld(true);
  }

  /** Lean, breathing and look-at, layered on whatever the mixer posed. */
  _applyAdditive(dt) {
    const b = this.bones; if (!b.hips && !b.spine) return;
    const L = this.anim.loco;
    const free = 1 - this.fullWeight;
    const k = 0.3 + 0.7 * free;
    const lean = this.lean * D2R * k;
    const breath = Math.sin(this.time * L.breathRate * Math.PI * 2 + 0.6) * L.breathChest * D2R * clamp(1.2 - this.speed / 4, 0.25, 1);
    const pitch = (this.pitchLean + this.startPush * L.startPushPitch + this.stopSettle * L.stopSettlePitch
      + this.airPitch * free + this._sprint * L.sprintLean) * D2R * k;

    // look-at: yaw / pitch offset from body facing, spread over chest, neck and head
    const lk = this.look;
    const wantW = lk.weight * free * (this.grounded ? 1 : 0.4);
    this._lookW = damp(this._lookW, wantW, L.lookLambda, dt);
    const rel = wrapPi(lk.yaw - this.yaw);
    // past the limit the head relaxes back instead of sticking at the stop
    const over = Math.abs(rel) > (L.lookMaxYaw + 40) * D2R;
    const ly = critDamp(this._lookYaw, over ? 0 : clamp(rel, -L.lookMaxYaw * D2R, L.lookMaxYaw * D2R), L.lookOmega, dt) * this._lookW;
    const lp = critDamp(this._lookPitch, over ? 0 : clamp(lk.pitch, -L.lookMaxPitch * D2R, L.lookMaxPitch * D2R), L.lookOmega, dt) * this._lookW;

    // Deltas are given in character space (pitch + = bow forward, yaw + = turn left, roll + = tip right) and
    // converted to each bone's own frame, so they mean the same thing on every rig.
    const body = this.object.getWorldQuaternion(this._qb);
    const bodyInv = this._qbi.copy(body).invert();
    const add = (bone, pitchR, yawR, rollR) => {
      if (!bone || (!pitchR && !yawR && !rollR)) return;
      bone.parent.updateWorldMatrix(true, false);
      const pw = bone.parent.getWorldQuaternion(this._qp);
      const bw = this._qw.copy(pw).multiply(bone.quaternion);
      this._q.setFromEuler(this._e.set(pitchR, yawR, rollR, 'YXZ')).premultiply(body).multiply(bodyInv);
      bone.quaternion.copy(pw.invert().multiply(this._q.multiply(bw)));
    };
    add(b.hips, 0, 0, -lean * 0.3);
    add(b.spine, pitch * 0.45, ly * 0.1, -lean * 0.3);
    add(b.upperChest || b.chest, pitch * 0.3 - breath, ly * 0.2, -lean * 0.15);
    add(b.neck, lp * 0.35, ly * 0.3, lean * 0.2);
    add(b.head, -pitch * 0.5 + breath * 0.6 + lp * 0.65, ly * 0.4, lean * 0.3);
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
