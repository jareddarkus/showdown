/* Cube League — bot AI. Pure logic on top of CubeSim (no DOM); runs in the browser (solo/host) and in Node (tests).
 *
 * A bot plays through exactly the same interface as a human client — sim.setInput(id, {rot,mx,my,ax,ay,aim}) and
 * sim.pressSpace(id) — so it can't do anything a player can't. It reads positions/velocities, which enemies are
 * mid-dash, and the block layout. It never looks at anyone's hearts.
 *
 * Skill (0..1) scales:
 *   • lead aim      predicts where the target will be when the dash lands (gravity included)
 *   • aim error     Gaussian noise on the dash angle
 *   • think time    how often it re-decides, and its reaction time to an incoming dash (+ whether it reacts at all)
 *   • strike range  weaker bots wait for a closer shot
 * Behaviours, in priority order:
 *   strike   jump → dash at the predicted position when in range with a clear line
 *   travel   bunny-hop (jump + upward-arcing dash) when far away and roughly level — landings refill the dash
 *   hop      dash at a nearby floating block that gets it closer to the target (edge-middle contact = dash reset)
 *   unstick  hemmed in / not moving: pop up and dash over the obstacle
 *   chase    roll (ground) or steer (air) toward the target
 *   dodge    (any time) an enemy dash is coming through me: jump / dash sideways after the reaction time
 * In the air a bot spins to the nearest 90° so that whatever it touches meets the middle of an edge (= dash reset).
 */
(function (root) {
  'use strict';
  const M = root.Matter || (typeof require === 'function' ? require('../lib/matter.min.js') : null);
  const S = root.CubeSim || (typeof require === 'function' ? require('./sim.js') : null);
  const { CFG, STEP_MS } = S;

  const LEVELS = { off: 0, easy: 0.3, normal: 0.6, hard: 0.9 };
  const LEVEL_ORDER = ['off', 'easy', 'normal', 'hard'];
  const G_STEP = CFG.GRAVITY_SCALE * STEP_MS * STEP_MS;       // gravity in px/step² (≈0.44)
  const DASH_REACH = CFG.DASH_V * CFG.DASH_WINDOW * 60;        // ≈252 px a dash covers while its hit window is open

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const norm = (x, y) => { const m = Math.hypot(x, y) || 1; return { x: x / m, y: y / m }; };

  function create(sim, opts = {}) {
    const rng = opts.rng || Math.random;
    const gauss = () => (rng() + rng() + rng() - 1.5) * 2;       // ≈ N(0,1)
    const brains = new Map();                                    // fighter id -> brain
    let level = opts.level in LEVELS ? opts.level : 'normal';
    let seq = 0;

    function newBrain(f) {
      const b = {
        skill: 0.6, jitter: (rng() - 0.5) * 0.12, think: 0.2, react: 0.12, nextThink: 0, queue: [], target: null,
        roll: 0, steer: 0, mode: 'idle', threatSince: -1, reactRoll: true, dodgeCool: 0, hopCool: 0,
        lastPos: { x: f.body.position.x, y: f.body.position.y }, lastCheck: 0, aimOn: false, aim: { x: 1, y: 0 }, rs: f.rs,
      };
      setSkillOn(b, LEVELS[level] + b.jitter);
      return b;
    }
    function setSkillOn(b, skill) {
      b.skill = clamp(skill, 0.05, 0.98);
      b.think = 0.10 + (1 - b.skill) * 0.35;       // how often it re-decides
      b.react = 0.025 + (1 - b.skill) * 0.27;      // how long before it notices an incoming dash
      b.queue.length = 0; b.nextThink = 0;
    }

    // ───────────── perception helpers ─────────────
    // Is the straight corridor between two points free of floating blocks?
    function clearPath(from, to, ignore, width = 64) {
      for (const h of M.Query.ray(sim.solidBodies, from, to, width)) if (h.body !== ignore) return false;
      return true;
    }

    // Dash aim that leads a moving target (and accounts for its fall), with skill-scaled error.
    function leadAim(f, who, s) {
      const p = f.body.position, T = who.body.position, tv = who.body.velocity;
      const falling = who.sinceFloor > 0.1 && who.dashT <= 0;
      const lead = 0.3 + 0.7 * s;
      let tt = Math.min(16, Math.hypot(T.x - p.x, T.y - p.y) / CFG.DASH_V), tx = T.x, ty = T.y;
      for (let i = 0; i < 3; i++) {
        tx = T.x + tv.x * tt * lead;
        ty = T.y + tv.y * tt * lead + (falling ? 0.5 * G_STEP * tt * tt * lead : 0);
        tt = Math.min(16, Math.hypot(tx - p.x, ty - p.y) / CFG.DASH_V);
      }
      const a = Math.atan2(ty - p.y, tx - p.x) + gauss() * (1 - s) * 0.55;
      return { x: Math.cos(a), y: Math.sin(a) };
    }

    // Best floating block to dash at: close, reachable in a straight line, and gets us nearer the target.
    function pickWaypoint(f, T) {
      const p = f.body.position, cur = Math.hypot(T.x - p.x, T.y - p.y);
      let best = null, bestScore = 0;
      for (const w of sim.solidBodies) {
        const { min, max } = w.bounds;
        const q = { x: clamp(p.x, min.x, max.x), y: clamp(p.y, min.y, max.y) };       // nearest point on the block
        const dist = Math.hypot(q.x - p.x, q.y - p.y);
        if (dist < 100 || dist > DASH_REACH - 10) continue;
        const e = { x: clamp(T.x, min.x - 40, max.x + 40), y: clamp(T.y, min.y - 50, max.y + 50) };
        const gain = cur - Math.hypot(T.x - e.x, T.y - e.y);                             // progress toward the target
        if (gain < 90 || !clearPath(p, q, w, 56)) continue;
        const score = gain - dist * 0.3;
        if (score > bestScore) { bestScore = score; best = q; }
      }
      return best;
    }

    // ───────────── actions ─────────────
    // Space does ONE thing per press: touched anything within COYOTE → jump; otherwise → dash. So from a surface a dash
    // is always "jump, then dash a moment later"; from the air it's just the dash.
    function go(f, bt, now, dashSpec, jumpDelay) {
      if (f.canJump) bt.queue.push({ at: now + 0.02, kind: 'jump' }, { at: now + jumpDelay, kind: 'dash', ...dashSpec });
      else bt.queue.push({ at: now + (dashSpec.delay || 0), kind: 'dash', ...dashSpec });
    }

    function runAction(f, bt, a, now) {
      if (a.kind === 'jump') {
        if (f.canJump) { bt.aimOn = false; sim.pressSpace(f.id); } else bt.queue.length = 0;
        return;
      }
      // dash
      if (!f.canDash || f.canJump) { bt.queue.length = 0; return; }       // a press now would jump (or do nothing): abort the combo
      if (f.dashCd > 0) { if ((a.tries = (a.tries || 0) + 1) > 12) bt.queue.length = 0; else { a.at = now + 0.02; bt.queue.unshift(a); } return; }
      let aim = a.aim;
      if (a.point) aim = norm(a.point.x - f.body.position.x, a.point.y - f.body.position.y);
      if (a.who) {
        const t = a.who;
        const d = t.alive ? Math.hypot(t.body.position.x - f.body.position.x, t.body.position.y - f.body.position.y) : 1e9;
        if (d > strikeRange(bt.skill) + 150) { bt.queue.length = 0; return; }   // target slipped away — don't waste the dash
        aim = leadAim(f, t, bt.skill);
      }
      if (a.who) bt.strikes = (bt.strikes || 0) + 1;
      bt.aim = aim; bt.aimOn = true;
      sim.pressSpace(f.id);
    }

    const strikeRange = s => 170 + 100 * s;      // centre-to-centre distance at which a bot will commit to a dash

    function threats(f, bt, now) {
      const p = f.body.position, s = bt.skill;
      let th = null;
      for (const e of sim.fighters.values()) {
        if (!e.alive || e.team === f.team || e.dashT <= 0) continue;
        const ep = e.body.position, dd = e.dashDir;
        const rx = p.x - ep.x, ry = p.y - ep.y;
        const along = rx * dd.x + ry * dd.y, perp = rx * dd.y - ry * dd.x;
        if (along > -20 && along < DASH_REACH + 90 && Math.abs(perp) < 100) { th = { dd, rx, ry, perp }; break; }
      }
      if (!th) { bt.threatSince = -1; return; }
      if (bt.threatSince < 0) { bt.threatSince = now; bt.reactRoll = rng() < 0.2 + 0.8 * s; }
      if (!bt.reactRoll || now - bt.threatSince < bt.react || now < bt.dodgeCool) return;

      // Dodge: leave the dash line sideways (prefer up); jump first if touching something.
      bt.dodgeCool = now + 0.7;
      f.dodges = (f.dodges || 0) + 1;
      let n = { x: -th.dd.y, y: th.dd.x };
      if (Math.abs(th.perp) < 25) { if (n.y > 0) n = { x: -n.x, y: -n.y }; }
      else if (n.x * th.rx + n.y * th.ry < 0) n = { x: -n.x, y: -n.y };
      if (!clearPath(p, { x: p.x + n.x * 170, y: p.y + n.y * 170 }, null, 70)) n = { x: -n.x, y: -n.y };
      bt.queue.length = 0; bt.mode = 'dodge';
      if (f.canJump) {
        bt.aimOn = false; sim.pressSpace(f.id);                                              // hop out of the way now …
        if (f.canDash) bt.queue.push({ at: now + 0.05, kind: 'dash', aim: norm(n.x, Math.min(n.y, -0.2)) });   // … then dash clear
      } else if (f.canDash) {
        bt.queue.push({ at: now, kind: 'dash', aim: n });
      }
    }

    function decide(f, bt, now) {
      const s = bt.skill, p = f.body.position;
      const grounded = f.sinceFloor < 0.05;

      // Target: nearest enemy, sticky so it doesn't flip-flop between two.
      let best = null, bd = Infinity;
      for (const o of sim.fighters.values()) {
        if (!o.alive || o.team === f.team) continue;
        const d = Math.hypot(o.body.position.x - p.x, o.body.position.y - p.y) - (o === bt.target ? 180 : 0);
        if (d < bd) { bd = d; best = o; }
      }
      bt.target = best; bt.mode = 'idle';

      // Stuck guard (checked once a second).
      let stuck = false;
      if (now - bt.lastCheck > 1.0) {
        stuck = Math.hypot(p.x - bt.lastPos.x, p.y - bt.lastPos.y) < 30;
        bt.lastCheck = now; bt.lastPos = { x: p.x, y: p.y };
      }
      if (!best) { bt.roll = 0; bt.steer = 0; return; }

      const T = best.body.position;
      const dx = T.x - p.x, dy = T.y - p.y, d = Math.hypot(dx, dy);
      const los = clearPath(p, T, null);
      bt.roll = Math.abs(dx) > 40 ? Math.sign(dx) : 0;
      bt.steer = Math.abs(dx) > 50 ? clamp(dx / 250, -1, 1) : 0;
      if (bt.queue.length) { bt.mode = 'busy'; return; }

      const ready = f.canDash;
      const range = strikeRange(s);

      // 1. Strike: close enough with a clear line.
      if (ready && los && d < range + (f.canJump ? 50 : 0)) {
        bt.mode = 'strike';
        go(f, bt, now, { who: best, delay: (1 - s) * 0.10 }, 0.10 + (1 - s) * 0.18 + rng() * 0.05);
        return;
      }
      // 2. Far away, roughly level: bunny-hop. The upward arc also carries us over low blocks; line of sight is ignored.
      if (ready && grounded && f.canJump && s >= 0.4 && d > 520 && Math.abs(dx) > 380 && Math.abs(dy) < 280) {
        bt.mode = 'travel';
        go(f, bt, now, { aim: norm(Math.sign(dx), -0.42) }, 0.14);
        return;
      }
      // 3. Blocked or target above us: hop between floating blocks (each edge-middle touch refills the dash).
      if (ready && s >= 0.35 && now >= bt.hopCool && (!los || dy < -240)) {
        const w = pickWaypoint(f, T);
        if (w) {
          bt.mode = 'hop'; bt.hopCool = now + 0.45;
          go(f, bt, now, { point: w }, 0.13 + (1 - s) * 0.1);
          return;
        }
      }
      // 4. Not getting anywhere (or hemmed in by a block): pop up and dash up and over toward the target.
      if ((stuck || (!los && d < 520)) && ready && grounded && now >= bt.hopCool) {
        bt.mode = 'unstick'; bt.hopCool = now + 0.6;
        go(f, bt, now, { aim: norm(dx, Math.min(dy, 0) - 160) }, 0.12);
        return;
      }
      bt.mode = 'chase';
    }

    function think(f, bt, now) {
      if (bt.rs !== f.rs) { bt.rs = f.rs; bt.queue.length = 0; bt.nextThink = 0; bt.threatSince = -1; bt.aimOn = false; }
      const grounded = f.sinceFloor < 0.05;
      if (level === 'off') { sim.setInput(f.id, { rot: 0, mx: 0, my: 0, ax: 0, ay: 0, aim: false }); return; }

      threats(f, bt, now);
      if (now >= bt.nextThink) { bt.nextThink = now + bt.think * (0.8 + rng() * 0.4); decide(f, bt, now); }
      while (bt.queue.length && bt.queue[0].at <= now) runAction(f, bt, bt.queue.shift(), now);
      if (!f.pendingSpace && bt.aimOn && f.dashT > 0) bt.aimOn = false;      // the aimed press has been consumed

      let rot, mx;
      if (!grounded) {
        // In the air: spin to the nearest 90° (so whatever we touch meets an edge's middle) and steer toward the target.
        const q = Math.PI / 2, err = Math.round(f.body.angle / q) * q - f.body.angle;
        rot = clamp(err * 0.22, -CFG.ROT_MAX, CFG.ROT_MAX) / CFG.ROT_MAX;
        if (Math.abs(rot) < 1e-3) rot = rot < 0 ? -1e-3 : 1e-3;             // never exactly 0: 0 would only damp the spin, not stop it
        mx = f.dashT > 0 ? 0 : bt.steer;
      } else {
        rot = mx = bt.roll;                                                 // on the ground, roll toward the target
      }
      sim.setInput(f.id, { rot, mx, my: 0, ax: bt.aim.x, ay: bt.aim.y, aim: bt.aimOn });
    }

    function tick() {
      const now = sim.time;
      for (const [id, bt] of brains) {
        const f = sim.fighters.get(id);
        if (!f) { brains.delete(id); continue; }
        if (!f.alive) { bt.queue.length = 0; bt.rs = -1; continue; }
        think(f, bt, now);
      }
    }
    sim.beforeStep = tick;

    // ───────────── public API ─────────────
    const api = {
      brains, LEVELS, LEVEL_ORDER,
      get level() { return level; },
      /** Put an AI cube into the sim. Returns the fighter. */
      add({ team, name, at, id }) {
        id = id !== undefined ? id : 'ai' + (++seq);
        const f = sim.addFighter({ id, name: name || (team === 1 ? 'Ally' : 'Bot'), team, bot: true, ai: true, at });
        brains.set(id, newBrain(f));
        return f;
      },
      /** Top both teams up to `perTeam` cubes with AI. */
      fill(perTeam = CFG.TEAM_SIZE) {
        for (const team of [1, 2]) {
          let n = 0; for (const f of sim.fighters.values()) if (f.team === team) n++;
          while (n++ < perTeam) api.add({ team });
        }
      },
      setLevel(l) {
        if (!(l in LEVELS)) return;
        level = l;
        for (const bt of brains.values()) setSkillOn(bt, LEVELS[l] + bt.jitter);
      },
      cycle() { api.setLevel(LEVEL_ORDER[(LEVEL_ORDER.indexOf(level) + 1) % LEVEL_ORDER.length]); return level; },
      setSkill(id, skill) { const bt = brains.get(id); if (bt) setSkillOn(bt, skill); },
      detach() { if (sim.beforeStep === tick) sim.beforeStep = null; brains.clear(); },
    };
    return api;
  }

  const api = { create, LEVELS, LEVEL_ORDER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CubeBots = api;
})(typeof window !== 'undefined' ? window : globalThis);
