# Cube League

A minimalist, physics-based 2D arena game where you are a cube.

**Play:** https://jareddarkus.github.io/cubeleague/  _(GitHub Pages: Settings → Pages → deploy from branch)_

## Controls

| Action | Keyboard | PS4 / gamepad |
| --- | --- | --- |
| Roll on ground / steer in air | `A` / `D` | Left stick left / right |
| Fall slower (`W`) / **fast fall** (`S` while descending, Smash-style: snaps to a faster fall until you land) | `W` / `S` | Left stick up / down |
| **Jump** off anything you touch, or **dash** from the void (nothing touched) | `Space` | R1 |
| Aim a jump or dash | `W` `A` `S` `D` | Either stick (right overrides left) |
| Reset (practice only) | `R` | Options |
| Hide help / show FPS | `H` / `F` | |

No aim → a jump goes straight off the surface and a dash goes the cube's own facing direction (there is no marker on the cube). Jumping works within a short window (0.3 s) after touching any part of the cube to anything; a dash is a jump from the void. Dashes have a short 0.25 s cooldown; pressing early is buffered, so mashing works.

## Mechanics

- Everything collides: walls, floating blocks, pushable crates, other cubes.
- Every cube has 3 hearts. A dash hits only while the **thin blue outline** is on your cube.
- A hit reveals the target's hearts to everyone for 2 seconds. Your own hearts are always in the top-right corner.
- **Dash reset:** touch a surface with the middle of one of your edges (about the centre 40%, roughly ±20° of tilt) and you get your dash back — walls, floors, ceilings, crates and other cubes all count. Any other touch (a corner) still lets you jump but does not restore the dash. Corners alone don't count.

## Multiplayer (host / join, peer-to-peer)

- **Host game** → you get a 5-character room code and an invite link (`?join=CODE`). Friends enter the code (or open the link) and **Join**. Up to 6 players (3v3), auto-balanced onto teams.
- The **host's browser runs the match** (authoritative physics); everyone else sends inputs and gets snapshots over WebRTC (PeerJS). A match makes **zero backend calls** — only the free PeerJS broker is used for the handshake.
- Hearts are secret on the wire: snapshots contain positions only, each player is sent just their own hearts, and a hit briefly reveals the victim's hearts to everyone.
- Keep the host's tab in the foreground (browsers throttle background tabs). Strict NATs may need a TURN server (not configured yet).
- Scoreboard (bottom centre) counts eliminations per team; there is no win condition yet.

## Layout & tests

```
index.html      canvas, menu, help
js/sim.js       pure Matter.js simulation (no DOM) – also runs under Node
js/net.js       PeerJS host/client
js/render.js    canvas renderer (reads a plain "view" object)
js/game.js      input, solo/host/client modes, main loop, menu
lib/            vendored matter.min.js 0.20.0, peerjs.min.js 1.5.4
test/           node test/sim.test.js · node test/e2e.js (2 headless browsers + local PeerJS broker)
```

## Roadmap

- [x] Single-player sandbox (physics, jump/dash, dash reset, hearts, bots, gamepad)
- [x] Host / join matches peer-to-peer (WebRTC) so a match costs no backend calls
- [ ] Client-side prediction, win condition / rounds, TURN fallback
- [ ] Accounts, usernames, stats and high scores (Supabase)
- [ ] 3v3 teams, goals/objectives

## Development

Static site, no build step. Serve the folder with any static server:

```bash
python3 -m http.server 8000
```

Physics by [Matter.js](https://brm.io/matter-js/) (vendored in `lib/`).
