// Minimal debug HUD for L1–L4 (full L5 tempo widget / DAW menu comes later).
export function createHud({ root, strings }) {
  let debug = root.querySelector('#hud-debug');
  if (!debug) {
    debug = document.createElement('pre');
    debug.id = 'hud-debug';
    root.appendChild(debug);
  }
  const prompt = root.querySelector('#prompt');
  const start = document.getElementById('start');
  const loading = document.getElementById('loading');

  return {
    hideLoading() { if (loading) loading.classList.add('hidden'); },
    showStart() { if (start) start.classList.remove('hidden'); },
    hideStart() { if (start) start.classList.add('hidden'); },
    setPrompt(t) { if (prompt) { prompt.textContent = t || ''; prompt.style.display = t ? 'block' : 'none'; } },
    update({ state, speed, fps, grounded, hp, hpMax, model, level, bpm, phase, onBeat }) {
      const bar = onBeat ? '●' : '○';
      debug.textContent = [
        'AEGIS  v0.1  L1–L4',
        `LEVEL  ${level || '—'}`,
        `STATE  ${state || '—'}`,
        `SPEED  ${(speed ?? 0).toFixed(2)} m/s`,
        `FPS    ${Math.round(fps || 0)}`,
        `GROUND ${grounded ? 'yes' : 'no'}`,
        `HP     ${Math.round(hp ?? 0)}/${hpMax ?? 100}`,
        `MODEL  ${model || '—'}`,
        `TEMPO  ${Math.round(bpm || 0)} BPM  ${bar}  ph=${(phase ?? 0).toFixed(2)}`,
      ].join('\n');
    },
  };
}
