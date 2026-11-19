// C6 test page logic: real bus + clock + mix-health + sidechain, and a stub player that emits the combat events.
import { bus } from '../src/core/events.js';
import { createAudioClock } from '../src/core/audio-clock.js';
import { createMixHealth } from '../src/audio/mixhealth.js';
import { createSidechain } from '../src/audio/sidechain.js';

const tuning = await fetch('../src/data/tuning.json').then((r) => r.json());
const clock = createAudioClock(bus, tuning);
window.game = { clock, tuning, bus }; // same globals main.js exposes
const mix = createMixHealth(bus);
const side = createSidechain(bus);
const $ = (id) => document.getElementById(id);

const player = { hp: 100, hpMax: 100 };
const damage = (n) => {
  player.hp = Math.max(0, player.hp - n);
  bus.emit('playerDamaged', { amount: n, hp: player.hp, hpMax: player.hpMax });
};
const heal = (n) => {
  const add = Math.min(n, player.hpMax - player.hp);
  player.hp += add;
  bus.emit('playerHealed', { amount: add, hp: player.hp, hpMax: player.hpMax });
};
$('start').onclick = () => clock.startAudio();
$('d10').onclick = () => damage(10);
$('d30').onclick = () => damage(30);
$('h25').onclick = () => heal(25);
$('full').onclick = () => heal(100);
$('melee').onclick = () => bus.emit('sidechain', { source: 'melee', strength: 0.6, onBeat: false });
$('blast').onclick = () => bus.emit('sidechain', { source: 'blast', strength: 1, onBeat: false });
$('beatBlast').onclick = () => bus.emit('sidechain', { source: 'blast', strength: 1.2, onBeat: true });

let an = null;
const td = new Float32Array(2048);
let fd = null;
const scope = $('scope').getContext('2d');
const spec = $('spec').getContext('2d');
const metrics = { centroid: 0, rms: 0, levels: 0 };

let last = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  clock.update((now - last) / 1000);
  last = now;
  $('hp').firstElementChild.style.width = `${player.hp}%`;
  if (!an && mix.nodes) {
    an = clock.audio.ctx.createAnalyser();
    an.fftSize = 2048;
    mix.nodes.post.connect(an);
    fd = new Float32Array(an.frequencyBinCount);
  }
  $('state').textContent = mix.attached ? `chain attached · level ${mix.level.toFixed(2)} · pumps ${side.pumps} · music gain ${clock.audio.musicBus.gain.value.toFixed(2)}` : 'waiting for audio…';
  if (!an) return;
  an.getFloatTimeDomainData(td);
  an.getFloatFrequencyData(fd);
  // scope
  scope.fillStyle = '#0a1220';
  scope.fillRect(0, 0, 720, 140);
  scope.strokeStyle = mix.level > 0.5 ? '#ff3d8a' : '#3df0ff';
  scope.beginPath();
  let rms = 0;
  for (let i = 0; i < 720; i++) {
    const v = td[Math.floor((i / 720) * td.length)];
    scope.lineTo(i, 70 - v * 120);
  }
  scope.stroke();
  for (const v of td) rms += v * v;
  // spectrum + centroid
  spec.fillStyle = '#0a1220';
  spec.fillRect(0, 0, 720, 140);
  spec.fillStyle = '#3df0ff';
  let num = 0;
  let den = 0;
  const hzPerBin = clock.audio.ctx.sampleRate / an.fftSize;
  for (let i = 1; i < fd.length; i++) {
    const mag = Math.pow(10, fd[i] / 20);
    num += mag * i * hzPerBin;
    den += mag;
    const x = (Math.log(i) / Math.log(fd.length)) * 720;
    const h = Math.max(0, (fd[i] + 110) * 1.2);
    spec.fillRect(x, 140 - h, 2, h);
  }
  metrics.centroid = den ? num / den : 0;
  metrics.rms = Math.sqrt(rms / td.length);
  // distinct sample values ~ bit depth after the crusher
  metrics.levels = new Set(Array.from(td, (v) => Math.round(v * 32768))).size;
  $('stats').textContent =
    `lowpass   ${mix.nodes.lp.frequency.value.toFixed(0)} Hz\n` +
    `pre gain  ${mix.nodes.pre.gain.value.toFixed(2)}   post gain ${mix.nodes.post.gain.value.toFixed(2)}\n` +
    `centroid  ${metrics.centroid.toFixed(0)} Hz   rms ${metrics.rms.toFixed(3)}   distinct levels ${metrics.levels}`;
}
frame();

window.__mix = { clock, bus, mix, side, player, damage, heal, metrics };
