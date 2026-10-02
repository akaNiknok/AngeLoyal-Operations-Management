// ============================================================
//  The History button's reader: the audit trail of one trip or
//  billing line, with the rows of its waybill. Pins which rows
//  belong, the v1 sheet names, and the per-table permission.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet, EMAIL } = require('./fixtures');

const log = (id, table, rowId, action) => ({
  id, ts: `2026-09-2${id % 10} 08:00:00`, user_email: EMAIL.Dispatcher, action,
  table_name: table, row_id: rowId, old_value: '', new_value: `v${id}`,
});

function env(email = EMAIL.Admin) {
  return makeEnv({
    sheets: { Users: usersSheet() },
    userEmail: email,
    tables: {
      waybill_prefixes: [{ id: 1, prefix: 'AY', company_name: 'AngeLoyal' }],
      waybills: [{ id: 7, waybill_number: 'AY-1', prefix_id: 1, sequence_number: 1, waybill_type: 'Regular', status: 'Confirmed' }],
      trips: [5, 6].map((id) => ({
        id, trip_date: '2026-09-21', billing_date: '2026-09-21', trip_status: 'Delivered',
        source: 'Import', added_by: EMAIL.Dispatcher, added_at: '2026-09-21 08:00:00', waybill_id: id === 5 ? 7 : null,
      })),
      billing_lines: [{
        id: 9, waybill_id: 7, trip_date: '2026-09-21', billing_date: '2026-09-21', drops: 1, cartons: 10,
        added_by: EMAIL.Payroll, added_at: '2026-09-22 08:00:00',
      }],
      audit_log: [
        log(1, 'Trips', 5, 'TRIP_CREATE'),            // a v1 row keeps the sheet name
        log(2, 'trips', 5, 'TRIP_STATUS_CHANGE'),
        log(3, 'waybills', 7, 'WAYBILL_CONFIRM'),
        log(4, 'trips', 6, 'TRIP_STATUS_CHANGE'),     // another trip
        log(5, 'outlets', 5, 'OUTLET_EDIT'),          // same id, another table
        log(6, 'billing_lines', 9, 'BILLING_LINE_EDIT'),
      ],
    },
  });
}

test('a trip shows its own rows, v1 rows and its waybill, newest first', async () => {
  const r = await env().api.getRowHistory('trips', 5);
  assert.deepEqual(r.entries.map((e) => e.id), [3, 2, 1]);
  assert.equal(r.hasMore, false);
});

test('a trip with no waybill shows only its own rows', async () => {
  const r = await env().api.getRowHistory('trips', 6);
  assert.deepEqual(r.entries.map((e) => e.id), [4]);
});

test('a billing line shows its own rows and its waybill', async () => {
  const r = await env(EMAIL.Payroll).api.getRowHistory('billing_lines', 9);
  assert.deepEqual(r.entries.map((e) => e.id), [6, 3]);
});

test('each table is gated by its own permission', async () => {
  // Everyone sees the board, so everyone may read a trip's history.
  await env(EMAIL.Viewer).api.getRowHistory('trips', 5);
  for (const who of [EMAIL.Dispatcher, EMAIL.Viewer]) {
    await assert.rejects(() => env(who).api.getRowHistory('billing_lines', 9), /Access denied/, who);
  }
});

test('any other table is refused, so client text never reaches the SQL', async () => {
  for (const t of ['outlets', 'audit_log', 'trips; DROP TABLE trips', 'constructor']) {
    await assert.rejects(() => env().api.getRowHistory(t, 5), /No history/, t);
  }
});
