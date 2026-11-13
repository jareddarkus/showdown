/* Cube League — peer-to-peer networking (PeerJS / WebRTC data channels).
 * Star topology: the host's browser runs the authoritative sim, clients send inputs and receive
 * snapshots. A match never touches Supabase (or any backend) — only the free PeerJS broker is used
 * for the initial WebRTC handshake.
 *
 * Wire format (JSON):
 *   client → host  {k:'hello', name}
 *                  {k:'in', rot, ax, ay, aim, sp}      sp = running count of Space presses
 *   host → client  {k:'welcome', id, roster}   {k:'roster', roster}   {k:'full'}
 *                  {k:'snap', s, me, ev}               s = public snapshot, me = YOUR private state
 * Roster entries are [id, name, team]. Hearts are never in `s`; each client only ever receives its
 * own via `me` (plus public `hit` events, which reveal a victim's hearts for 2 s).
 */
(function (root) {
  'use strict';
  const PREFIX = 'cubeleague-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
  const CODE_LEN = 5;
  const MAX_PLAYERS = 6;
  const TIMEOUT_MS = 8000;

  const newCode = () => { let s = ''; for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; };
  const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  const cleanName = n => String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'Cube';

  // Default = free public PeerJS broker. Override with ?peerhost=&peerport=&peerpath=&peersecure=0 (used by tests).
  function peerOptions() {
    const q = new URLSearchParams(root.location ? root.location.search : '');
    const o = { debug: 0 };
    if (q.get('peerhost')) {
      o.host = q.get('peerhost');
      o.port = Number(q.get('peerport') || 9000);
      o.path = q.get('peerpath') || '/';
      o.secure = q.get('peersecure') === '1';
    }
    return o;
  }

  // ───────────────────────── Host ─────────────────────────
  // sim: CubeSim instance. The host is fighter id 0.
  function createHost({ sim, name, onRoster, onError }) {
    const players = new Map();   // peer id -> { id, name, conn, lastSpace, lastSeen }
    let nextId = 1;
    let peer = null, closed = false;
    const api = { code: null, players };

    const roster = () => [...sim.fighters.values()].filter(f => !f.bot).map(f => [f.id, f.name, f.team]);
    const send = (p, msg) => { try { if (p.conn.open) p.conn.send(msg); } catch (e) { /* closed */ } };
    const broadcastRoster = () => {
      const r = roster();
      for (const p of players.values()) send(p, { k: 'roster', roster: r });
      if (onRoster) onRoster(r);
    };

    // Add the host's own fighter.
    sim.addFighter({ id: 0, name: cleanName(name), team: 1 });

    function dropPlayer(p) {
      if (!players.has(p.conn.peer)) return;
      players.delete(p.conn.peer);
      sim.removeFighter(p.id);
      try { p.conn.close(); } catch (e) { /* noop */ }
      broadcastRoster();
    }

    function onConnection(conn) {
      conn.on('open', () => {
        if (players.size + 1 >= MAX_PLAYERS) { conn.send({ k: 'full' }); setTimeout(() => conn.close(), 300); return; }
        const t1 = sim.teamCount(1), t2 = sim.teamCount(2);
        const team = t1 <= t2 ? 1 : 2;
        const id = nextId++;
        const p = { id, name: 'Cube', conn, lastSpace: 0, lastSeen: performance.now() };
        players.set(conn.peer, p);
        sim.addFighter({ id, name: p.name, team });
        send(p, { k: 'welcome', id, roster: roster() });
        broadcastRoster();
      });
      conn.on('data', msg => {
        const p = players.get(conn.peer);
        if (!p || !msg || typeof msg !== 'object') return;
        p.lastSeen = performance.now();
        if (msg.k === 'hello') {
          const f = sim.fighters.get(p.id);
          if (f) { f.name = cleanName(msg.name); p.name = f.name; broadcastRoster(); }
        } else if (msg.k === 'in') {
          sim.setInput(p.id, msg);
          const sp = Number(msg.sp) | 0;
          if (sp > p.lastSpace) { p.lastSpace = sp; sim.pressSpace(p.id); }   // counter → no double-fire, loss-tolerant
        }
      });
      conn.on('close', () => { const p = players.get(conn.peer); if (p) dropPlayer(p); });
      conn.on('error', () => { const p = players.get(conn.peer); if (p) dropPlayer(p); });
    }

    api.ready = new Promise((resolve, reject) => {
      let tries = 0;
      const open = () => {
        const code = newCode();
        peer = new root.Peer(PREFIX + code, peerOptions());
        peer.on('open', () => { api.code = code; resolve(code); });
        peer.on('connection', onConnection);
        peer.on('error', err => {
          if (err.type === 'unavailable-id' && tries++ < 5) { try { peer.destroy(); } catch (e) { /* noop */ } open(); return; }
          if (!api.code) reject(err);
          else if (onError && !closed) onError(err);
        });
      };
      open();
    });

    // Called by the game ~30×/s with the public snapshot and the events since the last call.
    api.broadcast = (snap, events) => {
      const now = performance.now();
      for (const p of [...players.values()]) {
        if (now - p.lastSeen > TIMEOUT_MS) { dropPlayer(p); continue; }
        send(p, { k: 'snap', s: snap, me: sim.privateState(p.id), ev: events });
      }
    };
    api.close = () => { closed = true; for (const p of players.values()) try { p.conn.close(); } catch (e) { /* noop */ } if (peer) try { peer.destroy(); } catch (e) { /* noop */ } };
    return api;
  }

  // ───────────────────────── Client ─────────────────────────
  function joinGame({ code, name, onWelcome, onRoster, onSnap, onClose }) {
    code = cleanCode(code);
    let peer = null, conn = null, done = false, welcomed = false, spaces = 0;
    const api = { code };
    const fail = reason => { if (done) return; done = true; if (onClose) onClose(reason); api.close(); };

    api.sendInput = inp => { if (conn && conn.open) conn.send({ k: 'in', ...inp, sp: spaces }); };
    api.pressSpace = () => { spaces++; };
    api.close = () => { done = true; try { if (conn) conn.close(); } catch (e) { /* noop */ } try { if (peer) peer.destroy(); } catch (e) { /* noop */ } };

    peer = new root.Peer(peerOptions());
    const timer = setTimeout(() => { if (!welcomed) fail('Could not connect (timed out). Check the code — and note strict NATs may need a TURN server.'); }, 12000);
    peer.on('error', err => fail(err.type === 'peer-unavailable' ? 'No game found with that code.' : 'Connection error: ' + err.type));
    peer.on('open', () => {
      conn = peer.connect(PREFIX + code, { serialization: 'json', reliable: true });
      conn.on('open', () => conn.send({ k: 'hello', name: cleanName(name) }));
      conn.on('data', msg => {
        if (!msg) return;
        if (msg.k === 'welcome') { welcomed = true; clearTimeout(timer); onWelcome(msg.id, msg.roster); }
        else if (msg.k === 'roster') onRoster(msg.roster);
        else if (msg.k === 'snap') onSnap(msg);
        else if (msg.k === 'full') fail('That game is full.');
      });
      conn.on('close', () => { if (done) return; if (welcomed) { done = true; if (onClose) onClose('The host left the game.'); } else fail('Connection closed.'); });
    });
    return api;
  }

  root.CubeNet = { createHost, joinGame, cleanCode, cleanName, MAX_PLAYERS };
})(typeof window !== 'undefined' ? window : globalThis);
