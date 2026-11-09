// gpt.js: a GPT (decoder-only transformer) with hand-written reverse-mode autodiff. No dependencies.
// Every op computes its output and pushes a closure on the tape that knows how to push gradients back.
(function (root) {
'use strict';

let tape = [];
class Mat {
  constructor(r, c) { this.r = r; this.c = c; this.w = new Float64Array(r * c); this.g = new Float64Array(r * c); }
}

function linear(x, W, b) {                         // x: n×m, W: m×k, b: 1×k (optional)
  const n = x.r, m = x.c, k = W.c, o = new Mat(n, k), xw = x.w, Ww = W.w, ow = o.w;
  for (let i = 0; i < n; i++) {
    const oi = i * k;
    if (b) for (let l = 0; l < k; l++) ow[oi + l] = b.w[l];
    for (let j = 0; j < m; j++) { const v = xw[i * m + j], wj = j * k; for (let l = 0; l < k; l++) ow[oi + l] += v * Ww[wj + l]; }
  }
  tape.push(() => {
    const og = o.g, xg = x.g, Wg = W.g;
    for (let i = 0; i < n; i++) {
      const oi = i * k;
      if (b) for (let l = 0; l < k; l++) b.g[l] += og[oi + l];
      for (let j = 0; j < m; j++) {
        const v = xw[i * m + j], wj = j * k; let s = 0;
        for (let l = 0; l < k; l++) { const g = og[oi + l]; s += g * Ww[wj + l]; Wg[wj + l] += v * g; }
        xg[i * m + j] += s;
      }
    }
  });
  return o;
}

function add(a, b) {
  const o = new Mat(a.r, a.c), n = o.w.length;
  for (let i = 0; i < n; i++) o.w[i] = a.w[i] + b.w[i];
  tape.push(() => { for (let i = 0; i < n; i++) { a.g[i] += o.g[i]; b.g[i] += o.g[i]; } });
  return o;
}

function relu(x) {
  const o = new Mat(x.r, x.c), n = o.w.length;
  for (let i = 0; i < n; i++) o.w[i] = x.w[i] > 0 ? x.w[i] : 0;
  tape.push(() => { for (let i = 0; i < n; i++) if (x.w[i] > 0) x.g[i] += o.g[i]; });
  return o;
}

function layernorm(x, gain, bias) {
  const n = x.r, d = x.c, o = new Mat(n, d), xh = new Float64Array(n * d), inv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let mu = 0, v = 0;
    for (let j = 0; j < d; j++) mu += x.w[i * d + j];
    mu /= d;
    for (let j = 0; j < d; j++) { const t = x.w[i * d + j] - mu; v += t * t; }
    const s = inv[i] = 1 / Math.sqrt(v / d + 1e-5);
    for (let j = 0; j < d; j++) { const h = xh[i * d + j] = (x.w[i * d + j] - mu) * s; o.w[i * d + j] = h * gain.w[j] + bias.w[j]; }
  }
  tape.push(() => {
    for (let i = 0; i < n; i++) {
      let m1 = 0, m2 = 0;
      for (let j = 0; j < d; j++) {
        const g = o.g[i * d + j], dh = g * gain.w[j];
        bias.g[j] += g; gain.g[j] += g * xh[i * d + j];
        m1 += dh; m2 += dh * xh[i * d + j];
      }
      m1 /= d; m2 /= d;
      for (let j = 0; j < d; j++) x.g[i * d + j] += inv[i] * (o.g[i * d + j] * gain.w[j] - m1 - xh[i * d + j] * m2);
    }
  });
  return o;
}

// Causal multi-head self-attention. q, k, v: T×d, heads split along the columns.
function attention(q, k, v, H) {
  const T = q.r, d = q.c, dh = d / H, sc = 1 / Math.sqrt(dh), o = new Mat(T, d), P = new Float64Array(H * T * T);
  for (let h = 0; h < H; h++) {
    const off = h * dh;
    for (let i = 0; i < T; i++) {
      const pi = (h * T + i) * T; let mx = -Infinity, z = 0;
      for (let j = 0; j <= i; j++) {                // position i only sees positions <= i
        let s = 0;
        for (let l = 0; l < dh; l++) s += q.w[i * d + off + l] * k.w[j * d + off + l];
        P[pi + j] = s *= sc; if (s > mx) mx = s;
      }
      for (let j = 0; j <= i; j++) z += P[pi + j] = Math.exp(P[pi + j] - mx);
      for (let j = 0; j <= i; j++) { const pr = P[pi + j] /= z; for (let l = 0; l < dh; l++) o.w[i * d + off + l] += pr * v.w[j * d + off + l]; }
    }
  }
  tape.push(() => {
    const dp = new Float64Array(T);
    for (let h = 0; h < H; h++) {
      const off = h * dh;
      for (let i = 0; i < T; i++) {
        const pi = (h * T + i) * T; let dot = 0;
        for (let j = 0; j <= i; j++) {
          let s = 0;
          for (let l = 0; l < dh; l++) { const g = o.g[i * d + off + l]; s += g * v.w[j * d + off + l]; v.g[j * d + off + l] += P[pi + j] * g; }
          dp[j] = s; dot += P[pi + j] * s;
        }
        for (let j = 0; j <= i; j++) {              // softmax backward, then into q and k
          const ds = P[pi + j] * (dp[j] - dot) * sc;
          for (let l = 0; l < dh; l++) { q.g[i * d + off + l] += ds * k.w[j * d + off + l]; k.g[j * d + off + l] += ds * q.w[i * d + off + l]; }
        }
      }
    }
  });
  return o;
}

function embed(tokens, tok, pos) {
  const T = tokens.length, d = tok.c, o = new Mat(T, d);
  for (let i = 0; i < T; i++) for (let j = 0; j < d; j++) o.w[i * d + j] = tok.w[tokens[i] * d + j] + pos.w[i * d + j];
  tape.push(() => { for (let i = 0; i < T; i++) for (let j = 0; j < d; j++) { const g = o.g[i * d + j]; tok.g[tokens[i] * d + j] += g; pos.g[i * d + j] += g; } });
  return o;
}

// Mean cross-entropy over the rows of `logits`. Seeds the backward pass with d(loss*scale)/d(logits).
function crossEntropy(logits, targets, scale = 1) {
  const T = logits.r, V = logits.c; let loss = 0;
  const probs = new Float64Array(T * V);
  for (let i = 0; i < T; i++) {
    let mx = -Infinity, z = 0;
    for (let j = 0; j < V; j++) if (logits.w[i * V + j] > mx) mx = logits.w[i * V + j];
    for (let j = 0; j < V; j++) z += probs[i * V + j] = Math.exp(logits.w[i * V + j] - mx);
    for (let j = 0; j < V; j++) probs[i * V + j] /= z;
    loss -= Math.log(probs[i * V + targets[i]]);
  }
  tape.push(() => { for (let i = 0; i < T; i++) for (let j = 0; j < V; j++) logits.g[i * V + j] += (probs[i * V + j] - (j === targets[i] ? 1 : 0)) * scale / T; });
  return loss / T;
}

function backward() { for (let i = tape.length - 1; i >= 0; i--) tape[i](); tape = []; }

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function GPT({ vocab, ctx = 32, d = 48, heads = 4, layers = 2, seed = 1 }) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const params = [];
  const P = (r, c, std) => { const m = new Mat(r, c); if (std) for (let i = 0; i < m.w.length; i++) m.w[i] = gauss() * std; params.push(m); return m; };
  const ones = c => { const m = P(1, c, 0); m.w.fill(1); return m; };
  const W = (r, c) => P(r, c, 1 / Math.sqrt(r));

  const tok = P(vocab, d, 0.1), pos = P(ctx, d, 0.1);
  const blocks = Array.from({ length: layers }, () => ({
    g1: ones(d), b1: P(1, d, 0), wq: W(d, d), wk: W(d, d), wv: W(d, d), wo: W(d, d), bo: P(1, d, 0),
    g2: ones(d), b2: P(1, d, 0), w1: W(d, 4 * d), c1: P(1, 4 * d, 0), w2: W(4 * d, d), c2: P(1, d, 0),
  }));
  const gf = ones(d), bf = P(1, d, 0), head = W(d, vocab), hb = P(1, vocab, 0);
  const m1 = params.map(p => new Float64Array(p.w.length)), m2 = params.map(p => new Float64Array(p.w.length));
  let steps = 0;

  function forward(tokens) {
    let x = embed(tokens, tok, pos);
    for (const b of blocks) {
      const h = layernorm(x, b.g1, b.b1);
      x = add(x, linear(attention(linear(h, b.wq), linear(h, b.wk), linear(h, b.wv), heads), b.wo, b.bo));
      x = add(x, linear(relu(linear(layernorm(x, b.g2, b.b2), b.w1, b.c1)), b.w2, b.c2));
    }
    return linear(layernorm(x, gf, bf), head, hb);
  }

  const loss = (xs, ys, scale) => crossEntropy(forward(xs), ys, scale);

  // One Adam step on `batch` random windows of `data` (an array of token ids).
  function trainStep(data, batch = 8, lr = 3e-3) {
    let total = 0;
    for (let b = 0; b < batch; b++) {
      const s = rnd() * (data.length - ctx - 1) | 0;
      total += loss(data.subarray(s, s + ctx), data.subarray(s + 1, s + ctx + 1), 1 / batch);
      backward();
    }
    steps++;
    const c1 = 1 - 0.9 ** steps, c2 = 1 - 0.99 ** steps;
    params.forEach((p, k) => {
      const a = m1[k], v = m2[k];
      for (let i = 0; i < p.w.length; i++) {
        const g = p.g[i];
        a[i] = 0.9 * a[i] + 0.1 * g; v[i] = 0.99 * v[i] + 0.01 * g * g;
        p.w[i] -= lr * (a[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
        p.g[i] = 0;
      }
    });
    return total / batch;
  }

  function sample(prompt, n, temp = 0.8) {
    const ids = [...prompt];
    for (let t = 0; t < n; t++) {
      const win = ids.slice(-ctx), logits = forward(win);
      tape = [];
      const row = (win.length - 1) * vocab; let mx = -Infinity, z = 0;
      const pr = new Float64Array(vocab);
      for (let j = 0; j < vocab; j++) if (logits.w[row + j] > mx) mx = logits.w[row + j];
      for (let j = 0; j < vocab; j++) z += pr[j] = Math.exp((logits.w[row + j] - mx) / temp);
      let r = Math.random() * z, j = 0;
      while (j < vocab - 1 && (r -= pr[j]) > 0) j++;
      ids.push(j);
    }
    return ids.slice(prompt.length);
  }

  return { params, loss, trainStep, sample, count: params.reduce((s, p) => s + p.w.length, 0) };
}

const api = { GPT, backward };
if (typeof module !== 'undefined') module.exports = api; else root.TinyGPT = api;
})(this);
