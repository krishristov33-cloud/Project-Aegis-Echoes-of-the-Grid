// Stub beat clock (L6 will replace this with a real Web Audio Tempo Sync clock).
// Emits 'beat' / 'bar' on the bus at the BPM from src/data/tuning.json.
// Configurable so Kris can later load his own tracks.

export function createAudioClock(bus, tuning) {
  const audio = tuning.audio || {};
  let bpm = audio.bpm || 140;
  const beatsPerBar = audio.beatsPerBar || 4;
  let acc = 0;
  let index = 0;
  let phase = 0;
  const window = (tuning.combat && tuning.combat.onBeatWindow) || 0.12;

  function beatDur() { return 60 / Math.max(1, bpm); }

  return {
    setBpm(n) { if (n > 0) bpm = n; },
    getBpm() { return bpm; },
    getPhase() { return phase; },
    getIndex() { return index; },
    isOnBeat() { return phase < window || phase > 1 - window; },
    update(dt) {
      const dur = beatDur();
      acc += dt;
      while (acc >= dur) {
        acc -= dur;
        const bar = Math.floor(index / beatsPerBar);
        const beatInBar = index % beatsPerBar;
        bus.emit('beat', { index, bar, phase: 0, bpm });
        if (beatInBar === 0) bus.emit('bar', { index, bar, phase: 0, bpm });
        index++;
      }
      phase = acc / dur;
    },
  };
}
