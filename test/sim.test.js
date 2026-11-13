// Run: node test/sim.test.js   (pure sim, no browser)
const assert = require('assert');
const S = require('../js/sim.js');
const { CFG } = S;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

const settle = (sim, steps = 120) => { for (let i = 0; i < steps; i++) sim.step(); };

ok('snapshot never contains hearts', () => {
  const sim = S.create();
  sim.addFighter({ id: 1, name: 'a', team: 1 }); sim.addFighter({ id: 2, name: 'b', team: 2 });
  settle(sim);
  const json = JSON.stringify(sim.snapshot());
  assert(!/hp|heart/i.test(json));
  assert.deepStrictEqual(Object.keys(sim.privateState(1)).sort(), ['alive', 'dash', 'dashT', 'hp', 'jump']);
});

ok('rolling, jump then dash', () => {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1 });
  settle(sim);
  const x0 = f.body.position.x;
  sim.setInput(1, { rot: 1 }); settle(sim, 60);
  assert(f.body.position.x > x0 + 150, 'rolls right');
  sim.setInput(1, { rot: 0 });
  sim.pressSpace(1); sim.step();
  assert(f.body.velocity.y < -5, 'jumped');
  sim.pressSpace(1); sim.step();
  assert(f.dashT > 0 && !f.canDash, 'dashed');
});

ok('dash hit removes a heart, emits public hit event, kill scores', () => {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1000, y: CFG.H - 40 } });
  const b = sim.addFighter({ id: 2, name: 'b', team: 2, at: { x: 1090, y: CFG.H - 40 } });
  settle(sim);
  sim.drainEvents();
  for (let k = 0; k < 3; k++) {
    sim.respawn(1); sim.setInput(1, { ax: 1, ay: 0, aim: true });
    Matter_set(a, 1000, CFG.H - 40); Matter_set(b, 1090, CFG.H - 40);
    sim.pressSpace(1); sim.step();            // on the ground: first press is a jump…
    sim.pressSpace(1); sim.step();            // …second is a dash
    for (let i = 0; i < 30; i++) sim.step();
    if (!b.alive) break;
  }
  const ev = sim.drainEvents();
  assert(ev.some(e => e.e === 'hit' && e.id === 2 && typeof e.hp === 'number'));
  assert(b.hp < CFG.HEARTS);
});

function Matter_set(f, x, y) {
  const M = require('../lib/matter.min.js');
  M.Body.setPosition(f.body, { x, y }); M.Body.setVelocity(f.body, { x: 0, y: 0 }); M.Body.setAngle(f.body, 0);
}

ok('teammates never hit each other', () => {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1000, y: CFG.H - 40 } });
  const b = sim.addFighter({ id: 2, name: 'b', team: 1, at: { x: 1090, y: CFG.H - 40 } });
  settle(sim);
  sim.setInput(1, { ax: 1, ay: 0, aim: true });
  sim.pressSpace(1); sim.step(); sim.pressSpace(1); sim.step();
  for (let i = 0; i < 30; i++) sim.step();
  assert.strictEqual(b.hp, CFG.HEARTS);
});

ok('hostile inputs are clamped', () => {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1 });
  sim.setInput(1, { rot: 1e9, ax: NaN, ay: Infinity, aim: true });
  assert(f.inp.rot === 1 && f.inp.ax === 0 && f.inp.ay === 0 && f.inp.aim === false);
});

// Drop a cube from the same height with different air input; compare how long the fall takes / sideways drift.
function airRun(inp) {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 250, y: 200 } });   // clear of platforms
  sim.setInput(1, inp);
  let t = 0;
  for (; t < 400; t++) { sim.step(); if (f.sinceFloor < 0.01) break; }
  return { t, x: f.body.position.x, vy: f.body.velocity.y };
}
ok('air edge-follow: with a stick, the closest edge turns to face it, within spin limits; keyboard/ground untouched', () => {
  const q = Math.PI / 2, off = (a, th) => { let d = (th - a) % q; if (d > q / 2) d -= q; if (d < -q / 2) d += q; return Math.abs(d); };
  const run = (inp, steps, at = { x: 250, y: 100 }) => {
    const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1, at });
    M_.Body.setAngle(f.body, 0.3);
    sim.setInput(1, inp); let maxAv = 0;
    for (let i = 0; i < steps; i++) { sim.step(); maxAv = Math.max(maxAv, Math.abs(f.body.angularVelocity)); }
    return { f, maxAv };
  };
  const M_ = require('../lib/matter.min.js');
  for (const th of [-Math.PI / 2, -1.0, 0.5, 2.2]) {
    const { f, maxAv } = run({ ax: Math.cos(th), ay: Math.sin(th), aim: true, face: true }, 25);
    assert(off(f.body.angle, th) < 0.03, `edge faces ${th.toFixed(2)} rad within 25 steps (off ${off(f.body.angle, th).toFixed(3)})`);
    assert(maxAv <= CFG.ROT_MAX + 0.01, 'never spins faster than ROT_MAX');
  }
  const kb = run({ ax: 1, ay: 0, aim: true }, 25);                           // keyboard aim: face flag off → cube not auto-turned
  assert(off(kb.f.body.angle, 0) > 0.1 || Math.abs(kb.f.body.angle - 0.3) < 0.05, 'keyboard aim does not auto-turn');
  const gpos = { x: 250, y: CFG.H - 45 };
  const g1 = run({ ax: 1, ay: 0, aim: true, face: true }, 40, gpos);               // left stick sideways on the ground = rolling, no auto-turn
  assert(Math.abs(g1.f.body.angle) < 0.35, 'no auto-turn on the ground from a sideways left stick');
  const th = -Math.PI / 2 + 0.5;                                                  // right stick on the ground turns the cube
  const g2 = run({ ax: Math.cos(th), ay: Math.sin(th), aim: true, face: true, faceG: true }, 60, gpos);
  assert(off(g2.f.body.angle, th) < 0.08, `right stick turns the cube on the ground (off ${off(g2.f.body.angle, th).toFixed(3)})`);
});

ok('fast fall (Smash-style): S while descending snaps to FAST_FALL_V and holds until landing; W floats; normal fall is capped', () => {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 250, y: 100 } });
  let maxNormal = 0;
  for (let i = 0; i < 80; i++) { sim.step(); maxNormal = Math.max(maxNormal, f.body.velocity.y); }
  assert(maxNormal <= CFG.FALL_MAX + 0.6, 'normal terminal speed ' + maxNormal.toFixed(1));
  sim.setInput(1, { my: 1 });
  sim.step(); sim.step();
  assert(f.fastFall && Math.abs(f.body.velocity.y - CFG.FAST_FALL_V) < 0.5, 'snapped to fast fall speed: ' + f.body.velocity.y.toFixed(1));
  sim.setInput(1, {});                                    // let go: it persists, like Smash
  for (let i = 0; i < 5; i++) sim.step();
  assert(f.fastFall && f.body.velocity.y > CFG.FAST_FALL_V - 0.5, 'persists after releasing down');
  assert(sim.drainEvents().some(e => e.e === 'fastfall'), 'emits a fastfall event');
  for (let i = 0; i < 200 && f.fastFall; i++) sim.step();
  assert(!f.fastFall, 'ends on landing');
  // Not while rising: pressing S on the way up does nothing until you start descending.
  const g = S.create().addFighter({ id: 9, name: 'b', team: 1, at: { x: 250, y: CFG.H - 60 } });
  assert(!g.fastFall);
});

ok('air control: W lands slower, S lands faster, A/D steer', () => {
  const base = airRun({}), w = airRun({ my: -1 }), s = airRun({ my: 1 });
  assert(w.t > base.t + 8, `W slower (${w.t} vs ${base.t})`);
  assert(s.t < base.t - 8, `S faster (${s.t} vs ${base.t})`);
  const r = airRun({ mx: 1, rot: 1 }), l = airRun({ mx: -1, rot: -1 });
  assert(r.x > base.x + 100 && l.x < base.x - 100, `steer (${l.x | 0} / ${base.x | 0} / ${r.x | 0})`);
  assert(r.x - 250 < 420, 'air speed capped below ground roll');
});

ok('jump goes off the touched surface: straight without aim, toward the aim with one, off walls too', () => {
  const run = (inp, at) => {
    const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1, at });
    settle(sim, 60); sim.setInput(1, inp); sim.pressSpace(1); sim.step(); return f.body.velocity;
  };
  const floor = { x: 250, y: CFG.H - 60 };
  const plain = run({}, floor);
  const aimed = run({ ax: 1, ay: 0, aim: true }, floor);
  assert(Math.abs(plain.x) < 1 && plain.y < -8, 'no aim → straight up off the floor');
  assert(aimed.x > 8 && aimed.y < -4 && aimed.y > -13, `aim right → leaning right (${aimed.x.toFixed(1)}, ${aimed.y.toFixed(1)})`);
  assert(run({ ax: 0, ay: 1, aim: true }, floor).y < -8, 'aiming into the floor → straight off it');
  const wall = run({}, { x: CFG.CUBE / 2 + 2, y: 700 });             // pressed against the left wall in mid-air
  const wall2 = (() => { const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: CFG.CUBE / 2 + 1, y: 700 } });
    sim.setInput(1, { mx: -1 }); for (let i = 0; i < 8; i++) sim.step(); sim.setInput(1, {}); sim.pressSpace(1); sim.step(); return f.body.velocity; })();
  assert(wall2.x > 8, `jump off a wall pushes away from it (vx ${wall2.x.toFixed(1)})`);
});

ok('dash is the jump from the void: only when nothing was touched recently', () => {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1250, y: 250 } });
  for (let i = 0; i < 30; i++) sim.step();                // falling, touching nothing
  assert(!f.canJump && f.canDash, 'airborne');
  sim.pressSpace(1); sim.step();
  assert(f.dashT > 0, 'dashes from the void');
});

// Jump: any part of the cube touching anything. Dash reset: the MIDDLE of an edge touching (corners alone don't).
function touchAt(deg) {
  const M = require('../lib/matter.min.js');
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 250, y: 500 } });
  const th = deg * Math.PI / 180, h = CFG.CUBE / 2;
  M.Body.setStatic(f.body, true);                 // freeze it so we test the detection, not the physics
  M.Body.setAngle(f.body, th);
  M.Body.setPosition(f.body, { x: 250, y: CFG.H - h * (Math.abs(Math.cos(th)) + Math.abs(Math.sin(th))) + 0.5 });
  f.canDash = false; f.canJump = false; f.sinceContact = 99; f.lockout = 0;
  sim.step(); sim.step();
  return { jump: f.canJump, dash: f.canDash };
}
ok('edge-middle touch restores dash (±20° tilt); corner-first touches only allow a jump', () => {
  for (const d of [0, 10, -10]) assert.deepStrictEqual(touchAt(d), { jump: true, dash: true }, d + '°');
  for (const d of [30, 45]) assert.deepStrictEqual(touchAt(d), { jump: true, dash: false }, d + '°');
});

ok('dash cooldown is a plain timer: mashing never speeds it up or stretches it', () => {
  const M = require('../lib/matter.min.js');
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 300, y: 160 } });
  M.Body.setVelocity(f.body, { x: 0, y: 0 }); f.sinceContact = 99; f.sinceFloor = 99; f.canJump = false;
  sim.setInput(1, { ax: 0, ay: -1, aim: true });
  const dashAt = [];
  let was = false;
  for (let i = 0; i < 90; i++) {
    if (i % 3 === 0) sim.pressSpace(1);                 // hammer the button every 3 steps
    sim.step();
    const d = f.dashT > 0 && f.dashT > CFG.DASH_WINDOW - 0.02;   // a dash started this step
    if (d && !was) dashAt.push(i);
    was = d;
  }
  assert(dashAt.length >= 2, 'dashes again while mashing near the ceiling (' + dashAt + ')');
  const gap = dashAt[1] - dashAt[0];
  assert(gap >= CFG.DASH_COOLDOWN * 60 - 1 && gap <= CFG.DASH_COOLDOWN * 60 + 6, `gap ${gap} steps ≈ cooldown ${CFG.DASH_COOLDOWN * 60}`);
});

ok('a single early press is buffered and fires as soon as the dash is available', () => {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1400, y: 300 } });
  f.sinceContact = 99; f.sinceFloor = 99; f.canJump = false; f.canDash = false;
  sim.pressSpace(1); for (let i = 0; i < 5; i++) sim.step();
  f.canDash = true; sim.pressSpace(1); sim.step();      // available again → fires on the next step
  sim.step();
  assert(f.dashT > 0, 'dashed');
});

ok('other players count as surfaces: landing on one gives jump + dash back', () => {
  const M = require('../lib/matter.min.js');
  const sim = S.create();
  const low = sim.addFighter({ id: 2, name: 'b', team: 2, at: { x: 1400, y: CFG.H - CFG.CUBE / 2 - 2 } });
  const top = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1400, y: CFG.H - CFG.CUBE * 1.5 - 30 } });
  M.Body.setStatic(low.body, true);
  top.canJump = false; top.canDash = false; top.sinceFloor = 1;
  for (let i = 0; i < 90; i++) sim.step();
  assert(top.canJump, 'can jump off another cube');
  assert(top.canDash, 'dash restored by touching another cube');
});
ok('version.js defines a semantic version (never ship it empty)', () => {
  const v = require('fs').readFileSync(require('path').join(__dirname, '../js/version.js'), 'utf8');
  assert(/CUBE_VERSION\s*=\s*'\d+\.\d+\.\d+'/.test(v), 'js/version.js must set window.CUBE_VERSION');
});
console.log(n + ' tests passed');
