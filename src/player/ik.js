// Foot IK + two-bone solver.
// twoBoneIK is adapted from Aether's Kanemori locomotion.js (v0.3).
// Bone lookups go through the canonical humanoid map from src/core/bones.js
// (hips, leftUpperLeg, leftLowerLeg, leftFoot, ...). Never hardcode vendor names.
import * as THREE from 'three';
import { bindBones, resolveBoneMap } from '../core/bones.js';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

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
export function applyFootIK(root, bones, physics, ikT, weight = 1) {
  if (weight <= 0.01 || !bones.hips || !physics) return;
  root.updateMatrixWorld(true);
  const hips = bones.hips;
  if (!hips._ikRest) hips._ikRest = hips.position.clone();
  hips.position.copy(hips._ikRest);

  const sides = [
    { up: bones.leftUpperLeg, mid: bones.leftLowerLeg, foot: bones.leftFoot, sign: 1 },
    { up: bones.rightUpperLeg, mid: bones.rightLowerLeg, foot: bones.rightFoot, sign: -1 },
  ];
  const sole = ikT.footSole ?? 0.08;
  const rayUp = ikT.rayUp ?? 0.55;
  const rayDown = ikT.rayDown ?? 0.75;
  const plantLift = ikT.plantLift ?? 0.04;
  const plantRange = ikT.plantRange ?? 0.2;

  const results = [];
  for (const s of sides) {
    if (!s.up || !s.mid || !s.foot) { results.push(null); continue; }
    const fp = s.foot.getWorldPosition(new THREE.Vector3());
    const origin = fp.clone(); origin.y += rayUp;
    const hit = physics.raycast(origin, new THREE.Vector3(0, -1, 0), rayUp + rayDown, { ground: true });
    if (!hit) { results.push(null); continue; }
    const target = hit.point.clone(); target.y += sole;
    const lift = fp.y - target.y;
    const plant = 1 - Math.max(0, Math.min(1, (lift - plantLift) / plantRange));
    results.push({ s, fp, target, hit, lift, plant: plant * weight });
  }

  // Hip drop so the lower planted foot can reach
  let hipDrop = 0;
  for (const r of results) {
    if (!r || r.plant < 0.05) continue;
    if (r.lift > 0) hipDrop = Math.max(hipDrop, Math.min(ikT.maxHipDrop ?? 0.2, r.lift * r.plant));
  }
  if (hipDrop > 0.001) {
    hips.position.y -= hipDrop;
    hips.updateMatrixWorld(true);
    root.updateMatrixWorld(true);
  }

  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.getWorldQuaternion(_qb)).setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); else fwd.normalize();

  for (const r of results) {
    if (!r || r.plant < 0.02) continue;
    const hipP = r.s.up.getWorldPosition(new THREE.Vector3());
    const knee = r.s.mid.getWorldPosition(new THREE.Vector3());
    // Pole: existing knee bend, nudged forward so the knee stays ahead of the hip-ankle line
    const pole = knee.clone().addScaledVector(fwd, 0.35);
    pole.y = knee.y;
    // Re-read target after hip drop: keep world XZ of animated foot, Y of ground
    const fp = r.s.foot.getWorldPosition(new THREE.Vector3());
    const target = r.target.clone(); target.x = fp.x; target.z = fp.z;
    twoBoneIK(r.s.up, r.s.mid, r.s.foot, target, pole, r.plant);
  }
}
