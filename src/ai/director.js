// AI director: one per loaded level. Builds the navmesh, cover points and line of sight straight from the
// physics world (src/core/physics.js API), then spawns, ticks and ducks enemies.
//
//   const ai = await createAI({ bus, player: game.player, physics: game.physics, data: { enemies, strings } });
//   const squad = ai.createSquad('roof-a');
//   ai.spawnSoldier({ position, patrol: [p1, p2], squad, view });   // view = Object3D (manifest role)
//   ai.spawnDrone({ position, patrol: [...], squad, view });
//   // loop: ai.update(dt)      level unload: ai.dispose()
// Most callers want encounters.js instead, which does all of this per level from enemies.json.
//
// Bus: listens to `sidechain {source, strength, onBeat}` — source `{pos, radius}` ducks every enemy inside it
// (combat.js already ducks the enemies it hits on-beat via enemy.duck()). Duration = duckDefault x strength (x1.5 on beat).
// Also adds/removes Wave-Shield meshes (`shieldRaised` / `shieldLowered`) to the line-of-sight occluders (C3).
import { createNav } from './nav.js';
import { CoverSystem } from './cover.js';
import * as THREE from 'three';
import { Squad } from './squad.js';
import { createTokens } from './weapon.js';
import { Soldier } from './soldier.js';
import { Drone } from './drone.js';
import { levelFromPhysics, PhysicsLineOfSight } from './level-geometry.js';

export async function createAI({ bus, player = null, physics, data }) {
  const E = data.enemies;
  const geo = levelFromPhysics(physics, { lowCover: E.cover.lowHeight * 0.8 });
  const nav = await createNav(geo, { agentRadius: E.soldier.radius, agentHeight: E.soldier.height });
  const los = new PhysicsLineOfSight(physics);
  const cover = new CoverSystem({ nav, los, cfg: E.cover });
  cover.generate(geo.coverBoxes);

  const enemies = [];
  const squads = [];
  const tokens = createTokens(E.squad.maxShooters ?? 2);
  const _camDir = new THREE.Vector3();
  const _toP = new THREE.Vector3();
  let now = 0;

  const offs = [
    bus.on('sidechain', ({ source, strength = 1, onBeat } = {}) => {
      const mult = strength * (onBeat ? 1.5 : 1);
      if (typeof source === 'string') {
        const e = ai.byId(source);
        e?.duck(e.cfg.duckDefault * mult);
      } else if (source?.pos) {
        for (const e of enemies) if (!e.dead && e.position.distanceTo(source.pos) <= (source.radius ?? 4)) e.duck(e.cfg.duckDefault * mult);
      }
    }),
    bus.on('shieldRaised', ({ object } = {}) => object && los.extra.push(object)),
    bus.on('shieldLowered', ({ object } = {}) => {
      const i = los.extra.indexOf(object);
      if (i >= 0) los.extra.splice(i, 1);
    }),
  ];

  const ai = {
    /** The target every enemy fights (Player API). Settable. */
    player,
    nav,
    los,
    cover,
    enemies,
    squads,
    get now() {
      return now;
    },

    createSquad(name) {
      const s = new Squad({ bus, cfg: E.squad, strings: data.strings.callouts ?? {}, nav, name, tokens });
      squads.push(s);
      return s;
    },

    spawnSoldier({ position, patrol, squad, view, yaw }) {
      const s = new Soldier({ bus, nav, cover, los, cfg: E.soldier, ghostCfg: E.ghost, position, patrol, view, yaw });
      (squad ?? this.createSquad(`solo-${s.id}`)).add(s);
      s.director = this;
      enemies.push(s);
      return s;
    },

    spawnDrone({ position, patrol, squad, view }) {
      const d = new Drone({ bus, nav, los, cfg: E.drone, ghostCfg: E.ghost, position, patrol, view });
      (squad ?? this.createSquad(`solo-${d.id}`)).add(d);
      d.director = this;
      enemies.push(d);
      return d;
    },

    /** Register an externally built enemy (e.g. the Hulk) so it gets ticked, ducked and found by id. */
    register(enemy) {
      enemies.push(enemy);
      return enemy;
    },

    tokens,

    /** True when `pos` is outside the player's view (camera from game.camera). Off-screen shooters wind up longer. */
    offscreen(pos) {
      const cam = this.camera ?? globalThis.game?.camera;
      if (!cam) return false;
      cam.getWorldDirection(_camDir);
      _toP.subVectors(pos, cam.position);
      const d = _toP.length();
      if (d < 1e-3) return false;
      return _toP.dot(_camDir) / d < (E.squad.offscreenCos ?? 0.45);
    },

    byId(id) {
      return enemies.find((e) => e.id === id) ?? null;
    },

    update(dt) {
      if (!this.player) return;
      dt = Math.min(dt, 0.1);
      now += dt;
      los.casts = 0;
      nav.update(dt);
      for (const s of squads) s.update(dt, now);
      for (const e of enemies) e.update(dt, now, this.player);
    },

    dispose() {
      offs.forEach((off) => off?.());
      enemies.forEach((e) => e.dispose());
      enemies.length = 0;
      nav.dispose();
    },
  };
  return ai;
}
