// ============================================================
//  clearAllData (server/writers/masters.js) — the in-app Admin panel's
//  "wipe this environment" path. DevTools.gs's token-gated _devDump/
//  _devClear and doGet routing have no D1 equivalent (they existed to
//  export/reset a Sheet from outside the app) and are dropped along with
//  clasp; see Docs/D1 Migration.md Phase 2. Only the wipe contract itself
//  — clear every transactional table, keep every master table, log the
//  wipe after it happens — carries forward.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { emptySheet, usersSheet, EMAIL } = require('./fixtures');

const PHRASE = 'PERMANENTLY DELETE ALL DATA';

// One row of transactional data per table clearAllData targets, plus master
// data (Employees, Waybill Prefixes with its sequence counter) that must survive.
function seedSheets() {
  return {
    Users: usersSheet(),
    'Audit Log': emptySheet('Audit Log'), // real headers, so _auditLog can append after the wipe
    Employees: [
      ['ID', 'Nickname', 'First Name', 'Middle Name', 'Last Name', 'Role', 'Active'],
      [1, 'Juan', '', '', 'Dela Cruz', 'Driver', true],
    ],
    'Waybill Prefixes': [
      ['ID', 'Prefix', 'Company Name', 'Last Sequence Number', 'Active', 'Sequence Width'],
      [1, 'A', 'AngeLoyal', 42, true, 4],
    ],
    Outlets: [
      ['ID', 'Outlet Name', 'Area', 'Address', 'Customer Group', 'Notes', 'Created At'],
      [1, 'SM North', 'Quezon City', '', '', '', '1/1/2026'],
    ],
    Trips: [
      ['ID', 'Trip Date', 'Billing Date', 'Added By', 'Added At', 'Trip Status', 'Source', 'Outlet ID'],
      [1, '7/15/2026', '7/15/2026', 'admin@angeloyal.com', '7/15/2026 08:00:00', 'Scheduled', 'Manual', 1],
    ],
    'Route Frequency Log': [
      ['ID', 'Trip ID', 'Driver ID', 'Outlet ID'],
      [1, 1, 1, 1],
    ],
    Waybills: [
      ['ID', 'Waybill Number', 'Prefix ID', 'Sequence Number', 'Trip ID', 'FO Number', 'Waybill Type', 'Status'],
      [1, 'A-0001', 1, 1, 1, 'FO1', 'Regular', 'Confirmed'],
    ],
    'Billing Lines': [
      [
        'ID', 'Waybill Number', 'Waybill ID', 'Trip Date', 'Billing Date', 'Drops', 'Cartons',
        'Hauling Rate', 'Mano', 'Drop Fee', 'Manual Charges', 'Total', 'Status', 'Added By', 'Added At',
      ],
      [1, 'A-0001', 1, '7/15/2026', '7/15/2026', 1, 10, 1000, 0, 0, JSON.stringify({ 10: 50 }), 1050, 'Not Billed', 'admin@angeloyal.com', '7/15/2026'],
    ],
    'Billing Charge Types': [['ID', 'Label', 'Sort Order', 'Active'], [10, 'Toll Fee', 10, true]],
  };
}

function makeAdminEnv(email) {
  return makeEnv({ sheets: seedSheets(), userEmail: email || EMAIL.Admin });
}

test('clearAllData: an Admin with the exact phrase clears every transactional table', async () => {
  const { api, db } = makeAdminEnv();
  const result = await api.clearAllData(PHRASE);

  assert.equal(result.success, true);
  assert.deepEqual(result.cleared, ['Trips', 'Outlets', 'Route Frequency Log', 'Waybills', 'Billing Lines', 'Audit Log']);

  for (const table of ['trips', 'trip_helpers', 'outlets', 'route_frequency_log', 'waybills',
    'billing_lines', 'billing_line_charges']) {
    assert.equal(dump(db, table).length, 0, `${table} must be empty`);
  }
  // Master data survives, sequence counter included.
  assert.equal(dump(db, 'employees').length, 1);
  const prefix = dump(db, 'waybill_prefixes')[0];
  assert.equal(prefix.last_sequence_number, 42);
  assert.equal(dump(db, 'billing_charge_types').length, 1);
});

test('clearAllData: the audit row is written after the wipe, so it survives', async () => {
  const { api, db } = makeAdminEnv();
  await api.clearAllData(PHRASE);

  const entries = dump(db, 'audit_log');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'DATA_CLEAR');
  assert.equal(entries[0].user_email, EMAIL.Admin);
  assert.match(String(entries[0].new_value), /Trips/);
});

test('clearAllData: a wrong, empty or missing phrase deletes nothing', async () => {
  for (const phrase of [undefined, null, '', 'permanently delete all data', 'DELETE ALL DATA']) {
    const { api, db } = makeAdminEnv();
    const result = await api.clearAllData(phrase);
    assert.equal(result.success, false, `phrase ${JSON.stringify(phrase)} must be rejected`);
    assert.match(result.error, /did not match/);
    assert.equal(dump(db, 'trips').length, 1); // untouched
  }
});

test('clearAllData: surrounding whitespace in the phrase is tolerated', async () => {
  const { api, db } = makeAdminEnv();
  assert.equal((await api.clearAllData(`  ${PHRASE}\n`)).success, true);
  assert.equal(dump(db, 'trips').length, 0);
});

test('clearAllData: non-Admins are refused before the phrase is even looked at', async () => {
  for (const role of ['Dispatcher', 'Payroll', 'Viewer', 'Inactive', 'Unknown']) {
    const { api, db } = makeAdminEnv(EMAIL[role]);
    await assert.rejects(api.clearAllData(PHRASE), /Access denied/, `${role} must be refused`);
    assert.equal(dump(db, 'trips').length, 1);
  }
});
