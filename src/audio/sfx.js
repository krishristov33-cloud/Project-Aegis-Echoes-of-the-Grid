// SFX: every sound is synthesized (no asset files) and plays on the shared `sfxBus` of the Tempo Sync graph, so
// mix-as-health (master chain) and the sidechain pump still colour it. Pitched sounds sit in A minor, the key of
// the music stems (src/audio/music.js).
//
//   const sfx = createSfx({ bus, clock, tuning });
//   sfx.play('uiConfirm');            // by name, any time (silent until Web Audio has started)
//   sfx.play('gunshot', { pos });     // world position -> distance attenuation + stereo pan
//   sfx.update(dt);                   // each frame: drone hum, state-change fallbacks
//
// Bus events consumed: noise, playerAction, impact, playerDamaged, playerDied, playerRespawned, enemyShot, enemyHit,
// enemyKilled, enemyTelegraph, blink, phaseSkip, waveShield, launchpad, levelState, bossTelegraph, bossAttack,
// bossPhase, bossDefeated, puzzleFail, puzzleSolved, puzzleNote, beat.
import { whenAudioReady } from './audio-graph.js';

const DEFAULTS = {
  volume: 0.8,
  maxVoices: 28,
  footstep: 0.32,
  gunshot: 0.5,
  hearRange: 9, // metres at which a positional sound is at half level
  droneHum: 0.07,
  heartbeatBelow: 0.3,
  heartbeat: 0.35,
};

// A natural minor, used for every pitched cue
const A_MINOR = [0, 2, 3, 5, 7, 8, 10];
const deg = (d, base = 220) => {
  const oct = Math.floor(d / 7);
  return base * Math.pow(2, (A_MINOR[((d % 7) + 7) % 7] + oct * 12) / 12);
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function createSfx({ bus, clock, tuning } = {}) {
  const cfg = { ...DEFAULTS, ...(tuning?.sfx || {}) };
  let ctx = null;
  let out = null;
  let noiseBuf = null;
  let voices = 0;
  let played = 0;
  const lastAt = new Map(); // name -> performance.now() of last play (throttle / dedupe)
  const offs = [];
  let hum = null;
  let humT = 0;
  let prevState = '';
  let hpFrac = 1;

  const game = () => globalThis.game;

  function attach(graph) {
    ctx = graph.ctx;
    out = ctx.createGain();
    out.gain.value = cfg.volume;
    // gentle glue so stacked hits never clip the master chain
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    out.connect(comp).connect(graph.sfxBus);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // ---------- voice helpers ----------
  /** Destination for one sound: gain (+ panner when positioned). Returns null when over the voice cap. */
  function dest(gain = 1, pan = 0) {
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p).connect(out);
    } else g.connect(out);
    return g;
  }

  function track(src, t, dur) {
    voices++;
    src.onended = () => { voices = Math.max(0, voices - 1); };
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** Oscillator with a pitch glide and a percussive envelope. */
  function tone(to, { type = 'sine', f0 = 440, f1 = null, at = 0, dur = 0.2, gain = 0.3, attack = 0.004, curve = 'exp' }) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 !== null) {
      if (curve === 'lin') o.frequency.linearRampToValueAtTime(Math.max(1, f1), t + dur);
      else o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(to);
    track(o, t, dur);
  }

  /** Filtered noise burst with a filter sweep. */
  function noise(to, { type = 'bandpass', f0 = 1000, f1 = null, q = 1, at = 0, dur = 0.2, gain = 0.3, attack = 0.004, hold = 0 }) {
    const t = ctx.currentTime + at;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.loopStart = Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== null) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    if (hold > 0) g.gain.setValueAtTime(Math.max(0.0002, gain), t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(to);
    track(s, t, dur);
  }

  /** Distance gain and stereo pan of a world position relative to the camera. */
  function spatial(pos) {
    const cam = game()?.camera;
    if (!pos || !cam) return { gain: 1, pan: 0 };
    const e = cam.matrixWorld.elements;
    const dx = pos.x - e[12], dy = (pos.y ?? 0) - e[13], dz = pos.z - e[14];
    const d = Math.hypot(dx, dy, dz) || 1;
    const pan = (dx * e[0] + dy * e[1] + dz * e[2]) / d; // dot with camera right
    return { gain: 1 / (1 + d / cfg.hearRange), pan: pan * 0.8 };
  }

  // ---------- the sounds ----------
  const S = {
    footstep(o) {
      const sprint = o.speed > 6;
      const v = cfg.footstep * clamp(0.45 + (o.speed ?? 3) / 9, 0.4, 1.25);
      const to = dest(v, o.side === 'L' ? -0.12 : 0.12);
      const j = 0.85 + Math.random() * 0.3; // surface-ish variation
      noise(to, { type: 'lowpass', f0: (sprint ? 1500 : 950) * j, f1: 240, dur: 0.085, gain: 0.8 });
      tone(to, { f0: (sprint ? 105 : 88) * j, f1: 48, dur: 0.07, gain: 0.5 });
      // wet rooftop: a little splash tick
      noise(to, { type: 'highpass', f0: 3800 * j, dur: 0.04, gain: 0.1, at: 0.008 });
    },
    jump() {
      const to = dest(0.95);
      noise(to, { f0: 500, f1: 1800, q: 0.8, dur: 0.16, gain: 0.35, attack: 0.02 });
      tone(to, { f0: 130, f1: 210, dur: 0.11, gain: 0.25 });
    },
    land(o) {
      const k = clamp(o.strength ?? 0.4, 0.15, 1);
      const to = dest(0.35 + 0.6 * k);
      tone(to, { f0: 120 + 30 * k, f1: 36, dur: 0.14 + 0.14 * k, gain: 0.8 });
      noise(to, { type: 'lowpass', f0: 2200, f1: 180, dur: 0.12 + 0.1 * k, gain: 0.6 });
    },
    vault() {
      const to = dest(1.0);
      noise(to, { type: 'lowpass', f0: 900, f1: 300, dur: 0.07, gain: 0.7 }); // hand slap
      noise(to, { f0: 700, f1: 2400, q: 0.7, dur: 0.3, gain: 0.3, attack: 0.08, at: 0.03 }); // cloth
    },
    dodge() {
      const to = dest(0.9);
      noise(to, { f0: 2600, f1: 500, q: 1.2, dur: 0.24, gain: 0.5, attack: 0.02 });
      tone(to, { type: 'triangle', f0: 320, f1: 110, dur: 0.18, gain: 0.12 });
    },
    swing(o) {
      const i = clamp(o.index ?? 0, 0, 2);
      const to = dest(0.95 + i * 0.15, [-0.15, 0.15, 0][i]);
      const lo = [900, 1100, 600][i], hi = [3200, 3800, 4400][i];
      noise(to, { f0: lo, f1: hi, q: 1.6, dur: 0.13 + i * 0.03, gain: 0.55, attack: 0.03 });
      if (i === 2) noise(to, { f0: 4400, f1: 700, q: 1.2, dur: 0.16, gain: 0.35, at: 0.12 });
    },
    hit(o) {
      const sp = spatial(o.pos);
      const big = o.onBeat ? 1.35 : 1;
      const to = dest(0.75 * big * (0.5 + 0.5 * sp.gain), sp.pan);
      tone(to, { f0: o.onBeat ? 190 : 150, f1: 46, dur: 0.16 * big, gain: 0.9 });
      noise(to, { type: 'lowpass', f0: 3400, f1: 400, dur: 0.09, gain: 0.7 });
      noise(to, { type: 'highpass', f0: 5200, dur: 0.035, gain: 0.25 });
      if (o.onBeat) {
        // on the beat: a pitched ring that climbs the scale with the streak
        const f = deg(4 + (o.streak ?? 0) % 8, 440);
        tone(to, { type: 'triangle', f0: f, dur: 0.32, gain: 0.3 });
        tone(to, { type: 'sine', f0: f * 2, dur: 0.22, gain: 0.14 });
      }
    },
    blastCharge() {
      const to = dest(0.5);
      tone(to, { type: 'sawtooth', f0: 55, f1: 110, dur: 0.16, gain: 0.25, attack: 0.08 });
      noise(to, { f0: 300, f1: 1400, q: 2, dur: 0.16, gain: 0.25, attack: 0.1 });
    },
    blast(o) {
      const to = dest(o.onBeat ? 0.8 : 0.65);
      tone(to, { f0: 165, f1: 30, dur: 0.55, gain: 1 });
      tone(to, { type: 'sawtooth', f0: 82, f1: 27.5, dur: 0.4, gain: 0.35 });
      noise(to, { type: 'lowpass', f0: 5000, f1: 120, dur: 0.5, gain: 0.7 });
      if (o.onBeat) tone(to, { type: 'triangle', f0: deg(0, 440), dur: 0.4, gain: 0.22 });
    },
    blink() {
      const to = dest(0.6);
      tone(to, { type: 'square', f0: 1760, f1: 110, dur: 0.14, gain: 0.16 });
      noise(to, { type: 'highpass', f0: 6000, f1: 1500, dur: 0.09, gain: 0.3 });
      // datamosh stutter: three chopped repeats
      for (let i = 0; i < 3; i++) tone(to, { type: 'square', f0: deg(7 - i * 2, 440), dur: 0.035, gain: 0.12, at: 0.1 + i * 0.045 });
    },
    phaseSkip() {
      const to = dest(1.0);
      noise(to, { f0: 400, f1: 5200, q: 2.5, dur: 0.3, gain: 0.5, attack: 0.05 });
      tone(to, { type: 'sawtooth', f0: 110, f1: 880, dur: 0.28, gain: 0.14, attack: 0.04 });
      tone(to, { f0: deg(4, 880), dur: 0.2, gain: 0.12, at: 0.26 });
    },
    waveShield() {
      const to = dest(0.75);
      tone(to, { f0: 40, f1: 95, dur: 0.6, gain: 0.8, attack: 0.05, curve: 'lin' });
      noise(to, { type: 'lowpass', f0: 200, f1: 1800, dur: 0.6, gain: 0.5, attack: 0.1 });
      [0, 2, 4].forEach((d, i) => tone(to, { type: 'triangle', f0: deg(d, 220), dur: 0.5, gain: 0.14, at: 0.12 + i * 0.07 }));
    },
    padPlace() {
      const to = dest(0.5);
      tone(to, { type: 'triangle', f0: deg(0, 440), dur: 0.1, gain: 0.3 });
      tone(to, { type: 'triangle', f0: deg(4, 440), dur: 0.16, gain: 0.3, at: 0.07 });
    },
    padLaunch(o) {
      const sp = spatial(o.pos);
      const to = dest(0.8 * (0.5 + 0.5 * sp.gain), sp.pan);
      tone(to, { f0: 70, f1: 620, dur: 0.3, gain: 0.7, attack: 0.01 });
      noise(to, { f0: 500, f1: 4200, q: 1.5, dur: 0.34, gain: 0.4, attack: 0.03 });
      tone(to, { type: 'triangle', f0: deg(7, 440), dur: 0.3, gain: 0.16, at: 0.1 });
    },
    gunshot(o) {
      const sp = spatial(o.pos);
      const to = dest(cfg.gunshot * (0.25 + 0.75 * sp.gain), sp.pan);
      noise(to, { type: 'highpass', f0: 1400, dur: 0.05, gain: 1 });
      noise(to, { type: 'lowpass', f0: 2600, f1: 260, dur: 0.2, gain: 0.7 });
      tone(to, { type: 'square', f0: 210, f1: 55, dur: 0.08, gain: 0.35 });
      // slap-back off the far buildings
      noise(to, { type: 'bandpass', f0: 900, q: 0.6, dur: 0.22, gain: 0.12 * (1 - sp.gain), at: 0.11 });
    },
    whiz(o) {
      const to = dest(0.5, o.pan ?? 0);
      noise(to, { f0: 4200, f1: 1400, q: 6, dur: 0.12, gain: 0.5, attack: 0.02 });
    },
    enemyDeath(o) {
      const sp = spatial(o.pos);
      const to = dest(0.7 * (0.4 + 0.6 * sp.gain), sp.pan);
      if (o.kind === 'drone') {
        tone(to, { type: 'sawtooth', f0: 520, f1: 60, dur: 0.5, gain: 0.3 });
        noise(to, { type: 'lowpass', f0: 6000, f1: 200, dur: 0.6, gain: 0.8, at: 0.08 });
        tone(to, { f0: 110, f1: 30, dur: 0.4, gain: 0.7, at: 0.08 });
      } else {
        tone(to, { f0: 130, f1: 40, dur: 0.3, gain: 0.7 });
        noise(to, { type: 'lowpass', f0: 1500, f1: 200, dur: 0.22, gain: 0.5 });
        // the signal dropping out: a falling third
        tone(to, { type: 'triangle', f0: deg(2, 220), f1: deg(0, 220), dur: 0.35, gain: 0.14, at: 0.05 });
      }
    },
    telegraph(o) {
      const sp = spatial(o.pos);
      const dive = /dive|drone/i.test(o.kind || '');
      const to = dest(0.5 * (0.5 + 0.5 * sp.gain), sp.pan);
      const dur = clamp(o.time ?? 0.5, 0.2, 1.2);
      if (dive) {
        tone(to, { type: 'sawtooth', f0: 300, f1: 1300, dur, gain: 0.2, attack: dur * 0.6 });
        noise(to, { f0: 800, f1: 5000, q: 3, dur, gain: 0.25, attack: dur * 0.7 });
      } else {
        tone(to, { type: 'square', f0: deg(4, 880), dur: 0.07, gain: 0.14 });
        tone(to, { type: 'square', f0: deg(4, 880), dur: 0.07, gain: 0.14, at: 0.11 });
      }
    },
    hurt(o) {
      const k = clamp((o.amount ?? 10) / 30, 0.3, 1);
      const to = dest(0.5 + 0.4 * k);
      tone(to, { f0: 210, f1: 60, dur: 0.2, gain: 0.7 });
      noise(to, { type: 'bandpass', f0: 1800, f1: 500, q: 1.2, dur: 0.16, gain: 0.6 });
      // dissonant tick: minor second against the tonic
      tone(to, { type: 'square', f0: deg(0, 440) * 1.0595, dur: 0.09, gain: 0.08 });
    },
    death() {
      const to = dest(0.7);
      tone(to, { type: 'sawtooth', f0: 220, f1: 27.5, dur: 1.3, gain: 0.4 });
      tone(to, { f0: 110, f1: 25, dur: 1.4, gain: 0.7 });
      noise(to, { type: 'lowpass', f0: 6000, f1: 90, dur: 1.3, gain: 0.5 });
    },
    respawn() {
      const to = dest(0.6);
      noise(to, { f0: 300, f1: 4200, q: 1.5, dur: 0.6, gain: 0.3, attack: 0.3 });
      [0, 4, 7].forEach((d, i) => tone(to, { type: 'triangle', f0: deg(d, 220), dur: 0.5, gain: 0.2, at: 0.25 + i * 0.09 }));
    },
    heartbeat() {
      const to = dest(cfg.heartbeat);
      tone(to, { f0: 70, f1: 38, dur: 0.12, gain: 0.9 });
      tone(to, { f0: 62, f1: 34, dur: 0.14, gain: 0.6, at: 0.16 });
    },
    bossTelegraph(o) {
      const to = dest(0.8);
      const dur = clamp(((o.beats ?? 2) * 60) / (clock?.getBpm?.() || 174), 0.3, 1.6);
      tone(to, { type: 'sawtooth', f0: 41, f1: 98, dur, gain: 0.45, attack: dur * 0.7, curve: 'lin' });
      noise(to, { type: 'lowpass', f0: 150, f1: 1500, dur, gain: 0.5, attack: dur * 0.8 });
    },
    bossAttack(o) {
      const sp = spatial(o.pos);
      const to = dest(1.0 * (0.6 + 0.4 * sp.gain), sp.pan * 0.5);
      tone(to, { f0: 130, f1: 24, dur: 0.7, gain: 1 });
      noise(to, { type: 'lowpass', f0: 4200, f1: 80, dur: 0.6, gain: 0.9 });
      tone(to, { type: 'square', f0: 55 * 1.0595, f1: 40, dur: 0.3, gain: 0.2 });
    },
    bossPhase() {
      const to = dest(0.8);
      // tritone cluster: the Hulk is out of tune with the grid
      [220, 311.13, 233.08, 440 * 1.414].forEach((f, i) => tone(to, { type: 'sawtooth', f0: f, f1: f * 0.5, dur: 1.1, gain: 0.16, at: i * 0.03, attack: 0.02 }));
      noise(to, { type: 'lowpass', f0: 8000, f1: 200, dur: 1.0, gain: 0.5 });
    },
    bossDefeated() {
      const to = dest(0.7);
      tone(to, { f0: 90, f1: 22, dur: 1.6, gain: 0.9 });
      noise(to, { type: 'lowpass', f0: 9000, f1: 60, dur: 1.8, gain: 0.6 });
      // resolve to A major: the grid back in tune
      [220, 277.18, 329.63, 440, 554.37].forEach((f, i) => tone(to, { type: 'triangle', f0: f, dur: 2.4, gain: 0.16, at: 0.5 + i * 0.12, attack: 0.05 }));
    },
    portal() {
      const to = dest(0.6);
      noise(to, { f0: 250, f1: 3800, q: 2, dur: 0.8, gain: 0.35, attack: 0.5 });
      tone(to, { f0: deg(0, 110), f1: deg(0, 440), dur: 0.8, gain: 0.25, attack: 0.4 });
      tone(to, { type: 'triangle', f0: deg(4, 440), dur: 0.5, gain: 0.14, at: 0.75 });
    },
    clear() {
      const to = dest(0.6);
      [0, 2, 4, 7].forEach((d, i) => tone(to, { type: 'triangle', f0: deg(d, 440), dur: 0.35, gain: 0.22, at: i * 0.085 }));
    },
    puzzleFail() {
      const to = dest(0.6);
      tone(to, { type: 'sawtooth', f0: 116.5, f1: 98, dur: 0.4, gain: 0.3 });
      tone(to, { type: 'sawtooth', f0: 110, f1: 92, dur: 0.4, gain: 0.3 });
    },
    puzzleSolved() {
      const to = dest(0.7);
      [0, 2, 4, 7, 9, 11, 14].forEach((d, i) => tone(to, { type: 'triangle', f0: deg(d, 220), dur: 0.6, gain: 0.2, at: i * 0.09 }));
      noise(to, { type: 'highpass', f0: 5000, dur: 1.2, gain: 0.08, attack: 0.6 });
    },
    puzzleTick(o) {
      // the puzzle plays its own pad tones; this is only the tactile click under a player step
      const to = dest(o.ok === false ? 0.4 : 0.25);
      noise(to, { type: 'highpass', f0: 3000, dur: 0.03, gain: 0.5 });
    },
    uiHover() {
      tone(dest(0.25), { type: 'triangle', f0: deg(4, 880), dur: 0.05, gain: 0.3 });
    },
    uiConfirm() {
      const to = dest(0.4);
      tone(to, { type: 'triangle', f0: deg(0, 440), dur: 0.08, gain: 0.35 });
      tone(to, { type: 'triangle', f0: deg(4, 440), dur: 0.14, gain: 0.35, at: 0.06 });
    },
    uiBack() {
      const to = dest(0.35);
      tone(to, { type: 'triangle', f0: deg(4, 440), dur: 0.07, gain: 0.3 });
      tone(to, { type: 'triangle', f0: deg(0, 440), dur: 0.12, gain: 0.3, at: 0.05 });
    },
    tip() {
      tone(dest(0.3), { type: 'sine', f0: deg(7, 440), dur: 0.18, gain: 0.3 });
    },
  };

  // minimum gap (ms) between two plays of the same sound; also merges duplicate triggers from different events
  const GAP = { footstep: 90, land: 160, jump: 200, vault: 300, dodge: 250, swing: 110, hit: 35, gunshot: 45, hurt: 90, blast: 250, blastCharge: 250, uiHover: 50, heartbeat: 200, telegraph: 120, whiz: 80, death: 1500, respawn: 800, portal: 600 };

  function play(name, opts = {}) {
    if (!ctx || ctx.state !== 'running' || !S[name]) return false;
    const now = performance.now();
    if (now - (lastAt.get(name) ?? -1e9) < (GAP[name] ?? 0)) return false;
    if (voices >= cfg.maxVoices && (name === 'footstep' || name === 'whiz' || name === 'uiHover')) return false;
    if (voices >= cfg.maxVoices * 1.6) return false;
    lastAt.set(name, now);
    try { S[name](opts); played++; } catch (err) { console.warn('[sfx]', name, err); }
    return true;
  }

  // ---------- bus wiring ----------
  let streak = 0;
  const on = (name, fn) => bus && offs.push(bus.on(name, fn));
  const playerSpeed = () => {
    const v = game()?.player?.velocity;
    return v ? Math.hypot(v.x, v.z) : 3;
  };

  offs.push(whenAudioReady(bus, attach, () => clock ?? game()?.clock));

  on('noise', (e = {}) => {
    switch (e.kind) {
      case 'footstep': play('footstep', { side: e.side, speed: playerSpeed() }); break;
      case 'land': play('land', { strength: 0.45 }); break;
      case 'blast': play('blast', { onBeat: clock?.isOnBeat?.() }); break;
      case 'launch': play('padLaunch', { pos: e.pos }); break;
      case 'crash': play('enemyDeath', { pos: e.pos, kind: 'drone' }); break;
      case 'stomp': case 'impact': case 'gravityWell': play('bossAttack', { pos: e.pos }); break;
      default: break;
    }
  });
  on('playerAction', (e = {}) => {
    const map = { jump: 'jump', land: 'land', vault: 'vault', dodge: 'dodge', swing: 'swing', blastCharge: 'blastCharge', death: 'death', respawn: 'respawn' };
    if (map[e.name]) play(map[e.name], e);
  });
  on('impact', (e = {}) => {
    if (e.kind === 'land') {
      // a hard landing arrives after the generic one: let it through with its real strength
      if ((e.strength ?? 0) > 0.5) lastAt.delete('land');
      play('land', { strength: e.strength });
    }
  });
  on('enemyHit', (e = {}) => {
    const onBeat = !!e.src?.onBeat;
    streak = onBeat ? streak + 1 : 0;
    play('hit', { pos: e.pos, onBeat, streak });
  });
  on('enemyKilled', (e = {}) => { if (e.kind !== 'hulk') play('enemyDeath', e); });
  on('enemyShot', (e = {}) => {
    play('gunshot', { pos: e.from });
    if (!e.hit && !e.targetGhost && e.to) play('whiz', { pan: spatial(e.to).pan });
  });
  on('enemyTelegraph', (e = {}) => play('telegraph', e));
  on('playerDamaged', (e = {}) => {
    hpFrac = e.hpMax ? e.hp / e.hpMax : hpFrac;
    streak = 0;
    if (e.hp <= 0) play('death'); else play('hurt', e);
  });
  on('playerHealed', (e = {}) => { hpFrac = e.hpMax ? e.hp / e.hpMax : hpFrac; });
  on('playerDied', () => play('death'));
  on('playerRespawned', () => play('respawn'));
  on('blink', () => play('blink'));
  on('phaseSkip', () => play('phaseSkip'));
  on('waveShield', () => play('waveShield'));
  on('launchpad', (e = {}) => { if (e.burst) play('padLaunch', { pos: e.origin }); else play('padPlace'); });
  on('levelState', (e = {}) => {
    if (e.phase === 'enter') play('portal');
    else if (e.phase === 'clear') play('clear');
  });
  on('bossTelegraph', (e = {}) => play('bossTelegraph', e));
  on('bossAttack', (e = {}) => play('bossAttack', e));
  on('bossPhase', () => play('bossPhase'));
  on('bossDefeated', () => play('bossDefeated'));
  on('puzzleFail', () => play('puzzleFail'));
  on('puzzleSolved', () => play('puzzleSolved'));
  on('puzzleNote', (e = {}) => { if (e.by === 'player') play('puzzleTick', e); });
  on('beat', (e = {}) => {
    const p = game()?.player;
    if (p && p.hp > 0 && hpFrac < cfg.heartbeatBelow && (e.index ?? 0) % 2 === 0) play('heartbeat');
  });

  // ---------- continuous: drone hum ----------
  function updateHum(dt) {
    humT -= dt;
    if (humT > 0) return;
    humT = 0.1;
    let best = null;
    let bestD = Infinity;
    const g = game();
    const cam = g?.camera?.position;
    for (const e of g?.enemies ?? []) {
      if (e.kind !== 'drone' || e.dead || e.position.y < -40) continue;
      const d = cam ? e.position.distanceTo(cam) : 10;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best && !hum) {
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      o1.type = 'sawtooth'; o2.type = 'sawtooth';
      o1.frequency.value = 110; o2.frequency.value = 110 * 1.5 + 2;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 700;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 23;
      const lg = ctx.createGain();
      lg.gain.value = 0.35;
      const trem = ctx.createGain();
      trem.gain.value = 0.65;
      lfo.connect(lg).connect(trem.gain);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      o1.connect(lp); o2.connect(lp);
      lp.connect(trem).connect(gain);
      if (pan) gain.connect(pan).connect(out); else gain.connect(out);
      o1.start(); o2.start(); lfo.start();
      hum = { o1, o2, lfo, gain, pan };
    }
    if (!hum) return;
    const t = ctx.currentTime;
    if (best) {
      const sp = spatial(best.position);
      const speed = best.velocity ? best.velocity.length() : 0;
      hum.gain.gain.setTargetAtTime(cfg.droneHum * sp.gain * 2, t, 0.12);
      hum.o1.frequency.setTargetAtTime(110 + speed * 9, t, 0.15);
      hum.o2.frequency.setTargetAtTime((110 + speed * 9) * 1.5 + 2, t, 0.15);
      hum.pan?.pan.setTargetAtTime(clamp(sp.pan, -1, 1), t, 0.1);
      hum.idle = 0;
    } else {
      hum.gain.gain.setTargetAtTime(0, t, 0.15);
      hum.idle = (hum.idle ?? 0) + 0.1;
      if (hum.idle > 2) {
        hum.o1.stop(); hum.o2.stop(); hum.lfo.stop();
        hum.gain.disconnect();
        hum = null;
      }
    }
  }

  return {
    play,
    update(dt) {
      if (!ctx) return;
      // fallbacks for actions that have no dedicated event yet; the per-name gap merges them with real events
      const st = game()?.player?.state || '';
      if (st !== prevState) {
        if (st === 'jump') play('jump');
        else if (st === 'vault') play('vault');
        else if (st === 'dodge' || st === 'roll') play('dodge');
        else if (st === 'blast') play('blastCharge');
        else if (/^melee[123]$/.test(st)) play('swing', { index: Number(st.slice(5)) - 1 });
        prevState = st;
      }
      updateHum(dt);
    },
    setVolume(v) { cfg.volume = v; if (out) out.gain.value = v; },
    get ready() { return !!ctx; },
    /** Debug / tests: live voice count, sounds played, names. */
    get stats() { return { voices, played, hum: !!hum, names: Object.keys(S) }; },
    dispose() {
      offs.forEach((o) => o?.());
      if (hum) { hum.o1.stop(); hum.o2.stop(); hum.lfo.stop(); hum = null; }
      out?.disconnect();
    },
  };
}
