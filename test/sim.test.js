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
ok('hearts: hearts shown are fractional-safe (private state), public snapshot still has none', () => {
  const sim = S.create();
  const a = sim.addFighter({ id: 1, name: 'a', team: 1 }), b = sim.addFighter({ id: 2, name: 'b', team: 2 });
  settle(sim); strike(sim, a, b);
  const t0 = sim.time; while (sim.time < t0 + 5.5) sim.step();
  assert.strictEqual(sim.privateState(2).hp, 2.5);
  assert(!/hp|heart/i.test(JSON.stringify(sim.snapshot())));
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
ok('ability: snapshot lists squares publicly (id, x, y, angle, scale, team); no hearts anywhere', () => {
  const { sim } = abSim();
  sim.useAbility(1, 'u'); for (let i = 0; i < 20; i++) sim.step();
  const sn = sim.snapshot();
  assert.strictEqual(sn.a.length, 1); assert.strictEqual(sn.a[0].length, 6);
  assert(!/hp|heart/i.test(JSON.stringify(sn)));
});
ok('ability: dying/leaving does not break the sim; a restart clears squares', () => {
  const keep = [CFG.MATCH_SECONDS, CFG.MATCH_OVER_SECONDS]; CFG.MATCH_SECONDS = 2; CFG.MATCH_OVER_SECONDS = 1;
  try {
    const { sim } = abSim(); sim.useAbility(1, 'u'); sim.removeFighter(1);
    for (let i = 0; i < 60 * 4; i++) sim.step();
    assert.strictEqual(sim.abilities.length, 0);
  } finally { [CFG.MATCH_SECONDS, CFG.MATCH_OVER_SECONDS] = keep; }
});

console.log(n + ' tests passed');
