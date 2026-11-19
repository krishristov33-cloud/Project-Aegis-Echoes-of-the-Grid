// Resonant Launchpad (C3): Kael drops a resonating pad on the floor ahead; stepping on it fires him upward
// (on the beat: x1.5). Dynamic props on the pad get thrown too. Pads expire; at most `maxPads` at once.
// Uses only the Player API (position, isGrounded, applyImpulse) and physics.raycast / applyImpulse.
//
// Emits: launchpad {origin, duration}           when placed  (Aether FX)
//        launchpad {origin, burst: true, onBeat} on every launch (Aether FX)
//        noise {pos, radius, kind: 'launch'}
import * as THREE from 'three';

const DEFAULTS = { impulse: 14, duration: 6, radius: 1.1, placeDistance: 2.5, cooldown: 3, maxPads: 2, rearm: 0.6, onBeatMult: 1.5, propImpulse: 140, noiseRadius: 12 };
const DOWN = new THREE.Vector3(0, -1, 0);
let nextId = 1;

export function createLaunchpads({ bus, physics, scene, player, clock, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  let pads = [];
  let cooldownLeft = 0;
  let t = 0;

  function remove(pad) {
    pad.mesh.removeFromParent();
    pads = pads.filter((p) => p !== pad);
  }

  const api = {
    get ready() {
      return cooldownLeft <= 0;
    },
    get pads() {
      return pads;
    },

    /** Drop a pad `placeDistance` ahead along `yaw`. @returns pad id or null */
    place(yaw = player.yaw ?? 0) {
      if (!api.ready) return null;
      const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const p = player.position.clone().addScaledVector(dir, c.placeDistance);
      const g = physics.raycast(p.clone().setY(player.position.y + 1.5), DOWN, 6, { ground: true });
      if (!g) return null;
      p.y = g.point.y;
      while (pads.length >= c.maxPads) remove(pads[0]);
      const grp = new THREE.Group();
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(c.radius, c.radius * 1.08, 0.08, 32),
        new THREE.MeshStandardMaterial({ color: 0x0b1220, emissive: 0xff3d8a, emissiveIntensity: 0.6, roughness: 0.3 }),
      );
      disc.position.y = 0.04;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(c.radius * 0.8, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color: 0x3df0ff }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.1;
      grp.add(disc, ring);
      grp.position.copy(p);
      scene.add(grp);
      const pad = { id: `pad-${nextId++}`, pos: p, until: t + c.duration, rearm: 0, mesh: grp, ring, disc };
      pads.push(pad);
      cooldownLeft = c.cooldown;
      bus.emit('launchpad', { origin: p.clone(), duration: c.duration });
      return pad.id;
    },

    update(dt) {
      t += dt;
      cooldownLeft = Math.max(0, cooldownLeft - dt);
      for (const pad of [...pads]) {
        if (t >= pad.until) {
          remove(pad);
          continue;
        }
        pad.rearm -= dt;
        const ph = clock?.getPhase?.();
        const pulse = ph === undefined ? 0.5 + 0.5 * Math.sin(t * 6) : 1 - ph;
        pad.ring.scale.setScalar(1 + pulse * 0.15);
        pad.disc.material.emissiveIntensity = 0.4 + pulse * 0.8;
        if (pad.rearm > 0) continue;
        const dx = player.position.x - pad.pos.x;
        const dz = player.position.z - pad.pos.z;
        if (Math.hypot(dx, dz) > c.radius || Math.abs(player.position.y - pad.pos.y) > 0.35 || !player.isGrounded) continue;
        const onBeat = !!clock?.isOnBeat?.();
        const speed = c.impulse * (onBeat ? c.onBeatMult : 1);
        player.applyImpulse(new THREE.Vector3(0, speed - Math.min(0, player.velocity?.y ?? 0), 0));
        pad.rearm = c.rearm;
        bus.emit('launchpad', { origin: pad.pos.clone(), burst: true, onBeat });
        bus.emit('noise', { pos: pad.pos.clone(), radius: c.noiseRadius, kind: 'launch' });
        // props on the pad fly too
        for (const b of physics.bodies?.values?.() ?? []) {
          if (!b.dynamic) continue;
          if (Math.hypot(b.center.x - pad.pos.x, b.center.z - pad.pos.z) < c.radius + 0.4 && b.center.y - pad.pos.y < 1.5) {
            physics.applyImpulse?.(b.id, { x: 0, y: c.propImpulse * (onBeat ? c.onBeatMult : 1), z: 0 });
          }
        }
      }
    },

    dispose() {
      for (const p of [...pads]) remove(p);
    },
  };
  return api;
}
