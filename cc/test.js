// node cc/test.js
const assert = require('assert');
const { compile, run } = require('./cc.js');

const cases = [
  ['int main() { return 2 + 3 * 4 - 10 / 3 % 2; }', 13, ''],
  ['int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } int main() { return fib(20); }', 6765, ''],
  ['int main() { return later(4); } int later(int x) { return x * x; }', 16, ''],
  ['int s[1000]; int main() { int i, j, n = 0; for (i = 2; i < 1000; i++) { if (s[i]) continue; n++; for (j = i * i; j < 1000; j += i) s[j] = 1; } return n; }', 168, ''],
  ['int main() { int i = 0, n = 0; while (1) { i++; if (i > 10) break; if (i % 2) continue; n += i; } return n; }', 30, ''],
  ['int g; int hit() { g++; return 1; } int main() { int a = 0 && hit(); int b = 1 || hit(); int c = 1 && hit(); return g * 100 + a * 10 + b + c; }', 102, ''],
  ['int a[4] = {5, 6, 7, 8}; int main() { int i = 0; a[i++] += 10; a[i] <<= 1; return a[0] * 1000 + a[1] * 10 + i; }', 15121, ''],
  ['void puts(int s) { int i = 0; while (s[i]) putchar(s[i++]); } int main() { puts("hi\\n"); putchar(\'!\'); return -7; }', -7, 'hi\n!'],
  ['int x = -3; int main() { int y = x--; return (y == -3) + (x == -4) * 2 + (~x == 3) * 4 + (!x == 0) * 8 + (--x == -5) * 16; }', 31, ''],
  ['/* comments */ int main() { int n = 0; for (int i = 0; i < 5; i++) for (int j = 0; j < 5; j++) { if (j == 3) break; n++; } return n; } // done', 15, ''],
];

const errors = [
  ['int main() { return x; }', /line 1: 'x' is not declared/],
  ['int main() {\n  return f(1);\n}', /line 2: function 'f' is not defined/],
  ['int f(int a) { return a; } int main() { return f(1, 2); }', /takes 1 argument/],
  ['int main() { 3 = 4; }', /not assignable/],
  ['int main() { break; }', /outside a loop/],
  ['int f() { return 1; }', /no main/],
];

(async () => {
  for (const [src, ret, out] of cases) {
    const r = await run(compile(src));
    assert.deepStrictEqual([r.ret, r.out], [ret, out], src);
  }
  for (const [src, re] of errors) assert.throws(() => compile(src), re, src);
  console.log(`cc: ${cases.length + errors.length} checks passed`);
})();
