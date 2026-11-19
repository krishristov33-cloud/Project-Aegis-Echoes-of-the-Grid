// C4 test hooks: jump straight into the chamber and expose the live puzzle. Walk onto the centre to begin.
import { puzzleFor } from '../src/world/acoustic-puzzle.js';

while (!window.AG?.ready) await new Promise((r) => setTimeout(r, 100));
const game = window.game;
const log = [];
for (const t of ['puzzleState', 'puzzleNote', 'puzzleFail', 'puzzleSolved']) game.bus.on(t, (p) => log.push({ t, ...p }));
game.goto('chamber');
window.__puzzle = () => puzzleFor(game.scene.getObjectByName('chamber'));
window.__plog = log;
