// Run: node test/bots.test.js   (bot AI on the pure sim, no browser; deterministic via a seeded RNG)
const assert = require('assert');
const S = require('../js/sim.js');
const B = require('../js/bots.js');
const { CFG } = S;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

const lcg = seed => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
const FLOOR_Y = CFG.H - CFG.CUBE / 2 - 12;
const inArena = f => { const p = f.body.position; return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > -60 && p.x < CFG.W + 60 && p.y > -60 && p.y < CFG.H + 60; };

function threeVThree(seed, level, skills) {
  const sim = S.create();
  const bots = B.create(sim, { level, rng: lcg(seed) });
  bots.fill(CFG.TEAM_SIZE);
  if (skills) for (const id of bots.brains.keys()) bots.setSkill(id, skills[sim.fighters.get(id).team]);
  return { sim, bots };
}

ok('fill() makes a 3v3 of AI cubes that are flagged as bots (never counted as human players)', () => {
  const { sim } = threeVThree(1, 'normal');
  assert.strictEqual(sim.fighters.size, 6);
  assert.strictEqual(sim.teamCount(1) + sim.teamCount(2), 0, 'AI cubes must not count toward human team balance');
  assert([...sim.fighters.values()].every(f => f.bot && f.ai));
});

ok("level 'off': AI cubes stand still", () => {
  const { sim } = threeVThree(2, 'off');
  for (let i = 0; i < 120; i++) sim.step();
  const x0 = [...sim.fighters.values()].map(f => f.body.position.x);
  for (let i = 0; i < 600; i++) sim.step();
  [...sim.fighters.values()].forEach((f, i) => assert(Math.abs(f.body.position.x - x0[i]) < 5, 'moved while off'));
});

ok('a hard bot hunts down and hits an idle enemy', () => {
  const sim = S.create();
  const bots = B.create(sim, { level: 'hard', rng: lcg(3) });
  const idle = sim.addFighter({ id: 'idle', name: 'idle', team: 1, at: { x: 700, y: FLOOR_Y } });
  const ai = bots.add({ team: 2, at: { x: 2600, y: FLOOR_Y } });
  let hit = false;
  for (let i = 0; i < 60 * 40 && !hit; i++) { sim.step(); hit = ai.stats.hits > 0; }
  assert(hit, 'bot never landed a hit on a stationary target in 40 s');
});

ok('bots only ever hit the other team, the public snapshot never leaks private state, nobody escapes the arena (3v3, 3 min)', () => {
  const { sim } = threeVThree(4, 'normal');
  let hits = 0;
  for (let i = 0; i < 60 * 180; i++) {
    sim.step();
    for (const f of sim.fighters.values()) if (f.alive) assert(inArena(f), 'cube left the arena at step ' + i);
    if (i % 30 === 0) for (const ev of sim.drainEvents()) {
      if (ev.e === 'hit') { hits++; assert.notStrictEqual(sim.fighters.get(ev.by).team, sim.fighters.get(ev.id).team, 'friendly fire'); }
    }
  }
  assert(hits >= 30, 'expected a lively match, got ' + hits + ' hits');
  assert(sim.score[1] > 0 && sim.score[2] > 0, 'both teams should score: ' + JSON.stringify(sim.score));
  assert(!/dash|jump|cooldown/i.test(JSON.stringify(sim.snapshot())), 'snapshot must never contain private state');
});

ok('dead bots respawn and keep playing', () => {
  const { sim } = threeVThree(5, 'hard');
  for (let i = 0; i < 60 * 90; i++) sim.step();
  const respawned = [...sim.fighters.values()].filter(f => f.rs > 0).length;
  assert(respawned >= 3, 'only ' + respawned + ' cubes ever respawned');
  assert([...sim.fighters.values()].filter(f => f.alive).length >= 3);
});

ok('bots use the flip reset: they regain the dash on blocks/walls mid-air (resets > 0)', () => {
  const { sim } = threeVThree(6, 'hard');
  for (let i = 0; i < 60 * 120; i++) sim.step();
  const resets = [...sim.fighters.values()].reduce((a, f) => a + f.stats.resets, 0);
  assert(resets >= 20, 'expected plenty of dash resets, got ' + resets);
});

ok('skill matters: hard beats easy and normal beats easy (alternating sides, 8 seeded matches each)', () => {
  const play = (hi, lo, seed) => {
    const sideHi = seed % 2 ? 1 : 2;
    const { sim } = threeVThree(100 + seed, 'normal', sideHi === 1 ? { 1: hi, 2: lo } : { 1: lo, 2: hi });
    for (let i = 0; i < 60 * 120; i++) sim.step();
    return { hi: sim.score[sideHi], lo: sim.score[3 - sideHi] };
  };
  for (const [hi, lo] of [[0.9, 0.3], [0.6, 0.3]]) {
    let kh = 0, kl = 0, wins = 0;
    for (let seed = 1; seed <= 8; seed++) { const r = play(hi, lo, seed); kh += r.hi; kl += r.lo; if (r.hi > r.lo) wins++; }
    assert(wins >= 7 && kh > kl * 1.2, `skill ${hi} vs ${lo}: stronger won ${wins}/8, kills ${kh}–${kl}`);
  }
});

ok('a hosted match without bots is unaffected (bots only exist if you create them)', () => {
  const sim = S.create();
  sim.addFighter({ id: 0, name: 'a', team: 1 }); sim.addFighter({ id: 1, name: 'b', team: 2 });
  for (let i = 0; i < 300; i++) sim.step();
  assert([...sim.fighters.values()].every(f => !f.bot && !f.ai));
  assert.strictEqual(sim.beforeStep, null);
});

console.log(n + ' bot tests passed');
