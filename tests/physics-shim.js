// Test-only: lets the real game run on Rapier without editing main.js. tests/physics-game.html remaps
// src/core/physics.js to this file (import-map scope), so main.js's `new PhysicsWorld()` builds a RapierWorld.
import { initRapier, RapierWorld } from '../src/physics/rapier-world.js';

await initRapier();
export class PhysicsWorld extends RapierWorld {}
