/* Cube League — sandbox prototype
 * Physics: Matter.js (fixed 60 Hz step). Rendering: Canvas 2D.
 * Everything is simulated locally; multiplayer (host/join, peer-to-peer) comes later.
 */
(() => {
  'use strict';
  const { Engine, Bodies, Body, Composite, Collision, Bounds } = Matter;

  // ───────────────────────── Config ─────────────────────────
  const STEP_MS = 1000 / 60;
  const STEP = 1 / 60;
  const CFG = {
    W: 3200, H: 1100, WALL: 100,
    CUBE: 56,
    GRAVITY_SCALE: 0.0016,         // ≈1600 px/s²
    JUMP_V: 13.5,                  // px/step  (≈810 px/s)
    DASH_V: 17.5,                  // px/step  (≈1050 px/s)
    DASH_WINDOW: 0.24,             // seconds the blue outline (and the hit window) lasts
    ROT_MAX: 0.17,                 // rad/step max spin
    ROT_ACCEL: 0.03,               // rad/step² spin build-up
    AIR_SPIN_DAMP: 0.994,
    COYOTE: 0.10,                  // s you can still jump after leaving a floor
    RESET_LOCKOUT: 0.12,           // s after a jump/dash during which resets are ignored
    FLUSH_DEG: 8,                  // face-to-surface tolerance for counting as "two corners"
    HEARTS: 3,
    HEART_REVEAL: 2.0,             // s a hit cube shows its hearts to everyone
    RESPAWN_DELAY: 2.5,
  };
  const COLORS = {
    bg: '#dcd8cf', arena: '#f7f5ef', grid: '#ebe7dd', solid: '#23232b',
    box: '#c9c3b6', boxEdge: '#8f897b',
    team1: '#ff6a4d', team1Edge: '#c9472f', team2: '#f2b632', team2Edge: '#b9840f',
    blue: '#1e88ff', ink: '#23232b',
  };

  const FLUSH_COS = Math.cos(CFG.FLUSH_DEG * Math.PI / 180);

  // ───────────────────────── World ─────────────────────────
  const engine = Engine.create({ positionIterations: 8, velocityIterations: 6 });
  engine.gravity.y = 1;
  engine.gravity.scale = CFG.GRAVITY_SCALE;
  const world = engine.world;

  const solid = (x, y, w, h) => {
    const b = Bodies.rectangle(x, y, w, h, { isStatic: true, friction: 0.8, frictionStatic: 1, restitution: 0 });
    b.render = { kind: 'solid' };
    Composite.add(world, b);
    return b;
  };
  const crate = (x, y, w, h, density = 0.0007) => {
    const b = Bodies.rectangle(x, y, w, h, { friction: 0.5, frictionStatic: 0.8, restitution: 0.05, frictionAir: 0.004, density });
    b.render = { kind: 'box' };
    Composite.add(world, b);
    return b;
  };

  // Arena shell: floor, ceiling, walls (thick so nothing tunnels through).
  const { W, H, WALL } = CFG;
  solid(W / 2, H + WALL / 2, W + WALL * 2, WALL);     // floor (top at y = H)
  solid(W / 2, -WALL / 2, W + WALL * 2, WALL);        // ceiling (bottom at y = 0)
  solid(-WALL / 2, H / 2, WALL, H + WALL * 2);        // left wall
  solid(W + WALL / 2, H / 2, WALL, H + WALL * 2);     // right wall

  // Floating platforms & squares (flip-reset practice), ceiling hangers, centre block.
  [
    [800, 760, 280, 36], [2400, 760, 280, 36], [1600, 560, 420, 36],
    [1150, 430, 100, 100], [2050, 430, 100, 100],
    [480, 520, 90, 90], [2720, 520, 90, 90],
    [1600, 250, 80, 80],
    [1000, 110, 200, 220], [2200, 110, 200, 220],
    [1600, H - 60, 300, 120],
  ].forEach(r => solid(...r));

  // Pushable crates.
  [
    [1300, H - 35, 70, 70], [1900, H - 50, 100, 100], [1600, H - 165, 90, 90],
    [800, 712, 60, 60], [2400, 712, 60, 60], [2050, H - 90, 180, 180, 0.0012],
  ].forEach(r => crate(...r));

  // ───────────────────────── Fighters ─────────────────────────
  const fighters = [];
  function makeFighter({ x, y, team, name, isPlayer = false }) {
    const body = Bodies.rectangle(x, y, CFG.CUBE, CFG.CUBE, {
      friction: 0.8, frictionStatic: 1, frictionAir: 0.003, restitution: 0.05, density: 0.002,
    });
    body.render = { kind: 'fighter' };
    const f = {
      body, team, name, isPlayer, spawn: { x, y },
      hp: CFG.HEARTS, heartsUntil: -1, flash: 0, respawnAt: -1, alive: true,
      canJump: true, canDash: true, sinceFloor: 0, jumpN: { x: 0, y: -1 },
      dashT: 0, dashDir: { x: 1, y: 0 }, dashHit: new Set(),
      lockout: 0, flatT: -1, flatFloor: false, contacts: [],
      pendingSpace: false,
    };
    body.fighter = f;
    Composite.add(world, body);
    fighters.push(f);
    return f;
  }
  const player = makeFighter({ x: 320, y: H - 40, team: 1, name: 'You', isPlayer: true });
  makeFighter({ x: 1100, y: H - 40, team: 2, name: 'Bot' });
  makeFighter({ x: 2300, y: H - 40, team: 2, name: 'Bot' });
  makeFighter({ x: 2900, y: H - 40, team: 2, name: 'Bot' });

  function respawn(f) {
    if (!f.alive) Composite.add(world, f.body);
    Body.setPosition(f.body, { ...f.spawn });
    Body.setAngle(f.body, 0);
    Body.setVelocity(f.body, { x: 0, y: 0 });
    Body.setAngularVelocity(f.body, 0);
    Object.assign(f, {
      hp: CFG.HEARTS, heartsUntil: -1, flash: 0, respawnAt: -1, alive: true,
      canJump: true, canDash: true, dashT: 0, lockout: 0, flatT: -1, contacts: [],
    });
    f.dashHit.clear();
  }

  // ───────────────────────── Input ─────────────────────────
  const keys = new Set();
  let gp = null;              // last polled gamepad snapshot
  let gpPrev = { jump: false, respawn: false };
  const input = { rot: 0, aim: { x: 0, y: 0 }, aimActive: false, usingPad: false };

  addEventListener('keydown', e => {
    if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
    keys.add(e.code);
    if (e.code === 'Space') { player.pendingSpace = true; e.preventDefault(); }
    if (e.code === 'KeyR') respawn(player);
    if (e.code === 'KeyH') document.getElementById('help').classList.toggle('hidden');
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const padEl = document.getElementById('pad');
  function pollInput() {
    // Keyboard
    const k = c => keys.has(c) ? 1 : 0;
    let rot = k('KeyD') - k('KeyA');
    let ax = k('KeyD') - k('KeyA');
    let ay = k('KeyS') - k('KeyW');
    let mag = Math.hypot(ax, ay);
    if (mag > 0) { ax /= mag; ay /= mag; }
    let aimActive = mag > 0;
    let usingPad = false;

    // Gamepad (Standard mapping: PS4 → ✕=0, L1=4, R1=5, L2=6, R2=7, Options=9, D-pad=12..15)
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (gp) {
      padEl.textContent = '🎮 controller connected';
      padEl.classList.add('on');
      const dz = v => (Math.abs(v) < 0.18 ? 0 : v);
      const b = i => (gp.buttons[i] ? gp.buttons[i].value : 0);
      const sx = gp.axes[0] || 0, sy = gp.axes[1] || 0;
      let px = sx, py = sy;
      if (Math.hypot(px, py) < 0.3) { px = 0; py = 0; }
      if (b(14)) px -= 1; if (b(15)) px += 1; if (b(12)) py -= 1; if (b(13)) py += 1;
      const pm = Math.hypot(px, py);
      if (pm > 0.3) { ax = px / pm; ay = py / pm; aimActive = true; usingPad = true; }
      const prot = dz(gp.axes[2] || 0) + (b(5) - b(4)) + (b(7) - b(6));
      if (prot !== 0) { rot = Math.max(-1, Math.min(1, prot)); usingPad = true; }
      const jump = b(0) > 0.5, resp = b(9) > 0.5;
      if (jump && !gpPrev.jump) player.pendingSpace = true;
      if (resp && !gpPrev.respawn) respawn(player);
      gpPrev = { jump, respawn: resp };
    } else {
      padEl.textContent = '🎮 press any controller button to connect';
      padEl.classList.remove('on');
    }
    input.rot = rot; input.aim.x = ax; input.aim.y = ay; input.aimActive = aimActive; input.usingPad = usingPad;
  }

  // ───────────────────────── Effects ─────────────────────────
  const particles = [];
  const floaters = [];
  function burst(x, y, color, n = 14, speed = 5) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.4 + Math.random()) * speed;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, max: 0.8, size: 4 + Math.random() * 5, color });
    }
  }
  function floater(text, x, y, color = COLORS.ink) { floaters.push({ text, x, y, life: 0.9, color }); }

  // ───────────────────────── Simulation ─────────────────────────
  let time = 0;

  function scanContacts(f) {
    const b = f.body, out = [];
    for (const o of Composite.allBodies(world)) {
      if (o === b || !Bounds.overlaps(b.bounds, o.bounds)) continue;
      const c = Collision.collides(b, o);
      if (!c) continue;
      const corners = new Set();
      for (const v of c.supports) if (v && v.body === b) corners.add(v.index);
      let n = { x: c.normal.x, y: c.normal.y };
      // Orient so the normal points from the other body toward this cube.
      if (n.x * (b.position.x - o.position.x) + n.y * (b.position.y - o.position.y) < 0) { n.x = -n.x; n.y = -n.y; }
      // "Flush" = the face turned toward the surface is within ~8° of parallel, even if only one
      // corner has registered yet (keeps the reset forgiving without counting 45° corner hits).
      const a = b.angle, ca = Math.cos(a), sa = Math.sin(a);
      const align = Math.max(Math.abs(ca * n.x + sa * n.y), Math.abs(-sa * n.x + ca * n.y));
      const flush = corners.size >= 2 || (corners.size >= 1 && align > FLUSH_COS);
      out.push({ other: o, n, corners: corners.size, flush });
    }
    return out;
  }

  function doJump(f) {
    const n = f.jumpN;
    const v = f.body.velocity;
    // Replace the velocity component along the surface normal with a jump launch.
    const vn = v.x * n.x + v.y * n.y;
    const add = Math.max(CFG.JUMP_V - vn, CFG.JUMP_V * 0.6);
    Body.setVelocity(f.body, { x: v.x + n.x * add, y: v.y + n.y * add });
    f.canJump = false;
    f.lockout = CFG.RESET_LOCKOUT;
  }

  function currentAim(f) {
    if (f.isPlayer && input.aimActive) return { x: input.aim.x, y: input.aim.y };
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
    burst(f.body.position.x, f.body.position.y, f.team === 1 ? COLORS.team1 : COLORS.team2, 6, 2.5);
  }

  function preStep(f) {
    if (!f.alive) return;
    const b = f.body;
    f.lockout = Math.max(0, f.lockout - STEP);
    f.flash = Math.max(0, f.flash - STEP);
    f.sinceFloor += STEP;

    if (f.isPlayer) {
      // Rotation: build spin toward the target, damp lightly in the air.
      const grounded = f.sinceFloor < 0.04;
      let av = b.angularVelocity;
      if (input.rot !== 0) {
        const target = input.rot * CFG.ROT_MAX;
        av += Math.max(-CFG.ROT_ACCEL, Math.min(CFG.ROT_ACCEL, target - av));
        Body.setAngularVelocity(b, av);
      } else if (!grounded) {
        Body.setAngularVelocity(b, av * CFG.AIR_SPIN_DAMP);
      }

      // Space: jump first, then dash.
      if (f.pendingSpace) {
        f.pendingSpace = false;
        if (f.canJump && f.sinceFloor <= CFG.COYOTE) doJump(f);
        else if (f.canDash) doDash(f);
      }
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
    target.heartsUntil = time + CFG.HEART_REVEAL;
    target.flash = 0.2;
    const p = target.body.position;
    burst(p.x, p.y, '#ffffff', 10, 4);
    burst(p.x, p.y, target.team === 1 ? COLORS.team1 : COLORS.team2, 10, 5);
    const d = attacker.dashDir;
    Body.setVelocity(target.body, { x: d.x * 11, y: d.y * 11 });
    if (target.isPlayer) {} else floater('−1', p.x, p.y - 50, '#d9342b');
    if (target.hp <= 0) {
      burst(p.x, p.y, target.team === 1 ? COLORS.team1 : COLORS.team2, 30, 8);
      Composite.remove(world, target.body);
      target.alive = false;
      target.respawnAt = time + CFG.RESPAWN_DELAY;
    }
  }

  function postStep(f) {
    if (!f.alive) { if (time >= f.respawnAt) respawn(f); return; }
    const b = f.body;
    f.contacts = scanContacts(f);

    let floorTouch = false, flat = null;
    for (const c of f.contacts) {
      const isFloor = c.n.y < -0.65;
      if (isFloor && !c.other.fighter) { floorTouch = true; f.jumpN = c.n; }
      if (c.flush && !c.other.fighter) {
        if (!flat || isFloor) flat = { n: c.n, floor: isFloor };
      }
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
          burst(b.position.x, b.position.y, COLORS.blue, 12, 4);
          if (f.isPlayer) floater('DASH RESET', b.position.x, b.position.y - 56, COLORS.blue);
        }
      }
      if (f.flatFloor) f.canJump = true;
    }

    // Dash hits.
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

  function stepSim() {
    for (const f of fighters) preStep(f);
    Engine.update(engine, STEP_MS);
    time += STEP;
    for (const f of fighters) postStep(f);
  }

  // ───────────────────────── Rendering ─────────────────────────
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let dpr = 1, cw = 0, ch = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = innerWidth; ch = innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  addEventListener('resize', resize);
  resize();

  const cam = { x: 0, y: 0, scale: 1 };
  function updateCamera(snap) {
    const viewH = H + 120;
    cam.scale = Math.min(ch / viewH, cw / 1300);
    const viewW = cw / cam.scale;
    cam.y = -60 - Math.max(0, (ch / cam.scale - viewH) / 2);
    const p = player.body.position, v = player.body.velocity;
    let tx = p.x + v.x * 6 - viewW / 2;
    if (viewW >= W + 200) tx = -(viewW - W) / 2;
    else tx = Math.max(-100, Math.min(W + 100 - viewW, tx));
    cam.x = snap ? tx : cam.x + (tx - cam.x) * 0.12;
  }

  function heartPath(x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.9);
    ctx.bezierCurveTo(x - s * 1.5, y - s * 0.2, x - s * 0.7, y - s * 1.1, x, y - s * 0.35);
    ctx.bezierCurveTo(x + s * 0.7, y - s * 1.1, x + s * 1.5, y - s * 0.2, x, y + s * 0.9);
    ctx.closePath();
  }
  function drawHearts(x, y, hp, s, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const gap = s * 2.7;
    for (let i = 0; i < CFG.HEARTS; i++) {
      const hx = x + (i - (CFG.HEARTS - 1) / 2) * gap;
      heartPath(hx, y, s);
      if (i < hp) { ctx.fillStyle = '#e5384d'; ctx.fill(); }
      else { ctx.fillStyle = 'rgba(35,35,43,.18)'; ctx.fill(); }
    }
    ctx.restore();
  }

  function polyPath(vs) {
    ctx.beginPath();
    ctx.moveTo(vs[0].x, vs[0].y);
    for (let i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y);
    ctx.closePath();
  }

  function drawWorld() {
    // Arena floor plane + grid
    ctx.fillStyle = COLORS.arena;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 2 / cam.scale;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    // Team zones
    ctx.fillStyle = 'rgba(255,106,77,.10)'; ctx.fillRect(0, 0, 520, H);
    ctx.fillStyle = 'rgba(242,182,50,.12)'; ctx.fillRect(W - 520, 0, 520, H);

    // Static + dynamic scenery
    for (const b of Composite.allBodies(world)) {
      const k = b.render && b.render.kind;
      if (k === 'solid') { polyPath(b.vertices); ctx.fillStyle = COLORS.solid; ctx.fill(); }
      else if (k === 'box') {
        polyPath(b.vertices); ctx.fillStyle = COLORS.box; ctx.fill();
        ctx.lineWidth = 2.5 / cam.scale; ctx.strokeStyle = COLORS.boxEdge; ctx.stroke();
      }
    }

    // Fighters
    for (const f of fighters) {
      if (!f.alive) continue;
      const b = f.body;
      const fill = f.flash > 0 ? '#ffffff' : (f.team === 1 ? COLORS.team1 : COLORS.team2);
      const edge = f.team === 1 ? COLORS.team1Edge : COLORS.team2Edge;
      polyPath(b.vertices); ctx.fillStyle = fill; ctx.fill();
      ctx.lineJoin = 'round'; ctx.lineWidth = 3 / cam.scale; ctx.strokeStyle = edge; ctx.stroke();
      // facing dot
      const a = b.angle, fx = b.position.x + Math.cos(a) * 15, fy = b.position.y + Math.sin(a) * 15;
      ctx.beginPath(); ctx.arc(fx, fy, 5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();

      // Dash window: thin blue border, only you see it.
      if (f.isPlayer && f.dashT > 0) {
        ctx.save();
        polyPath(b.vertices);
        ctx.lineWidth = 2.2 / cam.scale; ctx.strokeStyle = COLORS.blue; ctx.lineJoin = 'miter'; ctx.stroke();
        ctx.restore();
      }
      // Aim preview
      if (f.isPlayer && f.canDash && input.aimActive) {
        ctx.save();
        ctx.setLineDash([6 / cam.scale, 8 / cam.scale]);
        ctx.lineWidth = 2 / cam.scale; ctx.strokeStyle = 'rgba(30,136,255,.55)';
        ctx.beginPath();
        ctx.moveTo(b.position.x + input.aim.x * 40, b.position.y + input.aim.y * 40);
        ctx.lineTo(b.position.x + input.aim.x * 130, b.position.y + input.aim.y * 130);
        ctx.stroke(); ctx.restore();
      }
      // Others' hearts: visible only briefly after being hit. (Your own are in the corner.)
      if (!f.isPlayer) {
        const left = f.heartsUntil - time;
        if (left > 0) drawHearts(b.position.x, b.position.y - 58, f.hp, 7, Math.min(1, left / 0.3));
        ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(35,35,43,.55)';
        ctx.fillText(f.name, b.position.x, b.position.y - 40);
      }
    }

    // Particles & floaters
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const t of floaters) {
      ctx.globalAlpha = Math.min(1, t.life / 0.4);
      ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    // Light panel so the HUD stays readable over dark geometry.
    ctx.fillStyle = 'rgba(250,248,243,.96)';
    ctx.beginPath(); ctx.roundRect(cw - 172, 12, 160, 76, 10); ctx.fill();
    // Your hearts: top-right of the screen.
    drawHearts(cw - 92, 38, player.hp, 11);
    // Jump / dash availability
    const pip = (label, on, x) => {
      ctx.fillStyle = on ? COLORS.ink : 'rgba(35,35,43,.18)';
      ctx.fillRect(x, 66, 14, 14);
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillStyle = on ? COLORS.ink : 'rgba(35,35,43,.4)';
      ctx.fillText(label, x + 20, 77);
    };
    pip("JUMP", player.canJump, cw - 160);
    pip("DASH", player.canDash, cw - 90);
    if (!player.alive) {
      ctx.font = '700 18px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.ink; ctx.fillText('respawning…', cw / 2, ch / 2);
    }
  }

  function render(dtSec) {
    for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vx *= 0.94; p.vy = p.vy * 0.94 + 0.12; p.life -= dtSec; }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
    for (const t of floaters) { t.y -= 40 * dtSec; t.life -= dtSec; }
    for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);

    updateCamera(false);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, -cam.x * cam.scale * dpr, -cam.y * cam.scale * dpr);
    drawWorld();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawHUD();
  }

  // ───────────────────────── Main loop ─────────────────────────
  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    acc += dt * 1000;
    pollInput();
    let n = 0;
    while (acc >= STEP_MS && n < 5) { stepSim(); acc -= STEP_MS; n++; }
    if (n === 5) acc = 0;
    render(dt);
    requestAnimationFrame(frame);
  }
  updateCamera(true);
  requestAnimationFrame(frame);

  // Debug / test hook
  window.__game = { CFG, engine, player, fighters, input, keys, stepSim, get time() { return time; }, respawn, Matter };
})();
