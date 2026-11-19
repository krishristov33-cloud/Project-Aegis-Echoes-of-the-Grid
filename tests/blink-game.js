// Attaches Frame-Drop Blink to the running game without touching src/main.js / core/input.js.
// Q blinks where the camera faces. Remove once Lumen wires createBlink into main.js (see the C7 PR).
import { createBlink } from '../src/player/powers/blink.js';

while (!window.AG?.ready) await new Promise((r) => setTimeout(r, 100));
const game = window.game;
// main.js now wires createBlink; do not attach a second instance.
if (game.blink) {
  window.__blink = game.blink;
} else {
  const powers = await fetch('src/data/powers.json').then((r) => r.json());
  const blink = createBlink({ bus: game.bus, player: game.player, physics: game.physics, scene: game.scene, clock: game.clock, cfg: powers.blink, time: game.time });
  blink.aimYaw = () => game.player.yaw;
  let last = performance.now();
  (function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    blink.update(Math.min((now - last) / 1000, 0.1));
    last = now;
  })();
  window.__blink = blink;
}
