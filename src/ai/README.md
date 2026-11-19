# src/ai: enemy AI (C1, Claude)

Everything enemy-side goes through `director.js`. Systems talk to the rest of the game only via the bus and the Player / Enemy APIs in `docs/TASKS.md`.

| File | What |
|---|---|
| `director.js` | `createAI()` entry point: builds navmesh, cover, squads; spawns; ticks; ducks enemies on `sidechain` |
| `nav.js` | recast/detour navmesh + crowd wrapper (`recast-navigation@0.43.1`) |
| `perception.js` | sight cone + peripheral + LOS, hearing (`noise`), awareness meter, last known position, ghost belief (`blink`) |
| `cover.js` | cover-point generation from greybox meshes, scored cover / flank queries, claims |
| `squad.js` | shared knowledge with comms delay, roles (suppress / flank / assault / spot / search), callouts |
| `soldier.js` | Directorate soldier brain: patrol, investigate, combat (seek cover, hide, peek, advance), search, ducked |
| `drone.js` | spotter drone: patrol circuit, spotlight cone, orbit at standoff, light bursts, crash on death |
| `weapon.js` | hitscan rifle: bursts, reload, reaction time, accuracy falloff, cover-aware hits, ghost misses |
| `enemy.js` | Enemy API base: `id, position, hp, state, duck(sec), takeDamage(n, src)` + `kind, animState, view` |

## Wiring into the game (once L1 is on main)

```js
import { createAI } from './ai/director.js';
const ai = await createAI({
  bus, player: game.player,
  level: { navMeshes: [...walkable, ...obstacles], occluders: obstacles, coverMeshes: obstacles },
  data: { enemies, strings },           // src/data/enemies.json, src/data/strings.json
});
const squad = ai.createSquad('roof-a');
ai.spawnSoldier({ position, patrol: [a, b], squad, view });   // view = Object3D from the asset manifest
ai.spawnDrone({ position, patrol: [...], squad, view });
// loop: ai.update(dt)
```

`index.html` import map needs these entries (same as `tests/ai.html`):

```json
"recast-navigation": "https://cdn.jsdelivr.net/npm/recast-navigation@0.43.1/index.mjs",
"@recast-navigation/core": "https://cdn.jsdelivr.net/npm/@recast-navigation/core@0.43.1/dist/index.mjs",
"@recast-navigation/generators": "https://cdn.jsdelivr.net/npm/@recast-navigation/generators@0.43.1/dist/index.mjs",
"@recast-navigation/three": "https://cdn.jsdelivr.net/npm/@recast-navigation/three@0.43.1/dist/index.mjs",
"@recast-navigation/wasm": "https://cdn.jsdelivr.net/npm/@recast-navigation/wasm@0.43.1/dist/recast-navigation.wasm-compat.js"
```
`three/addons/` must also be mapped (the recast three helpers import line materials from it).

## Bus
- Listens: `noise {pos, radius, kind}` (hearing; `shot`/`subBass` close by also suppresses), `blink {from, to, ghostId}` (enemies that were watching shoot the ghost for `ghost.belief` s), `sidechain {source, strength, onBeat}` (source = enemy id or `{pos, radius}`).
- Emits: `callout {speaker, text, pos, key}`, `enemyShot`, `enemyHit`, `enemyKilled`, `enemyDucked {id, until}`, and `noise {kind:'enemyShot' | 'crash'}`.

## For Aether (animation)
Each enemy exposes `animState`: soldier `idle, walk, aimWalk, run, aim, fire, crouch, crouchFire, reload, crouchReload, hit, ducked, dead`; drone `hover, fire, ducked`. Soldier also has `crouched` and `yaw`. Drone has `spotlight` (bool) for the cone light.

## Player hooks used
`position` (feet), `velocity` (accuracy penalty when moving), `hp` (stop firing at 0), `takeDamage(n, src)`. C3's Phase-Skip only needs to make `takeDamage` ignore hits while phasing.

## Test page
`tests/ai.html` (serve the repo root). Controls are on screen. `window.__test` exposes `ai, player, bus, events` for console poking.
