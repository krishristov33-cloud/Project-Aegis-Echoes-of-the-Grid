// Attaches C1 encounters to the running game without touching src/main.js.
// Once Lumen wires createEncounters into main.js (see src/ai/README.md), this page is no longer needed.
// The rooftop squad below is a TEST spawn list; the real one is requested for enemies.json `encounters`.
import { createEncounters } from '../src/ai/encounters.js';

const TEST_ENCOUNTERS = {
  rooftop: {
    squads: [
      {
        name: 'roof-a',
        soldiers: [
          { pos: [-9, 0, -7.5], yaw: 0, patrol: [[-9, 0, -7.5], [-3, 0, -8.5], [-9, 0, -2]] },
          { pos: [9, 0, -9], yaw: 0, patrol: [[9, 0, -9], [11, 0, -3], [4, 0, -4]] },
          { pos: [0, 0, -9.3], yaw: 0 },
        ],
        drones: [{ pos: [0, 0, -4], patrol: [[-10, 0, -8], [10, 0, -8], [10, 0, 2], [-10, 0, 2]] }],
      },
    ],
  },
};

while (!window.AG?.ready) await new Promise((r) => setTimeout(r, 100));
const game = window.game;
// main.js now wires createEncounters; do not attach a second director.
if (game.encounters) {
  window.__enc = game.encounters;
} else {
  const enemiesData = await fetch('src/data/enemies.json').then((r) => r.json());
  const data = { enemies: { ...enemiesData, encounters: enemiesData.encounters ?? TEST_ENCOUNTERS }, strings: game.strings };
  const encounters = createEncounters({
    bus: game.bus,
    scene: game.scene,
    physics: game.physics,
    player: game.player,
    enemies: game.enemies,
    manifest: game.manifest,
    data,
  });
  let last = performance.now();
  (function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    encounters.update(Math.min((now - last) / 1000, game.time?.maxDt ?? 0.1));
    last = now;
  })();
  game.goto(game.level ?? 'rooftop'); // re-enter so encounters sees levelState
  window.__enc = encounters;
}
game.bus.on('callout', ({ speaker, text }) => console.log(`[callout] ${speaker}: ${text}`));
