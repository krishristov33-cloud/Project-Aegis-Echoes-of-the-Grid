# Aegis architecture (L1–L4 as built)

This describes the code as it exists after Lumen's first push. Event names and the player/enemy APIs stay as documented in `docs/TASKS.md` (Contracts). Tuning numbers live in `src/data/*.json`; the company name `amuNet` lives in `src/data/strings.json`.

## Boot

- `index.html` — import map for three.js **0.164.1** (unpkg, jsDelivr fallback via `?cdn=1`), canvas, HUD root, click-to-start / pointer lock. No build step; serve the repo root.
- `src/main.js` — loads data + `assets/manifest.json`, creates the renderer / scene / physics world / audio-clock stub, loads roles through the manifest, boots the rooftop, runs the loop, exposes `window.game` and `window.AG`.
- `?debug=1` keeps the debug HUD and lets keys 1–4 switch rooftop / Cradle / chamber / arena. `?shots=1` skips the start overlay and uses a slightly looser `maxDt` so headless tests can catch up.

## Core (`src/core/`)

| File | Role |
|---|---|
| `events.js` | `bus.emit` / `bus.on` / `bus.off`. Event names in `Events`. |
| `time.js` | Clamped dt + FPS. |
| `input.js` | WASD, jump, melee, blast, pointer-lock mouse, plus `setScriptedInput` for tests. |
| `assets.js` | Manifest loader. `loadRole(role, manifest)` only. Skinned meshes are cloned with `SkeletonUtils.clone`. Failed loads fall back to a capsule. |
| `bones.js` | Canonical VRM-style humanoid map (`hips`, `spine`, `chest`, `upperChest`, `neck`, `head`, `leftUpperLeg`, `leftLowerLeg`, `leftFoot`, `leftToes`, …). Manifest `boneMap` is optional; auto-detect covers Mixamo (`mixamorig*` / `mixamorig:*` — GLTFLoader strips `:`) and common patterns (Rigify `DEF-*`, unprefixed, VRM). `findNamedNode` resolves sanitized names. |
| `retarget.js` | **A1 stub.** `retargetClips(clips, { sourceBoneMap, targetBoneMap })` currently returns clips unchanged. |
| `audio-clock.js` | **L6 stub.** Emits `beat` / `bar` at `tuning.audio.bpm` (174, matching Krea's master concept). `isOnBeat()` uses the 0.12 window. `setBpm` is ready for Kris's tracks. |
| `physics.js` | Box + mesh-raycast world. Same method names C3 should keep when swapping in Rapier: `addBox`, `addMesh`, `remove`, `raycast`, `moveCapsule`, `overlapCapsule`, `findVault`. Hits: `{ point, normal, distance, id, userData }` with flags `solid`, `ground`, `vaultable`. |

IK, locomotion and combat look up bones **only** through `bindBones()` / the canonical map, never a vendor name.

## Player (`src/player/`)

- `controller.js` — capsule move, gravity, slopes, coyote / jump buffer, vault arc, `game.player` API: `position`, `velocity`, `isGrounded`, `hp`, `state`, `applyImpulse(v)`, `takeDamage(n, src)`.
- `camera.js` — third-person orbit, pointer-lock look, shoulder offset, collision pull-in.
- `locomotion.js` — phase-synced idle/walk/jog/run/sprint blend adapted from Kanemori `motion/v03/locomotion.js` (Aether). Missing clips are weight-blended or time-scaled. Lean on turn. Foot IK after the mixer.
- `ik.js` — `twoBoneIK` (same source) + foot-lock raycasts + hip drop, using `leftUpperLeg` / `leftLowerLeg` / `leftFoot` (and right).
- `combat.js` — state machine with crossfades: `melee1/2/3` combo, Sub-Bass Blast cone, hit react. On-beat (`|phase| < 0.12` or `> 0.88`) multiplies damage and emits a shockwave. Emits `sidechain`, `noise`, `playerDamaged`, `playerHealed`.
- `powers/blink.js`, `powers/phase-skip.js` — stubs (L8 / C3).

## World (`src/world/`)

- `rooftop.js` — Sofia rooftop greybox: wet grid deck, parapets with a +Z gap, vault crate at `(0, 0, 7)`, uneven IK tiles, ramp, AC units, glass tower, magenta/cyan neon, warm apartment windows, instanced rain. Mood from `concepts/00_master`. One training dummy (Enemy API, not C1 AI; Soldier mesh if the manifest role loads).
- `cradle.js`, `chamber.js`, `arena.js` — greyboxes for level flow (L3). `chamber.js` exports `updatePuzzle()` as a no-op for C4.
- `rain.js` — one `InstancedMesh` of streaks, following the player.
- `greybox.js` — box helper that registers both a visual and a physics body.
- `geo-extrude.js` — C3 stub (`extrudeTiles`, `createLaunchpad`).

Level changes go through `game.goto('rooftop'|'cradle'|'chamber'|'arena')` and emit `levelState`. Walking into a portal also switches.

## Data and assets

- `assets/manifest.json` — every role's `url`, `clipMap`, optional `boneMap`. Player is three.js Xbot (MIT); soldier is Soldier.glb (MIT). `plannedUALClipMap` documents Quaternius UAL 1+2 (CC0, in-place) as the planned clip base — the free UAL glTF uses Rigify `DEF-*` bones and needs A1 retarget, so it is not in `assets/` this push.
- Incoming Tripo meshes / Meshy rigs will land in `/workspace/apex/aegis/models/` (see MODELS.md when it arrives). Swap a role with a `url` + `boneMap` change only. Do not hardcode those paths in gameplay code.
- `src/data/tuning.json`, `strings.json`, `enemies.json`, `powers.json`, `puzzle.json`.

## Claude / Lumen stubs already on the bus

`src/ai/*` (C1–C2), `src/audio/{music,bpm,mixhealth,sidechain,sfx}.js` (L6–L7), `src/fx/blink.js` + `src/ui/{tempo-widget,daw-menu}.js` (L8 / L5) exist as no-ops or bus listeners so the game runs without those systems.

## Debug hooks (`window.AG`)

`ready`, `modelLoaded`, `state()`, `tp(x,z,y?)`, `cam(yaw,pitch,dist?)`, `face(yaw)`, `setInput`, `clearInput`, `jump`, `tryVault`, `attack`, `blast`, `damage`, `goto`, `bus`, `clock`, `player`.
