// Finds the Tempo Sync audio graph (C5: game.clock.audio = {ctx, master, musicBus, sfxBus}) for systems that main.js
// creates with only the bus (mixhealth, sidechain). The graph exists only after the first user gesture, so this
// checks on every `beat` until it appears, then calls `cb(graph, clock)` once.
export function whenAudioReady(bus, cb, getClock = () => globalThis.game?.clock) {
  let done = false;
  const tryAttach = () => {
    if (done) return;
    const clock = getClock();
    const graph = clock?.audio;
    if (!graph?.ctx) return;
    done = true;
    off?.();
    cb(graph, clock);
  };
  const off = bus.on('beat', tryAttach);
  tryAttach();
  return () => {
    done = true;
    off?.();
  };
}
