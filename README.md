# Cube League

A minimalist, physics-based 2D arena game where you are a cube.

**Play:** https://jareddarkus.github.io/cube-league/

## Controls

| Action | Keyboard | PS4 / gamepad |
| --- | --- | --- |
| Rotate (roll on ground, spin in air) | `A` / `D` | R1 / L1, right stick, or R2 / L2 |
| Jump, then press again to **dash** | `Space` | ✕ |
| Aim the dash | `W` `A` `S` `D` | Left stick (analog, any angle) or D-pad |
| Respawn | `R` | Options |
| Hide help | `H` | |

No aim input → the dash goes the way the white dot on your cube points.

## Mechanics

- Everything collides: walls, floating blocks, pushable crates, other cubes.
- Every cube has 3 hearts. A dash hits only while the **thin blue outline** is on your cube.
- A hit reveals the target's hearts to everyone for 2 seconds. Your own hearts are always in the top-right corner.
- **Dash reset:** touch a surface with two corners at once (a flush face contact, ~8° tolerance) and you get your dash back.

## Roadmap

- [x] Single-player sandbox (physics, jump/dash, dash reset, hearts, bots, gamepad)
- [ ] Host / join matches peer-to-peer (WebRTC) so a match costs no backend calls
- [ ] Accounts, usernames, stats and high scores (Supabase)
- [ ] 3v3 teams, goals/objectives

## Development

Static site, no build step. Serve the folder with any static server:

```bash
python3 -m http.server 8000
```

Physics by [Matter.js](https://brm.io/matter-js/) (vendored in `lib/`).
