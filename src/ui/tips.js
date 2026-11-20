// First-time onboarding. One tip at a time, in order; each waits until it is relevant, stays until the player does
// the thing (or a timeout), then never shows again (remembered in localStorage). Text: strings.tips, with {Key}
// placeholders rendered as key caps.
const STORE = 'aegis.tips.v1';

export function createTips({ root, strings, bus, enabled = true }) {
  const T = strings.tips || {};
  const game = () => globalThis.game;
  const did = {}; // actions the player has performed this session
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { seen = {}; }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(seen)); } catch { /* private mode */ } };

  const enemyNear = (r) => {
    const g = game();
    const p = g?.player?.position;
    return !!p && !!g.enemies?.some((e) => !e.dead && e.position.y > -40 && e.position.distanceTo(p) < r);
  };
  const cd = (id) => game()?.cooldowns?.()[id]?.left ?? 0;

  // order matters; `when` gates relevance, `done` is the action flag in `did`
  const TIPS = [
    { id: 'move', when: () => true },
    { id: 'sprint', when: () => true },
    { id: 'jump', when: () => true },
    { id: 'melee', when: () => enemyNear(14) },
    { id: 'onBeat', when: () => did.melee && enemyNear(16) },
    { id: 'blast', when: () => enemyNear(10) && cd('blast') <= 0 },
    { id: 'blink', when: () => did.hurt && cd('blink') <= 0 },
    { id: 'phaseSkip', when: () => did.shotAt && cd('phaseSkip') <= 0 },
    { id: 'waveShield', when: () => did.shotAt && cd('waveShield') <= 0 },
    { id: 'launchpad', when: () => !enemyNear(18) },
  ].filter((t) => T[t.id]);

  let cur = null; // { tip, t, doneT }
  let gap = 1.5;
  let moveT = 0;

  const offs = [];
  const on = (name, fn) => bus && offs.push(bus.on(name, fn));
  on('enemyHit', (p = {}) => {
    if (p.src !== 'player' && p.src?.source !== 'player') return;
    if (p.src?.kind === 'blast') did.blast = true; else did.melee = true;
    if (p.src?.onBeat) did.onBeat = true;
  });
  on('sidechain', (p = {}) => { if (p.source === 'blast') did.blast = true; });
  on('playerDamaged', () => { did.hurt = true; });
  on('enemyShot', () => { did.shotAt = true; });
  on('blink', () => { did.blink = true; });
  on('phaseSkip', () => { did.phaseSkip = true; });
  on('waveShield', () => { did.waveShield = true; });
  on('launchpad', () => { did.launchpad = true; });

  function render(text) {
    root.replaceChildren();
    for (const part of String(text).split(/(\{[^}]+\})/)) {
      if (!part) continue;
      if (part[0] === '{') {
        const k = document.createElement('kbd');
        k.textContent = part.slice(1, -1);
        root.appendChild(k);
      } else root.appendChild(document.createTextNode(part));
    }
  }

  function show(tip) {
    cur = { tip, t: 0, doneT: 0 };
    render(T[tip.id]);
    root.classList.remove('done', 'off');
    game()?.sfx?.play?.('tip');
  }

  function hide() {
    root.classList.add('off');
    cur = null;
    gap = 1.2;
  }

  return {
    get current() { return cur?.tip.id ?? null; },
    /** Forget what was learned (debug). */
    reset() { seen = {}; save(); },
    update(dt, { state, speed, playing }) {
      if (!enabled || !playing) return;
      // movement flags from the player state
      if ((speed ?? 0) > 1) { moveT += dt; if (moveT > 1.2) did.move = true; }
      if (state === 'sprint' || (speed ?? 0) > 6.5) did.sprint = true;
      if (state === 'jump' || state === 'vault') did.jump = true;
      if (state && state.startsWith('melee')) did.melee = true;

      if (cur) {
        cur.t += dt;
        if (cur.doneT > 0) {
          cur.doneT -= dt;
          if (cur.doneT <= 0) hide();
        } else if (did[cur.tip.id]) {
          seen[cur.tip.id] = 1; save();
          root.classList.add('done');
          cur.doneT = 0.8;
        } else if (cur.t > 16) {
          seen[cur.tip.id] = 1; save(); // shown long enough: do not nag again
          hide();
        }
        return;
      }
      gap -= dt;
      if (gap > 0) return;
      for (const tip of TIPS) {
        if (seen[tip.id]) continue;
        if (did[tip.id]) { seen[tip.id] = 1; save(); continue; } // already knows it
        if (tip.when()) show(tip);
        break; // strictly in order: wait for this one to become relevant
      }
    },
    dispose() { offs.forEach((o) => o?.()); },
  };
}
