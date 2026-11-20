// Procedural clip library (authored poses; see pose-rig.js for the channel reference).
// Character space: +Z forward, +X the character's LEFT. Feet are IK targets, so the pelvis can move freely.
// Durations of melee1..3 / blast match tuning.json combat.meleeDuration / blastDuration; `events` are
// normalised hints (seconds) that gameplay reads from tuning, repeated here so the two stay in sync.

// Shared stances -------------------------------------------------------------------------------------------
const GUARD = {
  hipsPos: [0, -0.07, 0.02], hips: [4, -24, 0], torso: [8, -12, 0], headAbs: 1, head: [-2, 0, 0],
  footL: [0.05, 0, 0.17], footRotL: [0, 6, 0], footR: [-0.1, 0, -0.19], footRotR: [0, -42, 0],
  ikL: 1, ikR: 1, handTL: [0.13, 1.4, 0.36], poleL: [0.5, -0.85, -0.1], handTR: [-0.14, 1.36, 0.2], poleR: [-0.55, -0.8, -0.2],
  shL: [4, 8], shR: [4, 0], handL: [0, 0, 0], handR: [0, 0, 0],
};

const RIFLE = {
  hipsPos: [0, -0.05, 0.01], hips: [3, -28, 0], torso: [9, -10, 0], neck: [0, 16, 0], head: [-3, 20, 4],
  footL: [0.04, 0, 0.2], footRotL: [0, 4, 0], footR: [-0.1, 0, -0.16], footRotR: [0, -48, 0],
  armL: [80, 74, 10], elbowL: 52, armR: [66, 22, -10], elbowR: 118, shL: [2, 16], shR: [6, -4],
  handL: [0, 0, 0], handR: [0, 0, 0],
};

const KNEEL = {
  hipsPos: [0, -0.5, -0.02], hips: [6, -26, 0],
  footL: [0.07, 0, 0.26], footRotL: [0, 6, 0], kneeL: [0.25, 1],
  footR: [-0.12, 0.05, -0.36], footRotR: [62, -20, 0], kneeR: [-0.2, 1], toeR: -50,
};

const k = (t, pose, extra) => ({ t, ...pose, ...(extra || {}) });

// Player ---------------------------------------------------------------------------------------------------
const jump = {
  name: 'jump', dur: 0.5,
  keys: [
    { t: 0, hipsPos: [0, -0.13, 0.02], torso: [14, 0, 0], head: [-8, 0, 0], armL: [82, -34, 0], armR: [82, -34, 0], elbowL: 30, elbowR: 30,
      footL: [0, 0, 0], footR: [0, 0, 0], footRotL: [0, 0, 0], footRotR: [0, 0, 0] },
    { t: 0.1, hipsPos: [0, 0.03, 0], torso: [-6, 0, 0], head: [2, 0, 0], armL: [64, 66, 0], armR: [58, 74, 0], elbowL: 46, elbowR: 40,
      footL: [0, -0.1, -0.06], footR: [0, -0.1, -0.03], footRotL: [52, 0, 0], footRotR: [48, 0, 0], toeL: 20, toeR: 20 },
    { t: 0.3, hipsPos: [0, 0, 0], torso: [4, 0, 0], head: [-2, 0, 0], armL: [56, 40, 0], armR: [52, 48, 0], elbowL: 58, elbowR: 52,
      footL: [0.03, 0.26, 0.14], footR: [-0.03, 0.1, -0.1], footRotL: [18, 0, 0], footRotR: [34, 0, 0], toeL: 0, toeR: 0 },
    { t: 0.5, hipsPos: [0, 0, 0], torso: [6, 0, 0], armL: [50, 30, 0], armR: [48, 34, 0], elbowL: 50, elbowR: 46,
      footL: [0.04, 0.2, 0.12], footR: [-0.04, 0.1, -0.08], footRotL: [14, 0, 0], footRotR: [28, 0, 0] },
  ],
};

const fall = {
  name: 'fall', dur: 0.9, loop: true,
  keys: [
    { t: 0, torso: [8, 0, 0], head: [6, 0, 0], armL: [44, 22, 0], armR: [48, 26, 0], elbowL: 40, elbowR: 44,
      footL: [0.05, 0.16, 0.12], footR: [-0.05, 0.07, -0.1], footRotL: [14, 0, 0], footRotR: [30, 0, 0] },
    { t: 0.45, torso: [10, 3, 0], head: [8, -2, 0], armL: [38, 14, 0], armR: [54, 34, 0], elbowL: 48, elbowR: 36,
      footL: [0.05, 0.1, 0.07], footR: [-0.05, 0.13, -0.05], footRotL: [20, 0, 0], footRotR: [24, 0, 0] },
    { t: 0.9, torso: [8, 0, 0], head: [6, 0, 0], armL: [44, 22, 0], armR: [48, 26, 0], elbowL: 40, elbowR: 44,
      footL: [0.05, 0.16, 0.12], footR: [-0.05, 0.07, -0.1], footRotL: [14, 0, 0], footRotR: [30, 0, 0] },
  ],
};

const land = {
  name: 'land', dur: 0.42,
  keys: [
    { t: 0, hipsPos: [0, -0.2, 0], torso: [16, 0, 0], head: [-6, 0, 0], armL: [62, 30, 0], armR: [62, 30, 0], elbowL: 50, elbowR: 50,
      footL: [0.05, 0, 0.04], footR: [-0.05, 0, -0.04], kneeL: [0.3, 1], kneeR: [-0.3, 1] },
    { t: 0.09, stop: true, hipsPos: [0, -0.34, 0.02], torso: [28, 0, 0], head: [-14, 0, 0], armL: [70, 44, 0], armR: [70, 44, 0], elbowL: 40, elbowR: 40,
      footL: [0.06, 0, 0.04], footR: [-0.06, 0, -0.04] },
    { t: 0.26, hipsPos: [0, -0.1, 0], torso: [8, 0, 0], head: [-3, 0, 0], armL: [76, 10, 0], armR: [76, 10, 0], elbowL: 24, elbowR: 24 },
    { t: 0.42, hipsPos: [0, 0, 0], torso: [0, 0, 0], head: [0, 0, 0], armL: [76, 4, 0], armR: [76, 4, 0], elbowL: 14, elbowR: 14,
      footL: [0, 0, 0], footR: [0, 0, 0], kneeL: [0.12, 1], kneeR: [-0.12, 1] },
  ],
};

// Forward shoulder roll that carries momentum out of a hard landing.
const landRoll = {
  name: 'landRoll', dur: 0.72,
  keys: [
    { t: 0, hipsPos: [0, -0.42, 0.05], hips: [38, 0, 0], torso: [30, 0, 0], head: [20, 0, 0],
      armL: [84, 70, 0], armR: [84, 70, 0], elbowL: 30, elbowR: 30,
      footL: [0.06, 0, 0], footR: [-0.06, 0, -0.05], footRotL: [0, 0, 0], footRotR: [0, 0, 0], kneeL: [0.3, 1], kneeR: [-0.3, 1] },
    { t: 0.16, lin: true, hipsPos: [0, -0.5, 0.12], hips: [100, 0, 0], torso: [46, 0, 0], head: [34, 0, 0],
      armL: [80, 60, 0], armR: [80, 60, 0], elbowL: 80, elbowR: 80,
      footL: [0.06, 0.22, -0.22], footR: [-0.06, 0.3, -0.26], footRotL: [80, 0, 0], footRotR: [80, 0, 0], kneeL: [0.2, 0.4], kneeR: [-0.2, 0.4] },
    { t: 0.31, lin: true, hipsPos: [0, -0.56, 0.05], hips: [180, 0, 0], torso: [50, 0, 0], head: [36, 0, 0],
      armL: [70, 50, 0], armR: [70, 50, 0], elbowL: 100, elbowR: 100,
      footL: [0.07, 0.56, 0.02], footR: [-0.07, 0.6, 0.06], footRotL: [180, 0, 0], footRotR: [180, 0, 0], kneeL: [0.2, -1], kneeR: [-0.2, -1] },
    { t: 0.45, lin: true, hipsPos: [0, -0.54, 0], hips: [262, 0, 0], torso: [44, 0, 0], head: [30, 0, 0],
      armL: [74, 40, 0], armR: [74, 40, 0], elbowL: 80, elbowR: 80,
      footL: [0.07, 0.26, 0.42], footR: [-0.07, 0.3, 0.4], footRotL: [270, 0, 0], footRotR: [270, 0, 0], kneeL: [0.2, -0.2], kneeR: [-0.2, -0.2] },
    { t: 0.58, lin: true, hipsPos: [0, -0.46, 0], hips: [338, 0, 0], torso: [26, 0, 0], head: [8, 0, 0],
      armL: [78, 30, 0], armR: [78, 30, 0], elbowL: 40, elbowR: 40,
      footL: [0.07, 0, 0.14], footR: [-0.07, 0, 0.02], footRotL: [360, 0, 0], footRotR: [360, 0, 0], kneeL: [0.3, 1], kneeR: [-0.3, 1] },
    { t: 0.72, hipsPos: [0, -0.1, 0], hips: [364, 0, 0], torso: [8, 0, 0], head: [0, 0, 0],
      armL: [76, 10, 0], armR: [76, 10, 0], elbowL: 20, elbowR: 20,
      footL: [0.03, 0, 0.1], footR: [-0.03, 0, -0.06], footRotL: [360, 0, 0], footRotR: [360, 0, 0] },
  ],
};

// One-hand speed vault: left palm plants, body lays out sideways, legs sweep over to the right.
// Normalised to the vault arc by the controller.
const vault = {
  name: 'vault', dur: 0.55,
  keys: [
    { t: 0, ikL: 0, hipsPos: [0, -0.14, 0.04], hips: [14, 0, 0], torso: [18, 0, 0], headAbs: 1, head: [-4, 0, 0],
      armL: [84, 78, 0], elbowL: 22, shL: [0, 18], armR: [78, -24, 0], elbowR: 40,
      footL: [0.03, 0, 0.12], footR: [-0.04, 0.04, -0.3], footRotR: [40, 0, 0] },
    { t: 0.16, ikL: 1, handTL: [0.42, 0.62, 0.2], poleL: [0.8, 0.3, -0.5], hipsPos: [-0.08, -0.06, 0.02], hips: [6, 14, 58], torso: [4, 6, 10], head: [-4, 0, 14],
      armR: [30, 20, 0], elbowR: 50, shL: [-6, 10],
      footL: [-0.52, 0.62, -0.06], footR: [-0.66, 0.8, 0.12], footRotL: [20, 10, 50], footRotR: [20, 10, 50], kneeL: [0.2, 1], kneeR: [0, 1] },
    { t: 0.33, ikL: 1, handTL: [0.44, 0.6, -0.2], poleL: [0.8, 0.3, -0.5], hipsPos: [-0.08, -0.08, 0.06], hips: [0, 8, 52], torso: [4, 2, 8], head: [-4, 0, 12],
      armR: [34, 40, 0], elbowR: 44,
      footL: [-0.5, 0.56, 0.5], footR: [-0.58, 0.6, 0.66], footRotL: [10, 6, 40], footRotR: [10, 6, 40] },
    { t: 0.46, ikL: 0, hipsPos: [0, -0.24, 0], hips: [14, 0, 6], torso: [18, 0, 0], head: [-4, 0, 0],
      armL: [84, -34, 0], elbowL: 34, shL: [0, 0], armR: [64, 30, 0], elbowR: 46,
      footL: [0.04, 0, 0.16], footR: [-0.06, 0, 0.04], footRotL: [0, 0, 0], footRotR: [0, 0, 0] },
    { t: 0.55, hipsPos: [0, -0.08, 0], hips: [4, 0, 0], torso: [6, 0, 0], head: [-2, 0, 0],
      armL: [78, 0, 0], elbowL: 20, armR: [76, 8, 0], elbowR: 22,
      footL: [0.02, 0, 0.08], footR: [-0.03, 0, -0.04] },
  ],
};

// Right cross. Contact at 0.12 s.
const melee1 = {
  name: 'melee1', dur: 0.42, events: { hit: 0.12 },
  keys: [
    k(0, GUARD, { hips: [4, -32, 0], torso: [8, -18, 0], handTR: [-0.2, 1.34, 0.12], shR: [4, -12] }),
    k(0.11, GUARD, { stop: true, hipsPos: [0, -0.11, 0.14], hips: [8, 22, 0], torso: [10, 28, 0],
      handTR: [0.03, 1.46, 1.05], poleR: [-0.7, -0.5, -0.1], shR: [8, 30],
      handTL: [0.2, 1.36, 0.2], poleL: [0.5, -0.85, -0.3], shL: [4, -6],
      footL: [0.05, 0, 0.27], footRotL: [0, 10, 0], footR: [-0.1, 0.05, -0.15], footRotR: [34, -8, 0], toeR: -30 }),
    k(0.19, GUARD, { hipsPos: [0, -0.11, 0.15], hips: [8, 26, 0], torso: [10, 32, 0],
      handTR: [0.05, 1.45, 1.05], poleR: [-0.7, -0.5, -0.1], shR: [8, 32],
      handTL: [0.2, 1.36, 0.2], poleL: [0.5, -0.85, -0.3], shL: [4, -6],
      footL: [0.05, 0, 0.27], footRotL: [0, 10, 0], footR: [-0.1, 0.05, -0.15], footRotR: [34, -8, 0], toeR: -30 }),
    k(0.42, GUARD, { toeR: 0 }),
  ],
};

// Lead hook, thrown off the rotation the cross left behind. Contact at 0.13 s.
const melee2 = {
  name: 'melee2', dur: 0.44, events: { hit: 0.13 },
  keys: [
    k(0, GUARD, { hipsPos: [0, -0.1, 0.12], hips: [6, 26, 0], torso: [8, 30, 0],
      handTL: [0.46, 1.38, 0.2], poleL: [0.6, 0.1, -0.8], shL: [10, -10], handTR: [-0.1, 1.38, 0.3],
      footL: [0.05, 0, 0.26], footRotL: [0, 10, 0], footR: [-0.1, 0.02, -0.15], footRotR: [16, -20, 0] }),
    k(0.06, GUARD, { handTL: [0.42, 1.42, 0.5], poleL: [0.9, 0.1, -0.4] }),
    k(0.12, GUARD, { stop: true, hipsPos: [0, -0.12, 0.1], hips: [6, -34, 0], torso: [8, -40, 0],
      handTL: [-0.12, 1.46, 0.52], poleL: [0.8, 0.15, 0.3], shL: [12, 26], handTR: [-0.18, 1.34, 0.1],
      footL: [0.05, 0.03, 0.25], footRotL: [20, -30, 0], footR: [-0.1, 0, -0.17], footRotR: [0, -44, 0] }),
    k(0.2, GUARD, { hipsPos: [0, -0.12, 0.09], hips: [6, -40, 0], torso: [8, -46, 0],
      handTL: [-0.24, 1.44, 0.4], poleL: [0.7, 0.15, 0.4], shL: [12, 30], handTR: [-0.18, 1.34, 0.1],
      footL: [0.05, 0.03, 0.25], footRotL: [20, -30, 0] }),
    k(0.44, GUARD),
  ],
};

// Finisher: rear-leg roundhouse. Chamber at 0.14, contact at 0.26 s.
const melee3 = {
  name: 'melee3', dur: 0.62, events: { hit: 0.26 },
  keys: [
    k(0, GUARD),
    k(0.14, GUARD, { hipsPos: [0.05, -0.04, 0.04], hips: [0, 36, -10], torso: [0, 10, 6], head: [-2, 0, 4],
      handTL: [0.2, 1.38, 0.3], handTR: [-0.3, 1.2, 0.0], poleR: [-0.8, -0.3, -0.5],
      footL: [0.05, 0, 0.17], footRotL: [0, 50, 0], kneeL: [0.5, 1],
      footR: [-0.12, 0.5, 0.12], footRotR: [50, 30, 0], kneeR: [-0.2, 1] }),
    k(0.25, GUARD, { stop: true, hipsPos: [0.1, -0.02, 0.06], hips: [-4, 84, -26], torso: [-4, -14, 14], head: [0, 0, 8],
      handTL: [0.28, 1.36, 0.22], handTR: [-0.42, 1.1, -0.3], poleR: [-0.6, -0.4, -0.7],
      footL: [0.05, 0.03, 0.17], footRotL: [14, 96, 0], kneeL: [1, 0.5], toeL: -20,
      footR: [0.2, 0.98, 0.72], footRotR: [56, 96, 0], kneeR: [1, 0.2] }),
    k(0.33, GUARD, { hipsPos: [0.1, -0.02, 0.06], hips: [-4, 92, -26], torso: [-4, -14, 14], head: [0, 0, 8],
      handTL: [0.28, 1.36, 0.22], handTR: [-0.44, 1.1, -0.32], poleR: [-0.6, -0.4, -0.7],
      footL: [0.05, 0.03, 0.17], footRotL: [14, 96, 0], kneeL: [1, 0.5], toeL: -20,
      footR: [0.3, 0.94, 0.66], footRotR: [56, 104, 0], kneeR: [1, 0.2] }),
    k(0.47, GUARD, { hipsPos: [0.03, -0.06, 0.04], hips: [2, 30, -8], torso: [4, 0, 4],
      footL: [0.05, 0, 0.17], footRotL: [0, 40, 0], kneeL: [0.4, 1], toeL: 0,
      footR: [-0.1, 0.34, 0.06], footRotR: [40, 10, 0], kneeR: [-0.1, 1] }),
    k(0.62, GUARD, { kneeL: [0.12, 1], kneeR: [-0.12, 1] }),
  ],
};

// Sub-Bass Blast: gather at the hips, then drive both palms forward from a wide base. Release at 0.16 s.
const BLAST = { ikL: 1, ikR: 1, headAbs: 1, poleL: [0.7, -0.7, -0.2], poleR: [-0.7, -0.7, -0.2] };
const blast = {
  name: 'blast', dur: 0.62, events: { hit: 0.16 },
  keys: [
    k(0, BLAST, { hipsPos: [0, -0.1, -0.03], hips: [8, 0, 0], torso: [14, 0, 0], head: [-2, 0, 0],
      handTL: [0.24, 1.04, 0.06], handTR: [-0.24, 1.04, 0.06], shL: [2, -14], shR: [2, -14],
      footL: [0.1, 0, 0.06], footR: [-0.1, 0, -0.08], footRotL: [0, 10, 0], footRotR: [0, -16, 0] }),
    k(0.08, BLAST, { hipsPos: [0, -0.18, -0.07], hips: [12, 0, 0], torso: [18, 0, 0], head: [-2, 0, 0],
      handTL: [0.26, 1.0, -0.06], handTR: [-0.26, 1.0, -0.06], shL: [2, -20], shR: [2, -20] }),
    k(0.16, BLAST, { stop: true, hipsPos: [0, -0.22, 0.12], hips: [14, 0, 0], torso: [20, 0, 0], head: [0, 0, 0],
      handTL: [0.1, 1.24, 1.1], handTR: [-0.1, 1.24, 1.1], shL: [6, 28], shR: [6, 28], handL: [0, 60, 0], handR: [0, 60, 0],
      footL: [0.2, 0, 0.2], footR: [-0.2, 0, -0.22], footRotL: [0, 14, 0], footRotR: [20, -30, 0] }),
    k(0.22, BLAST, { hipsPos: [0, -0.22, 0.07], torso: [16, 0, 0], handTL: [0.1, 1.25, 0.9], handTR: [-0.1, 1.25, 0.9], shL: [6, 20], shR: [6, 20] }),
    k(0.36, BLAST, { hipsPos: [0, -0.2, 0.08], hips: [12, 0, 0], torso: [18, 0, 0], head: [0, 0, 0],
      handTL: [0.1, 1.24, 1.0], handTR: [-0.1, 1.24, 1.0], handL: [0, 55, 0], handR: [0, 55, 0],
      footL: [0.2, 0, 0.2], footR: [-0.2, 0, -0.22] }),
    k(0.62, BLAST, { hipsPos: [0, -0.04, 0], hips: [2, 0, 0], torso: [4, 0, 0], head: [0, 0, 0],
      handTL: [0.24, 0.92, 0.06], handTR: [-0.24, 0.92, 0.06], poleL: [0.5, -0.3, -0.8], poleR: [-0.5, -0.3, -0.8],
      shL: [0, 0], shR: [0, 0], handL: [0, 0, 0], handR: [0, 0, 0],
      footL: [0.06, 0, 0.06], footR: [-0.06, 0, -0.06], footRotL: [0, 4, 0], footRotR: [0, -8, 0] }),
  ],
};

const hit = {
  name: 'hit', dur: 0.42,
  keys: [
    { t: 0, hipsPos: [0, -0.02, 0], torso: [0, 0, 0], head: [0, 0, 0] },
    { t: 0.07, stop: true, hipsPos: [0.02, -0.08, -0.1], hips: [-6, 10, 4], torso: [-16, 18, 6], neck: [-8, 0, 0], head: [-14, -8, 8],
      armL: [60, 30, 0], elbowL: 80, armR: [68, -16, 0], elbowR: 50, shL: [10, 0], shR: [8, -10],
      footR: [-0.05, 0, -0.2], footRotR: [0, -20, 0], footL: [0.03, 0, 0.02] },
    { t: 0.2, hipsPos: [0.01, -0.07, -0.07], hips: [-2, 6, 2], torso: [-6, 10, 3], head: [-4, -4, 3],
      armL: [70, 24, 0], elbowL: 60, armR: [74, -4, 0], elbowR: 40 },
    { t: 0.42, hipsPos: [0, 0, 0], hips: [0, 0, 0], torso: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
      armL: [76, 4, 0], elbowL: 14, armR: [76, 4, 0], elbowR: 14, shL: [0, 0], shR: [0, 0],
      footR: [0, 0, 0], footRotR: [0, 0, 0], footL: [0, 0, 0] },
  ],
};

// Buckle, fall back, settle. The last frame is held by the caller.
const death = {
  name: 'death', dur: 1.35,
  keys: [
    { t: 0, hipsPos: [0, 0, 0], hips: [0, 0, 0], torso: [0, 0, 0], head: [0, 0, 0], armL: [76, 4, 0], armR: [76, 4, 0], elbowL: 14, elbowR: 14,
      footL: [0, 0, 0], footR: [0, 0, 0], footRotL: [0, 0, 0], footRotR: [0, 0, 0] },
    { t: 0.16, hipsPos: [0.02, -0.1, -0.08], hips: [-8, 8, 4], torso: [-22, 14, 6], head: [-24, 0, 0],
      armL: [50, 30, 0], armR: [60, -20, 0], elbowL: 60, elbowR: 40 },
    { t: 0.5, hipsPos: [0, -0.42, -0.2], hips: [-28, 4, 2], torso: [-14, 6, 0], head: [-10, 0, 0],
      armL: [44, 10, 0], armR: [50, 0, 0], elbowL: 50, elbowR: 44,
      footL: [0.08, 0, 0.1], footR: [-0.08, 0, 0.02], footRotL: [-10, 14, 0], footRotR: [-10, -14, 0], kneeL: [0.4, 1], kneeR: [-0.4, 1] },
    { t: 0.82, lin: true, hipsPos: [0, -0.82, -0.36], hips: [-72, 0, 0], torso: [-12, 0, 0], head: [14, 0, 0],
      armL: [40, -10, 0], armR: [44, -14, 0], elbowL: 40, elbowR: 46,
      footL: [0.12, 0.02, 0.36], footR: [-0.12, 0.02, 0.26], footRotL: [-50, 20, 0], footRotR: [-44, -22, 0] },
    { t: 0.98, stop: true, hipsPos: [0, -0.9, -0.42], hips: [-90, 0, 0], torso: [-4, 0, 0], head: [-10, 6, 0],
      armL: [34, -4, 0], armR: [48, -6, 0], elbowL: 30, elbowR: 54,
      footL: [0.14, 0.01, 0.4], footR: [-0.14, 0.04, 0.3], footRotL: [-70, 26, 0], footRotR: [-60, -30, 0] },
    { t: 1.1, hipsPos: [0, -0.875, -0.42], hips: [-87, 0, 0], torso: [-2, 0, 0], head: [-4, 8, 0] },
    { t: 1.35, hipsPos: [0, -0.9, -0.42], hips: [-90, 0, 0], torso: [-4, 0, 0], head: [-8, 10, 0],
      armL: [34, -4, 0], armR: [48, -6, 0], elbowL: 30, elbowR: 54,
      footL: [0.14, 0.01, 0.42], footR: [-0.14, 0.04, 0.32], footRotL: [-72, 28, 0], footRotR: [-62, -32, 0] },
  ],
};

// Low forward dash: drop under the line of fire, trailing leg long, arms swept back.
const dodge = {
  name: 'dodge', dur: 0.46,
  keys: [
    { t: 0, hipsPos: [0, -0.1, 0.02], hips: [16, 0, 0], torso: [16, 0, 0], head: [-14, 0, 0],
      armL: [80, -10, 0], armR: [80, -10, 0], elbowL: 40, elbowR: 40,
      footL: [0.03, 0, 0.1], footR: [-0.03, 0, -0.1] },
    { t: 0.1, hipsPos: [0, -0.36, 0.1], hips: [34, -8, 0], torso: [30, -8, 0], neck: [-16, 4, 0], head: [-30, 8, 0],
      armL: [78, -58, 0], armR: [70, -64, 0], elbowL: 16, elbowR: 22, shL: [0, -16], shR: [0, -16],
      footL: [0.05, 0, 0.42], footRotL: [0, 4, 0], kneeL: [0.2, 1],
      footR: [-0.08, 0.06, -0.56], footRotR: [58, -6, 0], kneeR: [-0.1, 1], toeR: -40 },
    { t: 0.28, hipsPos: [0, -0.38, 0.12], hips: [36, -8, 0], torso: [32, -8, 0], head: [-32, 8, 0],
      armL: [80, -62, 0], armR: [72, -68, 0], elbowL: 14, elbowR: 18,
      footL: [0.05, 0, 0.44], footR: [-0.08, 0.05, -0.6], footRotR: [60, -6, 0] },
    { t: 0.46, hipsPos: [0, -0.1, 0.02], hips: [8, 0, 0], torso: [8, 0, 0], neck: [0, 0, 0], head: [-6, 0, 0],
      armL: [76, 6, 0], armR: [76, 6, 0], elbowL: 24, elbowR: 24, shL: [0, 0], shR: [0, 0],
      footL: [0.03, 0, 0.12], footRotL: [0, 0, 0], footR: [-0.03, 0, -0.08], footRotR: [0, 0, 0], toeR: 0 },
  ],
};

// Backward hop when dodging with no direction held.
const dodgeBack = {
  name: 'dodgeBack', dur: 0.42,
  keys: [
    { t: 0, hipsPos: [0, -0.14, 0.04], torso: [18, 0, 0], head: [-12, 0, 0], armL: [74, 30, 0], armR: [74, 30, 0], elbowL: 60, elbowR: 60 },
    { t: 0.12, hipsPos: [0, -0.02, -0.08], hips: [10, 0, 0], torso: [22, 0, 0], head: [-20, 0, 0],
      armL: [60, 56, 0], armR: [60, 56, 0], elbowL: 40, elbowR: 40,
      footL: [0.06, 0.16, 0.2], footR: [-0.06, 0.2, 0.06], footRotL: [20, 0, 0], footRotR: [30, 0, 0] },
    { t: 0.28, hipsPos: [0, -0.24, -0.04], hips: [16, 0, 0], torso: [24, 0, 0], head: [-22, 0, 0],
      armL: [70, 40, 0], armR: [80, 20, 0], elbowL: 50, elbowR: 30,
      footL: [0.1, 0, 0.18], footR: [-0.1, 0, -0.24], footRotL: [0, 8, 0], footRotR: [30, -20, 0] },
    { t: 0.42, hipsPos: [0, -0.06, 0], hips: [4, 0, 0], torso: [6, 0, 0], head: [-4, 0, 0],
      armL: [76, 8, 0], armR: [76, 8, 0], elbowL: 22, elbowR: 22,
      footL: [0.04, 0, 0.06], footR: [-0.04, 0, -0.08], footRotL: [0, 0, 0], footRotR: [0, 0, 0] },
  ],
};

// Wave-Shield: drop to a knee and drive the right palm into the floor.
const castGround = {
  name: 'castGround', dur: 0.66, events: { hit: 0.2 },
  keys: [
    { t: 0, ikR: 0, hipsPos: [0, -0.06, 0], torso: [4, 0, 0], armR: [20, 40, 0], elbowR: 80, shR: [16, 0], armL: [76, 10, 0], elbowL: 30 },
    { t: 0.1, ikR: 0, hipsPos: [0, -0.02, -0.02], torso: [-8, -14, 0], head: [4, 10, 0], armR: [-50, 10, 0], elbowR: 50, shR: [24, 0], armL: [70, 30, 0], elbowL: 50 },
    k(0.2, KNEEL, { stop: true, ikR: 1, handTR: [-0.1, 0.05, 0.52], poleR: [-0.8, 0.3, -0.3], hipsPos: [0, -0.52, 0.06], torso: [40, 14, 0], neck: [-10, 0, 0], head: [-20, -6, 0],
      armR: [96, 46, 0], elbowR: 14, shR: [-4, 20], handR: [-60, 0, 0], armL: [64, -20, 0], elbowL: 50 }),
    k(0.42, KNEEL, { ikR: 1, handTR: [-0.1, 0.05, 0.52], poleR: [-0.8, 0.3, -0.3], hipsPos: [0, -0.5, 0.05], torso: [36, 12, 0], neck: [-10, 0, 0], head: [-26, -6, 0],
      armR: [96, 44, 0], elbowR: 18, shR: [-4, 18], handR: [-60, 0, 0], armL: [66, -16, 0], elbowL: 46 }),
    { t: 0.66, ikR: 0, hipsPos: [0, -0.06, 0], hips: [2, 0, 0], torso: [4, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
      armR: [76, 6, 0], elbowR: 20, shR: [0, 0], handR: [0, 0, 0], armL: [76, 6, 0], elbowL: 20,
      footL: [0.03, 0, 0.06], footRotL: [0, 0, 0], kneeL: [0.12, 1], footR: [-0.03, 0, -0.06], footRotR: [0, 0, 0], kneeR: [-0.12, 1], toeR: 0 },
  ],
};

// Launchpad: underhand toss with the right hand.
const castThrow = {
  name: 'castThrow', dur: 0.46, events: { hit: 0.16 },
  keys: [
    { t: 0, hipsPos: [0, -0.1, -0.02], hips: [6, -16, 0], torso: [12, -18, 0], head: [-8, 22, 0],
      armR: [84, -44, 0], elbowR: 24, shR: [0, -14], armL: [70, 36, 0], elbowL: 50,
      footL: [0.05, 0, 0.14], footR: [-0.08, 0, -0.14], footRotR: [0, -30, 0] },
    { t: 0.16, stop: true, hipsPos: [0, -0.16, 0.08], hips: [10, 14, 0], torso: [14, 18, 0], head: [-12, -22, 0],
      armR: [100, 62, 0], elbowR: 10, shR: [0, 20], handR: [40, 0, 0], armL: [74, -20, 0], elbowL: 40,
      footL: [0.05, 0, 0.2], footR: [-0.08, 0.03, -0.14], footRotR: [24, -20, 0] },
    { t: 0.26, armR: [86, 86, 0], elbowR: 14 },
    { t: 0.46, hipsPos: [0, -0.04, 0], hips: [0, 0, 0], torso: [2, 0, 0], head: [0, 0, 0],
      armR: [76, 6, 0], elbowR: 18, shR: [0, 0], handR: [0, 0, 0], armL: [76, 6, 0], elbowL: 18,
      footL: [0.02, 0, 0.04], footR: [-0.02, 0, -0.04], footRotR: [0, 0, 0] },
  ],
};

// Blink arrival: three-point skid that rises back to standing.
const blinkIn = {
  name: 'blinkIn', dur: 0.4,
  keys: [
    { t: 0, ikL: 1, handTL: [0.3, 0.04, 0.34], poleL: [0.9, 0.3, -0.2], hipsPos: [0, -0.4, -0.04], hips: [20, -14, 0], torso: [26, -10, 0], neck: [-12, 6, 0], head: [-26, 14, 0],
      armL: [94, 40, 0], elbowL: 12, handL: [-50, 0, 0], armR: [56, -50, 0], elbowR: 30,
      footL: [0.16, 0, 0.3], footRotL: [0, 20, 0], kneeL: [0.5, 1], footR: [-0.14, 0.04, -0.4], footRotR: [50, -20, 0], kneeR: [-0.3, 1] },
    { t: 0.14, ikL: 1, handTL: [0.3, 0.04, 0.34], hipsPos: [0, -0.38, -0.02], torso: [24, -10, 0] },
    { t: 0.4, ikL: 0, hipsPos: [0, -0.06, 0], hips: [4, 0, 0], torso: [6, 0, 0], neck: [0, 0, 0], head: [-4, 0, 0],
      armL: [76, 8, 0], elbowL: 20, handL: [0, 0, 0], armR: [76, 8, 0], elbowR: 20,
      footL: [0.04, 0, 0.08], footRotL: [0, 0, 0], kneeL: [0.12, 1], footR: [-0.04, 0, -0.08], footRotR: [0, 0, 0], kneeR: [-0.12, 1] },
  ],
};

// Phase-Skip: held streamline pose while the body is out of phase.
const dash = {
  name: 'dash', dur: 0.5, loop: true,
  keys: [0, 0.25, 0.5].map((t, i) => ({
    t, hipsPos: [0, -0.2 - (i === 1 ? 0.015 : 0), 0.1], hips: [30, 0, 0], torso: [24, 0, 0], neck: [-14, 0, 0], head: [-28, 0, 0],
    armL: [74, -56 - (i === 1 ? 4 : 0), 0], armR: [74, -56 - (i === 1 ? 4 : 0), 0], elbowL: 12, elbowR: 12, shL: [0, -14], shR: [0, -14],
    footL: [0.04, 0.02, 0.36], footRotL: [10, 0, 0], footR: [-0.05, 0.12, -0.56], footRotR: [64, 0, 0], toeR: -30,
  })),
};

// Relaxed ready stance held between combo hits and while enemies are close.
const guard = {
  name: 'guard', dur: 1.8, loop: true,
  keys: [
    k(0, GUARD),
    k(0.9, GUARD, { hipsPos: [0, -0.085, 0.02], torso: [9.5, -12, 0], armL: [73, 56, 0], elbowL: 106, armR: [81, 25, 0], elbowR: 126 }),
    k(1.8, GUARD),
  ],
};

// Enemy humanoids -------------------------------------------------------------------------------------------
const aim = {
  name: 'aim', dur: 2.4, loop: true,
  keys: [
    k(0, RIFLE),
    k(1.2, RIFLE, { hipsPos: [0, -0.06, 0.01], torso: [10.2, -10, 0], armL: [80.6, 73.4, 10], armR: [66.5, 21.6, -10] }),
    k(2.4, RIFLE),
  ],
};

const fire = {
  name: 'fire', dur: 0.2, loop: true, fps: 60,
  keys: [
    k(0, RIFLE),
    k(0.04, RIFLE, { hipsPos: [0, -0.052, -0.012], torso: [6.5, -11.5, 0], shR: [8, -9], armR: [67.5, 19, -10], elbowR: 121, armL: [79, 72, 10], elbowL: 55, head: [-4.5, 20, 4] }),
    k(0.2, RIFLE),
  ],
};

const crouch = {
  name: 'crouch', dur: 2.6, loop: true,
  keys: [0, 1.3, 2.6].map((t, i) => k(t, KNEEL, {
    torso: [22 + (i === 1 ? 1.5 : 0), -8, 0], neck: [-6, 10, 0], head: [-12, 16, 0],
    armL: [84, 50, 10], elbowL: 70, armR: [74, 10, -10], elbowR: 112, shL: [2, 12], shR: [4, -4],
  })),
};

const crouchAim = {
  name: 'crouchAim', dur: 2.4, loop: true,
  keys: [0, 1.2, 2.4].map((t, i) => k(t, KNEEL, {
    hipsPos: [0, -0.46, 0], torso: [12 + (i === 1 ? 1 : 0), -8, 0], neck: [0, 14, 0], head: [-4, 18, 4],
    armL: [80, 76, 10], elbowL: 52, armR: [66, 22, -10], elbowR: 118, shL: [2, 16], shR: [6, -4],
  })),
};

const reload = {
  name: 'reload', dur: 1.6,
  keys: [
    k(0, RIFLE),
    k(0.3, RIFLE, { torso: [12, -6, 0], head: [8, 14, 0], armR: [72, 30, -10], elbowR: 104, armL: [86, 30, 0], elbowL: 80 }),
    k(0.6, RIFLE, { torso: [12, -4, 0], head: [12, 10, 0], armR: [72, 32, -10], elbowR: 100, armL: [88, -8, 0], elbowL: 62, shL: [0, -6] }),
    k(0.95, RIFLE, { torso: [12, -6, 0], head: [10, 12, 0], armR: [72, 32, -10], elbowR: 100, armL: [84, 36, 0], elbowL: 96, shL: [2, 4] }),
    k(1.15, RIFLE, { stop: true, torso: [11, -8, 0], head: [6, 14, 0], armR: [70, 28, -10], elbowR: 108, armL: [82, 44, 6], elbowL: 104 }),
    k(1.6, RIFLE),
  ],
};

const stagger = {
  name: 'stagger', dur: 0.52,
  keys: [
    k(0, RIFLE),
    { t: 0.08, stop: true, hipsPos: [0.03, -0.1, -0.14], hips: [-10, -10, 6], torso: [-24, 22, 8], neck: [-10, 0, 0], head: [-18, -10, 10],
      armL: [44, 40, 0], elbowL: 60, armR: [60, -24, 0], elbowR: 70, shL: [14, 0], shR: [10, -12],
      footL: [0.06, 0, 0.1], footRotL: [0, 10, 0], footR: [-0.12, 0, -0.38], footRotR: [0, -30, 0] },
    { t: 0.26, hipsPos: [0.02, -0.12, -0.12], hips: [-2, -16, 2], torso: [-4, 8, 2], head: [-4, 4, 2],
      armL: [66, 50, 0], elbowL: 70, armR: [66, 6, 0], elbowR: 96 },
    k(0.52, RIFLE),
  ],
};

// Sidechain-ducked: hunched, hands clamped over the ears, swaying.
const ducked = {
  name: 'ducked', dur: 1.0, loop: true,
  keys: [0, 0.5, 1.0].map((t, i) => ({
    t, hipsPos: [i === 1 ? 0.02 : -0.02, -0.16, 0], hips: [10, 0, i === 1 ? 3 : -3], torso: [30, 0, i === 1 ? 4 : -4],
    neck: [10, 0, 0], head: [14, i === 1 ? 6 : -6, 0],
    armL: [22, 70, 30], elbowL: 148, armR: [22, 70, 30], elbowR: 148, shL: [18, 10], shR: [18, 10],
    footL: [0.1, 0, 0.04], footR: [-0.1, 0, -0.04], kneeL: [0.4, 1], kneeR: [-0.4, 1],
  })),
};

// Dissonant Hulk ---------------------------------------------------------------------------------------------
const HULK = {
  hipsPos: [0, -0.1, 0], hips: [8, 0, 0], torso: [16, 0, 0], neck: [-6, 0, 0], head: [-10, 0, 0],
  armL: [62, 14, 0], elbowL: 36, armR: [62, 14, 0], elbowR: 36, shL: [6, 6], shR: [6, 6],
  footL: [0.16, 0, 0.04], footR: [-0.16, 0, -0.04], footRotL: [0, 16, 0], footRotR: [0, -16, 0], kneeL: [0.4, 1], kneeR: [-0.4, 1],
};

// Overhead double-fist slam. Impact at 60% (0.72 s).
const hulkSlam = {
  name: 'hulkSlam', dur: 1.2, events: { hit: 0.72 },
  keys: [
    k(0, HULK),
    k(0.5, HULK, { hipsPos: [0, 0, -0.06], hips: [-6, 0, 0], torso: [-26, 0, 0], neck: [6, 0, 0], head: [10, 0, 0],
      armL: [-62, 30, 0], elbowL: 50, armR: [-62, 30, 0], elbowR: 50, shL: [30, 0], shR: [30, 0] }),
    k(0.62, HULK, { ikL: 0, ikR: 0, hipsPos: [0, 0.01, -0.07], torso: [-30, 0, 0], armL: [-68, 26, 0], elbowL: 60, armR: [-68, 26, 0], elbowR: 60, shL: [32, 0], shR: [32, 0] }),
    k(0.72, HULK, { stop: true, ikL: 1, ikR: 1, handTL: [0.2, 0.1, 0.72], handTR: [-0.2, 0.1, 0.72], hipsPos: [0, -0.4, 0.2], hips: [26, 0, 0], torso: [50, 0, 0], neck: [-14, 0, 0], head: [-30, 0, 0],
      armL: [98, 62, 0], elbowL: 12, armR: [98, 62, 0], elbowR: 12, shL: [-4, 24], shR: [-4, 24],
      footL: [0.22, 0, 0.16], footR: [-0.22, 0, 0.1] }),
    k(0.95, HULK, { ikL: 1, ikR: 1, handTL: [0.2, 0.1, 0.72], handTR: [-0.2, 0.1, 0.72], hipsPos: [0, -0.38, 0.18], hips: [24, 0, 0], torso: [46, 0, 0], head: [-34, 0, 0],
      armL: [98, 60, 0], elbowL: 16, armR: [98, 60, 0], elbowR: 16, shL: [-4, 22], shR: [-4, 22], footL: [0.22, 0, 0.16], footR: [-0.22, 0, 0.1] }),
    k(1.2, HULK, { ikL: 0, ikR: 0 }),
  ],
};

// Rip a chunk out of the floor and hurl it overhand. Release at 55% (0.66 s).
const hulkThrow = {
  name: 'hulkThrow', dur: 1.2, events: { hit: 0.66 },
  keys: [
    k(0, HULK),
    k(0.26, HULK, { stop: true, hipsPos: [-0.04, -0.42, 0.1], hips: [20, -20, 0], torso: [44, -20, 0], head: [-26, 20, 0],
      armR: [98, 40, 0], elbowR: 14, shR: [-6, 16], armL: [60, -10, 0], elbowL: 50 }),
    k(0.5, HULK, { hipsPos: [0.03, -0.06, -0.1], hips: [-4, -34, 0], torso: [-16, -40, 0], neck: [0, 30, 0], head: [-4, 34, 0],
      armR: [-48, -30, 0], elbowR: 84, shR: [26, -20], armL: [70, 70, 0], elbowL: 30, shL: [4, 20],
      footL: [0.16, 0, 0.2], footR: [-0.18, 0, -0.2] }),
    k(0.66, HULK, { stop: true, hipsPos: [0, -0.22, 0.2], hips: [18, 26, 0], torso: [34, 34, 0], neck: [-6, -24, 0], head: [-16, -30, 0],
      armR: [70, 96, 0], elbowR: 10, shR: [10, 30], armL: [80, -40, 0], elbowL: 40, shL: [0, -14],
      footL: [0.16, 0, 0.24], footR: [-0.18, 0.04, -0.1], footRotR: [30, -10, 0] }),
    k(0.85, HULK, { hipsPos: [0, -0.26, 0.2], hips: [20, 32, 0], torso: [40, 40, 0], head: [-18, -34, 0],
      armR: [104, 70, 0], elbowR: 20, armL: [80, -44, 0], elbowL: 40, footL: [0.16, 0, 0.24], footR: [-0.18, 0, -0.06] }),
    k(1.2, HULK),
  ],
};

const hulkRoar = {
  name: 'hulkRoar', dur: 1.6,
  keys: [
    k(0, HULK),
    k(0.3, HULK, { hipsPos: [0, -0.24, 0.04], hips: [16, 0, 0], torso: [36, 0, 0], head: [-6, 0, 0],
      armL: [70, 50, 0], elbowL: 100, armR: [70, 50, 0], elbowR: 100 }),
    ...[0.55, 0.7, 0.85, 1.0, 1.15, 1.3].map((t, i) => k(t, HULK, {
      hipsPos: [0, -0.08, -0.06], hips: [-8, 0, i % 2 ? 2 : -2], torso: [-30, i % 2 ? 5 : -5, i % 2 ? 3 : -3], neck: [-10, 0, 0], head: [-26, i % 2 ? -6 : 6, 0],
      armL: [48, -36, -30], elbowL: 44, armR: [48, -36, -30], elbowR: 44, shL: [-8, -24], shR: [-8, -24],
      footL: [0.24, 0, 0.02], footR: [-0.24, 0, -0.02],
    })),
    k(1.6, HULK),
  ],
};

const hulkStagger = {
  name: 'hulkStagger', dur: 0.8,
  keys: [
    k(0, HULK),
    k(0.1, HULK, { stop: true, hipsPos: [0.04, -0.14, -0.2], hips: [-12, 12, 6], torso: [-30, 20, 8], head: [-16, -10, 8],
      armL: [40, 30, 0], elbowL: 50, armR: [56, -30, 0], elbowR: 40, footR: [-0.2, 0, -0.4], footL: [0.18, 0, 0] }),
    k(0.36, HULK, { hipsPos: [0, -0.44, -0.1], hips: [14, 6, 0], torso: [34, 8, 0], head: [8, 0, 0],
      armL: [92, 40, 0], elbowL: 14, armR: [70, 10, 0], elbowR: 60, footR: [-0.2, 0.04, -0.42], footRotR: [50, -16, 0], footL: [0.18, 0, 0.1] }),
    k(0.56, HULK, { hipsPos: [0, -0.42, -0.1], hips: [12, 6, 0], torso: [30, 6, 0], head: [4, 0, 0],
      armL: [92, 40, 0], elbowL: 16, armR: [70, 10, 0], elbowR: 60, footR: [-0.2, 0.04, -0.42], footRotR: [50, -16, 0], footL: [0.18, 0, 0.1] }),
    k(0.8, HULK),
  ],
};

export const CLIP_DEFS = [
  jump, fall, land, landRoll, vault, melee1, melee2, melee3, blast, hit, death, dodge, dodgeBack,
  castGround, castThrow, blinkIn, dash, guard,
  aim, fire, crouch, crouchAim, reload, stagger, ducked,
  hulkSlam, hulkThrow, hulkRoar, hulkStagger,
];
