# fable-five

Five browser projects written by Claude Fable 5.2 in one Claude Code session. No dependencies and no build step: every project is a page you can open.

**Live: https://preacherxp.github.io/fable-five/**

| Project | What it does | Core | Check |
|---|---|---|---|
| [blackhole](https://preacherxp.github.io/fable-five/blackhole/) | A rotating (Kerr) black hole. Every pixel integrates a photon geodesic in Kerr-Schild coordinates; the disk gets Doppler beaming and gravitational redshift. Spin slider from 0 to 0.998. | `blackhole/kerr.js` 72 lines, `index.html` 159 | `node blackhole/test.js`: shadow edge matches the analytic Kerr values for 4 spins in both directions |
| [cc](https://preacherxp.github.io/fable-five/cc/) | A C compiler that writes a WebAssembly binary byte by byte: int, char, double, pointers, arrays, structs, a type checker. The demo is a ray tracer written in C. | `cc/cc.js`, 456 lines | `node cc/test.js`, 48 checks |
| [gpt](https://preacherxp.github.io/fable-five/gpt/) | A 4-layer transformer (207,422 parameters) with hand-written backprop, training on Shakespeare across all CPU cores in Web Workers. | `gpt/gpt.js` 264 lines, `worker.js` 23 | `node gpt/test.js`: 93 gradients against finite differences, worker shards equal the whole batch |
| [mpm](https://preacherxp.github.io/fable-five/mpm/) | Water, jelly and snow in one 3D MLS-MPM solver, drawn as lit spheres with WebGL. | `mpm/sim.js`, 193 lines | `node mpm/test.js`: 3×3 polar and eigen decompositions on 4,000 random matrices, 3,000 stable steps |
| [sql](https://preacherxp.github.io/fable-five/sql/) | A SQL engine: recursive CTEs, window functions, correlated subqueries, B+tree indexes, hash joins, three-valued NULL logic, UPDATE and DELETE, and the plan it ran. | `sql/sql.js`, 646 lines | `node sql/test.js`, 84 checks |

## Run it

```
python3 -m http.server 8000     # then open http://localhost:8000
for t in blackhole cc gpt mpm sql; do node $t/test.js; done
```

## Limits

- **blackhole:** the camera is a static observer 40 M away with a flat-space mapping from pixel to photon momentum, a few percent off. The disk is a thin textured plane on circular orbits from the innermost stable orbit outwards, not simulated gas. 32-bit floats and a capped step count, so rays that circle the hole many times come out black.
- **cc:** no structs by value, function pointers, `switch`, `enum`, `typedef`, `unsigned`, `float` or `goto`. Heap and stack share 1 MiB with no overflow check and `malloc` never frees.
- **gpt:** character-level and small. After about 90 seconds on 10 cores the held-out loss is about 1.56 nats per character (random guessing is 4.13) and it writes Shakespeare-shaped text with a mix of real and invented words. The held-out text comes from the same plays as the training text. Without workers it falls back to one thread and is about 7 times slower.
- **mpm:** a 32³ grid on one thread with explicit time stepping, so the water is coarse and the snow block squashes more than it shatters. 24,000 particles at most.
- **sql:** in memory. No transactions, multi-column or unique indexes, `ROWS BETWEEN` frames, RIGHT or FULL joins, or join reordering.
