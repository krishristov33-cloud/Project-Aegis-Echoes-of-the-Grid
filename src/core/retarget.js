// A1 (Aether): retarget animation clips from a source humanoid rig onto a
// target humanoid rig, through the canonical boneMaps (see bones.js).
//
// Method: rest-pose-compensated world-delta retarget, baked per frame.
//   targetRootRel(t) = sourceRootRel(t) * inv(sourceRootRel_rest) * targetRootRel_rest
// so a T-pose source (Mixamo/Xbot, UAL) drives an A-pose target (Meshy) without
// the arms clipping, and reversed spine naming never matters (we only match
// canonical slots). Unmapped target bones keep their rest local pose.
// Hips translation is scaled by target/source rest hip height.
//
// Without a source, retargetClips() passes clips through (Mixamo-compatible GLBs).

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { findNamedNode } from './bones.js';

/** Meshy `3d_rigging` 24-joint humanoid. NOTE: its spine is reversed vs Mixamo
 *  (Spine02 is lowest, Spine is highest), so never rely on name auto-detect. */
export const MESHY24_BONE_MAP = Object.freeze({
  hips: 'Hips',
  spine: 'Spine02',
  chest: 'Spine01',
  upperChest: 'Spine',
  neck: 'neck',
  head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
});

/** True if a loaded scene carries the Meshy 24-joint rig. */
export function isMeshy24(root) {
  let a = false, b = false;
  root.traverse((o) => { if (o.name === 'Spine02') a = true; if (o.name === 'headfront') b = true; });
  return a && b;
}

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function rootRelQuat(node, root, out) {
  node.getWorldQuaternion(out);
  root.getWorldQuaternion(_qi).invert();
  return out.premultiply(_qi);
}
function rootRelPos(node, root, out) {
  node.getWorldPosition(out);
  return root.worldToLocal(out);
}
function resolve(root, map) {
  const byName = {};
  root.traverse((o) => { if (o.name) byName[o.name] = o; });
  const out = {};
  for (const [canon, name] of Object.entries(map || {})) {
    const n = findNamedNode(byName, name);
    if (n) out[canon] = n;
  }
  return out;
}
function clipTimes(clip, fps) {
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = (clip.duration * i) / (n - 1);
  return t;
}

/**
 * @param {THREE.AnimationClip[]} clips  clips authored on the SOURCE rig
 * @param {{ sourceRoot?, sourceBoneMap?, targetRoot?, targetBoneMap?, fps?, inPlace?, suffix? }} ctx
 * @returns {THREE.AnimationClip[]} clips that animate the TARGET rig by bone name
 */
export function retargetClips(clips, ctx = {}) {
  const { sourceRoot, sourceBoneMap, targetRoot, targetBoneMap } = ctx;
  if (!clips?.length || !sourceRoot || !targetRoot || !sourceBoneMap || !targetBoneMap) return clips || [];
  const fps = ctx.fps ?? 30;

  // Work on private clones so live instances are never touched.
  const src = SkeletonUtils.clone(sourceRoot);
  const tgt = SkeletonUtils.clone(targetRoot);
  src.position.set(0, 0, 0); src.quaternion.identity();
  tgt.position.set(0, 0, 0); tgt.quaternion.identity();
  src.updateMatrixWorld(true); tgt.updateMatrixWorld(true);

  const S = resolve(src, sourceBoneMap);
  const T = resolve(tgt, targetBoneMap);
  const slots = Object.keys(T).filter((c) => S[c]);
  if (!slots.length || !S.hips || !T.hips) return clips;
  const slotOf = new Map(slots.map((c) => [T[c], c]));

  // Rest snapshots (scene default pose = bind pose for glTF exports).
  const sRest = {}, tRest = {};
  for (const c of slots) {
    sRest[c] = rootRelQuat(S[c], src, new THREE.Quaternion());
    tRest[c] = rootRelQuat(T[c], tgt, new THREE.Quaternion());
  }
  // Rest-pose alignment (T-pose source vs A-pose target): per slot, the swing that
  // turns the target rest bone direction onto the source rest direction. Folded
  // into tRest so the delta formula reproduces the source's limb DIRECTIONS.
  const CHILD = {
    hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
    leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand',
    rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
    leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
    rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
  };
  const INHERIT = { head: 'neck', leftHand: 'leftLowerArm', rightHand: 'rightLowerArm', leftToes: 'leftFoot', rightToes: 'rightFoot' };
  const align = {};
  if (ctx.alignRest !== false) {
    const ps = new THREE.Vector3(), pt = new THREE.Vector3(), ds = new THREE.Vector3(), dt = new THREE.Vector3();
    for (const c of slots) {
      const k = CHILD[c];
      if (c === 'hips' || !k || !S[k] || !T[k]) continue;
      ds.copy(rootRelPos(S[k], src, ps)).sub(rootRelPos(S[c], src, _v)).normalize();
      dt.copy(rootRelPos(T[k], tgt, pt)).sub(rootRelPos(T[c], tgt, _v)).normalize();
      if (ds.lengthSq() > 0.5 && dt.lengthSq() > 0.5) align[c] = new THREE.Quaternion().setFromUnitVectors(dt, ds);
    }
    for (const [c, p] of Object.entries(INHERIT)) if (!align[c] && align[p] && T[c]) align[c] = align[p];
    for (const c of slots) if (align[c]) tRest[c].premultiply(align[c]);
  }
  const sHip0 = rootRelPos(S.hips, src, new THREE.Vector3());
  const tHip0 = rootRelPos(T.hips, tgt, new THREE.Vector3());
  const hipScale = Math.abs(sHip0.y) > 1e-4 ? tHip0.y / sHip0.y : 1;
  // hips parent is assumed static (Armature node); cache its inverse root-rel matrix
  const hipParent = T.hips.parent;
  const hipParentInv = new THREE.Matrix4();
  if (hipParent && hipParent !== tgt) {
    hipParentInv.copy(tgt.matrixWorld).invert().multiply(hipParent.matrixWorld).invert();
  }

  // Target nodes in parent-before-child order, with rest locals.
  const order = [];
  tgt.traverse((o) => { if (o !== tgt) order.push(o); });
  const restLocal = new Map(order.map((o) => [o, o.quaternion.clone()]));

  const mixer = new THREE.AnimationMixer(src);
  const out = [];
  for (const clip of clips) {
    const times = clipTimes(clip, fps);
    const qVals = new Map(slots.map((c) => [c, new Float32Array(times.length * 4)]));
    const pVals = new Float32Array(times.length * 3);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; // t = duration must sample the last key, not wrap to 0
    action.reset().play();
    const rr = new Map(); // target node -> root-relative quat this frame
    for (let i = 0; i < times.length; i++) {
      mixer.setTime(times[i]);
      src.updateMatrixWorld(true);
      for (const o of order) {
        const parentRR = o.parent === tgt ? null : rr.get(o.parent);
        let q = rr.get(o) || new THREE.Quaternion();
        const c = slotOf.get(o);
        if (c) {
          rootRelQuat(S[c], src, _q);                       // source now
          q.copy(_q).multiply(_qi.copy(sRest[c]).invert()).multiply(tRest[c]);
          // local = inv(parentRR) * q
          const local = parentRR ? _qi.copy(parentRR).invert().multiply(q) : _qi.copy(q);
          local.toArray(qVals.get(c), i * 4);
        } else {
          q.copy(restLocal.get(o));
          if (parentRR) q.premultiply(parentRR);
        }
        rr.set(o, q);
      }
      // hips translation
      rootRelPos(S.hips, src, _v).sub(sHip0).multiplyScalar(hipScale).add(tHip0);
      if (ctx.inPlace) { _v.x = tHip0.x; _v.z = tHip0.z; }
      _v.applyMatrix4(hipParentInv);
      _v.toArray(pVals, i * 3);
    }
    action.stop();
    mixer.uncacheAction(clip);

    const tracks = slots.map((c) => new THREE.QuaternionKeyframeTrack(`${T[c].name}.quaternion`, times, qVals.get(c)));
    tracks.push(new THREE.VectorKeyframeTrack(`${T.hips.name}.position`, times, pVals));
    out.push(new THREE.AnimationClip(clip.name + (ctx.suffix || ''), clip.duration, tracks));
  }
  mixer.uncacheRoot(src);
  return out;
}

/**
 * Give a loaded target role the clips of a loaded source role (both from loadRole()).
 * Mutates and returns `target` (clips, gltf.animations). Keeps target's own clips
 * unless they are the 1-frame Meshy rest clip.
 */
export function retargetRole(target, source, opts = {}) {
  if (!target || !source || target.fallback || source.fallback) return target;
  const srcClips = source.gltf?.animations || Object.values(source.clips || {});
  const baked = retargetClips(srcClips, {
    sourceRoot: source.root, sourceBoneMap: source.boneMap,
    targetRoot: target.root, targetBoneMap: target.boneMap, ...opts,
  });
  const own = (target.gltf?.animations || []).filter((c) => !/clip0\|baselayer/.test(c.name) && c.duration > 0.05);
  const all = [...own, ...baked];
  target.clips = Object.fromEntries(all.map((c) => [c.name, c]));
  if (target.gltf) target.gltf.animations = all;
  // inherit the source clipMap for any logical clip the target doesn't define
  target.clipMap = { ...(source.clipMap || {}), ...Object.fromEntries(Object.entries(target.clipMap || {}).filter(([, v]) => v)) };
  return target;
}
