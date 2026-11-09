// node mpm/test.js
// Checks the two 3×3 decompositions against random matrices, then drops water, jelly and snow
// and checks the simulation stays physical.
const assert = require('assert');
const S = require('./sim.js');

let seed = 7;
const rnd = () => (seed = seed * 1664525 + 1013904223 >>> 0) / 2147483648 - 1;   // [-1, 1)
const det = a => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
const mul = (a, b) => Float64Array.from({ length: 9 }, (_, k) => [0, 1, 2].reduce((s, m) => s + a[3 * (k / 3 | 0) + m] * b[3 * m + k % 3], 0));
const tr = a => Float64Array.from({ length: 9 }, (_, k) => a[3 * (k % 3) + (k / 3 | 0)]);
const diff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const I = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);

// Polar decomposition F = R S: near-identity, arbitrary (half of them inverted), and flattened to rank 2.
let worst = 0, inverted = 0;
for (let t = 0; t < 3000; t++) {
  const F = Float64Array.from({ length: 9 }, (_, i) => rnd() * (t % 3 ? 2 : 0.4) + (t % 3 ? 0 : I[i]));
  if (t % 3 === 2) for (let i = 0; i < 9; i += 3) F[i + 2] = F[i] - 2 * F[i + 1];
  const R = new Float64Array(9);
  S.polar(F, R);
  const Sm = mul(tr(R), F), e = Math.max(diff(mul(tr(R), R), I), Math.abs(det(R) - 1), diff(Sm, tr(Sm)), diff(mul(R, Sm), F));
  worst = Math.max(worst, e); if (det(F) < 0) inverted++;
  assert(e < 1e-7, `polar #${t}: error ${e}`);
}
assert(inverted > 500, 'the inverted path was not exercised');

// Jacobi eigen-decomposition: V diag Vᵀ = S, V a rotation.
let worstEig = 0;
for (let t = 0; t < 1000; t++) {
  const B = Float64Array.from({ length: 9 }, rnd), Sm = mul(B, tr(B)).map((x, i) => x + (t % 2 ? I[i] : 0)), A = Sm.slice(), V = new Float64Array(9);
  S.eig(A, V);
  const D = Float64Array.of(A[0], 0, 0, 0, A[4], 0, 0, 0, A[8]);
  const e = Math.max(diff(mul(mul(V, D), tr(V)), Sm), diff(mul(tr(V), V), I), Math.abs(det(V) - 1));
  worstEig = Math.max(worstEig, e);
  assert(e < 1e-10, `eig #${t}: error ${e}`);
}

// Drop one block of each material and run 0.75 simulated seconds.
S.reset();
S.addBlock(0.3, 0.6, 0.5, 0.1, 0.1, 0.1, S.WATER, 2000);
S.addBlock(0.55, 0.45, 0.5, 0.08, 0.08, 0.08, S.JELLY, 1000);
S.addBlock(0.7, 0.7, 0.5, 0.08, 0.08, 0.08, S.SNOW, 1000);
const mean = m => { let s = 0, c = 0; for (let p = 0; p < S.n; p++) if (S.mat[p] === m) { s += S.pos[3 * p + 1]; c++; } return s / c; };
const startY = [0, 1, 2].map(mean);

const t = process.hrtime.bigint(), steps = 3000;
let maxSpeed = 0;
for (let i = 0; i < steps; i++) {
  S.step();
  if (i % 50 === 0) for (let k = 0; k < 3 * S.n; k++) maxSpeed = Math.max(maxSpeed, Math.abs(S.vel[k]));
}
const us = Number(process.hrtime.bigint() - t) / 1e3 / steps;

let compacted = 0;
for (let p = 0; p < S.n; p++) {
  for (let d = 0; d < 3; d++) {
    assert(Number.isFinite(S.pos[3 * p + d]) && Number.isFinite(S.vel[3 * p + d]), `particle ${p} is not finite`);
    assert(S.pos[3 * p + d] > 0 && S.pos[3 * p + d] < 1, `particle ${p} left the box`);
  }
  if (S.mat[p] === S.SNOW && S.Jp[p] !== 1) compacted++;
}
assert(maxSpeed < 0.5 / S.N / S.DT, `too fast for the grid: ${maxSpeed}`);        // under half a cell per step
[0, 1, 2].forEach(m => assert(mean(m) < startY[m] - 0.1, `material ${m} did not fall`));
assert(compacted > 100, 'snow never deformed plastically');

console.log(`mpm: polar ok on 3000 matrices (${inverted} inverted, worst error ${worst.toExponential(1)}), eig ok on 1000 (worst ${worstEig.toExponential(1)}), ` +
  `${S.n} particles stable for ${steps} steps on a ${S.N}³ grid, ${us.toFixed(0)} µs/step, max speed ${maxSpeed.toFixed(1)}, ${compacted} snow particles compacted`);
