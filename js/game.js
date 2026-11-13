/* Cube League — game shell: input, modes (solo / host / client), main loop, menu.
 * Simulation lives in sim.js, networking in net.js, drawing in render.js. Everything is buildless.
 */
(() => {
  'use strict';
  const { CFG, STEP_MS } = CubeSim;
  const $ = id => document.getElementById(id);

  const SNAP_EVERY = 2;        // host sends a snapshot every N sim steps (60/2 = 30 Hz)
  const INTERP_DELAY = 0.10;   // s — clients render this far in the past so they can interpolate
  const INPUT_HEARTBEAT = 0.25;

  const renderer = CubeRender.create($('c'));

  // ───────────────────────── Mode state ─────────────────────────
  let mode = 'solo';           // 'solo' | 'host' | 'client'
  let sim = null;              // solo + host only
  let host = null, client = null;
  let myId = 0;
  let roster = new Map();      // id -> {name, team}   (clients; host/solo read the sim)
  let pendingEv = [];          // host: events since the last broadcast
  let stepsSinceSnap = 0;
  const net = { snaps: [], offset: null, me: null, score: [0, 0], lastSent: '', lastSentAt: 0 };

  function teardown() {
    if (host) host.close();
    if (client) client.close();
    host = client = sim = null;
    net.snaps = []; net.offset = null; net.me = null; net.score = [0, 0]; net.lastSent = '';
    pendingEv = []; stepsSinceSnap = 0; roster = new Map();
    renderer.resetEffects();
  }
  const nameVal = () => { const n = CubeNet.cleanName($('name').value); try { localStorage.setItem('cl_name', n); } catch (e) { /* private mode */ } return n; };

  function startSolo() {
    teardown(); mode = 'solo'; myId = 0;
    sim = CubeSim.create({ bots: true });
    sim.addFighter({ id: 0, name: 'You', team: 1 });
    setMenu();
  }

  async function startHost() {
    teardown(); mode = 'host'; myId = 0;
    sim = CubeSim.create({ bots: false });
    setStatus('Creating room…');
    try {
      host = CubeNet.createHost({ sim, name: nameVal(), onRoster: setMenu, onError: e => setStatus('Network error: ' + e.type) });
      sim.fighters.get(0).name = nameVal();
      await host.ready;
      setMenu();
    } catch (e) {
      setStatus('Could not create a room (' + (e.type || e.message) + '). Back to practice.');
      startSolo();
    }
  }

  function startClient(code) {
    teardown(); mode = 'client'; myId = -1;
    setStatus('Joining ' + CubeNet.cleanCode(code) + '…');
    client = CubeNet.joinGame({
      code, name: nameVal(),
      onWelcome: (id, r) => { myId = id; setRoster(r); setMenu(); },
      onRoster: r => { setRoster(r); setMenu(); },
      onSnap: onSnap,
      onClose: reason => { startSolo(); setStatus(reason); },
    });
  }

  const setRoster = r => { roster = new Map(r.map(([id, name, team]) => [id, { name, team }])); };

  // ───────────────────────── Input ─────────────────────────
  const keys = new Set();
  let gpPrev = { jump: false, respawn: false };
  const input = { rot: 0, aim: { x: 0, y: 0 }, aimActive: false, usingPad: false };
  const typing = e => e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  function pressSpace() {
    if (mode === 'client') { if (client) client.pressSpace(); }
    else if (sim) sim.pressSpace(myId);
  }
  function tryRespawn() { if (mode === 'solo' && sim) sim.respawn(myId); }   // no free respawns in a real match

  addEventListener('keydown', e => {
    if (typing(e)) return;
    if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
    keys.add(e.code);
    if (e.code === 'Space') { pressSpace(); e.preventDefault(); }
    if (e.code === 'KeyR') tryRespawn();
    if (e.code === 'KeyH') $('help').classList.toggle('hidden');
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const padEl = $('pad');
  function pollInput() {
    const k = c => keys.has(c) ? 1 : 0;
    let rot = k('KeyD') - k('KeyA');
    let ax = k('KeyD') - k('KeyA'), ay = k('KeyS') - k('KeyW');
    let mag = Math.hypot(ax, ay);
    if (mag > 0) { ax /= mag; ay /= mag; }
    let aimActive = mag > 0, usingPad = false;

    // Gamepad (Standard mapping: PS4 → ✕=0, L1=4, R1=5, L2=6, R2=7, Options=9, D-pad=12..15)
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (gp) {
      padEl.textContent = '🎮 controller connected'; padEl.classList.add('on');
      const dz = v => (Math.abs(v) < 0.18 ? 0 : v);
      const b = i => (gp.buttons[i] ? gp.buttons[i].value : 0);
      let px = gp.axes[0] || 0, py = gp.axes[1] || 0;
      if (Math.hypot(px, py) < 0.3) { px = 0; py = 0; }
      if (b(14)) px -= 1; if (b(15)) px += 1; if (b(12)) py -= 1; if (b(13)) py += 1;
      const pm = Math.hypot(px, py);
      if (pm > 0.3) { ax = px / pm; ay = py / pm; aimActive = true; usingPad = true; }
      const prot = dz(gp.axes[2] || 0) + (b(5) - b(4)) + (b(7) - b(6));
      if (prot !== 0) { rot = Math.max(-1, Math.min(1, prot)); usingPad = true; }
      const jump = b(0) > 0.5, resp = b(9) > 0.5;
      if (jump && !gpPrev.jump) pressSpace();
      if (resp && !gpPrev.respawn) tryRespawn();
      gpPrev = { jump, respawn: resp };
    } else {
      padEl.textContent = '🎮 press any controller button to connect'; padEl.classList.remove('on');
    }
    input.rot = rot; input.aim.x = ax; input.aim.y = ay; input.aimActive = aimActive; input.usingPad = usingPad;
  }

  // ───────────────────────── Client: snapshots → interpolated view ─────────────────────────
  const nowSec = () => performance.now() / 1000;

  function onSnap(msg) {
    const now = nowSec(), s = msg.s;
    const o = now - s.t;
    net.offset = net.offset === null || o < net.offset ? o : net.offset + (o - net.offset) * 0.01;
    net.snaps.push(s);
    if (net.snaps.length > 30) net.snaps.shift();
    net.me = msg.me; net.score = s.s;
    for (const ev of msg.ev || []) renderer.handleEvent(ev, myId, now);
  }

  function clientView(now) {
    const sn = net.snaps;
    if (!sn.length) return null;
    const rt = (now - net.offset) - INTERP_DELAY;
    let a = sn[0], b = sn[0];
    for (let i = 0; i < sn.length; i++) {
      if (sn[i].t <= rt) { a = sn[i]; b = sn[Math.min(i + 1, sn.length - 1)]; }
    }
    if (rt >= sn[sn.length - 1].t) a = b = sn[sn.length - 1];
    const u = a === b || b.t === a.t ? 1 : Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));
    const prev = new Map(a.f.map(f => [f[0], f]));
    const fighters = b.f.map(fb => {
      const fa = prev.get(fb[0]);
      const ri = roster.get(fb[0]) || { name: 'Cube', team: 1 };
      const snap = !fa || fa[5] !== fb[5] || !fa[4] || !fb[4];   // respawned / dead: don't slide across the map
      const L = (p, q) => (snap ? q : p + (q - p) * u);
      return { id: fb[0], x: L(fa && fa[1], fb[1]), y: L(fa && fa[2], fb[2]), a: L(fa && fa[3], fb[3]), alive: !!fb[4], team: ri.team, name: ri.name };
    });
    const ca = a.c;
    const crates = b.c.map((cb, i) => [ca[i][0] + (cb[0] - ca[i][0]) * u, ca[i][1] + (cb[1] - ca[i][1]) * u, ca[i][2] + (cb[2] - ca[i][2]) * u]);
    return { fighters, crates };
  }

  function sendClientInput(now) {
    if (!client) return;
    const msg = { rot: +input.rot.toFixed(2), ax: +input.aim.x.toFixed(2), ay: +input.aim.y.toFixed(2), aim: input.aimActive };
    const key = JSON.stringify(msg);
    if (key !== net.lastSent || now - net.lastSentAt > INPUT_HEARTBEAT) { client.sendInput(msg); net.lastSent = key; net.lastSentAt = now; }
  }

  // ───────────────────────── Views ─────────────────────────
  let lastMe = null;
  function withVelocity(view, dt) {
    const me = view.fighters.find(f => view.me && f.id === view.me.id);
    if (me && lastMe && dt > 0) me.vx = Math.max(-25, Math.min(25, (me.x - lastMe.x) / (dt * 60)));
    lastMe = me ? { x: me.x } : null;
    return view;
  }

  function simView(now) {
    const fighters = [...sim.fighters.values()].map(f => ({ id: f.id, x: f.body.position.x, y: f.body.position.y, a: f.body.angle, alive: f.alive, team: f.team, name: f.name }));
    const me = sim.fighters.get(myId);
    return {
      fighters, crates: sim.crateBodies.map(b => [b.position.x, b.position.y, b.angle]),
      me: me ? { id: myId, ...sim.privateState(myId) } : null,
      score: mode === 'host' ? [sim.score[1], sim.score[2]] : null,
    };
  }

  // ───────────────────────── Menu / UI ─────────────────────────
  function setStatus(t) { $('status').textContent = t; }
  function setMenu() {
    const inRoom = mode !== 'solo';
    $('btnLeave').hidden = !inRoom;
    $('btnHost').hidden = $('btnJoin').hidden = $('code').hidden = inRoom;
    $('btnCopy').hidden = mode !== 'host' || !host || !host.code;
    if (mode === 'solo') { setStatus('Practice — host a game or enter a code to join friends.'); $('roster').textContent = ''; return; }
    const code = mode === 'host' ? (host && host.code) : (client && client.code);
    const r = mode === 'host' ? [...sim.fighters.values()].filter(f => !f.bot).map(f => [f.id, f.name, f.team]) : [...roster].map(([id, v]) => [id, v.name, v.team]);
    setStatus(code ? `Room ${code} · ${r.length}/${CubeNet.MAX_PLAYERS} players` + (mode === 'host' ? ' · keep this tab in the foreground' : '') : 'Connecting…');
    const team = t => r.filter(p => p[2] === t).map(p => p[1] + (p[0] === myId ? ' (you)' : '')).join(', ') || '—';
    $('roster').innerHTML = '';
    for (const t of [1, 2]) {
      const d = document.createElement('div');
      d.className = 't' + t; d.textContent = `Team ${t}: ${team(t)}`;
      $('roster').appendChild(d);
    }
  }

  try { $('name').value = localStorage.getItem('cl_name') || ''; } catch (e) { /* ignore */ }
  $('btnHost').onclick = () => { $('btnHost').blur(); startHost(); };
  $('btnJoin').onclick = () => { $('btnJoin').blur(); const c = CubeNet.cleanCode($('code').value); if (c.length === 5) startClient(c); else setStatus('Enter the 5-character room code.'); };
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });
  $('btnLeave').onclick = () => { $('btnLeave').blur(); startSolo(); };
  $('btnCopy').onclick = () => {
    $('btnCopy').blur();
    const url = location.origin + location.pathname + '?join=' + host.code;
    try { navigator.clipboard.writeText(url); setStatus('Invite link copied: ' + url); } catch (e) { setStatus(url); }
  };

  // ───────────────────────── Main loop ─────────────────────────
  let last = performance.now(), acc = 0;
  function frame(nowMs) {
    const dt = Math.min(0.1, (nowMs - last) / 1000); last = nowMs;
    const now = nowMs / 1000;
    pollInput();
    let view;

    if (mode === 'client') {
      sendClientInput(now);
      const cv = clientView(now);
      view = cv ? { ...cv, me: net.me ? { id: myId, ...net.me } : null, score: net.score } : { fighters: [], crates: [], me: null, score: null };
    } else if (sim) {
      sim.setInput(myId, { rot: input.rot, ax: input.aim.x, ay: input.aim.y, aim: input.aimActive });
      acc += dt * 1000;
      let n = 0;
      while (acc >= STEP_MS && n < 5) {
        sim.step(); acc -= STEP_MS; n++;
        if (mode === 'host' && ++stepsSinceSnap >= SNAP_EVERY) {
          stepsSinceSnap = 0;
          const evs = sim.drainEvents();
          for (const ev of evs) renderer.handleEvent(ev, myId, now);
          if (host && host.players.size) host.broadcast(sim.snapshot(), pendingEv.concat(evs));
          pendingEv = [];
        }
      }
      if (n === 5) acc = 0;
      if (mode === 'solo') for (const ev of sim.drainEvents()) renderer.handleEvent(ev, myId, now);
      view = simView(now);
    }
    view = view || { fighters: [], crates: [], me: null, score: null };
    view.now = now;
    view.aim = { active: input.aimActive, x: input.aim.x, y: input.aim.y };
    renderer.draw(withVelocity(view, dt), dt);
    requestAnimationFrame(frame);
  }

  startSolo();
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) { $('code').value = CubeNet.cleanCode(joinCode); startClient(joinCode); }
  requestAnimationFrame(frame);

  // Debug / test hook
  window.__game = {
    CFG, input, keys,
    get sim() { return sim; }, get mode() { return mode; }, get myId() { return myId; },
    get host() { return host; }, get client() { return client; }, get net() { return net; },
    get roster() { return roster; }, get time() { return sim ? sim.time : 0; },
    stepSim: () => sim && sim.step(), startSolo, startHost, startClient,
  };
})();
