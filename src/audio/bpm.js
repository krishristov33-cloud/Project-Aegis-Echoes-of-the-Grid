// Tempo Sync analysis (C5): BPM + first-beat offset of a loaded track, so Kris's own music can drive the beat clock.
//
//   const { bpm, offset, confidence } = await detectBpm(audioBuffer);          // AudioBuffer (decoded)
//   const r = detectBpmFromSamples(float32Mono, sampleRate, { min: 85, max: 190 });  // pure function, testable
//
// Method: onset envelope (full-band transients + kick band, hop ~5.8 ms) -> autocorrelation table -> every candidate
// tempo in [min, max] scored by its 1/2/4-beat and half-beat lags -> fine refinement -> octave choice (prefer the
// faster tempo when nearly as strong) -> snap to integer BPM when close -> phase by comb-scoring at the beat period.

const DEFAULTS = { min: 85, max: 190, maxSeconds: 60, hop: 256, frame: 1024, snap: 0.12 };

/** Mono mixdown of an AudioBuffer. */
export function toMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * Onset envelope, one value per hop: half-wave rectified log-energy rises of the full band (transients)
 * plus a weighted kick band (one-pole low-pass, ~150 Hz) which carries the beat accents. Returns { env, rate }.
 */
export function onsetEnvelope(samples, sampleRate, { hop, frame, lowWeight = 2, lowCut = 150 }) {
  const frames = Math.max(0, Math.floor((samples.length - frame) / hop));
  const env = new Float32Array(frames);
  const a = 1 - Math.exp((-2 * Math.PI * lowCut) / sampleRate);
  // low-passed copy for the kick band
  const low = new Float32Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) low[i] = y += a * (samples[i] - y);
  let prevF = 0;
  let prevL = 0;
  for (let f = 0; f < frames; f++) {
    let eF = 0;
    let eL = 0;
    const o = f * hop;
    for (let i = 1; i < frame; i++) {
      const d = samples[o + i] - samples[o + i - 1]; // first difference = cheap high-pass for transients
      eF += d * d;
      eL += low[o + i] * low[o + i];
    }
    const lF = Math.log1p(eF * 1000);
    const lL = Math.log1p(eL * 100);
    env[f] = Math.max(0, lF - prevF) + lowWeight * Math.max(0, lL - prevL);
    prevF = lF;
    prevL = lL;
  }
  // remove slow trend (moving average) so the ACF sees pulses, not loudness changes
  const w = Math.round(sampleRate / hop / 2);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    out[i] = Math.max(0, env[i] - acc / Math.min(i + 1, w));
  }
  return { env: out, rate: sampleRate / hop };
}

function acf(env, lag) {
  let s = 0;
  for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
  return s / (env.length - lag);
}

/**
 * @param {Float32Array} samples  mono
 * @param {number} sampleRate
 * @param {object} [opts]  { min, max, maxSeconds, hop, frame, snap }
 * @returns {{bpm:number, offset:number, confidence:number}|null}
 */
export function detectBpmFromSamples(samples, sampleRate, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // analyse the middle of long tracks (intros are often beatless)
  const maxN = Math.floor(o.maxSeconds * sampleRate);
  let start = 0;
  if (samples.length > maxN) start = Math.floor((samples.length - maxN) / 2);
  const slice = samples.subarray(start, start + maxN);
  const { env, rate } = onsetEnvelope(slice, sampleRate, o);
  if (env.length < rate * 4) return null; // need a few seconds

  // ACF table up to 4 bars of the slowest tempo, linear interpolation for fractional lags
  const maxLag = Math.min(Math.floor(env.length / 2), Math.ceil((4 * 60 * rate) / o.min) + 2);
  const table = new Float32Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag; lag++) table[lag] = acf(env, lag);
  const A = (lagF) => {
    if (lagF >= maxLag) return 0;
    const l0 = Math.floor(lagF);
    const t = lagF - l0;
    return table[l0] * (1 - t) + table[l0 + 1] * t;
  };
  // score every candidate tempo IN the range by its beat multiples (1, 2, 4 beats) and half-beat
  const score = (bpm) => {
    const L = (60 * rate) / bpm;
    return A(L) + A(2 * L) + 0.5 * A(4 * L) + 0.25 * A(L / 2);
  };
  let best = -1;
  let bpm = 0;
  let sum = 0;
  let count = 0;
  for (let t = o.min; t <= o.max; t += 0.25) {
    const sc = score(t);
    sum += sc;
    count++;
    if (sc > best) [best, bpm] = [sc, t];
  }
  if (best <= 0) return null;
  // refine around the peak
  for (let t = bpm - 0.25; t <= bpm + 0.25; t += 0.02) {
    const sc = score(t);
    if (sc > best) [best, bpm] = [sc, t];
  }
  // octave choice inside the range: prefer the faster tempo when its pulse is nearly as strong (DnB vs half-time)
  if (bpm * 2 <= o.max && score(bpm * 2) > 0.8 * best) bpm *= 2;

  // joint tempo + phase fit: comb-score the whole envelope; a long baseline pins the tempo to ~0.02 BPM
  const comb = (period, ph) => {
    let s = 0;
    for (let t = ph; t < env.length - 1; t += period) {
      const i = Math.round(t);
      s += env[i] + 0.5 * ((env[i - 1] ?? 0) + env[i + 1]);
    }
    return s;
  };
  const fit = (lo, hi, step) => {
    let bestS = -1;
    let bestT = bpm;
    let bestPh = 0;
    for (let t = lo; t <= hi + 1e-9; t += step) {
      const period = (60 * rate) / t;
      const steps = Math.max(16, Math.round(period * 2));
      for (let k = 0; k < steps; k++) {
        const ph = (k / steps) * period;
        const sc = comb(period, ph);
        if (sc > bestS) [bestS, bestT, bestPh] = [sc, t, ph];
      }
    }
    return { bpm: bestT, phase: bestPh };
  };
  let f = fit(bpm - 0.5, bpm + 0.5, 0.05);
  f = fit(f.bpm - 0.05, f.bpm + 0.05, 0.005);
  bpm = f.bpm;
  if (Math.abs(bpm - Math.round(bpm)) < o.snap) {
    bpm = Math.round(bpm);
    f = fit(bpm, bpm, 1); // re-fit the phase for the snapped tempo
  }
  const bestPhase = f.phase;

  // offset of the first beat from the start of the *track*; the envelope lags the attack by about half a frame
  const beatSec = 60 / bpm;
  let offset = (start / sampleRate + bestPhase / rate + (o.frame / 2) / sampleRate) % beatSec;
  if (offset < 0) offset += beatSec;

  return { bpm, offset, confidence: count ? best / (sum / count) : 0 };
}

/** Detect from an AudioBuffer (already decoded). */
export async function detectBpm(buffer, opts) {
  if (!buffer?.getChannelData) return null;
  return detectBpmFromSamples(toMono(buffer), buffer.sampleRate, opts);
}
