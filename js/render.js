/* Cube League — canvas renderer. Pure drawing: it only reads a `view` object, so the same code draws a
 * solo/host sim directly and a client's interpolated snapshots.
 *
 * view = {
 *   now,                       // seconds (monotonic, local clock) – used for heart-reveal timeouts
 *   fighters: [{id,x,y,a,alive,team,name}],
 *   crates:   [[x,y,a], ...],  // same order as LAYOUT.crates
 *   me:       {id,hp,jump,dash,dashT,alive} | null,   // YOUR private state only
 *   aim:      {active,x,y},
 *   score:    [team1, team2] | null,
 * }
 */
(function (root) {
  'use strict';
  const { CFG, LAYOUT } = root.CubeSim;
  const { W, H } = CFG;
  const COLORS = {
    bg: '#dcd8cf', arena: '#f7f5ef', grid: '#ebe7dd', solid: '#23232b',
    box: '#c9c3b6', boxEdge: '#8f897b',
    team1: '#ff6a4d', team1Edge: '#c9472f', team2: '#f2b632', team2Edge: '#b9840f',
    blue: '#1e88ff', ink: '#23232b',
  };
  const teamColor = t => (t === 1 ? COLORS.team1 : COLORS.team2);

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let dpr = 1, cw = 0, ch = 0;
    const cam = { x: 0, y: 0, scale: 1 };
    const particles = [], floaters = [];
    const reveal = new Map();   // id -> { hp, until }   (heart reveal after a hit)
    const flash = new Map();    // id -> until

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
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
          if (ev.id === myId) floater('DASH RESET', ev.x, ev.y - 56, COLORS.blue);
          break;
        case 'hit':
          reveal.set(ev.id, { hp: ev.hp, until: now + CFG.HEART_REVEAL });
          flash.set(ev.id, now + 0.2);
          burst(ev.x, ev.y, '#ffffff', 10, 4);
          burst(ev.x, ev.y, teamColor(ev.team), 10, 5);
          if (ev.id !== myId) floater('−1', ev.x, ev.y - 50, '#d9342b');
          break;
        case 'die': burst(ev.x, ev.y, teamColor(ev.team), 30, 8); reveal.delete(ev.id); break;
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
        heartPath(x + (i - (CFG.HEARTS - 1) / 2) * gap, y, s);
        ctx.fillStyle = i < hp ? '#e5384d' : 'rgba(35,35,43,.18)';
        ctx.fill();
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

    function drawWorld(view) {
      const z = 1 / cam.scale;
      ctx.fillStyle = COLORS.arena; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 2 * z;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = 0; y <= H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,106,77,.10)'; ctx.fillRect(0, 0, 520, H);
      ctx.fillStyle = 'rgba(242,182,50,.12)'; ctx.fillRect(W - 520, 0, 520, H);

      ctx.fillStyle = COLORS.solid;
      for (const r of LAYOUT.shell) { rectPath(r[0], r[1], r[2], r[3]); ctx.fill(); }
      for (const r of LAYOUT.solids) { rectPath(r[0], r[1], r[2], r[3]); ctx.fill(); }
      view.crates.forEach((c, i) => {
        const d = LAYOUT.crates[i];
        rectPath(c[0], c[1], d[2], d[3], c[2]);
        ctx.fillStyle = COLORS.box; ctx.fill();
        ctx.lineWidth = 2.5 * z; ctx.strokeStyle = COLORS.boxEdge; ctx.stroke();
      });

      for (const f of view.fighters) {
        if (!f.alive) continue;
        const isMe = view.me && f.id === view.me.id;
        const fl = flash.get(f.id) || 0;
        ctx.lineJoin = 'round';
        rectPath(f.x, f.y, CFG.CUBE, CFG.CUBE, f.a);
        ctx.fillStyle = fl > view.now ? '#ffffff' : teamColor(f.team); ctx.fill();
        ctx.lineWidth = 3 * z; ctx.strokeStyle = f.team === 1 ? COLORS.team1Edge : COLORS.team2Edge; ctx.stroke();
        ctx.beginPath(); ctx.arc(f.x + Math.cos(f.a) * 15, f.y + Math.sin(f.a) * 15, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();

        if (isMe) {
          // Dash window: thin blue border, only you see it.
          if (view.me.dashT > 0) {
            ctx.save(); rectPath(f.x, f.y, CFG.CUBE, CFG.CUBE, f.a);
            ctx.lineWidth = 2.2 * z; ctx.strokeStyle = COLORS.blue; ctx.lineJoin = 'miter'; ctx.stroke(); ctx.restore();
          }
          if (view.me.dash && view.aim.active) {
            ctx.save(); ctx.setLineDash([6 * z, 8 * z]);
            ctx.lineWidth = 2 * z; ctx.strokeStyle = 'rgba(30,136,255,.55)';
            ctx.beginPath();
            ctx.moveTo(f.x + view.aim.x * 40, f.y + view.aim.y * 40);
            ctx.lineTo(f.x + view.aim.x * 130, f.y + view.aim.y * 130);
            ctx.stroke(); ctx.restore();
          }
        } else {
          // Others' hearts: only for 2 s after they were hit. Yours live in the top-right corner.
          const r = reveal.get(f.id);
          if (r && r.until > view.now) drawHearts(f.x, f.y - 58, r.hp, 7, Math.min(1, (r.until - view.now) / 0.3));
          ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(35,35,43,.55)';
          ctx.fillText(f.name, f.x, f.y - 40);
        }
      }

      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1; ctx.textAlign = 'center';
      for (const t of floaters) {
        ctx.globalAlpha = Math.min(1, t.life / 0.4);
        ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
      }
      ctx.globalAlpha = 1;
    }

    function drawHUD(view) {
      const me = view.me;
      if (me) {
        ctx.fillStyle = 'rgba(250,248,243,.96)';
        ctx.beginPath(); ctx.roundRect(cw - 172, 12, 160, 76, 10); ctx.fill();
        drawHearts(cw - 92, 38, me.hp, 11);
        const pip = (label, on, x) => {
          ctx.fillStyle = on ? COLORS.ink : 'rgba(35,35,43,.18)'; ctx.fillRect(x, 66, 14, 14);
          ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
          ctx.fillStyle = on ? COLORS.ink : 'rgba(35,35,43,.4)'; ctx.fillText(label, x + 20, 77);
        };
        pip('JUMP', me.jump, cw - 160); pip('DASH', me.dash, cw - 90);
        if (!me.alive) {
          ctx.font = '700 18px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
          ctx.fillStyle = COLORS.ink; ctx.fillText('respawning…', cw / 2, ch / 2);
        }
      }
      if (view.score) {
        ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = COLORS.team1; ctx.fillText(String(view.score[0]), cw / 2 - 28, ch - 22);
        ctx.fillStyle = 'rgba(35,35,43,.4)'; ctx.fillText('·', cw / 2, ch - 24);
        ctx.fillStyle = COLORS.team2; ctx.fillText(String(view.score[1]), cw / 2 + 28, ch - 22);
      }
    }

    let first = true;
    function draw(view, dtSec) {
      for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vx *= 0.94; p.vy = p.vy * 0.94 + 0.12; p.life -= dtSec; }
      for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
      for (const t of floaters) { t.y -= 40 * dtSec; t.life -= dtSec; }
      for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);

      updateCamera(view, first); first = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, cw, ch);
      ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, -cam.x * cam.scale * dpr, -cam.y * cam.scale * dpr);
      drawWorld(view);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawHUD(view);
    }
    function resetEffects() { particles.length = 0; floaters.length = 0; reveal.clear(); flash.clear(); first = true; }

    return { draw, handleEvent, resetEffects, resize };
  }

  root.CubeRender = { create, COLORS };
})(window);
