// Stand-in for game.player until Lumen's L2 controller lands. Implements the Player API from
// docs/TASKS.md: position, velocity, isGrounded, hp, state, applyImpulse(v), takeDamage(n, src),
// plus the bits the AI harness needs (footstep noise, blink, god mode).
// Movement is clamped to the navmesh so the stub can't walk through greybox geometry.
import * as THREE from 'three';

export class PlayerStub {
  constructor({ bus, scene, nav, noise, position, hpMax = 100 }) {
    this.id = 'player';
    this.bus = bus;
    this.nav = nav;
    this.noise = noise; // enemies.json "noise" radii
    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.isGrounded = true;
    this.hpMax = hpMax;
    this.hp = hpMax;
    this.state = 'idle';
    this.yaw = 0;
    this.god = false;
    this.invulnerable = false; // C3 Phase-Skip sets this while phasing
    this.walkSpeed = 3;
    this.runSpeed = 6.5;
    this._stepT = 0;
    this._impulse = new THREE.Vector3();

    const g = new THREE.CapsuleGeometry(0.35, 1.1, 4, 8);
    g.translate(0, 0.9, 0);
    this.view = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x38e8ff, emissive: 0x0b4050 }));
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    nose.position.set(0, 1.5, 0.35);
    this.view.add(nose);
    this.view.castShadow = true;
    scene.add(this.view);
  }

  applyImpulse(v) {
    this._impulse.add(v);
  }

  takeDamage(n, src) {
    if (this.god || this.invulnerable || this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - n);
    this.bus.emit('playerDamaged', { amount: n, hp: this.hp, hpMax: this.hpMax, src: src?.id });
    if (this.hp <= 0) this.state = 'dead';
  }

  heal(n) {
    this.hp = Math.min(this.hpMax, this.hp + n);
    if (this.hp > 0 && this.state === 'dead') this.state = 'idle';
    this.bus.emit('playerHealed', { amount: n, hp: this.hp, hpMax: this.hpMax });
  }

  /** @param {{x:number,z:number}} input  move vector in world XZ (length 0..1) */
  update(dt, input, running) {
    if (this.state === 'dead') {
      this.velocity.set(0, 0, 0);
      return;
    }
    const speed = running ? this.runSpeed : this.walkSpeed;
    this.velocity.set(input.x * speed, 0, input.z * speed).add(this._impulse);
    this._impulse.multiplyScalar(Math.max(0, 1 - dt * 6));
    const next = this.position.clone().addScaledVector(this.velocity, dt);
    const snapped = this.nav.closest(next, { x: 1, y: 3, z: 1 });
    if (snapped) this.position.copy(snapped);
    const moving = Math.hypot(input.x, input.z) > 0.1;
    if (moving) this.yaw = Math.atan2(input.x, input.z);
    this.state = moving ? (running ? 'run' : 'walk') : 'idle';

    if (moving) {
      this._stepT -= dt;
      if (this._stepT <= 0) {
        this._stepT = running ? 0.32 : 0.5;
        this.bus.emit('noise', { pos: this.position.clone(), radius: running ? this.noise.footstepRun : this.noise.footstepWalk, kind: 'footstep' });
      }
    }
    this.view.position.copy(this.position);
    this.view.rotation.y = this.yaw;
  }

  teleport(p) {
    this.position.copy(p);
    this.view.position.copy(p);
  }
}
