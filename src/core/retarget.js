// A1 stub (Aether): retarget animation clips from a source rig onto the
// target humanoid, using canonical boneMaps on both sides.
// Until this is implemented, loadRole returns the GLB's clips as-is
// (fine for Mixamo-compatible sources such as Xbot / Soldier / UAL-after-retarget).

/**
 * @param {THREE.AnimationClip[]} clips
 * @param {{ sourceBoneMap?: object, targetBoneMap?: object, sourceRoot?: object, targetRoot?: object }} _ctx
 * @returns {THREE.AnimationClip[]}
 */
export function retargetClips(clips, _ctx = {}) {
  return clips || [];
}
