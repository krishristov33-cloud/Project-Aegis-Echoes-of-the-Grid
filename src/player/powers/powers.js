// C3 powers bundle: Phase-Skip, Wave-Shield, Resonant Launchpad on the Rapier world.
//
//   import { createPowers } from './player/powers/powers.js';
//   const powers = createPowers({ bus, physics, scene, player, clock, cfg: powersJson });
//   // tick, after pawn.update(): powers.update(dt);   input: powers.phaseSkip.trigger(orbit.yaw) etc.
//
// Input lives in src/core/input.js (R Phase-Skip, G Wave-Shield, T Launchpad).
// The temporary R/E/T handler stays off unless cfg.bindKeys === true.
import { createPhaseSkip } from './phase-skip.js';
import { createWaveShield } from './wave-shield.js';
import { createLaunchpads } from './launchpad.js';
import { decayExtrusions } from '../../world/geo-extrude.js';

export function createPowers({ bus, physics, scene, player, clock, cfg = {}, aimYaw = null }) {
  if (!physics?.castCapsule) {
    console.warn('[powers] Phase-Skip / Wave-Shield / Launchpad need the Rapier world (src/physics/rapier-world.js)');
  }
  const phaseSkip = createPhaseSkip({ bus, physics, player, clock, cfg: cfg.phaseSkip });
  const waveShield = createWaveShield({ bus, physics, scene, player, clock, cfg: cfg.waveShield });
  const launchpad = createLaunchpads({ bus, physics, scene, player, clock, cfg: cfg.launchpad });
  const yaw = () => aimYaw?.() ?? player.yaw ?? 0;

  let offKeys = null;
  if (cfg.bindKeys === true && typeof addEventListener === 'function') {
    const onKey = (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyR') phaseSkip.trigger(yaw());
      else if (e.code === 'KeyG') waveShield.trigger(yaw());
      else if (e.code === 'KeyT') launchpad.place(yaw());
    };
    addEventListener('keydown', onKey);
    offKeys = () => removeEventListener('keydown', onKey);
  }

  return {
    phaseSkip,
    waveShield,
    launchpad,
    update(dt) {
      decayExtrusions(dt);
      waveShield.update(dt);
      launchpad.update(dt);
      phaseSkip.update(dt);
      physics.step?.(dt);
    },
    dispose() {
      offKeys?.();
      phaseSkip.dispose();
      waveShield.dispose();
      launchpad.dispose();
    },
  };
}
