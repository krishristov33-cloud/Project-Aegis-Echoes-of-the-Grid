// Foot IK + two-bone solver.
// twoBoneIK is adapted from Aether's Kanemori locomotion.js (v0.3).
// Bone lookups go through the canonical humanoid map from src/core/bones.js
// (hips, leftUpperLeg, leftLowerLeg, leftFoot, ...). Never hardcode vendor names.
import * as THREE from 'three';
import { bindBones, resolveBoneMap } from '../core/bones.js';
import { critDamp } from './animTuning.js';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _ax = new THREE.Vector3();

/** Bind canonical bones on a root, using a manifest/auto boneMap if provided. */
export function collectBones(root, boneMap) {
  const map = boneMap && Object.keys(boneMap).length ? boneMap : resolveBoneMap(root);
  return bindBones(root, map);
}

/** Analytic two-bone IK in world space. Elbow/knee bends toward pole. */
export function twoBoneIK(upper, lower, end, target, pole, weight = 1) {
  if (weight <= 0 || !upper || !lower || !end || !upper.parent) return;
  const pU = upper.getWorldPosition(new THREE.Vector3());
  const pL = lower.getWorldPosition(new THREE.Vector3());
  const pE = end.getWorldPosition(new THREE.Vector3());
  const a = pU.distanceTo(pL), b = pL.distanceTo(pE);
  if (a < 1e-5 || b < 1e-5) return;
  const toT = target.clone().sub(pU);
  const d = Math.max(0.01, Math.min((a + b) * 0.999, toT.length()));
  const dir = toT.normalize();
  const m = pole.clone().sub(pU);
  m.addScaledVector(dir, -m.dot(dir));
  if (m.lengthSq() < 1e-8) m.set(0, 0, 1);
  m.normalize();
  const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const elbow = pU.clone().addScaledVector(dir, a * cosA).addScaledVector(m, a * sinA);
  const rot = (bone, from, to) => {
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    const q = _qa.setFromUnitVectors(from.normalize(), to.normalize());
    const wq = bone.getWorldQuaternion(new THREE.Quaternion());
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const nl = pq.invert().multiply(q.multiply(wq));
    bone.quaternion.slerp(nl, weight);
    bone.updateMatrixWorld(true);
  };
  rot(upper, pL.clone().sub(pU), elbow.clone().sub(pU));
  lower.getWorldPosition(pL); end.getWorldPosition(pE);
  rot(lower, pE.clone().sub(pL), target.clone().sub(pL));
}

/**
 * After the mixer has posed the skeleton: drop hips to the lower foot and
 * two-bone-IK each planted foot onto a ground raycast.
 */
export function applyFootIK(root, bones, physics, ikT, weight = 1, dt = 1 / 60) {
  if (weight <= 0.01 || !bones.hips || !physics) return;
  root.updateMatrixWorld(true);
  const hips = bones.hips;
  // the mixer has just written the animated pelvis position; offsets are added on top of it
  const hipOff = ikT.hipOffsetY || 0;
  hips.position.y += hipOff / (ikT.hipUnit || 1);

  const sides = [
    { up: bones.leftUpperLeg, mid: bones.leftLowerLeg, foot: bones.leftFoot, sign: 1 },
    { up: bones.rightUpperLeg, mid: bones.rightLowerLeg, foot: bones.rightFoot, sign: -1 },
  ];
  const sole = ikT.footSole ?? 0.08;
  const rayUp = ikT.rayUp ?? 0.55;
  const rayDown = ikT.rayDown ?? 0.75;
  const plantLift = ikT.plantLift ?? 0.04;
  const plantRange = ikT.plantRange ?? 0.2;
  const st = bones._ikSmooth || (bones._ikSmooth = {
    hip: { p: 0, v: 0 },
    plant: [{ p: 0, v: 0 }, { p: 0, v: 0 }],
    tgtY: [{ p: 0, v: 0, has: false }, { p: 0, v: 0, has: false }],
  });

  const results = [];
  for (let i = 0; i < sides.length; i++) {
    const s = sides[i];
    if (!s.up || !s.mid || !s.foot) { results.push(null); continue; }
    const fp = s.foot.getWorldPosition(new THREE.Vector3());
    const origin = fp.clone(); origin.y += rayUp;
    const hit = physics.raycast(origin, new THREE.Vector3(0, -1, 0), rayUp + rayDown, { ground: true });
    if (!hit) {
      critDamp(st.plant[i], 0, ikT.plantOmega ?? 20, dt);
      results.push(null);
      continue;
    }
    const target = hit.point.clone(); target.y += sole;
    if (!st.tgtY[i].has) { st.tgtY[i].p = target.y; st.tgtY[i].has = true; }
    target.y = critDamp(st.tgtY[i], target.y, ikT.targetYOmega ?? 22, dt);
    const lift = fp.y - target.y;
    const plantRaw = 1 - Math.max(0, Math.min(1, (lift - plantLift) / plantRange));
    const plant = critDamp(st.plant[i], plantRaw * weight, ikT.plantOmega ?? 20, dt);
    results.push({ s, fp, target, hit, lift, plant });
  }

  // Smooth pelvis drop so the lower planted foot can reach without jitter
  let hipDropTgt = 0;
  for (const r of results) {
    if (!r || r.plant < 0.05) continue;
    if (r.lift > 0) hipDropTgt = Math.max(hipDropTgt, Math.min(ikT.maxHipDrop ?? 0.2, r.lift * r.plant));
  }
  const hipDrop = critDamp(st.hip, hipDropTgt, ikT.hipOmega ?? 18, dt);
  if (Math.abs(hipDrop) > 0.0005) {
    hips.position.y -= hipDrop / (ikT.hipUnit || 1);
    hips.updateMatrixWorld(true);
    root.updateMatrixWorld(true);
  }

  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.getWorldQuaternion(_qb)).setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); else fwd.normalize();

  for (const r of results) {
    if (!r || r.plant < 0.02) continue;
    const knee = r.s.mid.getWorldPosition(new THREE.Vector3());
    // Pole: existing knee bend, nudged forward so the knee stays ahead of the hip-ankle line
    const pole = knee.clone().addScaledVector(fwd, 0.35);
    pole.y = knee.y;
    // Re-read target after hip drop: keep world XZ of animated foot, Y of (smoothed) ground
    const fp = r.s.foot.getWorldPosition(new THREE.Vector3());
    const target = r.target.clone(); target.x = fp.x; target.z = fp.z;
    twoBoneIK(r.s.up, r.s.mid, r.s.foot, target, pole, r.plant);
    // pitch / roll the planted foot onto the surface it stands on
    const n = r.hit.normal;
    const align = (ikT.footAlign ?? 0) * r.plant;
    if (align > 0.01 && n && n.y > 0.5 && n.y < 0.9995) {
      const maxA = (ikT.footAlignMaxDeg ?? 30) * Math.PI / 180;
      const ang = Math.min(maxA, Math.acos(Math.min(1, n.y))) * align;
      const axis = _ax.set(n.z, 0, -n.x).normalize(); // up x normal
      _qa.setFromAxisAngle(axis, ang);
      r.s.foot.parent.updateWorldMatrix(true, false);
      const pw = r.s.foot.parent.getWorldQuaternion(_qb);
      const fw = _qc.copy(pw).multiply(r.s.foot.quaternion);
      r.s.foot.quaternion.copy(pw.invert().multiply(_qa.multiply(fw)));
    }
  }
}
