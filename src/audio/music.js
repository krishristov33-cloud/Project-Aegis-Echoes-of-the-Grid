// Music engine (C5). Two modes, both locked to the Tempo Sync clock:
//  - stems: four procedural drum & bass layers (drums, bass, pad, arp) scheduled sample-accurately on the beat grid.
//    By default the mix is fixed (cfg.level) so the music never swells with the fight; cfg.dynamic = true brings
//    back the old behaviour where combat intensity adds layers (calm = pad + light drums, full fight = everything).
//  - track: a loaded track (Kris's own music) looped on whole bars; intensity opens a low-pass filter instead.
// Intensity: bus `resonance {value}` if anyone emits it, otherwise estimated from combat noise / damage events.
//
// Created by audio-clock.js once Web Audio starts; reach it as `game.clock.music`.
//   music.setIntensity(0..1)   force a level (debug / scripted moments)
//   music.stop() / start()
//   music.stems                { drums, bass, pad, arp } GainNodes (C6 / FX can tap them)

// --- musical content (A minor, DnB two-step) ---
const PROG = [
  { root: 55.0, chord: [220.0, 261.63, 329.63] }, // Am
  { root: 43.65, chord: [174.61, 220.0, 261.63] }, // F
  { root: 65.41, chord: [261.63, 329.63, 392.0] }, // C
  { root: 49.0, chord: [196.0, 246.94, 293.66] }, // G
];
const KICK = [0, 10];
const SNARE = [4, 12];
const GHOST = [7, 15];
const BASS = [0, 3, 6, 10, 11, 14];
const BASS_OCT = { 3: 2, 11: 2 };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createMusic({ ctx, output, clock, bus, cfg = {} }) {
  const lookahead = cfg.lookahead ?? 0.12;
  const dynamic = cfg.dynamic === true;
  const fixedLevel = Math.max(0, Math.min(1, cfg.level ?? 0.5));
  const stemBus = ctx.createGain();
  stemBus.connect(output);

  // track mode: source -> lowpass -> trackGain -> output
  const trackFilter = ctx.createBiquadFilter();
  trackFilter.type = 'lowpass';
  trackFilter.frequency.value = 18000;
  const trackGain = ctx.createGain();
  trackGain.gain.value = 0;
  trackFilter.connect(trackGain).connect(output);

  const mk = (g) => {
    const n = ctx.createGain();
    n.gain.value = g;
    n.connect(stemBus);
    return n;
  };
  const stems = { drums: mk(0), bass: mk(0), pad: mk(0), arp: mk(0) };

  // arp echo
  const delay = ctx.createDelay(1);
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(stems.arp);

  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  {
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  let mode = 'stems';
  let running = false;
  let nextStep = null; // next 16th step (absolute) to schedule
  let intensity = 0;
  let forced = null;
  let explicit = 0; // last `resonance` value (decays)
  let auto = 0; // estimated from events
  let track = null;

  const offs = [
    bus.on('resonance', (d) => {
      explicit = Math.max(0, Math.min(1, d?.value ?? 0));
    }),
    bus.on('noise', (d) => {
      const k = d?.kind || '';
      if (k === 'enemyShot') auto = Math.min(1, auto + 0.02);
      else if (k === 'shot' || k === 'blast' || k.startsWith('melee')) auto = Math.min(1, auto + 0.08);
    }),
    bus.on('playerDamaged', () => (auto = Math.min(1, auto + 0.12))),
    bus.on('enemyKilled', () => (auto = Math.min(1, auto + 0.1))),
  ];

  // ---------- voices ----------
  function env(g, t, a, peak, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
  }

  function kick(t, out) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    env(g, t, 0.002, 0.9, 0.3);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.35);
  }

  function noiseHit(t, out, { hp = 1000, bp = null, peak = 0.5, decay = 0.15 }) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = bp ? 'bandpass' : 'highpass';
    f.frequency.value = bp ?? hp;
    const g = ctx.createGain();
    env(g, t, 0.001, peak, decay);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + decay + 0.05);
  }

  function snare(t, out, vel = 1) {
    noiseHit(t, out, { bp: 1800, peak: 0.55 * vel, decay: 0.16 });
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 190;
    env(g, t, 0.001, 0.3 * vel, 0.08);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.12);
  }

  function bassNote(t, freq, len, out) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(380 + intensity * 500, t);
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
    g.gain.setValueAtTime(0.09, t + len * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + len + 0.02);
    }
    const sub = ctx.createOscillator();
    sub.frequency.value = freq;
    const sg = ctx.createGain();
    sg.gain.value = 0.8;
    sub.connect(sg).connect(g);
    sub.start(t);
    sub.stop(t + len + 0.02);
    f.connect(g).connect(out);
  }

  function padChord(t, chord, len, out) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900 + intensity * 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + len * 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    for (const fr of chord) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = fr;
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + len + 0.05);
      }
    }
    f.connect(g).connect(out);
  }

  function arpNote(t, freq, out) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2400;
    const g = ctx.createGain();
    env(g, t, 0.003, 0.1, 0.09);
    o.connect(f).connect(g);
    g.connect(out);
    g.connect(delay);
    o.start(t);
    o.stop(t + 0.15);
  }

  function scheduleStep(step, t) {
    const s16 = step % 16;
    const barIdx = Math.floor(step / 16);
    const ch = PROG[barIdx % PROG.length];
    const sixteenth = (60 / clock.getBpm()) / 4;
    // drums
    if (KICK.includes(s16)) kick(t, stems.drums);
    if (SNARE.includes(s16)) snare(t, stems.drums);
    if (GHOST.includes(s16) && intensity > 0.45) snare(t, stems.drums, 0.25);
    if (s16 % 2 === 0 || intensity > 0.7) noiseHit(t, stems.drums, { hp: 7000, peak: s16 % 4 === 2 ? 0.22 : 0.12, decay: 0.04 });
    // bass
    if (BASS.includes(s16)) bassNote(t, ch.root * (BASS_OCT[s16] ?? 1), sixteenth * (s16 === 0 ? 2.5 : 1.6), stems.bass);
    // pad: one chord per bar
    if (s16 === 0) padChord(t, ch.chord, sixteenth * 16, stems.pad);
    // arp: 16ths over chord tones, two octaves up
    const notes = ch.chord;
    arpNote(t, notes[s16 % notes.length] * (s16 % 6 < 3 ? 2 : 4), stems.arp);
  }

  function setStemLevels(t) {
    const r = intensity;
    const tc = 0.6;
    stems.pad.gain.setTargetAtTime(0.9 - 0.3 * r, t, tc);
    stems.drums.gain.setTargetAtTime(0.35 + 0.65 * smooth(0.1, 0.35, r), t, tc);
    stems.bass.gain.setTargetAtTime(smooth(0.3, 0.55, r), t, tc);
    stems.arp.gain.setTargetAtTime(smooth(0.6, 0.85, r), t, tc);
    trackFilter.frequency.setTargetAtTime(700 + 17000 * smooth(0, 0.6, r) ** 2, t, tc);
  }

  const api = {
    stems,
    get mode() {
      return mode;
    },
    get intensity() {
      return intensity;
    },
    get running() {
      return running;
    },
    get track() {
      return track;
    },

    start() {
      running = true;
      nextStep = null;
      stemBus.gain.setTargetAtTime(mode === 'stems' ? 1 : 0, ctx.currentTime, 0.05);
      if (track) trackGain.gain.setTargetAtTime(mode === 'track' ? 1 : 0, ctx.currentTime, 0.05);
    },

    stop() {
      running = false;
      stemBus.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      trackGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    },

    setIntensity(v) {
      forced = v === null || v === undefined ? null : Math.max(0, Math.min(1, v));
    },

    /** Play a decoded track looped on whole bars. Returns the context time it starts at. */
    playTrack(buffer, { bpm, offset }) {
      track?.source.stop();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const bar = (60 / bpm) * (clock.getBeatsPerBar?.() ?? 4);
      const bars = Math.floor((buffer.duration - offset) / bar);
      if (bars >= 1) {
        src.loop = true;
        src.loopStart = offset;
        src.loopEnd = offset + bars * bar;
      }
      src.connect(trackFilter);
      const startAt = ctx.currentTime + 0.1;
      src.start(startAt);
      track = { source: src, buffer, bpm, offset, startAt };
      mode = 'track';
      running = true;
      stemBus.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      trackGain.gain.setTargetAtTime(1, startAt, 0.02);
      return startAt;
    },

    /** Back to the procedural stems. */
    useStems() {
      track?.source.stop();
      track = null;
      mode = 'stems';
      nextStep = null;
      trackGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      if (running) stemBus.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
    },

    update(dt) {
      auto = Math.max(0, auto - dt * 0.06);
      explicit = Math.max(0, explicit - dt * 0.03);
      const target = forced ?? Math.max(auto, explicit);
      if (dynamic || forced !== null) intensity += (target - intensity) * Math.min(1, dt * 1.5);
      else intensity = fixedLevel; // constant mix: fighting does not make the music louder
      const now = ctx.currentTime;
      setStemLevels(now);
      if (!running || mode !== 'stems' || ctx.state !== 'running') return;

      delay.delayTime.value = (60 / clock.getBpm()) * 0.75; // dotted eighth
      // schedule every 16th whose play time falls inside the lookahead window
      const stepPos = (now - clock.beatTime(0)) / (60 / clock.getBpm()) * 4;
      if (nextStep === null || nextStep < stepPos - 2) nextStep = Math.ceil(stepPos);
      for (;;) {
        const t = clock.beatTime(nextStep / 4);
        if (t > now + lookahead) break;
        if (t >= now - 0.01) scheduleStep(nextStep, Math.max(t, now));
        nextStep++;
      }
    },

    dispose() {
      offs.forEach((o) => o?.());
      api.stop();
      track?.source.stop();
    },
  };
  return api;
}
