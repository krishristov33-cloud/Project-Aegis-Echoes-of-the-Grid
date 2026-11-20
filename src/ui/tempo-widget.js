// L5 tempo widget: phase ring driven by bus `beat` events (stub clock now, C5 later).
export function createTempoWidget({ root, bus, strings }) {
  const S = (strings && strings.hud) || {};
  let wrap = root.querySelector('#hud-tempo');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'hud-tempo';
    root.appendChild(wrap);
  }
  wrap.innerHTML = `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring-track" cx="50" cy="50" r="40" />
      <circle class="ring-win" cx="50" cy="50" r="40" />
      <circle class="ring-phase" cx="50" cy="50" r="40" />
      <circle class="ring-pulse" cx="50" cy="50" r="44" />
    </svg>
    <div class="tempo-bpm">—</div>
    <div class="tempo-label"></div>
  `;
  wrap.querySelector('.tempo-label').textContent = S.bpm || 'BPM';
  const phaseEl = wrap.querySelector('.ring-phase');
  const pulseEl = wrap.querySelector('.ring-pulse');
  const bpmEl = wrap.querySelector('.tempo-bpm');
  const C = 2 * Math.PI * 40;
  phaseEl.style.strokeDasharray = `${C}`;
  phaseEl.style.strokeDashoffset = `${C}`;
  // gold arc = the on-beat window (|phase| < 0.12 either side of the beat, which sits at 12 o'clock)
  const winEl = wrap.querySelector('.ring-win');
  const WIN = 0.12;
  winEl.style.strokeDasharray = `${C * WIN * 2} ${C}`;
  winEl.style.transform = `rotate(${-90 - WIN * 360}deg)`;
  pulseEl.style.opacity = '0';

  let last = { t: performance.now(), bpm: 0, index: 0 };
  let pulse = 0;

  const off = bus?.on('beat', ({ index, bar, phase, bpm }) => {
    last = { t: performance.now(), bpm: bpm || last.bpm, index, bar, phase: phase ?? 0 };
    pulse = 1;
    wrap.classList.add('on-beat');
    if (last.bpm) bpmEl.textContent = String(Math.round(last.bpm));
  });

  return {
    update() {
      const period = 60 / Math.max(1, last.bpm || 1);
      const elapsed = last.bpm ? (performance.now() - last.t) / 1000 : 0;
      const ph = last.bpm ? (elapsed / period) % 1 : 0;
      phaseEl.style.strokeDashoffset = `${C * (1 - ph)}`;
      if (pulse > 0) {
        pulse = Math.max(0, pulse - 0.08);
        pulseEl.style.opacity = String(pulse);
        const s = 1 + pulse * 0.12;
        wrap.style.setProperty('--pulse-scale', s.toFixed(3));
        if (pulse <= 0) wrap.classList.remove('on-beat');
      }
    },
    dispose() { off?.(); },
  };
}
