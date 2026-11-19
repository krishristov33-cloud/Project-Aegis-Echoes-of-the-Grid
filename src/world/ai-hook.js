// Hook Claude's createAI into a greybox: views, squad spawns, clip playback via clipMap only.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createAI } from '../ai/director.js';

const ANIM_ALIAS = {
  idle: 'idle',
  walk: 'walk',
  aimWalk: 'walk',
  run: 'run',
  aim: 'idle',
  fire: 'idle',
  crouch: 'idle',
  crouchFire: 'idle',
  reload: 'idle',
  crouchReload: 'idle',
  hit: 'hit',
  ducked: 'hit',
  dead: 'hit',
  hover: 'idle',
};

export function makeSoldierView(loaded, parent) {
  const g = new THREE.Group();
  if (loaded && !loaded.fallback && loaded.root) {
    const root = SkeletonUtils.clone(loaded.root);
    g.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const actions = {};
    for (const [logical, name] of Object.entries(loaded.clipMap || {})) {
      const clip = name && loaded.clips?.[name];
      if (clip && !actions[logical]) actions[logical] = mixer.clipAction(clip);
    }
    g.userData.mixer = mixer;
    g.userData.actions = actions;
    if (actions.idle) { actions.idle.play(); g.userData.anim = 'idle'; }
  } else {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 1.15, 6, 10).translate(0, 0.9, 0),
      new THREE.MeshStandardMaterial({ color: 0xc8344a, roughness: 0.45, metalness: 0.2, emissive: 0x400010, emissiveIntensity: 0.25 }),
    );
    body.castShadow = true;
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.4, metalness: 0.6 }),
    );
    gun.position.set(0.2, 1.25, 0.38);
    g.add(body, gun);
    g.userData.body = body;
  }
  parent.add(g);
  return g;
}

export function makeDroneView(loaded, parent) {
  const g = new THREE.Group();
  if (loaded && !loaded.fallback && loaded.root && loaded.entry?.url) {
    g.add(SkeletonUtils.clone(loaded.root));
  } else {
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.22, 0.85),
      new THREE.MeshStandardMaterial({ color: 0x9aa4b4, roughness: 0.35, metalness: 0.7, emissive: 0x3df0ff, emissiveIntensity: 0.2 }),
    );
    hull.castShadow = true;
    g.add(hull);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x222830, roughness: 0.4, metalness: 0.6 });
    const rotorMat = new THREE.MeshBasicMaterial({ color: 0x3df0ff, transparent: true, opacity: 0.45 });
    for (const [x, z] of [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.12), armMat);
      arm.position.set(x * 0.5, 0.02, z * 0.5);
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 12), rotorMat);
      rotor.position.set(x, 0.12, z);
      g.add(arm, rotor);
    }
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xff3d8a, emissive: 0xff3d8a, emissiveIntensity: 1.2 }),
    );
    eye.position.set(0, -0.08, 0.4);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(2.0, 6.5, 20, 1, true).translate(0, -3.25, 0),
      new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }),
    );
    cone.rotation.x = -(Math.PI / 2 - 35 * (Math.PI / 180));
    g.add(eye, cone);
    g.userData.cone = cone;
    g.userData.body = hull;
  }
  parent.add(g);
  return g;
}

function toVec(p) {
  if (!p) return new THREE.Vector3();
  if (p.isVector3) return p;
  if (p.length === 2) return new THREE.Vector3(p[0], 0, p[1]);
  return new THREE.Vector3(p[0], p[1] ?? 0, p[2] ?? 0);
}

export function tickEnemyViews(ai, dt) {
  if (!ai) return;
  for (const e of ai.enemies) {
    const view = e.view;
    if (!view?.userData?.mixer) continue;
    const logical = ANIM_ALIAS[e.animState] || 'idle';
    const actions = view.userData.actions || {};
    const want = actions[logical] ? logical : (actions.idle ? 'idle' : null);
    if (want && want !== view.userData.anim) {
      actions[view.userData.anim]?.fadeOut(0.16);
      actions[want].reset().fadeIn(0.16).play();
      view.userData.anim = want;
    }
    view.userData.mixer.update(dt);
  }
}

export async function bootLevelAI(level, { bus, player, enemiesData, strings, loadedSoldier, loadedDrone }) {
  if (!level?.navMeshes?.length || !level.spawns?.length) return null;
  const ai = await createAI({
    bus,
    player,
    level: {
      navMeshes: level.navMeshes,
      occluders: level.occluders || [],
      coverMeshes: level.coverMeshes || level.occluders || [],
    },
    data: { enemies: enemiesData, strings },
  });
  const squad = ai.createSquad(level.name || 'squad');
  const group = level.group;
  for (const s of level.spawns) {
    const position = toVec(s.position);
    const patrol = (s.patrol || []).map(toVec);
    if (s.kind === 'drone') {
      ai.spawnDrone({ position, patrol, squad, view: makeDroneView(loadedDrone, group) });
    } else {
      ai.spawnSoldier({ position, patrol, squad, view: makeSoldierView(loadedSoldier, group), yaw: s.yaw });
    }
  }
  const prev = ai.dispose.bind(ai);
  ai.dispose = () => {
    for (const e of ai.enemies) {
      e.view?.userData?.mixer?.stopAllAction();
      e.view?.parent?.remove(e.view);
    }
    prev();
  };
  level.ai = ai;
  return ai;
}
