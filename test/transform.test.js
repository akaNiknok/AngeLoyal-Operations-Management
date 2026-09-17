// ============================================================
//  server/migrate/transform.js — sheet snapshot -> table rows.
//  The rules of Docs/D1 Migration.md §3.1, plus the real snapshot
//  when data/sheets-snapshot.json is present (gitignored, so that
//  case is skipped on a machine without it).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transform } = require('../server/migrate/transform.js');
const { makeEnv, dump } = require('./harness');
const { HEADERS } = require('./fixtures');

const tripRow = (v) => HEADERS.Trips.map((h) => (h in v ? v[h] : ''));

test('dates: ISO instants shift to Manila, M/d/yyyy strings are wall time, booleans become 0/1', () => {
  const { tables } = transform({
    Users: [HEADERS.Users, [1, ' Ada@X.com ', 'Ada', 'Admin', 'TRUE'], [2, 'b@x', 'B', 'Viewer', false], [3, 'c@x', 'C', 'Viewer', '']],
    Outlets: [HEADERS.Outlets, [1, 'O', 'A', '', '', '', '2026-08-28T16:00:00.000Z']],
    Trips: [HEADERS.Trips,
      tripRow({ ID: 1, 'Trip Date': '2026-08-28T16:00:00.000Z', 'Billing Date': '8/29/2026', 'Added At': '8/29/2026 07:05:09', 'Added By': 'd' }),
    ],
  });
  assert.deepEqual(tables.users.map((u) => [u.email, u.active]), [['ada@x.com', 1], ['b@x', 0], ['c@x', 1]]);
  assert.equal(tables.outlets[0].created_at, '2026-08-29 00:00:00', 'UTC 16:00 is Manila midnight next day');
  assert.equal(tables.trips[0].trip_date, '2026-08-29');
  assert.equal(tables.trips[0].billing_date, '2026-08-29');
  assert.equal(tables.trips[0].added_at, '2026-08-29 07:05:09');
});

test('helpers and default crews become slot rows; category names become ids', () => {
  const { tables } = transform({
    'Billing Categories': [HEADERS['Billing Categories'], [7, '6W', true]],
    Employees: [HEADERS.Employees, ...[7, 8, 21, 30, 31, 32, 33].map((id) => [id, `E${id}`, '', '', '', 'Helper', true])],
    Trucks: [HEADERS.Trucks, [1, 'AAA', 'Isuzu', '6W', true, '6w']],
    'Default Assignments': [HEADERS['Default Assignments'], [1, 1, 21, '30, 31 ,32,33', 'n']],
    Trips: [HEADERS.Trips, tripRow({ ID: 1, 'Trip Date': '6/1/2026', 'Helper IDs': '7,,8', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' })],
    'Route Type Map': [['ID', 'File Type Code', 'Billing Category', 'Active'], [1, '6WF', '6W', true]],
  });
  assert.equal(tables.trucks[0].billing_category_id, 7, 'case-insensitive name match');
  assert.equal(tables.trucks[0].default_driver_id, 21);
  assert.equal(tables.trucks[0].roster_notes, 'n');
  assert.deepEqual(tables.truck_default_helpers, [
    { truck_id: 1, employee_id: 30, slot: 1 }, { truck_id: 1, employee_id: 31, slot: 2 }, { truck_id: 1, employee_id: 32, slot: 3 },
  ]);
  assert.deepEqual(tables.trip_helpers, [{ trip_id: 1, employee_id: 7, slot: 1 }, { trip_id: 1, employee_id: 8, slot: 2 }]);
  assert.equal(tables.route_type_map[0].billing_category_id, 7);
});

test('an unknown category name fails a strict run and is created in a lenient one', () => {
  const snap = { Trucks: [HEADERS.Trucks, [1, 'AAA', '', '', true, 'L300']] };
  assert.throws(() => transform(snap), /Trucks ID 1: unknown Billing Category "L300"/);
  const { tables } = transform(snap, { strict: false });
  assert.equal(tables.billing_categories[0].name, 'L300');
  assert.equal(tables.trucks[0].billing_category_id, tables.billing_categories[0].id);
});

test('waybills: one row per number+FO load, lowest id kept, trips relinked, parents remapped', () => {
  const { tables } = transform({
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'], [1, '', 'AL', 100, true, 5]],
    Trips: [HEADERS.Trips,
      ...[1, 2, 3, 4].map((id) => tripRow({ ID: id, 'Trip Date': '6/1/2026', 'FO Number': id === 3 ? 'B' : 'A', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' })),
    ],
    Waybills: [HEADERS.Waybills,
      [10, '00100', 1, 100, 1, 'A', 'Regular', '', 'Confirmed', true, '', ''],
      [11, '00100', 1, 100, 2, 'A', 'Regular', '', 'Confirmed', true, 'dan', '6/1/2026 09:00:00'],
      [12, '00100', 1, 100, 3, 'B', 'Regular', '', 'Suggested', false, '', ''],        // same number, other FO
      [13, '00100-R', 1, 100, 4, 'A', 'Redeliver', 11, 'Suggested', false, '', ''],   // parent was the merged row
    ],
  });
  assert.deepEqual(tables.waybills.map((w) => [w.id, w.waybill_number, w.status, w.confirmed_by, w.parent_waybill_id]), [
    [10, '00100', 'Confirmed', 'dan', null],
    [12, '00100', 'Suggested', null, null],
    [13, '00100-R', 'Suggested', null, 10],
  ]);
  assert.deepEqual(tables.trips.map((t) => t.waybill_id), [10, 10, 12, 13]);
});

test('waybills: a number+FO with mixed statuses fails the run', () => {
  assert.throws(() => transform({
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'], [1, '', 'AL', 100, true, 5]],
    Trips: [HEADERS.Trips, tripRow({ ID: 1, 'Trip Date': '6/1/2026', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' }),
      tripRow({ ID: 2, 'Trip Date': '6/1/2026', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' })],
    Waybills: [HEADERS.Waybills,
      [10, '00100', 1, 100, 1, 'A', 'Regular', '', 'Confirmed', true, '', ''],
      [11, '00100', 1, 100, 2, 'A', 'Regular', '', 'Suggested', false, '', ''],
    ],
  }), /mixed statuses on IDs 10, 11/);
});

test('strict: orphan trip FKs are cleared and reported; orphan log rows are dropped', () => {
  const { tables, report } = transform({
    Employees: [HEADERS.Employees, [5, 'Boy', '', '', '', 'Driver', true]],
    Trips: [HEADERS.Trips, tripRow({ ID: 1, 'Trip Date': '6/1/2026', 'Truck ID': 98, 'Driver ID': 5, 'Helper IDs': '5,6', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' })],
    'Route Frequency Log': [HEADERS['Route Frequency Log'], [1, 1, '6/1/2026', 5, 77], [2, 9, '6/1/2026', 5, 77]],
  });
  assert.equal(tables.trips[0].truck_id, null);
  assert.equal(tables.trips[0].driver_id, 5);
  assert.deepEqual(tables.trip_helpers.map((h) => h.employee_id), [5]);
  assert.equal(tables.route_frequency_log.length, 0);
  assert.equal(report.dropped.length, 4);
  assert.match(report.dropped[0], /Trips ID 1: truck 98 not found/);
});

test('freight rates go long (one row per non-blank band) and billing lines split their charges', () => {
  const bands = Array.from({ length: 25 }, (_, i) => (i === 0 ? 900 : i === 24 ? 1500 : ''));
  const { tables } = transform({
    'Freight Rates': [HEADERS['Freight Rates'], [3, 'Cabuyao', 'Sta. Rosa', '6W', '1/1/2026', ...bands]],
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'], [1, '', 'AL', 100, true, 5]],
    Trips: [HEADERS.Trips, tripRow({ ID: 1, 'Trip Date': '6/1/2026', 'FO Number': 'A', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' })],
    Waybills: [HEADERS.Waybills, [10, '00100', 1, 100, 1, 'A', 'Regular', '', 'Confirmed', true, '', '']],
    'Billing Lines': [HEADERS['Billing Lines'],
      [1, '00100', 10, '6/1/2026', '6/1/2026', 'Cabuyao', 'AAA', 'A', '6W', 'Sta. Rosa', 1, 100, 61, '150.01-155', 1500, 392, 0,
        '{"1":150,"3":0,"x":5}', 2042, '', 'Billed', '[]', '', 'p', '6/2/2026 09:00:00', '', ''],
    ],
  });
  assert.deepEqual(tables.freight_rates.map((r) => [r.area_key, r.band, r.rate]), [['STAROSA', 1, 900], ['STAROSA', 25, 1500]]);
  assert.equal(tables.billing_lines[0].waybill_id, 10);
  assert.equal(tables.billing_lines[0].rate_band, 25);
  assert.deepEqual(tables.billing_line_charges, [{ billing_line_id: 1, charge_type_id: 1, amount: 150 }]);
});

test('the transformed rows satisfy the schema with foreign keys on', () => {
  const { db, raw } = makeEnv({
    sheets: {
      'Billing Categories': [HEADERS['Billing Categories'], [1, '6W', true]],
      Employees: [HEADERS.Employees, [5, 'Boy', '', '', '', 'Driver', true], [6, 'Jun', '', '', '', 'Helper', true]],
      Trucks: [HEADERS.Trucks, [1, 'AAA', '', '', true, '6W']],
      'Default Assignments': [HEADERS['Default Assignments'], [1, 1, 5, '6', '']],
      Outlets: [HEADERS.Outlets, [1, 'O', 'A', '', '', '', '6/1/2026']],
      'Waybill Prefixes': [HEADERS['Waybill Prefixes'], [1, '', 'AL', 100, true, 5]],
      Trips: [HEADERS.Trips, tripRow({ ID: 1, 'Trip Date': '6/1/2026', 'Outlet ID': 1, 'Truck ID': 1, 'Driver ID': 5, 'Helper IDs': '6', 'FO Number': 'A', 'Added By': 'd', 'Added At': '6/1/2026 08:00:00' })],
      Waybills: [HEADERS.Waybills, [10, '00100', 1, 100, 1, 'A', 'Regular', '', 'Suggested', false, '', '']],
      'Route Frequency Log': [HEADERS['Route Frequency Log'], [1, 1, '6/1/2026', 5, 1]],
      'Audit Log': [HEADERS['Audit Log'], [1, '2026-06-01T00:00:00.000Z', 'd', 'TRIP_CREATE', '', 'Trips', 1, '', 'x']],
    },
  });
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(dump(db, 'audit_log')[0].ts, '2026-06-01 08:00:00');
});

const SNAPSHOT = path.join(__dirname, '..', 'data', 'sheets-snapshot.json');
test('the real snapshot transforms without a hard error', { skip: !fs.existsSync(SNAPSHOT) && 'no data/sheets-snapshot.json' }, () => {
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const { tables, report } = transform(snap);
  assert.equal(tables.trips.length, snap.Trips.length - 1);
  assert.ok(tables.waybills.length <= snap.Waybills.length - 1);
  assert.ok(Array.isArray(report.dropped));
});
