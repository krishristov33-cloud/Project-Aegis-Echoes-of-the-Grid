// Rooftop wave flow, a 2-shooter cap, and a cheap aim telegraph.
// Does not edit src/ai: parks wave-2 agents, wraps weapon.update, and draws a wind-up line.
import * as THREE from 'three';

export function createEncounterFlow({ bus, scene, player, enemies, strings }) {
  const group = new THREE.Group();
  group.name = 'aim-telegraph';
  scene.add(group);
  const mat = new THREE.LineBasicMaterial({ color: 0xff3d8a, transparent: true, opacity: 0.9, depthWrite: false });
  const lines = new Map();

  let level = '';
  let phase = 'off'; // wave1 | wait | wave2 | clear | off
  let waitT = 0;
  let parked = [];
  let armed = false;

  const incoming = () => {
    const lines = strings?.callouts?.waveIncoming;
    if (Array.isArray(lines) && lines.length) return lines[0];
    return 'Drone inbound! More on the roof!';
  };

  bus.on('levelState', (e) => {
    if (e?.phase !== 'enter') return;
    unparkAll();
    clearLines();
    level = e.level || '';
    phase = level === 'rooftop' ? 'wave1' : 'off';
    waitT = 0;
    armed = false;
  });

  function park(e) {
    if (e._flowPark) return;
    e._flowPark = {
      update: e.update.bind(e),
      pos: e.position.clone(),
      visible: e.view ? e.view.visible !== false : true,
    };
    e.position.set(0, -80, 0);
    if (e.view) {
      e.view.visible = false;
      e.view.position.copy(e.position);
    }
    e.update = () => {};
    parked.push(e);
  }

  function unparkAll() {
    for (const e of parked) {
      if (!e._flowPark) continue;
      e.position.copy(e._flowPark.pos);
      if (e.view) {
        e.view.visible = e._flowPark.visible;
        e.view.position.copy(e.position);
      }
      e.update = e._flowPark.update;
      e._flowPark = null;
    }
    parked = [];
  }

  function clearLines() {
    for (const rec of lines.values()) {
      rec.line.visible = false;
    }
  }

  function bindWeapon(e) {
    if (!e.weapon || e._mayShootBound) return;
    e._mayShootBound = true;
    e._mayShoot = true;
    const orig = e.weapon.update.bind(e.weapon);
    e.weapon.update = (dt, p) => orig(dt, { ...p, wantFire: !!(p.wantFire && e._mayShoot) });
  }

  function assignShooters() {
    const list = enemies.filter((e) => !e.dead && !e._flowPark && e.weapon && e.kind !== 'hulk');
    for (const e of list) bindWeapon(e);
    const engaging = list.filter((e) => e.perception?.canSee || (e.weapon.trackedFor || 0) > 0 || e.state === 'combat');
    engaging.sort((a, b) => a.position.distanceToSquared(player.position) - b.position.distanceToSquared(player.position));
    const allow = new Set(engaging.slice(0, 2));
    for (const e of list) e._mayShoot = allow.has(e);
  }

  function telegraph() {
    const seen = new Set();
    for (const e of enemies) {
      if (e.dead || !e.weapon || e._flowPark) continue;
      const rt = e.weapon.cfg?.reactionTime ?? 1.2;
      const t = e.weapon.trackedFor || 0;
      if (!(e._mayShoot && t > 0 && t < rt)) continue;
      seen.add(e);
      let rec = lines.get(e);
      if (!rec) {
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const line = new THREE.Line(geo, mat);
        line.frustumCulled = false;
        group.add(line);
        rec = { line, geo };
        lines.set(e, rec);
      }
      const from = e.position.clone();
      from.y += e.crouched ? 1.0 : 1.4;
      const to = player.position.clone();
      to.y += 1.1;
      rec.geo.setFromPoints([from, to]);
      rec.line.visible = true;
      rec.line.material.opacity = 0.4 + 0.6 * (t / Math.max(0.05, rt));
    }
    for (const [e, rec] of lines) if (!seen.has(e)) rec.line.visible = false;
  }

  function rooftopFlow(dt, levelObj) {
    if (phase === 'off' || level !== 'rooftop') return;
    const bySquad = (name) => enemies.filter((e) => e.squad?.name === name);
    if (!armed) {
      const w2 = bySquad('roof-wave2');
      if (w2.length) {
        for (const e of w2) park(e);
        armed = true;
      }
    }
    if (phase === 'wave1') {
      const w1 = bySquad('roof-wave1');
      if (armed && w1.length && w1.every((e) => e.dead)) {
        phase = 'wait';
        waitT = 1.0;
        bus.emit('callout', { text: incoming(), key: 'waveIncoming', pos: player.position.clone() });
      }
    } else if (phase === 'wait') {
      waitT -= dt;
      if (waitT <= 0) {
        unparkAll();
        phase = 'wave2';
      }
    } else if (phase === 'wave2') {
      const live = enemies.filter((e) => !e.dead && !e._flowPark && e.kind !== 'hulk' && (e.squad?.name === 'roof-wave1' || e.squad?.name === 'roof-wave2' || !e.squad?.name?.startsWith?.('roof')));
      const w1 = bySquad('roof-wave1');
      const w2 = bySquad('roof-wave2');
      if (armed && w1.length && w2.length && w1.every((e) => e.dead) && w2.every((e) => e.dead)) {
        phase = 'clear';
        bus.emit('levelState', { level: 'rooftop', phase: 'clear' });
        if (levelObj?.portals) for (const p of levelObj.portals) p.locked = false;
      }
    }
  }

  return {
    update(dt, levelObj) {
      assignShooters();
      rooftopFlow(dt, levelObj);
      telegraph();
    },
    dispose() {
      unparkAll();
      scene.remove(group);
    },
  };
}
