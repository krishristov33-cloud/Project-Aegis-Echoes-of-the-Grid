// C5 test page logic. Uses the real bus + clock; renders synthetic test tracks with OfflineAudioContext.
import { bus } from '../src/core/events.js';
import { createAudioClock } from '../src/core/audio-clock.js';

const tuning = await fetch('../src/data/tuning.json').then((r) => r.json());
const clock = createAudioClock(bus, tuning);
const $ = (id) => document.getElementById(id);
const log = (t) => {
  $('log').textContent = `${new Date().toLocaleTimeString()}  ${t}\n` + $('log').textContent;
};

// beat log for automated checks: ctx time of each beat vs the grid
const beats = [];
bus.on('beat', (b) => beats.push({ ...b, t: clock.audio?.ctx.currentTime ?? null, pos: clock.getBeatPos() }));

$('start').onclick = async () => {
  await clock.startAudio();
  log(`audio started: ${clock.audio?.ctx.sampleRate} Hz, latency ${((clock.audio?.ctx.outputLatency || clock.audio?.ctx.baseLatency || 0) * 1000).toFixed(1)} ms`);
};
$('setBpm').onclick = () => clock.setBpm(+$('bpmIn').value);
$('int').oninput = (e) => clock.music?.setIntensity(+e.target.value);
$('auto').onclick = () => clock.music?.setIntensity(null);
$('stemsBtn').onclick = () => clock.music?.useStems();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  log(`loading ${f.name}…`);
  const r = await clock.loadTrack(f);
  log(`${f.name}: ${r.bpm} BPM, first beat ${r.offset.toFixed(3)} s, ${r.duration.toFixed(1)} s, confidence ${r.confidence.toFixed(1)}`);
};

/** Render a drum loop at a known tempo (same generator as tests/bpm.test.mjs). */
async function renderTestTrack(bpm, seconds = 24, offset = 0.21) {
  const sr = 44100;
  const off = new OfflineAudioContext(1, sr * seconds, sr);
  const sixteenth = 60 / bpm / 4;
  const noise = off.createBuffer(1, sr, sr);
  noise.getChannelData(0).forEach((_, i, d) => (d[i] = Math.random() * 2 - 1));
  for (let t = offset, step = 0; t < seconds - 0.5; t += sixteenth, step++) {
    const s = step % 16;
    if (s === 0 || s === 10) {
      const o = off.createOscillator();
      const g = off.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(off.destination);
      o.start(t);
      o.stop(t + 0.32);
    }
    if (s === 4 || s === 12 || s % 2 === 0) {
      const n = off.createBufferSource();
      n.buffer = noise;
      const f = off.createBiquadFilter();
      f.type = s % 4 === 0 && (s === 4 || s === 12) ? 'bandpass' : 'highpass';
      f.frequency.value = s === 4 || s === 12 ? 1800 : 7000;
      const g = off.createGain();
      const peak = s === 4 || s === 12 ? 0.6 : 0.15;
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (peak > 0.3 ? 0.18 : 0.05));
      n.connect(f).connect(g).connect(off.destination);
      n.start(t);
      n.stop(t + 0.2);
    }
  }
  return off.startRendering();
}

$('gen').onclick = async () => {
  const bpm = +$('genBpm').value;
  log(`rendering a ${bpm} BPM loop…`);
  const buf = await renderTestTrack(bpm);
  const r = await clock.loadTrack(buf);
  log(`test track ${bpm} BPM -> detected ${r.bpm} BPM, first beat ${r.offset.toFixed(3)} s (true 0.210)`);
  window.__lastDetect = { true: bpm, ...r };
};

// stem meters
const meters = {};
let analysers = null;
function setupMeters() {
  if (analysers || !clock.music) return;
  analysers = {};
  for (const [name, node] of Object.entries(clock.music.stems)) {
    const an = clock.audio.ctx.createAnalyser();
    an.fftSize = 512;
    node.connect(an);
    analysers[name] = an;
    const row = document.createElement('div');
    row.className = 'stem';
    row.innerHTML = `<span>${name}</span><div class="bar"><div></div></div><span>0</span>`;
    $('stems').appendChild(row);
    meters[name] = row;
  }
}
const rms = {};
const buf = new Float32Array(512);

const ring = $('ring').getContext('2d');
let last = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  clock.update((now - last) / 1000);
  last = now;
  setupMeters();
  const ph = clock.getPhase();
  $('big').textContent = clock.getBpm().toFixed(2);
  $('beat').textContent = `beat ${clock.getIndex()} · bar ${Math.floor(clock.getIndex() / 4)}`;
  $('onbeat').className = clock.isOnBeat() ? 'on' : '';
  $('timebase').textContent = `timebase: ${clock.timebase}${clock.music ? ` · music: ${clock.music.mode} · intensity ${clock.music.intensity.toFixed(2)}` : ''}`;
  // ring
  ring.clearRect(0, 0, 160, 160);
  ring.lineWidth = 10;
  ring.strokeStyle = '#1a2232';
  ring.beginPath();
  ring.arc(80, 80, 60, 0, Math.PI * 2);
  ring.stroke();
  ring.strokeStyle = clock.isOnBeat() ? '#ff3d8a' : '#3df0ff';
  ring.beginPath();
  ring.arc(80, 80, 60, -Math.PI / 2, -Math.PI / 2 + ph * Math.PI * 2);
  ring.stroke();
  const beatInBar = clock.getIndex() % 4;
  for (let i = 0; i < 4; i++) {
    ring.fillStyle = i === beatInBar ? '#ff3d8a' : '#23324a';
    ring.beginPath();
    ring.arc(50 + i * 20, 80, 6, 0, Math.PI * 2);
    ring.fill();
  }
  if (analysers) {
    for (const [name, an] of Object.entries(analysers)) {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      rms[name] = Math.sqrt(s / buf.length);
      meters[name].querySelector('.bar > div').style.width = `${Math.min(100, rms[name] * 400)}%`;
      meters[name].lastChild.textContent = clock.music.stems[name].gain.value.toFixed(2);
    }
  }
}
frame();

window.__tempo = { clock, bus, beats, rms, renderTestTrack };
