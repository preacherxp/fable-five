// sql.js: an in-memory SQL engine. Tokenizer, recursive-descent parser, expressions compiled to closures,
// hash joins, grouping, three-valued NULL logic, and a plan that says what it did. No dependencies.
//
// Supported: CREATE TABLE, INSERT, SELECT [DISTINCT] ... FROM ... [LEFT] JOIN ... ON ... WHERE ... GROUP BY ...
// HAVING ... ORDER BY ... LIMIT ... OFFSET, COUNT/SUM/AVG/MIN/MAX, LIKE, IN, IS NULL, ||, and a few scalar functions.
(function (root) {
'use strict';

const KW = new Set('SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN LEFT INNER ON AS AND OR NOT IN IS NULL LIKE ASC DESC CREATE TABLE INSERT INTO VALUES DISTINCT'.split(' '));
const AGG = new Set(['count', 'sum', 'avg', 'min', 'max']);
const truthy = v => v != null && v !== false && v !== 0;

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

  function prim() {
    const t = toks[p++];
    if (!t) { p--; fail('unexpected end'); }
    if (t.k === 'num' || t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'kw' && t.v === 'NULL') return { t: 'lit', v: null };
    if (t.k === 'op' && t.v === '(') { const e = expr(); need(')'); return e; }
    if (t.k === 'op' && t.v === '-') return { t: 'neg', e: prim() };
    if (t.k === 'id') {
      if (eat('(')) {
        if (eat('*')) { need(')'); return { t: 'fn', name: t.v, star: true, args: [] }; }
        const distinct = eat('DISTINCT'), args = is(')') ? [] : list(expr);
        need(')');
        return { t: 'fn', name: t.v, args, distinct };
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
      if (t && t.k === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.v)) { p++; l = { t: 'bin', op: t.v, a: l, b: sum() }; continue; }
      if (eat('IS')) { const not = eat('NOT'); need('NULL'); l = { t: 'isnull', e: l, not }; continue; }
      const save = p, not = eat('NOT'), wrap = e => not ? { t: 'not', e } : e;
      if (eat('LIKE')) l = wrap({ t: 'bin', op: 'LIKE', a: l, b: sum() });
      else if (eat('IN')) { need('('); l = wrap({ t: 'in', e: l, list: list(expr) }); need(')'); }
      else { p = save; return l; }
    }
  }
  const not = () => eat('NOT') ? { t: 'not', e: not() } : cmp();
  const and = left(not, ['AND']), expr = left(and, ['OR']);

  const tableRef = () => { const name = id(); return { name, alias: eat('AS') ? id() : isId() ? id() : name }; };

  function statement() {
    if (eat('CREATE')) {
      need('TABLE'); const name = id(); need('(');
      const cols = list(() => {                    // column types are accepted and ignored
        const col = id(); let depth = 0;
        while (toks[p] && (depth || (!is(',') && !is(')')))) { if (is('(')) depth++; else if (is(')')) depth--; p++; }
        return col;
      });
      need(')');
      return { t: 'create', name, cols };
    }
    if (eat('INSERT')) {
      need('INTO'); const name = id(); let cols = null;
      if (eat('(')) { cols = list(id); need(')'); }
      need('VALUES');
      return { t: 'insert', name, cols, rows: list(() => { need('('); const r = list(expr); need(')'); return r; }) };
    }
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
    if (eat('ORDER')) { need('BY'); q.order = list(() => { const e = expr(), desc = eat('DESC'); if (!desc) eat('ASC'); return { e, desc }; }); }
    if (eat('LIMIT')) q.limit = num();
    if (eat('OFFSET')) q.offset = num();
    return q;
  }

  const out = [];
  while (p < toks.length) { if (eat(';')) continue; out.push(statement()); if (p < toks.length) need(';'); }
  return out;
}

const show = e =>
  e.t === 'lit' ? (typeof e.v === 'string' ? `'${e.v}'` : String(e.v))
  : e.t === 'col' ? (e.tbl ? e.tbl + '.' : '') + e.name
  : e.t === 'bin' ? `${show(e.a)} ${e.op} ${show(e.b)}`
  : e.t === 'fn' ? `${e.name}(${e.star ? '*' : (e.distinct ? 'DISTINCT ' : '') + e.args.map(show).join(', ')})`
  : e.t === 'neg' ? `-${show(e.e)}`
  : e.t === 'not' ? `NOT ${show(e.e)}`
  : e.t === 'isnull' ? `${show(e.e)} IS ${e.not ? 'NOT ' : ''}NULL`
  : `${show(e.e)} IN (${e.list.map(show).join(', ')})`;

const hasAgg = e => !!e && typeof e === 'object' && ((e.t === 'fn' && AGG.has(e.name)) || Object.values(e).some(v => Array.isArray(v) ? v.some(hasAgg) : hasAgg(v)));

const likes = new Map();
const like = (s, pat) => {
  let re = likes.get(pat);
  if (!re) likes.set(pat, re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$', 'i'));
  return re.test(String(s));
};
const BIN = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => b === 0 ? null : a / b, '%': (a, b) => b === 0 ? null : a % b,
  '||': (a, b) => String(a) + String(b), '=': (a, b) => a === b, '<>': (a, b) => a !== b, '!=': (a, b) => a !== b,
  '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, LIKE: like,
};
const FN = {
  upper: s => s == null ? null : String(s).toUpperCase(), lower: s => s == null ? null : String(s).toLowerCase(),
  length: s => s == null ? null : String(s).length, abs: n => n == null ? null : Math.abs(n),
  round: (n, d = 0) => n == null ? null : Math.round(n * 10 ** d) / 10 ** d,
  coalesce: (...a) => a.find(v => v != null) ?? null,
};

function aggregate(e, f, group) {
  if (!group) throw new Error(`${e.name}() needs a grouped query`);
  if (e.star) return group.length;
  let v = group.map(r => f(r)).filter(x => x != null);
  if (e.distinct) v = [...new Set(v)];
  if (e.name === 'count') return v.length;
  if (!v.length) return null;
  if (e.name === 'sum') return v.reduce((a, b) => a + b, 0);
  if (e.name === 'avg') return v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => (e.name === 'min' ? b < a : b > a) ? b : a);
}

// Compiles an expression against a schema ([{ tbl, name }]) into (row, group) => value.
function comp(e, S) {
  switch (e.t) {
    case 'lit': return () => e.v;
    case 'col': {
      const hits = S.flatMap((s, i) => s.name === e.name && (!e.tbl || s.tbl === e.tbl) ? [i] : []);
      if (hits.length !== 1) throw new Error(`${hits.length ? 'ambiguous' : 'no such'} column: ${show(e)}`);
      const i = hits[0];
      return r => r[i];
    }
    case 'neg': { const f = comp(e.e, S); return (r, g) => { const v = f(r, g); return v == null ? null : -v; }; }
    case 'not': { const f = comp(e.e, S); return (r, g) => { const v = f(r, g); return v == null ? null : !truthy(v); }; }
    case 'isnull': { const f = comp(e.e, S); return (r, g) => (f(r, g) == null) !== e.not; }
    case 'in': { const f = comp(e.e, S), L = e.list.map(x => comp(x, S)); return (r, g) => { const v = f(r, g); return v == null ? null : L.some(l => l(r, g) === v); }; }
    case 'bin': {
      const a = comp(e.a, S), b = comp(e.b, S), f = BIN[e.op];
      // SQL three-valued logic: NULL AND FALSE is FALSE, NULL OR TRUE is TRUE, otherwise NULL wins.
      if (e.op === 'AND') return (r, g) => { const x = a(r, g), y = b(r, g); return (x != null && !truthy(x)) || (y != null && !truthy(y)) ? false : x == null || y == null ? null : true; };
      if (e.op === 'OR') return (r, g) => { const x = a(r, g), y = b(r, g); return truthy(x) || truthy(y) ? true : x == null || y == null ? null : false; };
      return (r, g) => { const x = a(r, g), y = b(r, g); return x == null || y == null ? null : f(x, y); };
    }
    case 'fn': {
      if (AGG.has(e.name)) { const f = e.star ? null : comp(e.args[0], S); return (r, g) => aggregate(e, f, g); }
      const f = FN[e.name], A = e.args.map(x => comp(x, S));
      if (!f) throw new Error(`no such function: ${e.name}`);
      return (r, g) => f(...A.map(a => a(r, g)));
    }
  }
}

function Database() {
  const tables = new Map();
  const table = name => tables.get(name) || (() => { throw new Error(`no such table: ${name}`); })();
  const bucket = (m, k) => m.get(k) || m.set(k, []).get(k);

  function select(q) {
    const plan = [];
    let S = [], rows = [[]];
    if (q.from) {
      const t = table(q.from.name);
      S = t.cols.map(name => ({ tbl: q.from.alias, name })); rows = t.rows;
      plan.push(`Scan ${q.from.name} (${rows.length} rows)`);
    }
    for (const j of q.joins) {
      const t = table(j.name), RS = t.cols.map(name => ({ tbl: j.alias, name })), both = [...S, ...RS];
      const pad = RS.map(() => null), out = [], kind = j.left ? 'Left ' : '';
      const tryComp = (e, schema) => { try { return comp(e, schema); } catch { return null; } };
      // An equality between one expression per side can be hashed; anything else falls back to a nested loop.
      const eq = j.on.t === 'bin' && j.on.op === '=' && [[j.on.a, j.on.b], [j.on.b, j.on.a]].map(([l, r]) => [tryComp(l, S), tryComp(r, RS)]).find(([l, r]) => l && r);
      if (eq) {
        const [lk, rk] = eq, h = new Map();
        for (const r of t.rows) { const k = rk(r); if (k != null) bucket(h, k).push(r); }
        for (const l of rows) { const m = h.get(lk(l)); if (m) for (const r of m) out.push([...l, ...r]); else if (j.left) out.push([...l, ...pad]); }
        plan.push(`${kind}HashJoin ${j.name} (${t.rows.length} rows) on ${show(j.on)}`);
      } else {
        const on = comp(j.on, both);
        for (const l of rows) {
          let hit = false;
          for (const r of t.rows) { const c = [...l, ...r]; if (truthy(on(c))) { out.push(c); hit = true; } }
          if (!hit && j.left) out.push([...l, ...pad]);
        }
        plan.push(`${kind}NestedLoopJoin ${j.name} (${t.rows.length} rows) on ${show(j.on)}`);
      }
      S = both; rows = out;
    }
    if (q.where) {
      const f = comp(q.where, S), before = rows.length;
      rows = rows.filter(r => truthy(f(r)));
      plan.push(`Filter ${show(q.where)} (${before} → ${rows.length} rows)`);
    }

    const items = q.items.flatMap(it => it.star ? S.filter(s => !it.tbl || s.tbl === it.tbl).map(s => ({ e: { t: 'col', tbl: s.tbl, name: s.name }, as: s.name })) : [it]);
    const names = items.map(it => it.as || show(it.e));
    let units;                                     // [representative row, group rows]
    if (q.group || items.some(it => hasAgg(it.e)) || hasAgg(q.having) || (q.order || []).some(o => hasAgg(o.e))) {
      const keys = (q.group || []).map(e => comp(e, S)), m = new Map();
      for (const r of rows) bucket(m, JSON.stringify(keys.map(f => f(r)))).push(r);
      if (!q.group && !m.size) m.set('', []);      // an aggregate over no rows still returns one row
      units = [...m.values()].map(g => [g[0] || S.map(() => null), g]);
      plan.push(`Aggregate${q.group ? ' by ' + q.group.map(show).join(', ') : ''} (${units.length} groups)`);
    } else units = rows.map(r => [r]);
    if (q.having) { const f = comp(q.having, S); units = units.filter(([r, g]) => truthy(f(r, g))); plan.push(`Having ${show(q.having)} (${units.length} groups)`); }

    const proj = items.map(it => comp(it.e, S));
    let out = units.map(([r, g]) => ({ v: proj.map(f => f(r, g)), r, g }));
    if (q.distinct) { const seen = new Set(); out = out.filter(o => { const k = JSON.stringify(o.v); return !seen.has(k) && seen.add(k); }); plan.push('Distinct'); }
    if (q.order) {
      const keys = q.order.map(o => {              // an output alias, a column number, or any expression
        const i = o.e.t === 'col' && !o.e.tbl ? names.indexOf(o.e.name) : o.e.t === 'lit' && Number.isInteger(o.e.v) ? o.e.v - 1 : -1;
        if (i >= 0 && i < names.length) return x => x.v[i];
        const f = comp(o.e, S); return x => f(x.r, x.g);
      });
      out.sort((a, b) => {
        for (let i = 0; i < keys.length; i++) {
          const x = keys[i](a), y = keys[i](b);
          if (x === y) continue;
          const c = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
          return q.order[i].desc ? -c : c;
        }
        return 0;
      });
      plan.push(`Sort by ${q.order.map(o => show(o.e) + (o.desc ? ' DESC' : '')).join(', ')}`);
    }
    if (q.limit != null || q.offset) { const o = q.offset || 0; out = out.slice(o, q.limit != null ? o + q.limit : undefined); plan.push(`Limit ${q.limit ?? 'all'}${o ? ' offset ' + o : ''}`); }
    return { columns: names, rows: out.map(o => o.v), plan };
  }

  function run(st) {
    if (st.t === 'select') return select(st);
    if (st.t === 'create') {
      if (tables.has(st.name)) throw new Error(`table ${st.name} already exists`);
      tables.set(st.name, { cols: st.cols, rows: [] });
      return { message: `created ${st.name}` };
    }
    const t = table(st.name), at = (st.cols || t.cols).map(c => { const i = t.cols.indexOf(c); if (i < 0) throw new Error(`no such column: ${c}`); return i; });
    for (const r of st.rows) {
      if (r.length !== at.length) throw new Error(`${at.length} columns but ${r.length} values`);
      const row = t.cols.map(() => null);
      r.forEach((e, i) => { row[at[i]] = comp(e, [])([]); });
      t.rows.push(row);
    }
    return { message: `inserted ${st.rows.length} into ${st.name}` };
  }

  // Runs every statement in `sql`, returns one result per statement.
  return { exec: sql => parse(sql).map(run), tables };
}

const api = { Database, parse };
if (typeof module !== 'undefined') module.exports = api; else root.SQL = api;
})(this);
