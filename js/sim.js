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
    FALL_MAX: 12,                  // px/step (~720 px/s) normal terminal fall speed
    FALL_SLOW: 7,                  // px/step terminal fall speed while holding W (float down)
    FAST_FALL_V: 19,               // px/step (~1140 px/s ≈ 1.6× FALL_MAX): Smash-style fast fall. Down while descending snaps to this.
    FALL_DECEL: 1.2,               // px/step² how quickly an over-speed fall (e.g. after a dash) eases back to the cap
    DASH_COOLDOWN: 0.25,           // s after a dash starts before the next dash can start (plain timer, independent of resets and of button presses)
    PRESS_BUFFER: 0.15,            // s a Space press stays queued if it can't act yet (so mashing works; it never extends the cooldown)
    RESET_CENTER_HALF: 17,         // px either side of an edge's midpoint that count as "the middle of the edge" (≈42% of the edge)
    RESET_REACH: 8,                // px beyond the edge the surface may be and still count as touching (≈ up to 20° of tilt)
    JUMP_AIM_MAX_DEG: 60,          // an aimed jump can lean at most this far from the surface normal you jump off
    COYOTE: 0.30,                  // s you can still jump after leaving a floor
    RESET_LOCKOUT: 0.12,           // s after a jump/dash during which resets are ignored
    HEARTS: 3,
    RESPAWN_DELAY: 2.5,
    TEAM_SIZE: 3,
    MATCH_SECONDS: 180,            // a match lasts 3 minutes
    MATCH_OVER_SECONDS: 8,         // the result banner stays this long, then a fresh match starts
    REGEN_DELAY: 5,                // s without being hit before hearts start coming back
    REGEN_EVERY: 2,                // s between regeneration ticks …
    REGEN_AMOUNT: 0.5,             // … each one gives back this many hearts. A new hit restarts the REGEN_DELAY wait.
    ABILITY_SIZE: 64,              // the arrow-key square: a little smaller than a cube (80)
    ABILITY_GAP: 6,                // px between your cube and a freshly spawned square
    ABILITY_GROW: 0.5,             // s, ease-out with a small bounce at full size
    ABILITY_HOLD: 2,               // s the square stays at full size
    ABILITY_SHRINK: 0.5,           // s, the grow animation played backwards
    ABILITY_COOLDOWN: 0.5,         // s before the same player can spawn another one
    ABILITY_MAX: 3,                // squares one player can have alive at once
    DASH_ZONE: 1.0,                // the part of the cube's outline that hurts while dashing = this × one edge long, centred where the dash direction leaves the cube
    DASH_ZONE_TOL: 6,              // px of slack when deciding which part of the outline a contact happened on
    HEAL_RANGE: 380,               // px (centre to centre) within which a Titan can heal an ally
    HEAL_AMOUNT: 1,                // hearts per heal
    // Playable characters. size = edge in px; hearts = max hearts; rot/air/jump/dash/window scale the cube's speeds (window = how long the dash hits);
    // cd = ability cooldown (s); ability: block = physics square, wall = static black square, heal = heal a nearby ally.
    CLASSES: {
      cube:  { id: 0, name: 'Cube',  size: 80,  hearts: 3, rot: 1,    air: 1,    jump: 1,    dash: 1,    window: 1,    cd: 0.5, ability: 'block' },
      titan: { id: 1, name: 'Titan', size: 112, hearts: 5, rot: 0.58, air: 0.8,  jump: 0.94, dash: 0.92, window: 1.45, cd: 1.5, ability: 'heal' },
      mason: { id: 2, name: 'Mason', size: 80,  hearts: 3, rot: 1,    air: 1,    jump: 1,    dash: 1,    window: 1,    cd: 0.5, ability: 'wall' },
    },
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

  // The cube's outline as a loop: t runs 0 → 8h around a square of half-size h, starting at the top-left corner, clockwise.
  // `perimT(h, lx, ly)` = where the ray from the centre toward local point (lx, ly) crosses the outline.
  function perimT(h, lx, ly) {
    const m = Math.max(Math.abs(lx), Math.abs(ly)) || 1, px = lx / m * h, py = ly / m * h;
    if (Math.abs(ly) >= Math.abs(lx)) return ly < 0 ? px + h : 4 * h + (h - px);
    return lx > 0 ? 2 * h + (py + h) : 6 * h + (h - py);
  }
  function perimPoint(h, t) {                     // inverse of perimT: outline point (local coords) at loop position t
    t = ((t % (8 * h)) + 8 * h) % (8 * h);
    if (t < 2 * h) return [t - h, -h];
    if (t < 4 * h) return [h, t - 3 * h];
    if (t < 6 * h) return [5 * h - t, h];
    return [-h, 7 * h - t];
  }
  const toLocal = (a, dx, dy) => [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)];
  // The hurting part of a dashing cube: the stretch of its outline (zone long) centred where the dash direction exits it.
  function zoneCentre(size, angle, dir) { const [lx, ly] = toLocal(angle, dir.x, dir.y); return perimT(size / 2, lx, ly); }
  function inZone(size, angle, dir, dx, dy, tol) {   // is the contact at offset (dx, dy) from the cube's centre on the hurting stretch?
    const h = size / 2, P = 8 * h, [lx, ly] = toLocal(angle, dx, dy);
    let d = Math.abs(perimT(h, lx, ly) - zoneCentre(size, angle, dir)); d = Math.min(d, P - d);
    return d <= CFG.DASH_ZONE * size / 2 + tol;
  }
  // Polyline (world coords) of the hurting stretch, for drawing. `grow` pushes it a few px outside the cube.
  function zonePolyline(cx, cy, size, angle, dir, grow = 0) {
    const h = size / 2, tc = zoneCentre(size, angle, dir), half = CFG.DASH_ZONE * size / 2, ca = Math.cos(angle), sa = Math.sin(angle), pts = [];
    const add = t => { const [lx, ly] = perimPoint(h, t), m = Math.max(Math.abs(lx), Math.abs(ly)) || 1, k = (m + grow) / m, X = lx * k, Y = ly * k; pts.push([cx + X * ca - Y * sa, cy + X * sa + Y * ca]); };
    add(tc - half);
    for (let c = Math.ceil((tc - half) / (2 * h)) * 2 * h; c < tc + half; c += 2 * h) if (c > tc - half + 1e-6 && c < tc + half - 1e-6) add(c);   // corners inside the stretch
    add(tc + half);
    return pts;
  }

  const r1 = v => Math.round(v * 10) / 10;
  const r3 = v => Math.round(v * 1000) / 1000;

  function spawnPoint(team, slot, size = CFG.CLASSES.cube.size) {
    const x = 170 + (slot % CFG.TEAM_SIZE) * 130;
    return { x: team === 1 ? x : W - x, y: H - size / 2 - 12 };
  }

  function create(opts = {}) {
    const engine = Engine.create({ positionIterations: 8, velocityIterations: 6 });
    engine.gravity.y = 1;
    engine.gravity.scale = CFG.GRAVITY_SCALE;
    const world = engine.world;

    const solidBodies = [];     // floating blocks + centre block (everything except the arena shell) — AI navigation uses these
    LAYOUT.shell.concat(LAYOUT.solids).forEach((r, i) => {
      const b = Bodies.rectangle(r[0], r[1], r[2], r[3], { isStatic: true, friction: 0.8, frictionStatic: 1, restitution: 0 });
      Composite.add(world, b);
      if (i >= LAYOUT.shell.length) solidBodies.push(b);
    });
    const crateBodies = LAYOUT.crates.map(r => {
      const b = Bodies.rectangle(r[0], r[1], r[2], r[3], {
        friction: 0.5, frictionStatic: 0.8, restitution: 0.05, frictionAir: 0.004, density: r[4] || 0.0007,
      });
      Composite.add(world, b);
      return b;
    });

    const fighters = new Map();     // id -> fighter
    const score = { 1: 0, 2: 0 };   // eliminations per team
    const match = { left: CFG.MATCH_SECONDS, over: false, winner: 0, overLeft: 0 };   // winner: 0 = draw
    const abilities = [];            // live arrow-key squares: { id, owner, team, body, age, sc, vis }
    let abSeq = 0;
    let time = 0;
    let events = [];

    const sim = {
      engine, world, fighters, score, match, abilities, crateBodies, solidBodies, CFG,
      beforeStep: null,      // optional hook run at the start of every step (js/bots.js drives AI cubes from here)
      get time() { return time; },
    };

    const emit = e => events.push(e);
    sim.drainEvents = () => { const e = events; events = []; return e; };

    // ─────────────── roster ───────────────
    sim.teamCount = team => { let n = 0; for (const f of fighters.values()) if (f.team === team && !f.bot) n++; return n; };

    const classOf = key => CFG.CLASSES[key] ? key : 'cube';
    const makeBody = (x, y, size) => Bodies.rectangle(x, y, size, size, { friction: 0.8, frictionStatic: 1, frictionAir: 0.003, restitution: 0.05, density: 0.002 });

    sim.addFighter = ({ id, name, team, bot = false, ai = false, cls = 'cube', at = null }) => {
      let slot = 0;
      for (const f of fighters.values()) if (f.team === team) slot++;
      cls = classOf(cls); const k = CFG.CLASSES[cls];
      const sp = at ? { x: at.x, y: at.y } : spawnPoint(team, slot, k.size);
      const body = makeBody(sp.x, sp.y, k.size);
      const f = {
        id, name, team, bot, ai, body, spawn: sp, cls, k, size: k.size, maxHp: k.hearts, nextCls: null,
        hp: k.hearts, regenAt: 0, abCd: 0, alive: true, respawnAt: -1, rs: 0,
        canJump: true, canDash: true, sinceFloor: 0, sinceContact: 0, lastNs: [{ x: 0, y: -1 }],
        dashT: 0, dashDir: { x: 1, y: 0 }, dashHit: new Set(),
        lockout: 0, contacts: [],
        inp: { rot: 0, mx: 0, my: 0, ax: 0, ay: 0, aim: false }, pendingSpace: false, pressT: 0, dashCd: 0, fastFall: false,
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
      if (f.nextCls && f.nextCls !== f.cls) {                      // a different character: swap in a body of the right size
        if (f.alive) { Composite.remove(world, f.body); f.alive = false; }
        const k = CFG.CLASSES[f.nextCls];
        Object.assign(f, { cls: f.nextCls, k, size: k.size, maxHp: k.hearts });
        f.spawn = { x: f.spawn.x, y: H - k.size / 2 - 12 };
        f.body = makeBody(f.spawn.x, f.spawn.y, k.size); f.body.fighter = f;
        scanCache = null;
      }
      f.nextCls = null;
      if (!f.alive) { Composite.add(world, f.body); scanCache = null; }
      Body.setPosition(f.body, { ...f.spawn });
      Body.setAngle(f.body, 0);
      Body.setVelocity(f.body, { x: 0, y: 0 });
      Body.setAngularVelocity(f.body, 0);
      Object.assign(f, {
        hp: f.maxHp, regenAt: 0, abCd: 0, respawnAt: -1, alive: true,
        canJump: true, canDash: true, dashT: 0, lockout: 0, dashCd: 0, pressT: 0, pendingSpace: false, fastFall: false, sinceContact: 0, sinceFloor: 0, contacts: [],
      });
      f.dashHit.clear();
      f.rs++;
      emit({ e: 'spawn', id: f.id });
    }
    sim.respawn = id => { const f = fighters.get(id); if (f) respawn(f); };
    // Choose a character. It takes effect at your next respawn — or right now with `now` (practice mode).
    sim.setClass = (id, key, now = false) => {
      const f = fighters.get(id);
      if (!f || !CFG.CLASSES[key]) return false;
      f.nextCls = key === f.cls ? null : key;
      if (now && f.nextCls) respawn(f);
      return true;
    };

    // ─────────────── input ───────────────
    sim.setInput = (id, inp) => {
      const f = fighters.get(id);
      if (!f) return;
      const n = v => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);   // hosts never trust clients
      // rot/mx/my = moving (A/D roll + air steer, W/S float/dive). ax/ay/aim = the direction a jump or dash goes.
      f.inp.rot = n(inp.rot); f.inp.mx = n(inp.mx); f.inp.my = n(inp.my); f.inp.ax = n(inp.ax); f.inp.ay = n(inp.ay);
      f.inp.aim = !!inp.aim && (f.inp.ax !== 0 || f.inp.ay !== 0);
    };
    sim.pressSpace = id => { const f = fighters.get(id); if (f) { f.pendingSpace = true; f.pressT = CFG.PRESS_BUFFER; } };

    // ─────────────── simulation ───────────────
    // Bodies a fighter can touch: static scenery + crates (fixed) + living fighters. Rebuilt only when that set changes.
    const sceneBodies = Composite.allBodies(world).slice();   // statics + crates (taken before any fighter is added)
    let scanCache = null;
    const scanList = () => scanCache || (scanCache = sceneBodies.concat(abilities.map(a => a.body), [...fighters.values()].filter(x => x.alive).map(x => x.body)));
    // Anything any part of the cube is touching (walls, floors, ceilings, crates, other cubes).
    // `flush` = the MIDDLE of one of the cube's edges is touching it (not just a corner): that is what restores the dash.
    function scanContacts(f) {
      const b = f.body, out = [];
      for (const o of scanList()) {
        if (o === b || !Bounds.overlaps(b.bounds, o.bounds)) continue;
        const c = Collision.collides(b, o);
        if (!c) continue;
        const n = { x: c.normal.x, y: c.normal.y };
        // Orient so the normal points from the other body toward this cube.
        if (n.x * (b.position.x - o.position.x) + n.y * (b.position.y - o.position.y) < 0) { n.x = -n.x; n.y = -n.y; }
        // Probe three points across the middle of each edge, a few px outside it, against the other body.
        const a = b.angle, half = f.size / 2, ctrHalf = CFG.RESET_CENTER_HALF * f.size / CFG.CLASSES.cube.size;
        let flush = false;
        for (let k = 0; k < 4 && !flush; k++) {
          const fa = a + k * Math.PI / 2, nx = Math.cos(fa), ny = Math.sin(fa);   // outward face normal
          for (const off of [-ctrHalf, 0, ctrHalf]) {
            const p = { x: b.position.x + nx * (half + CFG.RESET_REACH) - ny * off, y: b.position.y + ny * (half + CFG.RESET_REACH) + nx * off };
            if (Vertices.contains(o.vertices, p)) { flush = true; break; }
          }
        }
        // Where the two bodies touch (mean of the penetrating vertices): decides which part of a dashing cube's outline did the hitting.
        let px = 0, py = 0, np = 0;
        for (const v of c.supports) if (v) { px += v.x; py += v.y; np++; }
        const pt = np ? { x: px / np, y: py / np } : { x: (b.position.x + o.position.x) / 2, y: (b.position.y + o.position.y) / 2 };
        out.push({ other: o, n, flush, pt });
      }
      return out;
    }

    // Jump = launch off whatever you touched in the last COYOTE seconds. With an aim you go that way (leaning at most
    // JUMP_AIM_MAX_DEG from the surface normal); without one you go straight off the surface.
    function doJump(f) {
      const aim = f.inp.aim ? currentAim(f) : null;
      let n = f.lastNs[0];
      for (const c of f.lastNs) {
        if (aim ? c.x * aim.x + c.y * aim.y > n.x * aim.x + n.y * aim.y : c.y < n.y) n = c;   // pick the surface that best fits the aim (else the most "floor-like")
      }
      let d = n;
      if (aim) {
        let ang = Math.atan2(n.x * aim.y - n.y * aim.x, n.x * aim.x + n.y * aim.y);        // signed angle normal → aim
        const lim = CFG.JUMP_AIM_MAX_DEG * Math.PI / 180;
        ang = Math.abs(ang) > Math.PI * 0.67 ? 0 : Math.max(-lim, Math.min(lim, ang));     // aiming into the surface = straight off it
        d = { x: n.x * Math.cos(ang) - n.y * Math.sin(ang), y: n.x * Math.sin(ang) + n.y * Math.cos(ang) };
      }
      const v = f.body.velocity;
      const jv = CFG.JUMP_V * f.k.jump;
      const add = Math.max(jv - (v.x * d.x + v.y * d.y), jv * 0.6);
      Body.setVelocity(f.body, { x: v.x + d.x * add, y: v.y + d.y * add });
      f.sinceContact = 99; f.canJump = false; f.fastFall = false;
      f.lockout = CFG.RESET_LOCKOUT;
    }

    function currentAim(f) {
      if (f.inp.aim) {
        const m = Math.hypot(f.inp.ax, f.inp.ay) || 1;
        return { x: f.inp.ax / m, y: f.inp.ay / m };
      }
      const a = f.body.angle;
      return { x: Math.cos(a), y: Math.sin(a) };   // facing = the cube's local +x (not drawn)
    }

    function doDash(f) {
      const dir = currentAim(f);
      f.dashDir = dir;
      Body.setVelocity(f.body, { x: dir.x * CFG.DASH_V * f.k.dash, y: dir.y * CFG.DASH_V * f.k.dash });
      Body.setAngularVelocity(f.body, f.body.angularVelocity * 0.4);
      f.dashT = CFG.DASH_WINDOW * f.k.window; f.fastFall = false;
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
      f.sinceContact += STEP;
      f.canJump = f.sinceContact <= CFG.COYOTE;

      const driven = !f.bot || f.ai;     // stationary dummies (bot without ai) ignore all input
      if (driven) {
        // Rotation: build spin toward the target, damp lightly in the air.
        const grounded = f.sinceFloor < 0.04;
        let av = b.angularVelocity;
        if (f.inp.rot !== 0) {
          const target = f.inp.rot * CFG.ROT_MAX * f.k.rot, acc = CFG.ROT_ACCEL * Math.max(0.5, f.k.rot);
          av += Math.max(-acc, Math.min(acc, target - av));
          Body.setAngularVelocity(b, av);
        } else if (!grounded) {
          Body.setAngularVelocity(b, av * CFG.AIR_SPIN_DAMP);
        }
        // Space: touching something (recently) → jump off it; touching nothing → dash, i.e. a jump from the void.
        if (f.pendingSpace) {
          if (f.canJump) { f.pendingSpace = false; doJump(f); }
          else if (f.canDash && f.dashCd <= 0) { f.pendingSpace = false; doDash(f); }
          else if (f.pressT <= 0) f.pendingSpace = false;     // nothing became possible in time: drop the press
        }
      }
      // Air control (not while dashing). A/D steer sideways.
      if (f.dashT <= 0 && f.sinceFloor > 0.04 && driven) {
        const v = b.velocity, ax = f.inp.mx, top = ax * CFG.AIR_MAX_X * f.k.air;      // a gentle push steers gently: top speed scales with the stick
        let vx = v.x;
        if (ax > 0 && vx < top) vx = Math.min(top, vx + CFG.AIR_ACCEL_X * f.k.air * ax);
        else if (ax < 0 && vx > top) vx = Math.max(top, vx + CFG.AIR_ACCEL_X * f.k.air * ax);
        if (vx !== v.x) Body.setVelocity(b, { x: vx, y: v.y });
      }

      // Fall speed (not while dashing). Normal terminal speed; W lowers it; S while already descending = FAST FALL
      // (Smash Bros style): fall speed snaps up to FAST_FALL_V and stays there until you touch something, jump, dash or are hit.
      if (f.fastFall && b.velocity.y < 0) f.fastFall = false;                    // bounced upward: over
      if (f.dashT <= 0 && f.sinceFloor > 0.04) {
        let vy = b.velocity.y;
        if (driven && !f.fastFall && f.inp.my > 0.5 && vy > 0 && f.sinceContact > 0.04) {
          f.fastFall = true;
          emit({ e: 'fastfall', id: f.id, x: r1(b.position.x), y: r1(b.position.y) });
        }
        const cap = f.fastFall ? CFG.FAST_FALL_V : (f.inp.my < -0.5 && driven ? CFG.FALL_SLOW : CFG.FALL_MAX);
        if (f.fastFall) vy = cap;                                                // snap, then hold
        else if (vy > cap) vy = Math.max(cap, vy - CFG.FALL_DECEL);
        if (vy !== b.velocity.y) Body.setVelocity(b, { x: b.velocity.x, y: vy });
      }

      // While dashing, ignore gravity so the tackle flies straight.
      if (f.dashT > 0) {
        b.force.y -= b.mass * engine.gravity.y * engine.gravity.scale;
        f.dashT = Math.max(0, f.dashT - STEP);
      }
    }

    function hit(attacker, target) {
      target.hp -= 1; target.fastFall = false;
      target.regenAt = time + CFG.REGEN_DELAY;      // being hit (again) restarts the wait before hearts come back
      attacker.stats.hits++;
      const p = target.body.position;
      const d = attacker.dashDir;
      Body.setVelocity(target.body, { x: d.x * 11, y: d.y * 11 });
      // `hp` here is public on purpose: a hit reveals the victim's hearts to everyone for 2 s.
      emit({ e: 'hit', id: target.id, by: attacker.id, hp: Math.max(0, target.hp), max: target.maxHp, team: target.team, x: r1(p.x), y: r1(p.y) });
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
      f.abCd = Math.max(0, f.abCd - STEP);
      if (f.hp < f.maxHp && time >= f.regenAt) {             // quiet for REGEN_DELAY → +0.5 hearts every REGEN_EVERY
        f.hp = Math.min(f.maxHp, f.hp + CFG.REGEN_AMOUNT);
        f.regenAt = time + CFG.REGEN_EVERY;
      }

      // Touching anything with any part of the cube: you can jump off it for a moment.
      // Touching it with the middle of an edge: your dash comes back too.
      if (f.contacts.length) {
        f.fastFall = false;
        if (f.contacts.some(c => c.n.y < -0.65)) f.sinceFloor = 0;        // standing on something (air control / spin damping)
        if (f.lockout <= 0) {
          f.sinceContact = 0; f.canJump = true;
          f.lastNs = f.contacts.map(c => c.n);
          const flat = f.contacts.filter(c => c.flush);
          // Touching another cube with the middle of your edge gives THEM a free dash reset too (enemy or ally).
          for (const c of flat) {
            const o = c.other.fighter;
            if (o && o.alive && !o.canDash) {
              o.canDash = true; o.stats.resets++;
              emit({ e: 'reset', id: o.id, x: r1(o.body.position.x), y: r1(o.body.position.y) });
            }
          }
          if (flat.length && !f.canDash) {
            f.canDash = true;
            if (!flat.some(c => c.n.y < -0.65)) {                            // landings on a floor are quiet; everything else is a "reset"
              f.stats.resets++;
              emit({ e: 'reset', id: f.id, x: r1(b.position.x), y: r1(b.position.y) });
            }
          }
        }
      }

      // Dash hits: one per target per dash, enemy team only.
      if (f.dashT > 0 && !match.over) {
        for (const c of f.contacts) {
          const t = c.other.fighter;
          if (t && t.alive && t.team !== f.team && !f.dashHit.has(t)
              && inZone(f.size, b.angle, f.dashDir, c.pt.x - b.position.x, c.pt.y - b.position.y, CFG.DASH_ZONE_TOL)) {
            f.dashHit.add(t);
            hit(f, t);
          }
        }
      }

      // Safety net: if something ever escapes the arena, put it back.
      const p = b.position;
      if (p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) respawn(f);
    }

    // ─────────────── abilities: arrow-key squares ───────────────
    const DIRS = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
    const easeOutBack = u => { const c1 = 1.4, c3 = c1 + 1, v = u - 1; return 1 + c3 * v * v * v + c1 * v * v; };   // peaks ≈ 1.07
    const clamp01 = v => Math.max(0, Math.min(1, v));
    // Visual scale over the square's life: grow (ease-out + bounce) → hold → the same animation reversed.
    const abilityScale = age => {
      const g = CFG.ABILITY_GROW, h = g + CFG.ABILITY_HOLD, e = h + CFG.ABILITY_SHRINK;
      if (age < g) return easeOutBack(clamp01(age / g));
      if (age < h) return 1;
      if (age < e) return easeOutBack(clamp01(1 - (age - h) / CFG.ABILITY_SHRINK));
      return 0;
    };

    // Heal the most hurt ally within HEAL_RANGE by HEAL_AMOUNT hearts (never above their max). Nobody to heal → nothing happens, no cooldown.
    function healAlly(f) {
      let best = null, bs = Infinity;
      for (const o of fighters.values()) {
        if (o === f || !o.alive || o.team !== f.team || o.hp >= o.maxHp) continue;
        const d = Math.hypot(o.body.position.x - f.body.position.x, o.body.position.y - f.body.position.y);
        if (d > CFG.HEAL_RANGE) continue;
        const score = o.hp * 1000 + d;                                              // most hurt first, then the closest
        if (score < bs) { bs = score; best = o; }
      }
      const p = f.body.position;
      if (!best) { emit({ e: 'noheal', id: f.id, x: r1(p.x), y: r1(p.y), r: CFG.HEAL_RANGE }); return false; }
      best.hp = Math.min(best.maxHp, best.hp + CFG.HEAL_AMOUNT);
      f.abCd = f.k.cd;
      emit({ e: 'heal', id: f.id, to: best.id, team: f.team, hp: best.hp, max: best.maxHp, x: r1(p.x), y: r1(p.y), tx: r1(best.body.position.x), ty: r1(best.body.position.y) });
      return true;
    }

    // The ability key (an arrow key / the D-pad). What it does depends on the character:
    //   Cube  → a physics square beside you (left / right / above / below), only if the full-size square fits there
    //   Mason → the same, but a static black square
    //   Titan → heals a nearby ally (the direction doesn't matter)
    sim.useAbility = (id, dir) => {
      const f = fighters.get(id), d = DIRS[dir];
      if (!f || !f.alive || !d || f.abCd > 0 || match.over) return false;
      if (f.k.ability === 'heal') return healAlly(f);
      if (abilities.filter(a => a.owner === id).length >= CFG.ABILITY_MAX) return false;
      const wall = f.k.ability === 'wall';
      const size = CFG.ABILITY_SIZE, half = f.size / 2, a = f.body.angle;
      const ext = half * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)));        // how far the (rotated) cube reaches along that axis
      const x = f.body.position.x + d[0] * (ext + size / 2 + CFG.ABILITY_GAP);
      const y = f.body.position.y + d[1] * (ext + size / 2 + CFG.ABILITY_GAP);
      const probe = Bodies.rectangle(x, y, size, size);
      let free = true;
      for (const o of scanList()) if (Bounds.overlaps(probe.bounds, o.bounds) && Collision.collides(probe, o)) { free = false; break; }
      if (!free) { emit({ e: 'abfail', id, x: r1(x), y: r1(y), size }); return false; }
      const body = wall
        ? Bodies.rectangle(x, y, size, size, { isStatic: true, friction: 0.8, frictionStatic: 1, restitution: 0 })
        : Bodies.rectangle(x, y, size, size, { friction: 0.6, frictionStatic: 0.9, restitution: 0.05, frictionAir: 0.004, density: 0.0012 });
      Body.scale(body, 0.1, 0.1);                                                  // starts tiny; updateAbilities() grows it
      f.abCd = f.k.cd;                                                             // only a spawn that happened starts the cooldown
      const ab = { id: ++abSeq, owner: id, team: f.team, kind: wall ? 1 : 0, body, age: 0, sc: 0.1, vis: 0 };
      body.ability = ab;
      Composite.add(world, body);
      abilities.push(ab);
      scanCache = null;
      emit({ e: 'ability', id, team: f.team, kind: ab.kind, x: r1(x), y: r1(y) });
      return true;
    };

    function updateAbilities() {
      for (let i = abilities.length - 1; i >= 0; i--) {
        const ab = abilities[i];
        ab.age += STEP;
        ab.vis = abilityScale(ab.age);
        if (ab.age >= CFG.ABILITY_GROW + CFG.ABILITY_HOLD + CFG.ABILITY_SHRINK) {
          Composite.remove(world, ab.body); abilities.splice(i, 1); scanCache = null; continue;
        }
        // The collider follows the animation (but never bigger than the real size, so the bounce can't shove neighbours).
        const target = Math.max(0.1, Math.min(1, ab.vis));
        if (Math.abs(target - ab.sc) > 1e-4) { Body.scale(ab.body, target / ab.sc, target / ab.sc); ab.sc = target; }
      }
    }

    function clearAbilities() { for (const ab of abilities) Composite.remove(world, ab.body); abilities.length = 0; scanCache = null; }

    // ─────────────── the 3-minute match ───────────────
    function updateMatch() {
      if (!match.over) {
        match.left -= STEP;
        if (match.left <= 0) {
          match.left = 0; match.over = true; match.overLeft = CFG.MATCH_OVER_SECONDS;
          match.winner = score[1] > score[2] ? 1 : score[2] > score[1] ? 2 : 0;
          emit({ e: 'end', winner: match.winner, s: [score[1], score[2]] });
        }
      } else if ((match.overLeft -= STEP) <= 0) {
        score[1] = 0; score[2] = 0;
        match.left = CFG.MATCH_SECONDS; match.over = false; match.winner = 0;
        clearAbilities();
        for (const f of fighters.values()) { respawn(f); for (const k in f.stats) f.stats[k] = 0; }
        emit({ e: 'start' });
      }
    }

    sim.step = () => {
      if (sim.beforeStep) sim.beforeStep(sim);
      // Remember last step's pose so renderers can interpolate between fixed steps (smooth motion at any refresh rate).
      for (const f of fighters.values()) { const p = f.body.position; f.px = p.x; f.py = p.y; f.pa = f.body.angle; f.prs = f.rs; f.pAlive = f.alive; }
      for (const b of crateBodies) { b.px = b.position.x; b.py = b.position.y; b.pa = b.angle; }
      for (const f of fighters.values()) preStep(f);
      updateAbilities();
      Engine.update(engine, STEP_MS);
      time += STEP;
      for (const f of fighters.values()) postStep(f);
      updateMatch();
    };

    // ─────────────── outputs ───────────────
    // Public snapshot: where everything is, which character each cube is, and each cube's hearts (shown above damaged cubes).
    // It never contains private state: no dash/jump/ability availability.
    sim.snapshot = () => ({
      t: r3(time),
      f: [...fighters.values()].map(f => [f.id, r1(f.body.position.x), r1(f.body.position.y), r3(f.body.angle), f.alive ? 1 : 0, f.rs, f.k.id, r1(f.hp)]),
      c: crateBodies.map(b => [r1(b.position.x), r1(b.position.y), r3(b.angle)]),
      s: [score[1], score[2]],
      m: [Math.round(match.left * 10) / 10, match.over ? 1 : 0, match.winner, Math.round(Math.max(0, match.overLeft) * 10) / 10],   // [seconds left, over?, winner (0 = draw), seconds until the next match]
      a: abilities.map(a => [a.id, r1(a.body.position.x), r1(a.body.position.y), r3(a.body.angle), r3(a.vis), a.team, a.kind]),
    });
    // Private state: sent only to the player it belongs to.
    sim.privateState = id => {
      const f = fighters.get(id);
      if (!f) return null;
      return { hp: f.hp, max: f.maxHp, jump: f.canJump, dash: f.canDash, dashT: r3(f.dashT), dx: r3(f.dashDir.x), dy: r3(f.dashDir.y), ab: r3(f.abCd), abMax: f.k.cd, cls: f.cls, alive: f.alive };
    };

    if (opts.bots) {
      [1100, 2300, 2900].forEach((x, i) => sim.addFighter({ id: 'bot' + i, name: 'Bot', team: 2, bot: true, at: { x, y: H - CFG.CLASSES.cube.size / 2 - 12 } }));
    }
    emit({ e: 'start' });          // the renderer pops a "GO!"
    return sim;
  }

  const api = { CFG, LAYOUT, STEP, STEP_MS, create, spawnPoint, zonePolyline, perimT, zoneCentre, inZone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CubeSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
