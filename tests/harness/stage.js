// Shared test-page stage: renderer, orbit camera that follows a target, lights, WASD input,
// HUD panels and floating labels. Test harness only.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createStage({ background = 0x0d1118 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.fog = new THREE.Fog(background, 40, 110);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);
  camera.position.set(0, 22, 22);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1420, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(20, 35, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 100 });
  scene.add(sun);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // keyboard
  const keys = new Set();
  const pressed = new Set();
  addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) pressed.add(e.code);
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));

  /** Camera-relative WASD vector on the XZ plane. */
  const _f = new THREE.Vector3();
  const _r = new THREE.Vector3();
  function moveInput() {
    camera.getWorldDirection(_f).setY(0).normalize();
    _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
    const v = new THREE.Vector3();
    if (keys.has('KeyW')) v.add(_f);
    if (keys.has('KeyS')) v.sub(_f);
    if (keys.has('KeyD')) v.add(_r);
    if (keys.has('KeyA')) v.sub(_r);
    return v.lengthSq() > 0 ? v.normalize() : v;
  }

  // labels
  const labelRoot = document.createElement('div');
  labelRoot.className = 'labels';
  document.body.appendChild(labelRoot);
  const labels = new Map();
  const _p = new THREE.Vector3();
  function label(key, worldPos, text, cls = '') {
    let el = labels.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      labelRoot.appendChild(el);
      labels.set(key, el);
    }
    _p.copy(worldPos).project(camera);
    const vis = _p.z < 1 && Math.abs(_p.x) < 1.1 && Math.abs(_p.y) < 1.1;
    el.style.display = vis ? '' : 'none';
    if (!vis) return;
    el.style.transform = `translate(-50%,-100%) translate(${((_p.x + 1) / 2) * innerWidth}px, ${((1 - _p.y) / 2) * innerHeight}px)`;
    if (el.textContent !== text) el.textContent = text;
    el.className = `label ${cls}`;
  }

  // pointer ray
  const mouse = new THREE.Vector2();
  addEventListener('pointermove', (e) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
  const raycaster = new THREE.Raycaster();
  function pick(objects) {
    raycaster.setFromCamera(mouse, camera);
    return raycaster.intersectObjects(objects, true)[0] ?? null;
  }

  const clock = new THREE.Clock();
  let followTarget = null;
  const _prev = new THREE.Vector3();
  function follow(obj) {
    followTarget = obj;
    _prev.copy(obj.position);
    controls.target.copy(obj.position);
  }

  function loop(update) {
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.1);
      update(dt);
      if (followTarget) {
        const d = followTarget.position.clone().sub(_prev);
        camera.position.add(d);
        controls.target.add(d);
        _prev.copy(followTarget.position);
      }
      controls.update();
      renderer.render(scene, camera);
      pressed.clear();
    });
  }

  return { renderer, scene, camera, controls, keys, pressed, moveInput, label, pick, follow, loop, mouse, sun };
}

/** Greybox helpers. */
export const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts });

export function box(scene, { w, h, d, x, y = 0, z, color = 0x3a4250, rotY = 0 }) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y + h / 2, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
  m.updateMatrixWorld(true);
  return m;
}
