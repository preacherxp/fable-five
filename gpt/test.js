// node gpt/test.js
// Checks every hand-written gradient against finite differences, then checks that training learns.
const assert = require('assert');
const { GPT, backward } = require('./gpt.js');

const m = GPT({ vocab: 7, ctx: 6, d: 8, heads: 2, layers: 2, seed: 3 });
const xs = [1, 4, 2, 6, 0, 3], ys = [4, 2, 6, 0, 3, 5];
for (const p of m.params) for (let i = 0; i < p.w.length; i++) p.w[i] += Math.sin(i * 12.9898 + p.w.length) * 0.3;  // move biases and gains off their init

m.loss(xs, ys); backward();
let checked = 0, worst = 0;
m.params.forEach((p, k) => {
  for (const i of [0, p.w.length >> 1, p.w.length - 1]) {
    const w = p.w[i], h = 1e-5, analytic = p.g[i];
    p.w[i] = w + h; const up = m.loss(xs, ys);
    p.w[i] = w - h; const down = m.loss(xs, ys);
    p.w[i] = w;
    const numeric = (up - down) / (2 * h), err = Math.abs(numeric - analytic) / Math.max(1e-8, Math.abs(numeric) + Math.abs(analytic));
    worst = Math.max(worst, err); checked++;
    assert(err < 1e-5 || Math.abs(numeric - analytic) < 1e-9, `param ${k}[${i}]: analytic ${analytic} vs numeric ${numeric}`);
  }
});

// Learns a repeating sequence: loss must fall from ~ln(5) to near zero.
const data = Int32Array.from({ length: 400 }, (_, i) => i % 5);
const t = GPT({ vocab: 5, ctx: 8, d: 16, heads: 2, layers: 1 });
const first = t.trainStep(data, 4, 1e-2);
let last;
for (let i = 0; i < 150; i++) last = t.trainStep(data, 4, 1e-2);
assert(first > 1.2 && last < 0.1, `loss ${first} -> ${last}`);

console.log(`gpt: ${checked} gradients match finite differences (worst relative error ${worst.toExponential(1)}), loss ${first.toFixed(2)} -> ${last.toFixed(3)}`);
