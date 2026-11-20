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

## Enemy feel pass (W3)

- `weapon.js`: aim wind-up -> burst -> pause -> short re-aim. The gun drags an aim point after the target at a limited speed and only hits when the muzzle -> aim-point line passes within `hitRadius` of the chest, so moving sideways, jumping or dodging beats it and standing still does not. Attack tokens (`squad.maxShooters`) cap how many enemies shoot at once. Emits `enemyTelegraph {id, kind:'aim'|'burst', pos, time, target}`.
- `soldier.js`: stagger + directional knockback on every hit (`soldier.hit`), a telegraphed rifle-butt shove at melee range (`soldier.shove`, telegraph kind `'melee'`), strafing when there is no reachable cover, stuck recovery.
- `drone.js`: beat-telegraphed dive (`drone.dive`): wind-up (`enemyTelegraph kind 'dive'`), line locked on the commit beat (`enemyAttack {id, kind:'dive', from, to, time}`), recovery window low over the ground with `vulnerableMult` damage. Banking, pitch and hover bob in `syncView`.
- `hulk.js`: animation cues fitted to the beat wind-up (`cue`), `enemyTelegraph kind 'slam'|'throw'|'well'`, `bossDefeated` now fires `deathTime` seconds after the kill (end of the death sequence).
- `enemy-anim.js`: per-enemy animator (lower/upper body split, speed-matched locomotion, torso aim, head look, flinch spring, hit flash). `encounters.js` is the view layer: arm IK onto the rifle so the barrel really points at the aim point, death collapse + corpse sink-out. `enemy-fx.js`: aim lasers, tracers, muzzle flashes, dive line (4 instanced draw calls). `skin-fix.js`: repairs hand/hip weight bleed in auto-rigged meshes and finds a rifle modelled into the hand.
- All numbers: `src/data/enemies.json` (`soldier.weapon`, `soldier.hit`, `soldier.shove`, `soldier.cover.strafe*`, `drone.dive`, `drone.visual`, `anim`, `fx`, `hulk.anim`, `hulk.deathTime`).
