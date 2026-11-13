/* Cube League — pure simulation (no DOM). Runs in the browser (host / solo) and in Node (tests).
 * Matter.js, fixed 60 Hz step. Velocities are px per step, not px/s.
 *
 * The host's browser owns the one authoritative sim. Everything a renderer needs comes out of
 *   sim.snapshot()        public state (positions only; NEVER hearts)
 *   sim.privateState(id)  one player's own hearts / jump / dash (sent only to that player)
 *   sim.drainEvents()     discrete things that happened (dash, reset, hit, die, spawn)
 */
(function (root) {
  'use strict';
  const M = root.Matter || (typeof require === 'function' ? require('../lib/matter.min.js') : null);
  const { Engine, Bodies, Body, Composite, Collision, Bounds, Vertices } = M;

  const STEP_MS = 1000 / 60;
  const STEP = 1 / 60;
  const CFG = {
    W: 3200, H: 1100, WALL: 100,
    CUBE: 80,
    GRAVITY_SCALE: 0.0016,         // ≈1600 px/s²
    JUMP_V: 13.5,                  // px/step  (≈810 px/s)
    DASH_V: 17.5,                  // px/step  (≈1050 px/s)
    DASH_WINDOW: 0.24,             // seconds the blue outline (and the hit window) lasts
    ROT_MAX: 0.17,                 // rad/step max spin
    ROT_ACCEL: 0.03,               // rad/step² spin build-up
    AIR_SPIN_DAMP: 0.994,
    AIR_ACCEL_X: 0.34,             // px/step² sideways push with A/D (or left stick) in the air
    AIR_MAX_X: 5.6,                // px/step (~340 px/s) – a bit slower than rolling on the ground (~415 px/s)
    AIR_FLOAT: 0.26,               // px/step² of lift with W  (gravity is ~0.44) → fall noticeably slower
    AIR_DIVE: 0.36,                // px/step² of extra pull with S → fall noticeably faster
    DASH_COOLDOWN: 0.25,           // s after a dash starts before the next dash can start (plain timer, independent of resets and of button presses)
    PRESS_BUFFER: 0.15,            // s a Space press stays queued if it can't act yet (so mashing works; it never extends the cooldown)
    JUMP_AIM_MAX_DEG: 60,          // a aimed jump (right stick) can lean at most this far from the surface normal
    AIR_VMAX_Y: 16,                // px/step cap on fall speed while diving
    COYOTE: 0.32,                  // s you can still jump after leaving a floor
    RESET_LOCKOUT: 0.12,           // s after a jump/dash during which resets are ignored
    RESET_CENTER_HALF: 17,         // px either side of an edge's midpoint that count as "the middle of the edge" (≈42% of the edge)
    RESET_REACH: 8,                // px beyond the edge the surface may be and still count as touching (≈ up to 20° of tilt)
    HEARTS: 3,
    HEART_REVEAL: 2.0,             // s a hit cube shows its hearts to everyone (renderer side)
    RESPAWN_DELAY: 2.5,
    TEAM_SIZE: 3,
  };
  
  // Static scenery + pushable crates. Shared by host and clients (clients draw it without Matter).
  const { W, H, WALL } = CFG;
  const LAYOUT = {
    // [x, y, w, h] — the arena shell is separate (thick so nothing tunnels).
    shell: [
      [W / 2, H + WALL / 2, W + WALL * 2, WALL],      // floor (top at y = H)
      [W / 2, -WALL / 2, W + WALL * 2, WALL],         // ceiling (bottom at y = 0)
      [-WALL / 2, H / 2, WALL, H + WALL * 2],         // left wall
      [W + WALL / 2, H / 2, WALL, H + WALL * 2],      // right wall
    ],
    solids: [
      [800, 760, 280, 36], [2400, 760, 280, 36], [1600, 560, 420, 36],
      [1150, 430, 100, 100], [2050, 430, 100, 100],
      [480, 520, 90, 90], [2720, 520, 90, 90],
      [1600, 250, 80, 80],
      [1000, 110, 200, 220], [2200, 110, 200, 220],
      [1600, H - 60, 300, 120],
    ],
    // [x, y, w, h, density?]
    crates: [
      [1300, H - 35, 70, 70], [1900, H - 50, 100, 100], [1600, H - 165, 90, 90],
      [800, 712, 60, 60], [2400, 712, 60, 60], [2050, H - 90, 180, 180, 0.0012],
    ],
  };

  const r1 = v => Math.round(v * 10) / 10;
  const r3 = v => Math.round(v * 1000) / 1000;

  function spawnPoint(team, slot) {
    const x = 170 + (slot % CFG.TEAM_SIZE) * 130;
    return { x: team === 1 ? x : W - x, y: H - CFG.CUBE / 2 - 12 };
  }

  function create(opts = {}) {
    const engine = Engine.create({ positionIterations: 8, velocityIterations: 6 });
    engine.gravity.y = 1;
    engine.gravity.scale = CFG.GRAVITY_SCALE;
    const world = engine.world;

    for (const r of LAYOUT.shell.concat(LAYOUT.solids)) {
      const b = Bodies.rectangle(r[0], r[1], r[2], r[3], { isStatic: true, friction: 0.8, frictionStatic: 1, restitution: 0 });
      Composite.add(world, b);
    }
    const crateBodies = LAYOUT.crates.map(r => {
      const b = Bodies.rectangle(r[0], r[1], r[2], r[3], {
        friction: 0.5, frictionStatic: 0.8, restitution: 0.05, frictionAir: 0.004, density: r[4] || 0.0007,
      });
      Composite.add(world, b);
      return b;
    });

    const fighters = new Map();     // id -> fighter
    const score = { 1: 0, 2: 0 };   // eliminations per team
    let time = 0;
    let events = [];

    const sim = {
      engine, world, fighters, score, crateBodies, CFG,
      get time() { return time; },
    };

    const emit = e => events.push(e);
    sim.drainEvents = () => { const e = events; events = []; return e; };

    // ─────────────── roster ───────────────
    sim.teamCount = team => { let n = 0; for (const f of fighters.values()) if (f.team === team && !f.bot) n++; return n; };

    sim.addFighter = ({ id, name, team, bot = false, at = null }) => {
      let slot = 0;
      for (const f of fighters.values()) if (f.team === team) slot++;
      const sp = at ? { x: at.x, y: at.y } : spawnPoint(team, slot);
      const body = Bodies.rectangle(sp.x, sp.y, CFG.CUBE, CFG.CUBE, {
        friction: 0.8, frictionStatic: 1, frictionAir: 0.003, restitution: 0.05, density: 0.002,
      });
      const f = {
        id, name, team, bot, body, spawn: sp,
        hp: CFG.HEARTS, alive: true, respawnAt: -1, rs: 0,
        canJump: true, canDash: true, sinceFloor: 0, jumpN: { x: 0, y: -1 },
        dashT: 0, dashDir: { x: 1, y: 0 }, dashHit: new Set(),
        lockout: 0, flatT: -1, flatFloor: false, contacts: [],
        inp: { rot: 0, mx: 0, my: 0, ax: 0, ay: 0, aim: false, jaim: false }, pendingSpace: false, pressT: 0, dashCd: 0,
        stats: { hits: 0, kills: 0, deaths: 0, resets: 0 },
      };
      body.fighter = f;
      Composite.add(world, body);
      fighters.set(id, f);
      scanCache = null;
      return f;
    };

    sim.removeFighter = id => {
      const f = fighters.get(id);
      if (!f) return;
      if (f.alive) Composite.remove(world, f.body);
      fighters.delete(id);
      scanCache = null;
    };

    function respawn(f) {
      if (!f.alive) { Composite.add(world, f.body); scanCache = null; }
      Body.setPosition(f.body, { ...f.spawn });
      Body.setAngle(f.body, 0);
      Body.setVelocity(f.body, { x: 0, y: 0 });
      Body.setAngularVelocity(f.body, 0);
      Object.assign(f, {
        hp: CFG.HEARTS, respawnAt: -1, alive: true,
        canJump: true, canDash: true, dashT: 0, lockout: 0, dashCd: 0, pressT: 0, pendingSpace: false, flatT: -1, contacts: [],
      });
      f.dashHit.clear();
      f.rs++;
      emit({ e: 'spawn', id: f.id });
    }
    sim.respawn = id => { const f = fighters.get(id); if (f) respawn(f); };

    // ─────────────── input ───────────────
    sim.setInput = (id, inp) => {
      const f = fighters.get(id);
      if (!f) return;
      const n = v => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);   // hosts never trust clients
      // rot/mx/my = moving (A/D roll + air steer, W/S float/dive). ax/ay = where a dash (or aimed jump) goes.
      f.inp.rot = n(inp.rot); f.inp.mx = n(inp.mx); f.inp.my = n(inp.my); f.inp.ax = n(inp.ax); f.inp.ay = n(inp.ay);
      f.inp.aim = !!inp.aim && (f.inp.ax !== 0 || f.inp.ay !== 0);
      f.inp.jaim = f.inp.aim && !!inp.jaim;   // jump follows the aim only when the player aims with a dedicated stick
    };
    sim.pressSpace = id => { const f = fighters.get(id); if (f) { f.pendingSpace = true; f.pressT = CFG.PRESS_BUFFER; } };

    // ─────────────── simulation ───────────────
    // Bodies a fighter can touch: static scenery + crates (fixed) + living fighters. Rebuilt only when that set changes.
    const sceneBodies = Composite.allBodies(world).slice();   // statics + crates (taken before any fighter is added)
    let scanCache = null;
    const scanList = () => scanCache || (scanCache = sceneBodies.concat([...fighters.values()].filter(x => x.alive).map(x => x.body)));
    function scanContacts(f) {
      const b = f.body, out = [];
      for (const o of scanList()) {
        if (o === b || !Bounds.overlaps(b.bounds, o.bounds)) continue;
        const c = Collision.collides(b, o);
        if (!c) continue;
        const corners = new Set();
        for (const v of c.supports) if (v && v.body === b) corners.add(v.index);
        const n = { x: c.normal.x, y: c.normal.y };
        // Orient so the normal points from the other body toward this cube.
        if (n.x * (b.position.x - o.position.x) + n.y * (b.position.y - o.position.y) < 0) { n.x = -n.x; n.y = -n.y; }
        // Reset contact = the MIDDLE of one of the cube's edges touches the surface (not a corner).
        // Probe three points across the middle of each edge, a few px outside it, against the other body.
        const a = b.angle, half = CFG.CUBE / 2;
        let flush = false;
        for (let k = 0; k < 4 && !flush; k++) {
          const fa = a + k * Math.PI / 2, nx = Math.cos(fa), ny = Math.sin(fa);   // outward face normal
          for (const off of [-CFG.RESET_CENTER_HALF, 0, CFG.RESET_CENTER_HALF]) {
            const p = { x: b.position.x + nx * (half + CFG.RESET_REACH) - ny * off, y: b.position.y + ny * (half + CFG.RESET_REACH) + nx * off };
            if (Vertices.contains(o.vertices, p)) { flush = true; break; }
          }
        }
        out.push({ other: o, n, corners: corners.size, flush });
      }
      return out;
    }

    function doJump(f) {
      const n = f.jumpN, v = f.body.velocity;
      let d = n;
      if (f.inp.jaim) {
        // Lean the jump toward the aim, but never more than JUMP_AIM_MAX_DEG away from the surface normal.
        const m = Math.hypot(f.inp.ax, f.inp.ay) || 1, ux = f.inp.ax / m, uy = f.inp.ay / m;
        let ang = Math.atan2(n.x * uy - n.y * ux, n.x * ux + n.y * uy);            // signed angle normal → aim
        const lim = CFG.JUMP_AIM_MAX_DEG * Math.PI / 180;
        ang = Math.max(-lim, Math.min(lim, ang));
        d = { x: n.x * Math.cos(ang) - n.y * Math.sin(ang), y: n.x * Math.sin(ang) + n.y * Math.cos(ang) };
      }
      const vn = v.x * d.x + v.y * d.y;
      const add = Math.max(CFG.JUMP_V - vn, CFG.JUMP_V * 0.6);
      Body.setVelocity(f.body, { x: v.x + d.x * add, y: v.y + d.y * add });
      f.canJump = false;
      f.lockout = CFG.RESET_LOCKOUT;
    }

    function currentAim(f) {
      if (f.inp.aim) {
        const m = Math.hypot(f.inp.ax, f.inp.ay) || 1;
        return { x: f.inp.ax / m, y: f.inp.ay / m };
      }
      const a = f.body.angle;
      return { x: Math.cos(a), y: Math.sin(a) };   // facing = the white dot
    }

    function doDash(f) {
      const dir = currentAim(f);
      f.dashDir = dir;
      Body.setVelocity(f.body, { x: dir.x * CFG.DASH_V, y: dir.y * CFG.DASH_V });
      Body.setAngularVelocity(f.body, f.body.angularVelocity * 0.4);
      f.dashT = CFG.DASH_WINDOW;
      f.dashHit.clear();
      f.canDash = false;
      f.lockout = CFG.RESET_LOCKOUT;
      f.dashCd = CFG.DASH_COOLDOWN;
      emit({ e: 'dash', id: f.id, team: f.team, x: r1(f.body.position.x), y: r1(f.body.position.y) });
    }

    function preStep(f) {
      if (!f.alive) return;
      const b = f.body;
      f.lockout = Math.max(0, f.lockout - STEP);
      f.dashCd = Math.max(0, f.dashCd - STEP);
      f.pressT = Math.max(0, f.pressT - STEP);
      f.sinceFloor += STEP;

      if (!f.bot) {
        // Rotation: build spin toward the target, damp lightly in the air.
        const grounded = f.sinceFloor < 0.04;
        let av = b.angularVelocity;
        if (f.inp.rot !== 0) {
          const target = f.inp.rot * CFG.ROT_MAX;
          av += Math.max(-CFG.ROT_ACCEL, Math.min(CFG.ROT_ACCEL, target - av));
          Body.setAngularVelocity(b, av);
        } else if (!grounded) {
          Body.setAngularVelocity(b, av * CFG.AIR_SPIN_DAMP);
        }
        // Space: jump first, then dash.
        if (f.pendingSpace) {
          if (f.canJump && f.sinceFloor <= CFG.COYOTE) { f.pendingSpace = false; doJump(f); }
          else if (f.canDash && f.dashCd <= 0) { f.pendingSpace = false; doDash(f); }
          else if (f.pressT <= 0) f.pendingSpace = false;     // nothing became possible in time: drop the press
        }
      }
      // Air control (not while dashing): A/D steer sideways, W floats down slower, S dives faster.
      if (f.dashT <= 0 && f.sinceFloor > 0.04 && !f.bot) {
        const v = b.velocity;
        let vx = v.x, vy = v.y;
        const ax = f.inp.mx, ay = f.inp.my;
        if (ax > 0 && vx < CFG.AIR_MAX_X) vx = Math.min(CFG.AIR_MAX_X, vx + CFG.AIR_ACCEL_X * ax);
        else if (ax < 0 && vx > -CFG.AIR_MAX_X) vx = Math.max(-CFG.AIR_MAX_X, vx + CFG.AIR_ACCEL_X * ax);
        if (ay < 0) vy -= CFG.AIR_FLOAT * -ay * (vy > 0 ? 1 : 0);          // only slows a fall, never launches you up
        else if (ay > 0 && vy < CFG.AIR_VMAX_Y) vy = Math.min(CFG.AIR_VMAX_Y, vy + CFG.AIR_DIVE * ay);
        if (vx !== v.x || vy !== v.y) Body.setVelocity(b, { x: vx, y: vy });
      }

      // Losing the floor without jumping burns the jump, so the next press is a dash.
      if (f.canJump && f.sinceFloor > CFG.COYOTE) f.canJump = false;

      // While dashing, ignore gravity so the tackle flies straight.
      if (f.dashT > 0) {
        b.force.y -= b.mass * engine.gravity.y * engine.gravity.scale;
        f.dashT = Math.max(0, f.dashT - STEP);
      }
    }

    function hit(attacker, target) {
      target.hp -= 1;
      attacker.stats.hits++;
      const p = target.body.position;
      const d = attacker.dashDir;
      Body.setVelocity(target.body, { x: d.x * 11, y: d.y * 11 });
      // `hp` here is public on purpose: a hit reveals the victim's hearts to everyone for 2 s.
      emit({ e: 'hit', id: target.id, by: attacker.id, hp: Math.max(0, target.hp), team: target.team, x: r1(p.x), y: r1(p.y) });
      if (target.hp <= 0) {
        emit({ e: 'die', id: target.id, by: attacker.id, team: target.team, x: r1(p.x), y: r1(p.y) });
        Composite.remove(world, target.body);
        target.alive = false;
        scanCache = null;
        target.respawnAt = time + CFG.RESPAWN_DELAY;
        target.stats.deaths++;
        attacker.stats.kills++;
        score[attacker.team]++;
      }
    }

    function postStep(f) {
      if (!f.alive) { if (time >= f.respawnAt) respawn(f); return; }
      const b = f.body;
      f.contacts = scanContacts(f);

      let floorTouch = false, flat = null;
      for (const c of f.contacts) {
        const isFloor = c.n.y < -0.65;
        if (isFloor) { floorTouch = true; f.jumpN = c.n; }          // other cubes count as surfaces too
        if (c.flush) { if (!flat || isFloor) flat = { n: c.n, floor: isFloor }; }
      }
      if (floorTouch) {
        f.sinceFloor = 0;
        if (f.lockout <= 0) f.canJump = true;
      }
      if (flat) { f.flatT = time; f.flatFloor = flat.floor; }

      // Dash reset: two corners on one surface at once (floors count as a normal landing).
      if (f.lockout <= 0 && time - f.flatT < 0.05) {
        if (!f.canDash) {
          f.canDash = true;
          if (!f.flatFloor) {
            f.stats.resets++;
            emit({ e: 'reset', id: f.id, x: r1(b.position.x), y: r1(b.position.y) });
          }
        }
        if (f.flatFloor) f.canJump = true;
      }

      // Dash hits: one per target per dash, enemy team only.
      if (f.dashT > 0) {
        for (const c of f.contacts) {
          const t = c.other.fighter;
          if (t && t.alive && t.team !== f.team && !f.dashHit.has(t)) {
            f.dashHit.add(t);
            hit(f, t);
          }
        }
      }

      // Safety net: if something ever escapes the arena, put it back.
      const p = b.position;
      if (p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) respawn(f);
    }

    sim.step = () => {
      for (const f of fighters.values()) preStep(f);
      Engine.update(engine, STEP_MS);
      time += STEP;
      for (const f of fighters.values()) postStep(f);
    };

    // ─────────────── outputs ───────────────
    // Public snapshot: where everything is. Deliberately contains no hearts.
    sim.snapshot = () => ({
      t: r3(time),
      f: [...fighters.values()].map(f => [f.id, r1(f.body.position.x), r1(f.body.position.y), r3(f.body.angle), f.alive ? 1 : 0, f.rs]),
      c: crateBodies.map(b => [r1(b.position.x), r1(b.position.y), r3(b.angle)]),
      s: [score[1], score[2]],
    });
    // Private state: sent only to the player it belongs to.
    sim.privateState = id => {
      const f = fighters.get(id);
      if (!f) return null;
      return { hp: f.hp, jump: f.canJump, dash: f.canDash, dashT: r3(f.dashT), alive: f.alive };
    };

    if (opts.bots) {
      [1100, 2300, 2900].forEach((x, i) => sim.addFighter({ id: 'bot' + i, name: 'Bot', team: 2, bot: true, at: { x, y: H - CFG.CUBE / 2 - 12 } }));
    }
    return sim;
  }

  const api = { CFG, LAYOUT, STEP, STEP_MS, create, spawnPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CubeSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
