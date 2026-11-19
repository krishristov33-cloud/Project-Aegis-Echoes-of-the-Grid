// AI director: the one entry point the game uses for enemies.
//
//   import { createAI } from './ai/director.js';
//   const ai = await createAI({
//     bus, player: game.player,
//     level: { navMeshes, occluders, coverMeshes },   // Object3D/Mesh lists from the level greybox
//     data: { enemies, strings },                     // parsed src/data/enemies.json + strings.json
//   });
//   const squad = ai.createSquad('roof-a');
//   ai.spawnSoldier({ position, patrol: [p1, p2], squad, view: soldierObject3D });
//   ai.spawnDrone({ position, patrol: [...], squad, view: droneObject3D });
//   // in the game loop:
//   ai.update(dt);
// `player` may be passed later: ai.player = game.player (it only needs the Player API).
//
// Also listens to bus `sidechain {source, strength, onBeat}` and ducks enemies:
//   source = enemy id (string)          -> ducks that enemy
//   source = { pos, radius }            -> ducks every enemy inside the radius
// Duration = enemy duckDefault x strength (x1.5 on beat).
import { createNav } from './nav.js';
import { CoverSystem } from './cover.js';
import { Squad } from './squad.js';
import { Soldier } from './soldier.js';
import { Drone } from './drone.js';
import { LineOfSight } from './util.js';

export async function createAI({ bus, player, level, data }) {
  const E = data.enemies;
  const nav = await createNav(level.navMeshes, { agentRadius: E.soldier.radius, agentHeight: E.soldier.height });
  const los = new LineOfSight(level.occluders);
  const cover = new CoverSystem({ nav, los, cfg: E.cover });
  cover.generate(level.coverMeshes ?? level.occluders);

  const enemies = [];
  const squads = [];
  let now = 0;

  const offSidechain = bus.on('sidechain', ({ source, strength = 1, onBeat }) => {
    const mult = strength * (onBeat ? 1.5 : 1);
    if (typeof source === 'string') {
      const e = ai.byId(source);
      e?.duck(e.cfg.duckDefault * mult);
    } else if (source?.pos) {
      for (const e of enemies) if (!e.dead && e.position.distanceTo(source.pos) <= (source.radius ?? 4)) e.duck(e.cfg.duckDefault * mult);
    }
  });

  const ai = {
    /** The target every enemy fights. Settable, so the player can be built after the navmesh. */
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
      const s = new Squad({ bus, cfg: E.squad, strings: data.strings.callouts, nav, name });
      squads.push(s);
      return s;
    },

    spawnSoldier({ position, patrol, squad, view, yaw }) {
      const s = new Soldier({ bus, nav, cover, los, cfg: E.soldier, ghostCfg: E.ghost, position, patrol, view, yaw });
      (squad ?? this.createSquad(`solo-${s.id}`)).add(s);
      enemies.push(s);
      return s;
    },

    spawnDrone({ position, patrol, squad, view }) {
      const d = new Drone({ bus, nav, los, cfg: E.drone, ghostCfg: E.ghost, position, patrol, view });
      (squad ?? this.createSquad(`solo-${d.id}`)).add(d);
      enemies.push(d);
      return d;
    },

    /** Register an externally-built enemy (e.g. the Hulk) so it gets ticked, ducked and found by id. */
    register(enemy) {
      enemies.push(enemy);
      return enemy;
    },

    byId(id) {
      return enemies.find((e) => e.id === id) ?? null;
    },

    /** Nearest living enemy to a point (for melee targeting / lock-on). */
    nearest(pos, maxDist = Infinity) {
      let best = null;
      let bd = maxDist;
      for (const e of enemies) {
        if (e.dead) continue;
        const d = e.position.distanceTo(pos);
        if (d < bd) [best, bd] = [e, d];
      }
      return best;
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
      offSidechain?.();
      enemies.forEach((e) => e.dispose());
      nav.dispose();
    },
  };
  return ai;
}
