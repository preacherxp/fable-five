// sim.js: MLS-MPM (moving least squares material point method) in 3D. No dependencies.
// Water, jelly and snow share one grid, so they collide and mix without any special-casing.
// Follows Hu et al. 2018, "A Moving Least Squares Material Point Method".
(function (root) {
'use strict';

const N = 32, N1 = N + 1, DT = 2.5e-4, GRAVITY = -200, MAX = 24000, WALL = 3;
const E = 1e4, NU = 0.2, MU0 = E / (2 * (1 + NU)), LA0 = E * NU / ((1 + NU) * (1 - 2 * NU));
const WATER = 0, JELLY = 1, SNOW = 2, LO = 1 - 2.5e-2, HI = 1 + 7.5e-3;   // LO, HI: how far snow stretches before it yields

// Particles: position, velocity, affine velocity field C (3×3), deformation gradient F (3×3), plastic volume Jp.
const pos = new Float64Array(3 * MAX), vel = new Float64Array(3 * MAX);
const C = new Float64Array(9 * MAX), F = new Float64Array(9 * MAX), Jp = new Float64Array(MAX), mat = new Uint8Array(MAX);
const gv = new Float64Array(3 * N1 ** 3), gm = new Float64Array(N1 ** 3);
// Scratch, so a step allocates nothing. 3×3 matrices are row-major Float64Array(9).
const M9 = () => new Float64Array(9);
const Fp = M9(), R = M9(), S = M9(), V = M9(), T = M9(), A = M9(), CF = M9(), PA = M9(), PV = M9(), PU = M9();
const L = new Float64Array(3), w = M9(), fr = new Float64Array(3), base = new Int32Array(3);
let n = 0, seed = 1;
const rnd = () => (seed = seed * 1664525 + 1013904223 >>> 0) / 4294967296;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

const det = a => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
// o = a b, o = a bᵀ, o = aᵀ b. o must not be a or b.
function mul(a, b, o) { for (let i = 0; i < 9; i += 3) for (let j = 0; j < 3; j++) o[i + j] = a[i] * b[j] + a[i + 1] * b[3 + j] + a[i + 2] * b[6 + j]; }
function mulT(a, b, o) { for (let i = 0; i < 9; i += 3) for (let j = 0; j < 9; j += 3) o[i + j / 3] = a[i] * b[j] + a[i + 1] * b[j + 1] + a[i + 2] * b[j + 2]; }
function Tmul(a, b, o) { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = a[i] * b[j] + a[3 + i] * b[3 + j] + a[6 + i] * b[6 + j]; }

// Symmetric eigen-decomposition by Jacobi rotations: on return a is diagonal (the eigenvalues) and
// the columns of v are the eigenvectors, so the input was v diag(a) vᵀ. v is a rotation (det +1).
function eig(a, v) {
  v[0] = v[4] = v[8] = 1; v[1] = v[2] = v[3] = v[5] = v[6] = v[7] = 0;
  for (let sweep = 0; sweep < 12 && a[1] * a[1] + a[2] * a[2] + a[5] * a[5] > 1e-26; sweep++)
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      const apq = a[3 * p + q];
      if (apq === 0) continue;
      // the rotation in the p,q plane that zeroes a[p][q]; r is the axis it leaves alone
      const th = (a[4 * q] - a[4 * p]) / (2 * apq), t = (th < 0 ? -1 : 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c, r = 3 - p - q, x = a[3 * r + p], y = a[3 * r + q];
      a[4 * p] -= t * apq; a[4 * q] += t * apq; a[3 * p + q] = a[3 * q + p] = 0;
      a[3 * r + p] = a[3 * p + r] = c * x - s * y; a[3 * r + q] = a[3 * q + r] = s * x + c * y;
      for (let k = 0; k < 9; k += 3) { const vp = v[k + p], vq = v[k + q]; v[k + p] = c * vp - s * vq; v[k + q] = s * vp + c * vq; }
    }
}

// Polar decomposition f = r s: r is a rotation (det +1), s = rᵀ f is symmetric.
function polar(f, r) {
  if (det(f) > 0.05) {
    // Newton iteration r <- (r + r⁻ᵀ) / 2 converges quadratically to the rotation. r⁻ᵀ = cofactors / det.
    for (let i = 0; i < 9; i++) r[i] = f[i];
    for (let it = 0; it < 40; it++) {
      CF[0] = r[4] * r[8] - r[5] * r[7]; CF[1] = r[5] * r[6] - r[3] * r[8]; CF[2] = r[3] * r[7] - r[4] * r[6];
      CF[3] = r[2] * r[7] - r[1] * r[8]; CF[4] = r[0] * r[8] - r[2] * r[6]; CF[5] = r[1] * r[6] - r[0] * r[7];
      CF[6] = r[1] * r[5] - r[2] * r[4]; CF[7] = r[2] * r[3] - r[0] * r[5]; CF[8] = r[0] * r[4] - r[1] * r[3];
      const s = 0.5 / (r[0] * CF[0] + r[1] * CF[1] + r[2] * CF[2]);
      let e = 0;
      for (let i = 0; i < 9; i++) { const x = 0.5 * r[i] + s * CF[i]; e = Math.max(e, Math.abs(x - r[i])); r[i] = x; }
      if (e < 1e-6) return;                       // the error is about e² by now
    }
    return;
  }
  // Inverted or flattened f: fᵀf = V Σ² Vᵀ. Two columns of U come from f V, the third from a cross
  // product, which keeps det(U Vᵀ) = +1 and puts the inversion into s as a negative stretch.
  Tmul(f, f, PA); eig(PA, PV); mul(f, PV, PU);
  const c = PA[0] <= PA[4] ? (PA[0] <= PA[8] ? 0 : 2) : (PA[4] <= PA[8] ? 1 : 2), a = (c + 1) % 3, b = (c + 2) % 3;
  const la = Math.hypot(PU[a], PU[3 + a], PU[6 + a]);
  for (let i = 0; i < 9; i += 3) PU[i + a] /= la;
  const d = PU[a] * PU[b] + PU[3 + a] * PU[3 + b] + PU[6 + a] * PU[6 + b];
  for (let i = 0; i < 9; i += 3) PU[i + b] -= d * PU[i + a];
  const lb = Math.hypot(PU[b], PU[3 + b], PU[6 + b]);
  // ponytail: rank <= 1 has no best rotation, so use none. Never seen in the simulation.
  if (!(la > 1e-9 && lb > 1e-9)) { r.fill(0); r[0] = r[4] = r[8] = 1; return; }
  for (let i = 0; i < 9; i += 3) PU[i + b] /= lb;
  PU[c] = PU[3 + a] * PU[6 + b] - PU[6 + a] * PU[3 + b];
  PU[3 + c] = PU[6 + a] * PU[b] - PU[a] * PU[6 + b];
  PU[6 + c] = PU[a] * PU[3 + b] - PU[3 + a] * PU[b];
  mulT(PU, PV, r);
}

function reset() { n = 0; seed = 1; }

// `count` particles of `material` at random in the box centre ± half.
function addBlock(cx, cy, cz, hx, hy, hz, material, count) {
  for (let i = 0; i < count && n < MAX; i++, n++) {
    pos[3 * n] = cx + (rnd() * 2 - 1) * hx; pos[3 * n + 1] = cy + (rnd() * 2 - 1) * hy; pos[3 * n + 2] = cz + (rnd() * 2 - 1) * hz;
    vel.fill(0, 3 * n, 3 * n + 3); C.fill(0, 9 * n, 9 * n + 9); F.fill(0, 9 * n, 9 * n + 9);
    F[9 * n] = F[9 * n + 4] = F[9 * n + 8] = Jp[n] = 1; mat[n] = material;
  }
}

// Quadratic B-spline weights of the 3×3×3 grid nodes around particle p, per axis, into w, base and fr.
function weights(p) {
  for (let d = 0; d < 3; d++) {
    const q = pos[3 * p + d] * N, b = q - 0.5 | 0, f = q - b;
    base[d] = b; fr[d] = f;
    w[3 * d] = 0.5 * (1.5 - f) ** 2; w[3 * d + 1] = 0.75 - (f - 1) ** 2; w[3 * d + 2] = 0.5 * (f - 0.5) ** 2;
  }
}

function step() {
  gv.fill(0); gm.fill(0);

  // Particles to grid: momentum, plus the stress of each particle's deformation.
  const K = -DT * 4 * N * N;
  for (let p = 0; p < n; p++) {
    weights(p);
    const m = mat[p], o = 9 * p;
    for (let i = 0; i < 9; i++) Fp[i] = F[o + i];
    const J = det(Fp), h = m === SNOW ? Math.exp(10 * (1 - Jp[p])) : m === JELLY ? 0.3 : 1;   // snow hardens as it compacts
    const mu2 = m === WATER ? 0 : 2 * MU0 * h, lj = K * LA0 * h * (J - 1) * J;
    // fixed corotated stress 2 mu (F - R) Fᵀ + lambda (J - 1) J, added to the affine momentum C
    if (mu2) {
      polar(Fp, R);
      for (let i = 0; i < 9; i++) T[i] = Fp[i] - R[i];
      mulT(T, Fp, A);
      for (let i = 0; i < 9; i++) A[i] = K * mu2 * A[i] + C[o + i];
    } else for (let i = 0; i < 9; i++) A[i] = C[o + i];
    const a0 = A[0] + lj, a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4] + lj, a5 = A[5], a6 = A[6], a7 = A[7], a8 = A[8] + lj;
    const vx = vel[3 * p], vy = vel[3 * p + 1], vz = vel[3 * p + 2], fx = fr[0], fy = fr[1], fz = fr[2], bz = base[2];
    for (let i = 0; i < 3; i++) {
      const dx = (i - fx) / N, wi = w[i], gi = (base[0] + i) * N1 + base[1];
      for (let j = 0; j < 3; j++) {
        const dy = (j - fy) / N, wij = wi * w[3 + j], gj = (gi + j) * N1 + bz;
        for (let l = 0; l < 3; l++) {
          const dz = (l - fz) / N, ww = wij * w[6 + l], g = gj + l, g3 = 3 * g;
          gv[g3] += ww * (vx + a0 * dx + a1 * dy + a2 * dz);
          gv[g3 + 1] += ww * (vy + a3 * dx + a4 * dy + a5 * dz);
          gv[g3 + 2] += ww * (vz + a6 * dx + a7 * dy + a8 * dz);
          gm[g] += ww;
        }
      }
    }
  }

  // Grid: momentum to velocity, gravity, slip walls on all six sides.
  for (let i = 0, g = 0; i <= N; i++) for (let j = 0; j <= N; j++) for (let l = 0; l <= N; l++, g++) {
    const m = gm[g];
    if (m <= 0) continue;
    let x = gv[3 * g] / m, y = gv[3 * g + 1] / m + DT * GRAVITY, z = gv[3 * g + 2] / m;
    if ((i < WALL && x < 0) || (i > N - WALL && x > 0)) x = 0;
    if ((j < WALL && y < 0) || (j > N - WALL && y > 0)) y = 0;
    if ((l < WALL && z < 0) || (l > N - WALL && z > 0)) z = 0;
    gv[3 * g] = x; gv[3 * g + 1] = y; gv[3 * g + 2] = z;
  }

  // Grid to particles: velocity, affine velocity field C, then advect and update the deformation gradient.
  for (let p = 0; p < n; p++) {
    weights(p);
    const m = mat[p], o = 9 * p, fx = fr[0], fy = fr[1], fz = fr[2], bz = base[2];
    let vx = 0, vy = 0, vz = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0, c8 = 0;
    for (let i = 0; i < 3; i++) {
      const dx = i - fx, wi = w[i], gi = (base[0] + i) * N1 + base[1];
      for (let j = 0; j < 3; j++) {
        const dy = j - fy, wij = wi * w[3 + j], gj = (gi + j) * N1 + bz;
        for (let l = 0; l < 3; l++) {
          const dz = l - fz, ww = wij * w[6 + l], g3 = 3 * (gj + l), gx = ww * gv[g3], gy = ww * gv[g3 + 1], gz = ww * gv[g3 + 2];
          vx += gx; vy += gy; vz += gz;
          c0 += gx * dx; c1 += gx * dy; c2 += gx * dz; c3 += gy * dx; c4 += gy * dy; c5 += gy * dz; c6 += gz * dx; c7 += gz * dy; c8 += gz * dz;
        }
      }
    }
    const s = 4 * N, lo = 2 / N, hi = 1 - lo;
    vel[3 * p] = vx; vel[3 * p + 1] = vy; vel[3 * p + 2] = vz;
    C[o] = s * c0; C[o + 1] = s * c1; C[o + 2] = s * c2; C[o + 3] = s * c3; C[o + 4] = s * c4; C[o + 5] = s * c5; C[o + 6] = s * c6; C[o + 7] = s * c7; C[o + 8] = s * c8;
    pos[3 * p] = clamp(pos[3 * p] + DT * vx, lo, hi); pos[3 * p + 1] = clamp(pos[3 * p + 1] + DT * vy, lo, hi); pos[3 * p + 2] = clamp(pos[3 * p + 2] + DT * vz, lo, hi);

    // F <- (I + DT C) F
    for (let i = 0; i < 9; i++) { T[i] = DT * C[o + i]; Fp[i] = F[o + i]; }
    T[0] += 1; T[4] += 1; T[8] += 1;
    mul(T, Fp, A);
    if (m === WATER) {                             // a fluid remembers only its volume change
      const q = Math.cbrt(Math.max(det(A), 0.1));
      A[0] = A[4] = A[8] = q; A[1] = A[2] = A[3] = A[5] = A[6] = A[7] = 0;
    } else if (m === SNOW) {                       // plasticity: clamp the principal stretches of S in F = R S
      // FᵀF = S². If its Gershgorin discs sit inside the squared limits no stretch needs clamping (3 in 4 steps).
      Tmul(A, A, S);
      const o0 = Math.abs(S[1]) + Math.abs(S[2]), o1 = Math.abs(S[1]) + Math.abs(S[5]), o2 = Math.abs(S[2]) + Math.abs(S[5]);
      if (Math.min(S[0] - o0, S[4] - o1, S[8] - o2) < LO * LO || Math.max(S[0] + o0, S[4] + o1, S[8] + o2) > HI * HI) {
        polar(A, R); Tmul(R, A, S); eig(S, V);
        let ratio = 1;
        for (let k = 0; k < 3; k++) { const e = S[4 * k]; L[k] = clamp(e, LO, HI); ratio *= e / L[k]; }
        Jp[p] = clamp(Jp[p] * ratio, 0.6, 20);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[3 * i + j] = V[3 * i] * L[0] * V[3 * j] + V[3 * i + 1] * L[1] * V[3 * j + 1] + V[3 * i + 2] * L[2] * V[3 * j + 2];
        mul(R, T, A);
      }
    }
    for (let i = 0; i < 9; i++) F[o + i] = A[i];
  }
}

const api = { N, DT, MAX, WALL, WATER, JELLY, SNOW, pos, vel, mat, Jp, reset, addBlock, step, polar, eig, get n() { return n; } };
if (typeof module !== 'undefined') module.exports = api; else root.MPM = api;
})(this);
