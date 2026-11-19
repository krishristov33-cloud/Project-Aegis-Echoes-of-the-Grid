// Aether animation tuning — source of truth for locomotion blend, lean, foot IK
// and jump/land poses. Gameplay speeds still live in src/data/tuning.json;
// keep clipSpeeds in sync with player.walk/jog/run/sprintSpeed.
//
// critDamp omega (rad/s) ≈ 2 / smoothTime. Higher = snappier.

/**
 * Critically-damped spring (stable implicit form).
 * `s` is `{ p, v }` (value, velocity) and is mutated in place.
 */
export function critDamp(s, target, omega, dt) {
  const w = Math.max(0, omega);
  const x = w * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.p - target;
  const temp = (s.v + w * change) * dt;
  s.v = (s.v - w * temp) * exp;
  s.p = target + (change + temp) * exp;
  return s.p;
}

/** Like critDamp, but shortest-arc on a wrapped angle in radians. */
export function critDampAngle(s, target, omega, dt) {
  const err = Math.atan2(Math.sin(target - s.p), Math.cos(target - s.p));
  const abs = s.p + err;
  critDamp(s, abs, omega, dt);
  s.p = Math.atan2(Math.sin(s.p), Math.cos(s.p));
  return s.p;
}

export const animTuning = {
  loco: {
    // Authored ground speed of each clip at playback rate 1 (m/s).
    // Phase rate is speed / (clipSpeed * duration) so feet don't skate.
    clipSpeeds: { idle: 0, walk: 1.4, jog: 2.8, run: 5.0, sprint: 7.5 },

    speedOmegaUp: 14,      // ~0.14 s to reach the requested gait
    speedOmegaDown: 18,    // slightly snappier decelerations
    turnOmega: 16,         // yaw spring toward stick heading
    maxTurnRateDeg: 720,   // hard cap on yaw velocity
    busyTurnScale: 0.35,   // slower turns while a full-body clip plays

    // leanDeg = clamp(yawVelRad * speed * leanGain, ±maxLean)
    leanGain: 0.28,
    maxLean: 12,           // degrees, hips/spine roll into the turn
    leanOmega: 14,

    // Pitch lean from horizontal acceleration (deg per m/s²), clamped.
    accelLeanGain: 1.2,
    accelLeanMax: 10,
    accelLeanOmega: 12,

    blendLambda: 14,       // 1st-order gait-weight smoothing (weights stay 0..1)

    // Short start push (forward lean + slight hip dip) when leaving idle.
    startPushFrom: 0.35,   // previous speed must be below this
    startPushSpeed: 0.5,   // target speed must be above this
    startPushDur: 0.18,
    startPushPitch: 8,     // extra forward lean, degrees
    startPushHip: 0.03,    // meters, downward

    // Stop settle (rear weight shift) when coming to a halt.
    stopSettleFrom: 0.8,
    stopSettleDur: 0.22,
    stopSettlePitch: -6,
    stopSettleHip: 0.045,
  },

  ik: {
    footSole: 0.08,
    rayUp: 0.55,
    rayDown: 0.75,
    maxHipDrop: 0.2,
    plantLift: 0.04,
    plantRange: 0.2,
    hipOmega: 18,          // smoothed pelvis drop
    plantOmega: 20,        // plant / unplant blend (kills edge jitter)
    targetYOmega: 22,      // foot target height smoothing
  },

  jump: {
    anticipateDur: 0.10,   // squat fades over this many seconds
    anticipateHip: 0.08,   // squat depth, meters
    // Air pose: hip Y and spine pitch follow vertical velocity.
    airVyHip: 0.02,
    airStretchHip: 0.06,   // rising (m)
    airTuckHip: 0.07,      // falling (m)
    airVyPitch: 1.5,       // deg per m/s
    airStretchPitch: 8,
    airTuckPitch: 10,
    airPoseOmega: 12,
    // Landing compression scales with impact speed, then springs back.
    landGain: 0.035,       // meters per (m/s) of downward impact
    landMax: 0.14,
    landOmega: 11,
  },
};
