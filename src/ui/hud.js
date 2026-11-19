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
      <div id="hud-boss" class="hidden">
        <div class="boss-label"></div>
        <div class="boss-track"><div class="boss-fill"></div></div>
        <div class="boss-weak"></div>
      </div>
    `;
    root.appendChild(chrome);
  }
  if (!document.getElementById('hud-boss-style')) {
    const st = document.createElement('style');
    st.id = 'hud-boss-style';
    st.textContent = `
      #hud-boss{position:absolute;top:18px;left:50%;transform:translateX(-50%);width:min(520px,70vw);text-align:center;pointer-events:none;z-index:6}
      #hud-boss .boss-label{font:800 11px/1 system-ui;letter-spacing:.28em;color:var(--mag,#ff3d8a);margin-bottom:6px;text-shadow:0 0 8px #012}
      #hud-boss .boss-track{height:12px;background:rgba(8,8,14,.75);border:1px solid rgba(255,61,138,.45);box-shadow:0 0 12px #ff3d8a22, inset 0 0 0 1px #000}
      #hud-boss .boss-fill{height:100%;width:100%;background:linear-gradient(90deg,#8a1038,var(--mag,#ff3d8a));box-shadow:0 0 10px #ff3d8a88;transition:width .12s linear}
      #hud-boss .boss-weak{margin-top:7px;font:900 16px/1 system-ui;letter-spacing:.32em;color:#fff;opacity:0;text-shadow:0 0 14px #ff3d8a;transition:opacity .12s}
      #hud-boss.weak .boss-weak{opacity:1;animation:bossWeakFlash .16s linear alternate infinite}
      @keyframes bossWeakFlash{from{opacity:.55;transform:scale(1)}to{opacity:1;transform:scale(1.08)}}
    `;
    document.head.appendChild(st);
  }
  const bannerEl = chrome.querySelector('#hud-banner');
  const calloutEl = chrome.querySelector('#hud-callout');
  const bossEl = chrome.querySelector('#hud-boss');
  const bossLabel = chrome.querySelector('#hud-boss .boss-label');
  const bossFill = chrome.querySelector('#hud-boss .boss-fill');
  const bossWeak = chrome.querySelector('#hud-boss .boss-weak');
  if (bossLabel) bossLabel.textContent = S.boss || 'DISSONANT HULK';
  if (bossWeak) bossWeak.textContent = S.weak || 'WEAK';
  let weakUntil = 0;
  let bossVisible = false;
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
    offs.push(bus.on('bossPhase', () => { bossVisible = true; bossEl?.classList.remove('hidden'); }));
    offs.push(bus.on('bossTelegraph', () => { bossVisible = true; bossEl?.classList.remove('hidden'); }));
    offs.push(bus.on('enemyHit', (p) => {
      if (p?.kind !== 'hulk') return;
      bossVisible = true;
      bossEl?.classList.remove('hidden');
      if (p.weak) {
        bossEl?.classList.add('weak');
        weakUntil = performance.now() + 900;
      }
      if (p.hpMax) bossFill && (bossFill.style.width = `${Math.max(0, Math.min(1, (p.hp ?? 0) / p.hpMax)) * 100}%`);
    }));
    offs.push(bus.on('bossDefeated', () => {
      if (bossFill) bossFill.style.width = '0%';
      bossEl?.classList.remove('weak');
      setTimeout(() => { bossEl?.classList.add('hidden'); bossVisible = false; }, 1600);
    }));
  }

  return {
    hideLoading() { if (loading) loading.classList.add('hidden'); },
    showStart() { if (start) start.classList.remove('hidden'); },
    hideStart() { if (start) start.classList.add('hidden'); },
    setPrompt(t) { if (prompt) { prompt.textContent = t || ''; prompt.style.display = t ? 'block' : 'none'; } },
    update({ state, speed, fps, grounded, hp, hpMax, model, level, bpm, phase, onBeat, dt = 0, boss = null }) {
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
      if (boss && boss.hpMax) {
        bossVisible = true;
        bossEl?.classList.remove('hidden');
        if (bossFill) bossFill.style.width = `${Math.max(0, Math.min(1, (boss.hp ?? 0) / boss.hpMax)) * 100}%`;
        if (boss.weak) {
          bossEl?.classList.add('weak');
          weakUntil = Math.max(weakUntil, now + 120);
        }
      }
      if (weakUntil && now > weakUntil) {
        bossEl?.classList.remove('weak');
        weakUntil = 0;
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
