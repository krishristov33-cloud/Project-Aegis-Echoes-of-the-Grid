import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { resolveBoneMap, bindBones } from './bones.js';
import { retargetClips, retargetRole, MESHY24_BONE_MAP } from './retarget.js';

const loader = new GLTFLoader();
const cache = new Map();
const roleCache = new Map();
let ktx2Loader = null;
let assetsReady = null;

function cdnBase() {
  return (typeof window !== 'undefined' && window.AG_CDN && window.AG_CDN.base)
    ? window.AG_CDN.base
    : 'https://cdn.jsdelivr.net/npm/three@0.164.1/';
}

/**
 * Attach KTX2 + Meshopt decoders so optimized GLBs load on GitHub Pages via the
 * same unpkg / jsDelivr CDN already used for three@0.164.1.
 * Call once after the renderer exists, before the first loadRole().
 */
export async function initAssets(renderer) {
  if (assetsReady) return assetsReady;
  assetsReady = (async () => {
    const base = cdnBase();
    ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath(base + 'examples/jsm/libs/basis/');
    if (renderer) ktx2Loader.detectSupport(renderer);
    loader.setKTX2Loader(ktx2Loader);
    if (MeshoptDecoder && MeshoptDecoder.ready) await MeshoptDecoder.ready;
    loader.setMeshoptDecoder(MeshoptDecoder);
  })();
  return assetsReady;
}

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

function entryBoneMap(entry, manifest) {
  const bm = entry?.boneMap;
  if (typeof bm === 'string') {
    if (bm === 'MESHY24_BONE_MAP' || bm === 'meshy24') return { ...MESHY24_BONE_MAP };
    const shared = manifest?.boneMaps?.[bm];
    if (shared) return { ...shared };
  }
  if (entry?.rig === 'meshy24') return { ...MESHY24_BONE_MAP, ...(bm && typeof bm === 'object' ? bm : {}) };
  return bm && typeof bm === 'object' ? { ...bm } : {};
}

function placeModel(scene, entry) {
  if (entry.rotY) scene.rotation.y += entry.rotY;
  scene.updateWorldMatrix(true, true);
  if (entry.scale != null && entry.scale !== 1) {
    scene.scale.multiplyScalar(entry.scale);
    scene.updateWorldMatrix(true, true);
  } else if (entry.height) {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3(); box.getSize(size);
    if (size.y > 0.2) {
      const s = entry.height / size.y;
      if (s > 0.05 && s < 20) scene.scale.multiplyScalar(s);
      scene.updateWorldMatrix(true, true);
    }
  }
  if (entry.yOffset != null) {
    scene.position.y += entry.yOffset;
  } else {
    const box2 = new THREE.Box3().setFromObject(scene);
    if (Number.isFinite(box2.min.y)) scene.position.y -= box2.min.y;
  }
  scene.updateWorldMatrix(true, true);
  return scene;
}

const CYAN = new THREE.Color(0x3df0ff);

/** Cyan accent glow from the base-color map (models ship without emissive textures). */
function applyEmissiveGlow(root, intensity) {
  if (!(intensity > 0)) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.isMaterial) continue;
      if (!m.emissiveMap && m.map) m.emissiveMap = m.map;
      if (m.emissive) m.emissive.copy(CYAN);
      else m.emissive = CYAN.clone();
      m.emissiveIntensity = intensity;
    }
  });
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
 * If `entry.animSource` is set, Mixamo/Xbot clips are retargeted through the
 * canonical boneMap (Aether A1 `retargetRole`).
 * @returns {Promise<{role, entry, root, gltf, clips, clipMap, fallback, height, radius, boneMap, bones}>}
 */
export async function loadRole(role, manifest) {
  const entry = manifest.roles?.[role];
  if (!entry) throw new Error(`unknown role ${role}`);
  const height = entry.height ?? 1.8;
  const radius = entry.radius ?? 0.32;
  let clipMap = entry.clipMap || {};
  if (!entry.url) {
    return { role, entry, root: fallbackMesh(entry.fallback || 'capsule', height, radius), gltf: null, clips: {}, clipMap, boneMap: {}, bones: {}, fallback: true, height, radius };
  }
  try {
    const gltf = await loadGLB(entry.url);
    const scene = SkeletonUtils.clone(gltf.scene);
    scene.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    placeModel(scene, entry);
    const glow = entry.emissive ?? entry.emissiveIntensity;
    applyEmissiveGlow(scene, glow != null ? glow : 0.16);
    const boneMap = resolveBoneMap(scene, entryBoneMap(entry, manifest));
    const bones = bindBones(scene, boneMap);
    const rawClips = retargetClips(gltf.animations || [], { targetBoneMap: boneMap, targetRoot: scene });
    const clips = Object.fromEntries(rawClips.map((c) => [c.name, c]));
    const loaded = { role, entry, root: scene, gltf: { scene, animations: rawClips }, clips, clipMap, boneMap, bones, fallback: false, height, radius };

    if (entry.animSource && entry.animSource !== role) {
      const srcKey = `anim:${entry.animSource}`;
      if (!roleCache.has(srcKey)) roleCache.set(srcKey, loadRole(entry.animSource, manifest));
      const source = await roleCache.get(srcKey);
      retargetRole(loaded, source, { inPlace: true });
      clipMap = loaded.clipMap || clipMap;
    }
    return loaded;
  } catch (err) {
    console.warn(`[assets] failed to load ${role} from ${entry.url}, using capsule`, err);
    return { role, entry, root: fallbackMesh(entry.fallback || 'capsule', height, radius, 0xff5a8a), gltf: null, clips: {}, clipMap, boneMap: {}, bones: {}, fallback: true, height, radius };
  }
}


/**
 * Load a prop from manifest.props (falls back to manifest.roles).
 * Clones are safe; geometry is shared. Props do not cast shadows.
 */
export async function loadProp(name, manifest) {
  const entry = manifest?.props?.[name] || manifest?.roles?.[name];
  if (!entry?.url) throw new Error(`unknown prop ${name}`);
  if (!assetsReady) await initAssets();
  else await assetsReady;
  const gltf = await loadGLB(entry.url);
  const root = gltf.scene.clone(true);
  placeModel(root, entry);
  const glow = entry.emissive ?? entry.emissiveIntensity;
  if (glow) applyEmissiveGlow(root, glow);
  root.name = name;
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; }
  });
  return { name, entry, root };
}
