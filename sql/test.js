// node sql/test.js
const assert = require('assert');
const { Database } = require('./sql.js');

const db = Database();
const q = sql => db.exec(sql).pop();
const rows = sql => q(sql).rows;

db.exec(`
  CREATE TABLE users (id INT, name VARCHAR(20), city TEXT);
  CREATE TABLE orders (id INT, user_id INT, total DECIMAL(10, 2), note TEXT);
  INSERT INTO users VALUES (1, 'Ada', 'London'), (2, 'Linus', 'Helsinki'), (3, 'Grace', 'New York'), (4, 'O''Neil', NULL);
  INSERT INTO orders VALUES (1, 1, 10.5, 'first'), (2, 1, 20, NULL), (3, 2, 5, 'gift wrap'), (4, 2, 7.5, 'Gift'), (5, 9, 99, 'orphan');
  INSERT INTO orders (id, total) VALUES (6, -1 * 3);
`);

assert.deepStrictEqual(rows('SELECT 1 + 2 * 3, (1 + 2) * 3, 7 % 4, 1 / 0, \'a\' || 1'), [[7, 9, 3, null, 'a1']]);
assert.deepStrictEqual(rows('SELECT name FROM users WHERE id >= 2 AND NOT name = \'Grace\' ORDER BY name DESC'), [["O'Neil"], ['Linus']]);
assert.deepStrictEqual(rows('SELECT u.name, COUNT(*) AS n, SUM(o.total) FROM orders o JOIN users u ON o.user_id = u.id GROUP BY u.name ORDER BY n DESC, u.name'), [['Ada', 2, 30.5], ['Linus', 2, 12.5]]);
assert.deepStrictEqual(rows('SELECT u.name, o.id FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL ORDER BY 1'), [['Grace', null], ["O'Neil", null]]);
assert.deepStrictEqual(rows('SELECT u.name, o.id FROM users u JOIN orders o ON o.user_id = u.id AND o.total > 9 ORDER BY o.id'), [['Ada', 1], ['Ada', 2]]);
assert.deepStrictEqual(rows('SELECT id FROM orders WHERE note LIKE \'gift%\' ORDER BY id'), [[3], [4]]);
assert.deepStrictEqual(rows('SELECT id FROM orders WHERE user_id IN (2, 9) AND id NOT IN (4) ORDER BY id'), [[3], [5]]);
assert.deepStrictEqual(rows('SELECT COUNT(*), COUNT(note), COUNT(DISTINCT user_id), MIN(total), MAX(total), ROUND(AVG(total), 2) FROM orders'), [[6, 4, 3, -3, 99, 23.17]]);
assert.deepStrictEqual(rows('SELECT COUNT(*), SUM(total) FROM orders WHERE id > 100'), [[0, null]]);
assert.deepStrictEqual(rows('SELECT user_id, SUM(total) AS s FROM orders GROUP BY user_id HAVING SUM(total) > 12 ORDER BY s LIMIT 2 OFFSET 1'), [[1, 30.5], [9, 99]]);
assert.deepStrictEqual(rows('SELECT DISTINCT user_id FROM orders WHERE user_id IS NOT NULL ORDER BY user_id DESC LIMIT 2'), [[9], [2]]);
assert.deepStrictEqual(rows('SELECT UPPER(name), LENGTH(name), COALESCE(city, \'?\') FROM users WHERE id = 4'), [["O'NEIL", 6, '?']]);
// NULL is neither true nor false: neither branch matches the user without a city.
assert.deepStrictEqual(rows('SELECT COUNT(*) FROM users WHERE city = \'London\' OR NOT city = \'London\''), [[3]]);
assert.deepStrictEqual(rows('SELECT COUNT(*) FROM users WHERE city = \'London\' OR id = 4'), [[2]]);
assert.deepStrictEqual(q('SELECT * FROM users u JOIN orders o ON u.id = o.user_id').columns, ['id', 'name', 'city', 'id', 'user_id', 'total', 'note']);
assert.match(q('SELECT * FROM users u JOIN orders o ON u.id = o.user_id').plan.join('|'), /Scan users \(4 rows\)\|HashJoin orders/);
assert.match(q('SELECT * FROM users u JOIN orders o ON u.id < o.user_id').plan.join('|'), /NestedLoopJoin/);

assert.throws(() => q('SELECT nope FROM users'), /no such column: nope/);
assert.throws(() => q('SELECT id FROM users u JOIN orders o ON u.id = o.user_id'), /ambiguous column: id/);
assert.throws(() => q('SELECT * FROM missing'), /no such table/);
assert.throws(() => q('SELECT FROM users'), /unexpected token near 'FROM'/);
assert.throws(() => q('SELECT name FROM users WHERE COUNT(*) > 1'), /needs a grouped query/);

console.log('sql: 22 checks passed');
