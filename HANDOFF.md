# Cube League — handoff for the next Claude session

> **Latest changes (session 2, later):** (a) air control: A/D steer, W floats, S dives (`AIR_*` in `CFG`); (b) the dash/flip reset now needs the **middle of an edge** to touch a surface (3 probe points ±12 px around each edge midpoint, 6 px reach ≈ ±20° tilt; `RESET_CENTER_HALF`/`RESET_REACH`) instead of two corners — the old §2 "Flip/dash reset" description (two corners / `FLUSH_DEG`) is obsolete. Owner wants replies kept to max 2 short paragraphs (≈40 words each).

> **Update (session 2):** Step B (P2P multiplayer) is **done and tested** — see §6 at the bottom. Repo rename to `cubeleague` and GitHub Pages are still **manual** (the proxy returns 403 on settings writes: `PATCH /repos/...` rename → 403 again this session). Steps C (Supabase) and D remain.


Read this whole file first. It contains the owner's vision, what already exists, what is blocked, and what to do next.
The owner (GitHub: `jareddarkus`) has granted **full permission** to create/modify/delete repos, Supabase projects, tables, etc. when the tools allow it. Act autonomously; ask only if truly blocked.

## Versioning (owner request)
The version shows bottom-right in the game (`js/version.js`, `window.CUBE_VERSION`). **Bump it on every update** and add a line here. Host and client must match (handshake refuses mismatches).

CHANGELOG
- 0.6.0 — controller remap (left stick = move + fall control, right stick = dash AND jump direction, R1 = jump/dash, Options = reset in practice; nothing else bound); jump can now be aimed (right stick only, ≤60° from the surface normal; keyboard jumps stay vertical); plain 0.25 s dash cooldown + 0.15 s press buffer (stops infinite ceiling-sticking; mashing works); other cubes count as surfaces for jump/dash reset; stronger air control; perf: render capped to ~60 draws/s, opaque canvas, no backdrop-filter, allocation-free contact scan, auto-lowers canvas resolution if fps<48, `F` shows fps/sim/draw ms. Inputs are now `rot, mx, my` (move) + `ax, ay, aim, jaim` (aim).
- 0.5.0 — cubes bigger (56→80 px, reset zone/offsets scaled), coyote 0.32 s (bigger cube hops more while rolling), version label + handshake check
- 0.4.0 — dash reset = middle of an edge touches a surface
- 0.3.0 — air control (A/D steer, W float, S dive)
- 0.2.0 — P2P host/join multiplayer
- 0.1.0 — single-player sandbox

---

## 1. Product vision (from the owner, paraphrased faithfully)

**Cube League** — a web-based, real-time competitive game hosted on **GitHub Pages**.

- You are a square, called a **cube**. 2D, **minimalist** look.
- **A / D** rotate the cube left/right (2D rotation). Rotation is also how you move on the ground (roll).
- **Space** = jump. **Second Space press** = dodge/dash ("like a Pokémon tackle"), in the direction given by **W/A/S/D**.
- Fully **physical**: the cube collides with everything (walls, floating objects, pushable objects, other cubes).
- **Flip-reset mechanic (Rocket League style):** if **two corners touch any surface at the same time**, you get an **extra dash** back.
- Map: has a **ceiling and a floor**, is **wide** (platformer-like but not really). Each team starts on one side.
- **Floating objects** (squares/rectangles only, so flip resets are achievable) plus **pushable objects**.
- **Hearts:** every cube has **3 hearts**. A dash hit during the **dash window** removes 1 heart.
  - When a cube is hit, everyone sees its hearts for **2 seconds**, then they become hidden again.
  - Your **own** hearts are never shown above your cube — only in the **top-right corner of your screen**.
- While dashing, the borders of your own cube are drawn with a **thin blue line** = the window in which a hit actually counts (only the local player needs to see this).
- Modes: **3 vs 3**. Players can **host** or **join** a game.
- **Supabase budget concern (~500k calls/month on free tier):** matches must NOT hit Supabase repeatedly. Matches are hosted by a player (peer-to-peer); Supabase is only for **accounts, usernames, emails/passwords, high scores, statistics**.
- **PS4 controller support** via the browser, for more accurate (analog) dash direction.

Current phase asked by owner: "something very simple that I can move around", just them playing alone first. **That is done** (see §2). Multiplayer + accounts are next.

---

## 2. What exists today (single-player sandbox) — all in this repo

Static site, **no build step**. Files:

```
index.html        canvas + help panel (DOM) + controller status line
js/game.js        entire game (physics, input, render, HUD) in one IIFE
lib/matter.min.js vendored Matter.js 0.20.0 (do not use a CDN; keep it vendored)
README.md         player-facing docs
HANDOFF.md        this file
```

Debug hook: `window.__game = { CFG, engine, player, fighters, input, keys, stepSim, time, respawn, Matter }`.
Tests used it: drive `__game.stepSim()` deterministically, set body state with `Matter.Body.*`, inspect `player.canDash` etc.

### Implemented mechanics (and how)

- **Fixed 60 Hz step** (`STEP_MS`), accumulator loop, `Engine.update(engine, STEP_MS)`. Matter velocities are **px per 1/60 s step**, not px/s. Gravity `engine.gravity.scale = 0.0016` (~1600 px/s²).
- **Arena:** 3200×1100 px; thick static walls/floor/ceiling (100 px, to avoid tunnelling). Static floating rectangles, ceiling "hangers", a centre block, and dynamic pushable crates (`crate()` with low density). Layout arrays are near the top of `game.js`.
- **Rotation:** A/D (or gamepad) builds angular velocity toward `±ROT_MAX` with `ROT_ACCEL`. On ground this rolls the cube (~340 px/s). Light spin damping only in air.
- **Jump:** only when a floor contact (normal pointing up, `n.y < -0.65`) was seen within `COYOTE` 0.1 s. Launches along the stored floor normal. Leaving a floor without jumping burns the jump, so the next Space is a dash.
- **Dash:** sets velocity to `dir * DASH_V`, cancels gravity during `DASH_WINDOW` (0.24 s), halves-ish spin. Direction = held WASD / gamepad stick (analog, any angle); if nothing held, the cube's **local +x** (marked by the **white dot**).
- **Dash window / hit:** while `dashT > 0` any contact with an enemy-team fighter counts once per dash (`dashHit` set) → `hit()`: −1 heart, reveal hearts 2 s (`heartsUntil`), flash, particles, knockback, death → respawn after 2.5 s. Blue outline drawn while `dashT > 0` for the local player.
- **Flip/dash reset:** `scanContacts()` uses `Matter.Collision.collides` per nearby body. Counts the cube's own corners in `collision.supports` (supports may contain `null`s — filter them). Contact **normal must be re-oriented** toward the cube (Matter's sign convention varies). A contact is **"flush"** if ≥2 own corners, or ≥1 corner and the face toward the surface is within `FLUSH_DEG` = 8° of parallel (forgiving; exact-2-corner proved too strict because the leading corner bounces away). Flush contact on any non-fighter surface restores the dash; flush on a floor also restores the jump. `RESET_LOCKOUT` 0.12 s after a jump/dash prevents instant re-reset.
- **Hearts:** 3 per cube. Bots show hearts only for 2 s after being hit. Local player's hearts + JUMP/DASH availability pips are in a top-right HUD panel.
- **Bots:** 3 yellow stationary team-2 dummies (they're real physics bodies and can be shoved).
- **Gamepad (Gamepad API, "standard" mapping, PS4-friendly):** left stick/D-pad = aim, ✕(0) = jump/dash, R1/L1 (5/4) + right stick X (axes[2]) + R2/L2 (7/6) = rotate, Options (9) = respawn. Chrome needs one button press before the pad is exposed. **Not tested with a physical pad** (only keyboard in headless Chromium).
- **Rendering:** Canvas 2D, camera follows the player horizontally, whole arena height always visible. Palette in `COLORS` (team1 coral `#ff6a4d`, team2 amber `#f2b632`, solids `#23232b`, dash outline blue `#1e88ff`).

### Verified in headless Chromium (Playwright is preinstalled; `require('playwright')`)

Rolling works, jump ≈ 190–210 px, dash sets ~17.4 px/step, hit on a bot removes a heart and reveals hearts ≈2 s, flush contact resets dash on: underside of floating square, ceiling, wall, top of a square; a 45° corner-only hit does **not** reset; ≤~12° tilt does reset. No console errors.

### Known gaps / ideas (not done)

- No scoring/goal/objective yet — only a sandbox. Decide a win condition for 3v3 (e.g., last team standing in rounds, or a ball/goal). Ask the owner if unclear.
- Bots don't move or fight back.
- No touch/mobile controls.
- Dash while spinning doesn't add RL-style flip torque.
- Camera doesn't zoom for different aspect ratios beyond a simple min() scale.

---

## 3. Blockers learned from the previous session (IMPORTANT)

The previous session's GitHub proxy **only allowed attached repos and git pushes**:

- ❌ `POST /user/repos` (create repo) → 403 ("sessions are bound to their configured repositories")
- ❌ `PATCH /repos/{o}/{r}` (rename, settings) → 403 ("Repository settings writes are not permitted")
- ❌ `POST /repos/{o}/{r}/pages` (enable Pages) → 403
- ❌ GraphQL → 403. Use the REST API only.
- ✅ `git push` to an attached repo works (needed `add_repo` with `access: "push"` first).

So the repo is **`jareddarkus/showdown`** (an old, empty repo the owner repurposed; default branch `master`). Code was pushed there, but the owner must do these by hand in the GitHub UI (if not done yet — **check `gh api repos/jareddarkus/showdown` for `name`/`has_pages` first**):

1. Settings → General → rename the repo to `cube-league` (owner wrote "Cube Lake", almost certainly a typo for Cube League).
2. Settings → Pages → Deploy from a branch → `master` / `/ (root)`.

The README links to `https://jareddarkus.github.io/cube-league/`. If the repo was not renamed, the live URL is `https://jareddarkus.github.io/showdown/` — fix the README link accordingly. All asset paths in `index.html` are **relative** so it works under a project sub-path.

If this new session has broader GitHub tools (e.g., can create repos / enable Pages), just do it: create or rename to `cube-league`, push, enable Pages on the default branch, then verify `curl -sI https://jareddarkus.github.io/<repo>/` returns 200.

Git identity used for commits: `jareddarkus` with the GitHub **noreply** email (`<id>+jareddarkus@users.noreply.github.com`) — do **not** put the owner's real email in a public repo.

---

## 4. Next steps (suggested order)

### Step A — Get it live
Confirm Pages is enabled and the game loads at the public URL (see §3). Test in a real browser if a browser tool is available.

### Step B — Peer-to-peer multiplayer (host / join), zero Supabase calls during a match

Goal: **host a game or join one** with a short **room code**; match traffic never touches Supabase.

Recommended design:
- **WebRTC data channels via PeerJS** (free public broker `0.peerjs.com`; vendor `peerjs.min.js` into `lib/` rather than CDN). Optional: add a free TURN fallback later; STUN alone fails on some NATs — mention this to the owner.
- Star topology: the **host's browser is authoritative** and runs the Matter.js simulation (reuse the existing fixed-step loop and `stepSim`). Up to 6 peers (3v3) connect to the host.
- Room code = the host's Peer ID (make it short/readable, e.g. 5 uppercase chars, used as the peer id prefix like `cubeleague-ABCDE`). UI: "Host game" → shows code; "Join game" → enter code. Team assignment: auto-balance, host can swap.
- **Clients send inputs** (rot, aim vector, space edge events with a sequence number) at ~60 Hz (or on change + heartbeat).
- **Host broadcasts snapshots** (positions, angles, velocities, angular vel, dash state, crates) at ~20–30 Hz. Clients **interpolate** remote bodies (~100 ms buffer); local player can use simple client-side prediction + reconciliation, or start without prediction and add it after it works.
- **Hearts secrecy is a protocol rule, not just a UI rule:** the host must send each player's exact hearts **only to that player**. Other players receive only `hit` events (`targetId`, `heartsLeft`, `revealUntil`) so they can display hearts for 2 s. Don't put everyone's hearts in the broadcast snapshot.
- Dash-window blue outline: local-only visual; hit validation happens on the host.
- Refactor `game.js` first: split into modules (`sim.js` pure simulation with no DOM, `render.js`, `input.js`, `net.js`) so the host sim can run headless-testable. Keep it buildless (plain `<script>` tags or native ES modules) so GitHub Pages serves it as is.
- Tests: write a Node/Playwright test with two pages (host + client) in headless Chromium over localhost PeerJS if feasible; otherwise unit-test the sim and message codecs.

### Step C — Accounts, usernames, stats, high scores (Supabase)

The owner connected Supabase and granted rights. Tools are available as `mcp__Supabase__*` (load them via ToolSearch first; they are deferred). Typical flow:

1. `list_organizations` / `list_projects` — reuse an existing project if sensible; otherwise `create_project` (check cost/confirmation requirements — free tier allows a limited number of projects).
2. Use **Supabase Auth** (email + password). **Never store passwords or hash them yourself.** The owner mentioned "usernames, emails, passwords" — Supabase Auth already stores email/password securely.
3. Migration via `apply_migration`, with **RLS on every table**:
   - `profiles (id uuid pk references auth.users on delete cascade, username text unique not null check (length between 3 and 20 and matches ^[A-Za-z0-9_]+$), created_at timestamptz default now())` — auto-create row via trigger on `auth.users` insert, or on first login.
   - `player_stats (user_id uuid pk references profiles, matches int, wins int, losses int, hits int, deaths int, dash_resets int, updated_at)`.
   - `match_results (id, host_id, played_at, duration_s, team1_score, team2_score, ...)` and `match_players (match_id, user_id, team, hits, deaths, dash_resets)` if per-match history is wanted.
   - A `leaderboard` view (public read, only username + aggregate stats).
   - Policies: anyone can read leaderboard/profile usernames; users can read/update only their own rows; **stat writes should go through a `SECURITY DEFINER` RPC or an Edge Function** so clients can't just write arbitrary scores. Since the host is a player (untrusted), be honest with the owner that peer-to-peer matches can't be made cheat-proof; mitigations: each participant reports the result, server stores only if reports agree (a simple 2-of-N consensus RPC), rate-limit submissions.
4. Client: `@supabase/supabase-js` vendored into `lib/` (or loaded from a pinned jsDelivr URL). Use the **publishable/anon key** (`get_publishable_keys`) and project URL (`get_project_url`) in the client — these are safe to ship **only because RLS is on**. Never commit the service-role key.
5. **Call budget:** sign-in/up once per session, fetch the leaderboard on demand (cache it), and write stats **once at the end of a match** (one RPC call per player or one batched call from the host). No calls per tick/per hit.
6. Run `get_advisors` (security + performance) after migrations and fix findings.
7. UI: minimal login/sign-up modal, username shown in-game, "Play as guest" path so unauthenticated people can still host/join (stats just aren't saved).

### Step D — Game design depth (ask the owner before big decisions)

3v3 spawn sides, win condition/round format, bots that fight back for solo practice, map variants, sound, touch controls, better visuals while staying minimalist.

---

## 5. Working notes / gotchas

- Matter.js 0.20: `Collision.collides(a, b)` returns a collision or `null`; `collision.supports` may contain `null`; vertices have `.body` and `.index`. Static rectangles are axis-aligned, so contact normals are axis-aligned; still orient them toward the cube.
- Don't change timestep per frame; velocities are per-step and the code assumes a constant `STEP_MS`.
- Dash cancels gravity by subtracting `mass * gravity.y * gravity.scale` from `body.force.y` in `preStep` (forces are cleared by Matter each update).
- Keep everything buildless and relative-pathed for GitHub Pages sub-path hosting.
- Playwright + Chromium are preinstalled in the cloud container; serve with `python3 -m http.server`. Screenshot with `deviceScaleFactor: 1` unless a human will view it.
- The owner's gamepad is a **PS4 controller** (standard mapping in Chrome/Edge/Firefox). If you can't test with real hardware, say so.
- The owner writes casually (voice-dictated); interpret intent generously, but state your interpretation (e.g., "Cube Lake" → Cube League).
- Don't commit secrets. Anon/publishable Supabase keys are OK in client code **only with RLS enabled**.
- Don't create PRs unless asked; the owner is fine with pushing directly to the default branch of this repo.

---

## 6. Session 2 — what changed (multiplayer)

**Architecture (all buildless, plain `<script>` tags, load order matters):** `matter.min.js` → `peerjs.min.js` → `sim.js` → `net.js` → `render.js` → `game.js`.

- `js/sim.js` — pure simulation, `CubeSim.create({bots})`. Fighters are keyed by id (`sim.addFighter/removeFighter/setInput/pressSpace/respawn/step`). It emits discrete **events** (`dash`, `reset`, `hit`, `die`, `spawn`; drain with `sim.drainEvents()`), and exposes `snapshot()` (public positions, **no hearts**) and `privateState(id)` (that player's hearts/jump/dash). Also tracks `score` (eliminations per team) and per-fighter `stats` {hits,kills,deaths,resets} — ready for the Supabase end-of-match report. `LAYOUT` (solids + crates) is shared so clients draw the map without running Matter. Runs in Node: `require('./js/sim.js')`.
- `js/net.js` — `CubeNet.createHost({sim,name,...})` / `CubeNet.joinGame({code,...})`. Peer id = `cubeleague-` + 5-char code. JSON serialization, reliable channel. Client sends `{rot,ax,ay,aim,sp}` on change + 250 ms heartbeat (`sp` = running Space-press counter, so presses aren't lost/doubled). Host broadcasts at 30 Hz (every 2nd step) `{k:'snap', s, me, ev}`; `me` is per-recipient. Host drops peers silent >8 s, clamps/sanitises all client input (`sim.setInput`), and sanitises names. Max 6 players; teams auto-balance. Override the broker with `?peerhost=&peerport=&peerpath=&peersecure=1` (used by tests).
- `js/render.js` — draws from a `view` object; effects (particles, hit flash, 2 s heart reveal) are driven by sim events, identical on host/solo/client.
- `js/game.js` — input (keyboard+gamepad, unchanged mapping), modes `solo|host|client`, client-side snapshot interpolation (100 ms delay, clock offset tracking, snap on respawn), menu UI, `?join=CODE` auto-join. `window.__game` debug hook now exposes `sim, mode, myId, host, client, net, roster, startSolo/startHost/startClient`.
- **Practice (solo) mode** is the default on load (player + 3 stationary bots, `R` respawn). In a hosted match there are no bots and `R` is disabled.

**Tests:** `node test/sim.test.js` (pure sim, 5 tests) and `node test/e2e.js` (27 checks: starts a local PeerJS broker + static server, drives a host page and a client page in headless Chromium: join, team balance, input, jump, dash hit, hearts secrecy on the wire, leave/rejoin/host-leaves, wrong code). Needs `npm i --no-save peer` (Playwright is preinstalled in the cloud container; use `NODE_PATH`). The container has no IPv6, so bind servers to `127.0.0.1`.

**Gameplay tweak:** `COYOTE` 0.10 → 0.17 s. While rolling at full speed the cube hops between corners and floor-contact gaps reach ~0.13 s, so jump silently became a dash ~always when pressed mid-roll. Now 0/40 misfires.

**Known gaps / next:**
1. **No client-side prediction** — a client's own cube is rendered ~100 ms interpolation + RTT behind its input. Biggest feel issue for a dash game. Idea: run Matter on the client for the local cube only (statics known from `LAYOUT`, others/crates as snapshot-driven kinematic bodies) and reconcile to host snapshots.
2. **Host tab must stay foreground** (rAF/timers throttle in background tabs → match freezes). Possible fix: drive the host sim from a Web Worker timer.
3. **TURN not configured** — PeerJS defaults to Google STUN only; symmetric/strict NATs will fail to connect. Add a free/cheap TURN to `peerOptions()` in `net.js` (`config.iceServers`) if players report this.
4. **No win condition**: only an elimination scoreboard (bottom centre). Ask the owner (round format / first-to-N / etc.).
5. **Host can cheat** (authoritative P2P) — as noted in Step C, use multi-party result reporting.
6. Not tested with a physical PS4 pad.
7. Touch controls, bots that fight back, sound: untouched.

**Repo name / Pages:** still `jareddarkus/showdown`. The README now links to `https://jareddarkus.github.io/cubeleague/`, which only works after the owner renames the repo to `cubeleague` (Settings → General) and enables Pages (Settings → Pages → deploy from branch `master` `/`). Work this session was pushed to branch `claude/dreamy-curie-pd0bm7` (session rules); merge to `master` for Pages to serve it. No PR was opened.
