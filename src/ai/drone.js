// C1 stub: recon drone. Enemy API.
export function createDrone({ id = 'drone-0', position, hp = 25 } = {}) {
  return { id, position, hp, state: 'idle', duck() {}, takeDamage(n) { this.hp = Math.max(0, this.hp - n); return n; }, update() {} };
}
