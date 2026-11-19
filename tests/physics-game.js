// C3 test hooks for tests/physics-game.html: the real game on Rapier.
// Keys come from the main game (Q Blink · R Phase-Skip · G Wave-Shield · T Launchpad).
// P drop a thin test wall ahead (phaseable) · O spawn crates.
import * as THREE from 'three';
import { createPowers } from '../src/player/powers/powers.js';

while (!window.AG?.ready) await new Promise((r) => setTimeout(r, 100));
const game = window.game;
const physics = game.physics;
console.info('[c3] physics world:', physics.world ? 'rapier' : 'aabb');
const cfg = await fetch('src/data/powers.json').then((r) => r.json());
const powers = game.powers || createPowers({ bus: game.bus, physics, scene: game.scene, player: game.player, clock: game.clock, cfg: { ...cfg, bindKeys: false } });

let wallN = 0;
function testWall(dist = 3, yaw = game.player.yaw) {
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const c = game.player.position.clone().addScaledVector(dir, dist).setY(game.player.position.y + 1.3);
  const alongX = Math.abs(dir.z) >= Math.abs(dir.x);
  const size = alongX ? [4, 2.6, 0.3] : [0.3, 2.6, 4];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color: 0x6a3df0, emissive: 0x2a0f60 }));
  mesh.position.copy(c);
  game.scene.add(mesh);
  const id = physics.addBox({ id: `test-wall-${++wallN}`, center: c, halfExtents: new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2), userData: { solid: true } });
  return { id, mesh, phaseable: physics.bodies.get(id).userData.phaseable };
}
function crates(n = 4) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: 0x8a6a3a }));
    game.scene.add(m);
    const p = game.player.position.clone().add(new THREE.Vector3((i % 2) * 0.7 - 0.35, 2 + i * 0.7, 2.5));
    physics.addDynamicBox({ center: p, halfExtents: new THREE.Vector3(0.3, 0.3, 0.3), mesh: m, mass: 15 });
  }
}
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') testWall();
  if (e.code === 'KeyO') crates();
});

if (!game.powers) {
  let last = performance.now();
  (function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    powers.update(Math.min((now - last) / 1000, 0.1));
    last = now;
  })();
}
window.__phys = { physics, powers, testWall, crates };
