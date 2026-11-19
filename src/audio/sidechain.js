// Sidechain combat (C6), audio side: every hit Kael lands (`sidechain {source, strength, onBeat}` from combat.js)
// pumps the music down like a sidechained kick and releases over an eighth note, with a sub thump on the SFX bus.
// On-beat hits pump deeper and thump harder.
// The gameplay side, enemies ducking for a punish window, lives in the enemies (src/ai/enemy.js): any player
// hit ducks the enemy that was hit, x1.5 on beat.
import { whenAudioReady } from './audio-graph.js';

const DEFAULTS = {
  depth: 0.65, // music gain dip at strength 1
  onBeatDepth: 0.85,
  attack: 0.008,
  releaseBeats: 0.5, // release over an eighth note
  thump: 0.7,
};

export function createSidechain(bus, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let graph = null;
  let clock = null;
  let baseMusic = 1;
  let pumps = 0;

  function thump(t, strength, onBeat) {
    const { ctx, sfxBus } = graph;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(onBeat ? 120 : 95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(cfg.thump * strength * (onBeat ? 1.3 : 1), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(sfxBus);
    o.start(t);
    o.stop(t + 0.25);
  }

  const offs = [
    whenAudioReady(bus, (g, c) => {
      Object.assign(cfg, globalThis.game?.tuning?.audio?.sidechain ?? {}, opts);
      graph = g;
      clock = c;
      baseMusic = g.musicBus.gain.value;
    }),
    bus.on('sidechain', ({ strength = 1, onBeat = false } = {}) => {
      if (!graph) return;
      const { ctx, musicBus } = graph;
      const t = ctx.currentTime;
      const s = Math.max(0, Math.min(1.5, strength));
      const depth = Math.min(0.95, (onBeat ? cfg.onBeatDepth : cfg.depth) * s);
      const release = (60 / (clock?.getBpm?.() || 174)) * cfg.releaseBeats;
      const gp = musicBus.gain;
      gp.cancelScheduledValues(t);
      gp.setValueAtTime(gp.value, t);
      gp.linearRampToValueAtTime(baseMusic * (1 - depth), t + cfg.attack);
      gp.setTargetAtTime(baseMusic, t + cfg.attack, release / 3);
      thump(t, Math.min(1, s), onBeat);
      pumps++;
    }),
  ];

  return {
    get pumps() {
      return pumps;
    },
    dispose() {
      offs.forEach((o) => o?.());
    },
  };
}
