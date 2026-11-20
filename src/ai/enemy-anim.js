// Enemy animation layer (W3). One EnemyAnimator per humanoid enemy view.
//
// - Every clip is split into a LOWER (hips + legs) and an UPPER (spine, arms, head) action, so a soldier can run
//   on walk/run legs while the torso holds the `aim` / `fire` / `reload` pose.
// - Locomotion (idle / walk / run) shares one phase; playback rate follows the real agent speed so feet don't skate.
//   Turning on the spot feeds a little "step" speed so the feet shuffle instead of pivoting like a turntable.
// - Pose loops: aim, fire, crouch, crouchAim, ducked. One-shots: stagger, death, reload, melee1, hulk*.
//   Every clip is optional: a missing one resolves through FALLBACK to something that exists (never throws).
// - After the mixer: aim yaw/pitch spread over spine / chest / upperChest, head look-at, hit flinch spring,
//   emissive hit flash, all through the canonical bone map in `loaded.bones` (no vendor bone names).
//
// Weights are set by hand on every action (timeScale 0), same approach as the player's Locomotion.
import * as THREE from 'three';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const LOWER = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
const LOCO = ['idle', 'walk', 'run'];
const POSES = ['aim', 'fire', 'crouch', 'crouchAim', 'ducked'];
/** name -> what to use when the clip is not in the role (first existing wins; null = locomotion). */
const FALLBACK = {
  aim: ['idle'],
  fire: ['aim', 'idle'],
  crouch: ['idle'],
  crouchAim: ['crouch', 'aim', 'idle'],
  ducked: ['idle'],
  walk: ['run', 'idle'],
  run: ['walk', 'idle'],
};

const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Rotate `bone` by a world-space quaternion `r` (premultiplied in world space). */
export function rotateWorld(bone, r) {
  if (!bone?.parent) return;
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_pq);
  // local' = inv(P) * r * P * local
  _q.copy(_pq).invert().multiply(r).multiply(_pq).multiply(bone.quaternion);
  bone.quaternion.copy(_q);
}

export class EnemyAnimator {
  /**
   * @param {object} loaded        loadRole() result
   * @param {object} [o]
   * @param {object} [o.cfg]       enemies.json "anim" block (speeds authored on the source rig, blend rates)
   * @param {number} [o.height]    this enemy's height (scales the authored clip speeds)
   */
  constructor(loaded, o = {}) {
    const A = (this.cfg = {
      walkSpeed: 1.4, runSpeed: 5.0, sourceHeight: 1.8, blend: 9, poseBlend: 11, turnStep: 0.45,
      aimSpread: [0.3, 0.3, 0.4], aimMaxYaw: 1.1, aimMaxPitch: 0.7, aimRate: 12, lookRate: 6,
      flinchStiffness: 90, flinchDamping: 13, flashTime: 0.16, flashGain: 1.6,
      ...(o.cfg ?? {}),
    });
    this.loaded = loaded;
    this.root = loaded.root;
    this.bones = loaded.bones ?? {};
    this.ok = !loaded.fallback && !!loaded.clips && Object.keys(loaded.clips).length > 0;
    this.mixer = this.ok ? new THREE.AnimationMixer(this.root) : null;
    const scale = (o.height ?? loaded.height ?? A.sourceHeight) / A.sourceHeight;
    this.speedOf = { idle: 0, walk: A.walkSpeed * scale, run: A.runSpeed * scale };

    this.ch = new Map(); // name -> channel
    this.lowerNames = new Set(LOWER.map((k) => this.bones[k]?.name).filter(Boolean));
    if (this.ok) for (const n of [...LOCO, ...POSES]) this._channel(n);
    if (this.ok && !this.ch.has('idle')) {
      // a role without an idle clip: use whatever is there so the mixer always has a base
      const any = Object.keys(loaded.clips)[0];
      if (any) this._channel('idle', loaded.clips[any]);
      else this.ok = false;
    }

    this.phase = Math.random(); // per-enemy offset so a squad never steps in sync
    this.speed = 0;
    this.lower = 'loco';
    this.upper = 'loco';
    this.shot = null; // active one-shot
    this.aim = { yaw: 0, pitch: 0, w: 0, tYaw: 0, tPitch: 0, tW: 0 };
    this.look = { yaw: 0, pitch: 0, w: 0, tYaw: 0, tPitch: 0, tW: 0 };
    this.flinchS = { x: 0, z: 0, vx: 0, vz: 0 };
    this.flashT = 0;
    this.crouchDrop = 0; // procedural hip drop when the role has no crouch clip
    this.frozen = false;
    this._mats = null;
    this._yawRate = 0;
  }

  // ---------- clip plumbing ----------
  _clip(name) {
    const c = this.loaded.clips ?? {};
    const mapped = this.loaded.clipMap?.[name];
    return (mapped && c[mapped]) || c[name] || null;
  }

  has(name) {
    return !!this._clip(name);
  }

  _channel(name, forceClip = null) {
    if (this.ch.has(name)) return this.ch.get(name);
    const clip = forceClip ?? this._clip(name);
    if (!clip || !this.mixer) return null;
    const lo = [];
    const up = [];
    for (const t of clip.tracks) {
      const node = THREE.PropertyBinding.parseTrackName(t.name).nodeName;
      (this.lowerNames.has(node) ? lo : up).push(t);
    }
    const mk = (suffix, tracks) => {
      if (!tracks.length) return null;
      const a = this.mixer.clipAction(new THREE.AnimationClip(`${clip.name}@${name}:${suffix}`, clip.duration, tracks));
      a.enabled = true;
      a.setEffectiveTimeScale(0);
      a.setEffectiveWeight(0);
      a.play();
      return a;
    };
    const ch = { name, clip, dur: Math.max(1e-3, clip.duration), lo: mk('lo', lo), up: mk('up', up), wLo: 0, wUp: 0, t: Math.random() * clip.duration };
    this.ch.set(name, ch);
    return ch;
  }

  /** Channel for `name`, walking the fallback chain. */
  _resolve(name) {
    if (this.ch.has(name)) return this.ch.get(name);
    for (const f of FALLBACK[name] ?? []) if (this.ch.has(f)) return this.ch.get(f);
    return this.ch.get('idle') ?? null;
  }

  // ---------- inputs ----------
  /** Ground speed (m/s) and yaw rate (rad/s) this frame. */
  setMotion(speed, yawRate = 0) {
    this.speed = Math.max(0, speed);
    this._yawRate = yawRate;
  }

  /** Looping pose for each half: 'loco' | 'aim' | 'fire' | 'crouch' | 'crouchAim' | 'ducked'. */
  setPose(lower, upper = lower) {
    this.lower = lower;
    this.upper = upper;
  }

  /**
   * One-shot clip. Returns false when the role has no such clip (caller falls back to procedural).
   * @param {object} [o] duration (fit the clip into this many seconds), timeScale, fade, fadeOut, hold (keep the
   *   last frame), upperOnly, markAt (0..1 clip fraction) + onMark, onDone
   */
  play(name, o = {}) {
    if (!this.ok) return false;
    const ch = this._channel(name);
    if (!ch) return false;
    const ts = o.duration ? ch.dur / o.duration : (o.timeScale ?? 1);
    const same = this.shot && this.shot.ch === ch;
    this._fading = (this._fading ?? []).filter((s) => s.ch !== ch);
    if (this.shot && !same) {
      this.shot.out = true;
      this._fading.push(this.shot);
    }
    this.shot = {
      ch, name, t: 0, ts, w: same ? this.shot.w : 0, out: false, hold: !!o.hold, upperOnly: !!o.upperOnly,
      fade: o.fade ?? 0.1, fadeOut: o.fadeOut ?? 0.18, onDone: o.onDone, markAt: o.markAt, onMark: o.onMark,
    };
    return true;
  }

  stop(name) {
    if (this.shot && (!name || this.shot.name === name)) this.shot.out = true;
  }

  get playing() {
    return this.shot && !this.shot.out ? this.shot.name : null;
  }

  /** Torso aim offset relative to the body facing (radians). weight 0 relaxes. */
  setAim(yaw, pitch, weight = 1) {
    this.aim.tYaw = clamp(yaw, -this.cfg.aimMaxYaw, this.cfg.aimMaxYaw);
    this.aim.tPitch = clamp(pitch, -this.cfg.aimMaxPitch, this.cfg.aimMaxPitch);
    this.aim.tW = weight;
  }

  /** Head look offset relative to the body facing (radians). */
  setLook(yaw, pitch, weight = 1) {
    this.look.tYaw = clamp(yaw, -1.2, 1.2);
    this.look.tPitch = clamp(pitch, -0.6, 0.6);
    this.look.tW = weight;
  }

  /** Hit flinch: (x, z) is the push direction in the body's local space (z forward), strength ~0..1. */
  flinch(x, z, strength = 1) {
    this.flinchS.vx += x * strength * 9;
    this.flinchS.vz += z * strength * 9;
  }

  flash(strength = 1) {
    this.flashT = Math.max(this.flashT, this.cfg.flashTime * strength);
    this._flashPeak = this.flashT;
  }

  /** Stop animating (dead body at rest). The pose stays as it is. */
  freeze() {
    this.frozen = true;
    this._applyFlash(0);
  }

  // ---------- update ----------
  update(dt) {
    if (this.frozen || dt <= 0) return;
    const A = this.cfg;
    if (this.flashT > 0 || this._flashOn) {
      this.flashT = Math.max(0, this.flashT - dt);
      this._applyFlash(this.flashT / Math.max(1e-3, this._flashPeak ?? A.flashTime));
    }
    if (!this.ok) return;

    // --- locomotion weights (speed-matched, shared phase) ---
    const stepSpeed = Math.min(this.speedOf.walk * 0.6, Math.abs(this._yawRate) * A.turnStep);
    const v = Math.max(this.speed, stepSpeed);
    const idle = this.ch.get('idle');
    const walk = this._resolve('walk');
    const run = this._resolve('run');
    const lw = { idle: 0, walk: 0, run: 0 };
    let rate = 0;
    const vW = this.speedOf.walk;
    const vR = this.speedOf.run;
    if (!walk || walk === idle) lw.idle = 1;
    else if (v <= vW) {
      const a = smooth(v / vW);
      lw.idle = 1 - a;
      lw.walk = a;
      rate = v / (vW * walk.dur);
      if (v > 0.05) rate = Math.max(rate, 0.45 / walk.dur); // never a slow-motion shuffle
    } else {
      const a = run && run !== walk ? clamp((v - vW) / Math.max(0.1, vR - vW), 0, 1) : 0;
      lw.walk = 1 - a;
      lw.run = a;
      const stride = vW * walk.dur * (1 - a) + vR * (run?.dur ?? walk.dur) * a;
      rate = v / Math.max(1e-3, stride);
    }
    this.phase = (this.phase + rate * dt) % 1;

    // --- targets per channel ---
    const tgtLo = new Map();
    const tgtUp = new Map();
    const add = (map, ch, w) => ch && w > 0 && map.set(ch, (map.get(ch) ?? 0) + w);
    const fill = (map, pose) => {
      if (pose === 'loco') {
        add(map, idle, lw.idle);
        add(map, walk, lw.walk);
        add(map, run, lw.run);
      } else add(map, this._resolve(pose), 1);
    };
    fill(tgtLo, this.lower);
    fill(tgtUp, this.upper);

    // --- one-shot envelope ---
    let sLo = 0;
    let sUp = 0;
    const stepShot = (s) => {
      s.t += dt * s.ts;
      const end = s.ch.dur;
      if (s.markAt != null && !s.marked && s.t >= s.markAt * end) {
        s.marked = true;
        s.onMark?.();
      }
      if (!s.hold && s.t >= end - s.fadeOut * s.ts) s.out = true;
      if (s.out) s.w = s.fadeOut > 0 ? s.w - dt / s.fadeOut : 0;
      else s.w = s.fade > 0 ? Math.min(1, s.w + dt / s.fade) : 1;
      if (s.t >= end && !s.doneFired) {
        s.doneFired = true;
        s.onDone?.();
      }
      return s.w > 0;
    };
    const shots = [];
    if (this._fading?.length) {
      this._fading = this._fading.filter((s) => { s.out = true; return stepShot(s); });
      shots.push(...this._fading);
    }
    if (this.shot) {
      if (stepShot(this.shot)) shots.push(this.shot);
      else if (this.shot.out) this.shot = null;
    }
    const shotW = new Map(); // ch -> {lo, up}
    for (const s of shots) {
      const w = smooth(s.w);
      const rec = shotW.get(s.ch) ?? { lo: 0, up: 0 };
      rec.up = Math.max(rec.up, w);
      if (!s.upperOnly) rec.lo = Math.max(rec.lo, w);
      shotW.set(s.ch, rec);
      s.ch.t = Math.min(s.t, s.ch.dur - 1e-4);
    }
    for (const rec of shotW.values()) {
      sLo = Math.max(sLo, rec.lo);
      sUp = Math.max(sUp, rec.up);
    }

    // --- damp, normalise, write ---
    const lamL = this.lower === 'loco' ? A.blend : A.poseBlend;
    let sumLo = 0;
    let sumUp = 0;
    for (const ch of this.ch.values()) {
      if (shotW.has(ch)) continue;
      ch.wLo = damp(ch.wLo, tgtLo.get(ch) ?? 0, lamL, dt);
      ch.wUp = damp(ch.wUp, tgtUp.get(ch) ?? 0, A.poseBlend, dt);
      if (ch.wLo < 1e-3 && !(tgtLo.get(ch) > 0)) ch.wLo = 0;
      if (ch.wUp < 1e-3 && !(tgtUp.get(ch) > 0)) ch.wUp = 0;
      sumLo += ch.wLo;
      sumUp += ch.wUp;
    }
    for (const ch of this.ch.values()) {
      const rec = shotW.get(ch);
      let wl;
      let wu;
      if (rec) {
        wl = rec.lo;
        wu = rec.up;
        ch.wLo = 0;
        ch.wUp = 0;
      } else {
        wl = sumLo > 1e-4 ? (ch.wLo / sumLo) * (1 - sLo) : 0;
        wu = sumUp > 1e-4 ? (ch.wUp / sumUp) * (1 - sUp) : 0;
        if (LOCO.includes(ch.name) && ch.name !== 'idle') ch.t = this.phase * ch.dur;
        else ch.t = (ch.t + dt) % ch.dur;
      }
      if (ch.lo) { ch.lo.time = ch.t; ch.lo.setEffectiveWeight(wl); }
      if (ch.up) { ch.up.time = ch.t; ch.up.setEffectiveWeight(wu); }
    }
    this.mixer.update(dt);
    this._procedural(dt, 1 - Math.max(sLo, sUp) * 0.85);
  }

  _procedural(dt, k) {
    const A = this.cfg;
    const b = this.bones;
    const a = this.aim;
    const l = this.look;
    a.yaw = damp(a.yaw, a.tYaw, A.aimRate, dt);
    a.pitch = damp(a.pitch, a.tPitch, A.aimRate, dt);
    a.w = damp(a.w, a.tW, A.aimRate, dt);
    l.yaw = damp(l.yaw, l.tYaw, A.lookRate, dt);
    l.pitch = damp(l.pitch, l.tPitch, A.lookRate, dt);
    l.w = damp(l.w, l.tW, A.lookRate, dt);

    // flinch spring (decays to rest)
    const f = this.flinchS;
    f.vx += (-A.flinchStiffness * f.x - A.flinchDamping * f.vx) * dt;
    f.vz += (-A.flinchStiffness * f.z - A.flinchDamping * f.vz) * dt;
    f.x += f.vx * dt;
    f.z += f.vz * dt;

    if (!b.spine && !b.chest) return;
    // body frame in world space
    this.root.parent?.updateWorldMatrix(true, false);
    const bodyQ = (this.root.parent ?? this.root).getWorldQuaternion(new THREE.Quaternion());
    const right = _axis.set(1, 0, 0).applyQuaternion(bodyQ).setY(0).normalize().clone();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ).setY(0).normalize();

    const chain = [b.spine, b.chest, b.upperChest].filter(Boolean);
    const spread = A.aimSpread;
    const aw = a.w * k;
    chain.forEach((bone, i) => {
      const share = chain.length === spread.length ? spread[i] : 1 / chain.length;
      if (aw > 1e-3) {
        rotateWorld(bone, _r.setFromAxisAngle(UP, a.yaw * aw * share));
        rotateWorld(bone, _r.setFromAxisAngle(right, -a.pitch * aw * share));
      }
      // flinch: bend away from the hit
      if (Math.abs(f.x) + Math.abs(f.z) > 1e-3) {
        rotateWorld(bone, _r.setFromAxisAngle(right, -f.z * 0.28));
        rotateWorld(bone, _r.setFromAxisAngle(fwd, f.x * 0.28));
      }
    });
    const lw = l.w * k;
    if (lw > 1e-3) {
      // the head follows what is left after the torso aim
      const yaw = l.yaw - a.yaw * aw;
      const pitch = l.pitch - a.pitch * aw;
      if (b.neck) {
        rotateWorld(b.neck, _r.setFromAxisAngle(UP, yaw * lw * 0.4));
        rotateWorld(b.neck, _r.setFromAxisAngle(right, -pitch * lw * 0.4));
      }
      if (b.head) {
        const share = b.neck ? 0.6 : 1;
        rotateWorld(b.head, _r.setFromAxisAngle(UP, yaw * lw * share));
        rotateWorld(b.head, _r.setFromAxisAngle(right, -pitch * lw * share));
      }
    }
    if (b.head && Math.abs(f.z) > 1e-3) rotateWorld(b.head, _r.setFromAxisAngle(right, -f.z * 0.35));
  }

  // ---------- hit flash (per-instance materials) ----------
  _materials() {
    if (this._mats) return this._mats;
    this._mats = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const own = (m) => {
        const c = m.clone();
        this._mats.push({ m: c, e: c.emissive ? c.emissive.clone() : null, i: c.emissiveIntensity ?? 0 });
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
    });
    return this._mats;
  }

  _applyFlash(u) {
    const mats = this._materials();
    this._flashOn = u > 0;
    for (const r of mats) {
      if (!r.e) continue;
      r.m.emissive.copy(r.e).lerp(FLASH, u * 0.85);
      r.m.emissiveIntensity = r.i + this.cfg.flashGain * u;
    }
  }

  /** Whole-model tint override (drone / boss telegraphs): pass null to clear. */
  tint(color, amount) {
    const mats = this._materials();
    for (const r of mats) {
      if (!r.e) continue;
      if (color == null) {
        r.m.emissive.copy(r.e);
        r.m.emissiveIntensity = r.i;
      } else {
        r.m.emissive.copy(r.e).lerp(color, clamp(amount, 0, 1));
        r.m.emissiveIntensity = r.i + amount;
      }
    }
  }

  dispose() {
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.root);
    if (this._mats) for (const r of this._mats) r.m.dispose();
  }
}

const FLASH = new THREE.Color(0xffffff);

export { wrapPi, damp, clamp, smooth };

const _pU = new THREE.Vector3();
const _pL = new THREE.Vector3();
const _pE = new THREE.Vector3();
const _toT = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _sq = new THREE.Quaternion();

/**
 * Analytic two-bone IK in world space (arm: upper, lower, hand). The elbow bends toward `pole` (world point).
 * Call after the mixer; world matrices of the chain are refreshed here.
 */
export function solveLimb(upper, lower, end, target, pole, weight = 1) {
  if (weight <= 1e-3 || !upper || !lower || !end || !upper.parent) return;
  upper.parent.updateWorldMatrix(true, false);
  upper.updateWorldMatrix(false, true);
  upper.getWorldPosition(_pU);
  lower.getWorldPosition(_pL);
  end.getWorldPosition(_pE);
  const la = _pU.distanceTo(_pL);
  const lb = _pL.distanceTo(_pE);
  if (la < 1e-5 || lb < 1e-5) return;
  _toT.subVectors(target, _pU);
  const d = clamp(_toT.length(), 0.02, (la + lb) * 0.995);
  _toT.normalize();
  _mid.subVectors(pole, _pU);
  _mid.addScaledVector(_toT, -_mid.dot(_toT));
  if (_mid.lengthSq() < 1e-8) _mid.set(0, -1, 0);
  _mid.normalize();
  const cosA = clamp((la * la + d * d - lb * lb) / (2 * la * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _elbow.copy(_pU).addScaledVector(_toT, la * cosA).addScaledVector(_mid, la * sinA);
  const swing = (bone, from, to) => {
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    _sq.setFromUnitVectors(from.normalize(), to.normalize());
    bone.getWorldQuaternion(_wq);
    bone.parent.getWorldQuaternion(_pq);
    _q.copy(_pq).invert().multiply(_sq.multiply(_wq));
    bone.quaternion.slerp(_q, weight);
    bone.updateWorldMatrix(false, true);
  };
  swing(upper, _a.subVectors(_pL, _pU), _b.subVectors(_elbow, _pU));
  lower.getWorldPosition(_pL);
  end.getWorldPosition(_pE);
  swing(lower, _a.subVectors(_pE, _pL), _b.subVectors(target, _pL));
}
