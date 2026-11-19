import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { resolveBoneMap, bindBones } from './bones.js';
import { retargetClips } from './retarget.js';

const loader = new GLTFLoader();
const cache = new Map();

export async function loadManifest(url = 'assets/manifest.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest ${res.status} ${url}`);
  return res.json();
}

export function clipOf(roleEntry, logical) {
  const map = roleEntry?.clipMap || {};
  const name = map[logical];
  return name || null;
}

function fallbackMesh(kind, height, radius, color = 0x3df0ff) {
  let geom;
  if (kind === 'sphere') geom = new THREE.SphereGeometry(radius || 0.28, 16, 12);
  else {
    const h = height || 1.8, r = radius || 0.32;
    const cyl = Math.max(0.1, h - 2 * r);
    geom = new THREE.CapsuleGeometry(r, cyl, 6, 12);
  }
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, emissive: color, emissiveIntensity: 0.12 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  if (kind !== 'sphere') mesh.position.y = (height || 1.8) * 0.5;
  const group = new THREE.Group(); group.add(mesh); group.name = 'fallback-' + (kind || 'capsule');
  return group;
}

function normalizeModel(scene, targetHeight) {
  scene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3(); box.getSize(size);
  if (size.y > 0.2 && targetHeight) {
    const s = targetHeight / size.y;
    if (s > 0.05 && s < 20) scene.scale.multiplyScalar(s);
  }
  scene.updateWorldMatrix(true, true);
  const box2 = new THREE.Box3().setFromObject(scene);
  if (Number.isFinite(box2.min.y)) scene.position.y -= box2.min.y;
  scene.updateWorldMatrix(true, true);
  return scene;
}

function loadGLB(url) {
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
  cache.set(url, p);
  return p;
}

/**
 * Load a role from the manifest. Never pass a raw GLB path from gameplay code.
 * @returns {Promise<{role, entry, root, gltf, clips, clipMap, fallback, height, radius}>}
 */
export async function loadRole(role, manifest) {
  const entry = manifest.roles?.[role];
  if (!entry) throw new Error(`unknown role ${role}`);
  const height = entry.height ?? 1.8;
  const radius = entry.radius ?? 0.32;
  const clipMap = entry.clipMap || {};
  if (!entry.url) {
    return { role, entry, root: fallbackMesh(entry.fallback || 'capsule', height, radius), gltf: null, clips: {}, clipMap, boneMap: {}, bones: {}, fallback: true, height, radius };
  }
  try {
    const gltf = await loadGLB(entry.url);
    const scene = SkeletonUtils.clone(gltf.scene);
    scene.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    normalizeModel(scene, height);
    const boneMap = resolveBoneMap(scene, entry.boneMap || {});
    const bones = bindBones(scene, boneMap);
    const rawClips = retargetClips(gltf.animations || [], { targetBoneMap: boneMap, targetRoot: scene });
    const clips = Object.fromEntries(rawClips.map((c) => [c.name, c]));
    return { role, entry, root: scene, gltf: { scene, animations: rawClips }, clips, clipMap, boneMap, bones, fallback: false, height, radius };
  } catch (err) {
    console.warn(`[assets] failed to load ${role} from ${entry.url}, using capsule`, err);
    return { role, entry, root: fallbackMesh(entry.fallback || 'capsule', height, radius, 0xff5a8a), gltf: null, clips: {}, clipMap, boneMap: {}, bones: {}, fallback: true, height, radius };
  }
}
