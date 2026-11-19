// Frame-Drop Blink (C7): Kael skips forward like a dropped video frame and leaves a ghost frame of himself behind.
// Enemies that were watching keep shooting the ghost (C1 perception reacts to `blink`); everyone else just lost him.
//
//   const blink = createBlink({ bus, player: game.player, physics: game.physics, scene, clock, cfg: powers.blink, time: game.time });
//   blink.trigger();      // from input (Lumen: wantsBlink() -> blink.trigger(orbit.yaw))
//   blink.update(dt);     // every frame
//
// Destination: up to `distance` along the aim, stopped short of solid geometry (knee/chest/head rays), landing on
// ground within `maxRise` up / `maxDrop` down, never inside a collider. On beat: ghost lasts x1.5, cooldown halves.
// Emits: blink {from, to, ghostId, life, onBeat}; noise {pos: to, radius, kind:'blink'} (a quiet pop on arrival).
import * as THREE from 'three';
import { createBlinkFx } from '../../fx/blink.js';

const DEFAULTS = {
  distance: 15,
  cooldown: 2.8,
  ghostLife: 2.5,
  maxRise: 1.2,
  maxDrop: 6,
  minDistance: 1.5,
  freeze: 0.06, // seconds of "dropped frame" hitch (time scale ~0) when the blink fires
  noiseRadius: 4,
  onBeatLife: 1.5,
  onBeatCooldown: 0.5,
  bindKey: 'KeyQ', // temporary until input.js has wantsBlink(); set null to disable
};

let nextGhost = 1;
const DOWN = new THREE.Vector3(0, -1, 0);

export function createBlink({ bus, player, physics, scene, clock, cfg = {}, time = null }) {
  const c = { ...DEFAULTS, ...cfg };
  const fx = createBlinkFx({ scene, bus });
  let cooldownLeft = 0;
  let freezeLeft = 0;
  let prevScale = null;

  /** Where would a blink along `yaw` land? null if nowhere valid. */
  function destination(yaw) {
    const r = player.radius ?? 0.32;
    const h = player.height ?? 1.8;
    const from = player.position.clone();
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    let maxD = c.distance;
    for (const hy of [0.45, 1.0, h - 0.15]) {
      const o = from.clone().setY(from.y + hy);
      const hit = physics.raycast(o, dir, c.distance + r, { solid: true });
      if (hit) maxD = Math.min(maxD, hit.distance - r - 0.05);
    }
    for (let t = maxD; t >= c.minDistance; t -= 0.4) {
      const p = from.clone().addScaledVector(dir, t);
      const top = p.clone().setY(from.y + c.maxRise + 0.2);
      const g = physics.raycast(top, DOWN, c.maxRise + c.maxDrop + 0.2, { ground: true });
      if (!g) continue;
      p.y = g.point.y;
      // the whole footprint must stand on that ground (no landing half off a ledge)
      let feet = 0;
      for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
        const fg = physics.raycast(top.clone().set(p.x + ox, top.y, p.z + oz), DOWN, c.maxRise + c.maxDrop + 0.2, { ground: true });
        if (fg && Math.abs(fg.point.y - p.y) < 0.3) feet++;
      }
      if (feet < 4) continue;
      if (physics.overlapCapsule(p.clone().setY(p.y + 0.05), r, h - 0.05, { solid: true }).length) continue;
      return p;
    }
    return null;
  }

  const api = {
    get cooldownLeft() {
      return cooldownLeft;
    },
    get ready() {
      return cooldownLeft <= 0 && player.hp > 0;
    },
    fx,
    destination,

    /** @param {number} [yaw] aim yaw (camera); defaults to the player's facing. */
    trigger(yaw = player.yaw ?? 0) {
      if (!api.ready) return false;
      const to = destination(yaw);
      if (!to) return false;
      const from = player.position.clone();
      const onBeat = !!clock?.isOnBeat?.();
      const life = c.ghostLife * (onBeat ? c.onBeatLife : 1);
      const ghostId = `ghost-${nextGhost++}`;
      if (player.object) fx.spawnGhost(player.object, { id: ghostId, life });

      player.position.copy(to);
      if (player.velocity) player.velocity.y = 0;
      player.isGrounded = true;
      player.yaw = yaw;

      cooldownLeft = c.cooldown * (onBeat ? c.onBeatCooldown : 1);
      bus.emit('blink', { from, to: to.clone(), ghostId, life, onBeat });
      bus.emit('noise', { pos: to.clone(), radius: c.noiseRadius, kind: 'blink' });

      // the "dropped frame": a tiny hitch of the whole sim
      if (time && c.freeze > 0) {
        if (prevScale === null) prevScale = time.scale ?? 1;
        time.scale = 0.02;
        freezeLeft = c.freeze;
      }
      return true;
    },

    /** @param {number} dt  frame dt; uses real time for the hitch so it ends even while the sim is frozen */
    update(dt) {
      cooldownLeft = Math.max(0, cooldownLeft - dt);
      fx.update(dt);
    },

    dispose() {
      offKey?.();
      fx.dispose();
      clearInterval(freezeTimer);
    },
  };

  // un-freeze on wall-clock time (dt is ~0 while the sim is frozen)
  const freezeTimer = setInterval(() => {
    if (freezeLeft <= 0) return;
    freezeLeft -= 0.016;
    if (freezeLeft <= 0 && time && prevScale !== null) {
      time.scale = prevScale;
      prevScale = null;
    }
  }, 16);

  // temporary key binding (Lumen: replace with wantsBlink() in core/input.js)
  let offKey = null;
  if (c.bindKey && typeof addEventListener === 'function') {
    const onKey = (e) => {
      if (e.code === c.bindKey && !e.repeat) api.trigger(api.aimYaw?.() ?? player.yaw);
    };
    addEventListener('keydown', onKey);
    offKey = () => removeEventListener('keydown', onKey);
  }
  /** Optional: set to () => orbit.yaw so the key binding blinks where the camera looks. */
  api.aimYaw = null;
  return api;
}
