// ============================================================
//  DevTools.gs — devDump / devClear endpoint tests
//  These are token-gated data-destroying/exporting endpoints used
//  by scripts/fetch-sheet-data.js and scripts/clear-sheet-data.js;
//  the token gate and the "clear only transactional sheets, keep
//  headers" contract are what must never regress.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { emptySheet, usersSheet, EMAIL } = require('./fixtures');

const TOKEN = 'secret-token';

// Every transactional sheet devClear targets, seeded with one data row,
// plus master sheets that must survive a clear.
function seedSheets() {
  return {
    'Trips': [['ID', 'Trip Date'], [1, '7/15/2026']],
    'Outlets': [['ID', 'Outlet Name'], [1, 'SM North']],
    'Route Frequency Log': [['ID', 'Outlet ID'], [1, 1]],
    'Waybills': [['ID', 'Waybill Number'], [1, 'A-0001']],
    'Audit Log': [['ID', 'Action'], [1, 'CREATE']],
    'Employees': [['ID', 'Full Name'], [1, 'Juan Dela Cruz']],
    'Waybill Prefixes': [['ID', 'Prefix', 'Last Sequence Number'], [1, 'A', 42]],
  };
}

function makeGatedEnv(sheets) {
  return makeEnv({ sheets, scriptProperties: { DEV_DUMP_TOKEN: TOKEN } });
}

function body(output) {
  return JSON.parse(output.getContent());
}

// ---- token gate (shared by both endpoints) ----
test('devDump/devClear: wrong or missing token is forbidden and clears nothing', () => {
  const { api, ss } = makeGatedEnv(seedSheets());
  for (const params of [{}, { token: 'nope' }]) {
    assert.deepEqual(body(api._devDump(params)), { error: 'forbidden' });
    assert.deepEqual(body(api._devClear(params)), { error: 'forbidden' });
  }
  assert.equal(dump(ss, 'Trips').rows.length, 1); // data untouched
});

test('devDump/devClear: forbidden when no token is configured, even with a matching guess', () => {
  const { api } = makeEnv({ sheets: seedSheets() }); // no script properties
  assert.deepEqual(body(api._devDump({ token: undefined })), { error: 'forbidden' });
  assert.deepEqual(body(api._devClear({ token: undefined })), { error: 'forbidden' });
});

// ---- devDump ----
test('devDump: dumps all sheets with a valid token', () => {
  const { api } = makeGatedEnv(seedSheets());
  const result = body(api._devDump({ token: TOKEN }));
  assert.deepEqual(Object.keys(result).sort(), Object.keys(seedSheets()).sort());
  assert.deepEqual(result['Trips'], [['ID', 'Trip Date'], [1, '7/15/2026']]);
});

test('devDump: single-sheet dump; unknown sheet returns null', () => {
  const { api } = makeGatedEnv(seedSheets());
  const one = body(api._devDump({ token: TOKEN, sheet: 'Outlets' }));
  assert.deepEqual(one, { Outlets: [['ID', 'Outlet Name'], [1, 'SM North']] });
  const missing = body(api._devDump({ token: TOKEN, sheet: 'Nope' }));
  assert.deepEqual(missing, { Nope: null });
});

// ---- devClear ----
test('devClear: clears data rows of transactional sheets, keeps headers, leaves masters alone', () => {
  const { api, ss } = makeGatedEnv(seedSheets());
  const result = body(api._devClear({ token: TOKEN }));

  const transactional = ['Trips', 'Outlets', 'Route Frequency Log', 'Waybills', 'Audit Log'];
  assert.deepEqual(result.cleared, transactional);

  for (const name of transactional) {
    const { headers, rows } = dump(ss, name);
    assert.equal(headers[0], 'ID', `${name} header row must survive`);
    assert.ok(rows.every((r) => r.every((c) => c === '')), `${name} data rows must be cleared`);
  }

  // Master data untouched — including the waybill sequence counter.
  assert.deepEqual(dump(ss, 'Employees').rows, [[1, 'Juan Dela Cruz']]);
  assert.deepEqual(dump(ss, 'Waybill Prefixes').rows, [[1, 'A', 42]]);
});

test('devClear: header-only and missing sheets are handled without error', () => {
  const sheets = seedSheets();
  sheets['Trips'] = [['ID', 'Trip Date']]; // already empty
  delete sheets['Audit Log']; // sheet missing entirely
  const { api } = makeGatedEnv(sheets);
  const result = body(api._devClear({ token: TOKEN }));
  assert.deepEqual(result.cleared, ['Trips', 'Outlets', 'Route Frequency Log', 'Waybills']);
});

// ---- doGet routing ----
test('doGet: routes action=devDump and action=devClear before the OAuth/page path', () => {
  const { api, ss } = makeGatedEnv(seedSheets());
  const dumped = body(api.doGet({ parameter: { action: 'devDump', token: TOKEN } }));
  assert.ok(dumped['Trips']);
  const cleared = body(api.doGet({ parameter: { action: 'devClear', token: TOKEN } }));
  assert.equal(cleared.cleared.length, 5);
  assert.ok(dump(ss, 'Trips').rows.every((r) => r.every((c) => c === '')));
});

// ---- clearAllData (the in-app Admin panel path) ----
// Same wipe as devClear, but reached over rpc() by a signed-in Admin, so the
// gates are RBAC + the typed confirmation phrase instead of a shared token.
const PHRASE = 'PERMANENTLY DELETE ALL DATA';

function makeAdminEnv(email) {
  const sheets = seedSheets();
  sheets['Users'] = usersSheet();
  sheets['Audit Log'] = emptySheet('Audit Log'); // real headers, so _auditLog can append
  return makeEnv({ sheets, userEmail: email || EMAIL.Admin });
}

test('clearAllData: an Admin with the exact phrase clears the transactional sheets', () => {
  const { api, ss } = makeAdminEnv();
  const result = api.clearAllData(PHRASE);

  assert.equal(result.success, true);
  // Spread: the value crosses the vm boundary, so it isn't a host Array.
  assert.deepEqual([...result.cleared], ['Trips', 'Outlets', 'Route Frequency Log', 'Waybills', 'Audit Log']);
  for (const name of ['Trips', 'Outlets', 'Route Frequency Log', 'Waybills']) {
    assert.ok(dump(ss, name).rows.every((r) => r.every((c) => c === '')), `${name} must be empty`);
  }
  // Master data survives, sequence counter included.
  assert.deepEqual(dump(ss, 'Waybill Prefixes').rows, [[1, 'A', 42]]);
});

test('clearAllData: the audit row is written after the wipe, so it survives', () => {
  const { api, ss } = makeAdminEnv();
  api.clearAllData(PHRASE);

  const { headers, rows } = dump(ss, 'Audit Log');
  const entries = rows.filter((r) => r[0] !== '').map((r) => rowObject(headers, r));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]['Action'], 'DATA_CLEAR');
  assert.equal(entries[0]['User'], EMAIL.Admin);
  assert.match(String(entries[0]['New Value']), /Trips/);
});

test('clearAllData: a wrong, empty or missing phrase deletes nothing', () => {
  for (const phrase of [undefined, null, '', 'permanently delete all data', 'DELETE ALL DATA']) {
    const { api, ss } = makeAdminEnv();
    const result = api.clearAllData(phrase);
    assert.equal(result.success, false, `phrase ${JSON.stringify(phrase)} must be rejected`);
    assert.match(result.error, /did not match/);
    assert.equal(dump(ss, 'Trips').rows.length, 1); // untouched
  }
});

test('clearAllData: surrounding whitespace in the phrase is tolerated', () => {
  const { api, ss } = makeAdminEnv();
  assert.equal(api.clearAllData(`  ${PHRASE}\n`).success, true);
  assert.ok(dump(ss, 'Trips').rows.every((r) => r.every((c) => c === '')));
});

test('clearAllData: non-Admins are refused before the phrase is even looked at', () => {
  for (const role of ['Dispatcher', 'Payroll', 'Viewer', 'Inactive', 'Unknown']) {
    const { api, ss } = makeAdminEnv(EMAIL[role]);
    assert.throws(() => api.clearAllData(PHRASE), /Access denied/, `${role} must be refused`);
    assert.equal(dump(ss, 'Trips').rows.length, 1);
  }
});
