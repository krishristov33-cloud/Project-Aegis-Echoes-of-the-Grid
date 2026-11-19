// Minimal event bus with the same shape the game's src/core/events.js is expected to have
// (on/off/emit). Test harness only: delete once Lumen's L1 core is on main and import that instead.
export function createBus({ log = false } = {}) {
  const map = new Map();
  const bus = {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => bus.off(type, fn);
    },
    off(type, fn) {
      map.get(type)?.delete(fn);
    },
    emit(type, payload) {
      if (log) console.debug('[bus]', type, payload);
      for (const fn of [...(map.get(type) ?? [])]) fn(payload);
      for (const fn of [...(map.get('*') ?? [])]) fn(type, payload);
    },
  };
  return bus;
}
