/* Cube League — canvas renderer. Pure drawing: it only reads a `view` object, so the same code draws a
 * solo/host sim directly and a client's interpolated snapshots.
 *
 * view = {
 *   now,                       // seconds (monotonic, local clock) – used for heart-reveal timeouts and animations
 *   fighters: [{id,x,y,a,alive,team,name}],
 *   crates:   [[x,y,a], ...],  // same order as LAYOUT.crates
 *   abilities:[[id,x,y,a,scale,team], ...],   // the temporary arrow-key squares; scale animates 0 → ~1.07 → 1 → … → 0
 *   me:       {id,hp,jump,dash,dashT,alive} | null,   // YOUR private state only (hp can be a half: 2.5)
 *   aim:      {active,x,y},
 *   score:    [team1, team2] | null,
 *   match:    {left, over, winner, overLeft} | null,  // seconds left, finished?, winning team (0 = draw), seconds to the next match
 * }
 *
 * Look: a misty parallax forest behind everything; the arena in dark slate; UI made of rhomboids (parallelograms);
 * Unbounded Black for titles/numbers, Lexend Regular for the rest (both vendored in lib/fonts).
 */
(function (root) {
  'use strict';
  const { CFG, LAYOUT } = root.CubeSim;
  const { W, H } = CFG;
  const T_FONT = 'Unbounded, system-ui, sans-serif', B_FONT = 'Lexend, system-ui, sans-serif';
  const COLORS = {
    solid: '#2a3835', box: '#ddd6c4',
    team1: '#ff6a4d', team2: '#f2b632', ability1: '#ff9c88', ability2: '#f6cf72',
    blue: '#1e88ff', ink: '#23232b', hitFlash: '#23232b', spark: '#ffffff',
  };
  const teamColor = t => (t === 1 ? COLORS.team1 : COLORS.team2);
  const TEAM_NAME = { 1: 'RED', 2: 'YELLOW' };

  // The canvas can only use a webfont once it has loaded; ask for both right away (it repaints every frame anyway).
  try { if (root.document && root.document.fonts) { root.document.fonts.load('900 20px Unbounded'); root.document.fonts.load('400 12px Lexend'); } } catch (e) { /* no font API */ }

  // mulberry32 — same pseudo-random numbers on every load, so the forest always looks the same.
  const rngFrom = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  // ───────────────────────── the forest ─────────────────────────
  // Everything is flat colour; depth comes from parallax, haze and value: far = pale and slow, near = dark and fast.
  const FOREST = (() => {
    const rnd = rngFrom(20241117);
    const ridge = (n, rough) => {            // a jagged horizon: layered noise sampled at n points (wraps around)
      const pts = []; let v = 0.5;
      for (let i = 0; i < n; i++) { v += (rnd() - 0.5) * rough; v = Math.max(0.05, Math.min(1, v)); pts.push(v); }
      for (let i = 0; i < 8; i++) pts[i] = pts[i] * (i / 8) + pts[n - 1 - i] * (1 - i / 8);   // blend the ends so the tile repeats seamlessly
      return pts;
    };
    return {
      mountains: [
        { f: 0.020, col: '#c3d7d6', base: 0.58, amp: 0.34, tile: 3800, pts: ridge(70, 0.55) },
        { f: 0.045, col: '#a8c3c2', base: 0.66, amp: 0.30, tile: 3300, pts: ridge(80, 0.60) },
      ],
      // layers of conifers, far → near. h* = tree height as a fraction of the screen height, base = where the layer's ground sits.
      trees: [
        { f: 0.10, col: '#9fbcb2', n: 54, tile: 3200, hMin: 0.15, hMax: 0.25, base: -0.15 },
        { f: 0.18, col: '#7da396', n: 34, tile: 3000, hMin: 0.25, hMax: 0.40, base: -0.08 },
        { f: 0.30, col: '#5b887c', n: 20, tile: 2900, hMin: 0.40, hMax: 0.66, base: -0.01 },
      ].map(L => {
        L.trees = Array.from({ length: L.n }, (_, i) => ({ x: (i + rnd() * 0.9) / L.n * L.tile, h: L.hMin + rnd() * (L.hMax - L.hMin), w: 0.27 + rnd() * 0.09, tiers: 4 + Math.floor(rnd() * 2) }));
        return L;
      }),
      trunks: Array.from({ length: 5 }, (_, i) => ({ x: (i + 0.15 + rnd() * 0.7) / 5 * 3600, w: 0.045 + rnd() * 0.05 })),
      motes: Array.from({ length: 34 }, () => ({ x: rnd(), y: 0.08 + rnd() * 0.78, s: 2 + rnd() * 2.4, p: rnd() * 6.28, f: 0.1 + rnd() * 0.25 })),
    };
  })();

  function create(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });   // opaque canvas = cheaper compositing
    let dpr = 1, cw = 0, ch = 0, dprCap = 2;
    const cam = { x: 0, y: 0, scale: 1 };
    const particles = [], floaters = [], ghosts = [];
    const reveal = new Map();   // id -> { hp, until }   (heart reveal after a hit)
    const flash = new Map();    // id -> until

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      cw = innerWidth; ch = innerHeight;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    addEventListener('resize', resize);
    resize();

    // ── effects, driven by sim events (identical for host, solo and clients) ──
    function burst(x, y, color, n = 14, speed = 5) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = (0.4 + Math.random()) * speed;
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, max: 0.8, size: 4 + Math.random() * 5, color });
      }
    }
    function floater(text, x, y, color = COLORS.ink) { floaters.push({ text, x, y, life: 0.9, color }); }

    function handleEvent(ev, myId, now) {
      switch (ev.e) {
        case 'dash': burst(ev.x, ev.y, teamColor(ev.team), 6, 2.5); break;
        case 'reset':
          burst(ev.x, ev.y, COLORS.blue, 12, 4);
          if (ev.id === myId) floater('DASH RESET', ev.x, ev.y - CFG.CUBE / 2 - 28, COLORS.blue);
          break;
        case 'hit':
          reveal.set(ev.id, { hp: ev.hp, until: now + CFG.HEART_REVEAL });
          flash.set(ev.id, now + 0.2);
          burst(ev.x, ev.y, COLORS.spark, 10, 4);
          burst(ev.x, ev.y, teamColor(ev.team), 10, 5);
          if (ev.id !== myId) floater('−1', ev.x, ev.y - CFG.CUBE / 2 - 24, '#d9342b');
          break;
        case 'fastfall': burst(ev.x, ev.y - CFG.CUBE * 0.45, '#7b6cff', 7, 2.2); break;   // little blue-purple puff, like Smash
        case 'die': burst(ev.x, ev.y, teamColor(ev.team), 30, 8); reveal.delete(ev.id); break;
        case 'ability': burst(ev.x, ev.y, ev.team === 1 ? COLORS.ability1 : COLORS.ability2, 8, 3); break;
        case 'abfail': if (ev.id === myId) ghosts.push({ x: ev.x, y: ev.y, size: ev.size, until: now + 0.4, from: now }); break;   // "no room here"
        case 'start': case 'spawn': break;
        default: break;
      }
    }

    // ── helpers ──
    function updateCamera(view, snap) {
      const viewH = H + 120;
      cam.scale = Math.min(ch / viewH, cw / 1300);
      const viewW = cw / cam.scale;
      cam.y = -60 - Math.max(0, (ch / cam.scale - viewH) / 2);
      const me = view.fighters.find(f => view.me && f.id === view.me.id);
      let tx = cam.x;
      if (viewW >= W + 200) tx = -(viewW - W) / 2;
      else if (me) tx = Math.max(-100, Math.min(W + 100 - viewW, me.x - viewW / 2 + (me.vx || 0) * 6));
      else tx = (W - viewW) / 2;
      cam.x = snap ? tx : cam.x + (tx - cam.x) * 0.12;
    }
    // A heart made of straight lines (no curves).
    const HEART = [[0, 1], [-1.3, -0.15], [-1.3, -0.7], [-0.65, -1.1], [0, -0.6], [0.65, -1.1], [1.3, -0.7], [1.3, -0.15]];
    function heartPath(x, y, s) {
      ctx.beginPath();
      HEART.forEach(([px, py], i) => { if (i) ctx.lineTo(x + px * s * 0.95, y + py * s * 0.95); else ctx.moveTo(x + px * s * 0.95, y + py * s * 0.95); });
      ctx.closePath();
    }
    // hp can be a half: 2.5 → two full hearts and one half.
    function drawHearts(x, y, hp, s, alpha = 1, empty = 'rgba(35,35,43,.22)') {
      ctx.save();
      ctx.globalAlpha = alpha;
      const gap = s * 2.7;
      for (let i = 0; i < CFG.HEARTS; i++) {
        const hx = x + (i - (CFG.HEARTS - 1) / 2) * gap, fill = Math.max(0, Math.min(1, hp - i));
        heartPath(hx, y, s); ctx.fillStyle = empty; ctx.fill();
        if (fill > 0) {
          ctx.save();
          if (fill < 1) { ctx.beginPath(); ctx.rect(hx - s * 1.5, y - s * 1.3, s * 3 * fill, s * 2.8); ctx.clip(); }
          heartPath(hx, y, s); ctx.fillStyle = '#e5384d'; ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();
    }
    const rectPath = (x, y, w, h, a = 0) => {
      const c = Math.cos(a), s = Math.sin(a), hw = w / 2, hh = h / 2;
      ctx.beginPath();
      [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].forEach(([px, py], i) => {
        const X = x + px * c - py * s, Y = y + px * s + py * c;
        if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      });
      ctx.closePath();
    };
    // A rhomboid: leans right ("/"), `sl` px of slant, text inside stays upright.
    const para = (x, y, w, h, sl) => { ctx.beginPath(); ctx.moveTo(x + sl, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - sl, y + h); ctx.lineTo(x, y + h); ctx.closePath(); };

    // ── background: sky, sun, light shafts, two mountain ranges, three layers of conifers, haze, drifting motes ──
    function drawForest(now) {
      const sc = cam.scale, floorY = (H - cam.y) * sc;
      const sky = ctx.createLinearGradient(0, 0, 0, ch);
      sky.addColorStop(0, '#bcd7de'); sky.addColorStop(0.55, '#e3eee6'); sky.addColorStop(1, '#f3efdc');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, cw, ch);

      // sun + glow
      const sx = cw * 0.72 - cam.x * 0.01 * sc, sy = ch * 0.27, sr = ch * 0.075;
      const glow = ctx.createRadialGradient(sx, sy, sr * 0.4, sx, sy, ch * 0.62);
      glow.addColorStop(0, 'rgba(255,243,208,.80)'); glow.addColorStop(1, 'rgba(255,243,208,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = '#fff8e2'; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 6.2832); ctx.fill();
      // light shafts: long slanted rhomboids falling from the sun (they match the UI shapes)
      ctx.fillStyle = 'rgba(255,250,228,.11)';
      for (let i = 0; i < 4; i++) {
        const x0 = sx - ch * (0.05 + i * 0.16), w = ch * (0.05 + (i % 2) * 0.03);
        ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + w, 0); ctx.lineTo(x0 - ch * 0.5 + w, ch); ctx.lineTo(x0 - ch * 0.5, ch); ctx.closePath(); ctx.fill();
      }

      // mountains
      for (const M of FOREST.mountains) {
        const tile = M.tile * sc, off = cam.x * M.f * sc, n = M.pts.length, step = 22;
        ctx.fillStyle = M.col; ctx.beginPath(); ctx.moveTo(0, ch);
        for (let x = 0; x <= cw + step; x += step) {
          const u = ((((x + off) % tile) + tile) % tile) / tile * n, i = Math.floor(u), t = u - i;
          const v = M.pts[i % n] * (1 - t) + M.pts[(i + 1) % n] * t;
          ctx.lineTo(x, floorY - ch * (M.base - 0.0) + ch * M.amp * (0.5 - v) * 1.0);
        }
        ctx.lineTo(cw + step, ch); ctx.closePath(); ctx.fill();
      }
      haze(floorY - ch * 0.46, floorY - ch * 0.12, 0.50);

      // conifers, far → near. One path (all tiers of all trees) per layer = one fill.
      FOREST.trees.forEach((L, li) => {
        const tile = L.tile * sc, off = cam.x * L.f * sc, baseY = floorY + ch * L.base;
        ctx.fillStyle = L.col; ctx.beginPath();
        for (const t of L.trees) {
          const h = t.h * ch, w = t.w * h;
          const X = ((((t.x * sc - off) % tile) + tile) % tile) - tile * 0;      // 0..tile, then repeated across the screen
          for (let x = X - tile; x < cw + w; x += tile) {
            if (x < -w) continue;
            for (let k = 0; k < t.tiers; k++) {
              const top = baseY - h + k * h * 0.2, bot = top + h * 0.42, hw = w * (0.38 + 0.62 * (k + 1) / t.tiers);
              ctx.moveTo(x, top); ctx.lineTo(x + hw, bot); ctx.lineTo(x - hw, bot); ctx.closePath();
            }
          }
        }
        ctx.fill();
        ctx.fillRect(0, baseY - 1, cw, ch - baseY + 1);                              // ground under this layer
        if (li < 2) haze(baseY - ch * 0.30, baseY + ch * 0.02, 0.34);
      });

      // giant foreground trunks + a soft canopy shadow, very faint so they never fight with gameplay
      const tr = 3600 * sc, off = cam.x * 0.55 * sc;
      ctx.fillStyle = 'rgba(24,48,42,.22)';
      for (const t of FOREST.trunks) {
        const w = t.w * ch;
        for (let x = ((((t.x * sc - off) % tr) + tr) % tr) - tr; x < cw + w; x += tr) if (x > -w) ctx.fillRect(x, 0, w, ch);
      }
      const can = ctx.createLinearGradient(0, 0, 0, ch * 0.28);
      can.addColorStop(0, 'rgba(24,48,42,.30)'); can.addColorStop(1, 'rgba(24,48,42,0)');
      ctx.fillStyle = can; ctx.fillRect(0, 0, cw, ch * 0.28);

      // drifting motes (pollen / fireflies) — little squares, like everything else
      for (const m of FOREST.motes) {
        const x = (((m.x * cw * 1.6 + Math.sin(now * m.f + m.p) * 26 - cam.x * 0.22 * sc) % (cw * 1.6)) + cw * 1.6) % (cw * 1.6) - cw * 0.3;
        const y = m.y * ch + Math.cos(now * m.f * 1.3 + m.p) * 16;
        ctx.globalAlpha = 0.30 + 0.30 * Math.sin(now * 1.2 + m.p * 3);
        ctx.fillStyle = '#fffbe0'; ctx.fillRect(x, y, m.s, m.s);
      }
      ctx.globalAlpha = 1;
    }
    function haze(y0, y1, a) {
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, 'rgba(236,244,238,0)'); g.addColorStop(1, `rgba(236,244,238,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, y0, cw, y1 - y0);
    }

    function drawWorld(view) {
      const z = 1 / cam.scale;
      ctx.fillStyle = 'rgba(255,106,77,.07)'; ctx.fillRect(0, 0, 520, H);
      ctx.fillStyle = 'rgba(242,182,50,.09)'; ctx.fillRect(W - 520, 0, 520, H);

      ctx.fillStyle = COLORS.solid;
      for (const r of LAYOUT.shell) { rectPath(r[0], r[1], r[2], r[3]); ctx.fill(); }
      for (const r of LAYOUT.solids) { rectPath(r[0], r[1], r[2], r[3]); ctx.fill(); }
      view.crates.forEach((c, i) => {
        const d = LAYOUT.crates[i];
        rectPath(c[0], c[1], d[2], d[3], c[2]);
        ctx.fillStyle = COLORS.box; ctx.fill();
      });

      // Arrow-key squares: they pop in (ease-out, a little bounce) and pop out (the same, reversed).
      for (const a of view.abilities || []) {
        const s = CFG.ABILITY_SIZE * Math.max(0, a[4]);
        if (s < 0.5) continue;
        rectPath(a[1], a[2], s, s, a[3]); ctx.fillStyle = a[5] === 1 ? COLORS.ability1 : COLORS.ability2; ctx.fill();
      }
      // "No room here" ghost: a dashed red square where the ability would have gone.
      for (const g of ghosts) {
        const t = (view.now - g.from) / (g.until - g.from);
        if (t < 0 || t > 1) continue;
        ctx.save(); ctx.globalAlpha = 1 - t; ctx.setLineDash([8 * z, 6 * z]); ctx.lineWidth = 2.5 * z; ctx.strokeStyle = '#d9342b';
        rectPath(g.x, g.y, g.size, g.size); ctx.stroke(); ctx.restore();
      }

      for (const f of view.fighters) {
        if (!f.alive) continue;
        const isMe = view.me && f.id === view.me.id;
        const fl = flash.get(f.id) || 0;
        rectPath(f.x, f.y, CFG.CUBE, CFG.CUBE, f.a);
        ctx.fillStyle = fl > view.now ? COLORS.hitFlash : teamColor(f.team); ctx.fill();      // flat fill, no border

        if (isMe) {
          // Dash window: thin blue border, only you see it.
          if (view.me.dashT > 0) {
            ctx.save(); rectPath(f.x, f.y, CFG.CUBE, CFG.CUBE, f.a);
            ctx.lineWidth = 2.2 * z; ctx.strokeStyle = COLORS.blue; ctx.lineJoin = 'miter'; ctx.stroke(); ctx.restore();
          }
          if ((view.me.dash || view.me.jump) && view.aim.active) {
            ctx.save(); ctx.setLineDash([6 * z, 8 * z]);
            ctx.lineWidth = 2 * z; ctx.strokeStyle = 'rgba(30,136,255,.7)';
            ctx.beginPath();
            ctx.moveTo(f.x + view.aim.x * CFG.CUBE * 0.7, f.y + view.aim.y * CFG.CUBE * 0.7);
            ctx.lineTo(f.x + view.aim.x * CFG.CUBE * 2.3, f.y + view.aim.y * CFG.CUBE * 2.3);
            ctx.stroke(); ctx.restore();
          }
        } else {
          // Others' hearts: only for 2 s after they were hit. Yours live in the top-right corner.
          const r = reveal.get(f.id);
          if (r && r.until > view.now) drawHearts(f.x, f.y - CFG.CUBE / 2 - 30, r.hp, 8, Math.min(1, (r.until - view.now) / 0.3));
          ctx.font = `400 12px ${B_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = 'rgba(35,35,43,.72)';
          ctx.fillText(f.name, f.x, f.y - CFG.CUBE / 2 - 10);
        }
      }

      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1; ctx.textAlign = 'center';
      for (const t of floaters) {
        ctx.globalAlpha = Math.min(1, t.life / 0.4);
        ctx.font = `900 12px ${T_FONT}`;
        ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
      }
      ctx.globalAlpha = 1;
    }

    // ── HUD: all rhomboids ──
    const mmss = s => { const t = Math.max(0, Math.ceil(s)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
    function drawStrip(view) {
      const m = view.match, sc = view.score;
      if (!m && !sc) return;
      const sl = 16, h = 54, tw = 176, sw = 118, gap = 7;
      const x0 = cw / 2 - tw / 2, y = 10;
      // clock
      para(x0, y, tw, h, sl); ctx.fillStyle = COLORS.ink; ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const left = m ? m.left : 0, urgent = m && !m.over && left <= 10;
      ctx.font = `900 28px ${T_FONT}`; ctx.fillStyle = urgent && Math.floor(view.now * 2) % 2 ? '#ff8a72' : '#fff';
      ctx.fillText(m ? mmss(left) : '–:––', x0 + tw / 2, y + h / 2 + 2);
      // the two scoreboards, leaning the same way and sitting a hair away from the clock
      const plate = (px, team, n, light) => {
        para(px, y, sw, h, sl); ctx.fillStyle = teamColor(team); ctx.fill();
        ctx.fillStyle = light ? '#fff' : COLORS.ink;
        ctx.font = `900 26px ${T_FONT}`; ctx.fillText(String(n), px + sw / 2, y + h / 2 + 6);
        ctx.font = `400 9px ${B_FONT}`; ctx.globalAlpha = 0.85; ctx.fillText(TEAM_NAME[team], px + sw / 2, y + 11); ctx.globalAlpha = 1;
      };
      const s1 = sc ? sc[0] : 0, s2 = sc ? sc[1] : 0;
      plate(x0 + sl - gap - sw, 1, s1, true);
      plate(x0 + tw + gap - sl, 2, s2, false);
      ctx.textBaseline = 'alphabetic';
    }

    function drawBanner(view) {
      const m = view.match;
      if (!m || !m.over) return;
      const w = Math.min(560, cw - 40), h = 168, x = cw / 2 - w / 2, y = ch * 0.30, sl = 34;
      const col = m.winner === 0 ? COLORS.ink : teamColor(m.winner), light = m.winner !== 2;
      para(x, y, w, h, sl); ctx.fillStyle = col; ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = light ? '#fff' : COLORS.ink;
      ctx.font = `400 12px ${B_FONT}`; ctx.fillText('TIME', cw / 2, y + 26);
      ctx.font = `900 ${w < 420 ? 30 : 42}px ${T_FONT}`; ctx.fillText(m.winner === 0 ? 'DRAW' : TEAM_NAME[m.winner] + ' WINS', cw / 2, y + 74);
      ctx.font = `900 24px ${T_FONT}`; ctx.fillText(`${view.score ? view.score[0] : 0}  —  ${view.score ? view.score[1] : 0}`, cw / 2, y + 120);
      ctx.font = `400 12px ${B_FONT}`; ctx.fillText('new match in ' + Math.max(0, Math.ceil(m.overLeft || 0)) + ' s', cw / 2, y + 150);
      ctx.textBaseline = 'alphabetic';
    }

    function drawHUD(view) {
      const me = view.me;
      if (me) {
        const w = 196, h = 78, x = cw - w - 12, y = 10, sl = 16;
        para(x, y, w, h, sl); ctx.fillStyle = 'rgba(35,35,43,.93)'; ctx.fill();
        drawHearts(x + w / 2 + 4, y + 30, me.hp, 11, 1, 'rgba(255,255,255,.18)');
        const pip = (label, on, px) => {
          para(px, y + 54, 14, 12, 4); ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,.22)'; ctx.fill();
          ctx.font = `400 11px ${B_FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,.45)'; ctx.fillText(label, px + 20, y + 65);
        };
        pip('JUMP', me.jump, x + 32); pip('DASH', me.dash, x + 112);
        if (!me.alive) {
          const pw = 260, ph = 56, px = cw / 2 - pw / 2, py = ch / 2 - ph / 2;
          para(px, py, pw, ph, 18); ctx.fillStyle = COLORS.ink; ctx.fill();
          ctx.font = `900 16px ${T_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText('RESPAWNING', cw / 2, ch / 2 + 1);
          ctx.textBaseline = 'alphabetic';
        }
      }
      drawStrip(view);
      drawBanner(view);
    }

    let first = true;
    function draw(view, dtSec) {
      for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vx *= 0.94; p.vy = p.vy * 0.94 + 0.12; p.life -= dtSec; }
      for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
      for (const t of floaters) { t.y -= 40 * dtSec; t.life -= dtSec; }
      for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);
      for (let i = ghosts.length - 1; i >= 0; i--) if (ghosts[i].until < view.now) ghosts.splice(i, 1);

      updateCamera(view, first); first = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawForest(view.now);
      ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, -cam.x * cam.scale * dpr, -cam.y * cam.scale * dpr);
      drawWorld(view);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawHUD(view);
    }
    function resetEffects() { particles.length = 0; floaters.length = 0; ghosts.length = 0; reveal.clear(); flash.clear(); first = true; }

    const lowerResolution = () => { const eff = Math.min(window.devicePixelRatio || 1, dprCap); if (eff > 0.75) { dprCap = Math.max(0.75, eff - 0.5); resize(); } };
    return { draw, handleEvent, resetEffects, resize, lowerResolution, dprCap: () => Math.min(window.devicePixelRatio || 1, dprCap) };
  }

  root.CubeRender = { create, COLORS };
})(window);
