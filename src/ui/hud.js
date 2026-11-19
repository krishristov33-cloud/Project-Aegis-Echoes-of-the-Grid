// L5 HUD: HP bar, callouts, level-state banner. All player-facing text from strings.json.
export function createHud({ root, strings, bus, debug = false }) {
  const S = strings.hud || {};
  const levels = S.levels || {};
  let debugEl = root.querySelector('#hud-debug');
  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.id = 'hud-debug';
    root.appendChild(debugEl);
  }
  debugEl.style.display = debug ? '' : 'none';

  const prompt = root.querySelector('#prompt');
  const start = document.getElementById('start');
  const loading = document.getElementById('loading');

  let chrome = root.querySelector('#hud-chrome');
  if (!chrome) {
    chrome = document.createElement('div');
    chrome.id = 'hud-chrome';
    chrome.innerHTML = `
      <div id="hud-banner" class="hidden"></div>
      <div id="hud-hp">
        <div class="hp-label"></div>
        <div class="hp-track"><div class="hp-fill"></div></div>
        <div class="hp-val"></div>
      </div>
      <div id="hud-callout" class="hidden"></div>
    `;
    root.appendChild(chrome);
  }
  const bannerEl = chrome.querySelector('#hud-banner');
  const calloutEl = chrome.querySelector('#hud-callout');
  const hpLabel = chrome.querySelector('.hp-label');
  const hpFill = chrome.querySelector('.hp-fill');
  const hpVal = chrome.querySelector('.hp-val');
  hpLabel.textContent = S.hp || 'HP';

  let bannerUntil = 0;
  let calloutUntil = 0;
  let flash = 0;

  function showBanner(level, phase) {
    const name = levels[level] || level || '';
    const template = (phase && S.phases && S.phases[phase]) || '{level}';
    bannerEl.replaceChildren();
    if (phase === 'enter' && S.enterPrefix) {
      const pre = document.createElement('div');
      pre.className = 'banner-pre';
      pre.textContent = S.enterPrefix;
      bannerEl.appendChild(pre);
    }
    const main = document.createElement('div');
    main.className = 'banner-main';
    main.textContent = String(template).replace('{level}', name);
    bannerEl.appendChild(main);
    bannerEl.classList.remove('hidden');
    bannerUntil = performance.now() + 2800;
  }

  function showCallout(text) {
    if (!text) return;
    calloutEl.textContent = text;
    calloutEl.classList.remove('hidden');
    calloutUntil = performance.now() + 2800;
  }

  const offs = [];
  if (bus) {
    offs.push(bus.on('levelState', ({ level, phase }) => showBanner(level, phase)));
    offs.push(bus.on('callout', ({ text }) => showCallout(text)));
    offs.push(bus.on('playerDamaged', () => { flash = 1; }));
  }

  return {
    hideLoading() { if (loading) loading.classList.add('hidden'); },
    showStart() { if (start) start.classList.remove('hidden'); },
    hideStart() { if (start) start.classList.add('hidden'); },
    setPrompt(t) { if (prompt) { prompt.textContent = t || ''; prompt.style.display = t ? 'block' : 'none'; } },
    update({ state, speed, fps, grounded, hp, hpMax, model, level, bpm, phase, onBeat, dt = 0 }) {
      const max = hpMax || 100;
      const cur = Math.max(0, hp ?? 0);
      const pct = Math.max(0, Math.min(1, cur / max));
      hpFill.style.width = `${pct * 100}%`;
      hpFill.classList.toggle('low', pct <= 0.33);
      hpVal.textContent = `${Math.round(cur)}/${Math.round(max)}`;
      if (flash > 0) {
        flash = Math.max(0, flash - (dt || 0.016) * 2.5);
        chrome.style.setProperty('--hp-flash', flash.toFixed(3));
      }
      const now = performance.now();
      if (bannerUntil && now > bannerUntil) {
        bannerEl.classList.add('hidden');
        bannerUntil = 0;
      }
      if (calloutUntil && now > calloutUntil) {
        calloutEl.classList.add('hidden');
        calloutUntil = 0;
      }
      if (debug) {
        const bar = onBeat ? '●' : '○';
        debugEl.textContent = [
          'AEGIS  v0.1  L1–L5',
          `LEVEL  ${level || '—'}`,
          `STATE  ${state || '—'}`,
          `SPEED  ${(speed ?? 0).toFixed(2)} m/s`,
          `FPS    ${Math.round(fps || 0)}`,
          `GROUND ${grounded ? 'yes' : 'no'}`,
          `HP     ${Math.round(cur)}/${Math.round(max)}`,
          `MODEL  ${model || '—'}`,
          `TEMPO  ${Math.round(bpm || 0)} BPM  ${bar}  ph=${(phase ?? 0).toFixed(2)}`,
        ].join('\n');
      }
    },
    dispose() { offs.forEach((off) => off?.()); },
  };
}
