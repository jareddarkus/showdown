// Run: node test/sim.test.js   (pure sim, no browser)
const assert = require('assert');
const S = require('../js/sim.js');
const { CFG } = S;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

const settle = (sim, steps = 120) => { for (let i = 0; i < steps; i++) sim.step(); };

ok('snapshot publishes each cube\'s class and hearts (damaged cubes show them) but never private state', () => {
  const sim = S.create();
  sim.addFighter({ id: 1, name: 'a', team: 1 }); sim.addFighter({ id: 2, name: 'b', team: 2, cls: 'titan' });
  settle(sim);
  const sn = sim.snapshot();
  assert.deepStrictEqual(sn.f.map(r => r.length), [8, 8], 'row = [id, x, y, angle, alive, rs, class, hearts]');
  assert.deepStrictEqual(sn.f.map(r => [r[6], r[7]]), [[0, 3], [1, 5]], 'class ids and full hearts');
  assert(!/dash|jump|cooldown|ability/i.test(JSON.stringify(sn.f)), 'no private flags in fighter rows');
  assert.deepStrictEqual(Object.keys(sim.privateState(1)).sort(), ['ab', 'abMax', 'alive', 'cls', 'dash', 'dashT', 'dx', 'dy', 'hp', 'jump', 'max']);
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
ok('analog turning is proportional: a gentle push spins/steers gently, a full push fully', () => {
  const roll = rot => { const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 200, y: 1048 } });
    for (let i = 0; i < 60; i++) sim.step(); const x0 = f.body.position.x; sim.setInput(1, { rot, mx: rot }); for (let i = 0; i < 70; i++) sim.step(); return f.body.position.x - x0; };
  const lo = roll(0.25), mid = roll(0.5), hi = roll(1);
  assert(lo > 20 && lo < mid && mid < hi, `ground roll grows with the push (${lo | 0} < ${mid | 0} < ${hi | 0})`);
  assert(lo < hi * 0.55, 'a quarter push is well under half a full push');
  const drift = mx => { const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 60, y: 200 } });
    sim.setInput(1, { mx, rot: mx }); for (let i = 0; i < 600; i++) { sim.step(); if (f.sinceContact < 0.01) break; } return f.body.position.x - 60; };
  const d1 = drift(0.3), d2 = drift(1);
  assert(d1 > 15 && d1 < d2 * 0.6, `air steering scales with the stick (${d1 | 0} vs ${d2 | 0})`);
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

ok('my edge on another cube gives THAT cube a free dash reset, even if it only touches me with a corner (enemy or ally)', () => {
  const M = require('../lib/matter.min.js');
  const run = (aDeg, bDeg, team) => {
    const sim = S.create();
    const a = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1400, y: 300 } });
    const b = sim.addFighter({ id: 2, name: 'b', team, at: { x: 1600, y: 300 } });
    M.Body.setStatic(a.body, true); M.Body.setStatic(b.body, true);
    M.Body.setAngle(a.body, aDeg * Math.PI / 180); M.Body.setAngle(b.body, bDeg * Math.PI / 180);
    M.Body.setPosition(a.body, { x: 1400, y: 300 });
    // b sits to the right of a; b is a diamond (45°) when it should touch a with a corner.
    const reach = bDeg === 45 ? CFG.CUBE / Math.SQRT2 : CFG.CUBE / 2;
    M.Body.setPosition(b.body, { x: 1400 + CFG.CUBE / 2 + reach - 0.6, y: 300 });
    a.canDash = false; b.canDash = false; a.lockout = 0; b.lockout = 0;
    sim.step(); sim.step();
    return { a: a.canDash, b: b.canDash };
  };
  assert.deepStrictEqual(run(0, 45, 2), { a: true, b: true }, 'a edge → b corner (enemy): both get a reset');
  assert.deepStrictEqual(run(0, 45, 1), { a: true, b: true }, 'same for an ally');
  assert.deepStrictEqual(run(45, 45, 2), { a: false, b: false }, 'corner on corner: nobody gets one');
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

// ───────────── hearts regeneration ─────────────
// One real dash hit: `a` jumps+dashes into `b` standing 90 px away.
function strike(sim, a, b) {
  sim.setInput(a.id, { ax: 1, ay: 0, aim: true });
  Matter_set(a, 1000, CFG.H - 40); Matter_set(b, 1090, CFG.H - 40);
  a.canDash = true; a.canJump = true; a.dashCd = 0;
  sim.pressSpace(a.id); sim.step(); sim.pressSpace(a.id); sim.step();
  for (let i = 0; i < 25; i++) sim.step();
}
ok('hearts: after a hit, +0.5 after 5 s of quiet, then +0.5 every 2 s, capped at 3', () => {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1 }), b = sim.addFighter({ id: 2, name: 'b', team: 2 });
  settle(sim);
  strike(sim, a, b);
  assert.strictEqual(b.hp, 2, 'hit takes a full heart');
  const t0 = b.regenAt - CFG.REGEN_DELAY;                       // when it was hit
  const until = t => { while (sim.time < t0 + t) sim.step(); };
  until(4.9); assert.strictEqual(b.hp, 2, 'nothing back before 5 s');
  until(5.2); assert.strictEqual(b.hp, 2.5, 'first half heart at 5 s');
  until(6.8); assert.strictEqual(b.hp, 2.5, 'nothing again until 2 s later');
  until(7.2); assert.strictEqual(b.hp, 3, 'second half heart 2 s later');
  until(15); assert.strictEqual(b.hp, 3, 'never above 3');
});
ok('hearts: getting hit again restarts the 5 s wait', () => {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1 }), b = sim.addFighter({ id: 2, name: 'b', team: 2 });
  settle(sim);
  strike(sim, a, b);
  const t0 = sim.time;
  while (sim.time < t0 + 4) sim.step();                          // 4 s into the wait …
  strike(sim, a, b);                                             // … hit again
  assert.strictEqual(b.hp, 1);
  const t1 = b.regenAt - CFG.REGEN_DELAY;                        // moment of the second hit
  while (sim.time < t1 + 4.8) sim.step();
  assert.strictEqual(b.hp, 1, 'still waiting: the 5 s started over');
  while (sim.time < t1 + 5.3) sim.step();
  assert.strictEqual(b.hp, 1.5);
});
ok('hearts: half hearts show up in both the private state and the public snapshot row', () => {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1 }), b = sim.addFighter({ id: 2, name: 'b', team: 2 });
  settle(sim); strike(sim, a, b);
  const t0 = sim.time; while (sim.time < t0 + 5.5) sim.step();
  assert.strictEqual(sim.privateState(2).hp, 2.5);
  assert.strictEqual(sim.snapshot().f.find(r => r[0] === 2)[7], 2.5, 'the public row shows the half heart too');
});

// ───────────── the 3-minute match ─────────────
ok('match: 3 minutes by default, snapshot carries [seconds left, over, winner]', () => {
  assert.strictEqual(CFG.MATCH_SECONDS, 180);
  const sim = S.create(); sim.addFighter({ id: 1, name: 'a', team: 1 });
  sim.step();
  const m = sim.snapshot().m;
  assert(m[0] > 179.9 && m[0] <= 180 && m[1] === 0 && m[2] === 0, JSON.stringify(m));
});
ok('match: ends with a winner, freezes damage, shows the result, then restarts fresh', () => {
  const keep = [CFG.MATCH_SECONDS, CFG.MATCH_OVER_SECONDS];
  CFG.MATCH_SECONDS = 3; CFG.MATCH_OVER_SECONDS = 2;
  try {
    const sim = S.create();
    const a = sim.addFighter({ id: 1, name: 'a', team: 1 }), b = sim.addFighter({ id: 2, name: 'b', team: 2 });
    settle(sim, 30);
    sim.score[1] = 4; sim.score[2] = 2;                          // team 1 ahead
    sim.drainEvents();
    while (!sim.match.over) sim.step();
    assert(sim.time > 2.9 && sim.time < 3.3, 'ends after ~3 s, was ' + sim.time);
    assert.strictEqual(sim.match.winner, 1);
    const end = sim.drainEvents().find(e => e.e === 'end');
    assert(end && end.winner === 1 && end.s[0] === 4);
    strike(sim, a, b);
    assert.strictEqual(b.hp, CFG.HEARTS, 'no damage once the match is over');
    while (sim.match.over) sim.step();
    assert(sim.drainEvents().some(e => e.e === 'start'));
    assert.deepStrictEqual([sim.score[1], sim.score[2]], [0, 0]);
    assert(sim.match.left > 2.9 && !sim.match.over);
    assert(a.alive && b.alive && b.hp === CFG.HEARTS);
  } finally { [CFG.MATCH_SECONDS, CFG.MATCH_OVER_SECONDS] = keep; }
});
ok('match: a tie is a draw (winner 0)', () => {
  const keep = CFG.MATCH_SECONDS; CFG.MATCH_SECONDS = 1;
  try { const sim = S.create(); sim.addFighter({ id: 1, name: 'a', team: 1 }); for (let i = 0; i < 80; i++) sim.step(); assert(sim.match.over && sim.match.winner === 0); }
  finally { CFG.MATCH_SECONDS = keep; }
});

// ───────────── arrow-key ability squares ─────────────
const abSim = (x = 1000) => {
  const sim = S.create();
  const f = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x, y: CFG.H - 60 } });
  settle(sim);
  return { sim, f };
};
ok('ability: spawns beside you (left/right/above/below), a little smaller than a cube', () => {
  assert(CFG.ABILITY_SIZE < CFG.CUBE && CFG.ABILITY_SIZE >= CFG.CUBE * 0.7);
  for (const [dir, dx, dy] of [['l', -1, 0], ['r', 1, 0], ['u', 0, -1]]) {
    const { sim, f } = abSim();
    assert(sim.useAbility(1, dir), dir + ' should have room');
    const ab = sim.abilities[0], off = CFG.CUBE / 2 + CFG.ABILITY_SIZE / 2 + CFG.ABILITY_GAP;
    assert(Math.abs(ab.body.position.x - (f.body.position.x + dx * off)) < 1.5 && Math.abs(ab.body.position.y - (f.body.position.y + dy * off)) < 1.5, dir + ' position');
    assert.strictEqual(sim.drainEvents().filter(e => e.e === 'ability').length, 1);
  }
});
ok('ability: only if there is enough space (floor below, wall beside, existing square)', () => {
  const { sim, f } = abSim();
  assert(!sim.useAbility(1, 'd'), 'no room below: the floor is there');
  assert(sim.drainEvents().some(e => e.e === 'abfail'), 'a failed attempt is reported (for feedback)');
  assert.strictEqual(sim.abilities.length, 0);
  const wall = abSim(CFG.CUBE / 2 + 4);
  assert(!wall.sim.useAbility(1, 'l'), 'no room on the left: the wall is there');
  assert(wall.sim.useAbility(1, 'r'), 'room on the right');
  // the square it just made sits on the right, so a second one there (after the cooldown) has no room
  for (let i = 0; i < 40; i++) wall.sim.step();
  assert(!wall.sim.useAbility(1, 'r'), 'the first square is in the way');
});
ok('ability: grows 0.5 s ease-out with a small bounce, holds 2 s, shrinks back in 0.5 s, then disappears', () => {
  const { sim } = abSim();
  sim.useAbility(1, 'u');
  const ab = sim.abilities[0];
  const vis = [];
  for (let i = 0; i < 60 * 3.2 && sim.abilities.length; i++) { sim.step(); vis.push(ab.vis); }
  const at = t => vis[Math.round(t * 60) - 1];
  assert(at(0.1) > 0.1 && at(0.1) < 1, 'growing');
  assert(Math.max(...vis) > 1.02 && Math.max(...vis) < 1.12, 'a little bounce past full size: ' + Math.max(...vis).toFixed(3));
  assert(Math.abs(at(0.6) - 1) < 0.03 && Math.abs(at(2.4) - 1) < 1e-6, 'full size while it exists');
  assert(at(2.8) < 1 && at(2.99) < 0.2, 'shrinking away at the end');
  assert.strictEqual(sim.abilities.length, 0, 'gone after 3 s total');
  assert.strictEqual(sim.world.bodies.filter(b => b.ability).length, 0, 'body removed from the world');
});
ok('ability: it is a real physics body — it falls, rests, gets pushed, and has full-size collision once grown', () => {
  const { sim } = abSim();
  sim.useAbility(1, 'u');
  const ab = sim.abilities[0];
  for (let i = 0; i < 60; i++) sim.step();
  const w = ab.body.bounds.max.x - ab.body.bounds.min.x;
  assert(Math.abs(w - CFG.ABILITY_SIZE) < 1.5, 'full size collider: ' + w);
  assert(ab.body.position.y > CFG.H - 200, 'it fell down next to the cube (gravity applies)');
});
ok('ability: cooldown, and at most ABILITY_MAX alive per player', () => {
  const { sim } = abSim(1000);
  assert(sim.useAbility(1, 'u'));
  assert(!sim.useAbility(1, 'l'), 'cooldown');
  let made = 1;
  for (const d of ['l', 'r', 'u']) { for (let i = 0; i < 40; i++) sim.step(); if (sim.useAbility(1, d)) made++; }
  assert(made <= CFG.ABILITY_MAX && sim.abilities.length <= CFG.ABILITY_MAX, 'cap respected: ' + sim.abilities.length);
});
ok('ability: squares count as surfaces — touching one with the middle of an edge refills your dash', () => {
  const { sim } = abSim(1400);
  sim.useAbility(1, 'u');
  for (let i = 0; i < 90; i++) sim.step();                       // it fell and is resting somewhere beside you, fully grown
  const ab = sim.abilities[0], top = ab.body.bounds.min.y;
  const g = sim.addFighter({ id: 2, name: 'b', team: 1, at: { x: ab.body.position.x, y: top - CFG.CUBE / 2 - 25 } });
  g.canDash = false; g.sinceFloor = 1; g.canJump = false;
  for (let i = 0; i < 40; i++) sim.step();
  assert(g.canDash, 'landing flat on a square gives the dash back');
});
ok('ability: snapshot lists squares publicly (id, x, y, angle, scale, team, kind)', () => {
  const { sim } = abSim();
  sim.useAbility(1, 'u'); for (let i = 0; i < 20; i++) sim.step();
  const sn = sim.snapshot();
  assert.strictEqual(sn.a.length, 1); assert.strictEqual(sn.a[0].length, 7, '[id, x, y, angle, scale, team, kind]');
});
ok('ability: dying/leaving does not break the sim; a restart clears squares', () => {
  const keep = [CFG.MATCH_SECONDS, CFG.MATCH_OVER_SECONDS]; CFG.MATCH_SECONDS = 2; CFG.MATCH_OVER_SECONDS = 1;
  try {
    const { sim } = abSim(); sim.useAbility(1, 'u'); sim.removeFighter(1);
    for (let i = 0; i < 60 * 4; i++) sim.step();
    assert.strictEqual(sim.abilities.length, 0);
  } finally { [CFG.MATCH_SECONDS, CFG.MATCH_OVER_SECONDS] = keep; }
});


// ───────────── the dash only hurts with its leading edge ─────────────
const M2 = require('../lib/matter.min.js');
// A dashes right at 12 px/step for a few steps with B placed relative to A's centre (dx, dy). Returns B's hearts afterwards.
function sideSwipe(dx, dy) {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1, at: { x: 1000, y: 700 } });
  const b = sim.addFighter({ id: 2, name: 'b', team: 2, at: { x: 1000 + dx, y: 700 + dy } });
  M2.Body.setStatic(b.body, true);                                  // B just stands there
  a.dashT = 0.3; a.dashDir = { x: 1, y: 0 }; a.canDash = false;
  for (let i = 0; i < 14; i++) { M2.Body.setVelocity(a.body, { x: 12, y: 0 }); sim.step(); }
  return b.hp;
}
ok('dash zone: a head-on hit counts, but touching with the top / bottom of the dashing cube does not', () => {
  assert(sideSwipe(110, 0) < CFG.HEARTS, 'leading edge hits');
  assert(sideSwipe(0, -76) === CFG.HEARTS, 'B sits right above the dashing cube and its top edge slides under it: no damage');
  assert(sideSwipe(0, 76) === CFG.HEARTS, 'same from below: no damage');
  assert(sideSwipe(60, -70) < CFG.HEARTS, 'but catching B with the leading corner does count');
});
ok('dash zone: the hurting stretch is one edge long and slides around the outline as the cube turns (30% / 70% split)', () => {
  const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
  const flat = S.zonePolyline(0, 0, 80, 0, { x: 1, y: 0 });
  assert.strictEqual(flat.length, 2, 'dashing straight at a face: the zone is that face (no corner)');
  assert(Math.abs(len(flat) - 80) < 0.5 && flat.every(p => Math.abs(p[0] - 40) < 0.5), 'a straight line along the right edge');
  const tilted = S.zonePolyline(0, 0, 80, 20 * Math.PI / 180, { x: 1, y: 0 });
  assert.strictEqual(tilted.length, 3, 'a turned cube: the line wraps round a corner');
  const seg = [Math.hypot(tilted[1][0] - tilted[0][0], tilted[1][1] - tilted[0][1]), Math.hypot(tilted[2][0] - tilted[1][0], tilted[2][1] - tilted[1][1])];
  const share = Math.min(...seg) / (seg[0] + seg[1]);
  assert(share > 0.1 && share < 0.4 && Math.abs(seg[0] + seg[1] - 80) < 0.5, 'uneven split across the two edges: ' + seg.map(x => x.toFixed(1)));
  const diag = S.zonePolyline(0, 0, 80, Math.PI / 4, { x: 1, y: 0 });
  const dseg = [Math.hypot(diag[1][0] - diag[0][0], diag[1][1] - diag[0][1]), Math.hypot(diag[2][0] - diag[1][0], diag[2][1] - diag[1][1])];
  assert(Math.abs(dseg[0] - dseg[1]) < 1, 'dashing with a corner first: 50 / 50');
});

// ───────────── characters ─────────────
ok('characters: Cube 80 px / 3 hearts, Titan 112 px / 5 hearts, Mason 80 px / 3 hearts; bodies and hearts match', () => {
  const sim = S.create();
  const c = sim.addFighter({ id: 1, name: 'c', team: 1 }), t = sim.addFighter({ id: 2, name: 't', team: 1, cls: 'titan' }), m = sim.addFighter({ id: 3, name: 'm', team: 1, cls: 'mason' });
  const w = f => f.body.bounds.max.x - f.body.bounds.min.x;
  assert.deepStrictEqual([c, t, m].map(f => Math.round(w(f))), [80, 112, 80]);
  assert.deepStrictEqual([c, t, m].map(f => [f.maxHp, f.hp]), [[3, 3], [5, 5], [3, 3]]);
  settle(sim);
  assert(t.body.position.y < CFG.H - 112 / 2 + 1 && t.body.position.y > CFG.H - 112 / 2 - 14, 'the big one rests on the floor, not inside it');
});
ok('characters: the Titan is a little slower on the ground and in the air, and its dash hits longer and reaches further', () => {
  const run = cls => {
    const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1, cls, at: { x: 600, y: CFG.H - CFG.CLASSES[cls].size / 2 - 2 } });
    settle(sim, 60); const x0 = f.body.position.x; sim.setInput(1, { rot: 1 }); settle(sim, 60);
    const roll = f.body.position.x - x0;
    sim.setInput(1, { rot: 0 }); settle(sim, 90);
    sim.pressSpace(1); sim.step();                                  // jump
    const y0 = f.body.position.y; let top = y0; for (let i = 0; i < 40; i++) { sim.step(); top = Math.min(top, f.body.position.y); }
    sim.setInput(1, { ax: 1, ay: 0, aim: true }); sim.pressSpace(1); sim.step();
    const win = f.dashT, xs = f.body.position.x; const vx = f.body.velocity.x; for (let i = 0; i < 400 && f.dashT > 0; i++) sim.step();
    return { roll, jump: y0 - top, win, reach: f.body.position.x - xs, vx };
  };
  const c = run('cube'), t = run('titan');
  assert(t.roll < c.roll && t.roll > c.roll * 0.6, `slower roll (${t.roll.toFixed(0)} vs ${c.roll.toFixed(0)})`);
  assert(t.win > c.win * 1.3 && t.win < c.win * 1.6, `dash window ${t.win.toFixed(2)} vs ${c.win.toFixed(2)}`);
  assert(t.reach > c.reach * 1.15, `dash covers more ground (${t.reach.toFixed(0)} vs ${c.reach.toFixed(0)})`);
  assert(t.vx < c.vx, 'but is launched a little slower');
});
ok('characters: choosing one takes effect at the next respawn (or immediately in practice)', () => {
  const sim = S.create(); const f = sim.addFighter({ id: 1, name: 'a', team: 1 }); settle(sim);
  sim.setClass(1, 'titan');
  assert.strictEqual(f.cls, 'cube', 'not mid-life');
  sim.respawn(1);
  assert.strictEqual(f.cls, 'titan'); assert.strictEqual(f.maxHp, 5); assert.strictEqual(Math.round(f.body.bounds.max.x - f.body.bounds.min.x), 112);
  settle(sim, 60); assert(f.body.position.y > CFG.H - 70, 'standing on the floor');
  sim.setClass(1, 'mason', true);
  assert.strictEqual(f.cls, 'mason'); assert.strictEqual(Math.round(f.body.bounds.max.x - f.body.bounds.min.x), 80);
  assert(!sim.setClass(1, 'nonsense'), 'unknown characters are refused');
  assert.strictEqual(f.cls, 'mason');
});
ok('characters: a Titan regenerates up to 5 hearts, and hit events tell everyone its max', () => {
  const sim = S.create(); const t = sim.addFighter({ id: 2, name: 't', team: 2, cls: 'titan', at: { x: 1090, y: CFG.H - 58 } }), a = sim.addFighter({ id: 1, name: 'a', team: 1 });
  settle(sim); sim.drainEvents(); t.hp = 5;
  Matter_set(a, 1000, CFG.H - 40); Matter_set(t, 1100, CFG.H - 58);
  sim.setInput(1, { ax: 1, ay: 0, aim: true }); a.canDash = true; a.canJump = true;
  sim.pressSpace(1); sim.step(); sim.pressSpace(1); sim.step(); for (let i = 0; i < 30; i++) sim.step();
  const ev = sim.drainEvents().find(e => e.e === 'hit');
  assert(ev && ev.max === 5 && ev.hp === 4, JSON.stringify(ev));
  const t0 = sim.time; while (sim.time < t0 + 5.3) sim.step();
  assert.strictEqual(t.hp, 4.5); while (sim.time < t0 + 7.5) sim.step(); assert.strictEqual(t.hp, 5);
});

// ───────────── Titan: heal a nearby ally ─────────────
ok('Titan ability: any arrow key heals the most hurt ally in range by 1 heart; cooldown 1.5 s', () => {
  const sim = S.create();
  const t = sim.addFighter({ id: 1, name: 't', team: 1, cls: 'titan', at: { x: 1000, y: CFG.H - 58 } });
  const a = sim.addFighter({ id: 2, name: 'a', team: 1, at: { x: 1200, y: CFG.H - 40 } });
  const b = sim.addFighter({ id: 3, name: 'b', team: 1, at: { x: 1300, y: CFG.H - 40 } });
  const e = sim.addFighter({ id: 4, name: 'e', team: 2, at: { x: 1100, y: CFG.H - 40 } });
  settle(sim); a.hp = 2; b.hp = 1; e.hp = 1; for (const f of [a, b, e]) f.regenAt = 1e9; sim.drainEvents();      // (regen frozen so only the heal moves hearts)
  assert(sim.useAbility(1, 'u'), 'any key works');
  assert.strictEqual(b.hp, 2, 'the most hurt ally got the heart'); assert.strictEqual(a.hp, 2); assert.strictEqual(e.hp, 1, 'enemies are never healed');
  const ev = sim.drainEvents().find(x => x.e === 'heal'); assert(ev && ev.to === 3 && ev.hp === 2);
  assert.strictEqual(sim.privateState(1).ab > 1.4, true, 'cooldown started'); assert.strictEqual(sim.privateState(1).abMax, 1.5);
  assert(!sim.useAbility(1, 'l'), 'still cooling down');
  const t0 = sim.time; while (sim.time < t0 + 1.6) sim.step();
  assert(sim.useAbility(1, 'r')); assert.strictEqual(a.hp, 3, 'a and b are both at 2 now: the closer one (a) is healed next');
  assert.strictEqual(b.hp, 2, 'one heal per press');
});
ok('Titan ability: out of range / full health / enemies only → nothing happens and no cooldown is spent; never above max', () => {
  const sim = S.create();
  const t = sim.addFighter({ id: 1, name: 't', team: 1, cls: 'titan', at: { x: 600, y: CFG.H - 58 } });
  const far = sim.addFighter({ id: 2, name: 'far', team: 1, at: { x: 600 + CFG.HEAL_RANGE + 80, y: CFG.H - 40 } });
  settle(sim); far.hp = 1; far.regenAt = 1e9; sim.drainEvents();
  assert(!sim.useAbility(1, 'u'), 'ally too far'); assert.strictEqual(far.hp, 1);
  assert(sim.drainEvents().some(e => e.e === 'noheal'), 'a failed attempt is reported');
  assert.strictEqual(t.abCd, 0, 'no cooldown for a miss');
  const near = sim.addFighter({ id: 3, name: 'near', team: 1, at: { x: 800, y: CFG.H - 40 } }); settle(sim, 5);
  assert(!sim.useAbility(1, 'u'), 'ally at full health');
  near.hp = 2.5; near.regenAt = 1e9; assert(sim.useAbility(1, 'u')); assert.strictEqual(near.hp, 3, 'capped at the ally\'s max');
});

// ───────────── Mason: static black blocks ─────────────
ok('Mason ability: arrow keys spawn a STATIC black block (kind 1) that stays put, with the same grow / hold / shrink timing', () => {
  const sim = S.create(); const m = sim.addFighter({ id: 1, name: 'm', team: 1, cls: 'mason', at: { x: 1000, y: CFG.H - 60 } }); settle(sim);
  assert(sim.useAbility(1, 'u'));
  const ab = sim.abilities[0]; assert.strictEqual(ab.kind, 1); assert(ab.body.isStatic, 'static: not physics-based');
  const y0 = ab.body.position.y;
  const vis = []; for (let i = 0; i < 60 * 3.1 && sim.abilities.length; i++) { sim.step(); vis.push(ab.vis); }
  assert.strictEqual(ab.body.position.y, y0, 'it never moved (no gravity)');
  assert(Math.max(...vis) > 1.02 && Math.max(...vis) < 1.12 && vis[Math.round(1.5 * 60)] === 1, 'same animation');
  assert.strictEqual(sim.abilities.length, 0, 'gone after ~3 s');
  assert.strictEqual(sim.snapshot().a.length, 0);
});
ok('Mason ability: a static block is solid — a cube standing on it gets its jump + dash back, and nothing can push it', () => {
  const sim = S.create(); const m = sim.addFighter({ id: 1, name: 'm', team: 1, cls: 'mason', at: { x: 1000, y: CFG.H - 60 } }); settle(sim);
  sim.useAbility(1, 'l'); for (let i = 0; i < 40; i++) sim.step();
  const ab = sim.abilities[0], top = ab.body.bounds.min.y, x = ab.body.position.x;
  const g = sim.addFighter({ id: 2, name: 'g', team: 2, at: { x, y: top - 40 - 25 } }); g.canDash = false; g.sinceFloor = 1;
  for (let i = 0; i < 40; i++) sim.step();
  assert(g.canDash, 'landing on a Mason block refills the dash'); assert.strictEqual(Math.round(ab.body.position.x), Math.round(x));
});
ok('abilities: cooldown values per character are public in the private state (Cube 0.5 s, Mason 0.5 s, Titan 1.5 s)', () => {
  const sim = S.create();
  for (const [i, c] of ['cube', 'mason', 'titan'].entries()) sim.addFighter({ id: i + 1, name: c, team: 1, cls: c });
  assert.deepStrictEqual([1, 2, 3].map(id => sim.privateState(id).abMax), [0.5, 0.5, 1.5]);
});

console.log(n + ' tests passed');
