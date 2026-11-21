// Mix-as-health (C6): the mix is the health bar. Damage drives, bit-crushes and muffles the master; healing sweeps it
// clean. Each hit adds a short crunch spike, and below `heartbeatBelow` health the master dips on every beat.
//
// Chain inserted between the master bus and the speakers (only once Web Audio has started):
//   master -> pre (drive amount) -> drive (tanh shaper) -> lowpass -> crush (staircase shaper, after the filter so its
//   grit stays audible) -> post -> destination
// At full health every stage is transparent.
//
// Listens: playerDamaged / playerHealed {amount, hp, hpMax}, beat. Exposes `level` (0 clean .. 1 wrecked) for the HUD.
import { whenAudioReady } from './audio-graph.js';

const DEFAULTS = {
  maxDrive: 18, // tanh gain at 0 hp
  minBits: 4, // bit depth at 0 hp (crush starts below `crushBelow` health)
  crushBelow: 0.5,
  minCutoff: 1400, // Hz at 0 hp
  hitSpike: 2.5, // extra drive per (damage / hpMax), decays over `spikeTime`
  spikeTime: 0.35,
  healSweep: 0.8, // seconds to glide clean after a heal
  heartbeatBelow: 0.3,
  heartbeatDip: 0.22,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function driveCurve(k, n = 2048) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = k < 1.01 ? x : Math.tanh(k * x) / norm;
  }
  return c;
}

function crushCurve(bits, n = 4096) {
  const c = new Float32Array(n);
  const steps = Math.pow(2, bits - 1);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = bits >= 15.5 ? x : Math.round(x * steps) / steps;
  }
  return c;
}

export function createMixHealth(bus, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }; // tuning.audio.mixHealth is merged in when audio attaches
  let health = 1; // hp / hpMax
  let graph = null;
  let nodes = null;
  let lastDriveKey = -1;
  let lastCrushKey = -1;
  let driveK = 1;

  const api = {
    /** 0 = clean (full health) .. 1 = wrecked (dead). */
    get level() {
      return 1 - health;
    },
    get health() {
      return health;
    },
    get attached() {
      return !!nodes;
    },
    nodes: null,
  };

  function attach(g) {
    Object.assign(cfg, globalThis.game?.tuning?.audio?.mixHealth ?? {}, opts);
    graph = g;
    const { ctx, master } = g;
    const pre = ctx.createGain();
    const drive = ctx.createWaveShaper();
    drive.oversample = '2x';
    const crush = ctx.createWaveShaper();
    crush.oversample = 'none';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;
    lp.Q.value = 0.9;
    const post = ctx.createGain();
    master.disconnect();
    master.connect(pre).connect(drive).connect(lp).connect(crush).connect(post).connect(ctx.destination);
    nodes = { pre, drive, crush, lp, post };
    api.nodes = nodes;
    apply(0.05);
  }

  /** Push the current health into the chain; `glide` = seconds for parameter moves. */
  function apply(glide) {
    if (!nodes) return;
    const d = 1 - health; // damage 0..1
    const t = graph.ctx.currentTime;
    // drive: curve shape changes only in 5% steps (regenerating curves is not free)
    const dk = Math.round(d * 20);
    if (dk !== lastDriveKey) {
      lastDriveKey = dk;
      driveK = 1 + (cfg.maxDrive - 1) * Math.pow(dk / 20, 1.6);
      nodes.drive.curve = driveCurve(driveK);
    }
    const crushAmt = clamp01((cfg.crushBelow - health) / cfg.crushBelow);
    const ck = Math.round(crushAmt * 12);
    if (ck !== lastCrushKey) {
      lastCrushKey = ck;
      nodes.crush.curve = crushCurve(16 - (16 - cfg.minBits) * (ck / 12));
    }
    const cutoff = 20000 * Math.pow(cfg.minCutoff / 20000, Math.pow(d, 1.3));
    nodes.lp.frequency.cancelScheduledValues(t);
    nodes.lp.frequency.setTargetAtTime(cutoff, t, Math.max(0.01, glide / 3));
    // Loudness-neutral: undo the gain the saturator adds at a typical programme level, so damage changes the
    // character of the mix (grit, muffle) without ever turning it up.
    const ref = cfg.loudnessRef ?? 0.25;
    const makeup = driveK < 1.01 ? 1 : (ref * Math.tanh(driveK)) / Math.tanh(ref * driveK);
    nodes.post.gain.cancelScheduledValues(t);
    nodes.post.gain.setTargetAtTime(makeup, t, Math.max(0.01, glide / 3));
  }

  function spike(amount) {
    if (!nodes) return;
    const t = graph.ctx.currentTime;
    const extra = 1 + cfg.hitSpike * amount;
    nodes.pre.gain.cancelScheduledValues(t);
    nodes.pre.gain.setValueAtTime(extra, t);
    nodes.pre.gain.setTargetAtTime(1, t + 0.02, cfg.spikeTime / 3);
  }

  const offs = [
    bus.on('playerDamaged', (e = {}) => {
      if (e.hpMax > 0 && Number.isFinite(e.hp)) health = clamp01(e.hp / e.hpMax);
      apply(0.06);
      spike((e.amount ?? 0) / (e.hpMax || 100));
    }),
    bus.on('playerHealed', (e = {}) => {
      if (e.hpMax > 0 && Number.isFinite(e.hp)) health = clamp01(e.hp / e.hpMax);
      apply(cfg.healSweep);
    }),
    bus.on('beat', () => {
      // low health: the whole mix ducks on every beat like a heartbeat
      if (!nodes || health > cfg.heartbeatBelow || health <= 0) return;
      const t = graph.ctx.currentTime;
      const depth = cfg.heartbeatDip * (1 - health / cfg.heartbeatBelow);
      const g = nodes.post.gain;
      const base = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(base, t);
      g.linearRampToValueAtTime(base * (1 - depth), t + 0.03);
      g.setTargetAtTime(1 - 0.25 * (1 - health), t + 0.05, 0.08);
    }),
    whenAudioReady(bus, attach),
  ];

  api.dispose = () => {
    offs.forEach((o) => o?.());
    if (nodes && graph) {
      graph.master.disconnect();
      graph.master.connect(graph.ctx.destination);
      Object.values(nodes).forEach((n) => n.disconnect());
      nodes = null;
    }
  };
  return api;
}
