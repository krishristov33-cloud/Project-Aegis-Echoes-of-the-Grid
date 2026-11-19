// C2 stub: Dissonant Hulk. Enemy API; phases/chunks come in C2.
export function createHulk({ id = 'hulk', position, hp = 1200 } = {}) {
  return { id, position, hp, state: 'idle', phase: 1, duck() {}, takeDamage(n) { this.hp = Math.max(0, this.hp - n); return n; }, update() {} };
}
