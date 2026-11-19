// C4: World Engine acoustic puzzle ("Resonance Sequencer"), driven by Krea's src/data/puzzle.json.
//
// Tuned pads sit on the chamber rings. Each stage:
//   echo  — the core plays a phrase on the beat (pads light + sing); Kael answers by stepping on (or striking) the pads
//           in the same order, each ON THE BEAT. Wrong pad / off-beat / too slow -> dissonant buzz, small damage, replay.
//   chord — strike the listed pads so they all ring at once (each rings `sustain` beats after it is struck).
// Touch the core (centre pedestal) to begin. After the last stage: puzzleSolved, the rings flare, and the chamber stays solved for the session.
//
// Hook: chamber.js already calls updatePuzzle({ ctx, dt, playerPos, bus, group }) every frame. This module keeps one
// puzzle per chamber group and tears it down when the group leaves the scene.
//
// puzzle.json schema (see DEFAULT_PUZZLE for a complete example):
//   { "chambers": [ { "level": "chamber", "ringRadii": [3.2, 5.6, 8.0], "padRadius": 0.9,
//       "pads": [ { "id": "A", "ring": 0, "angle": 0, "note": "A3" }, ... ],
//       "stages": [ { "type": "echo", "sequence": ["A", "C", "E"] }, { "type": "chord", "notes": ["A","C","E"], "sustain": 4 } ],
//       "failDamage": 5, "answerBeats": 3, "listenGapBeats": 2 } ] }
// Events: puzzleState {level, stage, phase}, puzzleNote {pad, note, by:'core'|'player', ok}, puzzleFail {reason},
//         puzzleSolved {level}
import * as THREE from 'three';

export const DEFAULT_PUZZLE = {
  level: 'chamber',
  ringRadii: [3.2, 5.6, 8.0],
  padRadius: 0.9,
  pads: [
    { id: 'A', ring: 0, angle: 0, note: 'A3' },
    { id: 'C', ring: 0, angle: 120, note: 'C4' },
    { id: 'E', ring: 0, angle: 240, note: 'E4' },
    { id: 'G', ring: 1, angle: 60, note: 'G4' },
    { id: 'D', ring: 1, angle: 150, note: 'D4' },
    { id: 'B', ring: 1, angle: 270, note: 'B3' },
  ],
  stages: [
    { type: 'echo', sequence: ['A', 'C', 'E'] },
    { type: 'echo', sequence: ['A', 'G', 'D', 'C'] },
    { type: 'chord', notes: ['A', 'C', 'E'], sustain: 6 },
  ],
  failDamage: 5,
  answerBeats: 4, // max beats between two answers
  listenGapBeats: 2,
  startRadius: 1.3, // touch the core (centre) to begin
};

const NOTE = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
export function noteFreq(n) {
  const m = /^([A-G]#?)(\d)$/.exec(n);
  if (!m) return 440;
  return 440 * Math.pow(2, (NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12);
}

const PAD_COLORS = [0x3df0ff, 0xff3d8a, 0x9cffff, 0xffd166, 0x9c4dff, 0x6cffb0];
const solvedLevels = new Set();

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
    this.answerIdx = 0;
    this.beatsSinceAnswer = 0;
    this.root = new THREE.Group();
    this.root.name = 'acoustic-puzzle';
    group.add(this.root);
    this.pads = this.spec.pads.map((p, i) => this._makePad(p, i));
    this._off = bus.on('beat', () => this._onBeat());
    this._noiseOff = bus.on('noise', (e) => this._onNoise(e));
    this._emitState();
    if (this.phase === 'solved') this._flare(true);
  }

  _makePad(p, i) {
    const r = this.spec.ringRadii[p.ring] ?? 4;
    const a = (p.angle * Math.PI) / 180;
    const pos = new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
    const color = PAD_COLORS[i % PAD_COLORS.length];
    const mat = new THREE.MeshStandardMaterial({ color: 0x0a1018, emissive: color, emissiveIntensity: 0.15, roughness: 0.25, metalness: 0.5 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(this.spec.padRadius, this.spec.padRadius * 1.05, 0.1, 32), mat);
    disc.position.copy(pos).setY(0.05);
    disc.receiveShadow = true;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(this.spec.padRadius * 0.6, this.spec.padRadius * 0.9, 3, 24, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    beam.position.copy(pos).setY(1.55);
    this.root.add(disc, beam);
    return { ...p, pos, mat, beam, glow: 0, ringingBeats: 0, inside: false, color };
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
    this.bus.emit('puzzleState', { level: this.spec.level, stage: this.stage, phase: this.phase });
  }

  // ---------- flow ----------
  get current() {
    return this.spec.stages[this.stage];
  }

  _startStage() {
    const st = this.current;
    if (!st) return this._solve();
    if (st.type === 'chord') {
      this.phase = 'chord';
      // show the chord once so the player knows which pads
      for (const id of st.notes) {
        const pad = this._pad(id);
        this._light(pad, 0.8);
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
    for (const p of this.pads) p.ringingBeats = 0;
    this.bus.emit('puzzleFail', { level: this.spec.level, stage: this.stage, reason });
    if (pl?.hp > 0 && this.spec.failDamage) pl.takeDamage?.(this.spec.failDamage, { kind: 'dissonance' });
    this._startStage(); // replay the phrase
  }

  _solve() {
    this.phase = 'solved';
    solvedLevels.add(this.spec.level);
    this._flare(true);
    this.bus.emit('puzzleSolved', { level: this.spec.level });
    this._emitState();
  }

  _flare(on) {
    this.group.traverse((o) => {
      if (o.isMesh && o.geometry?.type === 'TorusGeometry' && o.material?.emissive) o.material.emissiveIntensity = on ? 2.2 : o.material.emissiveIntensity;
    });
    for (const p of this.pads) p.glow = on ? 1 : p.glow;
  }

  _onBeat() {
    if (this.phase === 'listen') {
      const id = this.queue.shift();
      if (id) {
        const pad = this._pad(id);
        this._light(pad);
        this._tone(pad);
        this.bus.emit('puzzleNote', { level: this.spec.level, pad: id, note: pad.note, by: 'core' });
      }
      if (!this.queue.length) {
        this.phase = 'answer';
        this.beatsSinceAnswer = 0;
        this._emitState();
      }
    } else if (this.phase === 'answer') {
      if (++this.beatsSinceAnswer > this.spec.answerBeats + (this.answerIdx === 0 ? 4 : 0)) this._fail('tooSlow');
    } else if (this.phase === 'chord') {
      for (const p of this.pads) p.ringingBeats = Math.max(0, p.ringingBeats - 1);
    }
  }

  /** The player sounds a pad (stepping on it or striking it). */
  strike(pad) {
    if (this.phase === 'waiting' || this.phase === 'solved' || this.phase === 'listen') {
      this._light(pad, 0.6);
      this._tone(pad);
      return;
    }
    const onBeat = !!this.getClock()?.isOnBeat?.();
    this._light(pad);
    this._tone(pad);
    if (this.phase === 'answer') {
      const want = this.current.sequence[this.answerIdx];
      const ok = pad.id === want && onBeat;
      this.bus.emit('puzzleNote', { level: this.spec.level, pad: pad.id, note: pad.note, by: 'player', ok, onBeat });
      if (!ok) return this._fail(pad.id !== want ? 'wrongPad' : 'offBeat');
      this.answerIdx++;
      this.beatsSinceAnswer = 0;
      if (this.answerIdx >= this.current.sequence.length) {
        this.stage++;
        this._startStage();
      }
    } else if (this.phase === 'chord') {
      const st = this.current;
      if (!st.notes.includes(pad.id)) return this._fail('wrongPad');
      if (!onBeat) return this._fail('offBeat');
      pad.ringingBeats = st.sustain ?? 4;
      this.bus.emit('puzzleNote', { level: this.spec.level, pad: pad.id, note: pad.note, by: 'player', ok: true, onBeat });
      if (st.notes.every((id) => this._pad(id).ringingBeats > 0)) {
        this.stage++;
        this._startStage();
      }
    }
  }

  _onNoise({ pos, kind } = {}) {
    // melee / blast near a pad strikes it too
    if (!pos || !(kind === 'blast' || String(kind).startsWith('melee'))) return;
    const reach = kind === 'blast' ? 4 : 2.2;
    let best = null;
    let bd = reach;
    for (const p of this.pads) {
      const d = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
      if (d < bd) [best, bd] = [p, d];
    }
    if (best) this.strike(best);
  }

  update(dt, playerPos) {
    if (playerPos && this.phase === 'waiting' && Math.hypot(playerPos.x, playerPos.z) < this.spec.startRadius) this._startStage();
    if (playerPos) {
      for (const p of this.pads) {
        const inside = Math.hypot(playerPos.x - p.pos.x, playerPos.z - p.pos.z) < this.spec.padRadius && Math.abs(playerPos.y - p.pos.y) < 0.6;
        if (inside && !p.inside) this.strike(p);
        p.inside = inside;
      }
    }
    for (const p of this.pads) {
      const ringing = p.ringingBeats > 0 ? 0.6 : 0;
      p.glow = Math.max(ringing, p.glow - dt * 1.8);
      p.mat.emissiveIntensity = 0.15 + p.glow * 1.6;
      p.beam.material.opacity = p.glow * 0.35;
    }
  }

  dispose() {
    this._off?.();
    this._noiseOff?.();
    this.root.removeFromParent();
  }
}

const live = new Map(); // chamber group -> puzzle

/** Find this level's puzzle in puzzle.json, falling back to DEFAULT_PUZZLE while Krea's file has none. */
function specFor(puzzleJson, level) {
  return puzzleJson?.chambers?.find((c) => (c.level ?? 'chamber') === level) ?? (level === 'chamber' ? DEFAULT_PUZZLE : null);
}

/**
 * chamber.js hook, called every frame: updatePuzzle({ ctx, dt, playerPos, bus, group }).
 * ctx is the level context from main.js (has `puzzle`, the parsed puzzle.json).
 */
export function updatePuzzle({ ctx, dt, playerPos, bus, group } = {}) {
  if (!group || !bus) return;
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
    if (!spec) return;
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
}

/** Debug/test access to the live puzzle for a chamber group. */
export function puzzleFor(group) {
  return live.get(group) ?? null;
}
