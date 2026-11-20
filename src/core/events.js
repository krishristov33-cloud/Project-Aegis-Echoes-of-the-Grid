// Event-bus contract. Systems talk through this, not direct imports.
// Add new event names here in the same PR that first emits them.
export const Events = Object.freeze({
  beat: 'beat',
  bar: 'bar',
  resonance: 'resonance',
  playerDamaged: 'playerDamaged',
  playerHealed: 'playerHealed',
  sidechain: 'sidechain',
  enemyDucked: 'enemyDucked',
  noise: 'noise',
  blink: 'blink',
  callout: 'callout',
  levelState: 'levelState',
  phaseSkip: 'phaseSkip',
  waveShield: 'waveShield',
  launchpad: 'launchpad',
  bossPhase: 'bossPhase',
  bossTelegraph: 'bossTelegraph',
  bossAttack: 'bossAttack',
  bossDefeated: 'bossDefeated',
  enemyShot: 'enemyShot',
  enemyHit: 'enemyHit',
  enemyKilled: 'enemyKilled',
  enemyTelegraph: 'enemyTelegraph',
  enemyAttack: 'enemyAttack',
  impact: 'impact',
  playerAction: 'playerAction',
  playerDied: 'playerDied',
  playerRespawned: 'playerRespawned',
  comboChanged: 'comboChanged',
  objective: 'objective',
  puzzleState: 'puzzleState',
  puzzleNote: 'puzzleNote',
  puzzleFail: 'puzzleFail',
  puzzleSolved: 'puzzleSolved',
});

class Bus {
  constructor() { this._m = new Map(); this._log = false; }
  on(name, fn) {
    let s = this._m.get(name); if (!s) { s = new Set(); this._m.set(name, s); }
    s.add(fn); return () => this.off(name, fn);
  }
  off(name, fn) { const s = this._m.get(name); if (s) s.delete(fn); }
  once(name, fn) {
    const wrap = (d) => { this.off(name, wrap); fn(d); };
    return this.on(name, wrap);
  }
  emit(name, detail) {
    if (this._log) console.log('[bus]', name, detail);
    const s = this._m.get(name); if (!s) return;
    for (const fn of [...s]) {
      try { fn(detail); } catch (err) { console.error('[bus] listener error for', name, err); }
    }
  }
}

export const bus = new Bus();
