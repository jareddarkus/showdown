/* Cube League — game shell: input, modes (solo / host / client), main loop, menu.
 * Simulation lives in sim.js, networking in net.js, drawing in render.js. Everything is buildless.
 */
(() => {
  'use strict';
  const { CFG, STEP_MS } = CubeSim;
  const $ = id => document.getElementById(id);

  const SNAP_EVERY = 2;        // host sends a snapshot every N sim steps (60/2 = 30 Hz)
  const INTERP_DELAY = 0.10;   // s — clients render this far in the past so they can interpolate
  const INPUT_HEARTBEAT = 0.1;

  const renderer = CubeRender.create($('c'));

  // ───────────────────────── Mode state ─────────────────────────
  let mode = 'solo';           // 'solo' | 'host' | 'client'
  let sim = null;              // solo + host only
  let host = null, client = null;
  let myId = 0;
  let roster = new Map();      // id -> {name, team}   (clients; host/solo read the sim)
  let stepsSinceSnap = 0;
  const net = { snaps: [], offset: null, me: null, score: [0, 0], lastSent: '', lastSentAt: 0 };

  function teardown() {
    if (host) host.close();
    if (client) client.close();
    host = client = sim = null;
    net.snaps = []; net.offset = null; net.me = null; net.score = [0, 0]; net.lastSent = '';
    stepsSinceSnap = 0; roster = new Map();
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
  // rot/mx/my = moving (A/D roll + air steer, W/S float/dive); ax/ay/aim = the direction a jump or dash goes.
  const input = { rot: 0, mx: 0, my: 0, aim: { x: 0, y: 0 }, aimActive: false, face: false, faceG: false };
  const typing = e => e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  function pressSpace() {
    if (mode === 'client') { if (client) { client.pressSpace(); sendClientInput(performance.now() / 1000, true); } }   // send NOW, not at the next heartbeat
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
    if (e.code === 'KeyF') perf.show = !perf.show;
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  // Controller (Standard mapping, PS4-friendly): left stick = move / fall control, right stick = dash + jump direction,
  // R1 = jump then dash, Options = reset (practice only). Nothing else is bound.
  const padEl = $('pad');
  function pollInput() {
    const k = c => keys.has(c) ? 1 : 0;
    let rot = k('KeyD') - k('KeyA'), mx = rot, my = k('KeyS') - k('KeyW');
    let ax = mx, ay = my;
    const m = Math.hypot(ax, ay);
    if (m > 0) { ax /= m; ay /= m; }
    let aimActive = m > 0, face = false, faceG = false;

    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (gp) {
      padEl.textContent = '🎮 controller connected'; padEl.classList.add('on');
      const dz = v => (Math.abs(v) < 0.2 ? 0 : v);
      const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0);
      if (lx !== 0) { rot = mx = lx; }
      if (ly !== 0) my = ly;
      // Left stick aims too (any direction you hold it); the right stick overrides it when it is pushed.
      const lm = Math.hypot(lx, ly);
      if (lm > 0.35) { ax = lx / lm; ay = ly / lm; aimActive = true; face = true; faceG = Math.abs(ly / lm) > 0.7; }   // left stick turns the cube on the ground only when pushed up/down (sideways = roll)
      const rx = gp.axes[2] || 0, ry = gp.axes[3] || 0, rm = Math.hypot(rx, ry);
      if (rm > 0.35) { ax = rx / rm; ay = ry / rm; aimActive = true; face = true; faceG = true; }   // right stick always turns it
      const r1 = !!(gp.buttons[5] && gp.buttons[5].pressed), opt = !!(gp.buttons[9] && gp.buttons[9].pressed);
      if (r1 && !gpPrev.jump) pressSpace();
      if (opt && !gpPrev.respawn) tryRespawn();
      gpPrev = { jump: r1, respawn: opt };
    } else {
      padEl.textContent = '🎮 press any controller button to connect'; padEl.classList.remove('on');
    }
    input.rot = rot; input.mx = mx; input.my = my;
    input.aim.x = ax; input.aim.y = ay; input.aimActive = aimActive; input.face = face; input.faceG = faceG;
  }

  // ───────────────────────── Client: snapshots → interpolated view ─────────────────────────
  const nowSec = () => performance.now() / 1000;

  function onSnap(msg) {
    const now = nowSec(), s = msg.s;
    const o = now - s.t;
    // Track how fast the host's clock really runs (a laggy host sims slower than wall time) instead of assuming 1:1.
    net.offset = net.offset === null ? o : net.offset + (o - net.offset) * 0.08;
    net.snaps.push(s);
    if (net.snaps.length > 30) net.snaps.shift();
    net.me = msg.me; net.score = s.s;
    for (const ev of msg.ev || []) renderer.handleEvent(ev, myId, now);
  }

  function clientView(now) {
    const sn = net.snaps;
    if (!sn.length) return null;
    const rt = Math.min((now - net.offset) - INTERP_DELAY, sn[sn.length - 1].t);   // never play past the newest snapshot
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

  function sendClientInput(now, force = false) {
    if (!client) return;
    const r2 = v => +v.toFixed(2);
    const msg = { rot: r2(input.rot), mx: r2(input.mx), my: r2(input.my), ax: r2(input.aim.x), ay: r2(input.aim.y), aim: input.aimActive, face: input.face, faceG: input.faceG };
    const key = JSON.stringify(msg);
    if (force || key !== net.lastSent || now - net.lastSentAt > INPUT_HEARTBEAT) { client.sendInput(msg); net.lastSent = key; net.lastSentAt = now; }
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
  // Simulation runs on its own clock (advanceSim), driven by a Worker timer. Browsers throttle requestAnimationFrame and
  // main-thread timers in background windows, which would freeze a host the other players are depending on.
  let simLast = performance.now(), simAcc = 0;
  function advanceSim(nowMs) {
    if (!sim) { simLast = nowMs; return; }
    const dtMs = Math.min(250, nowMs - simLast); simLast = nowMs;
    simAcc += dtMs;
    const now = nowMs / 1000;
    let n = 0;
    while (simAcc >= STEP_MS && n < 15) {
      sim.step(); simAcc -= STEP_MS; n++;
      if (mode === 'host' && ++stepsSinceSnap >= SNAP_EVERY) {
        stepsSinceSnap = 0;
        const evs = sim.drainEvents();
        for (const ev of evs) renderer.handleEvent(ev, myId, now);
        if (host && host.players.size) host.broadcast(sim.snapshot(), evs);
      }
    }
    if (n === 15) simAcc = 0;
    if (mode === 'solo') for (const ev of sim.drainEvents()) renderer.handleEvent(ev, myId, now);
  }
  try {
    const src = 'let id=null;onmessage=e=>{if(e.data==="start"&&!id)id=setInterval(()=>postMessage(0),8);};';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = () => advanceSim(performance.now());
    w.postMessage('start');
  } catch (e) { /* no worker: frame() below still advances the sim */ }

  // perf: press F in game to show fps / sim ms / draw ms. If the framerate stays low the renderer lowers its resolution.
  const perf = { show: false, frames: 0, t0: performance.now(), fps: 0, simMs: 0, drawMs: 0, slow: 0 };
  let last = performance.now();
  function frame(nowMs) {
    // 120/144 Hz displays: draw every other refresh so we never spend more than ~60 draws/s.
    if (nowMs - last < 15) { requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (nowMs - last) / 1000); last = nowMs;
    const now = nowMs / 1000;
    pollInput();
    const tSim = performance.now();
    let view;

    if (mode === 'client') {
      sendClientInput(now);
      const cv = clientView(now);
      view = cv ? { ...cv, me: net.me ? { id: myId, ...net.me } : null, score: net.score } : { fighters: [], crates: [], me: null, score: null };
    } else if (sim) {
      sim.setInput(myId, { rot: input.rot, mx: input.mx, my: input.my, ax: input.aim.x, ay: input.aim.y, aim: input.aimActive, face: input.face, faceG: input.faceG });
      advanceSim(performance.now());
      view = simView(now);
    }
    perf.simMs += (performance.now() - tSim - perf.simMs) * 0.1;
    view = view || { fighters: [], crates: [], me: null, score: null };
    view.now = now;
    view.aim = { active: input.aimActive, x: input.aim.x, y: input.aim.y };
    const tDraw = performance.now();
    renderer.draw(withVelocity(view, dt), dt);
    perf.drawMs += (performance.now() - tDraw - perf.drawMs) * 0.1;
    updatePerf(nowMs);
    requestAnimationFrame(frame);
  }

  function updatePerf(nowMs) {
    perf.frames++;
    if (nowMs - perf.t0 < 1000) return;
    perf.fps = Math.round(perf.frames * 1000 / (nowMs - perf.t0)); perf.frames = 0; perf.t0 = nowMs;
    if (perf.show) $('fps').textContent = `${perf.fps} fps · sim ${perf.simMs.toFixed(1)} ms · draw ${perf.drawMs.toFixed(1)} ms · res ${renderer.dprCap().toFixed(1)}×`;
    $('fps').hidden = !perf.show;
    // Safety net: a slow GPU/browser gets a lower canvas resolution instead of a stuttering game.
    if (document.visibilityState === 'visible' && perf.fps < 48) { if (++perf.slow >= 3) { renderer.lowerResolution(); perf.slow = 0; } } else perf.slow = 0;
  }

  startSolo();
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) { $('code').value = CubeNet.cleanCode(joinCode); startClient(joinCode); }
  requestAnimationFrame(frame);

  // Debug / test hook
  window.__game = {
    CFG, input, keys, perf,
    get sim() { return sim; }, get mode() { return mode; }, get myId() { return myId; },
    get host() { return host; }, get client() { return client; }, get net() { return net; },
    get roster() { return roster; }, get time() { return sim ? sim.time : 0; },
    stepSim: () => sim && sim.step(), startSolo, startHost, startClient,
  };
})();
