// node blackhole/test.js
// Checks the geodesic equations the shader runs against things known in closed form.
const assert = require('assert');
const K = require('./kerr.js');

const V = (x, y, z) => ({ x, y, z });
const axpy = (u, h, k) => V(u.x + h * k.x, u.y + h * k.y, u.z + h * k.z);
const dot = (u, v) => u.x * v.x + u.y * v.y + u.z * v.z;
const rOf = (x, a) => { const s = dot(x, x) - a * a; return Math.sqrt(0.5 * (s + Math.sqrt(s * s + 4 * a * a * x.z * x.z))); };
const angmom = (x, p) => x.x * p.y - x.y * p.x;

// The Hamiltonian, written out independently of kerr.js.
function H(x, p, a) {
  const r = rOf(x, a), D = r * r + a * a, f = 2 * r ** 3 / (r ** 4 + a * a * x.z * x.z);
  const w = ((r * x.x + a * x.y) * p.x + (r * x.y - a * x.x) * p.y) / D + x.z * p.z / r + 1;
  return 0.5 * (-1 + dot(p, p) - f * w * w);
}

function rk4(x, p, a, h) {
  const d = () => [V(0, 0, 0), V(0, 0, 0)], [x1, p1] = d(), [x2, p2] = d(), [x3, p3] = d(), [x4, p4] = d();
  K.rhs(x, p, a, x1, p1);
  K.rhs(axpy(x, h / 2, x1), axpy(p, h / 2, p1), a, x2, p2);
  K.rhs(axpy(x, h / 2, x2), axpy(p, h / 2, p2), a, x3, p3);
  K.rhs(axpy(x, h, x3), axpy(p, h, p3), a, x4, p4);
  const mix = (u, k1, k2, k3, k4) => V(u.x + h / 6 * (k1.x + 2 * k2.x + 2 * k3.x + k4.x), u.y + h / 6 * (k1.y + 2 * k2.y + 2 * k3.y + k4.y), u.z + h / 6 * (k1.z + 2 * k2.z + 2 * k3.z + k4.z));
  return [mix(x, x1, x2, x3, x4), mix(p, p1, p2, p3, p4), x1];
}

// Follows a photon until it falls through the horizon or leaves. `each` sees every step.
function trace(x, p, a, { step = 0.01, far = 300, each } = {}) {
  const rh = K.horizon(Math.abs(a));
  for (let i = 0; i < 2e6; i++) {
    const r = rOf(x, a);
    if (r < rh) return { fate: 'captured', x, p };
    const [nx, np, v] = rk4(x, p, a, step * r * Math.min(1, Math.max(0.01, r - rh)));   // small steps where space is steep
    if (r > far && dot(x, v) > 0) return { fate: 'escaped', x, p, v };
    if (each) each(x, p);
    x = nx; p = np;
  }
  throw new Error('ray never finished');
}
const launch = (x, n, a) => { const k = K.nullk(x, n, a); return V(k * n.x, k * n.y, k * n.z); };

// 1. dp = -dH/dx and dx = dH/dp, against central differences.
let worstGrad = 0;
for (let i = 0; i < 40; i++) {
  const s = j => Math.sin(i * 7.31 + j * 2.17), a = [0, 0.5, 0.9, -0.998][i % 4];
  const x = V(3 + 4 * s(1), 2.5 * s(2), 3 * s(3)), p = V(s(4), s(5), s(6)), dx = V(0, 0, 0), dp = V(0, 0, 0), e = 1e-5;
  K.rhs(x, p, a, dx, dp);
  for (const c of ['x', 'y', 'z']) {
    const fd = (o, sign) => { const xx = { ...x }, pp = { ...p }; (o === 'x' ? xx : pp)[c] += sign * e; return H(xx, pp, a); };
    for (const [got, want] of [[dp[c], -(fd('x', 1) - fd('x', -1)) / (2 * e)], [dx[c], (fd('p', 1) - fd('p', -1)) / (2 * e)]]) {
      const err = Math.abs(got - want) / (1 + Math.abs(want));
      worstGrad = Math.max(worstGrad, err);
      assert(err < 1e-7, `gradient ${c}: ${got} vs ${want} at a=${a}`);
    }
  }
}

// 2. A ray that skims the hole off the equator stays on the light cone and keeps its angular momentum.
let drift = 0;
{
  const a = 0.9, x0 = V(-30, 5.5, 4), p0 = launch(x0, V(1, 0, 0), a), l0 = angmom(x0, p0);
  assert(Math.abs(H(x0, p0, a)) < 1e-12, 'launch is not null');
  const end = trace(x0, p0, a, { far: 40, each: (x, p) => { drift = Math.max(drift, Math.abs(H(x, p, a)), Math.abs(angmom(x, p) - l0)); } });
  assert.strictEqual(end.fate, 'escaped');
  assert(drift < 1e-7, `H or Lz drifted by ${drift}`);
}

// 3. The edge of the shadow. In the equatorial plane a photon is captured below a critical angular momentum b = Lz/E
//    and escapes above it. Kerr gives it in closed form: b = 3 sqrt(r_ph) -/+ a, r_ph = 2 (1 + cos(2/3 acos(-/+a))).
let worstB = 0;
for (const a of [0, 0.5, 0.9, 0.998]) {
  for (const side of [1, -1]) {                    // side = sign of Lz
    const fate = y => { const x = V(-200, y, 0), p = launch(x, V(1, 0, 0), a); return [trace(x, p, a).fate, Math.abs(angmom(x, p))]; };
    let lo = 0.5, hi = 12, b;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2, [f, l] = fate(-side * mid); b = l; if (f === 'captured') lo = mid; else hi = mid; }
    const pro = side > 0, rph = 2 * (1 + Math.cos(2 / 3 * Math.acos(pro ? -a : a))), want = 3 * Math.sqrt(rph) + (pro ? -a : a);
    worstB = Math.max(worstB, Math.abs(b - want));
    assert(Math.abs(b - want) < 1e-3, `a=${a} ${pro ? 'prograde' : 'retrograde'}: critical b ${b}, Kerr says ${want}`);
  }
}

// 4. Far from a non-rotating hole, light bends by 4/b + 15 pi / (4 b^2).
const b = 100, x0 = V(-20000, b, 0), p0 = launch(x0, V(1, 0, 0), 0), v0 = V(0, 0, 0);
K.rhs(x0, p0, 0, v0, V(0, 0, 0));
const out = trace(x0, p0, 0, { far: 20000 }), bend = Math.atan2(out.v.y, out.v.x) - Math.atan2(v0.y, v0.x), want = 4 / b + 15 * Math.PI / (4 * b * b);
assert(Math.abs(-bend / want - 1) < 5e-3, `deflection ${-bend}, expected ${want}`);

assert(Math.abs(K.isco(0) - 6) < 1e-12 && Math.abs(K.isco(1) - 1) < 1e-6 && Math.abs(K.horizon(0) - 2) < 1e-12);

console.log(`blackhole: gradients match finite differences (${worstGrad.toExponential(1)}), H and Lz conserved (${drift.toExponential(1)}), shadow edge matches Kerr for 4 spins x 2 directions (worst ${worstB.toExponential(1)} M), weak-field bending ${(-bend / want * 100).toFixed(2)}% of theory`);
