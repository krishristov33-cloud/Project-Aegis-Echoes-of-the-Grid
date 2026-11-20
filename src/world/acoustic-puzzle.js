// C4: World Engine acoustic puzzle ("Resonance Sequencer"), driven by src/data/puzzle.json.
//
// Tuned pads sit on the chamber floor. Touch the core (centre pedestal) to begin. Each stage:
//   echo  — the core plays a phrase on the beat (pads light + sing, and the phrase stays readable as coloured
//           pips over the core); Kael answers by stepping on (or striking) the pads in the same order.
//           Wrong pad or too slow -> dissonant buzz, small damage, the phrase replays and the next pad is hinted.
//   chord — strike the listed pads so they all ring at once (each rings `sustain` beats after it is struck).
// Stepping on the beat is a bonus (a small heal and a brighter flare), not a requirement, unless the chamber
// sets "requireOnBeat": true. After the last stage: puzzleSolved, and the chamber stays solved for the session.
//
// Hook: chamber.js calls updatePuzzle({ ctx, dt, playerPos, bus, group }) every frame. This module keeps one
// puzzle per chamber group and tears it down when the group leaves the scene.
//
// puzzle.json schema (see DEFAULT_PUZZLE for a complete example):
//   { "chambers": [ { "level": "chamber", "ringRadii": [5.6], "padRadius": 1.0,
//       "pads": [ { "id": "A", "ring": 0, "angle": 0, "note": "A3" }, ... ],
//       "stages": [ { "type": "echo", "sequence": ["A", "D", "G"] }, { "type": "chord", "notes": ["A","E","G"], "sustain": 24 } ],
//       "failDamage": 4, "answerBeats": 24, "listenGapBeats": 2, "requireOnBeat": false, "perfectHeal": 3 } ] }
//
// Events (all carry level):
//   puzzleState  {level, stage, stages, phase, progress, length, type}
//                phase: waiting | listen | answer | chord | solved; progress/length = answered / needed this stage
//   puzzleNote   {level, pad, note, by:'core'|'player', ok, onBeat, index}
//   puzzleFail   {level, stage, reason:'wrongPad'|'offBeat'|'tooSlow'}
//   puzzleSolved {level}
import * as THREE from 'three';

export const DEFAULT_PUZZLE = {
  level: 'chamber',
  ringRadii: [5.6],
  padRadius: 1.0,
  pads: [
    { id: 'A', ring: 0, angle: 0, note: 'A3' },
    { id: 'C', ring: 0, angle: 60, note: 'C4' },
    { id: 'D', ring: 0, angle: 120, note: 'D4' },
    { id: 'E', ring: 0, angle: 180, note: 'E4' },
    { id: 'G', ring: 0, angle: 240, note: 'G4' },
    { id: 'H', ring: 0, angle: 300, note: 'A4' },
  ],
  stages: [
    { type: 'echo', sequence: ['A', 'D', 'G'] },
    { type: 'echo', sequence: ['C', 'A', 'E', 'D'] },
    { type: 'chord', notes: ['A', 'E', 'G'], sustain: 24 },
  ],
  failDamage: 4,
  answerBeats: 24, // max beats between two answers
  listenGapBeats: 2,
  startRadius: 1.45, // touch the core (centre) to begin
  requireOnBeat: false,
  perfectHeal: 3,
};

const NOTE = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
export function noteFreq(n) {
  const m = /^([A-G]#?)(\d)$/.exec(n);
  if (!m) return 440;
  return 440 * Math.pow(2, (NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12);
}

const PAD_COLORS = [0x3df0ff, 0xff3d8a, 0xffd166, 0x6cffb0, 0x9c6dff, 0xff8a3d];
const FAIL_COLOR = new THREE.Color(0xff2040);
const solvedLevels = new Set();

function labelTexture(text) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.font = '900 150px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = '#fff'; g.shadowBlur = 18;
  g.fillStyle = '#fff';
  g.fillText(text, 128, 138);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

class AcousticPuzzle {
  constructor({ bus, group, spec, getPlayer, getClock }) {
    this.bus = bus;
    this.group = group;
    this.spec = { ...DEFAULT_PUZZLE, ...spec };
    this.getPlayer = getPlayer;
    this.getClock = getClock;
    this.stage = 0;
    this.phase = solvedLevels.has(this.spec.level) ? 'solved' : 'waiting'; // waiting | listen | answer | chord | solved
    this.queue = []; // phrase being played by the core
    this.shown = 0; // notes of the phrase the core has played so far (pips revealed)
    this.answerIdx = 0;
    this.beatsSinceAnswer = 0;
    this.fails = 0; // on the current stage; > 0 turns on the next-pad hint
    this.failFlash = 0;
    this.time = 0;
    this.root = new THREE.Group();
    this.root.name = 'acoustic-puzzle';
    group.add(this.root);
    this.pads = this.spec.pads.map((p, i) => this._makePad(p, i));
    this._buildPips();
    this._off = bus.on('beat', () => this._onBeat());
    this._noiseOff = bus.on('noise', (e) => this._onNoise(e));
    if (this.phase === 'solved') { this.stage = this.spec.stages.length; this._flare(); }
    this._emitState();
  }

  _makePad(p, i) {
    const r = this.spec.ringRadii[p.ring] ?? 4;
    const a = (p.angle * Math.PI) / 180;
    const pos = new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
    const color = new THREE.Color(PAD_COLORS[i % PAD_COLORS.length]);
    const R = this.spec.padRadius;
    const mat = new THREE.MeshStandardMaterial({ color: 0x0a1018, emissive: color, emissiveIntensity: 0.25, roughness: 0.55, metalness: 0.2 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.06, 0.08, 40), mat);
    disc.position.copy(pos).setY(0.04);
    disc.receiveShadow = true;
    // rim + letter are unlit HDR so they read from across the room and bloom when the pad sings
    const rimMat = new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const rim = new THREE.Mesh(new THREE.RingGeometry(R * 0.9, R * 1.0, 48), rimMat);
    rim.rotation.x = -Math.PI / 2; rim.position.copy(pos).setY(0.09);
    const hintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const hint = new THREE.Mesh(new THREE.RingGeometry(R * 1.12, R * 1.2, 48), hintMat);
    hint.rotation.x = -Math.PI / 2; hint.position.copy(pos).setY(0.095);
    const labelMat = new THREE.MeshBasicMaterial({ map: labelTexture(p.label ?? p.id), color: color.clone(), transparent: true, depthWrite: false });
    const label = new THREE.Mesh(new THREE.PlaneGeometry(R * 1.1, R * 1.1), labelMat);
    label.rotation.x = -Math.PI / 2; label.rotation.z = a; // readable from the centre
    label.position.copy(pos).setY(0.1);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.55, R * 0.92, 4.5, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    beam.position.copy(pos).setY(2.3);
    for (const m of [rim, hint, label, beam]) m.renderOrder = 3;
    this.root.add(disc, rim, hint, label, beam);
    return { ...p, pos, mat, rimMat, hintMat, labelMat, beam, color, glow: 0, ringingBeats: 0, inside: false };
  }

  /** Row of pips over the core: the phrase in pad colours, filled as it is answered. */
  _buildPips() {
    const max = Math.max(1, ...this.spec.stages.map((s) => (s.sequence ?? s.notes ?? []).length));
    this.pips = [];
    this.pipRoot = new THREE.Group();
    this.pipRoot.position.set(0, 2.55, 0);
    const geom = new THREE.OctahedronGeometry(0.13, 0);
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x223040, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(geom, mat);
      this.pipRoot.add(m);
      this.pips.push({ mesh: m, mat });
    }
    this.root.add(this.pipRoot);
    // stage lights: one small bar per stage under the pips
    this.stageLights = this.spec.stages.map((_, i) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0x223040 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.05), mat);
      m.position.set((i - (this.spec.stages.length - 1) / 2) * 0.42, -0.32, 0);
      this.pipRoot.add(m);
      return mat;
    });
  }

  _needed() {
    const st = this.current;
    return st ? (st.sequence ?? st.notes ?? []) : [];
  }

  _refreshPips() {
    const need = this._needed();
    const n = need.length;
    this.pips.forEach((p, i) => {
      p.mesh.visible = i < n && this.phase !== 'waiting' && this.phase !== 'solved';
      if (!p.mesh.visible) return;
      p.mesh.position.x = (i - (n - 1) / 2) * 0.42;
      const pad = this._pad(need[i]);
      const st = this.current;
      const revealed = st.type === 'chord' || i < this.shown;
      const done = st.type === 'chord' ? pad.ringingBeats > 0 : i < this.answerIdx;
      if (!revealed) p.mat.color.setHex(0x223040);
      else p.mat.color.copy(pad.color).multiplyScalar(done ? 3.2 : 0.75);
      p.mesh.scale.setScalar(done ? 1.5 : 1);
    });
    this.stageLights.forEach((m, i) => m.color.setHex(i < this.stage ? 0x6cffb0 : i === this.stage && this.phase !== 'waiting' ? 0x3df0ff : 0x223040).multiplyScalar(i <= this.stage ? 2 : 1));
  }

  // ---------- sound ----------
  _tone(pad, { dissonant = false } = {}) {
    const audio = this.getClock()?.audio;
    if (!audio) return;
    const { ctx, sfxBus } = audio;
    const t = ctx.currentTime;
    const f = noteFreq(pad?.note ?? 'A3');
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(dissonant ? 0.18 : 0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (dissonant ? 0.5 : 1.4));
    g.connect(sfxBus);
    const partials = dissonant ? [1, 1.06, 1.414] : [1, 2, 3.01];
    partials.forEach((m, k) => {
      const o = ctx.createOscillator();
      o.type = dissonant ? 'sawtooth' : 'sine';
      o.frequency.value = f * m;
      const pg = ctx.createGain();
      pg.gain.value = [1, 0.35, 0.15][k];
      o.connect(pg).connect(g);
      o.start(t);
      o.stop(t + 1.5);
    });
  }

  _light(pad, amount = 1) {
    pad.glow = Math.max(pad.glow, amount);
  }

  _emitState() {
    const need = this._needed();
    const st = this.current;
    const progress = st?.type === 'chord' ? need.filter((id) => this._pad(id).ringingBeats > 0).length : this.answerIdx;
    this.bus.emit('puzzleState', {
      level: this.spec.level, stage: this.stage, stages: this.spec.stages.length, phase: this.phase,
      progress: this.phase === 'solved' ? 0 : progress, length: need.length, type: st?.type ?? null,
    });
    this._refreshPips();
  }

  // ---------- flow ----------
  get current() {
    return this.spec.stages[this.stage];
  }

  _startStage() {
    const st = this.current;
    if (!st) return this._solve();
    for (const p of this.pads) p.ringingBeats = 0;
    this.shown = 0;
    if (st.type === 'chord') {
      this.phase = 'chord';
      // show the chord once so the player knows which pads
      for (const id of st.notes) {
        const pad = this._pad(id);
        this._light(pad, 0.9);
        this._tone(pad);
      }
    } else {
      this.phase = 'listen';
      this.queue = [...Array(this.spec.listenGapBeats).fill(null), ...st.sequence];
    }
    this.answerIdx = 0;
    this.beatsSinceAnswer = 0;
    this._emitState();
  }

  _pad(id) {
    return this.pads.find((p) => p.id === id);
  }

  _fail(reason) {
    const pl = this.getPlayer();
    this._tone(this.pads[0], { dissonant: true });
    this.fails++;
    this.failFlash = 1;
    this.bus.emit('puzzleFail', { level: this.spec.level, stage: this.stage, reason });
    if (pl?.hp > 0 && this.spec.failDamage) pl.takeDamage?.(this.spec.failDamage, { kind: 'dissonance' });
    this._startStage(); // replay the phrase
  }

  _advance() {
    this.stage++;
    this.fails = 0;
    this._startStage();
  }

  _solve() {
    this.phase = 'solved';
    solvedLevels.add(this.spec.level);
    this._flare();
    this.bus.emit('puzzleSolved', { level: this.spec.level });
    this._emitState();
  }

  _flare() {
    for (const p of this.pads) p.glow = 1;
  }

  _onBeat() {
    if (this.phase === 'listen') {
      const id = this.queue.shift();
      if (id) {
        const pad = this._pad(id);
        this._light(pad);
        this._tone(pad);
        this.bus.emit('puzzleNote', { level: this.spec.level, pad: id, note: pad.note, by: 'core', ok: true, onBeat: true, index: this.shown });
        this.shown++;
        this._refreshPips();
      }
      if (!this.queue.length) {
        this.phase = 'answer';
        this.beatsSinceAnswer = 0;
        this._emitState();
      }
    } else if (this.phase === 'answer') {
      if (++this.beatsSinceAnswer > this.spec.answerBeats + (this.answerIdx === 0 ? 8 : 0)) this._fail('tooSlow');
    } else if (this.phase === 'chord') {
      let changed = false;
      for (const p of this.pads) {
        if (p.ringingBeats > 0 && --p.ringingBeats === 0) changed = true;
      }
      if (changed) this._emitState();
    }
  }

  _perfect(pad) {
    this._light(pad, 1.6);
    const pl = this.getPlayer();
    if (this.spec.perfectHeal && pl?.hp > 0 && pl.hp < pl.hpMax) pl.heal?.(this.spec.perfectHeal);
  }

  /** The player sounds a pad (stepping on it or striking it). */
  strike(pad) {
    if (this.phase === 'waiting' || this.phase === 'solved' || this.phase === 'listen') {
      this._light(pad, 0.6);
      this._tone(pad);
      return;
    }
    const onBeat = !!this.getClock()?.isOnBeat?.();
    const strict = !!this.spec.requireOnBeat;
    this._light(pad);
    this._tone(pad);
    if (this.phase === 'answer') {
      const want = this.current.sequence[this.answerIdx];
      const ok = pad.id === want && (onBeat || !strict);
      this.bus.emit('puzzleNote', { level: this.spec.level, pad: pad.id, note: pad.note, by: 'player', ok, onBeat, index: this.answerIdx });
      if (!ok) return this._fail(pad.id !== want ? 'wrongPad' : 'offBeat');
      if (onBeat) this._perfect(pad);
      this.answerIdx++;
      this.beatsSinceAnswer = 0;
      if (this.answerIdx >= this.current.sequence.length) this._advance();
      else this._emitState();
    } else if (this.phase === 'chord') {
      const st = this.current;
      if (!st.notes.includes(pad.id)) {
        this.bus.emit('puzzleNote', { level: this.spec.level, pad: pad.id, note: pad.note, by: 'player', ok: false, onBeat, index: 0 });
        return this._fail('wrongPad');
      }
      if (strict && !onBeat) return this._fail('offBeat');
      if (onBeat) this._perfect(pad);
      pad.ringingBeats = st.sustain ?? 24;
      const ringing = st.notes.filter((id) => this._pad(id).ringingBeats > 0).length;
      this.bus.emit('puzzleNote', { level: this.spec.level, pad: pad.id, note: pad.note, by: 'player', ok: true, onBeat, index: ringing - 1 });
      if (ringing === st.notes.length) this._advance();
      else this._emitState();
    }
  }

  _onNoise({ pos, kind } = {}) {
    // melee / blast near a pad strikes it too
    if (!pos || !(kind === 'blast' || String(kind).startsWith('melee'))) return;
    const reach = kind === 'blast' ? 3 : 1.6;
    let best = null;
    let bd = reach;
    for (const p of this.pads) {
      const d = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
      if (d < bd) [best, bd] = [p, d];
    }
    if (best && !best.inside) this.strike(best);
  }

  /** The pad the player should go to next (answer phase), or null. */
  get nextPad() {
    if (this.phase === 'answer') return this._pad(this.current.sequence[this.answerIdx]);
    return null;
  }

  update(dt, playerPos) {
    this.time += dt;
    if (playerPos && this.phase === 'waiting' && Math.hypot(playerPos.x, playerPos.z) < this.spec.startRadius) this._startStage();
    if (playerPos) {
      for (const p of this.pads) {
        const inside = Math.hypot(playerPos.x - p.pos.x, playerPos.z - p.pos.z) < this.spec.padRadius && Math.abs(playerPos.y - p.pos.y) < 0.6;
        if (inside && !p.inside) this.strike(p);
        p.inside = inside;
      }
    }
    this.failFlash = Math.max(0, this.failFlash - dt * 1.6);
    const st = this.current;
    const hintPad = this.fails > 0 ? this.nextPad : null;
    const solved = this.phase === 'solved';
    for (const p of this.pads) {
      const sustain = st?.sustain ?? 24;
      const ringing = p.ringingBeats > 0 ? 0.45 + 0.55 * (p.ringingBeats / sustain) : 0;
      const wanted = this.phase === 'chord' && st.notes.includes(p.id) ? 0.25 + 0.12 * Math.sin(this.time * 4) : 0;
      p.glow = Math.max(ringing, solved ? 0.3 + 0.12 * Math.sin(this.time * 2 + p.pos.x) : 0, p.glow - dt * 1.8);
      const g = Math.max(p.glow, wanted);
      p.mat.emissive.copy(p.color).lerp(FAIL_COLOR, this.failFlash);
      p.mat.emissiveIntensity = 0.25 + g * 1.8 + this.failFlash * 1.2;
      p.rimMat.color.copy(p.color).lerp(FAIL_COLOR, this.failFlash).multiplyScalar(1 + g * 2.5);
      p.labelMat.color.copy(p.color).multiplyScalar(1.2 + g * 2.2);
      p.beam.material.opacity = Math.min(0.45, g * 0.3);
      p.hintMat.opacity = p === hintPad ? 0.45 + 0.45 * Math.sin(this.time * 7) : 0;
    }
    // pips hover and face the player
    this.pipRoot.position.y = 2.55 + Math.sin(this.time * 1.5) * 0.05;
    if (playerPos) this.pipRoot.rotation.y = Math.atan2(playerPos.x, playerPos.z);
    for (const p of this.pips) p.mesh.rotation.y = this.time * 1.4;
    if (this.phase === 'chord') this._refreshPips();
  }

  dispose() {
    this._off?.();
    this._noiseOff?.();
    this.root.traverse((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
    this.root.removeFromParent();
  }
}

const live = new Map(); // chamber group -> puzzle

/** Find this level's puzzle in puzzle.json, falling back to DEFAULT_PUZZLE when the file has none. */
function specFor(puzzleJson, level) {
  return puzzleJson?.chambers?.find((c) => (c.level ?? 'chamber') === level) ?? (level === 'chamber' ? DEFAULT_PUZZLE : null);
}

/**
 * chamber.js hook, called every frame: updatePuzzle({ ctx, dt, playerPos, bus, group }).
 * ctx is the level context from main.js (has `puzzle`, the parsed puzzle.json).
 */
export function updatePuzzle({ ctx, dt, playerPos, bus, group } = {}) {
  if (!group || !bus) return null;
  // drop puzzles whose chamber left the scene (level unloaded)
  for (const [g, p] of live) {
    if (!g.parent) {
      p.dispose();
      live.delete(g);
    }
  }
  let p = live.get(group);
  if (!p) {
    const spec = specFor(ctx?.puzzle, group.name || 'chamber');
    if (!spec) return null;
    p = new AcousticPuzzle({
      bus,
      group,
      spec,
      getPlayer: () => globalThis.game?.player ?? null,
      getClock: () => globalThis.game?.clock ?? null,
    });
    live.set(group, p);
  }
  p.update(dt, playerPos);
  return p;
}

/** Tear down the puzzle of a chamber group right away (level unload), so no listener outlives the room. */
export function disposePuzzle(group) {
  const p = live.get(group);
  if (!p) return;
  p.dispose();
  live.delete(group);
}

/** Debug/test access to the live puzzle for a chamber group. */
export function puzzleFor(group) {
  return live.get(group) ?? null;
}

/** True once this level's puzzle has been solved this session. */
export function isSolved(level = 'chamber') {
  return solvedLevels.has(level);
}
