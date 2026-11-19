// C2 test hooks: spawns the Dissonant Hulk in the arena from a test encounter (the real one is requested for
// enemies.json `encounters.arena.boss`), then enters the arena. B prints the boss state to the console.
import { createEncounters } from '../src/ai/encounters.js';

while (!window.AG?.ready) await new Promise((r) => setTimeout(r, 100));
const game = window.game;
const enemiesData = await fetch('src/data/enemies.json').then((r) => r.json());
// main.js's own encounters already spawn the arena squads; this instance adds only the boss (unless the data has one)
const boss = enemiesData.encounters?.arena?.boss ?? { type: 'hulk', pos: [0, 0, 6], yaw: Math.PI };
const encounters = { arena: { boss } };
const enc = createEncounters({
  bus: game.bus, scene: game.scene, physics: game.physics, player: game.player, enemies: game.enemies, manifest: game.manifest,
  data: { enemies: { ...enemiesData, encounters: { arena: encounters.arena } }, strings: game.strings },
});
let last = performance.now();
(function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  enc.update(Math.min((now - last) / 1000, 0.1));
  last = now;
})();
const log = [];
for (const t of ['bossPhase', 'bossTelegraph', 'bossAttack', 'bossDefeated']) game.bus.on(t, (p) => log.push(`${t}:${p.kind ?? p.phase ?? ''}`));
game.bus.on('enemyHit', (p) => p.kind === 'hulk' && log.push(`hit:${p.amount.toFixed(1)}${p.weak ? ':WEAK' : ''}`));
addEventListener('keydown', (e) => {
  if (e.code === 'KeyB') console.table(window.__boss());
});
window.__boss = () => {
  const h = enc.ai?.enemies.find((x) => x.kind === 'hulk');
  return h && { hp: Math.round(h.hp), phase: h.phase, state: h.state, weak: h.weakOpen, attack: h.attack?.kind, voids: h.tiles.filter((t) => t.state === 'void').length, cracked: h.tiles.filter((t) => t.state === 'cracked').length, log: log.slice(-12) };
};
window.__enc2 = enc;
game.goto('arena');
