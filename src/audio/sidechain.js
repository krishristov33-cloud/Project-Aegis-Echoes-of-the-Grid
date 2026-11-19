// L7 stub: listen for sidechain hits (L4 already emits them).
export function createSidechain(bus) {
  const off = bus.on('sidechain', () => {});
  return { dispose() { off(); } };
}
