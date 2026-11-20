// Phase-Skip (C3): a short dash that passes through thin walls (Rapier PHASEABLE bodies: solid walls thinner than
// `maxPhaseThickness`, or userData.phaseable), Wave-Shield columns and bullets. Thick walls stop it. It never ends
// inside geometry or off a ledge: the landing needs the whole footprint on ground.
// While phasing (+ a short tail) `player.invulnerable` is true and damage is ignored (see installInvulnerability).
//
// Emits: phaseSkip {from, to, duration, onBeat, through: [ids]}   (Aether FX draws the streaks)
import * as THREE from 'three';

const DEFAULTS = { duration: 0.35, cooldown: 3.2, distance: 6, margin: 0.15, invulnerableTail: 0.12, onBeatDistance: 1.5, minDistance: 1 };
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Wrap player.takeDamage once so `player.invulnerable` is honoured (Lumen: native support in combat.takeDamage
 * makes this a no-op wrapper).
 */
export function installInvulnerability(player) {
  if (player._invulnWrapped) return;
  const orig = player.takeDamage;
  player.takeDamage = function (n, src) {
    if (this.invulnerable) return 0;
    return orig.call(this, n, src);
  };
  player._invulnWrapped = true;
}

export function createPhaseSkip({ bus, physics, player, clock, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  let cooldownLeft = 0;
  let dash = null; // { from, to, t }
  let tail = 0;
  installInvulnerability(player);

  // solid things a phase CAN'T pass: thick static walls (not phaseable, not shields / props / enemies)
  const hard = { solid: true, predicate: (b) => !b.userData?.phaseable && !['shield', 'prop', 'enemy'].includes(b.userData?.layer) };

  function destination(yaw) {
    const r = player.radius ?? 0.32;
    const h = player.height ?? 1.8;
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const onBeat = !!clock?.isOnBeat?.();
    let maxD = c.distance * (onBeat ? c.onBeatDistance : 1);
    const from = player.position.clone();
    const lifted = from.clone().setY(from.y + 0.35); // above steps / floor seams
    const hit = physics.castCapsule(lifted, dir, maxD, r * 0.9, h - 0.4, hard);
    if (hit) maxD = Math.max(0, hit.distance - c.margin);
    for (let t = maxD; t >= c.minDistance; t -= 0.25) {
      const p = from.clone().addScaledVector(dir, t);
      const g = physics.raycast(p.clone().setY(from.y + 1.2), DOWN, 2.5, { ground: true });
      if (!g || Math.abs(g.point.y - from.y) > 0.6) continue;
      p.y = g.point.y;
      let feet = 0;
      for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
        const fg = physics.raycast(new THREE.Vector3(p.x + ox, from.y + 1.2, p.z + oz), DOWN, 2.5, { ground: true });
        if (fg && Math.abs(fg.point.y - p.y) < 0.3) feet++;
      }
      if (feet < 4) continue;
      if (physics.overlapCapsule(p.clone().setY(p.y + 0.05), r, h - 0.05, { solid: true }).length) continue;
      return { to: p, dir, dist: t, onBeat };
    }
    return null;
  }

  const api = {
    get active() {
      return !!dash;
    },
    get cooldownLeft() {
      return cooldownLeft;
    },
    get ready() {
      return cooldownLeft <= 0 && !dash && player.hp > 0;
    },
    destination,

    /** @param {number} [yaw] aim yaw; defaults to the player's facing */
    trigger(yaw = player.yaw ?? 0) {
      if (!api.ready || !physics.castCapsule) return false;
      const d = destination(yaw);
      if (!d) return false;
      const from = player.position.clone();
      const chest = from.clone().setY(from.y + 1.1);
      const through = (physics.raycastAll?.(chest, d.dir, d.dist, { solid: true }) ?? [])
        .filter((hh) => hh.userData?.phaseable || hh.userData?.layer === 'shield')
        .map((hh) => hh.id);
      dash = { from, to: d.to, t: 0 };
      player.invulnerable = true;
      cooldownLeft = c.cooldown;
      bus.emit('phaseSkip', { from, to: d.to.clone(), duration: c.duration, onBeat: d.onBeat, through });
      return true;
    },

    /** Call after the controller has moved the player: the dash overrides its position. */
    update(dt) {
      cooldownLeft = Math.max(0, cooldownLeft - dt);
      if (dash) {
        dash.t += dt;
        const k = Math.min(1, dash.t / c.duration);
        const e = 1 - (1 - k) * (1 - k);
        player.position.lerpVectors(dash.from, dash.to, e);
        if (player.velocity) player.velocity.set(0, 0, 0);
        player.isGrounded = true;
        if (k >= 1) {
          dash = null;
          tail = c.invulnerableTail;
        }
      } else if (tail > 0 && (tail -= dt) <= 0) {
        player.invulnerable = false;
      }
    },

    dispose() {
      player.invulnerable = false;
    },
  };
  return api;
}

// kept for the L1 stub's callers
export function tryPhaseSkip() {
  return false;
}
