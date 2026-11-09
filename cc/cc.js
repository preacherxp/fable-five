// cc.js: a C-subset compiler that emits a WebAssembly binary, byte by byte. No dependencies.
//
// Supported: int, functions, recursion, if/else, while, for, break, continue, return, global arrays,
// string literals, all the usual operators (including ?:, &&, ||, ++, --, compound assignment).
// Not C: everything is a 32-bit int. Arrays and strings are int cells in linear memory, a[i] reads
// cell a + 4*i, and there is no pointer arithmetic, no structs, no preprocessor.
(function (root) {
'use strict';

const uleb = n => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
const sleb = n => { const o = []; for (;;) { const b = n & 127; n >>= 7; if ((n === 0 && !(b & 64)) || (n === -1 && (b & 64))) { o.push(b); return o; } o.push(b | 128); } };
const konst = n => [0x41, ...sleb(n | 0)];
const str = s => [...uleb(s.length), ...[...s].map(c => c.charCodeAt(0))];
const vec = items => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];

const KW = new Set(['int', 'void', 'if', 'else', 'while', 'for', 'return', 'break', 'continue']);
const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
const OP = { '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': 0x6d, '%': 0x6f, '&': 0x71, '|': 0x72, '^': 0x73, '<<': 0x74, '>>': 0x75, '==': 0x46, '!=': 0x47, '<': 0x48, '>': 0x4a, '<=': 0x4c, '>=': 0x4e };
const LOAD = [0x28, 2, 0], STORE = [0x36, 2, 0], NZ = [0x41, 0, 0x47];
const unescape = s => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', 0: '\0' }[c] ?? c));

function compile(src) {
  const lineOf = pos => src.slice(0, pos).split('\n').length;

  // ---- lexer
  const re = /\s+|\/\/.*|\/\*[\s\S]*?\*\/|(0x[0-9a-fA-F]+|\d+)|([A-Za-z_]\w*)|'(\\.|[^'\\])'|"((?:\\.|[^"\\])*)"|(<<=|>>=|[-+*\/%&|^]=|&&|\|\||<<|>>|[=!<>]=|\+\+|--|[-+*\/%<>=!~&|^?:;,(){}\[\]])/y;
  const toks = [];
  while (re.lastIndex < src.length) {
    const pos = re.lastIndex, m = re.exec(src);
    if (!m) throw new Error(`line ${lineOf(pos)}: unexpected character '${src[pos]}'`);
    if (m[1] !== undefined) toks.push({ k: 'num', v: Number(m[1]), pos });
    else if (m[2] !== undefined) toks.push({ k: 'id', v: m[2], pos });
    else if (m[3] !== undefined) toks.push({ k: 'num', v: unescape(m[3]).charCodeAt(0), pos });
    else if (m[4] !== undefined) toks.push({ k: 'str', v: unescape(m[4]), pos });
    else if (m[5] !== undefined) toks.push({ k: 'op', v: m[5], pos });
  }

  let p = 0;
  const fail = (msg, t = toks[p] || toks[toks.length - 1]) => { throw new Error(`line ${t ? lineOf(t.pos) : 1}: ${msg}`); };
  const peek = v => !!toks[p] && (toks[p].k === 'op' || toks[p].k === 'id') && toks[p].v === v;
  const eat = v => peek(v) && !!++p;
  const need = v => eat(v) || fail(`expected '${v}'`);
  const ident = () => (toks[p] && toks[p].k === 'id' && !KW.has(toks[p].v)) ? toks[p++].v : fail('expected a name');
  const cnum = () => { const neg = eat('-'), t = toks[p++]; if (!t || t.k !== 'num') fail('expected a constant'); return neg ? -t.v : t.v; };

  // ---- static memory: initialised data lives in page 0, zeroed arrays from page 1 up
  const mem = []; let dtop = 8, btop = 65536;
  const alloc = (words, zeroed) => { if (zeroed) { btop += words * 4; return btop - words * 4; } dtop += words * 4; if (dtop > 65536) fail('too much initialised data'); return dtop - words * 4; };
  const poke = (addr, v) => { for (let i = 0; i < 4; i++) mem[addr + i] = (v >> (8 * i)) & 255; };

  const globals = new Map();                       // name -> { addr, arr }
  const funcs = new Map([['putchar', { idx: 0, arity: 1 }]]);
  let fn, scopes, nlocals, depth, loops;
  const lookup = name => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); };

  // ---- expressions. Each returns { code, lv? } where code leaves exactly one i32 on the stack.
  // `e op= rhs` (op '' for plain '='), leaving the stored value.
  function store(e, op, rhs) {
    if (!e.lv) fail('left side is not assignable');
    if ('local' in e.lv) return [...(op ? [...e.code, ...rhs, OP[op]] : rhs), 0x22, ...uleb(e.lv.local)];
    const T = uleb(fn.arity);                      // the function's scratch local
    return [...e.lv.addr, ...(op ? [0x22, ...T, 0x20, ...T, ...LOAD, ...rhs, OP[op]] : rhs), 0x21, ...T, 0x20, ...T, ...STORE, 0x20, ...T];
  }

  function primary() {
    const t = toks[p++];
    if (!t) { p--; fail('unexpected end of input'); }
    if (t.k === 'num') return { code: konst(t.v) };
    if (t.k === 'str') { const a = alloc(t.v.length + 1); [...t.v].forEach((c, i) => poke(a + 4 * i, c.charCodeAt(0))); return { code: konst(a) }; }
    if (t.k === 'op' && t.v === '(') { const e = expr(); need(')'); return e; }
    if (t.k === 'id' && !KW.has(t.v)) {
      if (eat('(')) {
        const code = []; let n = 0;
        if (!eat(')')) { do { code.push(...expr().code); n++; } while (eat(',')); need(')'); }
        code.push({ call: t.v, n, t });           // resolved once every function is known
        return { code };
      }
      const l = lookup(t.v);
      if (l !== undefined) return { code: [0x20, ...uleb(l)], lv: { local: l } };
      const g = globals.get(t.v);
      if (!g) fail(`'${t.v}' is not declared`, t);
      return g.arr ? { code: konst(g.addr) } : { code: [...konst(g.addr), ...LOAD], lv: { addr: konst(g.addr) } };
    }
    fail(`unexpected '${t.v}'`, t);
  }

  function postfix() {
    let e = primary();
    for (;;) {
      if (eat('[')) { const i = expr(); need(']'); const addr = [...e.code, ...i.code, 0x41, 2, 0x74, 0x6a]; e = { code: [...addr, ...LOAD], lv: { addr } }; }
      else if (peek('++') || peek('--')) { const op = toks[p++].v[0]; e = { code: [...store(e, op, konst(1)), ...konst(1), op === '+' ? 0x6b : 0x6a] }; }
      else return e;
    }
  }

  function unary() {
    if (eat('-')) return { code: [...konst(0), ...unary().code, 0x6b] };
    if (eat('+')) return { code: unary().code };
    if (eat('!')) return { code: [...unary().code, 0x45] };
    if (eat('~')) return { code: [...unary().code, ...konst(-1), 0x73] };
    if (peek('++') || peek('--')) { const op = toks[p++].v[0]; return { code: store(unary(), op, konst(1)) }; }
    return postfix();
  }

  function binary(min) {
    let l = unary();
    for (;;) {
      const t = toks[p], pr = t && t.k === 'op' && PREC[t.v];
      if (!pr || pr < min) return l;
      p++;
      const r = binary(pr + 1).code;
      l = { code: t.v === '&&' ? [...l.code, 0x04, 0x7f, ...r, ...NZ, 0x05, ...konst(0), 0x0b]
                : t.v === '||' ? [...l.code, 0x04, 0x7f, ...konst(1), 0x05, ...r, ...NZ, 0x0b]
                : [...l.code, ...r, OP[t.v]] };
    }
  }

  function expr() {
    const l = binary(1), t = toks[p];
    if (eat('?')) { const a = expr(); need(':'); const b = expr(); return { code: [...l.code, 0x04, 0x7f, ...a.code, 0x05, ...b.code, 0x0b] }; }
    if (t && t.k === 'op' && /^(<<|>>|[-+*\/%&|^])?=$/.test(t.v)) { p++; return { code: store(l, t.v.slice(0, -1), expr().code) }; }
    return l;
  }

  // ---- statements. `depth` counts open wasm labels so break/continue know how far to branch.
  function stmt() {
    const t = toks[p];
    if (eat('{')) { scopes.push(new Map()); const c = []; while (!eat('}')) c.push(...stmt()); scopes.pop(); return c; }
    if (eat('int')) {
      const c = [];
      do {
        const nt = toks[p], name = ident();
        if (peek('[')) fail('local arrays are not supported, make it global', nt);
        const init = eat('=') ? expr().code : null, i = nlocals++;
        scopes[scopes.length - 1].set(name, i);
        if (init) c.push(...init, 0x21, ...uleb(i));
      } while (eat(','));
      need(';');
      return c;
    }
    if (eat('if')) {
      need('('); const c = expr().code; need(')');
      depth++; const a = stmt(), b = eat('else') ? stmt() : null; depth--;
      return [...c, 0x04, 0x40, ...a, ...(b ? [0x05, ...b] : []), 0x0b];
    }
    if (eat('while')) {
      need('('); const c = expr().code; need(')');
      depth += 2; loops.push({ brk: depth - 1, cont: depth }); const b = stmt(); loops.pop(); depth -= 2;
      return [0x02, 0x40, 0x03, 0x40, ...c, 0x45, 0x0d, 1, ...b, 0x0c, 0, 0x0b, 0x0b];
    }
    if (eat('for')) {
      need('('); scopes.push(new Map());
      const init = eat(';') ? [] : stmt();
      const c = peek(';') ? konst(1) : expr().code; need(';');
      const step = peek(')') ? [] : [...expr().code, 0x1a]; need(')');
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
    if (eat('return')) { const c = peek(';') ? konst(0) : expr().code; need(';'); return [...c, 0x0f]; }
    if (eat(';')) return [];
    const c = expr().code; need(';');
    return [...c, 0x1a];
  }

  // ---- top level
  while (p < toks.length) {
    if (!eat('int') && !eat('void')) fail("expected 'int' or 'void'");
    const t = toks[p], name = ident();
    if (eat('(')) {
      scopes = [new Map()];
      if (!eat(')')) {
        do {
          if (eat('void')) break;
          need('int'); scopes[0].set(ident(), scopes[0].size);
          if (eat('[')) need(']');
        } while (eat(','));
        need(')');
      }
      if (eat(';')) continue;                      // a prototype: calls are resolved at the end anyway
      if (funcs.has(name)) fail(`'${name}' is already defined`, t);
      fn = { idx: funcs.size, arity: scopes[0].size };
      funcs.set(name, fn);
      nlocals = fn.arity + 1; depth = 0; loops = [];
      if (!peek('{')) fail("expected '{'");
      fn.body = stmt(); fn.nlocals = nlocals;
    } else {
      const arr = eat('['), init = [];
      let n = arr ? 0 : 1;
      if (arr && !eat(']')) { n = cnum(); need(']'); }
      if (eat('=')) { if (arr) { need('{'); do init.push(cnum()); while (eat(',')); need('}'); } else init.push(cnum()); }
      n = Math.max(n, init.length);
      if (n < 1) fail('array needs a size', t);
      const addr = alloc(n, !init.length);
      init.forEach((v, i) => poke(addr + 4 * i, v));
      globals.set(name, { addr, arr });
      need(';');
    }
  }

  const main = funcs.get('main');
  if (!main || !main.body) throw new Error('no main() function');
  if (main.arity) throw new Error('main() takes no arguments');

  // ---- encode the module
  const user = [...funcs.values()].filter(f => f.body);
  const resolve = body => body.flatMap(b => {
    if (typeof b === 'number') return b;
    const f = funcs.get(b.call);
    if (!f) fail(`function '${b.call}' is not defined`, b.t);
    if (f.arity !== b.n) fail(`'${b.call}' takes ${f.arity} argument(s), got ${b.n}`, b.t);
    return [0x10, ...uleb(f.idx)];
  });
  const maxArity = Math.max(1, ...user.map(f => f.arity));
  const image = Array.from({ length: mem.length }, (_, i) => mem[i] | 0);
  return new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec(Array.from({ length: maxArity + 1 }, (_, n) => [0x60, ...vec(Array(n).fill([0x7f])), 1, 0x7f]))),  // type n = (i32 × n) -> i32
    ...section(2, vec([[...str('env'), ...str('putchar'), 0, 1]])),
    ...section(3, vec(user.map(f => uleb(f.arity)))),
    ...section(5, vec([[0, ...uleb(Math.ceil(btop / 65536))]])),
    ...section(7, vec([[...str('main'), 0, ...uleb(main.idx)], [...str('memory'), 2, 0]])),
    ...section(10, vec(user.map(f => {
      const body = [...vec([[...uleb(f.nlocals - f.arity), 0x7f]]), ...resolve(f.body), ...konst(0), 0x0b];
      return [...uleb(body.length), ...body];
    }))),
    ...(image.length ? section(11, vec([[0, 0x41, 0, 0x0b, ...uleb(image.length), ...image]])) : []),
  ]);
}

async function run(bytes) {
  let out = '';
  const { instance } = await WebAssembly.instantiate(bytes, { env: { putchar: c => { out += String.fromCharCode(c); return c; } } });
  // ponytail: runs on the calling thread, so an infinite loop hangs the tab. Move to a Worker if that matters.
  const ret = instance.exports.main();
  return { out, ret };
}

const api = { compile, run };
if (typeof module !== 'undefined') module.exports = api; else root.CC = api;
})(this);
