// C2 test hooks: the real game already spawns the arena Hulk from enemies.json
// `encounters.arena.boss`. This file only logs boss events and exposes window.__boss.
// B prints the boss state to the console.
while (!window.AG?.ready) await new Promise((r) => setTimeout(r, 100));
const game = window.game;
const log = [];
for (const t of ['bossPhase', 'bossTelegraph', 'bossAttack', 'bossDefeated']) {
  game.bus.on(t, (p) => log.push(`${t}:${p.kind ?? p.phase ?? ''}`));
}
game.bus.on('enemyHit', (p) => p.kind === 'hulk' && log.push(`hit:${p.amount.toFixed(1)}${p.weak ? ':WEAK' : ''}`));
function findHulk() {
  return (game.enemies || []).find((x) => x.kind === 'hulk')
    || game.encounters?.ai?.enemies?.find((x) => x.kind === 'hulk');
}
window.__boss = () => {
  const h = findHulk();
  return h && {
    hp: Math.round(h.hp),
    phase: h.phase,
    state: h.state,
    weak: h.weakOpen,
    attack: h.attack?.kind,
    voids: h.tiles?.filter((t) => t.state === 'void').length,
    cracked: h.tiles?.filter((t) => t.state === 'cracked').length,
    log: log.slice(-12),
  };
};
addEventListener('keydown', (e) => {
  if (e.code === 'KeyB') console.table(window.__boss());
});
if (game.level !== 'arena') game.goto('arena');
