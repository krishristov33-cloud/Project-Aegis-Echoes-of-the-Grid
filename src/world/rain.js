import * as THREE from 'three';

/** Instanced rain (perf budget: one InstancedMesh, no per-drop draw calls). */
export function createRain(tuning, parent) {
  const t = tuning.rain || {};
  const count = t.count ?? 1100;
  const area = t.area ?? 42;
  const speed = t.speed ?? 16;
  const size = t.size ?? 0.07;
  const height = t.height ?? 16;

  const geom = new THREE.BoxGeometry(size * 0.12, size * 2.4, size * 0.12);
  const mat = new THREE.MeshBasicMaterial({ color: 0x8eb8d0, transparent: true, opacity: 0.45, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geom, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false; mesh.receiveShadow = false;
  parent.add(mesh);

  const drops = new Float32Array(count * 3);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    drops[i * 3] = (Math.random() - 0.5) * area;
    drops[i * 3 + 1] = Math.random() * height;
    drops[i * 3 + 2] = (Math.random() - 0.5) * area;
  }

  let origin = new THREE.Vector3();
  return {
    mesh,
    setOrigin(p) { origin.copy(p); },
    update(dt) {
      const half = area * 0.5;
      for (let i = 0; i < count; i++) {
        let x = drops[i * 3], y = drops[i * 3 + 1], z = drops[i * 3 + 2];
        y -= speed * dt;
        x -= 1.4 * dt; // wind
        if (y < 0) {
          y += height;
          x = origin.x + (Math.random() - 0.5) * area;
          z = origin.z + (Math.random() - 0.5) * area;
        }
        drops[i * 3] = x; drops[i * 3 + 1] = y; drops[i * 3 + 2] = z;
        dummy.position.set(x, y, z);
        dummy.rotation.z = -0.12;
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      parent.remove(mesh);
      geom.dispose(); mat.dispose();
    },
  };
}
