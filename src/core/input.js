// Keyboard + pointer-lock mouse. Programmatic overrides for headless tests.
const DOWN = new Set();
const JUST = new Set();
const UP = new Set();

export const input = {
  mouseDx: 0,
  mouseDy: 0,
  locked: false,
  enabled: true,
  _script: { forward: 0, right: 0, sprint: false, walk: false, jump: false, melee: false, blast: false },
  _scripting: false,
};

export function bindInput(canvas, { onLock, onUnlock } = {}) {
  const onKey = (e, down) => {
    if (e.repeat) return;
    if (down) { DOWN.add(e.code); JUST.add(e.code); } else { DOWN.delete(e.code); UP.add(e.code); }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  };
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { DOWN.clear(); });

  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    if (input.locked) onLock?.(); else onUnlock?.();
  });
  document.addEventListener('mousemove', (e) => {
    if (!input.locked && !input._scripting) return;
    input.mouseDx += e.movementX || 0;
    input.mouseDy += e.movementY || 0;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!input.locked && canvas.requestPointerLock) {
      canvas.requestPointerLock();
    }
    if (e.button === 0) JUST.add('Mouse0');
    if (e.button === 2) JUST.add('Mouse2');
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function keyDown(code) { return DOWN.has(code); }
export function keyJust(code) { return JUST.has(code); }

export function beginFrame() { /* just consumed at end */ }
export function endFrame() {
  JUST.clear(); UP.clear();
  input.mouseDx = 0; input.mouseDy = 0;
  if (input._scripting) {
    input._script.jump = false;
    input._script.melee = false;
    input._script.blast = false;
  }
}

export function setScriptedInput(partial = {}) {
  Object.assign(input._script, partial);
  input._scripting = true;
}

export function clearScriptedInput() {
  input._scripting = false;
  input._script = { forward: 0, right: 0, sprint: false, walk: false, jump: false, melee: false, blast: false };
}

export function moveAxis() {
  let f = 0, r = 0;
  if (input._scripting) { f += input._script.forward || 0; r += input._script.right || 0; }
  if (keyDown('KeyW') || keyDown('ArrowUp')) f += 1;
  if (keyDown('KeyS') || keyDown('ArrowDown')) f -= 1;
  if (keyDown('KeyD') || keyDown('ArrowRight')) r += 1;
  if (keyDown('KeyA') || keyDown('ArrowLeft')) r -= 1;
  const m = Math.hypot(f, r);
  if (m > 1) { f /= m; r /= m; }
  return { forward: f, right: r, moving: m > 0.01 };
}

export function wantsSprint() { return input._scripting ? !!input._script.sprint : (keyDown('ShiftLeft') || keyDown('ShiftRight')); }
export function wantsWalk() { return input._scripting ? !!input._script.walk : (keyDown('ControlLeft') || keyDown('KeyC') || keyDown('CapsLock')); }
export function wantsJump() { return input._scripting ? !!input._script.jump : (keyJust('Space')); }
export function wantsMelee() { return input._scripting ? !!input._script.melee : (keyJust('Mouse0') || keyJust('KeyJ')); }
export function wantsBlast() { return input._scripting ? !!input._script.blast : (keyJust('KeyF') || keyJust('KeyK')); }

export function consumeMouse() {
  const x = input.mouseDx, y = input.mouseDy;
  input.mouseDx = 0; input.mouseDy = 0;
  return { x, y };
}
