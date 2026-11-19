// Frame-Drop Blink visual (C7): the "dropped frame" Kael leaves behind is a frozen copy of his actual pose at the
// moment of the blink, rendered as a glitching hologram. It stays where enemies last saw him and is what they keep
// shooting (C1 perception). Each shot that lands on it makes it tear harder.
// Aether's src/fx/index.js adds the datamosh blocks around both ends; this file owns only the posed ghost.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const GHOST_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  uniform float uTime, uTear;
  varying float vY;
  void main() {
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    // horizontal slice tearing: bands of the mesh jump sideways
    float band = floor(transformed.y * 9.0 + uTime * 3.0);
    float jitter = step(0.78 - uTear * 0.3, fract(sin(band * 91.7 + floor(uTime * 24.0)) * 4375.85));
    transformed.x += jitter * (0.06 + uTear * 0.18) * sin(band * 12.9 + uTime * 40.0);
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vY = wp.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const GHOST_FRAG = /* glsl */ `
  uniform float uTime, uLife, uTear;
  varying float vY;
  void main() {
    float scan = 0.55 + 0.45 * sin(vY * 70.0 - uTime * 18.0);
    float flick = 0.75 + 0.25 * step(0.4, fract(uTime * 17.0));
    vec3 cyan = vec3(0.24, 0.94, 1.0), mag = vec3(1.0, 0.24, 0.54);
    vec3 col = mix(cyan, mag, clamp(uTear + 0.25 * sin(uTime * 23.0), 0.0, 1.0)) * scan;
    gl_FragColor = vec4(col, 0.55 * flick * uLife);
  }`;

function ghostMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: GHOST_VERT,
    fragmentShader: GHOST_FRAG,
    uniforms: { uTime: { value: 0 }, uLife: { value: 1 }, uTear: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * @param {object} o
 * @param {THREE.Object3D} o.scene
 * @param {object} o.bus
 */
export function createBlinkFx({ scene, bus }) {
  const ghosts = []; // { id, root, mat, t, life }
  let time = 0;

  const off = bus.on('enemyShot', (e) => {
    if (!e?.targetGhost) return;
    for (const g of ghosts) g.tear = Math.min(1, g.tear + 0.25);
  });

  return {
    /**
     * Freeze `source` (the player's model root, in its current pose) into a ghost at its current transform.
     * @returns {{id, root}} the ghost
     */
    spawnGhost(source, { id, life = 2.5 } = {}) {
      source.updateMatrixWorld(true);
      const root = SkeletonUtils.clone(source); // copies bone transforms -> the pose is frozen (no mixer drives it)
      const mat = ghostMaterial();
      root.traverse((o) => {
        if (o.isMesh) {
          o.material = mat;
          o.castShadow = false;
          o.receiveShadow = false;
          o.frustumCulled = false;
        }
      });
      // the clone keeps the source's local transform; place it in world space
      source.matrixWorld.decompose(root.position, root.quaternion, root.scale);
      scene.add(root);
      const g = { id, root, mat, t: 0, life, tear: 0.6 };
      ghosts.push(g);
      return g;
    },

    update(dt) {
      time += dt;
      for (let i = ghosts.length - 1; i >= 0; i--) {
        const g = ghosts[i];
        g.t += dt;
        g.tear = Math.max(0, g.tear - dt * 1.5);
        const u = g.t / g.life;
        g.mat.uniforms.uTime.value = time;
        g.mat.uniforms.uTear.value = g.tear;
        g.mat.uniforms.uLife.value = u < 0.85 ? 1 : Math.max(0, 1 - (u - 0.85) / 0.15);
        if (u >= 1) {
          g.root.removeFromParent();
          g.mat.dispose();
          ghosts.splice(i, 1);
        }
      }
    },

    get ghosts() {
      return ghosts;
    },

    dispose() {
      off?.();
      for (const g of ghosts) g.root.removeFromParent();
      ghosts.length = 0;
    },
  };
}
