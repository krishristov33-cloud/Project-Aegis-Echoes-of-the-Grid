# Aegis task split

Goal: a gorgeous, playable vertical slice. **Rooftop escape (Sofia) → drop into the Antarctic Cradle → acoustic puzzle chamber → Dissonant Hulk boss.**
Usage cap from Oracle: build in priority order so whatever lands is playable.

## Repo layout
```
index.html            import map + canvas + HUD root
src/main.js           boot, loop, scene switching
src/core/             events.js, input.js, time.js, assets.js (manifest loader), audio-clock.js
src/player/           controller.js, camera.js, locomotion.js, ik.js, combat.js, powers/*.js
src/ai/               perception.js, cover.js, squad.js, soldier.js, drone.js, hulk.js
src/audio/            music.js (stems), mixhealth.js, sidechain.js, bpm.js, sfx.js
src/world/            rooftop.js, cradle.js, chamber.js, geo-extrude.js, rain.js
src/fx/               post.js, blink.js, shaders/*
src/ui/               hud.js, tempo-widget.js, daw-menu.js
src/data/             tuning.json, enemies.json, powers.json, strings.json, puzzle.json
assets/manifest.json  every model/clip/audio path
```

## Owners
| ID | Task | Owner | Why them |
|---|---|---|---|
| **L1** | Core: boot, loop, input, asset manifest, event bus, third-person camera | **Lumen** (in progress) | Already building it |
| **L2** | Player controller + locomotion blend space (idle/walk/jog/run/sprint), turn-in-place, jump/land/vault, foot IK (from Kanemori `locomotion.js`) | **Lumen** | In progress |
| **L3** | Greyboxes + level flow (rooftop escape → Cradle → acoustic chamber → boss): rooftop rain/neon first, then Cradle + chamber + boss-arena greyboxes | **Lumen** | Level flow owner |
| **L4** | Melee combo + Sub-Bass Blast + hit reactions (state machine with crossfades) | **Lumen** | Tied to L2 state machine |
| **L5** | HUD, tempo widget, DAW upgrade menu | **Lumen** | |
| **C5** (was L6) | **Tempo Sync** beat clock + music: `audio-clock.js`, `bpm.js`, `music.js`; configurable BPM so Kris can load his own tracks; replaces the stub `audio-clock.js` (Claude may edit that one core file for this task) | **Claude** | Clock everything else syncs to |
| **C6** (was L7) | **Mix-as-health + sidechain duck**: `mixhealth.js`, `sidechain.js`; damage distorts the master, healing cleans it; hits duck enemies for a punish window | **Claude** | Audio DSP + combat hook |
| **C7** (was L8) | **Frame-Drop Blink + ghost decoy**: `fx/blink.js`, `player/powers/blink.js`; Phase-Skip stays in C3 | **Claude** | Player power, AI targets the ghost |
| **C1** | **Enemy AI** on a navmesh: perception (sight cone, hearing), cover-point generation, squad tactics (suppress + flank, callouts as bus events), Directorate soldier + drone behaviours; navmesh via `three-pathfinding` or `recast-navigation-js` | **Claude** | Hardest gameplay system |
| **C2** | **Dissonant Hulk boss**: 3 phases, thrown floor chunks, destructible floor, gravity well, weak points that open only when ducked on-beat | **Claude** | Depends on C1 and C3 |
| **C3** | **Physics layer with Rapier**: replace the box-collider API; Phase-Skip through walls and bullets; Wave-Shield floor extrusion in `geo-extrude.js`; Resonant Launchpad | **Claude** | Math + collision heavy |
| **C4** | **Acoustic puzzle chamber**: `chamber.js` puzzle logic using Krea's `puzzle.json` (Lumen owns the greybox in L3) | **Claude** | Puzzle systems |
| **A1** | Retarget Mixamo clips, tune blends/foot IK, combat timing (hit-stop, anticipation) | **Aether** | Motion owner |
| **A2** | VFX: blink datamosh shader, sub-bass cone, shield, Dissonant static-void shader, Light Creator gold geometry | **Aether** | |
| **K1** | Spec, tuning values, acoustic puzzle design (`puzzle.json`), enemy stats, strings | **Krea** | Design owner |
| **K2** | Higgsfield 3D models into `assets/` + manifest (7 rigged characters, 10 props) after concepts are approved | **Krea + Lumen** | Credits approved by Kris |

Lumen also merges Claude's PRs into `main` after a playable check.

**Order**: L1–L4 done (on main). Claude's queue: **C1 → C5 → C6 → C7 → C3 → C2 → C4**. Lumen (capped until usage resets): L5 HUD, PR review/merge. Aether joins once L2 runs.

## Contracts (event bus, `src/core/events.js`)
```js
bus.emit('beat', {index, bar, phase, bpm})        // C1, every beat
bus.emit('resonance', {value})                    // 0..1, combat intensity, drives stems
bus.emit('playerDamaged', {amount, hp, hpMax})    // L4 → C2 distorts the mix
bus.emit('playerHealed', {amount, hp, hpMax})
bus.emit('sidechain', {source, strength, onBeat}) // L4 on hit → C2 + C3 duck enemies
bus.emit('enemyDucked', {id, until})              // C3
bus.emit('noise', {pos, radius, kind})            // footsteps/shots → C3 hearing
bus.emit('blink', {from, to, ghostId})            // C4 → C3 targets ghost
bus.emit('callout', {speaker, text, pos})         // C3 → L5 subtitle + audio
bus.emit('levelState', {level, phase})            // L3/C5
// added by C1 (Claude, src/ai/):
bus.emit('enemyShot', {id, from, to, hit, targetGhost})  // tracer / muzzle flash / gunshot sfx (A2, sfx)
bus.emit('enemyHit', {id, kind, amount, hp, hpMax, pos, src}) // hit reaction anim, hitmarker (A1, L5)
bus.emit('enemyKilled', {id, kind, pos})                 // death anim, resonance, level flow (A1, L3, L6)
bus.emit('phaseSkip', {from, to})                        // C3 → A2 phase-skip streak
bus.emit('waveShield', {origin, dir, duration})          // C3 → A2 wave-shield VFX
bus.emit('launchpad', {origin, burst?})                  // C3 → A2 launchpad pulse / burst
// added with the vertical-slice pass:
bus.emit('impact', {pos, strength, kind, onBeat, id?, release?, from?}) // kind: melee|blast|kill|hurt|land. One event for all
                                                         // hit feel: main.js hit-stop + camera shake, post pulse, sfx
bus.emit('playerAction', {name, index?, onBeat?, strength?}) // jump|land|vault|dodge|swing|blastCharge|death|respawn (sfx, tips)
bus.emit('playerDied', {pos})                            // death screen; player respawns at the last safe-ground checkpoint
bus.emit('playerRespawned', {pos, fall?})
bus.emit('comboChanged', {count, onBeatStreak})          // landed-hit streak for the HUD
bus.emit('enemyTelegraph', {id, kind, pos, time})        // src/ai, just before a dangerous attack (HUD warning, sfx)
bus.emit('objective', {level, key, text})                // encounter-flow → HUD objective line
bus.emit('puzzleState', {level, stage, stages, phase, progress, length, type}) // chamber: waiting|listen|answer|chord|solved
bus.emit('puzzleNote', {level, pad, note, by, ok, onBeat, index})
bus.emit('puzzleFail', {level, stage, reason})           // wrongPad|offBeat|tooSlow
bus.emit('puzzleSolved', {level})                        // unlocks the chamber → arena gate
// levelState also fires {level, phase:'clear'} when a level's gate unlocks
```
Note on the labels above: they predate the final owner split. Current owners: `beat` is L6, `sidechain` comes from L4/L7 and `src/ai/director.js` ducks enemies on it, `noise` is consumed by C1 hearing, `blink` is emitted by L8 and C1 makes enemies shoot the ghost, `callout` is emitted by C1 squads for L5.
Player API exposed on `game.player`: `position, velocity, isGrounded, hp, state, applyImpulse(v), takeDamage(n, src)`.
`player._iframe > 0` (dodge, respawn, phase-skip) means untouchable: `takeDamage` returns 0. `player.state` also reports `dodge`, `roll`, `skid`, `vault`, `dead`.

## Animation
Humanoid clips come from two places: the donor rig's own loops (idle / walk / run) and the procedural library in `src/anim/clips.js`, authored as keyframed poses on canonical channels (`src/anim/pose-rig.js`) and baked onto the donor role flagged `procClips` in the manifest. Both are retargeted to every role with `animSource`, so a new rig only needs a bone map. Add a clip by adding a definition to `CLIP_DEFS`; its name is its logical name.
Enemy API: `id, position, hp, state, duck(sec), takeDamage(n, src)`.
On-beat rule: an action is on-beat if `|phase| < 0.12` or `> 0.88`; damage ×1.5 and a shockwave.
