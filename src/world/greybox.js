import * as THREE from 'three';

export function makeMat(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: opts.color ?? 0x1a2230,
    roughness: opts.roughness ?? 0.32,
    metalness: opts.metalness ?? 0.18,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    flatShading: !!opts.flat,
  });
}

export function addBox(ctx, { id, size, pos, rot, mat, userData = {}, receive = true, cast = true }) {
  const { group, physics, mats } = ctx;
  const geom = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const mesh = new THREE.Mesh(geom, mat || mats.concrete);
  mesh.position.set(pos[0], pos[1], pos[2]);
  if (rot) mesh.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  mesh.castShadow = cast; mesh.receiveShadow = receive;
  mesh.userData = { ...userData };
  group.add(mesh);
  let pid = null;
  if (physics) {
    mesh.updateWorldMatrix(true, true);
    if (rot && (rot[0] || rot[2])) {
      pid = physics.addMesh(id, mesh, userData);
    } else {
      pid = physics.addBox({
        id,
        center: mesh.position.clone(),
        halfExtents: new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2),
        userData,
      });
      // also add the mesh so camera/ground rays can hit the same surface
      mesh.userData._physId = pid;
      if (userData.ground) physics.addMesh(id ? id + '_mesh' : undefined, mesh, userData);
    }
  }
  return { mesh, id: pid };
}

export function wetGridTexture(color1 = '#141b28', color2 = '#1e2a3c') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = color1; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = color2; g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke();
  }
  g.fillStyle = 'rgba(80,200,255,0.05)';
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function neonSign(text, { color = 0x3df0ff, w = 3.2, h = 0.7 } = {}) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#05070c'; g.fillRect(0, 0, 512, 128);
  g.font = 'bold 72px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = '#3df0ff'; g.shadowBlur = 18;
  g.fillStyle = color === 0xff3d8a ? '#ff7ab0' : '#b8ffff';
  if (typeof color === 'number' && color === 0xff3d8a) g.shadowColor = '#ff3d8a';
  g.fillText(text, 256, 70);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, emissive: color, emissiveIntensity: 1.4, emissiveMap: tex,
    roughness: 0.4, metalness: 0.2,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), mat);
  mesh.castShadow = false;
  return mesh;
}

/** Training dummy that implements the Enemy API (not C1 AI). */
export function createDummyEnemy({ id = 'dummy-0', position, hp = 80, color = 0x6a7a90, visual = null }) {
  const object = new THREE.Group();
  object.name = id;
  if (visual) object.add(visual);
  else {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 1.15, 6, 10),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, emissive: 0x1a3040, emissiveIntensity: 0.2 }),
    );
    body.position.y = 0.88; body.castShadow = true;
    object.add(body);
  }
  object.position.copy(position);
  const enemy = {
    id,
    object,
    position: object.position,
    velocity: new THREE.Vector3(),
    hp,
    hpMax: hp,
    state: 'idle',
    duckedUntil: 0,
    duck(sec) { this.duckedUntil = Math.max(this.duckedUntil, performance.now() / 1000 + sec); this.state = 'ducked'; },
    takeDamage(n, src) {
      this.hp = Math.max(0, this.hp - n);
      this.state = this.hp <= 0 ? 'dead' : 'hit';
      this._flash = 0.15;
      this._lastSrc = src;
      return n;
    },
    applyImpulse(v) { this.velocity.add(v); },
    update(dt) {
      if (this.duckedUntil && performance.now() / 1000 > this.duckedUntil && this.state === 'ducked') this.state = 'idle';
      if (this.hp <= 0) {
        object.rotation.x = Math.min(object.rotation.x + dt * 3, Math.PI * 0.5);
        object.position.y = Math.max(0.05, object.position.y - dt * 0.4);
        return;
      }
      // simple knockback slide
      object.position.x += this.velocity.x * dt;
      object.position.z += this.velocity.z * dt;
      this.velocity.x *= Math.max(0, 1 - 4 * dt);
      this.velocity.z *= Math.max(0, 1 - 4 * dt);
      this.velocity.y *= Math.max(0, 1 - 4 * dt);
      if (this._flash > 0) this._flash -= dt;
    },
  };
  return enemy;
}
