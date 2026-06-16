// ============================================================
//  Rebisco route-file import — importRouteFile, deleteImportedTrip,
//  and _resolveOrCreateOutlet (DataWriters.gs / Internals.gs).
//  The batched import is the trickiest writer: it seeds outlets,
//  pre-fills crew from defaults, and numbers waybills in-memory.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function importSheets(extra = {}) {
  return Object.assign(
    {
      Users: usersSheet(),
      Outlets: emptySheet('Outlets'),
      Trucks: [
        HEADERS.Trucks.slice(),
        [3, 'ABC-123', 'Isuzu', '6W', true, '6W'], // matches restriction "6W"
      ],
      'Default Assignments': [
        HEADERS['Default Assignments'].slice(),
        [1, 3, 9, '21,22', ''], // truck 3 -> driver 9, helpers 21,22
      ],
      Trips: emptySheet('Trips'),
      Waybills: emptySheet('Waybills'),
      'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 40]],
      'Route Frequency Log': emptySheet('Route Frequency Log'),
      'Audit Log': emptySheet('Audit Log'),
    },
    extra
  );
}

function asDispatcher(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
}

const ROWS = [
  { foNumber: 'FO-1', outletName: 'Outlet Alpha', area: 'Cavite', restrictions: '6W', quantity: 10, cbm: 2, tier: 1 },
  { foNumber: 'FO-2', outletName: 'Outlet Beta', area: 'Laguna', restrictions: '4W', quantity: 5, cbm: 1, tier: 2 },
  { foNumber: 'FO-3', outletName: 'outlet alpha', area: 'Cavite', restrictions: '6W', quantity: 8, cbm: 1, tier: 1 },
];

test('importRouteFile imports every row and numbers waybills sequentially', () => {
  const { api, ss } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', 1, ROWS);

  assert.equal(res.success, true);
  assert.equal(res.imported, 3);
  assert.equal(res.skipped, 0);

  const wbs = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  // prefix started at 40 -> 41, 42, 43
  assert.deepEqual(wbs.map((w) => w['Waybill Number']), ['AL-41', 'AL-42', 'AL-43']);
  assert.ok(wbs.every((w) => w.Status === 'Suggested' && w.Locked === false));
});

test('importRouteFile seeds new outlets once and dedupes case-insensitively', () => {
  const { api, ss } = asDispatcher(importSheets());
  api.importRouteFile('6/16/2026', 1, ROWS);

  const outlets = dump(ss, 'Outlets').rows.map((r) => rowObject(HEADERS.Outlets, r));
  // "Outlet Alpha" and "outlet alpha" collapse to one; plus "Outlet Beta" = 2 total
  assert.equal(outlets.length, 2);
  const names = outlets.map((o) => o['Outlet Name']).sort();
  assert.deepEqual(names, ['Outlet Alpha', 'Outlet Beta']);

  // Both alpha trips point at the same outlet id
  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  const alphaTrips = trips.filter((t) => ['FO-1', 'FO-3'].includes(t['FO Number']));
  assert.equal(alphaTrips[0]['Outlet ID'], alphaTrips[1]['Outlet ID']);
});

test('importRouteFile pre-fills truck/driver/helpers from defaults when restriction matches', () => {
  const { api, ss } = asDispatcher(importSheets());
  api.importRouteFile('6/16/2026', 1, ROWS);
  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));

  const sixW = trips.find((t) => t['FO Number'] === 'FO-1'); // restriction 6W -> truck 3
  assert.equal(Number(sixW['Truck ID']), 3);
  assert.equal(Number(sixW['Driver ID']), 9);
  assert.equal(sixW['Helper IDs'], '21,22');
  assert.equal(sixW['Truck Billing Category'], '6W');
  assert.equal(sixW['Billing Date'], '6/16/2026'); // = trip date on import

  const fourW = trips.find((t) => t['FO Number'] === 'FO-2'); // restriction 4W -> no truck
  assert.equal(fourW['Truck ID'], '');
  assert.equal(fourW['Driver ID'], '');
});

test('importRouteFile logs route frequency only for rows with a resolved driver', () => {
  const { api, ss } = asDispatcher(importSheets());
  api.importRouteFile('6/16/2026', 1, ROWS);
  // Only the two 6W rows (FO-1, FO-3) get a driver -> 2 route-freq rows.
  assert.equal(dump(ss, 'Route Frequency Log').rows.length, 2);
});

test('importRouteFile skips blank rows', () => {
  const { api } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', 1, [
    { foNumber: '', outletName: '' },
    { foNumber: 'FO-9', outletName: 'Outlet Z', restrictions: '6W' },
  ]);
  assert.equal(res.imported, 1);
  assert.equal(res.skipped, 1);
});

test('importRouteFile fails cleanly for an unknown prefix', () => {
  const { api } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', 999, ROWS);
  assert.equal(res.success, false);
  assert.match(res.errors[0], /not found/);
});

test('importRouteFile is gated by ADD_MANUAL_TRIP permission', () => {
  const { api } = makeEnv({ sheets: importSheets(), userEmail: EMAIL.Viewer });
  assert.throws(() => api.importRouteFile('6/16/2026', 1, ROWS), /Access denied/);
});

// ---------------- deleteImportedTrip ----------------

function withTripAndWaybill(locked) {
  const sheets = importSheets({
    Trips: [
      HEADERS.Trips.slice(),
      HEADERS.Trips.map((h) => (h === 'ID' ? 70 : h === 'FO Number' ? 'FO-700' : '')),
    ],
    Waybills: [
      HEADERS.Waybills.slice(),
      [80, 'AL-50', 1, 50, 70, 'FO-700', 'Regular', '', locked ? 'Confirmed' : 'Suggested', locked, '', ''],
    ],
  });
  return asDispatcher(sheets);
}

test('deleteImportedTrip removes the trip and its suggested waybills', () => {
  const { api, ss } = withTripAndWaybill(false);
  const res = api.deleteImportedTrip(70);
  assert.equal(res.success, true);
  assert.equal(dump(ss, 'Trips').rows.length, 0);
  assert.equal(dump(ss, 'Waybills').rows.length, 0); // suggested waybill cleaned up
});

test('deleteImportedTrip refuses to delete a trip with a confirmed waybill', () => {
  const { api, ss } = withTripAndWaybill(true);
  const res = api.deleteImportedTrip(70);
  assert.equal(res.success, false);
  assert.match(res.error, /confirmed waybill/);
  assert.equal(dump(ss, 'Trips').rows.length, 1); // untouched
});

// ---------------- _resolveOrCreateOutlet ----------------

test('_resolveOrCreateOutlet returns existing id (case-insensitive) or creates one', () => {
  const sheets = importSheets({
    Outlets: [HEADERS.Outlets.slice(), [5, 'Puregold Imus', 'Cavite', '', '', '', '6/1/2026']],
  });
  const { api, ss } = asDispatcher(sheets);

  assert.equal(api._resolveOrCreateOutlet('  puregold imus ', 'Cavite', ''), 5); // matched
  assert.equal(dump(ss, 'Outlets').rows.length, 1);

  const newId = api._resolveOrCreateOutlet('Brand New Outlet', 'Laguna', 'Addr');
  assert.equal(newId, 6); // next id
  assert.equal(dump(ss, 'Outlets').rows.length, 2);

  assert.equal(api._resolveOrCreateOutlet('', 'X', 'Y'), ''); // empty name -> ''
});
