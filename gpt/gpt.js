// gpt.js: a GPT (decoder-only transformer) with hand-written reverse-mode autodiff. No dependencies.
// Every op computes its output and pushes a closure on the tape that knows how to push gradients back.
// All weights live in one flat array (W) and all gradients in another (G), so a replica in a Web Worker
// can ship its gradient to the main thread as a single transferable buffer.
(function (root) {
'use strict';

let tape = [], lastAttn = null;
class Mat {
  constructor(r, c) { this.r = r; this.c = c; this.w = new Float64Array(r * c); this.g = new Float64Array(r * c); }
}

// x: n×m, W: m×k, b: 1×k (optional). This is where nearly all the time goes, so the loops are unrolled by
// four along the axis that lets one read and one write of the destination serve four multiplies.
function linear(x, W, b) {
  const n = x.r, m = x.c, k = W.c, o = new Mat(n, k), xw = x.w, Ww = W.w, ow = o.w, m4 = m & ~3, n4 = n & ~3;
  for (let i = 0; i < n; i++) {
    const oi = i * k, xi = i * m;
    if (b) for (let l = 0; l < k; l++) ow[oi + l] = b.w[l];
    let j = 0;
    for (; j < m4; j += 4) {
      const x0 = xw[xi + j], x1 = xw[xi + j + 1], x2 = xw[xi + j + 2], x3 = xw[xi + j + 3], w0 = j * k, w1 = w0 + k, w2 = w1 + k, w3 = w2 + k;
      for (let l = 0; l < k; l++) ow[oi + l] += x0 * Ww[w0 + l] + x1 * Ww[w1 + l] + x2 * Ww[w2 + l] + x3 * Ww[w3 + l];
    }
    for (; j < m; j++) { const v = xw[xi + j], wj = j * k; for (let l = 0; l < k; l++) ow[oi + l] += v * Ww[wj + l]; }
  }
  tape.push(() => {
    const og = o.g, xg = x.g, Wg = W.g;
    for (let i = 0; i < n; i++) {                  // into the input: xg[i][j] += og[i] · W[j]
      const oi = i * k, xi = i * m;
      if (b) for (let l = 0; l < k; l++) b.g[l] += og[oi + l];
      let j = 0;
      for (; j < m4; j += 4) {
        const w0 = j * k, w1 = w0 + k, w2 = w1 + k, w3 = w2 + k; let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let l = 0; l < k; l++) { const g = og[oi + l]; s0 += g * Ww[w0 + l]; s1 += g * Ww[w1 + l]; s2 += g * Ww[w2 + l]; s3 += g * Ww[w3 + l]; }
        xg[xi + j] += s0; xg[xi + j + 1] += s1; xg[xi + j + 2] += s2; xg[xi + j + 3] += s3;
      }
      for (; j < m; j++) { const wj = j * k; let s = 0; for (let l = 0; l < k; l++) s += og[oi + l] * Ww[wj + l]; xg[xi + j] += s; }
    }
    let i = 0;                                     // into the weights: Wg[j] += x[i][j] * og[i]
    for (; i < n4; i += 4) {
      const o0 = i * k, o1 = o0 + k, o2 = o1 + k, o3 = o2 + k;
      for (let j = 0; j < m; j++) {
        const x0 = xw[i * m + j], x1 = xw[(i + 1) * m + j], x2 = xw[(i + 2) * m + j], x3 = xw[(i + 3) * m + j], wj = j * k;
        for (let l = 0; l < k; l++) Wg[wj + l] += x0 * og[o0 + l] + x1 * og[o1 + l] + x2 * og[o2 + l] + x3 * og[o3 + l];
      }
    }
    for (; i < n; i++) for (let j = 0; j < m; j++) { const v = xw[i * m + j], wj = j * k, oi = i * k; for (let l = 0; l < k; l++) Wg[wj + l] += v * og[oi + l]; }
  });
  return o;
}

// logits = x Eᵀ + b, where E is the token embedding itself (weight tying): one matrix reads and writes characters.
function unembed(x, E, b) {
  const n = x.r, d = x.c, V = E.r, o = new Mat(n, V), xw = x.w, Ew = E.w;
  for (let i = 0; i < n; i++) for (let v = 0; v < V; v++) {
    let s = b.w[v];
    for (let j = 0; j < d; j++) s += xw[i * d + j] * Ew[v * d + j];
    o.w[i * V + v] = s;
  }
  tape.push(() => {
    for (let i = 0; i < n; i++) for (let v = 0; v < V; v++) {
      const g = o.g[i * V + v];
      b.g[v] += g;
      for (let j = 0; j < d; j++) { x.g[i * d + j] += g * Ew[v * d + j]; E.g[v * d + j] += g * xw[i * d + j]; }
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

function gelu(x) {                                 // 0.5 x (1 + tanh(√(2/π) (x + 0.044715 x³)))
  const o = new Mat(x.r, x.c), n = o.w.length, dy = new Float64Array(n), K = Math.sqrt(2 / Math.PI);
  for (let i = 0; i < n; i++) {
    const v = x.w[i], t = Math.tanh(K * (v + 0.044715 * v * v * v));
    o.w[i] = 0.5 * v * (1 + t);
    dy[i] = 0.5 * (1 + t) + 0.5 * v * (1 - t * t) * K * (1 + 3 * 0.044715 * v * v);
  }
  tape.push(() => { for (let i = 0; i < n; i++) x.g[i] += o.g[i] * dy[i]; });
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
  lastAttn = { P, T, H };
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

function GPT({ vocab, ctx = 64, d = 96, heads = 4, layers = 3, seed = 1 }) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const params = [];
  const P = (r, c, std) => { const m = new Mat(r, c); if (std) for (let i = 0; i < m.w.length; i++) m.w[i] = gauss() * std; params.push(m); return m; };
  const ones = c => { const m = P(1, c, 0); m.w.fill(1); return m; };
  const res = 1 / Math.sqrt(2 * layers);           // layers that write into the residual stream start small

  const tok = P(vocab, d, 0.05), pos = P(ctx, d, 0.05);
  const blocks = Array.from({ length: layers }, () => ({
    g1: ones(d), b1: P(1, d, 0), wq: P(d, d, d ** -0.5), wk: P(d, d, d ** -0.5), wv: P(d, d, d ** -0.5), wo: P(d, d, res * d ** -0.5), bo: P(1, d, 0),
    g2: ones(d), b2: P(1, d, 0), w1: P(d, 4 * d, d ** -0.5), c1: P(1, 4 * d, 0), w2: P(4 * d, d, res * (4 * d) ** -0.5), c2: P(1, d, 0),
  }));
  const gf = ones(d), bf = P(1, d, 0), hb = P(1, vocab, 0);

  // Repack every tensor as a view into one flat weight array and one flat gradient array.
  const count = params.reduce((s, p) => s + p.w.length, 0), W = new Float64Array(count), G = new Float64Array(count);
  let off = 0;
  for (const p of params) { const n = p.w.length; W.set(p.w, off); p.w = W.subarray(off, off + n); p.g = G.subarray(off, off + n); off += n; }
  const m1 = new Float64Array(count), m2 = new Float64Array(count);
  let steps = 0;

  function forward(tokens) {
    let x = embed(tokens, tok, pos);
    for (const b of blocks) {
      const h = layernorm(x, b.g1, b.b1);
      x = add(x, linear(attention(linear(h, b.wq), linear(h, b.wk), linear(h, b.wv), heads), b.wo, b.bo));
      x = add(x, linear(gelu(linear(layernorm(x, b.g2, b.b2), b.w1, b.c1)), b.w2, b.c2));
    }
    return unembed(layernorm(x, gf, bf), tok, hb);
  }

  const loss = (xs, ys, scale) => crossEntropy(forward(xs), ys, scale);                 // leaves the tape for backward()
  const evaluate = (xs, ys) => { const l = loss(xs, ys); tape = []; return l; };       // forward only

  // Adds the gradient of each window's loss to G (a sum, not a mean) and returns the summed loss.
  function grad(data, starts) {
    let total = 0;
    for (const s of starts) { total += loss(data.subarray(s, s + ctx), data.subarray(s + 1, s + ctx + 1)); backward(); }
    return total;
  }

  // One Adam step on G / n (n = how many windows were summed into G), with global-norm clipping. Clears G.
  function step(lr, n = 1, clip = 1) {
    let norm = 0;
    for (let i = 0; i < count; i++) norm += G[i] * G[i];
    norm = Math.sqrt(norm) / n;
    const s = (norm > clip ? clip / norm : 1) / n, c1 = 1 - 0.9 ** ++steps, c2 = 1 - 0.99 ** steps;
    for (let i = 0; i < count; i++) {
      const g = G[i] * s;
      m1[i] = 0.9 * m1[i] + 0.1 * g; m2[i] = 0.99 * m2[i] + 0.01 * g * g;
      W[i] -= lr * (m1[i] / c1) / (Math.sqrt(m2[i] / c2) + 1e-8);
      G[i] = 0;
    }
  }

  // Single-threaded training: one step on `batch` random windows of `data` (an array of token ids).
  function trainStep(data, batch = 8, lr = 3e-3) {
    const total = grad(data, Array.from({ length: batch }, () => rnd() * (data.length - ctx - 1) | 0));
    step(lr, batch);
    return total / batch;
  }

  // ponytail: re-runs the whole window for every new character. Add a key/value cache if sampling gets slow.
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

  return { params, W, G, count, ctx, loss, evaluate, grad, step, trainStep, sample };
}

// lastAttention(): the attention weights of the last layer in the most recent forward pass, { P, T, H }.
const api = { GPT, backward, lastAttention: () => lastAttn };
if (typeof module !== 'undefined') module.exports = api; else root.TinyGPT = api;
})(this);
