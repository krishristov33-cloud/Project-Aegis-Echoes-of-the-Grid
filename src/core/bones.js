// Canonical VRM-style humanoid bone map.
// Manifest entries may set `boneMap`: { canonicalName: rigBoneName }.
// If omitted (or partial), auto-detect fills in Mixamo (mixamorig*) and common rigs
// (unprefixed Mixamo, Rigify DEF-*, VRM, generic hips/spine/thigh...).
// IK, locomotion and combat must look up bones only through bindBones() —
// never hardcode a vendor bone name.

export const HUMANOID_BONES = Object.freeze([
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
]);

/** Well-known Mixamo export names (three.js Xbot/Soldier and most Mixamo FBX). */
export const MIXAMO_BONE_MAP = Object.freeze({
  hips: 'mixamorig:Hips',
  spine: 'mixamorig:Spine',
  chest: 'mixamorig:Spine1',
  upperChest: 'mixamorig:Spine2',
  neck: 'mixamorig:Neck',
  head: 'mixamorig:Head',
  leftShoulder: 'mixamorig:LeftShoulder',
  leftUpperArm: 'mixamorig:LeftArm',
  leftLowerArm: 'mixamorig:LeftForeArm',
  leftHand: 'mixamorig:LeftHand',
  rightShoulder: 'mixamorig:RightShoulder',
  rightUpperArm: 'mixamorig:RightArm',
  rightLowerArm: 'mixamorig:RightForeArm',
  rightHand: 'mixamorig:RightHand',
  leftUpperLeg: 'mixamorig:LeftUpLeg',
  leftLowerLeg: 'mixamorig:LeftLeg',
  leftFoot: 'mixamorig:LeftFoot',
  leftToes: 'mixamorig:LeftToeBase',
  rightUpperLeg: 'mixamorig:RightUpLeg',
  rightLowerLeg: 'mixamorig:RightLeg',
  rightFoot: 'mixamorig:RightFoot',
  rightToes: 'mixamorig:RightToeBase',
});

const MIXAMO_PREFIX_RE = /^mixamorig[:_]?/i;

function listBones(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isBone || o.type === 'Bone') out.push(o);
  });
  // some glTFs leave the hips node as a plain Object3D; include named nodes as fallback
  if (!out.length) {
    root.traverse((o) => { if (o.name && o.isObject3D) out.push(o); });
  }
  return out;
}

function stripVendor(name) {
  return String(name || '')
    .replace(MIXAMO_PREFIX_RE, '')
    .replace(/^def[-_.]?/i, '')
    .replace(/^bip[-_.]?01/i, '')
    .replace(/^bip[-_.]?/i, '')
    .replace(/^bone[-_.]?/i, '')
    .replace(/^j[-_.]?/i, '')
    .replace(/^armature\|/i, '');
}

/** three.js GLTFLoader strips reserved chars such as ':' from node names (mixamorig:Hips -> mixamorigHips). */
export function findNamedNode(byName, rigName) {
  if (!rigName) return null;
  if (byName[rigName]) return byName[rigName];
  const noColon = rigName.replace(/:/g, '');
  if (byName[noColon]) return byName[noColon];
  const bare = stripVendor(rigName);
  if (byName[bare]) return byName[bare];
  if (byName['mixamorig' + bare]) return byName['mixamorig' + bare];
  if (byName['mixamorig:' + bare]) return byName['mixamorig:' + bare];
  if (byName['mixamorig_' + bare]) return byName['mixamorig_' + bare];
  // case-insensitive last pass
  const lower = rigName.toLowerCase();
  for (const [k, v] of Object.entries(byName)) {
    if (k.toLowerCase() === lower || k.replace(/:/g, '').toLowerCase() === noColon.toLowerCase()) return v;
  }
  return null;
}

function indexNamed(root) {
  const byName = {};
  root.traverse((o) => { if (o.name) byName[o.name] = o; });
  return byName;
}

function norm(name) {
  return stripVendor(name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// Patterns are matched against norm(boneName). More specific first.
const PATTERNS = {
  hips: [/^(hips?|pelvis|root)$/],
  spine: [/^(spine|spine0?1?)$/],
  chest: [/^(chest|spine0?2|spine1)$/],
  upperChest: [/^(upperchest|spine0?3|spine2)$/],
  neck: [/^neck$/],
  head: [/^head$/],
  leftShoulder: [/^(leftshoulder|lshoulder|shoulderl)$/],
  leftUpperArm: [/^(leftupperarm|leftarm|luparm|upperarml|arml)$/],
  leftLowerArm: [/^(leftlowerarm|leftforearm|lforearm|lowerarml|forearml)$/],
  leftHand: [/^(lefthand|lhand|handl)$/],
  rightShoulder: [/^(rightshoulder|rshoulder|shoulderr)$/],
  rightUpperArm: [/^(rightupperarm|rightarm|ruparm|upperarmr|armr)$/],
  rightLowerArm: [/^(rightlowerarm|rightforearm|rforearm|lowerarmr|forearmr)$/],
  rightHand: [/^(righthand|rhand|handr)$/],
  leftUpperLeg: [/^(leftupperleg|leftupleg|lupleg|thighl|leftthigh|upperlegl|uplegl)$/],
  leftLowerLeg: [/^(leftlowerleg|leftleg|lleg|lowerlegl|shinl|calfl|leftshin)$/],
  leftFoot: [/^(leftfoot|lfoot|footl|leftankle)$/],
  leftToes: [/^(lefttoes|lefttoebase|lefttoe|toebasel|toesl)$/],
  rightUpperLeg: [/^(rightupperleg|rightupleg|rupleg|thighr|rightthigh|upperlegr|uplegr)$/],
  rightLowerLeg: [/^(rightlowerleg|rightleg|rleg|lowerlegr|shinr|calfr|rightshin)$/],
  rightFoot: [/^(rightfoot|rfoot|footr|rightankle)$/],
  rightToes: [/^(righttoes|righttoebase|righttoe|toebaser|toesr)$/],
};

function detectMixamo(byName) {
  if (!Object.keys(byName).some((n) => MIXAMO_PREFIX_RE.test(n) || /^mixamorig/i.test(n))) return null;
  const map = {};
  for (const [canon, mix] of Object.entries(MIXAMO_BONE_MAP)) {
    const hit = findNamedNode(byName, mix);
    if (hit) map[canon] = hit.name;
  }
  return Object.keys(map).length ? map : null;
}

/**
 * Auto-detect a canonical -> rig-bone-name map from a loaded model root.
 */
export function detectBoneMap(root) {
  const bones = listBones(root);
  const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
  const mix = detectMixamo(byName);
  if (mix) return mix;

  const used = new Set();
  const map = {};
  const candidates = bones.map((b) => ({ bone: b, n: norm(b.name) }));
  for (const canon of HUMANOID_BONES) {
    const pats = PATTERNS[canon] || [];
    const hit = candidates.find((c) => !used.has(c.bone) && pats.some((re) => re.test(c.n)));
    if (hit) { map[canon] = hit.bone.name; used.add(hit.bone); }
  }
  return map;
}

/**
 * Merge auto-detect with an optional manifest boneMap (manifest wins per key).
 */
export function resolveBoneMap(root, manifestMap = {}) {
  const auto = detectBoneMap(root);
  const byName = indexNamed(root);
  const out = { ...auto };
  for (const [k, v] of Object.entries(manifestMap || {})) {
    if (!v) continue;
    const node = findNamedNode(byName, v);
    // store the live runtime name so bindBones can look it up
    out[k] = node ? node.name : v;
  }
  return out;
}

/**
 * Bind canonical names to live Object3D bones. Look up only through the returned object.
 */
export function bindBones(root, boneMap) {
  const byName = indexNamed(root);
  const bones = {};
  const resolved = {};
  for (const [canon, rigName] of Object.entries(boneMap || {})) {
    const node = findNamedNode(byName, rigName);
    if (node) { bones[canon] = node; resolved[canon] = node.name; }
    else if (rigName) resolved[canon] = rigName;
  }
  bones._map = resolved;
  bones._all = byName;
  return bones;
}
