# src/ai: enemy AI (C1, Claude)

Everything enemy-side goes through `director.js`. Systems talk to the rest of the game only via the bus and the Player / Enemy APIs in `docs/TASKS.md`.

| File | What |
|---|---|
| `director.js` | `createAI()`: navmesh, cover, squads from the physics world; spawns; ticks; ducks enemies on `sidechain {source:{pos,radius}}` |
| `nav.js` | recast/detour navmesh + crowd wrapper (`recast-navigation@0.43.1`) |
| `perception.js` | sight cone + peripheral + LOS, hearing (`noise`), awareness meter, last known position, ghost belief (`blink`) |
| `cover.js` | cover-point generation from greybox meshes, scored cover / flank queries, claims |
| `squad.js` | shared knowledge with comms delay, roles (suppress / flank / assault / spot / search), callouts |
| `soldier.js` | Directorate soldier brain: patrol, investigate, combat (seek cover, hide, peek, advance), search, ducked |
| `drone.js` | spotter drone: patrol circuit, spotlight cone, orbit at standoff, light bursts, crash on death |
| `weapon.js` | hitscan rifle: bursts, reload, reaction time, accuracy falloff, cover-aware hits, ghost misses |
| `encounters.js` | per-level spawner the game uses: builds the director on `levelState`, loads manifest models, drives idle/walk/run clips |
| `level-geometry.js` | navmesh triangles, cover boxes and line of sight read from the physics world |
| `enemy.js` | Enemy API base: `id, position, hp, state, duck(sec), takeDamage(n, src)` + `kind, animState, view` |

## Wiring into the game

`encounters.js` is the only thing `src/main.js` needs (3 lines, Lumen's file):

```js
import { createEncounters } from './ai/encounters.js';
// after `const enemies = []` and the player exist:
const encounters = createEncounters({ bus, scene, physics, player, enemies, manifest, data: { enemies: enemiesData, strings } });
// in tick(), after current?.update(...):
encounters.update(dt);
```

On every `levelState {phase:'enter'}` it rebuilds navmesh + cover + line of sight from `physics.bodies` (solid/ground
boxes and meshes, so every greybox works as-is), spawns `enemiesData.encounters[level]`, and pushes the enemies into
`enemies` so `combat.js` melee / blast hit them. Leaving the level tears everything down. Levels without an
`encounters` entry get no AI.

Soldier/drone models come from manifest roles `soldier` / `drone`. Facing is detected from the canonical
`leftFoot -> leftToes` bones (no vendor bone names). Idle/walk/run clips come from the role's `clipMap`.

recast-navigation is imported from jsDelivr `+esm` URLs inside `nav.js`, so `index.html` needs no change.

## Bus
- Listens: `noise {pos, radius, kind}` (hearing; `shot`/`subBass` close by also suppresses), `blink {from, to, ghostId}` (enemies that were watching shoot the ghost for `ghost.belief` s), `sidechain {source, strength, onBeat}` (source = enemy id or `{pos, radius}`).
- Emits: `callout {speaker, text, pos, key}`, `enemyShot`, `enemyHit`, `enemyKilled`, `enemyDucked {id, until}`, and `noise {kind:'enemyShot' | 'crash'}`.

## For Aether (animation)
Each enemy exposes `animState`: soldier `idle, walk, aimWalk, run, aim, fire, crouch, crouchFire, reload, crouchReload, hit, ducked, dead`; drone `hover, fire, ducked`. Soldier also has `crouched` and `yaw`. Drone has `spotlight` (bool) for the cone light.

## Player / combat hooks used
`position` (feet), `velocity` (accuracy penalty when moving), `hp` (stop firing at 0), `takeDamage(n, src)`.
Enemies take `takeDamage(n, {source:'player'})` (the hit is traced back to the player's position), `duck(sec)` and `applyImpulse(v)` (Sub-Bass knockback slides them along the navmesh). C3's Phase-Skip only needs to make `takeDamage` ignore hits while phasing.

## Test pages
- `tests/ai.html`: sandbox arena, stub player, debug views (navmesh, cover, sight cones). `window.__test` for console poking.
- `tests/ai-game.html?debug=1`: the real game, unmodified `main.js`, with encounters attached from outside and a test rooftop squad (used until `enemies.json` has an `encounters` block).
