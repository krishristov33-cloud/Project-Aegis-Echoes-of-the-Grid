// Auto-rigged models (Meshy) are bound in an A-pose with the hands next to the thighs, so some hand / forearm
// vertices carry leg or hip weights (and the generated mesh can even be fused there). As soon as an arm lifts,
// that skin stretches into ribbons between the hand and the hip. This repairs the geometry once per mesh:
//   1. a vertex weighted to both an arm chain and the hips/legs keeps only the stronger side,
//   2. triangles that still bridge an arm vertex and a hip/leg vertex are dropped.
// Geometry is shared by every clone of the role, so the fix runs once (flagged in geometry.userData).
//
//   fixLimbBleed(loaded.root, loaded.bones)   // canonical bones from loadRole()

function chain(bone, out = new Set()) {
  bone?.traverse((o) => out.add(o));
  return out;
}

export function fixLimbBleed(root, bones) {
  if (!bones?.hips || !bones.leftUpperArm || !bones.rightUpperArm) return 0;
  const arms = chain(bones.leftUpperArm);
  chain(bones.rightUpperArm, arms);
  const legs = chain(bones.leftUpperLeg);
  chain(bones.rightUpperLeg, legs);
  legs.add(bones.hips);
  let fixed = 0;
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    const g = o.geometry;
    if (g.userData.limbBleedFixed) return;
    g.userData.limbBleedFixed = true;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    if (!si || !sw) return;
    const kind = o.skeleton.bones.map((b) => (arms.has(b) ? 1 : legs.has(b) ? 2 : 0));
    const n = si.count;
    const cls = new Uint8Array(n); // 1 arm, 2 leg/hips, 0 other
    for (let v = 0; v < n; v++) {
      const idx = [si.getX(v), si.getY(v), si.getZ(v), si.getW(v)];
      const w = [sw.getX(v), sw.getY(v), sw.getZ(v), sw.getW(v)];
      let wa = 0;
      let wl = 0;
      let wo = 0;
      for (let k = 0; k < 4; k++) {
        const c = kind[idx[k]];
        if (c === 1) wa += w[k];
        else if (c === 2) wl += w[k];
        else wo += w[k];
      }
      if (wa > 0 && wl > 0) {
        const drop = wa >= wl ? 2 : 1;
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          if (kind[idx[k]] === drop) w[k] = 0;
          sum += w[k];
        }
        if (sum > 1e-6) sw.setXYZW(v, w[0] / sum, w[1] / sum, w[2] / sum, w[3] / sum);
        if (drop === 2) wl = 0;
        else wa = 0;
        fixed++;
      }
      cls[v] = wa > wl && wa > wo * 0.5 ? 1 : wl > wa && wl > wo * 0.5 ? 2 : 0;
    }
    sw.needsUpdate = true;
    // drop triangles that bridge an arm and a leg
    const index = g.index;
    if (index) {
      const src = index.array;
      const out = new src.constructor(src.length);
      let m = 0;
      for (let i = 0; i < src.length; i += 3) {
        const a = cls[src[i]];
        const b = cls[src[i + 1]];
        const c = cls[src[i + 2]];
        const hasArm = a === 1 || b === 1 || c === 1;
        const hasLeg = a === 2 || b === 2 || c === 2;
        if (hasArm && hasLeg) {
          fixed++;
          continue;
        }
        out[m++] = src[i];
        out[m++] = src[i + 1];
        out[m++] = src[i + 2];
      }
      if (m !== src.length) {
        g.setIndex(new index.constructor(out.slice(0, m), 1));
        if (g.groups?.length) g.clearGroups();
      }
    }
  });
  return fixed;
}

/**
 * Find a weapon that is modelled into a hand (generated characters often ship holding their rifle): looks at the
 * vertices skinned to `hand` in the bind pose and returns the long axis in the hand bone's local space.
 * @returns {{axis: Vector3, front: number, back: number}|null}  axis points to the muzzle; front/back are the
 *   distances (m) from the wrist to the muzzle / stock. null when the hand holds nothing long.
 */
export function findHeldWeapon(root, hand, { minLength = 0.4, THREE }) {
  let best = null;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton || best) return;
    const bi = o.skeleton.bones.indexOf(hand);
    if (bi < 0) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    if (!pos || !si || !sw) return;
    const toHand = new THREE.Matrix4().multiplyMatrices(o.skeleton.boneInverses[bi], o.bindMatrix);
    const pts = [];
    const p = new THREE.Vector3();
    for (let v = 0; v < pos.count; v++) {
      let w = 0;
      if (si.getX(v) === bi) w += sw.getX(v);
      if (si.getY(v) === bi) w += sw.getY(v);
      if (si.getZ(v) === bi) w += sw.getZ(v);
      if (si.getW(v) === bi) w += sw.getW(v);
      if (w < 0.6) continue;
      pts.push(p.fromBufferAttribute(pos, v).applyMatrix4(toHand).clone());
    }
    if (pts.length < 30) return;
    // principal axis by power iteration on the covariance
    const mean = new THREE.Vector3();
    for (const q of pts) mean.add(q);
    mean.divideScalar(pts.length);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const q of pts) {
      const x = q.x - mean.x, y = q.y - mean.y, z = q.z - mean.z;
      xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
    }
    const a = new THREE.Vector3(1, 0.7, 0.4).normalize();
    for (let i = 0; i < 40; i++) {
      a.set(xx * a.x + xy * a.y + xz * a.z, xy * a.x + yy * a.y + yz * a.z, xz * a.x + yz * a.y + zz * a.z).normalize();
    }
    let min = Infinity, max = -Infinity;
    for (const q of pts) {
      const d = q.dot(a);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    // bone-local units -> metres
    const sc = new THREE.Vector3();
    hand.getWorldScale(sc);
    const unit = sc.x;
    if ((max - min) * unit < minLength) return;
    // the barrel is the longer side seen from the wrist
    if (Math.abs(min) > Math.abs(max)) {
      a.negate();
      [min, max] = [-max, -min];
    }
    best = { axis: a.clone(), front: Math.max(0, max) * unit, back: Math.max(0, -min) * unit, verts: pts.length };
  });
  return best;
}
