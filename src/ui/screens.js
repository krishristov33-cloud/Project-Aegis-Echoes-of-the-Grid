// Screens and meta flow: title -> play <-> pause, death overlay, level fade, victory + credits with run stats.
// Owns `game.paused`. main.js reaches it through hud.showStart() (pointer unlocked) and hud.hideStart() (locked).
//
// mode: 'title' | 'play' | 'pause' | 'victory'
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function createScreens({ root, strings, bus }) {
  const M = strings.menu || {};
  const game = () => globalThis.game;
  const canvas = document.getElementById('gl');
  const startEl = document.getElementById('start');
  const fadeEl = document.getElementById('fade');
  const sfx = (name) => game()?.sfx?.play?.(name);

  let mode = startEl && !startEl.classList.contains('hidden') ? 'title' : 'play';
  let started = false;
  let dead = false;
  let victoryT = 0;
  let postOn = true;
  let soundOn = true;
  let prevMaster = 0.9;
  const stats = { time: 0, kills: 0, onBeat: 0, deaths: 0, best: 0, chain: 0 };
  const offs = [];
  const on = (name, fn) => bus && offs.push(bus.on(name, fn));

  // ---------- title ----------
  const tag = document.getElementById('title-tag');
  if (tag) tag.textContent = M.tagline || '';
  const bStart = document.getElementById('bStart');
  if (bStart) bStart.firstElementChild.textContent = M.start || 'START';
  const tc = document.getElementById('title-controls');
  if (tc) for (const [k, v] of M.controlsList || []) {
    const s = el('span');
    s.appendChild(el('kbd', '', k));
    s.appendChild(document.createTextNode(' ' + v));
    tc.appendChild(s);
  }

  function button(label, cls, fn) {
    const b = el('button', 'btn ' + (cls || ''));
    b.type = 'button';
    b.appendChild(el('span', '', label));
    b.addEventListener('mouseenter', () => sfx('uiHover'));
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return b;
  }
  const setLabel = (b, t) => { b.firstElementChild.textContent = t; };
  bStart?.addEventListener('mouseenter', () => sfx('uiHover'));

  // ---------- pause ----------
  const pause = el('div', 'overlay screen hidden');
  pause.id = 'pause';
  const pMain = el('div', 'panel');
  pMain.appendChild(el('div', 'p-pre', M.pausedSub || ''));
  pMain.appendChild(el('h2', '', M.paused || 'PAUSED'));
  const pBtns = el('div', 'btn-col');
  const onOff = (v) => (v ? M.on || 'ON' : M.off || 'OFF');
  const bPost = button('', 'ghost', () => {
    postOn = !postOn;
    game()?.post?.setEnabled?.(postOn);
    setLabel(bPost, `${M.quality || 'POST FX'}  ${onOff(postOn)}`);
    sfx('uiConfirm');
  });
  const bSound = button('', 'ghost', () => {
    soundOn = !soundOn;
    const master = game()?.clock?.audio?.master;
    if (master) {
      if (!soundOn) prevMaster = master.gain.value || prevMaster;
      master.gain.value = soundOn ? prevMaster : 0;
    }
    setLabel(bSound, `${M.sound || 'SOUND'}  ${onOff(soundOn)}`);
    sfx('uiConfirm');
  });
  pBtns.append(
    button(M.resume || 'RESUME', 'primary', () => resume(true)),
    button(M.restart || 'RESTART AREA', '', () => { const g = game(); resume(true); g?.goto?.(g.level); }),
    button(M.controls || 'CONTROLS', '', () => { pMain.classList.add('hidden'); pCtl.classList.remove('hidden'); sfx('uiConfirm'); }),
    bPost,
    bSound,
  );
  pMain.appendChild(pBtns);
  const pCtl = el('div', 'panel hidden');
  pCtl.appendChild(el('div', 'p-pre', M.controls || 'CONTROLS'));
  const list = el('div', 'p-list');
  for (const [k, v] of M.controlsList || []) {
    const a = el('span'); a.appendChild(el('kbd', '', k));
    list.append(a, el('span', '', v));
  }
  pCtl.appendChild(list);
  pCtl.appendChild(button(M.back || 'BACK', '', () => { pCtl.classList.add('hidden'); pMain.classList.remove('hidden'); sfx('uiBack'); }));
  pause.append(pMain, pCtl);
  document.body.appendChild(pause);

  // ---------- death ----------
  const death = el('div', 'overlay hidden');
  death.id = 'death';
  const dPanel = el('div', 'panel');
  dPanel.appendChild(el('h2', '', M.dead || 'SIGNAL LOST'));
  dPanel.appendChild(el('div', 'p-sub', M.deadSub || ''));
  const dBar = el('div', 'p-bar'); dBar.appendChild(el('i'));
  dPanel.appendChild(dBar);
  death.appendChild(dPanel);
  document.body.appendChild(death);

  // ---------- victory ----------
  const victory = el('div', 'overlay hidden');
  victory.id = 'victory';
  document.body.appendChild(victory);

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function showVictory() {
    mode = 'victory';
    const g = game();
    if (g) g.paused = true;
    document.exitPointerLock?.();
    root.classList.add('dim');
    const p = el('div', 'panel');
    p.appendChild(el('div', 'p-pre', strings.subtitle || ''));
    p.appendChild(el('h2', '', M.victory || 'GRID IN TUNE'));
    p.appendChild(el('div', 'p-sub', M.victorySub || ''));
    const st = el('div', 'v-stats');
    const L = M.stats || {};
    for (const [k, v] of [['time', fmtTime(stats.time)], ['kills', stats.kills], ['onBeat', stats.onBeat], ['best', stats.best], ['deaths', stats.deaths]]) {
      const c = el('div', 'v-stat');
      c.append(el('b', '', String(v)), el('span', '', L[k] || k));
      st.appendChild(c);
    }
    p.appendChild(st);
    p.appendChild(button(M.playAgain || 'PLAY AGAIN', 'primary', () => { sfx('uiConfirm'); location.reload(); }));
    p.appendChild(el('div', 'v-ct', M.creditsTitle || 'CREDITS'));
    const cr = el('div', 'v-credits');
    for (const [role, who] of M.credits || []) cr.append(el('span', '', role), el('span', '', who));
    p.appendChild(cr);
    victory.replaceChildren(p);
    victory.classList.remove('hidden');
  }

  // ---------- pause control ----------
  function openPause() {
    if (mode !== 'play') return;
    mode = 'pause';
    const g = game();
    if (g) g.paused = true;
    setLabel(bPost, `${M.quality || 'POST FX'}  ${onOff(postOn)}`);
    setLabel(bSound, `${M.sound || 'SOUND'}  ${onOff(soundOn)}`);
    bPost.style.display = g?.post?.setEnabled ? '' : 'none';
    pCtl.classList.add('hidden');
    pMain.classList.remove('hidden');
    pause.classList.remove('hidden');
    root.classList.add('dim');
    sfx('uiBack');
    if (document.pointerLockElement) document.exitPointerLock?.(); // free the cursor for the menu
  }

  function resume(lock) {
    if (mode !== 'pause') return;
    mode = 'play';
    const g = game();
    if (g) g.paused = false;
    pause.classList.add('hidden');
    root.classList.remove('dim');
    sfx('uiConfirm');
    if (lock && canvas && document.pointerLockElement !== canvas) {
      // Chrome refuses a re-lock for about a second after Esc; a click on the canvas locks again later
      try { canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* same */ }
    }
  }

  const onKey = (e) => {
    if (e.code !== 'Escape' && e.code !== 'KeyP') return;
    if (mode === 'pause') resume(true);
    else if (mode === 'play' && started && (e.code === 'KeyP' || !document.pointerLockElement)) openPause();
  };
  addEventListener('keydown', onKey);
  const onBlur = () => { if (mode === 'play' && started && document.pointerLockElement) openPause(); };
  addEventListener('blur', onBlur);

  // ---------- events ----------
  on('levelState', ({ phase } = {}) => {
    if (phase !== 'enter' || !fadeEl) return;
    fadeEl.classList.add('on');
    setTimeout(() => fadeEl.classList.remove('on'), 140);
  });
  on('enemyKilled', () => { stats.kills++; });
  on('enemyHit', (p = {}) => {
    if (p.src !== 'player' && p.src?.source !== 'player') return;
    if (p.src?.onBeat) stats.onBeat++;
    stats.chain++;
    stats.best = Math.max(stats.best, stats.chain);
    chainT = 2.6;
  });
  on('comboChanged', ({ count = 0 } = {}) => { stats.best = Math.max(stats.best, count); });
  on('playerDamaged', () => { stats.chain = 0; });
  on('playerDied', () => setDead(true));
  on('playerRespawned', () => setDead(false));
  on('bossDefeated', () => { victoryT = 3.4; });
  let chainT = 0;

  function setDead(v) {
    if (v === dead) return;
    dead = v;
    if (v) {
      stats.deaths++;
      death.classList.remove('hidden');
      root.classList.add('dim');
      const bar = dBar.firstChild; bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    } else {
      death.classList.add('hidden');
      if (mode === 'play') root.classList.remove('dim');
      if (fadeEl) { fadeEl.classList.add('on'); setTimeout(() => fadeEl.classList.remove('on'), 140); }
    }
  }

  return {
    get mode() { return mode; },
    get stats() { return stats; },
    openPause,
    resume,
    showVictory,
    /** Pointer lock was lost (or main.js wants the start card): title the first time, pause afterwards. */
    onUnlock() {
      if (!started && mode !== 'victory') {
        mode = 'title';
        startEl?.classList.remove('hidden');
        const pl = game()?.player;
        if (pl) pl.invulnerable = true; // the world idles behind the title; nothing may hurt Kael yet
        root.classList.add('dim');
      } else openPause();
    },
    /** Pointer lock gained / start clicked: we are playing. */
    onLock() {
      if (mode === 'victory') return;
      if (mode === 'title' || !started) {
        if (!started && mode === 'title') sfx('uiConfirm');
        if (mode === 'title' && game()?.player) game().player.invulnerable = false;
        started = true;
        mode = 'play';
        startEl?.classList.add('hidden');
        root.classList.remove('dim');
      } else if (mode === 'pause') resume(false);
    },
    update(dt, { hp }) {
      if (mode === 'play') stats.time += dt;
      if (chainT > 0) { chainT -= dt; if (chainT <= 0) stats.chain = 0; }
      // until the player owner emits playerDied / playerRespawned, derive it from hp
      if (hp <= 0 && !dead) setDead(true);
      else if (hp > 0 && dead) setDead(false);
      if (victoryT > 0) { victoryT -= dt; if (victoryT <= 0) showVictory(); }
    },
    dispose() {
      offs.forEach((o) => o?.());
      removeEventListener('keydown', onKey);
      removeEventListener('blur', onBlur);
      pause.remove(); death.remove(); victory.remove();
    },
  };
}
