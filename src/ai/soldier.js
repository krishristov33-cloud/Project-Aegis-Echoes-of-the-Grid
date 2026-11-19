// C1 stub: Directorate soldier. Implements the Enemy API so callers can exist.
export function createSoldier({ id = 'soldier-0', position, hp = 60 } = {}) {
  return {
    id, position, hp, state: 'idle',
    duck(sec) { this.state = 'ducked'; this._until = sec; },
    takeDamage(n) { this.hp = Math.max(0, this.hp - n); return n; },
    update() {},
  };
}
