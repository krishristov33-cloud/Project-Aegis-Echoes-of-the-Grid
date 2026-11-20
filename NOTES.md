# Aegis L1–L4 notes (first push)

Playable vertical-slice skeleton: third-person controller, locomotion, foot IK, rooftop greybox, melee + Sub-Bass Blast + hit reactions, stub beat clock. **Not pushed.** Serve the repo root and open `index.html`.

## What's done

- **L1** Boot, loop, input, event bus, manifest loader, third-person camera, `window.AG` / `game.player`.
- **L2** Capsule controller (gravity, slopes, jump/land, vault), Kanemori-style speed blend (idle/walk/jog/run/sprint), turn lean, two-bone foot IK on uneven ground.
- **L3** Rooftop greybox first (rain, neon, crates, ramp, uneven patch, city). Cradle, acoustic chamber, and boss-arena greyboxes + `goto` / portals for the full flow.
- **L4** Melee combo (3 hits), Sub-Bass Blast cone knockback, hit reactions, on-beat multiplier, `sidechain` / `noise` / damage events.
- Stub `audio-clock.js` emits `beat` / `bar` at **174 BPM** (Krea's master concept). `setBpm` is ready for Kris's tracks (L6 will replace the stub).
- Collider API in `src/core/physics.js` is shaped so C3 can drop in Rapier without changing the controller or camera.
- Canonical `boneMap` on each manifest role (VRM-style names) with Mixamo / common-rig auto-detect, so later Tripo + Meshy rigs (non-Mixamo bones) swap in without gameplay code changes. Clip retargeting is an A1 stub (`src/core/retarget.js`).

## Controls

| Input | Action |
|---|---|
| WASD | Move (camera-relative) |
| Shift | Sprint |
| Ctrl / X | Walk |
| Space | Jump (hold for height), or vault a waist-high crate / ledge in front |
| C / RMB / Left Alt | Dodge with i-frames (longer on the beat); backward hop with no direction held |
| Mouse (click to lock) | Look |
| LMB / J | Melee chain: cross, hook, roundhouse. Snaps to the nearest target in front |
| F / K | Sub-Bass Blast |
| Q / R / G / T | Blink / Phase-Skip / Wave-Shield / Launchpad |
| Esc | Pause |
| 1–4 (`?debug=1`) | Rooftop / Cradle / chamber / arena |

URL flags: `?debug=1` debug panel + level keys, `?nopost=1` plain render, `?noreflect=1` no planar reflections, `?noai=1` no enemies, `?shots=1` headless test mode.

## How to run / test

```
cd /path/to/Aegis-Echoes-of-the-Grid
python3 -m http.server 8080
# open http://127.0.0.1:8080/index.html
# headless: python3 tests/test_l1_l4.py  (server on 8765, ?shots=1)
# on a machine with a GPU and Chrome: AEGIS_CHROME=1 AEGIS_GPU=1 python tests/test_l1_l4.py
```

Headless result (Playwright + Chromium swiftshader): **no console/page errors**, Xbot loaded, bone map bound (`mixamorigHips` etc.), scripted **idle → sprint (7.5 m/s) → jump → vault** (landed past the crate at z≈8.1). Melee state entered. Screenshots:

- `shots/01_idle_rooftop.png`
- `shots/02_sprint.png`
- `shots/03_vault.png`

## Clip / model sources

- **This push:** three.js examples **Xbot.glb** and **Soldier.glb** (MIT, Mixamo-compatible). Not raw Mixamo marketplace files.
- **Planned clip base:** Quaternius Universal Animation Library 1+2 (CC0, in-place). A free UAL 1 glTF mirror is available (`J-Ponzo/gltf-universal-animation-library`) but it uses Rigify `DEF-*` bones, not `mixamorig:*`, so it was **not** dropped into `assets/`. Manifest field `plannedUALClipMap` has the clip-name map for Aether (A1) to retarget.
- **Incoming art:** unrigged Tripo meshes are already arriving at `/workspace/apex/aegis/models/raw/` (kael, soldier, soul_harvester, …). Meshy rigs + `MODELS.md` will follow. Point `assets/manifest.json` `url` + `boneMap` at them when they are rigged. Do not hardcode those paths.

## Known issues

- Jump / vault / land have no dedicated Xbot clips (procedural / reused poses). UAL's `Jump_Start` / `Jump_Land` / `Roll` will fix this after retarget.
- Melee uses Xbot `agree` / `headShake` as placeholders; blast uses `sneak_pose`; hit uses `sad_pose`.
- Camera collision can still graze nearby props (a slice of the training dummy appeared in one vault frame).
- Rooftop `amuNet` neon reads as floor colour blobs more than a readable sign at the default camera; needs a framed angle or a bigger sign once K2 props land.
- Headless swiftshader sits around 6–15 fps; `?shots=1` loosens `maxDt`. Real-GPU FPS is unmeasured.
- Raw Tripo meshes are **unrigged** — not playable yet.
- L5–L8 and C1–C4 are stubs only (game runs without them).

## Rough estimate for the rest

| Task | Estimate |
|---|---|
| L5 HUD, tempo widget, DAW menu | 0.5 day |
| L6 Tempo Sync + stem music + user BPM | 0.5–1 day |
| L7 Mix-as-health + sidechain duck | 0.5 day |
| L8 Frame-Drop Blink + ghost decoy | 0.5 day |
| C1 Enemy AI + navmesh (soldiers, drone) | 1–1.5 days |
| C3 Rapier + Phase-Skip / Wave-Shield / Launchpad | 1–1.5 days |
| C4 Acoustic puzzle chamber logic | 0.5–1 day |
| C2 Dissonant Hulk (after C1/C3) | 1 day |
| A1 UAL / Meshy retarget + blend tune | 0.5–1 day |
| K2 model swap via manifest | once rigs land |

**About 6–8 working sessions** after this push, assuming Claude takes C1–C4 in parallel once L1 is on `main`.
