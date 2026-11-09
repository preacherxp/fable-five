// sql.js: an in-memory SQL engine in one file. No dependencies.
//
// Tokenizer, recursive-descent parser, expressions compiled to closures, three-valued NULL logic, hash joins,
// B+tree indexes with range scans and index joins, predicate pushdown, GROUP BY, window functions,
// subqueries (scalar, IN, EXISTS, derived tables, correlated), CTEs including WITH RECURSIVE, UNION,
// INSERT / UPDATE / DELETE, and a plan that says what it did.
//
// Not supported: transactions, multi-column or unique indexes, ROWS BETWEEN window frames, RIGHT/FULL joins,
// ALTER TABLE, column types (values are numbers, strings and NULL).
(function (root) {
'use strict';

const KW = new Set(('SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN LEFT INNER ON AS AND OR NOT IN IS NULL LIKE ASC DESC CREATE TABLE INSERT INTO VALUES DISTINCT ' +
  'WITH RECURSIVE UNION ALL OVER PARTITION EXISTS CASE WHEN THEN ELSE END BETWEEN UPDATE SET DELETE INDEX DROP EXPLAIN').split(' '));
const AGG = new Set(['count', 'sum', 'avg', 'min', 'max']), WIN = new Set(['row_number', 'rank', 'dense_rank', 'lag', 'lead']);
const FLIP = { '=': '=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
const truthy = v => v != null && v !== false && v !== 0;
// One total order for <, ORDER BY, MIN/MAX and index keys: numbers sort before strings, as in SQLite.
const cmpV = (a, b) => { const s = typeof a === 'string', t = typeof b === 'string'; return s !== t ? (s ? 1 : -1) : a < b ? -1 : a > b ? 1 : 0; };
const cmpKeys = (a, b, order) => {                 // sort keys with NULLs first, honouring DESC per key
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    const c = x == null ? -1 : y == null ? 1 : cmpV(x, y);
    if (c) return order[i].desc ? -c : c;
  }
  return 0;
};
const walk = (e, f) => {                           // visits every node of an expression, without entering subqueries
  if (!e || typeof e !== 'object') return;
  if (Array.isArray(e)) return e.forEach(x => walk(x, f));
  f(e);
  for (const k in e) if (k !== 'q') walk(e[k], f);
};

// B+tree. Keys are unique [value, rowid] pairs, so duplicates of a value are just neighbours.
// Nodes hold at most ORDER keys and (except the root) at least ORDER/2; leaves are linked for range scans.
function BTree(ORDER = 32) {
  const MIN = ORDER >> 1, cmp = (a, b) => cmpV(a[0], b[0]) || a[1] - b[1];
  let root = { keys: [], vals: [], next: null };   // a node with `kids` is internal
  const bound = (keys, k, upper) => {              // first index whose key is >= k (or > k with `upper`)
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = lo + hi >> 1, c = cmp(keys[m], k); if (c < 0 || (upper && c === 0)) lo = m + 1; else hi = m; }
    return lo;
  };
  function ins(n, k, v) {                          // returns [separator, new right sibling] when n had to split
    if (n.kids) { const i = bound(n.keys, k, true), s = ins(n.kids[i], k, v); if (s) { n.keys.splice(i, 0, s[0]); n.kids.splice(i + 1, 0, s[1]); } }
    else { const i = bound(n.keys, k); n.keys.splice(i, 0, k); n.vals.splice(i, 0, v); }
    if (n.keys.length <= ORDER) return null;
    const mid = n.keys.length >> 1;
    if (n.kids) { const right = { keys: n.keys.splice(mid + 1), kids: n.kids.splice(mid + 1) }; return [n.keys.pop(), right]; }
    const right = { keys: n.keys.splice(mid), vals: n.vals.splice(mid), next: n.next };
    n.next = right;
    return [right.keys[0], right];
  }
  function del(n, k) {
    if (!n.kids) { const i = bound(n.keys, k); if (i === n.keys.length || cmp(n.keys[i], k)) return false; n.keys.splice(i, 1); n.vals.splice(i, 1); return true; }
    const i = bound(n.keys, k, true), c = n.kids[i];
    if (!del(c, k)) return false;
    if (c.keys.length >= MIN) return true;
    const L = n.kids[i - 1], R = n.kids[i + 1];
    if (L && L.keys.length > MIN) {                // borrow from the left sibling
      if (c.kids) { c.keys.unshift(n.keys[i - 1]); n.keys[i - 1] = L.keys.pop(); c.kids.unshift(L.kids.pop()); }
      else { c.keys.unshift(L.keys.pop()); c.vals.unshift(L.vals.pop()); n.keys[i - 1] = c.keys[0]; }
    } else if (R && R.keys.length > MIN) {         // borrow from the right sibling
      if (c.kids) { c.keys.push(n.keys[i]); n.keys[i] = R.keys.shift(); c.kids.push(R.kids.shift()); }
      else { c.keys.push(R.keys.shift()); c.vals.push(R.vals.shift()); n.keys[i] = R.keys[0]; }
    } else {                                       // merge with a sibling
      const j = L ? i - 1 : i, a = n.kids[j], b = n.kids[j + 1];
      if (a.kids) { a.keys.push(n.keys[j], ...b.keys); a.kids.push(...b.kids); }
      else { a.keys.push(...b.keys); a.vals.push(...b.vals); a.next = b.next; }
      n.keys.splice(j, 1); n.kids.splice(j + 1, 1);
    }
    return true;
  }
  return {
    ORDER, MIN, get root() { return root; },
    insert(k, v) { const s = ins(root, k, v); if (s) root = { keys: [s[0]], kids: [root, s[1]] }; },
    remove(k) { const ok = del(root, k); if (root.kids && !root.keys.length) root = root.kids[0]; return ok; },
    range(lo, loInc, hi, hiInc) {                  // values with lo <(=) key <(=) hi, in key order; undefined = unbounded
      const out = [], from = lo === undefined ? null : [lo, loInc ? -Infinity : Infinity];
      let n = root;
      while (n.kids) n = n.kids[from ? bound(n.keys, from, true) : 0];
      for (let i = from ? bound(n.keys, from) : 0; n; n = n.next, i = 0)
        for (; i < n.keys.length; i++) {
          if (hi !== undefined) { const c = cmpV(n.keys[i][0], hi); if (c > 0 || (c === 0 && !hiInc)) return out; }
          out.push(n.vals[i]);
        }
      return out;
    },
  };
}

function lex(s) {
  const re = /\s+|--.*|(\d+\.?\d*)|'((?:[^']|'')*)'|([A-Za-z_]\w*)|(<=|>=|<>|!=|\|\||[-+*\/%=<>(),.;])/y, out = [];
  while (re.lastIndex < s.length) {
    const at = re.lastIndex, m = re.exec(s);
    if (!m) throw new Error(`unexpected '${s[at]}' at position ${at}`);
    if (m[1] !== undefined) out.push({ k: 'num', v: +m[1] });
    else if (m[2] !== undefined) out.push({ k: 'str', v: m[2].replace(/''/g, "'") });
    else if (m[3] !== undefined) { const u = m[3].toUpperCase(); out.push(KW.has(u) ? { k: 'kw', v: u } : { k: 'id', v: m[3].toLowerCase() }); }
    else if (m[4] !== undefined) out.push({ k: 'op', v: m[4] });
  }
  return out;
}

function parse(sql) {
  const toks = lex(sql); let p = 0;
  const fail = msg => { throw new Error(`${msg} near '${toks[p] ? toks[p].v : 'end of input'}'`); };
  const is = v => !!toks[p] && (toks[p].k === 'kw' || toks[p].k === 'op') && toks[p].v === v;
  const eat = v => is(v) && !!++p;
  const need = v => eat(v) || fail(`expected ${v}`);
  const isId = () => !!toks[p] && toks[p].k === 'id';
  const id = () => isId() ? toks[p++].v : fail('expected a name');
  const num = () => toks[p] && toks[p].k === 'num' ? toks[p++].v : fail('expected a number');
  const list = item => { const out = [item()]; while (eat(',')) out.push(item()); return out; };
  const left = (next, ops) => () => { let l = next(); while (toks[p] && toks[p].k !== 'str' && ops.includes(toks[p].v)) l = { t: 'bin', op: toks[p++].v, a: l, b: next() }; return l; };
  const isQuery = () => is('SELECT') || is('WITH');
  const orderItem = () => { const e = expr(), desc = eat('DESC'); if (!desc) eat('ASC'); return { e, desc }; };

  function prim() {
    const t = toks[p++];
    if (!t) { p--; fail('unexpected end'); }
    if (t.k === 'num' || t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'kw' && t.v === 'NULL') return { t: 'lit', v: null };
    if (t.k === 'kw' && t.v === 'EXISTS') { need('('); const q = query(); need(')'); return { t: 'exists', q }; }
    if (t.k === 'kw' && t.v === 'CASE') {
      const operand = is('WHEN') ? null : expr(), whens = [];
      while (eat('WHEN')) { const w = expr(); need('THEN'); whens.push([w, expr()]); }
      const other = eat('ELSE') ? expr() : null;
      need('END');
      return { t: 'case', operand, whens, other };
    }
    if (t.k === 'op' && t.v === '(') { const e = isQuery() ? { t: 'sub', q: query() } : expr(); need(')'); return e; }
    if (t.k === 'op' && t.v === '-') return { t: 'neg', e: prim() };
    if (t.k === 'id') {
      if (eat('(')) {
        let fn;
        if (eat('*')) fn = { t: 'fn', name: t.v, star: true, args: [] };
        else { const distinct = eat('DISTINCT'); fn = { t: 'fn', name: t.v, args: is(')') ? [] : list(expr), distinct }; }
        need(')');
        if (!eat('OVER')) return fn;
        need('(');
        const part = eat('PARTITION') ? (need('BY'), list(expr)) : [], order = eat('ORDER') ? (need('BY'), list(orderItem)) : [];
        need(')');
        return { t: 'win', fn, part, order };
      }
      return eat('.') ? { t: 'col', tbl: t.v, name: id() } : { t: 'col', name: t.v };
    }
    p--; fail('unexpected token');
  }
  const mul = left(prim, ['*', '/', '%']), sum = left(mul, ['+', '-', '||']);
  function cmp() {
    let l = sum();
    for (;;) {
      const t = toks[p];
      if (t && t.k === 'op' && FLIP[t.v] || t && t.k === 'op' && (t.v === '<>' || t.v === '!=')) { p++; l = { t: 'bin', op: t.v, a: l, b: sum() }; continue; }
      if (eat('IS')) { const not = eat('NOT'); need('NULL'); l = { t: 'isnull', e: l, not }; continue; }
      const save = p, not = eat('NOT'), wrap = e => not ? { t: 'not', e } : e;
      if (eat('LIKE')) l = wrap({ t: 'bin', op: 'LIKE', a: l, b: sum() });
      else if (eat('BETWEEN')) { const lo = sum(); need('AND'); l = wrap({ t: 'bin', op: 'AND', a: { t: 'bin', op: '>=', a: l, b: lo }, b: { t: 'bin', op: '<=', a: l, b: sum() } }); }
      else if (eat('IN')) { need('('); l = wrap(isQuery() ? { t: 'in', e: l, q: query() } : { t: 'in', e: l, list: list(expr) }); need(')'); }
      else { p = save; return l; }
    }
  }
  const not = () => eat('NOT') ? { t: 'not', e: not() } : cmp();
  const and = left(not, ['AND']), expr = left(and, ['OR']);

  const tableRef = () => {
    if (eat('(')) { const q = query(); need(')'); eat('AS'); return { q, table: '(subquery)', alias: id() }; }
    const table = id();
    return { table, alias: eat('AS') ? id() : isId() ? id() : table };
  };

  function selectCore() {
    need('SELECT');
    const q = { t: 'select', distinct: eat('DISTINCT'), joins: [] };
    q.items = list(() => {
      if (eat('*')) return { star: true };
      if (isId() && toks[p + 1] && toks[p + 1].v === '.' && toks[p + 2] && toks[p + 2].k === 'op' && toks[p + 2].v === '*') { p += 3; return { star: true, tbl: toks[p - 3].v }; }
      const e = expr();
      return { e, as: eat('AS') ? id() : isId() ? id() : null };
    });
    if (eat('FROM')) {
      q.from = tableRef();
      for (;;) {
        const lj = eat('LEFT'); if (!lj) eat('INNER');
        if (!eat('JOIN')) { if (lj) fail('expected JOIN'); break; }
        const ref = tableRef(); need('ON');
        q.joins.push({ ...ref, left: lj, on: expr() });
      }
    }
    if (eat('WHERE')) q.where = expr();
    if (eat('GROUP')) { need('BY'); q.group = list(expr); }
    if (eat('HAVING')) q.having = expr();
    return q;
  }

  // [WITH ...] select [UNION [ALL] select]... [ORDER BY ...] [LIMIT n] [OFFSET n]
  function query() {
    let withs = null, recursive = false;
    if (eat('WITH')) {
      recursive = eat('RECURSIVE');
      withs = list(() => { const name = id(); let cols = null; if (eat('(')) { cols = list(id); need(')'); } need('AS'); need('('); const q = query(); need(')'); return { name, cols, q }; });
    }
    const parts = [selectCore()], all = [];
    while (eat('UNION')) { all.push(eat('ALL')); parts.push(selectCore()); }
    const q = parts.length > 1 ? { t: 'union', parts, all } : parts[0];
    if (eat('ORDER')) { need('BY'); q.order = list(orderItem); }
    if (eat('LIMIT')) q.limit = num();
    if (eat('OFFSET')) q.offset = num();
    if (withs) { q.with = withs; q.recursive = recursive; }
    return q;
  }

  function statement() {
    if (eat('CREATE')) {
      if (eat('INDEX')) { const name = id(); need('ON'); const table = id(); need('('); const col = id(); need(')'); return { t: 'index', name, table, col }; }
      need('TABLE'); const table = id(); need('(');
      const cols = list(() => {                    // column types are accepted and ignored
        const col = id(); let depth = 0;
        while (toks[p] && (depth || (!is(',') && !is(')')))) { if (is('(')) depth++; else if (is(')')) depth--; p++; }
        return col;
      });
      need(')');
      return { t: 'create', table, cols };
    }
    if (eat('INSERT')) {
      need('INTO'); const table = id(); let cols = null;
      if (eat('(')) { cols = list(id); need(')'); }
      if (isQuery()) return { t: 'insert', table, cols, q: query() };
      need('VALUES');
      return { t: 'insert', table, cols, rows: list(() => { need('('); const r = list(expr); need(')'); return r; }) };
    }
    if (eat('UPDATE')) { const table = id(); need('SET'); const sets = list(() => { const col = id(); need('='); return [col, expr()]; }); return { t: 'update', table, sets, where: eat('WHERE') ? expr() : null }; }
    if (eat('DELETE')) { need('FROM'); const table = id(); return { t: 'delete', table, where: eat('WHERE') ? expr() : null }; }
    if (eat('DROP')) { need('TABLE'); return { t: 'drop', table: id() }; }
    if (eat('EXPLAIN')) return { t: 'explain', q: query() };
    return query();
  }

  const out = [];
  while (p < toks.length) { if (eat(';')) continue; out.push(statement()); if (p < toks.length) need(';'); }
  return out;
}

// Prints an expression back as SQL, with parentheses only where precedence needs them.
const PREC = { OR: 1, AND: 2, '+': 4, '-': 4, '||': 4, '*': 5, '/': 5, '%': 5 };   // comparisons are 3
const prec = e => e.t === 'bin' ? PREC[e.op] || 3 : 9;
const wrap = (e, min) => prec(e) < min ? `(${show(e)})` : show(e);
const showOrder = o => o.map(x => show(x.e) + (x.desc ? ' DESC' : '')).join(', ');
const show = e =>
  e.t === 'lit' ? (typeof e.v === 'string' ? `'${e.v}'` : e.v === null ? 'NULL' : String(e.v))
  : e.t === 'col' ? (e.tbl ? e.tbl + '.' : '') + e.name
  : e.t === 'bin' ? `${wrap(e.a, prec(e))} ${e.op} ${wrap(e.b, prec(e) + 1)}`
  : e.t === 'fn' ? `${e.name}(${e.star ? '*' : (e.distinct ? 'DISTINCT ' : '') + e.args.map(show).join(', ')})`
  : e.t === 'win' ? `${show(e.fn)} OVER (${[e.part.length ? 'PARTITION BY ' + e.part.map(show).join(', ') : '', e.order.length ? 'ORDER BY ' + showOrder(e.order) : ''].filter(Boolean).join(' ')})`
  : e.t === 'neg' ? `-${wrap(e.e, 6)}`
  : e.t === 'not' ? `NOT ${wrap(e.e, 3)}`
  : e.t === 'isnull' ? `${wrap(e.e, 4)} IS ${e.not ? 'NOT ' : ''}NULL`
  : e.t === 'sub' ? '(subquery)'
  : e.t === 'exists' ? 'EXISTS (subquery)'
  : e.t === 'case' ? 'CASE ... END'
  : `${wrap(e.e, 4)} IN (${e.q ? 'subquery' : e.list.map(show).join(', ')})`;

// Does an expression aggregate over the group? A window call does not, but its arguments might: SUM(SUM(x)) OVER ().
const hasAgg = e => !!e && typeof e === 'object' && (Array.isArray(e) ? e.some(hasAgg)
  : e.t === 'win' ? hasAgg(e.fn.args) || hasAgg(e.part) || hasAgg(e.order)
  : (e.t === 'fn' && AGG.has(e.name)) || Object.keys(e).some(k => k !== 'q' && hasAgg(e[k])));

const likes = new Map();
const like = (s, pat) => {
  let re = likes.get(pat);
  if (!re) likes.set(pat, re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$', 'i'));
  return re.test(String(s));
};
const BIN = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => b === 0 ? null : a / b, '%': (a, b) => b === 0 ? null : a % b,
  '||': (a, b) => String(a) + String(b), '=': (a, b) => a === b, '<>': (a, b) => a !== b, '!=': (a, b) => a !== b,
  '<': (a, b) => cmpV(a, b) < 0, '>': (a, b) => cmpV(a, b) > 0, '<=': (a, b) => cmpV(a, b) <= 0, '>=': (a, b) => cmpV(a, b) >= 0, LIKE: like,
};
const FN = {
  upper: s => s == null ? null : String(s).toUpperCase(), lower: s => s == null ? null : String(s).toLowerCase(),
  length: s => s == null ? null : String(s).length, abs: n => n == null ? null : Math.abs(n),
  substr: (s, i, n) => s == null ? null : String(s).slice(i - 1, n == null ? undefined : i - 1 + n),
  round: (n, d = 0) => n == null ? null : Math.round(n * 10 ** d) / 10 ** d,
  coalesce: (...a) => a.find(v => v != null) ?? null,
};

// An aggregate over `vals`, one value per row of the group or window frame (the rows themselves for COUNT(*)).
function fold(e, vals) {
  if (e.star) return vals.length;
  let v = vals.filter(x => x != null);
  if (e.distinct) v = [...new Set(v)];
  if (e.name === 'count') return v.length;
  if (!v.length) return null;
  if (e.name === 'sum' || e.name === 'avg') { const s = v.reduce((a, b) => a + b, 0); return e.name === 'sum' ? s : s / v.length; }
  return v.reduce((a, b) => (cmpV(b, a) < 0) === (e.name === 'min') ? b : a);
}

function Database() {
  const tables = new Map();
  const table = name => tables.get(name) || (() => { throw new Error(`no such table: ${name}`); })();
  const bucket = (m, k) => m.get(k) || m.set(k, []).get(k);
  const indent = lines => lines.map(l => '  ' + l);
  // A scope is one query level: its schema S ([{ tbl, name }]), the row being evaluated, and the enclosing level.
  const newScope = (S, parent) => ({ S, parent, row: null, subs: new Map() });
  const tryComp = (e, S) => { try { return comp(e, S, newScope(S)); } catch { return null; } };
  const distinct = (rows, key = r => r, seen = new Set()) => rows.filter(r => { const k = JSON.stringify(key(r)); return !seen.has(k) && seen.add(k); });
  const limit = (q, rows, plan) => {
    if (q.limit == null && !q.offset) return rows;
    const o = q.offset || 0;
    plan.push(`Limit ${q.limit ?? 'all'}${o ? ' offset ' + o : ''}`);
    return rows.slice(o, q.limit != null ? o + q.limit : undefined);
  };

  // Runs the subquery of node `e` for the outer row. Uncorrelated subqueries run once and are cached.
  function subq(e, S, scope) {
    const info = scope.subs.get(e) || scope.subs.set(e, { runs: 0 }).get(e);
    let cache;
    return r => {
      if (cache) return cache;
      scope.S = S; scope.row = r;
      const top = { parent: scope, S: [] }, res = query(e.q, top);
      if (!info.runs++) info.plan = res.plan;
      info.outer = top.outer;
      if (!top.outer) cache = res;
      return res;
    };
  }

  // Compiles an expression against a schema into (row, group) => value. Columns not found in S are looked up
  // in the enclosing queries, which is what makes a subquery correlated.
  function comp(e, S, scope) {
    const c = x => comp(x, S, scope);
    switch (e.t) {
      case 'lit': return () => e.v;
      case 'col': {
        const find = sch => {
          const hits = sch.flatMap((s, i) => s.name === e.name && (!e.tbl || s.tbl === e.tbl) ? [i] : []);
          if (hits.length > 1) throw new Error(`ambiguous column: ${show(e)}`);
          return hits[0];
        };
        const i = find(S);
        if (i !== undefined) return r => r[i];
        for (let a = scope.parent, path = [scope]; a; path.push(a), a = a.parent) {
          const j = find(a.S);
          if (j !== undefined) { path.forEach(s => { s.outer = true; }); return () => a.row[j]; }
        }
        throw new Error(`no such column: ${show(e)}`);
      }
      case 'neg': { const f = c(e.e); return (r, g) => { const v = f(r, g); return v == null ? null : -v; }; }
      case 'not': { const f = c(e.e); return (r, g) => { const v = f(r, g); return v == null ? null : !truthy(v); }; }
      case 'isnull': { const f = c(e.e); return (r, g) => (f(r, g) == null) !== e.not; }
      case 'in': {                                 // NULL if the value is NULL, or if it is not found and the list has a NULL
        const f = c(e.e), L = e.q ? null : e.list.map(c), sq = e.q && subq(e, S, scope);
        return (r, g) => {
          const v = f(r, g);
          if (v == null) return null;
          const vals = sq ? sq(r).rows.map(x => x[0]) : L.map(l => l(r, g));   // ponytail: linear scan per row, hash the list if IN lists get large
          return vals.includes(v) ? true : vals.includes(null) ? null : false;
        };
      }
      case 'sub': { const f = subq(e, S, scope); return r => { const rows = f(r).rows; if (rows.length > 1) throw new Error('scalar subquery returned more than one row'); return rows.length ? rows[0][0] : null; }; }
      case 'exists': { const f = subq(e, S, scope); return r => f(r).rows.length > 0; }
      case 'case': {
        const op = e.operand && c(e.operand), W = e.whens.map(([w, t]) => [c(w), c(t)]), other = e.other ? c(e.other) : () => null;
        return (r, g) => { const v = op && op(r, g); for (const [w, t] of W) { const x = w(r, g); if (op ? v != null && x === v : truthy(x)) return t(r, g); } return other(r, g); };
      }
      case 'win': return r => { const m = scope.win && scope.win.get(e); if (!m) throw new Error('window functions are only allowed in SELECT and ORDER BY'); return m.get(r); };
      case 'bin': {
        const a = c(e.a), b = c(e.b), f = BIN[e.op];
        // SQL three-valued logic: NULL AND FALSE is FALSE, NULL OR TRUE is TRUE, otherwise NULL wins.
        if (e.op === 'AND') return (r, g) => { const x = a(r, g), y = b(r, g); return (x != null && !truthy(x)) || (y != null && !truthy(y)) ? false : x == null || y == null ? null : true; };
        if (e.op === 'OR') return (r, g) => { const x = a(r, g), y = b(r, g); return truthy(x) || truthy(y) ? true : x == null || y == null ? null : false; };
        return (r, g) => { const x = a(r, g), y = b(r, g); return x == null || y == null ? null : f(x, y); };
      }
      case 'fn': {
        if (AGG.has(e.name)) {
          const f = e.star ? null : c(e.args[0]);
          return (r, g) => { if (!g) throw new Error(`${e.name}() needs a grouped query`); return fold(e, e.star ? g : g.map(x => f(x))); };
        }
        if (WIN.has(e.name)) throw new Error(`${e.name}() needs an OVER clause`);
        const f = FN[e.name], A = e.args.map(c);
        if (!f) throw new Error(`no such function: ${e.name}`);
        return (r, g) => f(...A.map(a => a(r, g)));
      }
    }
  }

  // Evaluates every window call over the result units ([row, group]) and stores value-per-row in scope.win.
  function windows(nodes, units, scope, plan) {
    scope.win = new Map();
    for (const w of nodes) {
      const c = e => comp(e, scope.S, scope), name = w.fn.name, part = w.part.map(c), ord = w.order.map(o => c(o.e)), args = w.fn.args.map(c);
      if (!AGG.has(name) && !WIN.has(name)) throw new Error(`${name}() is not a window function`);
      const out = new Map(), parts = new Map();
      for (const u of units) bucket(parts, JSON.stringify(part.map(f => f(u[0], u[1])))).push(u);
      for (const us of parts.values()) {
        const rows = us.map(u => ({ u, k: ord.map(f => f(u[0], u[1])), v: args[0] ? args[0](u[0], u[1]) : null }));
        rows.sort((a, b) => cmpKeys(a.k, b.k, w.order));
        for (let i = 0, dense = 1; i < rows.length; dense++) {
          let j = i + 1;                           // rows [i, j) are peers: equal ORDER BY keys, or the whole partition without ORDER BY
          while (j < rows.length && !cmpKeys(rows[i].k, rows[j].k, w.order)) j++;
          // Default frame: from the start of the partition through the last peer of the current row.
          // ponytail: refolds the frame for every peer group, O(n²) per partition; keep running state if partitions get big.
          const agg = AGG.has(name) ? fold(w.fn, w.fn.star ? rows.slice(0, j) : rows.slice(0, j).map(x => x.v)) : null;
          for (let n = i; n < j; n++) {
            const [r, g] = rows[n].u;
            let val = agg;
            if (name === 'row_number') val = n + 1;
            else if (name === 'rank') val = i + 1;
            else if (name === 'dense_rank') val = dense;
            else if (WIN.has(name)) { const off = args[1] ? args[1](r, g) : 1, t = rows[n + (name === 'lead' ? off : -off)]; val = t ? t.v : args[2] ? args[2](r, g) : null; }
            out.set(r, val);
          }
          i = j;
        }
      }
      scope.win.set(w, out);
      plan.push(`Window ${show(w)}`);
    }
  }

  function source(ref, env) {                      // a FROM item: derived table, CTE or stored table
    if (ref.q) { const r = query(ref.q, env); return { name: ref.alias, cols: r.columns, rows: r.rows, plan: [`Subquery ${ref.alias}`, ...indent(r.plan)] }; }
    for (let s = env; s; s = s.parent) if (s.ctes && s.ctes.has(ref.table)) return { name: ref.table, ...s.ctes.get(ref.table), plan: [] };
    const t = table(ref.table);
    return { name: ref.table, cols: t.cols, rows: t.rows, table: t, plan: [] };
  }

  function select(q, parent) {
    const scope = newScope([], parent), plan = [], c = (e, S = scope.S) => comp(e, S, scope);
    const conj = e => !e ? [] : e.t === 'bin' && e.op === 'AND' ? [...conj(e.a), ...conj(e.b)] : [e];
    const and = es => es.reduce((a, b) => ({ t: 'bin', op: 'AND', a, b }));
    const srcs = (q.from ? [q.from, ...q.joins] : []).map((ref, k) => { const it = source(ref, parent); it.S = it.cols.map(name => ({ tbl: ref.alias, name, k })); return it; });
    const all = srcs.flatMap(it => it.S);
    // Which FROM items does an expression read? null if it contains a subquery, -1 marks an ambiguous name.
    const reads = e => {
      const ks = new Set(); let sub = false;
      walk(e, n => {
        if (n.q) sub = true;
        if (n.t === 'col') { const hits = all.filter(s => s.name === n.name && (!n.tbl || s.tbl === n.tbl)); if (hits.length) ks.add(hits.length > 1 ? -1 : hits[0].k); }
      });
      return sub ? null : ks;
    };
    // Predicate pushdown: a WHERE conjunct that reads one table is applied before the joins
    // (but not to the nullable side of a LEFT JOIN, where it has to see the padded rows).
    const pushed = srcs.map(() => []), rest = [];
    for (const e of conj(q.where)) { const ks = reads(e), k = ks && ks.size === 1 ? [...ks][0] : -1; (k >= 0 && !(k && q.joins[k - 1].left) ? pushed[k] : rest).push(e); }

    // Rows of FROM item k after its pushed-down conjuncts, through an index when one fits.
    function scan(k) {
      const it = srcs[k]; let rows = it.rows, conds = pushed[k];
      plan.push(...it.plan);
      const sarg = conds.map(e => {                // column <op> value, where value reads none of this query's tables
        if (e.t === 'bin' && FLIP[e.op]) for (const [col, val, op] of [[e.a, e.b, e.op], [e.b, e.a, FLIP[e.op]]]) {
          const rv = reads(val);
          if (col.t === 'col' && rv && !rv.size && reads(col).has(k)) return { e, col: col.name, op, val, f: c(val, []) };
        }
      });
      const ix = it.table && it.table.indexes.map(ix => ({ tree: ix.tree, use: sarg.filter(s => s && s.col === it.table.cols[ix.col]) }))
        .filter(x => x.use.length).sort((a, b) => b.use.some(s => s.op === '=') - a.use.some(s => s.op === '='))[0];
      if (ix) {
        let lo, hi, empty = false;                 // the tightest bounds over all conjuncts on the indexed column
        for (const s of ix.use) {
          const v = s.f(), up = s.op === '=' || s.op === '>' || s.op === '>=', down = s.op === '=' || s.op === '<' || s.op === '<=';
          if (v == null) { empty = true; continue; }
          if (up && (!lo || cmpV(v, lo.v) > 0 || (!cmpV(v, lo.v) && s.op === '>'))) lo = { v, inc: s.op !== '>', e: s.val };
          if (down && (!hi || cmpV(v, hi.v) < 0 || (!cmpV(v, hi.v) && s.op === '<'))) hi = { v, inc: s.op !== '<', e: s.val };
        }
        rows = empty ? [] : ix.tree.range(lo && lo.v, lo && lo.inc, hi && hi.v, hi && hi.inc);
        const col = ix.use[0].col, eq = ix.use.find(s => s.op === '=');
        const what = eq ? `${col} = ${show(eq.val)}` : `${lo ? show(lo.e) + (lo.inc ? ' <= ' : ' < ') : ''}${col}${hi ? (hi.inc ? ' <= ' : ' < ') + show(hi.e) : ''}`;
        plan.push(`IndexScan ${it.name}: ${what} (${rows.length} of ${it.rows.length} rows)`);
        conds = conds.filter(e => !ix.use.some(s => s.e === e));
      } else if (!k || conds.length || it.plan.length) plan.push(`Scan ${it.name} (${rows.length} rows)`);
      if (conds.length) { const f = c(and(conds), it.S), n = rows.length; rows = rows.filter(r => truthy(f(r))); plan.push(`Filter ${show(and(conds))} (${n} → ${rows.length} rows)`); }
      return rows;
    }

    let S = [], rows = [[]];
    if (srcs.length) { S = srcs[0].S; rows = scan(0); }
    q.joins.forEach((j, n) => {
      const k = n + 1, it = srcs[k], both = [...S, ...it.S], pad = it.S.map(() => null), out = [], kind = j.left ? 'Left ' : '';
      const emit = (l, m) => { if (m && m.length) for (const r of m) out.push([...l, ...r]); else if (j.left) out.push([...l, ...pad]); };
      // An equality between one expression per side can be hashed or probed; anything else is a nested loop.
      const eq = j.on.t === 'bin' && j.on.op === '=' && [[j.on.a, j.on.b], [j.on.b, j.on.a]].map(([l, r]) => [tryComp(l, S), tryComp(r, it.S), r]).find(([l, r]) => l && r);
      const ix = eq && it.table && !pushed[k].length && eq[2].t === 'col' && it.table.indexes.find(x => it.table.cols[x.col] === eq[2].name);
      if (ix && rows.length * Math.log2(it.rows.length + 2) < it.rows.length) {   // few outer rows: probing the index beats hashing the whole table
        for (const l of rows) { const v = eq[0](l); emit(l, v == null ? null : ix.tree.range(v, true, v, true)); }
        plan.push(`${kind}IndexNestedLoopJoin ${it.name} (${it.rows.length} rows) on ${show(j.on)}`);
      } else {
        const right = scan(k);
        if (eq) {
          const h = new Map();
          for (const r of right) { const key = eq[1](r); if (key != null) bucket(h, key).push(r); }
          for (const l of rows) emit(l, h.get(eq[0](l)));
          plan.push(`${kind}HashJoin ${it.name} (${right.length} rows) on ${show(j.on)}`);
        } else {
          const on = c(j.on, both);
          for (const l of rows) emit(l, right.filter(r => truthy(on([...l, ...r]))));
          plan.push(`${kind}NestedLoopJoin ${it.name} (${right.length} rows) on ${show(j.on)}`);
        }
      }
      S = both; rows = out;
    });
    scope.S = S;
    if (rest.length) { const f = c(and(rest)), n = rows.length; rows = rows.filter(r => truthy(f(r))); plan.push(`Filter ${show(and(rest))} (${n} → ${rows.length} rows)`); }

    const items = q.items.flatMap(it => it.star ? S.filter(s => !it.tbl || s.tbl === it.tbl).map(s => ({ e: { t: 'col', tbl: s.tbl, name: s.name }, as: s.name })) : [it]);
    const names = items.map(it => it.as || (it.e.t === 'col' ? it.e.name : show(it.e)));
    let units;                                     // [representative row, group rows]
    if (q.group || items.some(it => hasAgg(it.e)) || hasAgg(q.having) || hasAgg(q.order)) {
      const keys = (q.group || []).map(e => c(e)), m = new Map();
      for (const r of rows) bucket(m, JSON.stringify(keys.map(f => f(r)))).push(r);
      if (!q.group && !m.size) m.set('', []);      // an aggregate over no rows still returns one row
      units = [...m.values()].map(g => [g[0] || S.map(() => null), g]);
      plan.push(`Aggregate${q.group ? ' by ' + q.group.map(show).join(', ') : ''} (${units.length} groups)`);
    } else units = rows.map(r => [r]);
    if (q.having) { const f = c(q.having); units = units.filter(([r, g]) => truthy(f(r, g))); plan.push(`Having ${show(q.having)} (${units.length} groups)`); }

    const wins = [];
    walk([items.map(it => it.e), q.order], n => { if (n.t === 'win') wins.push(n); });
    if (wins.length) windows(wins, units, scope, plan);

    const proj = items.map(it => c(it.e));
    let out = units.map(([r, g]) => ({ v: proj.map(f => f(r, g)), r, g }));
    if (q.distinct) { out = distinct(out, o => o.v); plan.push('Distinct'); }
    if (q.order) {
      const keys = q.order.map(o => {              // an output alias, a column number, or any expression
        const i = o.e.t === 'col' && !o.e.tbl ? names.indexOf(o.e.name) : o.e.t === 'lit' && Number.isInteger(o.e.v) ? o.e.v - 1 : -1;
        if (i >= 0 && i < names.length) return x => x.v[i];
        const f = c(o.e); return x => f(x.r, x.g);
      });
      for (const o of out) o.k = keys.map(f => f(o));
      out.sort((a, b) => cmpKeys(a.k, b.k, q.order));
      plan.push(`Sort by ${showOrder(q.order)}`);
    }
    out = limit(q, out, plan);
    for (const s of scope.subs.values()) if (s.runs) plan.push(s.outer ? `Subquery (correlated, ${s.runs} runs, first shown)` : 'Subquery (run once)', ...indent(s.plan));
    return { columns: names, rows: out.map(o => o.v), plan };
  }

  // A full query: CTEs, then one SELECT or a UNION chain. `parent` is the enclosing query's scope, if any.
  function query(q, parent) {
    let env = parent, res; const plan = [];
    if (q.with) {
      env = { parent, S: [], ctes: new Map() };
      for (const w of q.with) {
        // ponytail: self-reference is detected in the serialized AST; a string literal spelling "table":"name" would fool it.
        const rec = q.recursive && w.q.t === 'union' && JSON.stringify(w.q.parts.slice(1)).includes(`"table":"${w.name}"`);
        let r, n = 0;
        if (!rec) r = query(w.q, env);
        else {                                     // semi-naive evaluation: each round only sees the rows the previous round added
          r = select(w.q.parts[0], env);
          const seen = !w.q.all[0] && new Set(), fresh = rows => seen ? distinct(rows, undefined, seen) : rows, cols = w.cols || r.columns;
          let work = r.rows = fresh(r.rows);
          while (work.length) {
            if (++n > 10000 || r.rows.length > 1e6) throw new Error(`recursive CTE ${w.name} did not terminate (gave up after ${n - 1} rounds, ${r.rows.length} rows)`);
            env.ctes.set(w.name, { cols, rows: work });
            work = fresh(w.q.parts.slice(1).flatMap(p => select(p, env).rows));
            r.rows = r.rows.concat(work);
          }
        }
        if (w.cols && w.cols.length !== r.columns.length) throw new Error(`CTE ${w.name} has ${r.columns.length} columns but ${w.cols.length} names`);
        env.ctes.set(w.name, { cols: w.cols || r.columns, rows: r.rows });
        plan.push(`CTE ${w.name}${rec ? ` (recursive, ${n} rounds, ${r.rows.length} rows)` : ''}`, ...indent(r.plan));
      }
    }
    if (q.t !== 'union') res = select(q, env);
    else {
      const parts = q.parts.map(p => select(p, env));
      let rows = parts[0].rows;
      parts.forEach((r, i) => {
        if (r.columns.length !== parts[0].columns.length) throw new Error('UNION parts have different numbers of columns');
        plan.push(...r.plan);
        if (!i) return;
        rows = q.all[i - 1] ? rows.concat(r.rows) : distinct(rows.concat(r.rows));
        plan.push(`Union${q.all[i - 1] ? ' All' : ''} (${rows.length} rows)`);
      });
      if (q.order) {
        const at = q.order.map(o => { const i = o.e.t === 'col' ? parts[0].columns.indexOf(o.e.name) : o.e.t === 'lit' ? o.e.v - 1 : -1; if (!(i >= 0 && i < parts[0].columns.length)) throw new Error('ORDER BY on a UNION must name an output column'); return i; });
        rows.sort((a, b) => cmpKeys(at.map(i => a[i]), at.map(i => b[i]), q.order));
        plan.push(`Sort by ${showOrder(q.order)}`);
      }
      res = { columns: parts[0].columns, rows: limit(q, rows, plan), plan: [] };
    }
    return { columns: res.columns, rows: res.rows, plan: [...plan, ...res.plan] };
  }

  const index = (t, ix, row, add) => { if (row[ix.col] != null) ix.tree[add ? 'insert' : 'remove']([row[ix.col], t.rid.get(row)], row); };

  function run(st) {
    if (st.t === 'select' || st.t === 'union') return query(st, null);
    if (st.t === 'explain') { const r = query(st.q, null); return { columns: ['plan'], rows: r.plan.map(l => [l]), plan: r.plan }; }
    if (st.t === 'create') {
      if (tables.has(st.table)) throw new Error(`table ${st.table} already exists`);
      tables.set(st.table, { cols: st.cols, rows: [], indexes: [], rid: new WeakMap(), seq: 0 });
      return { message: `created ${st.table}` };
    }
    const t = table(st.table), col = name => { const i = t.cols.indexOf(name); if (i < 0) throw new Error(`no such column: ${name}`); return i; };
    if (st.t === 'drop') { tables.delete(st.table); return { message: `dropped ${st.table}` }; }
    if (st.t === 'index') {
      const ix = { name: st.name, col: col(st.col), tree: BTree() };
      t.rows.forEach(r => index(t, ix, r, true));
      t.indexes.push(ix);
      return { message: `created index ${st.name} on ${st.table} (${st.col})` };
    }
    if (st.t === 'insert') {
      const at = (st.cols || t.cols).map(col), scope = newScope([]);
      const src = st.q ? query(st.q, null).rows : st.rows.map(r => r.map(e => comp(e, [], scope)([])));
      for (const r of src) {
        if (r.length !== at.length) throw new Error(`${at.length} columns but ${r.length} values`);
        const row = t.cols.map(() => null);
        r.forEach((v, i) => { row[at[i]] = v; });
        t.rows.push(row); t.rid.set(row, t.seq++);
        for (const ix of t.indexes) index(t, ix, row, true);
      }
      return { message: `inserted ${src.length} into ${st.table}` };
    }
    // UPDATE and DELETE: find the rows first, then change them, keeping every index in step.
    const S = t.cols.map(name => ({ tbl: st.table, name })), scope = newScope(S), where = st.where ? comp(st.where, S, scope) : () => true;
    const hit = t.rows.filter(r => truthy(where(r)));
    if (st.t === 'delete') {
      const gone = new Set(hit);
      for (const r of hit) for (const ix of t.indexes) index(t, ix, r, false);
      t.rows = t.rows.filter(r => !gone.has(r));
      return { message: `deleted ${hit.length} from ${st.table}` };
    }
    const sets = st.sets.map(([name, e]) => [col(name), comp(e, S, scope)]), next = hit.map(r => sets.map(([, f]) => f(r)));
    hit.forEach((r, n) => {
      for (const ix of t.indexes) index(t, ix, r, false);
      sets.forEach(([i], k) => { r[i] = next[n][k]; });
      for (const ix of t.indexes) index(t, ix, r, true);
    });
    return { message: `updated ${hit.length} in ${st.table}` };
  }

  // Runs every statement in `sql`, returns one result per statement.
  return { exec: sql => parse(sql).map(run), tables };
}

const api = { Database, parse, BTree };
if (typeof module !== 'undefined') module.exports = api; else root.SQL = api;
})(this);
