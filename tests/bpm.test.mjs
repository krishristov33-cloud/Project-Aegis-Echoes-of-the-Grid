// BPM detector check (C5). Run: node tests/bpm.test.mjs  — synthesises drum loops at known tempos/offsets and
// prints what src/audio/bpm.js detects. Exits non-zero if any tempo is off by more than 0.05 BPM (octaves allowed).
import { detectBpmFromSamples } from '../src/audio/bpm.js';
const SR = 44100;
function synth({ bpm, seconds = 40, offset = 0.2, style }) {
  const n = SR * seconds, out = new Float32Array(n), sixteenth = 60 / bpm / 4;
  const hit = (t, fn, len) => { const s = Math.floor(t * SR); for (let i = 0; i < len * SR && s + i < n; i++) out[s + i] += fn(i / SR); };
  const kick = (t) => Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12) * 0.9;
  const snare = (t) => ((Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 18);
  const hat = (t) => (Math.random() * 2 - 1) * 0.2 * Math.exp(-t * 60);
  const pats = {
    dnb: { k: [0, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },          // 2-step, steps in a 16-step bar... (bar = 4 beats here => 16 sixteenths)
    house: { k: [0, 4, 8, 12], s: [4, 12], h: [2, 6, 10, 14] },
    halftime: { k: [0], s: [8], h: [0, 2, 4, 6, 8, 10, 12, 14] },
    hiphop: { k: [0, 7, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },
  };
  const p = pats[style];
  for (let t = offset, step = 0; t < seconds; t += sixteenth, step++) {
    const st = step % 16;
    if (p.k.includes(st)) hit(t, kick, 0.4);
    if (p.s.includes(st)) hit(t, snare, 0.25);
    if (p.h.includes(st)) hit(t, hat, 0.06);
  }
  // sustained bass + noise floor
  for (let i = 0; i < n; i++) out[i] += Math.sin(2 * Math.PI * 55 * i / SR) * 0.15 + (Math.random() - 0.5) * 0.02;
  return out;
}
const cases = [
  { bpm: 174, style: 'dnb', offset: 0.13 }, { bpm: 172, style: 'dnb', offset: 0.31 }, { bpm: 128, style: 'house', offset: 0.05 },
  { bpm: 140, style: 'halftime', offset: 0.2 }, { bpm: 90, style: 'hiphop', offset: 0.4 }, { bpm: 165.5, style: 'dnb', offset: 0.0 }, { bpm: 120, style: 'house', offset: 0.25 },
];
for (const c of cases) {
  const t0 = performance.now();
  const r = detectBpmFromSamples(synth(c), SR, { min: 85, max: 190 });
  const beat = 60 / c.bpm;
  let offErr = Math.abs(((r.offset - c.offset) % beat + beat * 1.5) % beat - beat / 2);
  console.log(`${c.style.padEnd(8)} true ${c.bpm} @${c.offset}s -> ${r.bpm.toFixed(2)} @${r.offset.toFixed(3)}s  offErr ${(offErr * 1000).toFixed(0)}ms conf ${r.confidence.toFixed(1)}  ${(performance.now() - t0).toFixed(0)}ms`);
}
// pass/fail (octave errors allowed: 90 may read as 180)
let failed = 0;
for (const c of cases) {
  const r = detectBpmFromSamples(synth(c), SR, { min: 85, max: 190 });
  const ratio = r.bpm / c.bpm;
  const ok = [0.5, 1, 2].some((m) => Math.abs(ratio - m) < 0.05 / c.bpm);
  if (!ok) { failed++; console.error(`FAIL ${c.style} ${c.bpm}: got ${r.bpm}`); }
}
console.log(failed ? `${failed} failed` : 'all tempos OK');
process.exit(failed ? 1 : 0);
