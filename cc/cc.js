// cc.js: a C compiler that emits a WebAssembly binary, byte by byte. No dependencies.
//
// Types: int, char, double, void, pointers, arrays of any dimension, structs. The expression generator is
// type checked: usual arithmetic conversions, casts, scaled pointer arithmetic, sizeof, & and *, struct
// assignment. Also string literals, brace initialisers, #define constants, recursion, forward calls.
// Every local lives in a stack frame in linear memory, so anything can have its address taken.
// Built in: putchar, plot(x, y, rgb), malloc, sqrt, fabs, floor, ceil.
// Not C yet: structs passed or returned by value (pass a pointer), function pointers, unsigned, float, long,
// switch, goto, enum, typedef, function-like macros, the comma operator.
(function (root) {
'use strict';

const uleb = n => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
const sleb = n => { const o = []; for (;;) { const b = n & 127; n >>= 7; if ((n === 0 && !(b & 64)) || (n === -1 && (b & 64))) { o.push(b); return o; } o.push(b | 128); } };
const konst = n => [0x41, ...sleb(n | 0)];
const f64 = v => [0x44, ...new Uint8Array(new Float64Array([v]).buffer)];
const str = s => [...uleb(s.length), ...[...s].map(c => c.charCodeAt(0))];
const vec = items => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const up = (n, a) => (n + a - 1) & -a;
const unescape = s => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', 0: '\0' }[c] ?? c));

const INT = { k: 'int' }, CHAR = { k: 'char' }, DOUBLE = { k: 'double' }, VOID = { k: 'void' };
const ptr = to => ({ k: 'ptr', to }), arr = (of, n) => ({ k: 'arr', of, n });
const isInt = t => t === INT || t === CHAR, isArith = t => isInt(t) || t === DOUBLE, isScalar = t => isArith(t) || t.k === 'ptr';
const same = (a, b) => a === b || (a.k === b.k && (a.k === 'ptr' ? same(a.to, b.to) : a.k === 'arr' ? a.n === b.n && same(a.of, b.of) : a.k === 'struct' && a.name === b.name));
const show = t => t.k === 'ptr' ? show(t.to) + ' *' : t.k === 'arr' ? `${show(t.of)}[${t.n}]` : t.k === 'struct' ? 'struct ' + t.name : t.k;
const alignOf = t => t.k === 'arr' ? alignOf(t.of) : t.k === 'struct' ? t.align : t === CHAR ? 1 : t === DOUBLE ? 8 : 4;
const wasmType = t => t === DOUBLE ? 0x7c : 0x7f;
const LOAD = t => t === CHAR ? [0x2c, 0, 0] : t === DOUBLE ? [0x2b, 3, 0] : [0x28, 2, 0];
const STORE = t => t === CHAR ? [0x3a, 0, 0] : t === DOUBLE ? [0x39, 3, 0] : [0x36, 2, 0];

const TYPES = new Set(['int', 'char', 'double', 'void', 'struct', 'const', 'static']);
const KW = new Set([...TYPES, 'if', 'else', 'while', 'for', 'do', 'return', 'break', 'continue', 'sizeof']);
const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
const OP = { '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': 0x6d, '%': 0x6f, '&': 0x71, '|': 0x72, '^': 0x73, '<<': 0x74, '>>': 0x75, '==': 0x46, '!=': 0x47, '<': 0x48, '>': 0x4a, '<=': 0x4c, '>=': 0x4e };
const FOP = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3, '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64, '<=': 0x65, '>=': 0x66 };
const CMP = new Set(['==', '!=', '<', '>', '<=', '>=']);
const MATH = { sqrt: 0x9f, fabs: 0x99, floor: 0x9c, ceil: 0x9b };   // one f64 instruction each
const NZ = [0x41, 0, 0x47], COPY = [0xfc, 0x0a, 0, 0], FILL = [0xfc, 0x0b, 0];

function compile(src) {
  const lineOf = pos => src.slice(0, pos).split('\n').length;

  // ---- lexer, with #define NAME tokens
  const macros = new Map(), busy = new Set();
  const lex = (text, at) => {
    const re = /\s+|\/\/.*|\/\*[\s\S]*?\*\/|#include.*|#define[ \t]+(\w+)[ \t]+(.*)|(0x[0-9a-fA-F]+|\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+|\d+)|([A-Za-z_]\w*)|'(\\.|[^'\\])'|"((?:\\.|[^"\\])*)"|(<<=|>>=|->|[-+*\/%&|^]=|&&|\|\||<<|>>|[=!<>]=|\+\+|--|[-+*\/%<>=!~&|^?:;,.(){}\[\]])/y;
    const out = [];
    while (re.lastIndex < text.length) {
      const here = re.lastIndex, m = re.exec(text), pos = at ?? here;
      if (!m) throw new Error(`line ${lineOf(pos)}: unexpected character '${text[here]}'`);
      if (m[1]) macros.set(m[1], m[2]);
      else if (m[3] !== undefined) out.push({ k: 'num', v: Number(m[3]), f: /[.eE]/.test(m[3]) && !/^0x/i.test(m[3]), pos });
      else if (m[4] !== undefined && macros.has(m[4]) && !busy.has(m[4])) { busy.add(m[4]); out.push(...lex(macros.get(m[4]), pos)); busy.delete(m[4]); }
      else if (m[4] !== undefined) out.push({ k: 'id', v: m[4], pos });
      else if (m[5] !== undefined) out.push({ k: 'num', v: unescape(m[5]).charCodeAt(0), pos });
      else if (m[6] !== undefined) out.push({ k: 'str', v: unescape(m[6]), pos });
      else if (m[7] !== undefined) out.push({ k: 'op', v: m[7], pos });
    }
    return out;
  };
  const toks = lex(src);

  // One pass over the file. The first pass (known = null) only collects function signatures, so calls can
  // come before definitions; the second generates code.
  const unit = known => {
    const scan = !known;
    let p = 0;
    const fail = (msg, t = toks[p] || toks[toks.length - 1]) => { throw new Error(`line ${t ? lineOf(t.pos) : 1}: ${msg}`); };
    const peek = v => !!toks[p] && (toks[p].k === 'op' || toks[p].k === 'id') && toks[p].v === v;
    const eat = v => peek(v) && !!++p;
    const need = v => eat(v) || fail(`expected '${v}'`);
    const isName = t => !!t && t.k === 'id' && !KW.has(t.v);
    const ident = () => isName(toks[p]) ? toks[p++].v : fail('expected a name');
    const isType = (t = toks[p]) => !!t && t.k === 'id' && TYPES.has(t.v);
    const number = () => { const neg = eat('-'), t = toks[p++]; if (!t || t.k !== 'num') fail('expected a constant', t); return neg ? -t.v : t.v; };

    const structs = new Map(), globals = new Map(), data = [];   // data: [address, bytes] segments
    const funcs = new Map(known || [
      ['putchar', { name: 'putchar', idx: 0, params: [{ t: INT }], ret: INT, imp: 1, sig: [[0x7f], [0x7f]] }],
      ['plot', { name: 'plot', idx: 1, params: [{ t: INT }, { t: INT }, { t: INT }], ret: VOID, imp: 1, sig: [[0x7f, 0x7f, 0x7f], []] }],
    ]);
    let fn, scopes, frame, depth, loops, top = 16;                 // top: end of static data
    const size = (t, tk) => t === CHAR || t === VOID ? 1 : t === DOUBLE ? 8 : t.k === 'arr' ? t.n * size(t.of, tk)
      : t.k === 'struct' ? t.size ?? fail(`struct ${t.name} is not defined yet`, tk) : 4;
    const alloc = (t, tk) => { const s = size(t, tk); top = up(top, alignOf(t)) + s; return top - s; };
    const string = s => { top += s.length + 1; data.push([top - s.length - 1, [...s].map(c => c.charCodeAt(0) & 255).concat(0)]); return top - s.length - 1; };
    const bytesOf = (t, v) => t === DOUBLE ? [...new Uint8Array(new Float64Array([v]).buffer)] : t === CHAR ? [v & 255] : [0, 8, 16, 24].map(s => (v >> s) & 255);
    const local = off => off ? [0x20, fn.np, ...konst(off), 0x6a] : [0x20, fn.np];   // address of a slot in this frame

    // ---- types and declarators
    function baseType() {
      while (eat('const') || eat('static'));
      for (const [kw, t] of [['int', INT], ['char', CHAR], ['double', DOUBLE], ['void', VOID]]) if (eat(kw)) return t;
      if (!eat('struct')) return null;
      const tk = toks[p], name = ident();
      const s = structs.get(name) || structs.set(name, { k: 'struct', name, members: new Map() }).get(name);
      if (eat('{')) {
        if (s.size !== undefined) fail(`struct ${name} is already defined`, tk);
        let off = 0; s.align = 1;
        while (!eat('}')) {
          const bt = baseType() || fail('expected a member type');
          do {
            const [t, n, mt] = declarator(bt), sz = size(t, mt);
            if (s.members.has(n)) fail(`struct ${name} already has a member '${n}'`, mt);
            off = up(off, alignOf(t)); s.members.set(n, { t, off }); off += sz; s.align = Math.max(s.align, alignOf(t));
          } while (eat(','));
          need(';');
        }
        s.size = up(off, s.align);
      }
      return s;
    }
    function declarator(t, nameless) {
      while (eat('*')) t = ptr(t);
      const tk = toks[p], name = nameless && !isName(tk) ? null : ident(), dims = [];
      while (eat('[')) { dims.push(peek(']') ? 0 : number()); need(']'); }
      for (let i = dims.length - 1; i >= 0; i--) t = arr(t, dims[i]);
      return [t, name, tk];
    }
    const typeName = () => { let t = baseType(); while (eat('*')) t = ptr(t); return t; };

    // `int a[] = {1, 2, 3}` and `char s[] = "abc"` take their size from the initialiser.
    function sized(t, tk) {
      if (t === VOID) fail('a variable cannot be void', tk);
      if (t.k !== 'arr' || t.n) return t;
      if (!peek('=')) fail('array needs a size', tk);
      if (toks[p + 1] && toks[p + 1].k === 'str') return arr(t.of, toks[p + 1].v.length + 1);
      let n = 0, d = 0, fresh = false;   // ponytail: counts commas at brace depth 1, so a call with arguments in there miscounts
      for (let i = p + 1; i < toks.length; i++) {
        const v = toks[i].k === 'op' ? toks[i].v : '';
        if (v === '}' && !--d) break;
        if (d === 1 && v === ',') fresh = true; else if (d === 1 && fresh) { n++; fresh = false; }
        if (v === '{' && ++d === 1) fresh = true;
      }
      return arr(t.of, n);
    }
    // Walks a (possibly nested) initialiser and calls leaf(type, offset, string?) for each value in it.
    function init(t, off, leaf) {
      const tk = toks[p];
      if (t.k === 'arr' && t.of === CHAR && tk && tk.k === 'str') { p++; if (tk.v.length > t.n) fail('string is too long for the array', tk); return leaf(t, off, tk.v); }
      if (!eat('{')) return leaf(t, off);
      const parts = t.k === 'arr' ? Array.from({ length: t.n }, (_, i) => [t.of, off + i * size(t.of)])
        : t.k === 'struct' ? [...t.members.values()].map(m => [m.t, off + m.off]) : [[t, off]];
      for (let i = 0; !eat('}'); i++) { if (i >= parts.length) fail('too many initialisers'); init(...parts[i], leaf); if (!peek('}')) need(','); }
    }

    // ---- expressions. Each is { t: type, code } for a value on the wasm stack, or { t, addr } for an lvalue,
    // where addr is the code that pushes its address. rval() turns either into a value.
    const rval = e => !e.addr ? e : e.t.k === 'arr' ? { t: ptr(e.t.of), code: e.addr } : e.t.k === 'struct' ? e : { t: e.t, code: [...e.addr, ...LOAD(e.t)] };
    const truth = (e, tk) => { e = rval(e); return e.t === DOUBLE ? [...e.code, ...f64(0), 0x62] : isScalar(e.t) ? e.code : fail(`${show(e.t)} cannot be a condition`, tk); };
    const discard = e => e.t === VOID ? e.code : e.t.k === 'struct' ? [] : [...rval(e).code, 0x1a];

    function conv(e, to, tk, cast) {
      const f = e.t, c = e.code;
      if (isScalar(f) && isScalar(to)) {
        if (same(f, to)) return e;
        if (isInt(f) && isInt(to)) return { t: to, code: to === CHAR ? [...c, 0xc0] : c };
        if (isInt(f) && to === DOUBLE) return { t: to, code: [...c, 0xb7] };
        if (f === DOUBLE && isInt(to)) return { t: to, code: [...c, 0xfc, 2, ...(to === CHAR ? [0xc0] : [])] };   // saturating truncation
        const viaVoid = f.k === 'ptr' && to.k === 'ptr' && (f.to === VOID || to.to === VOID);
        if (f !== DOUBLE && to !== DOUBLE && (cast || viaVoid || (e.zero && to.k === 'ptr'))) return { t: to, code: c };
      }
      fail(`cannot convert ${show(f)} to ${show(to)}`, tk);
    }

    function binop(op, a, b, tk) {
      const bad = () => fail(`invalid operands to '${op}': ${show(a.t)} and ${show(b.t)}`, tk);
      const ap = a.t.k === 'ptr', bp = b.t.k === 'ptr';
      if (ap || bp) {                              // pointer arithmetic moves in units of the pointed-to type
        const times = t => { const s = size(t.to, tk); return s === 1 ? [] : [...konst(s), 0x6c]; };
        if (op === '+' && ap && isInt(b.t)) return { t: a.t, code: [...a.code, ...b.code, ...times(a.t), 0x6a] };
        if (op === '+' && bp && isInt(a.t)) return { t: b.t, code: [...a.code, ...times(b.t), ...b.code, 0x6a] };
        if (op === '-' && ap && isInt(b.t)) return { t: a.t, code: [...a.code, ...b.code, ...times(a.t), 0x6b] };
        if (op === '-' && ap && bp && same(a.t, b.t)) { const s = size(a.t.to, tk); return { t: INT, code: [...a.code, ...b.code, 0x6b, ...(s === 1 ? [] : [...konst(s), 0x6d])] }; }
        if (CMP.has(op) && ((ap && bp) || a.zero || b.zero)) return { t: INT, code: [...a.code, ...b.code, OP[op]] };
        bad();
      }
      if (!isArith(a.t) || !isArith(b.t)) bad();
      if (a.t !== DOUBLE && b.t !== DOUBLE) return { t: INT, code: [...a.code, ...b.code, OP[op]] };
      if (!FOP[op]) bad();
      return { t: CMP.has(op) ? INT : DOUBLE, code: [...conv(a, DOUBLE, tk).code, ...conv(b, DOUBLE, tk).code, FOP[op]] };
    }

    // `l op= r` (op '' for plain '='), leaving the stored value. The address is computed once.
    function assign(l, op, r, tk) {
      if (!l.addr || l.t.k === 'arr') fail('left side is not assignable', tk);
      if (l.t.k === 'struct') {
        if (op || !r.addr || !same(l.t, r.t)) fail(`cannot assign ${show(r.t)} to ${show(l.t)}`, tk);
        return { t: VOID, code: [...l.addr, ...r.addr, ...konst(size(l.t, tk)), ...COPY] };
      }
      const T = fn.np + 1, V = l.t === DOUBLE ? fn.np + 3 : T;   // scratch locals: i32 and f64
      const v = conv(op ? binop(op, { t: l.t, code: [0x22, T, 0x20, T, ...LOAD(l.t)] }, rval(r), tk) : rval(r), l.t, tk);
      return { t: l.t, code: [...l.addr, ...v.code, 0x21, V, 0x20, V, ...STORE(l.t), 0x20, V] };
    }
    const one = () => ({ t: INT, code: konst(1) });

    function primary() {
      const t = toks[p++];
      if (!t) { p--; fail('unexpected end of input'); }
      if (t.k === 'num') return t.f ? { t: DOUBLE, code: f64(t.v) } : { t: INT, code: konst(t.v), zero: t.v === 0 };
      if (t.k === 'str') return { t: arr(CHAR, t.v.length + 1), addr: konst(string(t.v)) };
      if (t.k === 'op' && t.v === '(') { const e = expr(); need(')'); return e; }
      if (!isName(t)) fail(`unexpected '${t.v}'`, t);
      if (eat('(')) {
        const args = [];
        if (!eat(')')) { do args.push(rval(expr())); while (eat(',')); need(')'); }
        const f = funcs.get(t.v), want = n => args.length === n || fail(`'${t.v}' takes ${n} argument(s), got ${args.length}`, t);
        if (!f && MATH[t.v]) { want(1); return { t: DOUBLE, code: [...conv(args[0], DOUBLE, t).code, MATH[t.v]] }; }
        // ponytail: bump allocator, never frees and never checks against the stack. Add a free list if programs need it.
        if (!f && t.v === 'malloc') { want(1); return { t: ptr(VOID), code: [0x23, 1, 0x23, 1, ...conv(args[0], INT, t).code, 0x6a, ...konst(7), 0x6a, ...konst(-8), 0x71, 0x24, 1] }; }
        if (!f) fail(`function '${t.v}' is not defined`, t);
        want(f.params.length);
        return { t: f.ret, code: [...args.flatMap((a, i) => conv(a, f.params[i].t, t).code), 0x10, ...uleb(f.idx)] };
      }
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(t.v)) { const l = scopes[i].get(t.v); return { t: l.t, addr: local(l.off) }; }
      const g = globals.get(t.v) || fail(`'${t.v}' is not declared`, t);
      return { t: g.t, addr: konst(g.addr) };
    }

    function postfix() {
      let e = primary();
      for (;;) {
        const tk = toks[p];
        if (eat('[')) {
          const b = rval(e), i = rval(expr()); need(']');
          if (b.t.k !== 'ptr' || b.t.to === VOID || !isInt(i.t)) fail(`cannot index ${show(e.t)} with ${show(i.t)}`, tk);
          e = { t: b.t.to, addr: binop('+', b, i, tk).code };
        } else if (peek('.') || peek('->')) {
          const arrow = toks[p++].v === '->', b = arrow ? rval(e) : e, st = arrow ? b.t.to : b.t;
          if (!st || st.k !== 'struct' || (arrow ? b.t.k !== 'ptr' : !b.addr)) fail(`'${arrow ? '->' : '.'}' needs a struct${arrow ? ' pointer' : ''}, got ${show(e.t)}`, tk);
          const mt = toks[p], m = st.members.get(ident()) || fail(`struct ${st.name} has no member '${mt.v}'`, mt);
          const base = arrow ? b.code : b.addr;
          e = { t: m.t, addr: m.off ? [...base, ...konst(m.off), 0x6a] : base };
        } else if (peek('++') || peek('--')) {     // x++ is (x += 1) - 1
          const op = toks[p++].v[0];
          e = binop(op === '+' ? '-' : '+', assign(e, op, one(), tk), one(), tk);
        } else return e;
      }
    }

    function unary() {
      const tk = toks[p];
      if (eat('-')) { const e = rval(unary()); return e.t === DOUBLE ? { t: DOUBLE, code: [...e.code, 0x9a] } : isInt(e.t) ? { t: INT, code: [...konst(0), ...e.code, 0x6b] } : fail(`cannot negate ${show(e.t)}`, tk); }
      if (eat('+')) return rval(unary());
      if (eat('!')) return { t: INT, code: [...truth(unary(), tk), 0x45] };
      if (eat('~')) { const e = rval(unary()); return isInt(e.t) ? { t: INT, code: [...e.code, ...konst(-1), 0x73] } : fail(`'~' needs an int, got ${show(e.t)}`, tk); }
      if (eat('*')) { const e = rval(unary()); return e.t.k === 'ptr' && e.t.to !== VOID ? { t: e.t.to, addr: e.code } : fail(`cannot dereference ${show(e.t)}`, tk); }
      if (eat('&')) { const e = unary(); return e.addr ? { t: ptr(e.t), code: e.addr } : fail("'&' needs something with an address", tk); }
      if (peek('++') || peek('--')) { const op = toks[p++].v[0]; return assign(unary(), op, one(), tk); }
      if (eat('sizeof')) {
        let t;
        if (peek('(') && isType(toks[p + 1])) { p++; t = typeName(); need(')'); } else t = unary().t;
        return { t: INT, code: konst(size(t, tk)) };
      }
      if (peek('(') && isType(toks[p + 1])) { p++; const t = typeName(); need(')'); return conv(rval(unary()), t, tk, true); }
      return postfix();
    }

    function binary(min) {
      let l = unary();
      for (;;) {
        const t = toks[p], pr = t && t.k === 'op' && PREC[t.v];
        if (!pr || pr < min) return l;
        p++;
        const r = binary(pr + 1);
        l = t.v === '&&' ? { t: INT, code: [...truth(l, t), 0x04, 0x7f, ...truth(r, t), ...NZ, 0x05, ...konst(0), 0x0b] }
          : t.v === '||' ? { t: INT, code: [...truth(l, t), 0x04, 0x7f, ...konst(1), 0x05, ...truth(r, t), ...NZ, 0x0b] }
          : binop(t.v, rval(l), rval(r), t);
      }
    }

    function expr() {
      const l = binary(1), t = toks[p];
      if (eat('?')) {
        const a = rval(expr()); need(':'); const b = rval(expr());
        const ty = isArith(a.t) && isArith(b.t) ? (a.t === DOUBLE || b.t === DOUBLE ? DOUBLE : INT) : a.zero ? b.t : a.t;
        const arm = e => ty === VOID && e.t === VOID ? e.code : conv(e, ty, t).code;
        return { t: ty, code: [...truth(l, t), 0x04, ty === VOID ? 0x40 : wasmType(ty), ...arm(a), 0x05, ...arm(b), 0x0b] };
      }
      if (t && t.k === 'op' && /^(<<|>>|[-+*\/%&|^])?=$/.test(t.v)) { p++; return assign(l, t.v.slice(0, -1), expr(), t); }
      return l;
    }

    // ---- statements. `depth` counts open wasm labels (the function body is label 1) so break, continue
    // and return know how far to branch.
    function declare(code) {
      const bt = baseType();
      if (eat(';')) return;
      do {
        const [t0, name, tk] = declarator(bt), t = sized(t0, tk), sz = size(t, tk);
        frame = up(frame, alignOf(t));
        const off = frame; frame += sz;
        scopes[scopes.length - 1].set(name, { t, off });
        if (!eat('=')) continue;
        if (t.k === 'arr' || (t.k === 'struct' && peek('{'))) code.push(...local(off), ...konst(0), ...konst(sz), ...FILL);   // the rest is zero, as in C
        init(t, off, (lt, o, s) => code.push(...(s !== undefined
          ? [...local(o), ...konst(string(s)), ...konst(Math.min(s.length + 1, lt.n)), ...COPY]
          : discard(assign({ t: lt, addr: local(o) }, '', expr(), tk)))));
      } while (eat(','));
      need(';');
    }

    function stmt() {
      const t = toks[p];
      if (eat('{')) { scopes.push(new Map()); const c = []; while (!eat('}')) c.push(...stmt()); scopes.pop(); return c; }
      if (isType()) { const c = []; declare(c); return c; }
      if (eat('if')) {
        need('('); const c = truth(expr(), t); need(')');
        depth++; const a = stmt(), b = eat('else') ? stmt() : null; depth--;
        return [...c, 0x04, 0x40, ...a, ...(b ? [0x05, ...b] : []), 0x0b];
      }
      if (eat('while')) {
        need('('); const c = truth(expr(), t); need(')');
        depth += 2; loops.push({ brk: depth - 1, cont: depth }); const b = stmt(); loops.pop(); depth -= 2;
        return [0x02, 0x40, 0x03, 0x40, ...c, 0x45, 0x0d, 1, ...b, 0x0c, 0, 0x0b, 0x0b];
      }
      if (eat('do')) {
        depth += 3; loops.push({ brk: depth - 2, cont: depth }); const b = stmt(); loops.pop(); depth -= 3;
        need('while'); need('('); const c = truth(expr(), t); need(')'); need(';');
        return [0x02, 0x40, 0x03, 0x40, 0x02, 0x40, ...b, 0x0b, ...c, 0x0d, 0, 0x0b, 0x0b];
      }
      if (eat('for')) {
        need('('); scopes.push(new Map());
        const init = eat(';') ? [] : stmt();
        const c = peek(';') ? konst(1) : truth(expr(), t); need(';');
        const step = peek(')') ? [] : discard(expr()); need(')');
        depth += 3; loops.push({ brk: depth - 2, cont: depth }); const b = stmt(); loops.pop(); depth -= 3;
        scopes.pop();
        return [...init, 0x02, 0x40, 0x03, 0x40, ...c, 0x45, 0x0d, 1, 0x02, 0x40, ...b, 0x0b, ...step, 0x0c, 0, 0x0b, 0x0b];
      }
      if (peek('break') || peek('continue')) {
        const brk = toks[p++].v === 'break', l = loops[loops.length - 1];
        if (!l) fail(`'${t.v}' outside a loop`, t);
        need(';');
        return [0x0c, ...uleb(depth - (brk ? l.brk : l.cont))];
      }
      if (eat('return')) {                         // park the value in a local, then leave through the epilogue
        let c = [];
        if (!peek(';')) c = fn.ret === VOID ? fail('a void function cannot return a value', t) : [...conv(rval(expr()), fn.ret, t).code, 0x21, fn.np + (fn.ret === DOUBLE ? 4 : 2)];
        else if (fn.ret !== VOID) fail('return needs a value', t);
        need(';');
        return [...c, 0x0c, ...uleb(depth - 1)];
      }
      if (eat(';')) return [];
      const c = discard(expr()); need(';');
      return c;
    }

    // ---- top level
    while (p < toks.length) {
      const bt = baseType() || fail('expected a declaration');
      if (eat(';')) continue;
      let [t, name, tk] = declarator(bt);
      if (eat('(')) {
        const params = [];
        if (peek('void') && toks[p + 1] && toks[p + 1].k === 'op' && toks[p + 1].v === ')') p++;
        if (!eat(')')) {
          do {
            const [pt, pn, pk] = declarator(baseType() || fail('expected a parameter type'), true);
            if (pt.k === 'struct' || pt === VOID) fail(`a parameter cannot be ${show(pt)}, pass a pointer`, pk);
            params.push({ t: pt.k === 'arr' ? ptr(pt.of) : pt, name: pn });
          } while (eat(','));
          need(')');
        }
        if (t.k === 'struct' || t.k === 'arr') fail(`a function cannot return ${show(t)}, write through a pointer`, tk);
        let f = funcs.get(name);
        if (!f) funcs.set(name, f = { name, idx: funcs.size, params, ret: t });
        else if (!f.imp && (f.params.length !== params.length || !same(f.ret, t) || params.some((q, i) => !same(q.t, f.params[i].t)))) fail(`conflicting declarations of '${name}'`, tk);
        if (eat(';')) continue;                    // a prototype
        if (!peek('{')) fail("expected '{' or ';'");
        if (f.imp) fail(`'${name}' is built in`, tk);
        if (scan) {                                // skip the body for now
          if (f.def) fail(`'${name}' is already defined`, tk);
          f.def = true;
          let d = 0;
          do { const v = toks[p].k === 'op' ? toks[p].v : ''; d += v === '{' ? 1 : v === '}' ? -1 : 0; p++; } while (d && p < toks.length);
          continue;
        }
        fn = f; fn.np = params.length; scopes = [new Map()]; frame = 0; depth = 1; loops = [];
        const pre = [];                            // copy the wasm parameters into the frame
        params.forEach((q, i) => {
          if (!q.name) fail('parameter needs a name', tk);
          frame = up(frame, alignOf(q.t)); scopes[0].set(q.name, { t: q.t, off: frame });
          pre.push(...local(frame), 0x20, i, ...STORE(q.t)); frame += size(q.t, tk);
        });
        // locals: np = frame pointer, np+1 = i32 scratch, np+2 = i32 result, np+3 = f64 scratch, np+4 = f64 result
        const body = stmt(), F = konst(up(frame, 8)), FP = fn.np;
        f.body = [0x23, 0, ...F, 0x6b, 0x22, FP, 0x24, 0, ...pre, 0x02, 0x40, ...body, 0x0b,
          0x20, FP, ...F, 0x6a, 0x24, 0, ...(t === VOID ? [] : [0x20, FP + (t === DOUBLE ? 4 : 2)])];
        f.sig = [params.map(q => wasmType(q.t)), t === VOID ? [] : [wasmType(t)]];
        continue;
      }
      for (;;) {                                   // global variables, initialised with constants
        t = sized(t, tk);
        if (globals.has(name) || funcs.has(name)) fail(`'${name}' is already defined`, tk);
        const addr = alloc(t, tk);
        globals.set(name, { t, addr });
        if (eat('=')) {
          const bytes = Array(size(t)).fill(0);
          init(t, 0, (lt, o, s) => {
            const at = toks[p];
            const b = s !== undefined ? [...s].map(c => c.charCodeAt(0) & 255)
              : lt.k === 'ptr' && at && at.k === 'str' ? (p++, bytesOf(INT, string(at.v)))
              : isScalar(lt) ? bytesOf(lt, number()) : fail(`${show(lt)} needs a brace initialiser`, at);
            b.slice(0, size(lt)).forEach((v, i) => { bytes[o + i] = v; });
          });
          data.push([addr, bytes]);
        }
        if (!eat(',')) break;
        [t, name, tk] = declarator(bt);
      }
      need(';');
    }
    if (scan) return funcs;

    // ---- encode the module
    const main = funcs.get('main');
    if (!main || !main.body) throw new Error('no main() function');
    if (main.params.length) throw new Error('main() takes no arguments');
    const all = [...funcs.values()].sort((a, b) => a.idx - b.idx), user = all.filter(f => !f.imp);
    for (const f of user) if (!f.body) throw new Error(`function '${f.name}' is declared but never defined`);
    const types = [];
    const typeIdx = sig => { const key = sig.join('>'); let i = types.findIndex(x => x.key === key); if (i < 0) i = types.push({ key, sig }) - 1; return uleb(i); };
    const tix = all.map(f => typeIdx(f.sig));
    // ponytail: 1 MiB above the static data, shared by the heap (growing up) and the stack (growing down), unchecked.
    const pages = Math.ceil(top / 65536) + 16;
    return new Uint8Array([
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...section(1, vec(types.map(x => [0x60, ...vec(x.sig[0].map(v => [v])), ...vec(x.sig[1].map(v => [v]))]))),
      ...section(2, vec(all.filter(f => f.imp).map(f => [...str('env'), ...str(f.name), 0, ...tix[f.idx]]))),
      ...section(3, vec(user.map(f => tix[f.idx]))),
      ...section(5, vec([[0, ...uleb(pages)]])),
      ...section(6, vec([[0x7f, 1, ...konst(pages * 65536), 0x0b], [0x7f, 1, ...konst(up(top, 8)), 0x0b]])),   // stack pointer, heap pointer
      ...section(7, vec([[...str('main'), 0, ...uleb(main.idx)], [...str('memory'), 2, 0]])),
      ...section(10, vec(user.map(f => { const body = [...vec([[3, 0x7f], [2, 0x7c]]), ...f.body, 0x0b]; return [...uleb(body.length), ...body]; }))),
      ...(data.length ? section(11, vec(data.map(([a, b]) => [0, ...konst(a), 0x0b, ...uleb(b.length), ...b]))) : []),
    ]);
  };
  return unit(unit(null));
}

// Runs main(). `pixels` is a flat list of x, y, rgb triples from plot().
async function run(bytes) {
  let out = '';
  const pixels = [];
  const { instance } = await WebAssembly.instantiate(bytes, { env: { putchar: c => { out += String.fromCharCode(c); return c; }, plot: (x, y, rgb) => { pixels.push(x, y, rgb); } } });
  // ponytail: runs on the calling thread, so an infinite loop hangs the tab. Move to a Worker if that matters.
  const ret = instance.exports.main();
  return { out, ret, pixels };
}

const api = { compile, run };
if (typeof module !== 'undefined') module.exports = api; else root.CC = api;
})(this);
