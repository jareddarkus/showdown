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
ok('air control: W lands slower, S lands faster, A/D steer', () => {
  const base = airRun({}), w = airRun({ ay: -1, aim: true }), s = airRun({ ay: 1, aim: true });
  assert(w.t > base.t + 8, `W slower (${w.t} vs ${base.t})`);
  assert(s.t < base.t - 8, `S faster (${s.t} vs ${base.t})`);
  const r = airRun({ ax: 1, rot: 1, aim: true }), l = airRun({ ax: -1, rot: -1, aim: true });
  assert(r.x > base.x + 100 && l.x < base.x - 100, `steer (${l.x | 0} / ${base.x | 0} / ${r.x | 0})`);
  assert(r.x - 250 < 300, 'air speed capped below ground roll');
});

// Dash reset = middle of an edge touches a surface; corners alone don't count.
function resetAt(deg) {
  const M = require('../lib/matter.min.js');
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 250, y: 500 } });
  const th = deg * Math.PI / 180, h = CFG.CUBE / 2;
  M.Body.setStatic(f.body, true);                 // freeze it so we test the detection, not the physics
  M.Body.setAngle(f.body, th);
  M.Body.setPosition(f.body, { x: 250, y: CFG.H - h * (Math.abs(Math.cos(th)) + Math.abs(Math.sin(th))) + 0.5 });
  f.canDash = false; f.lockout = 0; f.flatT = -1;
  sim.step(); sim.step();
  return f.canDash;
}
ok('dash reset: flat edge and small tilts reset; corner-first (30°, 45°) does not', () => {
  assert.strictEqual(resetAt(0), true, '0°');
  assert.strictEqual(resetAt(10), true, '10°');
  assert.strictEqual(resetAt(-10), true, '-10°');
  assert.strictEqual(resetAt(30), false, '30°');
  assert.strictEqual(resetAt(45), false, '45°');
});
console.log(n + ' tests passed');
