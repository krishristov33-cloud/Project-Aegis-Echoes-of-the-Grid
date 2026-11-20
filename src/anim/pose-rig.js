// Procedural clip authoring rig.
//
// Clips are authored as sparse keyframes on a small set of character-space channels (see CHANNELS below) and
// baked to ordinary THREE.AnimationClips on the SOURCE humanoid (the manifest role flagged `procClips`). From
// there they go through the normal retarget pipeline (src/core/retarget.js), so every humanoid role gets them
// and no vendor bone name is ever written here: bones are reached only through the canonical bone map.
//
// Character space: +Z forward, +Y up, +X the character's left. Angles in degrees, lengths in metres for a
// character whose hips rest 1 m above the ground (scaled to the real rig).
//
//   hipsPos  [x, y, z]            pelvis offset from rest
//   hips     [pitch, yaw, roll]   pitch + = bow forward, yaw + = turn left, roll + = tip to the right
//   spine / chest / upperChest / neck / head   [pitch, yaw, roll], each relative to its parent
//   torso    [pitch, yaw, roll]   shorthand, spread evenly over spine, chest and upperChest
//   shL / shR        [raise, fwd]            clavicles
//   armL / armR      [down, swing, twist]    down: 0 = T-pose, 90 = hanging, -90 = straight up;
//                                            swing: rotates the lowered arm forward (+) / back (-)
//   elbowL / elbowR  bend
//   handTL / handTR  [x, y, z]    hand IK target in character space (origin on the ground under the rest pelvis),
//   ikL / ikR        0..1         weight of that target over the FK arm above
//   poleL / poleR    [x, y, z]    which way the elbow points while on IK
//   headAbs          0..1         1 = `head` is absolute in character space (keeps the eyes level while the torso twists)
//   handL / handR    [pitch, yaw, roll]
//   footL / footR    [x, y, z]    ankle offset from its rest spot, in character space (legs are solved by IK,
//                                 so feet stay where they are put while the pelvis moves)
//   footRotL / footRotR [pitch, yaw, roll]   pitch + = toes down
//   kneeL / kneeR    [x, z]       knee pole direction (default: forward, slightly out)
//   toeL / toeR      bend
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { findNamedNode } from '../core/bones.js';

const D2R = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

export const DEFAULT_POSE = Object.freeze({
  hipsPos: [0, 0, 0], hips: [0, 0, 0],
  spine: [0, 0, 0], chest: [0, 0, 0], upperChest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], torso: [0, 0, 0],
  shL: [0, 0], shR: [0, 0],
  armL: [76, 4, 0], armR: [76, 4, 0], elbowL: 14, elbowR: 14,
  handL: [0, 0, 0], handR: [0, 0, 0],
  handTL: [0.3, 1.0, 0.3], handTR: [-0.3, 1.0, 0.3], ikL: 0, ikR: 0,
  poleL: [0.5, -0.7, -0.5], poleR: [-0.5, -0.7, -0.5], headAbs: 0,
  footL: [0, 0, 0], footR: [0, 0, 0], footRotL: [0, 0, 0], footRotR: [0, 0, 0],
  kneeL: [0.12, 1], kneeR: [-0.12, 1], toeL: 0, toeR: 0,
});

const SPINE_CHAIN = ['spine', 'chest', 'upperChest', 'neck', 'head'];
const PARENT = { spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck' };
const ORDER = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
];

const _e = new THREE.Euler();
const qEuler = (p, y, r, out = new THREE.Quaternion()) => out.setFromEuler(_e.set(p * D2R, y * D2R, r * D2R, 'YXZ'));
const qAxis = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(axis, deg * D2R);

/** Rotation taking the orthonormal frame (up0, fwd0) onto (up1, fwd1). */
function frameDelta(u0, f0, u1, f1) {
  const basis = (u, f) => {
    const uu = u.clone().normalize();
    const ff = f.clone().addScaledVector(uu, -f.dot(uu));
    if (ff.lengthSq() < 1e-8) ff.set(0, 0, 1).addScaledVector(uu, -uu.z);
    ff.normalize();
    const s = new THREE.Vector3().crossVectors(uu, ff);
    return new THREE.Matrix4().makeBasis(s, uu, ff);
  };
  const m = basis(u1, f1).multiply(basis(u0, f0).transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export class PoseRig {
  /** @param {THREE.Object3D} sourceRoot  loaded role root  @param {object} boneMap canonical -> rig bone name */
  constructor(sourceRoot, boneMap) {
    const root = SkeletonUtils.clone(sourceRoot);
    root.position.set(0, 0, 0); root.quaternion.identity();
    root.updateMatrixWorld(true);
    this.root = root;
    const byName = {};
    root.traverse((o) => { if (o.name) byName[o.name] = o; });
    this.node = {};
    for (const [c, name] of Object.entries(boneMap || {})) {
      const n = findNamedNode(byName, name);
      if (n) this.node[c] = n;
    }
    this.ok = !!(this.node.hips && this.node.leftUpperLeg && this.node.leftFoot);
    if (!this.ok) return;
    const rootInv = new THREE.Quaternion();
    root.getWorldQuaternion(rootInv).invert();
    this.restRR = {}; this.restPos = {}; this.restLocal = new Map();
    root.traverse((o) => this.restLocal.set(o, o.quaternion.clone()));
    for (const c of Object.keys(this.node)) {
      this.restRR[c] = this.node[c].getWorldQuaternion(new THREE.Quaternion()).premultiply(rootInv);
      this.restPos[c] = root.worldToLocal(this.node[c].getWorldPosition(new THREE.Vector3()));
    }
    this.k = this.restPos.hips.y; // metres -> rig units (authored for a 1 m hip height)
    const hp = this.node.hips.parent;
    this.hipParentInv = new THREE.Matrix4();
    if (hp && hp !== root) this.hipParentInv.copy(root.matrixWorld).invert().multiply(hp.matrixWorld).invert();
    this.present = ORDER.filter((c) => this.node[c]);
    this._rr = new Map();
  }

  _legIK(side, P, hipsPos, Dh, D) {
    const L = side === 'L';
    const up = L ? 'leftUpperLeg' : 'rightUpperLeg', lo = L ? 'leftLowerLeg' : 'rightLowerLeg';
    const ft = L ? 'leftFoot' : 'rightFoot', toe = L ? 'leftToes' : 'rightToes';
    if (!this.node[up] || !this.node[lo] || !this.node[ft]) return;
    const R = this.restPos, k = this.k;
    const hip = R[up].clone().sub(R.hips).applyQuaternion(Dh).add(hipsPos);
    const fo = P['foot' + side], fr = P['footRot' + side], kp = P['knee' + side];
    const target = R[ft].clone().add(new THREE.Vector3(fo[0] * k, fo[1] * k, fo[2] * k));
    const a = R[lo].distanceTo(R[up]), b = R[ft].distanceTo(R[lo]);
    const toT = target.clone().sub(hip);
    const d = Math.max(0.05 * k, Math.min((a + b) * 0.9995, toT.length()));
    const dir = toT.lengthSq() > 1e-10 ? toT.normalize() : new THREE.Vector3(0, -1, 0);
    const yaw = (P.hips[1] * 0.5 + fr[1] * 0.5) * D2R;
    const pole = new THREE.Vector3(kp[0], 0, kp[1]).applyAxisAngle(Y, yaw);
    const m = pole.addScaledVector(dir, -pole.dot(dir));
    if (m.lengthSq() < 1e-8) m.set(0, 0, 1);
    m.normalize();
    const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const knee = hip.clone().addScaledVector(dir, a * cosA).addScaledVector(m, a * sinA);
    const ankle = hip.clone().addScaledVector(dir, d);
    D[up] = frameDelta(R[lo].clone().sub(R[up]), Z, knee.clone().sub(hip), m);
    D[lo] = frameDelta(R[ft].clone().sub(R[lo]), Z, ankle.clone().sub(knee), m);
    D[ft] = qEuler(fr[0], fr[1], fr[2]);
    if (this.node[toe]) D[toe] = D[ft].clone().multiply(qAxis(X, P['toe' + side]));
  }

  /** Pose the private skeleton from a full channel set. Returns the hips local position. */
  apply(P) {
    const D = {};
    const k = this.k;
    const Dh = D.hips = qEuler(P.hips[0], P.hips[1], P.hips[2]);
    const hipsPos = this.restPos.hips.clone().add(new THREE.Vector3(P.hipsPos[0] * k, P.hipsPos[1] * k, P.hipsPos[2] * k));
    const t3 = P.torso;
    let top = 'hips';
    const pos = { hips: hipsPos };
    const R = this.restPos;
    const place = (c, parent) => { pos[c] = R[c].clone().sub(R[parent]).applyQuaternion(D[parent]).add(pos[parent]); };
    for (const c of SPINE_CHAIN) {
      if (!this.node[c]) continue;
      const v = P[c];
      const share = (c === 'spine' || c === 'chest' || c === 'upperChest') ? 1 / 3 : 0;
      D[c] = D[top].clone().multiply(qEuler(v[0] + t3[0] * share, v[1] + t3[1] * share, v[2] + t3[2] * share));
      place(c, top);
      top = c;
    }
    if (D.head && P.headAbs > 0) {
      const abs = qEuler(P.head[0], P.head[1], P.head[2]);
      const under = D.neck ? 'neck' : null;
      const base = D.upperChest || D.chest || D.spine || Dh;
      if (under) D.neck = base.clone().slerp(abs, 0.5 * P.headAbs).multiply(qEuler(P.neck[0], 0, 0));
      D.head.slerp(abs, Math.min(1, P.headAbs));
    }
    const chestName = D.upperChest ? 'upperChest' : D.chest ? 'chest' : D.spine ? 'spine' : 'hips';
    // if the rig has fewer than three spine bones, the missing shares are simply dropped (fine for a shorthand)
    const chestTop = D.upperChest || D.chest || D.spine || Dh;
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const pre = side === 'L' ? 'left' : 'right';
      const sh = P['sh' + side], arm = P['arm' + side];
      const Dsh = chestTop.clone().multiply(qAxis(Z, s * sh[0])).multiply(qAxis(Y, -s * sh[1]));
      let armParent = chestName;
      if (this.node[pre + 'Shoulder']) { place(pre + 'Shoulder', chestName); D[pre + 'Shoulder'] = Dsh; armParent = pre + 'Shoulder'; }
      const Dup = Dsh.clone()
        .multiply(qAxis(X, -arm[1]))
        .multiply(qAxis(Z, -s * arm[0]))
        .multiply(qAxis(X, arm[2]));
      const Dlo = Dup.clone().multiply(qAxis(Y, -s * P['elbow' + side]));
      const w = P['ik' + side];
      const upN = pre + 'UpperArm', loN = pre + 'LowerArm', haN = pre + 'Hand';
      if (w > 0 && this.node[upN] && this.node[loN] && this.node[haN]) {
        // two-bone IK from the shoulder joint to the hand target
        const S = R[upN].clone().sub(R[armParent]).applyQuaternion(armParent === chestName ? D[chestName] : Dsh).add(pos[armParent]);
        const ht = P['handT' + side], pl = P['pole' + side];
        const a = R[loN].distanceTo(R[upN]), b = R[haN].distanceTo(R[loN]);
        const toT = new THREE.Vector3(ht[0] * k, ht[1] * k, ht[2] * k).sub(S);
        const d = Math.max(0.05 * k, Math.min((a + b) * 0.999, toT.length()));
        const dir = toT.lengthSq() > 1e-10 ? toT.normalize() : new THREE.Vector3(0, -1, 0);
        const m = new THREE.Vector3(pl[0], pl[1], pl[2]);
        m.addScaledVector(dir, -m.dot(dir));
        if (m.lengthSq() < 1e-8) m.set(0, -1, 0);
        m.normalize();
        const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
        const elbow = S.clone().addScaledVector(dir, a * cosA).addScaledVector(m, a * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
        const hand = S.clone().addScaledVector(dir, d);
        const back = new THREE.Vector3(0, 0, -1);
        const ikUp = frameDelta(R[loN].clone().sub(R[upN]), back, elbow.clone().sub(S), m);
        const ikLo = frameDelta(R[haN].clone().sub(R[loN]), back, hand.clone().sub(elbow), m);
        Dup.slerp(ikUp, Math.min(1, w));
        Dlo.slerp(ikLo, Math.min(1, w));
      }
      D[upN] = Dup;
      D[loN] = Dlo;
      const h = P['hand' + side];
      D[pre + 'Hand'] = Dlo.clone().multiply(qAxis(Z, -s * h[0])).multiply(qAxis(Y, -s * h[1])).multiply(qAxis(X, h[2]));
      this._legIK(side, P, hipsPos, Dh, D);
    }

    // world-delta -> local quaternions, parents first
    const rr = this._rr; rr.clear();
    const rrOf = (n) => {
      if (n === this.root || !n) return null;
      if (rr.has(n)) return rr.get(n);
      const p = rrOf(n.parent);
      const q = this.restLocal.get(n).clone();
      if (p) q.premultiply(p);
      return q; // not cached: only used for static in-between nodes
    };
    for (const c of this.present) {
      const n = this.node[c];
      const want = (D[c] || new THREE.Quaternion()).clone().multiply(this.restRR[c]);
      const p = rrOf(n.parent);
      n.quaternion.copy(p ? p.clone().invert().multiply(want) : want);
      rr.set(n, want);
    }
    return hipsPos.applyMatrix4(this.hipParentInv);
  }
}

// ---------- keyframe evaluation ----------

/** Per-channel sparse keys -> value at time t (cubic Hermite through the keys; `stop` keys have flat tangents). */
function buildChannel(keys, name, dur, loop) {
  const ks = [];
  for (const key of keys) if (key[name] !== undefined) ks.push({ t: key.t, v: key[name], stop: !!key.stop, lin: !!key.lin });
  if (!ks.length) return null;
  const isArr = Array.isArray(ks[0].v);
  const n = isArr ? ks[0].v.length : 1;
  const val = (k, i) => (isArr ? k.v[i] : k.v);
  const tan = (j, i) => {
    const k = ks[j];
    if (k.stop) return 0;
    let a = ks[j - 1], b = ks[j + 1];
    let ta = a?.t, tb = b?.t;
    if (loop && ks.length > 2) {
      if (!a) { a = ks[ks.length - 2]; ta = a.t - dur; }
      if (!b) { b = ks[1]; tb = b.t + dur; }
    }
    if (!a || !b) return 0;
    const va = val(a, i), vb = val(b, i), v = val(k, i);
    // monotone guard: a key that is a local extreme gets a flat tangent (no overshoot past authored poses)
    if ((v - va) * (vb - v) <= 0) return 0;
    return (vb - va) / Math.max(1e-5, tb - ta);
  };
  const tans = ks.map((_, j) => Array.from({ length: n }, (_, i) => tan(j, i)));
  return (t) => {
    let j = 0;
    while (j < ks.length - 2 && t > ks[j + 1].t) j++;
    const a = ks[j], b = ks[j + 1] || a;
    const span = b.t - a.t;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const va = val(a, i), vb = val(b, i);
      if (span <= 1e-6 || t <= a.t) { out[i] = t <= a.t ? va : vb; continue; }
      if (t >= b.t) { out[i] = vb; continue; }
      const u = (t - a.t) / span;
      if (b.lin) { out[i] = va + (vb - va) * u; continue; }
      const u2 = u * u, u3 = u2 * u;
      out[i] = (2 * u3 - 3 * u2 + 1) * va + (u3 - 2 * u2 + u) * span * tans[j][i]
        + (-2 * u3 + 3 * u2) * vb + (u3 - u2) * span * tans[j + 1][i];
    }
    return isArr ? out : out[0];
  };
}

/**
 * Bake one clip definition.
 * def: { name, dur, loop?, fps?, base?: pose overrides, keys: [{ t, stop?, lin?, ...channels }] }
 * Channels a key leaves out are interpolated from that channel's own neighbouring keys (or the base pose).
 */
export function bakeClip(rig, def) {
  const fps = def.fps ?? 30;
  const base = { ...DEFAULT_POSE, ...(def.base || {}) };
  const keys = [...def.keys].sort((a, b) => a.t - b.t);
  const chans = {};
  for (const name of Object.keys(DEFAULT_POSE)) chans[name] = buildChannel(keys, name, def.dur, def.loop);
  const n = Math.max(2, Math.round(def.dur * fps) + 1);
  const times = new Float32Array(n);
  const q = Object.fromEntries(rig.present.map((c) => [c, new Float32Array(n * 4)]));
  const pos = new Float32Array(n * 3);
  const P = {};
  for (let i = 0; i < n; i++) {
    const t = (def.dur * i) / (n - 1);
    times[i] = t;
    for (const name of Object.keys(DEFAULT_POSE)) P[name] = chans[name] ? chans[name](t) : base[name];
    rig.apply(P).toArray(pos, i * 3);
    for (const c of rig.present) rig.node[c].quaternion.toArray(q[c], i * 4);
  }
  // keep quaternion signs continuous so the track interpolates the short way
  for (const c of rig.present) {
    const a = q[c];
    for (let i = 1; i < n; i++) {
      const o = i * 4, p = o - 4;
      if (a[o] * a[p] + a[o + 1] * a[p + 1] + a[o + 2] * a[p + 2] + a[o + 3] * a[p + 3] < 0) {
        a[o] = -a[o]; a[o + 1] = -a[o + 1]; a[o + 2] = -a[o + 2]; a[o + 3] = -a[o + 3];
      }
    }
  }
  const tracks = rig.present.map((c) => new THREE.QuaternionKeyframeTrack(`${rig.node[c].name}.quaternion`, times, q[c]));
  tracks.push(new THREE.VectorKeyframeTrack(`${rig.node.hips.name}.position`, times, pos));
  const clip = new THREE.AnimationClip(def.name, def.dur, tracks);
  clip.userData = { procedural: true, loop: !!def.loop, events: def.events || {} };
  return clip;
}
