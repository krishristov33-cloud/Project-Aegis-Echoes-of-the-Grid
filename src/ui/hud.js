// HUD: mix-integrity (health) meter, power bar with cooldowns, beat reticle, hitmarkers, chain counter, enemy pips,
// floating damage, damage direction, attack warnings, boss bar, objective, subtitles, prompts. Menus and the title /
// pause / death / victory flow live in screens.js, first-time tips in tips.js; both are created here.
//
// Performance rules: the DOM is built once, per-frame work only writes `transform` / `opacity` (compositor only),
// and text / classes change only when the value changes.
//
// All player-facing text comes from strings.json. Reads the rest of the game through `globalThis.game`.
import { createScreens } from './screens.js';
import { createTips } from './tips.js';

const ICONS = {
  blast: '<path d="M3 12h3"/><path d="M9 8a6 6 0 0 1 0 8"/><path d="M13 5a10 10 0 0 1 0 14"/><path d="M17 2.5a13.5 13.5 0 0 1 0 19"/>',
  blink: '<path d="M4 12l4-6.5 4 6.5-4 6.5z" opacity=".45"/><path d="M12 12l4-6.5 4 6.5-4 6.5z"/>',
  phaseSkip: '<path d="M12 2.5v4M12 10v4M12 17.5v4"/><path d="M3 12h15"/><path d="M15 8.5l3.5 3.5-3.5 3.5"/>',
  waveShield: '<path d="M3 21v-7M7.5 21V9M12 21V4M16.5 21V9M21 21v-7"/>',
  launchpad: '<path d="M4 20h16"/><path d="M7 16.5h10"/><path d="M12 13V3"/><path d="M8 7l4-4 4 4"/>',
};
const POWER_ORDER = ['blast', 'blink', 'phaseSkip', 'waveShield', 'launchpad'];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };

export function createHud({ root, strings, bus, debug = false }) {
  const S = strings.hud || {};
  const levels = S.levels || {};
  const game = () => globalThis.game;
  const QS = new URLSearchParams(globalThis.location?.search || '');

  let debugEl = root.querySelector('#hud-debug');
  if (!debugEl) { debugEl = el('pre'); debugEl.id = 'hud-debug'; root.appendChild(debugEl); }
  debugEl.style.display = debug ? '' : 'none';
  const prompt = root.querySelector('#prompt');
  const start = document.getElementById('start');
  const loading = document.getElementById('loading');

  // ---------- build ----------
  const chrome = el('div');
  chrome.id = 'hud-chrome';
  chrome.innerHTML = `
    <div id="hud-hurt"></div>
    <div id="hud-obj" class="off"><div class="obj-label"></div><div class="obj-text"></div></div>
    <div id="hud-banner" class="hidden"></div>
    <div id="hud-boss" class="hidden"><div class="boss-label"></div><div class="boss-track"><div class="boss-fill"></div></div><div class="boss-weak"></div></div>
    <div id="hud-world"></div>
    <div id="hud-dmg"></div>
    <div id="hud-ret"><div class="ret-ring"></div><div class="ret-dot"></div><div class="ret-hit"></div></div>
    <div id="hud-onbeat"></div>
    <div id="hud-combo"><div class="cb-n">0</div><div class="cb-l"></div><div class="cb-bar"></div><div class="cb-s"></div></div>
    <div id="hud-hp"><div class="hp-head"><span class="hp-label"></span><span class="hp-val"></span></div><div class="hp-track"><div class="hp-ghost"></div><div class="hp-fill"></div></div></div>
    <div id="hud-powers"></div>
    <div id="hud-callout" class="hidden"></div>
    <div id="hud-tip" class="off"></div>
  `;
  root.appendChild(chrome);
  const q = (s) => chrome.querySelector(s);

  const hurtEl = q('#hud-hurt');
  const objEl = q('#hud-obj'), objText = q('.obj-text');
  q('.obj-label').textContent = S.objectiveLabel || 'OBJECTIVE';
  const bannerEl = q('#hud-banner');
  const calloutEl = q('#hud-callout');
  const bossEl = q('#hud-boss'), bossFill = q('.boss-fill');
  q('.boss-label').textContent = S.boss || 'DISSONANT HULK';
  q('.boss-weak').textContent = S.weak || 'WEAK';
  const worldEl = q('#hud-world');
  const dmgEl = q('#hud-dmg');
  const retRing = q('.ret-ring'), retHit = q('.ret-hit');
  const onBeatEl = q('#hud-onbeat');
  onBeatEl.textContent = S.onBeat || 'ON BEAT';
  const comboEl = q('#hud-combo'), comboN = q('.cb-n'), comboS = q('.cb-s'), comboBar = q('.cb-bar');
  q('.cb-l').textContent = S.combo || 'CHAIN';
  const hpEl = q('#hud-hp'), hpFill = q('.hp-fill'), hpGhost = q('.hp-ghost'), hpVal = q('.hp-val');
  q('.hp-label').textContent = S.hp || 'HP';

  // power bar
  const powersEl = q('#hud-powers');
  const powers = POWER_ORDER.map((id) => {
    const box = el('div', 'pw');
    box.innerHTML = `<div class="pw-box"><div class="pw-sweep"></div></div><svg viewBox="0 0 24 24">${ICONS[id]}</svg>`;
    box.appendChild(el('div', 'pw-key', S.keys?.[id] || ''));
    box.appendChild(el('div', 'pw-name', S.powers?.[id] || id));
    powersEl.appendChild(box);
    return { id, box, cd: -1, cooling: false };
  });

  // pools of world-anchored markers
  const pool = (n, make) => Array.from({ length: n }, () => { const node = make(); worldEl.appendChild(node); return { node, on: false }; });
  const pips = pool(8, () => { const p = el('div', 'pip'); p.appendChild(el('i')); return p; });
  const nums = pool(10, () => el('div', 'dnum'));
  const warns = pool(4, () => el('div', 'warn', '!'));
  const arcs = Array.from({ length: 3 }, () => { const node = el('div', 'dmg-arc'); dmgEl.appendChild(node); return { node, t: 0 }; });

  // ---------- state ----------
  let W = innerWidth, H = innerHeight;
  addEventListener('resize', () => { W = innerWidth; H = innerHeight; });
  let bannerUntil = 0, calloutUntil = 0, weakUntil = 0;
  let hurt = 0;
  let lastHp = -1, lastHpMax = -1, lastLow = null;
  let lastBoss = -1;
  let lastPrompt = '';
  let combo = 0, comboT = 0, streak = 0, externalCombo = false, lastComboShown = -1, lastStreakShown = -1;
  const COMBO_HOLD = 2.6;
  const recent = new Map(); // enemy id -> seconds left to show its pip
  let ringOn = false;

  const proj = { x: 0, y: 0, ok: false };
  /** World -> screen pixels. `ok` is false behind the camera. */
  function project(x, y, z) {
    const cam = game()?.camera;
    if (!cam) { proj.ok = false; return proj; }
    const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    const cx = v[0] * x + v[4] * y + v[8] * z + v[12];
    const cy = v[1] * x + v[5] * y + v[9] * z + v[13];
    const cz = v[2] * x + v[6] * y + v[10] * z + v[14];
    proj.ok = cz < -0.1;
    const w = -cz || 1e-6;
    proj.x = (0.5 + (0.5 * p[0] * cx) / Math.abs(w)) * W;
    proj.y = (0.5 - (0.5 * p[5] * cy) / Math.abs(w)) * H;
    return proj;
  }

  function showBanner(level, phase) {
    const name = levels[level] || level || '';
    const template = (phase && S.phases && S.phases[phase]) || '{level}';
    bannerEl.replaceChildren();
    if (phase === 'enter' && S.enterPrefix) bannerEl.appendChild(el('div', 'banner-pre', S.enterPrefix));
    bannerEl.appendChild(el('div', 'banner-main', String(template).replace('{level}', name)));
    bannerEl.classList.remove('hidden');
    bannerEl.style.animation = 'none'; void bannerEl.offsetWidth; bannerEl.style.animation = '';
    bannerUntil = performance.now() + 3000;
  }

  function showCallout(text) {
    if (!text) return;
    calloutEl.textContent = text;
    calloutEl.classList.remove('hidden');
    calloutUntil = performance.now() + 2600;
  }

  function setObjective(text) {
    if (!text) { objEl.classList.add('off'); return; }
    if (objText.textContent === text) return;
    objText.textContent = text;
    objEl.classList.remove('off');
    restart(objEl, 'pop');
  }

  function bumpCombo() {
    comboT = COMBO_HOLD;
    restart(comboN, 'bump');
  }

  function spawnNum(pos, amount, onBeat) {
    const n = nums.find((x) => !x.on) || nums[0];
    n.on = true; n.t = 0;
    n.x = pos.x + (Math.random() - 0.5) * 0.5; n.y = (pos.y ?? 0) + 1.5; n.z = pos.z;
    n.node.textContent = String(Math.round(amount));
    n.node.classList.toggle('beat', !!onBeat);
  }

  function damageFrom(src) {
    let pos = src?.position || src?.pos || src?.from || null;
    if (!pos && typeof src === 'string') pos = game()?.enemies?.find((e) => e.id === src)?.position;
    if (!pos) return;
    const a = arcs.reduce((m, x) => (x.t < m.t ? x : m), arcs[0]);
    a.t = 1.1; a.x = pos.x; a.z = pos.z;
  }

  // ---------- events ----------
  const offs = [];
  const on = (name, fn) => bus && offs.push(bus.on(name, fn));
  on('levelState', ({ level, phase } = {}) => {
    showBanner(level, phase);
    if (phase === 'enter') {
      recent.clear();
      bossEl.classList.add('hidden');
      lastBoss = -1;
      setObjective(S.objectives?.[level] || '');
    }
  });
  on('objective', ({ text } = {}) => setObjective(text));
  on('callout', ({ text } = {}) => showCallout(text));
  on('playerDamaged', ({ src, amount = 10, hpMax = 100 } = {}) => {
    hurt = Math.min(1, hurt + 0.45 + amount / hpMax);
    restart(hpEl, 'hit');
    damageFrom(src);
    if (!externalCombo) { combo = 0; streak = 0; }
  });
  on('comboChanged', ({ count = 0, onBeatStreak = 0 } = {}) => {
    externalCombo = true;
    if (count > combo) bumpCombo();
    combo = count; streak = onBeatStreak;
    if (count > 0) comboT = COMBO_HOLD;
  });
  on('enemyHit', (p = {}) => {
    const mine = p.src === 'player' || p.src?.source === 'player';
    if (mine) {
      const onBeat = !!p.src?.onBeat;
      retHit.classList.toggle('beat', onBeat);
      retHit.classList.toggle('kill', p.hp <= 0);
      restart(retHit, 'go');
      if (onBeat) restart(onBeatEl, 'go');
      if (!externalCombo) { combo++; streak = onBeat ? streak + 1 : 0; bumpCombo(); }
      if (p.pos) spawnNum(p.pos, p.amount ?? 0, onBeat);
    }
    if (p.kind === 'hulk') {
      if (p.weak) { bossEl.classList.add('weak'); weakUntil = performance.now() + 900; }
    } else if (p.id && p.hp > 0) recent.set(p.id, 4);
  });
  on('enemyKilled', ({ id } = {}) => recent.delete(id));
  on('enemyTelegraph', ({ pos, time = 0.6 } = {}) => {
    if (!pos) return;
    const w = warns.find((x) => !x.on) || warns[0];
    w.on = true; w.t = Math.max(0.3, time); w.x = pos.x; w.y = (pos.y ?? 0) + 1.6; w.z = pos.z;
  });
  on('bossPhase', () => bossEl.classList.remove('hidden'));
  on('bossTelegraph', () => bossEl.classList.remove('hidden'));
  on('bossDefeated', () => {
    bossFill.style.transform = 'scaleX(0)';
    bossEl.classList.remove('weak');
    setTimeout(() => bossEl.classList.add('hidden'), 1600);
  });

  const screens = createScreens({ root, strings, bus });
  const tips = createTips({ root: q('#hud-tip'), strings, bus, enabled: !QS.has('shots') || QS.has('tips') });

  // ---------- per-frame pieces ----------
  function updatePowers() {
    const cds = game()?.cooldowns?.();
    if (!cds) return;
    for (const p of powers) {
      const c = cds[p.id];
      if (!c) continue;
      const frac = c.total > 0 ? Math.max(0, Math.min(1, c.left / c.total)) : 0;
      const qd = Math.ceil(frac * 50) / 50;
      if (qd === p.cd) continue;
      p.cd = qd;
      p.box.style.setProperty('--cd', qd.toFixed(2));
      const cooling = qd > 0;
      if (cooling !== p.cooling) {
        p.cooling = cooling;
        p.box.classList.toggle('cd', cooling);
        if (!cooling) { restart(p.box, 'ready'); } else p.box.classList.remove('ready');
      }
    }
  }

  function updateWorld(dt) {
    const g = game();
    // enemy pips: only enemies hit in the last few seconds
    let i = 0;
    if (recent.size && g?.enemies) {
      for (const e of g.enemies) {
        const left = recent.get(e.id);
        if (left === undefined) continue;
        if (e.dead || left <= 0) { recent.delete(e.id); continue; }
        recent.set(e.id, left - dt);
        if (i >= pips.length) continue;
        const pr = project(e.position.x, e.position.y + (e.cfg?.height ?? 1.85) + 0.28, e.position.z);
        if (!pr.ok) continue;
        const pip = pips[i++];
        pip.on = true;
        pip.node.style.transform = `translate3d(${pr.x.toFixed(1)}px,${pr.y.toFixed(1)}px,0)`;
        pip.node.style.opacity = Math.min(1, left * 2).toFixed(2);
        const f = Math.max(0, Math.min(1, e.hp / (e.hpMax || 1)));
        if (pip.f !== f) { pip.f = f; pip.node.firstChild.style.transform = `scaleX(${f.toFixed(3)})`; }
        const duck = !!e.ducked;
        if (pip.duck !== duck) { pip.duck = duck; pip.node.classList.toggle('duck', duck); }
      }
    }
    for (; i < pips.length; i++) if (pips[i].on) { pips[i].on = false; pips[i].node.style.opacity = '0'; }

    for (const n of nums) {
      if (!n.on) continue;
      n.t += dt;
      const k = n.t / 0.75;
      const pr = project(n.x, n.y, n.z);
      if (k >= 1 || !pr.ok) { n.on = false; n.node.style.opacity = '0'; continue; }
      n.node.style.transform = `translate3d(${pr.x.toFixed(1)}px,${(pr.y - 46 * (1 - (1 - k) * (1 - k))).toFixed(1)}px,0) scale(${(1.25 - 0.25 * Math.min(1, k * 5)).toFixed(2)})`;
      n.node.style.opacity = (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4).toFixed(2);
    }

    for (const w of warns) {
      if (!w.on) continue;
      w.t -= dt;
      if (w.t <= 0) { w.on = false; w.node.style.opacity = '0'; continue; }
      const pr = project(w.x, w.y, w.z);
      let x = pr.x, y = pr.y;
      if (!pr.ok) { x = W - x; y = H - 60; } // behind the camera: pin to the bottom edge, mirrored
      x = Math.max(40, Math.min(W - 40, x)); y = Math.max(60, Math.min(H - 140, y));
      const pulse = 1 + 0.18 * Math.sin(w.t * 26);
      w.node.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${pulse.toFixed(2)})`;
      w.node.style.opacity = '1';
    }

    // damage direction arcs turn with the camera
    const cam = g?.camera;
    for (const a of arcs) {
      if (a.t <= 0) continue;
      a.t -= dt;
      if (a.t <= 0 || !cam) { a.node.style.opacity = '0'; continue; }
      const m = cam.matrixWorld.elements;
      const dx = a.x - m[12], dz = a.z - m[14];
      const right = dx * m[0] + dz * m[2];
      const fwd = -(dx * m[8] + dz * m[10]);
      const ang = Math.atan2(right, fwd); // 0 = ahead (top of screen), clockwise
      a.node.style.transform = `rotate(${ang.toFixed(3)}rad)`;
      a.node.style.opacity = Math.min(1, a.t * 1.6).toFixed(2);
    }
  }

  const api = {
    hideLoading() { if (loading) loading.classList.add('hidden'); },
    /** Title before the first start, pause menu afterwards (main.js calls this on pointer unlock). */
    showStart() { screens.onUnlock(); },
    hideStart() { screens.onLock(); },
    setPrompt(t) {
      t = t || '';
      if (t === lastPrompt || !prompt) return;
      lastPrompt = t;
      prompt.textContent = t;
      prompt.style.display = t ? 'block' : 'none';
    },
    setObjective,
    screens,
    tips,
    update({ state, speed, fps, grounded, hp, hpMax, model, level, bpm, phase, onBeat, dt = 0, boss = null }) {
      const g = game();
      if (g && !g.hud) g.hud = api;
      const now = performance.now();
      const max = hpMax || 100;
      const cur = Math.max(0, hp ?? 0);

      // health
      if (cur !== lastHp || max !== lastHpMax) {
        const pct = Math.max(0, Math.min(1, cur / max));
        const sx = `scaleX(${pct.toFixed(4)})`;
        hpFill.style.transform = sx;
        hpGhost.style.transform = sx;
        hpVal.textContent = `${Math.round(pct * 100)}%`;
        const low = pct <= 0.33;
        if (low !== lastLow) { lastLow = low; hpEl.classList.toggle('low', low); }
        lastHp = cur; lastHpMax = max;
      }
      if (hurt > 0) {
        hurt = Math.max(0, hurt - dt * 1.8);
        hurtEl.style.opacity = hurt.toFixed(3);
      }

      // timers
      if (bannerUntil && now > bannerUntil) { bannerEl.classList.add('hidden'); bannerUntil = 0; }
      if (calloutUntil && now > calloutUntil) { calloutEl.classList.add('hidden'); calloutUntil = 0; }

      // boss
      if (boss && boss.hpMax) {
        if (lastBoss < 0) bossEl.classList.remove('hidden');
        const f = Math.max(0, Math.min(1, (boss.hp ?? 0) / boss.hpMax));
        if (f !== lastBoss) { lastBoss = f; bossFill.style.transform = `scaleX(${f.toFixed(4)})`; }
        if (boss.weak) { if (!weakUntil) bossEl.classList.add('weak'); weakUntil = Math.max(weakUntil, now + 120); }
      }
      if (weakUntil && now > weakUntil) { bossEl.classList.remove('weak'); weakUntil = 0; }

      // beat reticle: a ring that closes onto the dot as the beat arrives, only while something is alive to hit
      const fight = !!g?.enemies?.some((e) => !e.dead && e.position.y > -40);
      if (fight) {
        const ph = phase ?? 0;
        const s = 2.4 - 1.4 * ph;
        retRing.style.transform = `scale(${s.toFixed(3)})`;
        retRing.style.opacity = (onBeat ? 1 : 0.12 + 0.5 * ph * ph).toFixed(2);
        ringOn = true;
      } else if (ringOn) { ringOn = false; retRing.style.opacity = '0'; }

      // chain counter
      if (comboT > 0) {
        comboT -= dt;
        if (comboT <= 0 && !externalCombo) { combo = 0; streak = 0; }
        comboBar.style.transform = `scaleX(${Math.max(0, comboT / COMBO_HOLD).toFixed(3)})`;
      }
      const shown = comboT > 0 ? combo : 0;
      if (shown !== lastComboShown) {
        lastComboShown = shown;
        comboEl.classList.toggle('on', shown >= 2);
        if (shown > 0) comboN.textContent = String(shown);
      }
      if (streak !== lastStreakShown) {
        lastStreakShown = streak;
        comboS.textContent = streak >= 2 ? String(S.streak || 'IN TIME ×{n}').replace('{n}', streak) : '';
      }

      updatePowers();
      updateWorld(dt);
      screens.update(dt, { hp: cur, level });
      tips.update(dt, { state, speed, playing: screens.mode === 'play' });

      if (debug) {
        debugEl.textContent = [
          `LEVEL  ${level || '-'}   FPS ${Math.round(fps || 0)}`,
          `STATE  ${state || '-'}`,
          `SPEED  ${(speed ?? 0).toFixed(2)} m/s  ${grounded ? 'ground' : 'air'}`,
          `MODEL  ${model || '-'}`,
          `TEMPO  ${Math.round(bpm || 0)}  ${onBeat ? '●' : '○'}  ph=${(phase ?? 0).toFixed(2)}`,
        ].join('\n');
      }
    },
    dispose() { offs.forEach((off) => off?.()); screens.dispose(); tips.dispose(); },
  };
  return api;
}
