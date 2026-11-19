# Project Aegis: Echoes of the Grid

Third-person action thriller in three.js. Kael, an animator and neurofunk producer from Sofia, escapes rainy rooftops, drops into a prehistoric world under Antarctica, solves acoustic puzzles inside the World Engine and fights the Dissonant Hulk.

- Spec: `docs/SPEC.md` (full design lives in the Main Brain vault at `Apex/Projects/Project Aegis.md`, mirrored here)
- Task split and owners: `docs/TASKS.md`
- Rules for any coding agent (Claude included): `AGENTS.md` / `CLAUDE.md`

## Run
No build step. Serve the repo root and open `index.html`:
```
npx serve .     # or: python3 -m http.server 8080
```
three.js comes from an import map (CDN), all game code is ES modules under `src/`.
