// kerr.js: light rays around a rotating (Kerr) black hole. No dependencies.
//
// Units G = c = M = 1. Ingoing Kerr-Schild coordinates, spin axis z:  g = eta + f l l,  l = (1, L).
// A photon with energy E = 1 and spatial momentum p obeys Hamilton's equations for
//   H = (-1 + p.p - f w^2) / 2,   w = L.p + 1        (H = 0 on a light ray)
//   dx/dlambda = p - f w L,   dp/dlambda = grad(f w^2) / 2
// These coordinates have no singularity at the horizon or on the axis, so a ray can be followed all the way in.
//
// The formulas below are written once, as scalar statements that are valid GLSL and (after `float` -> `let`,
// `sqrt` -> `Math.sqrt`) valid JavaScript. The fragment shader and the tests run this same text.
// Sign convention, pinned by test.js: with a > 0 the hole spins counterclockwise seen from +z.
(function (root) {
'use strict';

// in: x (position), a (spin).  out: r, f, L
const GEOM = `
  float a2 = a*a;
  float rho2 = x.x*x.x + x.y*x.y + x.z*x.z - a2;
  float Q = sqrt(rho2*rho2 + 4.0*a2*x.z*x.z);
  float r2 = 0.5*(rho2 + Q);
  float r = sqrt(r2);
  float D = r2 + a2;
  float S4 = r2*r2 + a2*x.z*x.z;
  float f = 2.0*r2*r/S4;
  float A = r*x.x + a*x.y;
  float B = r*x.y - a*x.x;
  float Lx = A/D;
  float Ly = B/D;
  float Lz = x.z/r;`;

// in: x, p, a.  out: dx, dp
const RHS = GEOM + `
  float w = Lx*p.x + Ly*p.y + Lz*p.z + 1.0;
  dx.x = p.x - f*w*Lx;
  dx.y = p.y - f*w*Ly;
  dx.z = p.z - f*w*Lz;
  float rq = 1.0/(r*Q);
  float rx = x.x*r2*rq;
  float ry = x.y*r2*rq;
  float rz = x.z*D*rq;
  float c = 3.0/r - 4.0*r2*r/S4;
  float fx = f*c*rx;
  float fy = f*c*ry;
  float fz = f*(c*rz - 2.0*a2*x.z/S4);
  float K = (x.x*p.x + x.y*p.y)/D - 2.0*r*(A*p.x + B*p.y)/(D*D) - x.z*p.z/r2;
  float wx = K*rx + (r*p.x - a*p.y)/D;
  float wy = K*ry + (a*p.x + r*p.y)/D;
  float wz = K*rz + p.z/r;
  dp.x = 0.5*fx*w*w + f*w*wx;
  dp.y = 0.5*fy*w*w + f*w*wy;
  dp.z = 0.5*fz*w*w + f*w*wz;`;

// in: x, n (unit direction), a.  out: k, the length of p = k n that puts the photon on the light cone (H = 0)
const NULLK = GEOM + `
  float c = Lx*n.x + Ly*n.y + Lz*n.z;
  float k = (f*c + sqrt(f*f*c*c + (1.0 - f*c*c)*(1.0 + f)))/(1.0 - f*c*c);`;

const toJS = s => s.replace(/\bfloat\b/g, 'let').replace(/\bsqrt\(/g, 'Math.sqrt(');

const api = {
  RHS, NULLK,
  rhs: new Function('x', 'p', 'a', 'dx', 'dp', toJS(RHS)),
  nullk: new Function('x', 'n', 'a', toJS(NULLK) + '\nreturn k;'),
  horizon: a => 1 + Math.sqrt(1 - a * a),
  // innermost stable circular orbit for gas orbiting with the spin (Bardeen, Press & Teukolsky 1972)
  isco: a => {
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a)), z2 = Math.sqrt(3 * a * a + z1 * z1);
    return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
  },
};
if (typeof module !== 'undefined') module.exports = api; else root.KERR = api;
})(this);
