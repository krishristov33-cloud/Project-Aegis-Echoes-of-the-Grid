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
| **L3** | Rooftop greybox, rain, neon, then Cradle + chamber greybox | **Lumen** | Level flow owner |
| **L4** | Melee combo + Sub-Bass Blast + hit reactions (state machine with crossfades) | **Lumen** | Tied to L2 state machine |
| **L5** | HUD, tempo widget, DAW upgrade menu | **Lumen** | |
| **C1** | **Adaptive music engine** (Web Audio): 4 stem layers (sub, mid-bass, drums, leads) crossfaded by Resonance; `audio-clock.js` beat clock exposed on the bus (`beat`, `bar`, phase 0-1); BPM from data, plus offline BPM detection for user-loaded tracks | **Claude** | Hardest timing work; everything syncs to it |
| **C2** | **Mix-as-health + sidechain**: damage drives a waveshaper/clipper + bitcrush + lowpass on the master; heal cleans it. Player hits emit `sidechain` → enemies' `ducked` window (0.35 s) + audible pump on music | **Claude** | Audio DSP |
| **C3** | **Enemy AI**: perception (sight cone, hearing), cover-point generation on the greybox, squad tactics (suppress + flank, callouts as bus events), soldier + drone behaviours; navmesh via `three-pathfinding` or `recast-navigation-js` | **Claude** | Hardest gameplay system |
| **C4** | **Geometry powers**: `geo-extrude.js` for Wave-Shield (floor tiles extrude along normal, collide, decay) and Resonant Launchpad (gravity-vector pad); Phase-Skip collision bypass; Blink with ghost-frame decoy that AI keeps targeting | **Claude** | Math + collision heavy |
| **C5** | **Dissonant Hulk boss**: 3 phases, rips floor chunks (uses C4 extrude), gravity well, weak points that open only when ducked on-beat | **Claude** | Depends on C1–C4 |
| **A1** | Retarget Mixamo clips, tune blends/foot IK, combat timing (hit-stop, anticipation) | **Aether** | Motion owner |
| **A2** | VFX: blink datamosh shader, sub-bass cone, shield, Dissonant static-void shader, Light Creator gold geometry | **Aether** | |
| **K1** | Spec, tuning values, acoustic puzzle design (`puzzle.json`), enemy stats, strings | **Krea** | Design owner |
| **K2** | Higgsfield 3D models into `assets/` + manifest (7 rigged characters, 10 props) after concepts are approved | **Krea + Lumen** | Credits approved by Kris |

**Order**: L1 → (L2 ∥ C1) → (L3 ∥ C2 ∥ C3) → (L4 ∥ C4) → L5 → C5. Aether joins once L2 runs.

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
```
Player API exposed on `game.player`: `position, velocity, isGrounded, hp, state, applyImpulse(v), takeDamage(n, src)`.
Enemy API: `id, position, hp, state, duck(sec), takeDamage(n, src)`.
On-beat rule: an action is on-beat if `|phase| < 0.12` or `> 0.88`; damage ×1.5 and a shockwave.
