// ============================================================
//  server/db.js + ctx.js + the harness shim — the date vocabulary
//  (Workers run in UTC; Manila is the only "today"), the client
//  <-> storage format round trips, batch atomicity, and the D1
//  binding rules the shim mirrors.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db.js');
const { nextBusinessDay } = require('../server/internals.js');
const { makeEnv, dump } = require('./harness');

test('todayPH/nowPH follow Manila wall time, not UTC — pinned near midnight', () => {
  // 2026-06-16 16:30 UTC is 2026-06-17 00:30 in Manila.
  assert.equal(db.toPHTimestamp('2026-06-16T16:30:00Z'), '2026-06-17 00:30:00');
  assert.equal(db.toPHTimestamp('2026-06-16T15:59:59Z'), '2026-06-16 23:59:59');
  assert.match(db.todayPH(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(db.nowPH().slice(0, 10), db.todayPH());
});

test('client dates round-trip and a bad date never becomes today', () => {
  assert.equal(db.fromClientDate('6/16/2026'), '2026-06-16');
  assert.equal(db.fromClientDate('2026-06-16'), '2026-06-16');
  assert.equal(db.fromClientDate(''), null);
  assert.equal(db.fromClientDate('2/30/2026'), null);
  assert.equal(db.fromClientDate('16/6/2026'), null);
  assert.equal(db.toClientDate('2026-06-16'), '6/16/2026');
  assert.equal(db.toClientDate(null), '');
  assert.equal(db.toClientDateTime('2026-06-16 07:05:09'), '6/16/2026 07:05:09');
  assert.equal(db.toClientDateTime(''), '');
  assert.equal(db.fromClientDateTime('6/16/2026 7:05:09'), '2026-06-16 07:05:09');
  assert.equal(db.fromClientDateTime('6/16/2026'), null);
});

test('addDays crosses months and years; nextBusinessDay skips Sunday', () => {
  assert.equal(db.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(db.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(db.dayOfWeek('2026-06-14'), 0);          // a Sunday
  assert.equal(nextBusinessDay('2026-06-13'), '2026-06-15', 'Saturday -> Monday');
  assert.equal(nextBusinessDay('2026-06-15'), '2026-06-16');
});

test('numOrNull keeps zero and drops blanks', () => {
  assert.equal(db.numOrNull(0), 0);
  assert.equal(db.numOrNull('42'), 42);
  assert.equal(db.numOrNull(''), null);
  assert.equal(db.numOrNull('abc'), null);
  assert.equal(db.round3(3.638000000000001), 3.638);
});

test('every query helper needs a request context', async () => {
  await assert.rejects(() => db.q('SELECT 1'), /No request context/);
});

test('batch is all-or-nothing and returns one result per statement', async () => {
  const { api, db: d1 } = makeEnv({ userEmail: 'unknown' });
  const ok = await api.batch([
    api.stmt(`INSERT INTO employees (id, nickname, role) VALUES (?, ?, ?)`, 1, 'A', 'Driver'),
    api.stmt(`INSERT INTO employees (id, nickname, role) VALUES (?, ?, ?)`, 2, 'B', 'Helper'),
  ]);
  assert.equal(ok.length, 2);
  assert.equal(dump(d1, 'employees').length, 2);

  await assert.rejects(() => api.batch([
    api.stmt(`INSERT INTO employees (id, nickname, role) VALUES (?, ?, ?)`, 3, 'C', 'Driver'),
    api.stmt(`INSERT INTO employees (id, nickname, role) VALUES (?, ?, ?)`, 1, 'dup', 'Driver'),
  ]), /UNIQUE|PRIMARY KEY/);
  assert.equal(dump(d1, 'employees').length, 2, 'the first insert rolled back with the second');
});

test('the shim binds like D1: booleans become integers, undefined is refused, FKs are enforced', async () => {
  const { api } = makeEnv({ userEmail: 'unknown' });
  const meta = await api.run(`INSERT INTO employees (nickname, role, active) VALUES (?, ?, ?)`, 'A', 'Driver', false);
  assert.equal(meta.last_row_id, 1);
  assert.equal((await api.one(`SELECT active FROM employees WHERE id = 1`)).active, 0);
  await assert.rejects(() => api.run(`INSERT INTO employees (nickname, role) VALUES (?, ?)`, undefined, 'x'), /D1_TYPE_ERROR/);
  await assert.rejects(() => api.run(`INSERT INTO trucks (plate_number, default_driver_id) VALUES (?, ?)`, 'AAA', 99), /FOREIGN KEY/);
});

test('an INSERT … RETURNING reserves a value atomically (the waybill sequence pattern)', async () => {
  const { api } = makeEnv({ tables: { waybill_prefixes: [{ id: 1, prefix: 'AL', company_name: 'x', last_sequence_number: 40 }] } });
  const row = await api.one(
    `UPDATE waybill_prefixes SET last_sequence_number = last_sequence_number + 1 WHERE id = ? RETURNING last_sequence_number`, 1);
  assert.equal(row.last_sequence_number, 41);
});
