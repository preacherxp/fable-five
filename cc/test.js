// node cc/test.js
const assert = require('assert');
const { compile, run } = require('./cc.js');

// [source, value main() returns, text written with putchar]
const cases = [
  // the int-only core
  ['int main() { return 2 + 3 * 4 - 10 / 3 % 2; }', 13, ''],
  ['int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } int main() { return fib(20); }', 6765, ''],
  ['int main() { return later(4); } int later(int x) { return x * x; }', 16, ''],
  ['int s[1000]; int main() { int i, j, n = 0; for (i = 2; i < 1000; i++) { if (s[i]) continue; n++; for (j = i * i; j < 1000; j += i) s[j] = 1; } return n; }', 168, ''],
  ['int main() { int i = 0, n = 0; while (1) { i++; if (i > 10) break; if (i % 2) continue; n += i; } return n; }', 30, ''],
  ['int g; int hit() { g++; return 1; } int main() { int a = 0 && hit(); int b = 1 || hit(); int c = 1 && hit(); return g * 100 + a * 10 + b + c; }', 102, ''],
  ['int a[4] = {5, 6, 7, 8}; int main() { int i = 0; a[i++] += 10; a[i] <<= 1; return a[0] * 1000 + a[1] * 10 + i; }', 15121, ''],
  ['int x = -3; int main() { int y = x--; return (y == -3) + (x == -4) * 2 + (~x == 3) * 4 + (!x == 0) * 8 + (--x == -5) * 16; }', 31, ''],
  ['/* comments */ int main() { int n = 0; for (int i = 0; i < 5; i++) for (int j = 0; j < 5; j++) { if (j == 3) break; n++; } return n; } // done', 15, ''],
  // doubles and conversions
  ['double half(int n) { return n / 2.0; } int main() { double x = half(7) * 3; return (int)(x * 10); }', 105, ''],
  ['int main() { int i = 3.99; double d = i; d += 0.5; i = d * 2; return i; }', 7, ''],
  ['int main() { return (int)3.7 + (char)300 + (int)((double)1 / 2 * 10) * 100 + 7 / 2 * 1000; }', 3547, ''],
  ['int main() { return (int)(powi(1.5, 4) * 100); } double powi(double b, int n) { return n ? b * powi(b, n - 1) : 1; }', 506, ''],
  ['double d[3] = {1.0, 2.0, 3.0}; int main() { int i = 0; d[i++] *= 2.5; d[i] -= 0.5; return (int)(d[0] * 10) * 100 + (int)(d[1] * 10) + i * 10000; }', 12515, ''],
  ['int main() { char c = 200; int i = c; c = c + 100; return i * 1000 + c; }', -55956, ''],
  ['int main() { double x = 0.0; int n = 0; do { x += 0.25; n++; } while (x < 1.0 && n < 100); return n * 10 + (x >= 1.0) + (1e3 == 1000.0) + (.5 * 4 == 2); }', 43, ''],
  // pointers
  ['int a[5] = {10, 20, 30, 40, 50}; int main() { int *p = a + 1, *q = &a[4]; p++; return *p + (q - p) * 100 + *(q - 1); }', 270, ''],
  ['void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; } int main() { int x = 3, y = 5; swap(&x, &y); double d = 1.5; double *pd = &d; *pd *= 2; return x * 10 + y + (int)d; }', 56, ''],
  ['void set(int **pp, int *v) { *pp = v; } int g = 9; int main() { int *p = 0; set(&p, &g); return *p + (p != 0) + (p == &g); }', 11, ''],
  ['int main() { double v[4]; double *p = v, *e = v + 4; while (p < e) { *p = (p - v) * 1.5; p++; } return (int)(v[3] * 10) + (e - v) * 100 + sizeof(v) * 1000; }', 32445, ''],
  // structs
  ['struct node { int v; struct node *next; }; struct node pool[10]; int sum(struct node *n) { return n ? n->v + sum(n->next) : 0; } int main() { int i; for (i = 0; i < 10; i++) { pool[i].v = i * i; pool[i].next = i < 9 ? &pool[i + 1] : 0; } return sum(pool) + pool[2].next->next->v; }', 301, ''],
  ['struct vec { double x, y; }; struct box { char tag; struct vec lo, hi; int id; }; int main() { struct box a = {\'q\', {1.5, 2.5}, {3.0, 4.0}, 7}, b; b = a; b.hi.x += 1; struct box *p = &b; return sizeof(struct box) * 1000 + sizeof(a.lo) * 10 + (int)(p->hi.x + p->lo.y) + p->id + (p->tag == \'q\') + (a.hi.x == 3.0); }', 48175, ''],
  ['struct v { double x, y; }; struct s { struct v c; double r; int id; }; struct s scene[2] = {{{1, 2}, 0.5, 3}, {{-1.5, 4}, 2, 9}}; int main() { struct s *q = scene + 1; return (int)((scene[0].c.x + scene[0].c.y + scene[0].r + q->c.x + q->c.y + q->r) * 10) + q->id * 1000 + scene->id * 100; }', 9380, ''],
  ['struct tree { int v; struct tree *l, *r; }; struct tree *node(int v) { struct tree *t = malloc(sizeof(struct tree)); t->v = v; t->l = t->r = 0; return t; } void add(struct tree **t, int v) { if (!*t) *t = node(v); else add(v < (*t)->v ? &(*t)->l : &(*t)->r, v); } void walk(struct tree *t) { if (!t) return; walk(t->l); putchar(\'0\' + t->v); walk(t->r); } int main() { struct tree *root = 0; int i, v[7] = {4, 2, 6, 1, 3, 5, 7}; for (i = 0; i < 7; i++) add(&root, v[i]); walk(root); return root->l->r->v; }', 3, '1234567'],
  // arrays, strings, sizeof
  ['int main() { int m[3][4]; int i, j, s = 0; for (i = 0; i < 3; i++) for (j = 0; j < 4; j++) m[i][j] = i * 4 + j; for (i = 0; i < 3; i++) s += m[i][3 - i]; return s * 100 + sizeof(m) + sizeof(m[0]) / sizeof(int); }', 1852, ''],
  ['int len(char *s) { char *e = s; while (*e) e++; return e - s; } char msg[] = "hello"; char *names[2] = {"ab", "cde"}; int main() { char buf[8] = "hi"; buf[2] = \'!\'; char *p = buf; while (*p) putchar(*p++); return len(msg) * 100 + len(names[1]) * 10 + sizeof(msg) + ("xyz"[1] == \'y\') + (buf[7] == 0); }', 538, 'hi!'],
  ['int main() { int a[] = {3, 1, 2}, b[5] = {7}; return sizeof(a) / sizeof(a[0]) * 100 + b[0] * 10 + b[4] + sizeof(char) + sizeof(double) + sizeof(int *); }', 383, ''],
  // #define, malloc, built-in maths
  ['#define N 5\n#define STEP (N - 3)\ndouble total = 0.5; int main() { int i = 0; int *a = malloc(N * sizeof(int)); do { a[i] = i * STEP; i++; } while (i < N); for (i = 0; i < N; i++) total += a[i]; return (int)(total * 2) + (fabs(-2.5) == 2.5) + (int)sqrt(49.0) + (int)floor(-0.5) + (int)ceil(0.2); }', 49, ''],
];

const errors = [
  ['int main() { return x; }', /line 1: 'x' is not declared/],
  ['int main() {\n  return f(1);\n}', /line 2: function 'f' is not defined/],
  ['int f(int a) { return a; } int main() { return f(1, 2); }', /takes 1 argument/],
  ['int main() { 3 = 4; }', /not assignable/],
  ['int main() { break; }', /outside a loop/],
  ['int f() { return 1; }', /no main/],
  ['int main() { int *p; double d = 1.0;\n p = d; return 0; }', /line 2: cannot convert double to int \*/],
  ['int main() { int *p; char *q = 0; p = q; return 0; }', /cannot convert char \* to int \*/],
  ['int main() { int *p = 5; return 0; }', /cannot convert int to int \*/],
  ['struct v { int x; }; int main() { struct v a; return a.y; }', /struct v has no member 'y'/],
  ['int main() { int x = 1; return x->y; }', /'->' needs a struct pointer, got int/],
  ['int main() { double d = 1.0; return d % 2; }', /invalid operands to '%': double and int/],
  ['int main() { int x = 1; return *x; }', /cannot dereference int/],
  ['int main() { return &3; }', /needs something with an address/],
  ['int f(int a); int f(double a) { return 0; } int main() { return 0; }', /conflicting declarations of 'f'/],
  ['struct v; int main() { struct v a; return 0; }', /struct v is not defined yet/],
  ['struct v { int x; }; struct w { int x; }; int main() { struct v a; struct w b; a = b; return 0; }', /cannot assign struct w to struct v/],
  ['void f() {} int main() { int x = f(); return x; }', /cannot convert void to int/],
  ['int main() { int a[2] = {1, 2, 3}; return 0; }', /too many initialisers/],
];

(async () => {
  for (const [src, ret, out] of cases) {
    const r = await run(compile(src));
    assert.deepStrictEqual([r.ret, r.out], [ret, out], src);
  }
  for (const [src, re] of errors) assert.throws(() => compile(src), re, src);
  const drawn = await run(compile('int main() { plot(1, 2, 0xff8800); return 0; }'));
  assert.deepStrictEqual(drawn.pixels, [1, 2, 0xff8800]);
  console.log(`cc: ${cases.length + errors.length + 1} checks passed`);
})();
