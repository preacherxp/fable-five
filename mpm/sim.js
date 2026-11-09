// sim.js: MLS-MPM (moving least squares material point method) in 2D. No dependencies.
// Water, jelly and snow share one grid, so they collide and mix without any special-casing.
// Follows Hu et al. 2018, "A Moving Least Squares Material Point Method".
(function (root) {
'use strict';

const N = 80, DT = 1e-4, GRAVITY = -200, MAX = 12000, WALL = 3;
const E = 1e4, NU = 0.2, MU0 = E / (2 * (1 + NU)), LA0 = E * NU / ((1 + NU) * (1 - 2 * NU));
const WATER = 0, JELLY = 1, SNOW = 2;

const A = () => new Float64Array(MAX);
const x = A(), y = A(), vx = A(), vy = A(), C00 = A(), C01 = A(), C10 = A(), C11 = A();
const F00 = A(), F01 = A(), F10 = A(), F11 = A(), Jp = A(), mat = new Uint8Array(MAX);
const G = (N + 1) * (N + 1), gvx = new Float64Array(G), gvy = new Float64Array(G), gm = new Float64Array(G);
const wx = [0, 0, 0], wy = [0, 0, 0];
let n = 0, seed = 1;
const rnd = () => (seed = seed * 1664525 + 1013904223 >>> 0) / 4294967296;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function reset() { n = 0; seed = 1; }

function addBlock(cx, cy, half, material, count) {
  for (let i = 0; i < count && n < MAX; i++, n++) {
    x[n] = cx + (rnd() * 2 - 1) * half; y[n] = cy + (rnd() * 2 - 1) * half;
    vx[n] = vy[n] = C00[n] = C01[n] = C10[n] = C11[n] = F01[n] = F10[n] = 0;
    F00[n] = F11[n] = Jp[n] = 1; mat[n] = material;
  }
}

// Quadratic B-spline weights of the 3×3 grid nodes around a particle.
function weights(p) {
  const px = x[p] * N, py = y[p] * N, bx = px - 0.5 | 0, by = py - 0.5 | 0, fx = px - bx, fy = py - by;
  wx[0] = 0.5 * (1.5 - fx) ** 2; wx[1] = 0.75 - (fx - 1) ** 2; wx[2] = 0.5 * (fx - 0.5) ** 2;
  wy[0] = 0.5 * (1.5 - fy) ** 2; wy[1] = 0.75 - (fy - 1) ** 2; wy[2] = 0.5 * (fy - 0.5) ** 2;
  return [bx, by, fx, fy];
}

// One time step. `push` = { x, y, vx, vy, r } moves grid nodes near the pointer (optional).
function step(push) {
  gvx.fill(0); gvy.fill(0); gm.fill(0);

  // Particles to grid: momentum, plus the stress of each particle's deformation.
  for (let p = 0; p < n; p++) {
    const [bx, by, fx, fy] = weights(p), m = mat[p];
    const f00 = F00[p], f01 = F01[p], f10 = F10[p], f11 = F11[p], J = f00 * f11 - f01 * f10;
    const h = m === SNOW ? Math.exp(10 * (1 - Jp[p])) : m === JELLY ? 0.3 : 1;   // snow hardens as it compacts
    const mu2 = m === WATER ? 0 : 2 * MU0 * h, lj = LA0 * h * (J - 1) * J;
    // polar decomposition F = R S, R = [c -s; s c]
    const a = f00 + f11, b = f10 - f01, len = Math.hypot(a, b) || 1, c = a / len, s = b / len;
    const d00 = f00 - c, d01 = f01 + s, d10 = f10 - s, d11 = f11 - c;
    // fixed corotated stress: 2 mu (F - R) Fᵀ + lambda (J - 1) J
    const k = -DT * 4 * N * N;
    const a00 = k * (mu2 * (d00 * f00 + d01 * f01) + lj) + C00[p], a01 = k * mu2 * (d00 * f10 + d01 * f11) + C01[p];
    const a10 = k * mu2 * (d10 * f00 + d11 * f01) + C10[p], a11 = k * (mu2 * (d10 * f10 + d11 * f11) + lj) + C11[p];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const dx = (i - fx) / N, dy = (j - fy) / N, w = wx[i] * wy[j], g = (bx + i) * (N + 1) + by + j;
      gvx[g] += w * (vx[p] + a00 * dx + a01 * dy);
      gvy[g] += w * (vy[p] + a10 * dx + a11 * dy);
      gm[g] += w;
    }
  }

  // Grid: momentum to velocity, gravity, pointer, walls.
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const g = i * (N + 1) + j;
    if (gm[g] <= 0) continue;
    gvx[g] /= gm[g]; gvy[g] = gvy[g] / gm[g] + DT * GRAVITY;
    if (push && (i / N - push.x) ** 2 + (j / N - push.y) ** 2 < push.r * push.r) { gvx[g] = push.vx; gvy[g] = push.vy; }
    if (i < WALL && gvx[g] < 0) gvx[g] = 0;
    if (i > N - WALL && gvx[g] > 0) gvx[g] = 0;
    if (j < WALL && gvy[g] < 0) gvy[g] = 0;
    if (j > N - WALL && gvy[g] > 0) gvy[g] = 0;
  }

  // Grid to particles: velocity, affine velocity field C, then advect and update the deformation gradient.
  for (let p = 0; p < n; p++) {
    const [bx, by, fx, fy] = weights(p), m = mat[p];
    let nvx = 0, nvy = 0, c00 = 0, c01 = 0, c10 = 0, c11 = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const dx = i - fx, dy = j - fy, w = wx[i] * wy[j], g = (bx + i) * (N + 1) + by + j, gx = w * gvx[g], gy = w * gvy[g];
      nvx += gx; nvy += gy;
      c00 += gx * dx; c01 += gx * dy; c10 += gy * dx; c11 += gy * dy;
    }
    c00 *= 4 * N; c01 *= 4 * N; c10 *= 4 * N; c11 *= 4 * N;
    vx[p] = nvx; vy[p] = nvy; C00[p] = c00; C01[p] = c01; C10[p] = c10; C11[p] = c11;
    x[p] = clamp(x[p] + DT * nvx, 2 / N, 1 - 2 / N); y[p] = clamp(y[p] + DT * nvy, 2 / N, 1 - 2 / N);

    const f00 = F00[p], f01 = F01[p], f10 = F10[p], f11 = F11[p];
    let n00 = (1 + DT * c00) * f00 + DT * c01 * f10, n01 = (1 + DT * c00) * f01 + DT * c01 * f11;
    let n10 = DT * c10 * f00 + (1 + DT * c11) * f10, n11 = DT * c10 * f01 + (1 + DT * c11) * f11;
    if (m === WATER) {                             // a fluid remembers only its volume change
      n00 = n11 = Math.sqrt(Math.max(n00 * n11 - n01 * n10, 0.1)); n01 = n10 = 0;
    } else if (m === SNOW) {                       // plasticity: clamp the principal stretches of S in F = R S
      const a = n00 + n11, b = n10 - n01, len = Math.hypot(a, b) || 1, c = a / len, s = b / len;
      const s00 = c * n00 + s * n10, s01 = c * n01 + s * n11, s11 = -s * n01 + c * n11;
      const th = 0.5 * Math.atan2(2 * s01, s00 - s11), ct = Math.cos(th), st = Math.sin(th);
      const e1 = ct * ct * s00 + 2 * ct * st * s01 + st * st * s11, e2 = st * st * s00 - 2 * ct * st * s01 + ct * ct * s11;
      const l1 = clamp(e1, 1 - 2.5e-2, 1 + 7.5e-3), l2 = clamp(e2, 1 - 2.5e-2, 1 + 7.5e-3);
      Jp[p] = clamp(Jp[p] * e1 * e2 / (l1 * l2), 0.6, 20);
      const t00 = ct * ct * l1 + st * st * l2, t01 = ct * st * (l1 - l2), t11 = st * st * l1 + ct * ct * l2;
      n00 = c * t00 - s * t01; n01 = c * t01 - s * t11; n10 = s * t00 + c * t01; n11 = s * t01 + c * t11;
    }
    F00[p] = n00; F01[p] = n01; F10[p] = n10; F11[p] = n11;
  }
}

const api = { N, DT, MAX, WATER, JELLY, SNOW, x, y, vx, vy, mat, Jp, reset, addBlock, step, get n() { return n; } };
if (typeof module !== 'undefined') module.exports = api; else root.MPM = api;
})(this);
