// Per-level enemy encounters. One object for the whole game; on every `levelState {level, phase:'enter'}` it tears
// down the previous level's AI, builds a new director from the physics world (navmesh, cover, line of sight), and
// spawns the squads listed in enemies.json `encounters[level]`. Enemies are pushed into the game's enemy list so
// combat.js hits them like the training dummy.
//
//   import { createEncounters } from './ai/encounters.js';
//   const encounters = createEncounters({ bus, scene, physics, player, enemies, manifest, data: { enemies: enemiesData, strings } });
//   // in tick(): encounters.update(dt);
//
// Models come only from manifest roles (`soldier`, `drone`). Facing is detected from the canonical foot/toe bones,
// so any rig (Mixamo now, Meshy later) walks forwards without hardcoded bone names. Clips are picked by logical
// name through the role's clipMap (idle / walk / run), missing ones fall back to idle; A1 can replace this.
import * as THREE from 'three';
import { loadRole } from '../core/assets.js';
import { createAI } from './director.js';

const V = (a) => new THREE.Vector3(a[0], a[1] ?? 0, a[2]);

/** animState -> logical clip name in the manifest clipMap. */
const CLIP_FOR = {
  walk: 'walk',
  aimWalk: 'walk',
  run: 'run',
};

/** Yaw (radians) that turns this model so its feet point down +Z (the game's forward). */
function detectYawOffset(loaded) {
  const foot = loaded.bones?.leftFoot ?? loaded.bones?.rightFoot;
  const toes = loaded.bones?.leftToes ?? loaded.bones?.rightToes;
  if (!foot || !toes) return 0;
  loaded.root.updateWorldMatrix(true, true);
  const a = foot.getWorldPosition(new THREE.Vector3());
  const b = toes.getWorldPosition(new THREE.Vector3());
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-4) return 0;
  return -Math.atan2(dx, dz); // rotate the model so (dx, dz) lines up with +Z
}

async function makeView(role, manifest) {
  const loaded = await loadRole(role, manifest);
  const holder = new THREE.Group();
  holder.name = `ai-${role}`;
  const inner = new THREE.Group();
  inner.rotation.y = detectYawOffset(loaded);
  inner.add(loaded.root);
  holder.add(inner);
  let mixer = null;
  const actions = {};
  if (loaded.gltf && !loaded.fallback) {
    mixer = new THREE.AnimationMixer(loaded.root);
    for (const logical of ['idle', 'walk', 'run']) {
      const name = loaded.clipMap?.[logical];
      const clip = name && loaded.clips[name];
      if (clip) actions[logical] = mixer.clipAction(clip);
    }
    actions.idle?.play();
  }
  return { holder, mixer, actions, current: 'idle' };
}

export function createEncounters({ bus, scene, physics, player, enemies, manifest, data }) {
  let ai = null;
  let views = []; // { enemy, holder, mixer, actions, current }
  let token = 0;
  let debugNav = null;

  function teardown() {
    for (const v of views) v.holder.removeFromParent();
    views = [];
    if (ai) {
      for (const e of ai.enemies) {
        const i = enemies.indexOf(e);
        if (i >= 0) enemies.splice(i, 1);
      }
      ai.dispose();
      ai = null;
    }
    debugNav?.removeFromParent();
    debugNav = null;
  }

  async function enter(level) {
    const my = ++token;
    teardown();
    const spec = data.enemies.encounters?.[level];
    if (!spec?.squads?.length) return;
    let next;
    try {
      next = await createAI({ bus, player, physics, data });
    } catch (err) {
      console.warn('[ai] could not build AI for', level, err);
      return;
    }
    if (my !== token) return next.dispose(); // level changed while the navmesh was building
    ai = next;
    for (const sq of spec.squads) {
      const squad = ai.createSquad(sq.name ?? level);
      for (const s of sq.soldiers ?? []) {
        const v = await makeView('soldier', manifest);
        if (my !== token) return;
        scene.add(v.holder);
        const e = ai.spawnSoldier({ position: V(s.pos), yaw: s.yaw ?? 0, patrol: (s.patrol ?? []).map(V), squad, view: v.holder });
        views.push({ enemy: e, ...v });
        enemies.push(e);
      }
      for (const d of sq.drones ?? []) {
        const v = await makeView('drone', manifest);
        if (my !== token) return;
        scene.add(v.holder);
        const e = ai.spawnDrone({ position: V(d.pos), patrol: (d.patrol ?? []).map(V), squad, view: v.holder });
        views.push({ enemy: e, ...v });
        enemies.push(e);
      }
    }
  }

  const off = bus.on('levelState', (e) => {
    if (e?.phase === 'enter') enter(e.level);
  });

  return {
    get ai() {
      return ai;
    },

    update(dt) {
      if (!ai) return;
      ai.update(dt);
      for (const v of views) {
        if (!v.mixer) continue;
        const e = v.enemy;
        const want = e.dead ? null : CLIP_FOR[e.animState] && v.actions[CLIP_FOR[e.animState]] ? CLIP_FOR[e.animState] : 'idle';
        if (want !== v.current) {
          const from = v.actions[v.current];
          const to = want && v.actions[want];
          if (to) to.reset().fadeIn(0.2).play();
          from?.fadeOut(0.2);
          v.current = want;
        }
        v.mixer.update(e.dead ? 0 : dt);
      }
    },

    /** Debug: show the navmesh of the current level. */
    showNavmesh(on = true) {
      if (!ai) return;
      if (on && !debugNav) scene.add((debugNav = ai.nav.debugObject()));
      if (!on && debugNav) {
        debugNav.removeFromParent();
        debugNav = null;
      }
    },

    dispose() {
      off?.();
      token++;
      teardown();
    },
  };
}
