// Wave-Shield (C3): the floor ahead of Kael extrudes into a wall of columns (world/geo-extrude.js). The columns are
// solid Rapier bodies, so they block movement, AI line of sight and enemy fire automatically, and you can stand on
// them. On the beat: wider and lasts longer.
//
// Emits: waveShield {origin, dir, duration, onBeat}  (Aether FX draws its grid on top)
//        noise {pos, radius, kind: 'shield'}
import * as THREE from 'three';
import { extrudeTiles } from '../../world/geo-extrude.js';

const DEFAULTS = { height: 1.8, duration: 4, cooldown: 8, distance: 2.2, width: 6, columns: 11, depth: 0.7, onBeatWidth: 1.5, onBeatHold: 1.5, noiseRadius: 14 };

export function createWaveShield({ bus, physics, scene, player, clock, cfg = {}, material = null }) {
  const c = { ...DEFAULTS, ...cfg };
  let cooldownLeft = 0;
  const active = [];

  const api = {
    get cooldownLeft() {
      return cooldownLeft;
    },
    get ready() {
      return cooldownLeft <= 0;
    },
    get active() {
      return active;
    },

    /** Raise a wall `distance` ahead along `yaw`. @returns the Extrusion or null */
    trigger(yaw = player.yaw ?? 0) {
      if (!api.ready) return null;
      const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const onBeat = !!clock?.isOnBeat?.();
      const origin = player.position.clone().addScaledVector(dir, c.distance);
      const widthMul = onBeat ? c.onBeatWidth : 1;
      const holdTime = c.duration * (onBeat ? c.onBeatHold : 1);
      const ex = extrudeTiles({
        physics,
        scene,
        origin,
        facing: dir,
        width: c.width * widthMul,
        columns: Math.round(c.columns * widthMul),
        height: c.height,
        depth: c.depth,
        holdTime,
        material,
      });
      if (!ex) return null;
      active.push(ex);
      cooldownLeft = c.cooldown;
      bus.emit('waveShield', { origin: origin.clone(), dir, duration: holdTime, onBeat });
      bus.emit('noise', { pos: origin.clone(), radius: c.noiseRadius, kind: 'shield' });
      return ex;
    },

    update(dt) {
      cooldownLeft = Math.max(0, cooldownLeft - dt);
      // the columns themselves are advanced by geo-extrude's decayExtrusions(dt) (once per frame, in powers.js)
      for (let i = active.length - 1; i >= 0; i--) if (active[i].done) active.splice(i, 1);
    },

    dispose() {
      active.forEach((e) => e.dispose());
      active.length = 0;
    },
  };
  return api;
}
