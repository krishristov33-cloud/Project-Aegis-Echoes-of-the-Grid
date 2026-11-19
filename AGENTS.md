# Rules for coding agents on Aegis

Several agents work in this repo at once: **Lumen** (core gameplay), **Claude** (hard systems), **Aether** (animation + VFX), **Krea** (design + data). Read `docs/TASKS.md` and only touch the files your task owns.

## Golden rules
1. **Branch per task**: `claude/<task-id>`, `lumen/<task-id>`, `aether/<task-id>`. Open a PR to `main`; keep `main` always playable.
2. **Own your files.** Shared files (`src/core/*`, `assets/manifest.json`, `index.html`) change only through small, clearly described PRs.
3. **Talk through the event bus**, not direct imports between systems. `src/core/events.js` is the contract (see "Contracts" in TASKS.md). Add new events there in the same PR that emits them.
4. **Assets only via `assets/manifest.json`.** Never hardcode a GLB path. Placeholders now; Higgsfield rigged models swap in later with a manifest change only.
5. **Skeletons are Mixamo-compatible humanoids** (`mixamorig:` bone names). Retarget everything to that.
6. **Performance budget**: 60 fps on a mid laptop at 1080p. Under ~300 draw calls, shadows from one directional light, instanced rain.
7. **Tuning numbers live in `src/data/*.json`**, never as magic numbers in code. Krea owns those files' values.
8. Every PR: what changed, how to test it in the browser, a screenshot or short clip if visual.
9. No secrets in the repo. No paid API calls from game code.
10. The company name `amuNet` is a placeholder (too close to a real company). Keep it in one constant in `src/data/strings.json` so it can be renamed before release.
