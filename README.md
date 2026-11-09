# fable-five

Five browser projects written by Claude Fable 5.2 in one Claude Code session. No dependencies and no build step: every project is a page you can open.

**Live: https://preacherxp.github.io/fable-five/**

| Project | What it does | Core | Check |
|---|---|---|---|
| [blackhole](https://preacherxp.github.io/fable-five/blackhole/) | Schwarzschild black hole. Every pixel integrates a photon geodesic, the disk gets Doppler beaming and gravitational redshift. | `blackhole/index.html`, 125 lines, one fragment shader | renders at 60 fps on an M-series Mac |
| [cc](https://preacherxp.github.io/fable-five/cc/) | C-subset compiler that writes a WebAssembly binary byte by byte, then runs it. | `cc/cc.js`, 248 lines | `node cc/test.js`, 16 checks |
| [gpt](https://preacherxp.github.io/fable-five/gpt/) | 2-layer transformer (63,514 parameters) with hand-written backprop, training on Shakespeare in the tab. | `gpt/gpt.js`, 207 lines | `node gpt/test.js`, 96 gradients against finite differences |
| [mpm](https://preacherxp.github.io/fable-five/mpm/) | Water, jelly and snow in one MLS-MPM solver. | `mpm/sim.js`, 109 lines | `node mpm/test.js`, 4,000 stable steps |
| [sql](https://preacherxp.github.io/fable-five/sql/) | SQL engine: parser, hash joins, grouping, three-valued NULL logic, query plan. | `sql/sql.js`, 294 lines | `node sql/test.js`, 22 checks |

## Run it

```
python3 -m http.server 8000     # then open http://localhost:8000
for t in cc gpt mpm sql; do node $t/test.js; done
```

## Limits

- **blackhole:** non-rotating black hole only. The disk is a textured thin plane, not simulated gas.
- **cc:** everything is a 32-bit `int`. Arrays and strings are int cells, there is no pointer arithmetic, no structs, no preprocessor. `putchar` is the only import.
- **gpt:** character-level and tiny. After about 2,000 steps (a minute) the loss falls from random guessing (4.06 nats per character) to about 1.8 and it writes Shakespeare-shaped text with mostly invented words.
- **mpm:** 2D, explicit time stepping, 12,000 particles at most.
- **sql:** in memory, read-mostly. No UPDATE or DELETE, no subqueries, no indexes.
