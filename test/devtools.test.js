// ============================================================
//  DevTools.gs — devDump / devClear endpoint tests
//  These are token-gated data-destroying/exporting endpoints used
//  by scripts/fetch-sheet-data.js and scripts/clear-sheet-data.js;
//  the token gate and the "clear only transactional sheets, keep
//  headers" contract are what must never regress.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');

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
