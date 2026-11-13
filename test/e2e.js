// End-to-end: host page + client page in headless Chromium over a LOCAL PeerJS broker (no internet needed).
// Run:  npm i --no-save peer playwright   (playwright is preinstalled in the cloud container)  then  node test/e2e.js
const http = require('http'), fs = require('fs'), path = require('path');
const { PeerServer } = require('peer');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.md': 'text/plain' };
const web = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
}).listen(8765, '127.0.0.1');
PeerServer({ port: 9000, path: '/', host: '127.0.0.1' });
const Q = '?peerhost=127.0.0.1&peerport=9000&peerpath=/';
const URL_ = 'http://127.0.0.1:8765/' + Q;

let passed = 0;
const ok = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); passed++; console.log('ok -', msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (page, fn, msg, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return ok(true, msg); await sleep(100); } throw new Error('TIMEOUT: ' + msg); };

(async () => {
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async name => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
    return page;
  };
  const host = await mk('host'), cli = await mk('client');

  await host.addInitScript(() => {   // mock a standard-mapping pad (PS4-like) we can drive from the test
    window.__pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    navigator.getGamepads = () => [window.__pad];
  });
  await host.goto(URL_);
  ok(await host.evaluate(() => __game.mode === 'solo' && __game.sim.fighters.size === 4), 'solo practice boots with player + 3 bots');
  // ── controller mapping (solo practice) ──
  const pad = (axes, btn) => host.evaluate(([a, b]) => { __pad.axes = a; __pad.buttons.forEach((x, i) => { x.pressed = x.value = (i === b ? 1 : 0); }); }, [axes, btn]);
  await sleep(800);
  const px0 = await host.evaluate(() => __game.sim.fighters.get(0).body.position.x);
  await pad([1, 0, 0, 0], -1); await sleep(1000); await pad([0, 0, 0, 0], -1);
  ok(await host.evaluate(x => __game.sim.fighters.get(0).body.position.x > x + 100, px0), 'controller: left stick right rolls the cube right');
  await sleep(1200);
  await pad([0, 0, 0, 0], 0); await sleep(150); await pad([0, 0, 0, 0], -1);
  ok(await host.evaluate(() => __game.sim.fighters.get(0).canJump === true), 'controller: ✕ (button 0) is not bound to jump');
  const v1 = await host.evaluate(async () => { const f = __game.sim.fighters.get(0); __pad.axes = [0, 0, 1, 0]; await new Promise(r => setTimeout(r, 100)); __pad.buttons[5].pressed = __pad.buttons[5].value = 1; await new Promise(r => setTimeout(r, 120)); __pad.buttons[5].pressed = __pad.buttons[5].value = 0; __pad.axes = [0, 0, 0, 0]; return { vx: f.body.velocity.x, vy: f.body.velocity.y, canJump: f.canJump }; });
  ok(!v1.canJump && v1.vx > 4 && v1.vy < 0, `controller: R1 + right stick right = jump leaning right (vx ${v1.vx.toFixed(1)}, vy ${v1.vy.toFixed(1)})`);
  await sleep(300);
  const dashUp = await host.evaluate(async () => { const f = __game.sim.fighters.get(0); __pad.axes = [0, 0, 0, -1]; await new Promise(r => setTimeout(r, 100)); __pad.buttons[5].pressed = __pad.buttons[5].value = 1; await new Promise(r => setTimeout(r, 100)); __pad.buttons[5].pressed = __pad.buttons[5].value = 0; await new Promise(r => setTimeout(r, 100)); __pad.buttons[5].pressed = __pad.buttons[5].value = 1; await new Promise(r => setTimeout(r, 60)); const d = { dashY: f.dashDir.y, dashT: f.dashT }; __pad.buttons[5].pressed = __pad.buttons[5].value = 0; __pad.axes = [0, 0, 0, 0]; return d; });
  ok(dashUp.dashY < -0.9, 'controller: R1 again in the air dashes where the right stick points (up)');
  await host.evaluate(() => __game.startSolo());

  await host.fill('#name', 'Hosty'); await host.click('#btnHost');
  await until(host, () => __game.mode === 'host' && __game.host && __game.host.code, 'host gets a room code');
  const code = await host.evaluate(() => __game.host.code);
  ok(/^[A-Z2-9]{5}$/.test(code), 'room code is 5 readable chars: ' + code);
  ok(await host.evaluate(() => [...__game.sim.fighters.values()].every(f => !f.bot)), 'no bots in a hosted match');

  // Wire tap on the client: record every raw message from the host.
  await cli.addInitScript(() => {
    window.__wire = [];
    const wrap = () => { if (!window.Peer || window.Peer.__tapped) return; const c = window.Peer.prototype.connect; window.Peer.prototype.connect = function (...a) { const conn = c.apply(this, a); conn.on('data', m => window.__wire.push(JSON.stringify(m))); return conn; }; window.Peer.__tapped = true; };
    document.addEventListener('DOMContentLoaded', wrap); window.addEventListener('load', wrap);
  });
  await cli.goto(URL_);
  await cli.fill('#name', 'Joiner'); await cli.fill('#code', code); await cli.click('#btnJoin');
  await until(cli, () => __game.mode === 'client' && __game.myId > 0 && __game.roster.size === 2, 'client joins and receives roster');
  await until(host, () => __game.sim.fighters.size === 2, 'host sees the new fighter');
  const teams = await host.evaluate(() => [...__game.sim.fighters.values()].map(f => f.team).sort().join());
  ok(teams === '1,2', 'auto-balanced onto opposite teams');

  await until(cli, () => __game.net.snaps.length > 10, 'client receives a stream of snapshots');
  await sleep(500);

  // Client input drives its cube on the host.
  const x0 = await host.evaluate(() => __game.sim.fighters.get(1).body.position.x);
  await cli.keyboard.down('KeyA'); await sleep(1200); await cli.keyboard.up('KeyA');
  const x1 = await host.evaluate(() => __game.sim.fighters.get(1).body.position.x);
  ok(x1 < x0 - 100, `client A-key rolls its cube on the host (${x0 | 0} → ${x1 | 0})`);
  await sleep(1500);   // let it coast to a stop
  const x2 = await host.evaluate(() => __game.sim.fighters.get(1).body.position.x);
  const seen = await cli.evaluate(() => { const v = __game.net.snaps[__game.net.snaps.length - 1].f.find(f => f[0] === __game.myId); return v[1]; });
  ok(Math.abs(seen - x2) < 15, 'client snapshots track the host position');

  // Jump from the client (Space edge via counter).
  await cli.keyboard.press('Space');
  await until(host, () => __game.sim.fighters.get(1).canJump === false, 'client Space → jump on host');
  await until(cli, () => __game.net.me && __game.net.me.jump === false, 'client receives its own private state');

  // Combat: put them face-to-face, host dashes into the client.
  await sleep(800);
  await host.evaluate(() => {
    const { Body } = Matter, s = __game.sim, a = s.fighters.get(0).body, b = s.fighters.get(1).body;
    Body.setPosition(a, { x: 1000, y: 1060 }); Body.setPosition(b, { x: 1100, y: 1060 });
    for (const x of [a, b]) { Body.setVelocity(x, { x: 0, y: 0 }); Body.setAngle(x, 0); Body.setAngularVelocity(x, 0); }
  });
  await sleep(300);
  await host.keyboard.down('KeyD'); await host.keyboard.press('Space'); await sleep(30); await host.keyboard.press('Space'); await host.keyboard.up('KeyD');
  await until(host, () => __game.sim.fighters.get(1).hp === 2, 'host dash hit removes a heart');
  await until(cli, () => __game.net.me.hp === 2, 'victim is told its own hearts (private)');
  await sleep(500);

  // Hearts secrecy on the wire: snapshots carry no hearts; only `hit` events do.
  const wire = await cli.evaluate(() => __wire);
  const snaps = wire.map(JSON.parse).filter(m => m.k === 'snap');
  ok(snaps.length > 10, 'captured raw wire messages (' + snaps.length + ' snaps)');
  ok(snaps.every(m => !/"hp"|heart/i.test(JSON.stringify(m.s))), 'public snapshots never contain hearts');
  ok(snaps.every(m => Object.keys(m.me).sort().join() === 'alive,dash,dashT,hp,jump'), 'private block is only the receiver\'s own state');
  ok(snaps.some(m => (m.ev || []).some(e => e.e === 'hit' && e.hp === 2)), 'hit event reveals victim hearts to everyone');
  // Attacker (host) must never receive the client's private block, and vice versa: client `me` hp is its own.
  ok(await host.evaluate(() => __game.sim.fighters.get(0).hp === 3), 'attacker unharmed');

  // Dash outline is local-only: client view of host has no dash info in snapshots.
  ok(snaps.every(m => m.s.f.every(f => f.length === 6)), 'snapshot rows carry no dash/hearts fields');

  // Client leaves → host roster shrinks.
  await cli.click('#btnLeave');
  await until(host, () => __game.sim.fighters.size === 1, 'host drops a client that leaves');
  ok(await cli.evaluate(() => __game.mode === 'solo'), 'leaving returns client to practice');

  // Rejoin via invite link, then the host leaves → client falls back to solo with a message.
  await cli.goto(URL_ + '&join=' + code);
  await until(cli, () => __game.mode === 'client' && __game.myId > 0, 'invite link ?join=CODE auto-joins');
  await host.click('#btnLeave');
  await until(cli, () => __game.mode === 'solo', 'host leaving drops client back to practice');
  ok(/host left/i.test(await cli.textContent('#status')), 'client is told the host left');

  // Version label + mismatch rejection.
  ok((await cli.textContent('#ver')) === 'v' + (await cli.evaluate(() => CUBE_VERSION)), 'version label is shown in the game');
  await host.click('#btnHost');
  await until(host, () => __game.host && __game.host.code, 'host again');
  const code2 = await host.evaluate(() => __game.host.code);
  await cli.evaluate(() => { window.CUBE_VERSION = '0.0.0'; });
  await cli.fill('#code', code2); await cli.click('#btnJoin');
  await until(cli, () => /Version mismatch/.test(document.getElementById('status').textContent), 'mismatched version is refused with a clear message');
  await until(host, () => __game.sim.fighters.size === 1, 'host drops the mismatched client');

  // Wrong code.
  await cli.fill('#code', 'ZZZZZ'); await cli.click('#btnJoin');
  await until(cli, () => /No game found/.test(document.getElementById('status').textContent), 'wrong code → friendly error');

  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log(`\n${passed} checks passed`);
  await browser.close(); web.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
