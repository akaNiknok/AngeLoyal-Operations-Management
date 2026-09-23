// ============================================================
//  Full-table scans. D1 bills every row a query visits, so a scan
//  on a big or growing table spends the free plan's 5M rows read a
//  day. These tests read SQLite's query plan and fail on a SCAN.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { HEADERS, usersSheet, EMAIL } = require('./fixtures');

const plan = (raw, sql) => raw.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail);

test('boot and the rate reads never scan freight_rates (~36,750 rows)', async () => {
  const bands = Array.from({ length: 25 }, (_, i) => (i === 7 ? 1000 : ''));
  const sheets = {
    Users: usersSheet(),
    'Freight Rates': [
      HEADERS['Freight Rates'].slice(),
      [1, 'Cabuyao', 'Sta. Rosa', '6W', '1/1/2026', ...bands],
      [2, 'Naic', 'Dasma', '6W', '1/1/2026', ...bands],
    ],
  };
  const { api, raw } = makeEnv({ sheets, userEmail: EMAIL.Admin });

  const seen = new Set();
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => { seen.add(sql); return prepare(sql); };
  await api.getBootData();
  await api.getFreightRates('CABUYAO');
  raw.prepare = prepare;

  const rateSql = [...seen].filter((s) => /freight_rates/.test(s));
  assert.ok(rateSql.length >= 2);
  rateSql.forEach((sql) => {
    assert.ok(!plan(raw, sql).some((d) => /^SCAN freight_rates/.test(d)), `scans freight_rates:\n${sql}`);
  });
});

test('the counter, trip delete and waybill unlink lookups use an index', () => {
  const { raw } = makeEnv({});
  [
    `SELECT MAX(sequence_number) FROM waybills WHERE prefix_id = 1`,
    `DELETE FROM route_frequency_log WHERE trip_id = 1`,
    `UPDATE trips SET parent_trip_id = NULL WHERE parent_trip_id = 1`,
    `UPDATE waybills SET parent_waybill_id = NULL WHERE parent_waybill_id = 1`,
  ].forEach((sql) => {
    assert.ok(!plan(raw, sql).some((d) => /^SCAN /.test(d)), `full scan:\n${sql}`);
  });
});
