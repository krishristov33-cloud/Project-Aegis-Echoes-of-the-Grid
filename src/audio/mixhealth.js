// L7 stub: damage distorts the master, healing cleans it.
export function createMixHealth(bus) {
  const off = bus.on('playerDamaged', () => {});
  const off2 = bus.on('playerHealed', () => {});
  return { dispose() { off(); off2(); } };
}
