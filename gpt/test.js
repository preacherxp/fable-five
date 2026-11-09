// node gpt/test.js
// 1. every hand-written gradient against finite differences, 2. the maths the parallel trainer relies on,
// 3. that training actually learns.
const assert = require('assert');
const { GPT, backward } = require('./gpt.js');

// 1. Three entries of every parameter tensor, analytic vs central differences.
const m = GPT({ vocab: 7, ctx: 6, d: 10, heads: 2, layers: 2, seed: 3 });
const xs = [1, 4, 2, 6, 0, 3], ys = [4, 2, 6, 0, 3, 5];
for (let i = 0; i < m.count; i++) m.W[i] += Math.sin(i * 12.9898) * 0.3;        // move biases and gains off their init
m.loss(xs, ys); backward();
const analytic = m.G.slice();
let checked = 0, worst = 0, at = 0;
m.params.forEach((p, k) => {
  for (const j of [0, p.w.length >> 1, p.w.length - 1]) {
    const i = at + j, w = m.W[i], h = 1e-5;
    m.W[i] = w + h; const up = m.evaluate(xs, ys);
    m.W[i] = w - h; const down = m.evaluate(xs, ys);
    m.W[i] = w;
    const numeric = (up - down) / (2 * h), err = Math.abs(numeric - analytic[i]) / Math.max(1e-8, Math.abs(numeric) + Math.abs(analytic[i]));
    worst = Math.max(worst, err); checked++;
    assert(err < 1e-6 || Math.abs(numeric - analytic[i]) < 1e-9, `param ${k}[${j}]: analytic ${analytic[i]} vs numeric ${numeric}`);
  }
  at += p.w.length;
});
assert.strictEqual(at, m.count);

// 2. Data-parallel training: three replicas with the same weights each take a shard of the batch, their summed
// gradients must equal the gradient of the whole batch, and one optimiser step must land on the same weights.
const data = Int32Array.from({ length: 300 }, (_, i) => (i * i + 3 * i) % 7), starts = [5, 40, 77, 120, 9, 200, 31, 250];
const cfg = { vocab: 7, ctx: 6, d: 10, heads: 2, layers: 2, seed: 5 };
const whole = GPT(cfg), main = GPT(cfg);
const lossWhole = whole.grad(data, starts);
let lossShards = 0, shardGap = 0;
for (const shard of [starts.slice(0, 3), starts.slice(3, 4), starts.slice(4)]) {
  const replica = GPT({ ...cfg, seed: 99 });                                   // different init, then synced like a worker
  replica.W.set(main.W);
  lossShards += replica.grad(data, shard);
  for (let i = 0; i < main.count; i++) main.G[i] += replica.G[i];
}
for (let i = 0; i < whole.count; i++) shardGap = Math.max(shardGap, Math.abs(whole.G[i] - main.G[i]));
assert(shardGap < 1e-12 && Math.abs(lossWhole - lossShards) < 1e-12, `shards differ from the whole batch by ${shardGap}`);
whole.step(1e-2, starts.length); main.step(1e-2, starts.length);
for (let i = 0; i < whole.count; i++) assert(Math.abs(whole.W[i] - main.W[i]) < 1e-12, 'step differs');
assert(main.G.every(g => g === 0), 'step must clear the gradient');

// 3. Learns a repeating sequence: loss must fall from ~ln(5) to near zero.
const seq = Int32Array.from({ length: 400 }, (_, i) => i % 5);
const t = GPT({ vocab: 5, ctx: 8, d: 16, heads: 2, layers: 1 });
const first = t.trainStep(seq, 4, 1e-2);
let last;
for (let i = 0; i < 150; i++) last = t.trainStep(seq, 4, 1e-2);
assert(first > 1.2 && last < 0.1, `loss ${first} -> ${last}`);

console.log(`gpt: ${checked} gradients over ${m.params.length} tensors match finite differences (worst relative error ${worst.toExponential(1)}), ` +
  `3 worker shards = whole batch (max gap ${shardGap.toExponential(1)}), loss ${first.toFixed(2)} -> ${last.toFixed(3)}`);
