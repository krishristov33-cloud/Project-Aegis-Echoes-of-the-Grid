// Tempo Sync beat clock (C5). Same API the L1 stub had, so main.js / combat.js / HUD are unchanged:
//   setBpm(n), getBpm(), getPhase(), getIndex(), isOnBeat(), update(dt)
// plus:
//   clock.audio        { ctx, master, musicBus, sfxBus } once Web Audio has started (first click / key press)
//   clock.music        the music engine (src/audio/music.js): procedural stems or a loaded track
//   clock.loadTrack(src)  File | Blob | ArrayBuffer | AudioBuffer | URL -> detects BPM + first beat, locks the clock to it
//   clock.beatTime(pos)   context time at which beat position `pos` is *played* (for sample-accurate scheduling)
//
// Timebase: before audio starts the clock runs on frame dt (as the stub did). Once the AudioContext runs, the beat
// position is derived from ctx.currentTime, minus output latency, so "on beat" means "on the beat the player hears".
// Switching timebase or BPM never jumps the beat position.
//
// Emits `beat {index, bar, phase, bpm}` on every beat and `bar {...}` on the first beat of each bar.
import { createMusic } from '../audio/music.js';
import { detectBpm } from '../audio/bpm.js';

export function createAudioClock(bus, tuning) {
  const A = tuning.audio || {};
  let bpm = A.bpm || 140;
  const beatsPerBar = A.beatsPerBar || 4;
  const window_ = (tuning.combat && tuning.combat.onBeatWindow) || 0.12;
  const extraLatency = (A.latencyMs ?? 0) / 1000;

  let beatPos = 0; // continuous beat position (heard)
  let lastIndex = -1;
  let anchor = 0; // ctx time (played) of beat position 0, audio timebase only
  let ctx = null;
  let audio = null;
  let music = null;
  let starting = null;

  const beatDur = () => 60 / Math.max(1, bpm);
  const latency = () => (ctx ? (ctx.outputLatency || ctx.baseLatency || 0) + extraLatency : 0);
  const audioRunning = () => ctx && ctx.state === 'running';

  function reanchor() {
    // keep the current beat position continuous under a new bpm / timebase
    if (ctx) anchor = ctx.currentTime - latency() - beatPos * beatDur();
  }

  function emitBeats() {
    const idx = Math.floor(beatPos);
    if (idx <= lastIndex) return;
    // after a long stall only announce the latest beat (no burst of stale beats)
    const from = Math.max(lastIndex + 1, idx - 1);
    for (let i = from; i <= idx; i++) {
      if (i < 0) continue;
      const bar = Math.floor(i / beatsPerBar);
      const d = { index: i, bar, phase: beatPos - idx, bpm };
      bus.emit('beat', d);
      if (i % beatsPerBar === 0) bus.emit('bar', d);
    }
    lastIndex = idx;
  }

  /** Create / resume the AudioContext. Must be called from a user gesture the first time. */
  function startAudio() {
    if (starting) return starting;
    starting = (async () => {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: 'interactive' });
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      const master = ctx.createGain();
      master.gain.value = A.masterVolume ?? 0.9;
      master.connect(ctx.destination);
      const musicBus = ctx.createGain();
      musicBus.gain.value = A.musicVolume ?? 0.55;
      musicBus.connect(master);
      const sfxBus = ctx.createGain();
      sfxBus.gain.value = A.sfxVolume ?? 0.9;
      sfxBus.connect(master);
      audio = { ctx, master, musicBus, sfxBus };
      reanchor();
      music = createMusic({ ctx, output: musicBus, clock: api, bus, cfg: A.music || {} });
      if (A.musicAutoplay !== false) music.start();
      if (qs?.get('track')) api.loadTrack(qs.get('track')).catch((err) => console.warn('[tempo] ?track failed', err));
      return audio;
    })();
    return starting;
  }

  // Browsers only allow audio after a gesture: start on the first click / key press anywhere.
  const gesture = () => {
    startAudio().then(() => ctx?.state !== 'running' && ctx?.resume());
    removeEventListener('pointerdown', gesture, true);
    removeEventListener('keydown', gesture, true);
  };
  if (typeof addEventListener === 'function') {
    addEventListener('pointerdown', gesture, true);
    addEventListener('keydown', gesture, true);
  }

  // Kris's own music: drop an audio file anywhere on the page (or ?track=<url>), or set ?bpm=<n> for the stems.
  if (typeof addEventListener === 'function' && A.trackDrop !== false) {
    addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.type.startsWith('audio/'))) e.preventDefault();
    });
    addEventListener('drop', (e) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('audio/'));
      if (!file) return;
      e.preventDefault();
      api.loadTrack(file).then(
        (r) => console.info(`[tempo] ${file.name}: ${r.bpm} BPM, first beat ${r.offset.toFixed(3)} s`),
        (err) => console.warn('[tempo] could not load', file.name, err),
      );
    });
  }
  const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (qs?.get('bpm') && +qs.get('bpm') > 0) bpm = +qs.get('bpm');

  const api = {
    setBpm(n) {
      if (!(n > 0)) return;
      bpm = n;
      reanchor();
    },
    getBpm() {
      return bpm;
    },
    getPhase() {
      return beatPos - Math.floor(beatPos);
    },
    getIndex() {
      return Math.max(0, Math.floor(beatPos));
    },
    /** Continuous beat position (heard). */
    getBeatPos() {
      return beatPos;
    },
    getBeatsPerBar() {
      return beatsPerBar;
    },
    isOnBeat() {
      const p = api.getPhase();
      return p < window_ || p > 1 - window_;
    },
    get timebase() {
      return audioRunning() ? 'audio' : 'frame';
    },
    get audio() {
      return audio;
    },
    get music() {
      return music;
    },
    startAudio,

    /** Context time at which beat position `pos` is played (schedule notes at this time). */
    beatTime(pos) {
      return anchor + pos * beatDur();
    },

    /**
     * Lock the grid: beat position `pos` is played at context time `t` (e.g. a track's first beat).
     * Beat indices continue from the current bar so listeners don't see the count jump backwards.
     */
    lockTo(t, newBpm, pos = 0) {
      if (newBpm > 0) bpm = newBpm;
      anchor = t - pos * beatDur();
      if (ctx) beatPos = (ctx.currentTime - latency() - anchor) / beatDur();
      lastIndex = Math.floor(beatPos) - 1;
    },

    /**
     * Load a track, detect tempo + first beat, play it, and sync the whole game to it.
     * @param {File|Blob|ArrayBuffer|AudioBuffer|string} src
     * @returns {Promise<{bpm, offset, confidence, duration}>}
     */
    async loadTrack(src, opts = {}) {
      await startAudio();
      if (!ctx) throw new Error('Web Audio unavailable');
      let buffer = src;
      if (!(src instanceof AudioBuffer)) {
        let data = src;
        if (typeof src === 'string') data = await (await fetch(src)).arrayBuffer();
        else if (src instanceof Blob) data = await src.arrayBuffer();
        buffer = await ctx.decodeAudioData(data.slice ? data.slice(0) : data);
      }
      const range = A.tempoRange || [85, 190];
      const det = opts.bpm ? { bpm: opts.bpm, offset: opts.offset ?? 0, confidence: 1 } : await detectBpm(buffer, { min: range[0], max: range[1] });
      if (!det) throw new Error('could not detect a tempo');
      const startAt = music.playTrack(buffer, det);
      // the track's first beat is played at startAt + offset; continue the bar count from the next bar
      const nextBar = Math.ceil(beatPos / beatsPerBar + 1e-6) * beatsPerBar;
      api.lockTo(startAt + det.offset, det.bpm, nextBar);
      return { ...det, duration: buffer.duration };
    },

    update(dt) {
      if (audioRunning()) {
        beatPos = (ctx.currentTime - latency() - anchor) / beatDur();
      } else {
        beatPos += dt / beatDur();
        if (ctx) reanchor(); // suspended context: keep the anchor in step with frame time
      }
      emitBeats();
      music?.update(dt);
    },
  };
  return api;
}
