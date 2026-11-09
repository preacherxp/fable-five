// node sql/test.js
const assert = require('assert');
const { Database, BTree } = require('./sql.js');

let checks = 0;
const db = Database();
const q = sql => db.exec(sql).pop();
const rows = (sql, expected) => { checks++; assert.deepStrictEqual(q(sql).rows, expected, sql); };
const fails = (sql, re) => { checks++; assert.throws(() => q(sql), re, sql); };
const plan = (sql, re) => { checks++; assert.match(q(sql).plan.join('|'), re, sql); };

db.exec(`
  CREATE TABLE users (id INT, name VARCHAR(20), city TEXT);
  CREATE TABLE orders (id INT, user_id INT, total DECIMAL(10, 2), note TEXT);
  INSERT INTO users VALUES (1, 'Ada', 'London'), (2, 'Linus', 'Helsinki'), (3, 'Grace', 'New York'), (4, 'O''Neil', NULL);
  INSERT INTO orders VALUES (1, 1, 10.5, 'first'), (2, 1, 20, NULL), (3, 2, 5, 'gift wrap'), (4, 2, 7.5, 'Gift'), (5, 9, 99, 'orphan');
  INSERT INTO orders (id, total) VALUES (6, -1 * 3);
  CREATE TABLE s (name TEXT, grp TEXT, pts INT);
  INSERT INTO s VALUES ('a', 'x', 10), ('b', 'x', 10), ('c', 'x', 8), ('d', 'x', 7), ('e', 'y', 5), ('f', 'y', 5);
  CREATE TABLE emp (id INT, boss INT);
  INSERT INTO emp VALUES (1, NULL), (2, 1), (3, 1), (4, 2), (5, 4);
`);

// ---- the original engine: expressions, joins, grouping, NULL logic
rows('SELECT 1 + 2 * 3, (1 + 2) * 3, 7 % 4, 1 / 0, \'a\' || 1', [[7, 9, 3, null, 'a1']]);
rows('SELECT name FROM users WHERE id >= 2 AND NOT name = \'Grace\' ORDER BY name DESC', [["O'Neil"], ['Linus']]);
rows('SELECT u.name, COUNT(*) AS n, SUM(o.total) FROM orders o JOIN users u ON o.user_id = u.id GROUP BY u.name ORDER BY n DESC, u.name', [['Ada', 2, 30.5], ['Linus', 2, 12.5]]);
rows('SELECT u.name, o.id FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL ORDER BY 1', [['Grace', null], ["O'Neil", null]]);
rows('SELECT u.name, o.id FROM users u JOIN orders o ON o.user_id = u.id AND o.total > 9 ORDER BY o.id', [['Ada', 1], ['Ada', 2]]);
rows('SELECT id FROM orders WHERE note LIKE \'gift%\' ORDER BY id', [[3], [4]]);
rows('SELECT id FROM orders WHERE user_id IN (2, 9) AND id NOT IN (4) ORDER BY id', [[3], [5]]);
rows('SELECT COUNT(*), COUNT(note), COUNT(DISTINCT user_id), MIN(total), MAX(total), ROUND(AVG(total), 2) FROM orders', [[6, 4, 3, -3, 99, 23.17]]);
rows('SELECT COUNT(*), SUM(total) FROM orders WHERE id > 100', [[0, null]]);
rows('SELECT user_id, SUM(total) AS s FROM orders GROUP BY user_id HAVING SUM(total) > 12 ORDER BY s LIMIT 2 OFFSET 1', [[1, 30.5], [9, 99]]);
rows('SELECT DISTINCT user_id FROM orders WHERE user_id IS NOT NULL ORDER BY user_id DESC LIMIT 2', [[9], [2]]);
rows('SELECT UPPER(name), LENGTH(name), COALESCE(city, \'?\') FROM users WHERE id = 4', [["O'NEIL", 6, '?']]);
// NULL is neither true nor false: neither branch matches the user without a city.
rows('SELECT COUNT(*) FROM users WHERE city = \'London\' OR NOT city = \'London\'', [[3]]);
rows('SELECT COUNT(*) FROM users WHERE city = \'London\' OR id = 4', [[2]]);
checks++; assert.deepStrictEqual(q('SELECT * FROM users u JOIN orders o ON u.id = o.user_id').columns, ['id', 'name', 'city', 'id', 'user_id', 'total', 'note']);
plan('SELECT * FROM users u JOIN orders o ON u.id = o.user_id', /Scan users \(4 rows\)\|HashJoin orders/);
plan('SELECT * FROM users u JOIN orders o ON u.id < o.user_id', /NestedLoopJoin/);
fails('SELECT nope FROM users', /no such column: nope/);
fails('SELECT id FROM users u JOIN orders o ON u.id = o.user_id', /ambiguous column: id/);
fails('SELECT * FROM missing', /no such table/);
fails('SELECT FROM users', /unexpected token near 'FROM'/);
fails('SELECT name FROM users WHERE COUNT(*) > 1', /needs a grouped query/);

// ---- CTEs, recursion, UNION
rows('WITH a AS (SELECT id, name FROM users WHERE id <= 2), b(uid, n) AS (SELECT user_id, COUNT(*) FROM orders GROUP BY user_id) SELECT a.name, b.n FROM a JOIN b ON a.id = b.uid ORDER BY a.name', [['Ada', 2], ['Linus', 2]]);
rows('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT SUM(n), COUNT(*), MAX(n) FROM t', [[15, 5, 5]]);
// UNION (without ALL) drops rows it has already seen, so a cycle terminates.
rows('WITH RECURSIVE t(n) AS (SELECT 0 UNION SELECT (n + 1) % 3 FROM t) SELECT n FROM t ORDER BY n', [[0], [1], [2]]);
fails('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT COUNT(*) FROM t', /recursive CTE t did not terminate/);
rows('WITH RECURSIVE chain(id, depth) AS (SELECT id, 0 FROM emp WHERE boss IS NULL UNION ALL SELECT e.id, c.depth + 1 FROM emp e JOIN chain c ON e.boss = c.id) SELECT id, depth FROM chain ORDER BY id', [[1, 0], [2, 1], [3, 1], [4, 2], [5, 3]]);
// A recursive CTE that does not refer to itself is just a UNION; a later CTE can read an earlier one.
rows('WITH RECURSIVE a(x) AS (SELECT 1 UNION ALL SELECT 2), b AS (SELECT x * 10 AS y FROM a) SELECT SUM(y) FROM b', [[30]]);
rows('SELECT city FROM users WHERE id <= 2 UNION ALL SELECT city FROM users WHERE id = 1 ORDER BY 1', [['Helsinki'], ['London'], ['London']]);
rows('SELECT city FROM users WHERE id <= 2 UNION SELECT city FROM users WHERE id = 1 ORDER BY city DESC LIMIT 5', [['London'], ['Helsinki']]);
fails('SELECT id FROM users UNION SELECT id, name FROM users', /different numbers of columns/);
fails('WITH a(x, y) AS (SELECT 1) SELECT * FROM a', /1 columns but 2 names/);

// ---- window functions
rows('SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY total DESC) FROM orders WHERE user_id IS NOT NULL ORDER BY id', [[1, 2], [2, 1], [3, 2], [4, 1], [5, 1]]);
// Ties: RANK leaves a gap after peers, DENSE_RANK does not, ROW_NUMBER keeps counting.
rows('SELECT name, RANK() OVER (PARTITION BY grp ORDER BY pts DESC), DENSE_RANK() OVER (PARTITION BY grp ORDER BY pts DESC), ROW_NUMBER() OVER (PARTITION BY grp ORDER BY pts DESC) FROM s ORDER BY name',
  [['a', 1, 1, 1], ['b', 1, 1, 2], ['c', 3, 2, 3], ['d', 4, 3, 4], ['e', 1, 1, 1], ['f', 1, 1, 2]]);
// A running SUM includes all peers of the current row; without ORDER BY the frame is the whole partition.
rows('SELECT name, SUM(pts) OVER (PARTITION BY grp ORDER BY pts DESC) AS run, SUM(pts) OVER (PARTITION BY grp) AS tot, COUNT(*) OVER () AS n, MIN(pts) OVER (ORDER BY name) AS low FROM s ORDER BY name',
  [['a', 20, 35, 6, 10], ['b', 20, 35, 6, 10], ['c', 28, 35, 6, 8], ['d', 35, 35, 6, 7], ['e', 10, 10, 6, 5], ['f', 10, 10, 6, 5]]);
rows('SELECT name, LAG(pts) OVER (PARTITION BY grp ORDER BY name), LEAD(pts, 2) OVER (PARTITION BY grp ORDER BY name), LAG(pts, 1, 0) OVER (ORDER BY name) FROM s ORDER BY name',
  [['a', null, 8, 0], ['b', 10, 7, 10], ['c', 10, null, 10], ['d', 8, null, 8], ['e', null, null, 7], ['f', 5, null, 5]]);
rows('SELECT user_id, SUM(total) AS s, RANK() OVER (ORDER BY SUM(total) DESC) AS r FROM orders WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY r', [[9, 99, 1], [1, 30.5, 2], [2, 12.5, 3]]);
rows('SELECT name FROM (SELECT name, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY pts DESC, name) AS rn FROM s) t WHERE rn = 1 ORDER BY name', [['a'], ['e']]);
rows('SELECT name, pts * 100 / SUM(pts) OVER () FROM s WHERE grp = \'y\' ORDER BY RANK() OVER (ORDER BY name DESC)', [['f', 50], ['e', 50]]);
fails('SELECT id FROM orders WHERE ROW_NUMBER() OVER (ORDER BY id) = 1', /only allowed in SELECT and ORDER BY/);
fails('SELECT RANK() FROM orders', /rank\(\) needs an OVER clause/);
fails('SELECT UPPER(note) OVER () FROM orders', /not a window function/);

// ---- subqueries
rows('SELECT name FROM users WHERE id = (SELECT MAX(user_id) FROM orders WHERE user_id < 9)', [['Linus']]);
rows('SELECT u.name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS n FROM users u ORDER BY u.id', [['Ada', 2], ['Linus', 2], ['Grace', 0], ["O'Neil", 0]]);
rows('SELECT name FROM users WHERE id IN (SELECT user_id FROM orders) ORDER BY name', [['Ada'], ['Linus']]);
// x NOT IN (..., NULL) is never true: the NULL might have been x.
rows('SELECT name FROM users WHERE id NOT IN (SELECT user_id FROM orders)', []);
rows('SELECT name FROM users WHERE id NOT IN (1, NULL)', []);
rows('SELECT name FROM users WHERE id NOT IN (SELECT user_id FROM orders WHERE user_id IS NOT NULL) ORDER BY name', [['Grace'], ["O'Neil"]]);
rows('SELECT name FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) ORDER BY name', [['Grace'], ["O'Neil"]]);
rows('SELECT name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total > 15)', [['Ada']]);
// Correlated on a NULL: the order without a user compares against an empty average, which is NULL.
rows('SELECT o.id FROM orders o WHERE o.total > (SELECT AVG(p.total) FROM orders p WHERE p.user_id = o.user_id) ORDER BY o.id', [[2], [4]]);
rows('SELECT u.name FROM users u WHERE EXISTS (SELECT 1 FROM users v WHERE v.city = u.city AND v.id <> u.id)', []);
rows('SELECT t.user_id, t.s FROM (SELECT user_id, SUM(total) AS s FROM orders GROUP BY user_id) t WHERE t.s > 20 ORDER BY t.s', [[1, 30.5], [9, 99]]);
// Two levels deep: the innermost query reads a column of the outermost one.
rows('SELECT u.name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total = (SELECT MAX(p.total) FROM orders p WHERE p.user_id = u.id) AND o.total > 10) ORDER BY 1', [['Ada']]);
fails('SELECT (SELECT id FROM users) FROM orders', /more than one row/);
plan('SELECT name FROM users WHERE id IN (SELECT user_id FROM orders)', /Subquery \(run once\)\|  Scan orders \(6 rows\)/);
plan('SELECT name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)', /Subquery \(correlated, 4 runs, first shown\)/);

// ---- CASE, BETWEEN, UPDATE, DELETE, INSERT ... SELECT, EXPLAIN, DROP
rows('SELECT id, CASE WHEN total >= 20 THEN \'big\' WHEN total >= 7 THEN \'mid\' ELSE \'small\' END, CASE user_id WHEN 1 THEN \'ada\' WHEN 2 THEN \'linus\' END FROM orders ORDER BY id',
  [[1, 'mid', 'ada'], [2, 'big', 'ada'], [3, 'small', 'linus'], [4, 'mid', 'linus'], [5, 'big', null], [6, 'small', null]]);
rows('SELECT id FROM orders WHERE total BETWEEN 5 AND 10.5 ORDER BY id', [[1], [3], [4]]);
rows('SELECT id FROM orders WHERE total NOT BETWEEN 5 AND 20 ORDER BY id', [[5], [6]]);
rows('SELECT SUBSTR(name, 2, 3), SUBSTR(name, 3) FROM users WHERE id = 2', [['inu', 'nus']]);
db.exec('CREATE TABLE acct (id INT, bal INT); INSERT INTO acct VALUES (1, 100), (2, 50), (3, 0);');
checks++; assert.strictEqual(q('UPDATE acct SET bal = bal - 30, id = id + 10 WHERE bal >= 50').message, 'updated 2 in acct');
rows('SELECT id, bal FROM acct ORDER BY id', [[3, 0], [11, 70], [12, 20]]);
db.exec('UPDATE acct SET id = bal, bal = id');     // both sides read the old row
rows('SELECT id, bal FROM acct ORDER BY id', [[0, 3], [20, 12], [70, 11]]);
db.exec('UPDATE acct SET bal = (SELECT MAX(bal) FROM acct) WHERE id IN (SELECT id FROM acct WHERE id > 10)');
rows('SELECT id, bal FROM acct ORDER BY id', [[0, 3], [20, 12], [70, 12]]);
checks++; assert.strictEqual(q('DELETE FROM acct WHERE bal = 12 AND id < 50').message, 'deleted 1 from acct');
db.exec('INSERT INTO acct SELECT id, total FROM orders WHERE id <= 2');
rows('SELECT id, bal FROM acct ORDER BY id', [[0, 3], [1, 10.5], [2, 20], [70, 12]]);
db.exec('DELETE FROM acct');
rows('SELECT COUNT(*) FROM acct', [[0]]);
rows('EXPLAIN SELECT * FROM users WHERE id = 1', [['Scan users (4 rows)'], ['Filter id = 1 (4 → 1 rows)']]);
db.exec('DROP TABLE acct');
fails('SELECT * FROM acct', /no such table: acct/);
// Pushdown: the filter on users runs before the join, the one on the nullable side of a LEFT JOIN after it.
plan('SELECT * FROM orders o JOIN users u ON o.user_id = u.id WHERE u.id > 1 AND o.total > 5', /Scan orders \(6 rows\)\|Filter o.total > 5 \(6 → 4 rows\)\|Scan users \(4 rows\)\|Filter u.id > 1 \(4 → 3 rows\)\|HashJoin users \(3 rows\)/);
plan('SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.total > 5', /Left HashJoin orders \(6 rows\)[^|]*\|Filter o.total > 5/);

// ---- B+tree indexes: two databases get the same statements, one has indexes; results must always match
let seed = 11;
const rnd = n => (seed = seed * 1664525 + 1013904223 >>> 0) % n;
const pick = a => a[rnd(a.length)];
const idx = Database(), bare = Database();
const both = sql => { idx.exec(sql); bare.exec(sql); };
const word = () => pick(['ash', 'birch', 'cedar', 'elm', 'fir', 'oak', 'pine', 'yew']) + rnd(30);
const sorted = (d, sql) => d.exec(sql).pop().rows.map(r => JSON.stringify(r)).sort();
both('CREATE TABLE big (id INT, v INT, s TEXT); CREATE TABLE small (id INT);');
both('INSERT INTO small VALUES (3), (50), (50), (99), (1234), (NULL);');
const fill = (from, n) => both('INSERT INTO big VALUES ' + Array.from({ length: n }, (_, i) => `(${from + i}, ${rnd(12) ? rnd(100) : 'NULL'}, '${word()}')`).join(','));
fill(0, 2000);
idx.exec('CREATE INDEX big_v ON big (v); CREATE INDEX big_s ON big (s);');
const predicate = () => {
  const a = rnd(110) - 5, b = a + rnd(40), w = `'${word()}'`;
  return pick([`v = ${a}`, `v < ${a}`, `v <= ${a}`, `v > ${a}`, `v >= ${a}`, `${a} < v`, `${b} >= v`, `v BETWEEN ${a} AND ${b}`, `v > ${a} AND v <= ${b} AND v <> ${a + 1}`,
    `v >= ${a} AND id % 2 = 0`, `v = ${a} AND v = ${b}`, `v > ${a} AND v > ${b} AND v < 90`, `s = ${w}`, `s >= ${w} AND s < 'oak'`, `s > ${a}`, `s < ${a}`,
    `v = NULL`, `v < (SELECT MAX(id) FROM small WHERE id < ${b + 2})`, `v = ${a} OR v = ${b}`]);
};
const compare = n => {
  let used = 0;
  for (let i = 0; i < n; i++) {
    const sql = `SELECT id, v, s FROM big WHERE ${predicate()}`;
    assert.deepStrictEqual(sorted(idx, sql), sorted(bare, sql), sql);
    if (/IndexScan/.test(idx.exec(sql).pop().plan.join('|'))) used++;
  }
  checks++;
  return used;
};
const usedFirst = compare(200);
assert(usedFirst > 120, `only ${usedFirst} of 200 predicates used an index`);
// The index follows UPDATE, DELETE and INSERT.
both('UPDATE big SET v = v + 1000, s = s || \'x\' WHERE id % 3 = 0');
both('DELETE FROM big WHERE id % 5 = 0 OR v BETWEEN 20 AND 30');
both('UPDATE big SET v = v - 1000 WHERE v >= 1040');
fill(2000, 500);
both('UPDATE big SET v = NULL WHERE id % 7 = 0');
compare(200);
checks++; assert.strictEqual(idx.exec('SELECT COUNT(*) FROM big').pop().rows[0][0], idx.tables.get('big').rows.length);
checks++; assert.match(idx.exec('SELECT * FROM big WHERE v BETWEEN 40 AND 45 AND id > 5').pop().plan.join('|'), /^IndexScan big: 40 <= v <= 45 \(\d+ of \d+ rows\)\|Filter id > 5/);
// A small outer side probes the index of the big table instead of hashing it.
const join = 'SELECT s.id, COUNT(b.id), MIN(b.id) FROM small s LEFT JOIN big b ON b.v = s.id GROUP BY s.id ORDER BY s.id';
checks++; assert.deepStrictEqual(idx.exec(join).pop().rows, bare.exec(join).pop().rows);
checks++; assert.match(idx.exec(join).pop().plan.join('|'), /Left IndexNestedLoopJoin big/);
checks++; assert.match(bare.exec(join).pop().plan.join('|'), /Left HashJoin big/);
// A correlated subquery probes the index once per outer row.
const corr = 'SELECT s.id FROM small s WHERE EXISTS (SELECT 1 FROM big b WHERE b.v = s.id AND b.id > 100) ORDER BY 1';
checks++; assert.deepStrictEqual(idx.exec(corr).pop().rows, bare.exec(corr).pop().rows);
checks++; assert.match(idx.exec(corr).pop().plan.join('|'), /Subquery \(correlated, 6 runs, first shown\)\|  IndexScan big: v = s.id/);

// ---- B+tree invariants under random inserts and deletes, against a sorted array as the model
function audit(tree, model) {
  const leaves = [];
  (function visit(n, depth, lo, hi) {
    assert(n.keys.length <= tree.ORDER && (n === tree.root || n.keys.length >= tree.MIN), `node has ${n.keys.length} keys`);
    for (let i = 0; i < n.keys.length; i++) {
      if (i) assert(cmp(n.keys[i - 1], n.keys[i]) < 0, 'keys out of order');
      assert((!lo || cmp(lo, n.keys[i]) <= 0) && (!hi || cmp(n.keys[i], hi) < 0), 'key outside the range its parent allows');
    }
    if (!n.kids) return leaves.push([n, depth]);
    assert.strictEqual(n.kids.length, n.keys.length + 1);
    n.kids.forEach((k, i) => visit(k, depth + 1, i ? n.keys[i - 1] : lo, i < n.keys.length ? n.keys[i] : hi));
  })(tree.root, 0, null, null);
  assert(leaves.every(([, d]) => d === leaves[0][1]), 'leaves at different depths');
  leaves.forEach(([n], i) => assert.strictEqual(n.next, i + 1 < leaves.length ? leaves[i + 1][0] : null, 'broken leaf chain'));
  assert.deepStrictEqual(leaves.flatMap(([n]) => n.keys), model, 'leaf chain does not hold exactly the model keys');
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
let ops = 0;
for (const order of [4, 5, 32]) {
  const tree = BTree(order), live = [];
  for (let i = 0; i < 6000; i++, ops++) {
    if (live.length && rnd(100) < (i < 3000 ? 35 : 60)) { const [k] = live.splice(rnd(live.length), 1); assert(tree.remove(k)); assert(!tree.remove(k)); }
    else { const k = [rnd(300), i]; live.push(k); tree.insert(k, k[1]); }
    if (i % 250 === 0 || i === 5999) {
      audit(tree, [...live].sort(cmp));
      const lo = rnd(300), hi = lo + rnd(60), inc = rnd(2), got = tree.range(lo, inc, hi, !inc);
      assert.deepStrictEqual(got, live.filter(k => (inc ? k[0] >= lo : k[0] > lo) && (inc ? k[0] < hi : k[0] <= hi)).sort(cmp).map(k => k[1]));
    }
  }
  while (live.length) assert(tree.remove(live.pop()));
  audit(tree, []);
  checks++;
}

console.log(`sql: ${checks} checks passed (${usedFirst} of 200 random predicates answered by an index, ${ops} B+tree operations audited)`);
