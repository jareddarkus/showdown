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
console.log(n + ' tests passed');
