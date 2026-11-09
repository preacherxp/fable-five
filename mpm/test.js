// node mpm/test.js
// Drops water, jelly and snow, runs 0.4 simulated seconds and checks the simulation stays physical.
const assert = require('assert');
const S = require('./sim.js');

S.reset();
S.addBlock(0.3, 0.7, 0.08, S.WATER, 1000);
S.addBlock(0.5, 0.45, 0.08, S.JELLY, 1000);
S.addBlock(0.7, 0.75, 0.08, S.SNOW, 1000);
const startY = [0, 1, 2].map(m => mean(m));

const t = process.hrtime.bigint(), steps = 4000;
for (let i = 0; i < steps; i++) S.step();
const us = Number(process.hrtime.bigint() - t) / 1e3 / steps;

function mean(m) { let s = 0, c = 0; for (let p = 0; p < S.n; p++) if (S.mat[p] === m) { s += S.y[p]; c++; } return s / c; }

let maxSpeed = 0, compacted = 0;
for (let p = 0; p < S.n; p++) {
  assert(Number.isFinite(S.x[p]) && Number.isFinite(S.y[p]) && Number.isFinite(S.vx[p]), `particle ${p} is not finite`);
  assert(S.x[p] > 0 && S.x[p] < 1 && S.y[p] > 0 && S.y[p] < 1, `particle ${p} left the box`);
  maxSpeed = Math.max(maxSpeed, Math.hypot(S.vx[p], S.vy[p]));
  if (S.mat[p] === S.SNOW && S.Jp[p] !== 1) compacted++;
}
assert(maxSpeed < 0.5 / S.N / S.DT, `too fast for the grid: ${maxSpeed}`);        // well under one cell per step
[0, 1, 2].forEach(m => assert(mean(m) < startY[m] - 0.1, `material ${m} did not fall`));
assert(compacted > 100, 'snow never deformed plastically');

console.log(`mpm: ${S.n} particles stable for ${steps} steps, ${us.toFixed(0)} µs/step, max speed ${maxSpeed.toFixed(2)}, ${compacted} snow particles compacted`);
