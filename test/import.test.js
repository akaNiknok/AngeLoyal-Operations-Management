// ============================================================
//  Rebisco route-file import — importRouteFile, deleteImportedTrip,
//  and _resolveOrCreateOutlet (DataWriters.gs / Internals.gs).
//  The batched import is the trickiest writer: it seeds outlets,
//  pre-fills crew from defaults, and lands trips in Prepping
//  (waybills come later, via markDayScheduled).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function importSheets(extra = {}) {
  return Object.assign(
    {
      Users: usersSheet(),
      Outlets: emptySheet('Outlets'),
      Trucks: [
        HEADERS.Trucks.slice(),
        [3, 'ABC-123', 'Isuzu', '6W', true, '6W'], // billing category 6W
        [4, 'DEF-456', 'Isuzu', '6W', true, '6W'], // billing category 6W
      ],
      'Default Assignments': [
        HEADERS['Default Assignments'].slice(),
        [1, 3, 9, '21,22', ''], // truck 3 -> driver 9, helpers 21,22
        [2, 4, 10, '', ''],     // truck 4 -> driver 10
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

// Truck type lives in the per-type "slots"; "restrictions" is the separate
// client constraint column. Route Type Map (self-seeded) maps 6WC/4WC -> 6W.
const ROWS = [
  { foNumber: 'FO-1', outletName: 'Outlet Alpha', area: 'Cavite', restrictions: '6W', quantity: 10, cbm: 2, tier: 1, slots: [{ type: '6WC', count: 1 }] },
  { foNumber: 'FO-2', outletName: 'Outlet Beta', area: 'Laguna', restrictions: '4W', quantity: 5, cbm: 1, tier: 2, slots: [{ type: '4WC', count: 1 }] },
  { foNumber: 'FO-3', outletName: 'outlet alpha', area: 'Cavite', restrictions: '6W', quantity: 8, cbm: 1, tier: 1, slots: [{ type: '6WC', count: 1 }] },
];

test('importRouteFile imports every row as Prepping with no waybills yet', () => {
  const { api, ss } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', ROWS);

  assert.equal(res.success, true);
  assert.equal(res.imported, 3);
  assert.equal(res.skipped, 0);

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.ok(trips.every((t) => t['Trip Status'] === 'Prepping'));
  // Waybills are suggested at day promotion (markDayScheduled), not import.
  assert.equal(dump(ss, 'Waybills').rows.length, 0);
});

test('importRouteFile seeds new outlets once and dedupes case-insensitively', () => {
  const { api, ss } = asDispatcher(importSheets());
  api.importRouteFile('6/16/2026', ROWS);

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

test('importRouteFile returns newly created outlets for the client to merge into its cache', () => {
  const { api } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', ROWS);

  // "Outlet Alpha" / "outlet alpha" dedupe to one outlet; "Outlet Beta" is
  // the other -> 2 distinct new outlets, not 3 rows.
  assert.equal(res.newOutlets.length, 2);
  const names = Array.from(res.newOutlets, (o) => o.outletName).sort();
  assert.deepEqual(names, ['Outlet Alpha', 'Outlet Beta']);
});

test('importRouteFile assigns the right truck type + default crew and distributes without double-booking', () => {
  const { api, ss } = asDispatcher(importSheets());
  api.importRouteFile('6/16/2026', ROWS);
  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));

  // FO-1 (6WC -> 6W) takes the first free 6W truck.
  const fo1 = trips.find((t) => t['FO Number'] === 'FO-1');
  assert.equal(Number(fo1['Truck ID']), 3);
  assert.equal(Number(fo1['Driver ID']), 9);
  assert.equal(fo1['Helper IDs'], '21,22');
  assert.equal(fo1['Truck Billing Category'], '6W');
  assert.equal(fo1['Billing Date'], '6/16/2026'); // = trip date on import

  // FO-2 (4WC -> 6W) takes the next free 6W truck (not the same as FO-1).
  const fo2 = trips.find((t) => t['FO Number'] === 'FO-2');
  assert.equal(Number(fo2['Truck ID']), 4);
  assert.equal(Number(fo2['Driver ID']), 10);
  assert.equal(fo2['Truck Billing Category'], '6W');

  // FO-3 (6WC -> 6W) finds no free 6W truck left -> unassigned, but the
  // required category is still recorded so the dispatcher sees the type.
  const fo3 = trips.find((t) => t['FO Number'] === 'FO-3');
  assert.equal(fo3['Truck ID'], '');
  assert.equal(fo3['Driver ID'], '');
  assert.equal(fo3['Truck Billing Category'], '6W');
});

test('importRouteFile keeps Restrictions distinct from the resolved truck type', () => {
  const { api, ss } = asDispatcher(importSheets());
  // Restriction column says "6W" but the truck-type column is 4WC (-> 6W).
  api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-R', outletName: 'Outlet R', restrictions: '6W', slots: [{ type: '4WC', count: 1 }] },
  ]);
  const trip = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r))[0];
  assert.equal(trip['Restrictions'], '6W');             // client constraint, verbatim
  assert.equal(trip['Truck Billing Category'], '6W');   // resolved truck type via map
});

test('importRouteFile rides a truck\'s multiple outlet rows on one truck', () => {
  const { api, ss } = asDispatcher(importSheets());
  // One FO, two outlet rows; the 2nd row has no type column (continuation),
  // so it rides the same truck (multi-drop load).
  api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-M', outletName: 'Stop One', slots: [{ type: '6WC', count: 1 }] },
    { foNumber: 'FO-M', outletName: 'Stop Two', slots: [] },
  ]);
  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));

  assert.equal(trips.length, 2);
  assert.equal(Number(trips[0]['Truck ID']), 3);
  assert.equal(Number(trips[1]['Truck ID']), 3); // continuation inherits the truck
});

test('importRouteFile creates one trip per truck for a multi-truck FO', () => {
  const { api, ss } = asDispatcher(importSheets());
  // One outlet, two trucks of the same type requested (count 2).
  api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-T', outletName: 'Big Outlet', slots: [{ type: '6WC', count: 2 }] },
  ]);
  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));

  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map((t) => Number(t['Truck ID'])).sort(), [3, 4]);
});

test('importRouteFile logs no route frequency — trips land Prepping, not scheduled', () => {
  const { api, ss } = asDispatcher(importSheets());
  api.importRouteFile('6/16/2026', ROWS);
  // Crew is still shuffleable while Prepping; markDayScheduled does the logging.
  assert.equal(dump(ss, 'Route Frequency Log').rows.length, 0);
});

test('importRouteFile skips blank rows', () => {
  const { api } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', [
    { foNumber: '', outletName: '' },
    { foNumber: 'FO-9', outletName: 'Outlet Z', restrictions: '6W' },
  ]);
  assert.equal(res.imported, 1);
  assert.equal(res.skipped, 1);
});

test('importRouteFile persists convoy groups, offset past the date\'s existing tokens', () => {
  // A pre-existing same-date trip already uses convoy token 2.
  const existing = HEADERS.Trips.map((h) =>
    h === 'ID' ? 60 : h === 'Trip Date' ? '6/16/2026' : h === 'Convoy Group' ? '2' : h === 'Trip Status' ? 'Prepping' : ''
  );
  const { api, ss } = asDispatcher(importSheets({ Trips: [HEADERS.Trips.slice(), existing] }));

  api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-A', outletName: 'Outlet A', slots: [{ type: '6WC', count: 1 }], convoyGroup: '1' },
    { foNumber: 'FO-B', outletName: 'Outlet B', slots: [{ type: '4WC', count: 1 }], convoyGroup: '1' },
    { foNumber: 'FO-C', outletName: 'Outlet C', slots: [{ type: '6WC', count: 1 }] },
  ]);

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  // Incoming token 1 offsets past the existing max (2) -> 3.
  assert.equal(trips.find((t) => t['FO Number'] === 'FO-A')['Convoy Group'], '3');
  assert.equal(trips.find((t) => t['FO Number'] === 'FO-B')['Convoy Group'], '3');
  assert.equal(trips.find((t) => t['FO Number'] === 'FO-C')['Convoy Group'], '');
});

test('importRouteFile is gated by ADD_MANUAL_TRIP permission', () => {
  const { api } = makeEnv({ sheets: importSheets(), userEmail: EMAIL.Viewer });
  assert.throws(() => api.importRouteFile('6/16/2026', ROWS), /Access denied/);
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

// ---------------- parseRebiscoFile (web/import.js, client-side) --------------
// The convoy redistribution runs in the browser, before importRouteFile ever
// sees a row. Load the frontend's import module into a vm the same way the
// harness loads the .gs bundle. Only stub what top-level code touches.

function loadParseRebiscoFile() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'import.js'), 'utf8');
  const sandbox = { showToast() {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}
;globalThis.__parse = parseRebiscoFile;
;globalThis.__dropCount = dropCount;`, sandbox, {
    filename: 'web/import.js',
  });
  // Round-trip out of the vm's realm: its objects carry a different
  // Object.prototype, which deepStrictEqual counts as a mismatch.
  const parse = (raw) => JSON.parse(JSON.stringify(sandbox.__parse(raw)));
  parse.dropCount = (rows) => sandbox.__dropCount(rows); // the preview's count
  return parse;
}

// Mirrors the real file's shape: type columns sit between FREIGHT ORDER and TOTAL.
const RAW_HEADER = ['FREIGHT ORDER', 'L300', 'TOTAL', 'OUTLET', 'AREA'];
const MALL = 'SW FESTIVAL MALL ALABANG';
const truckCount = (rows) =>
  rows.reduce((sum, r) => sum + (r.slots || []).reduce((n, s) => n + s.count, 0), 0);

test('parseRebiscoFile hands convoy surplus to the following TOTAL=0 rows', () => {
  const parse = loadParseRebiscoFile();
  // Anchor asks for 3 L300s; two blank TOTAL=0 rows ride along -> 1 each.
  const rows = parse([
    RAW_HEADER,
    ['6100043752', 3, 3, MALL, 'Alabang'],
    ['6100043765', '', 0, MALL, 'Alabang'],
    ['6100043766', '', 0, MALL, 'Alabang'],
  ]);

  assert.deepEqual(rows[0].slots, [{ type: 'L300', count: 1 }]); // anchor keeps one
  assert.deepEqual(rows[1].slots, [{ type: 'L300', count: 1 }]);
  assert.deepEqual(rows[2].slots, [{ type: 'L300', count: 1 }]);
  assert.equal(truckCount(rows), 3);
});

test('parseRebiscoFile keeps surplus trucks on the anchor when recipients run out', () => {
  const parse = loadParseRebiscoFile();
  // The real ROUTE MAY 12 case: FO 6100043752 asks for 6 L300s but only 4
  // blank TOTAL=0 rows follow; row 6 has its own truck and ends the run.
  const rows = parse([
    RAW_HEADER,
    ['6100043752', 6, 6, MALL, 'Alabang'],
    ['6100043765', '', 0, MALL, 'Alabang'],
    ['6100043766', '', 0, MALL, 'Alabang'],
    ['437462', '', 0, MALL, 'Alabang'],
    ['437463', '', 0, MALL, 'Alabang'],
    ['437464', 1, 1, 'OTHER OUTLET', 'Cavite'], // own slots -> loop breaks here
  ]);

  // 1 unplaced surplus stays on the anchor rather than being dropped.
  assert.deepEqual(rows[0].slots, [{ type: 'L300', count: 2 }]);
  assert.equal(rows[0].displayType, '2×L300');
  rows.slice(1, 5).forEach((r) => assert.deepEqual(r.slots, [{ type: 'L300', count: 1 }]));
  assert.deepEqual(rows[5].slots, [{ type: 'L300', count: 1 }]); // untouched

  // 6 requested by the anchor + 1 for row 6 = 7 trucks, none lost.
  assert.equal(truckCount(rows), 7);
});

test('parseRebiscoFile keeps the whole convoy on the anchor when no recipient follows', () => {
  const parse = loadParseRebiscoFile();
  const rows = parse([RAW_HEADER, ['6100043752', 4, 4, MALL, 'Alabang']]);

  assert.deepEqual(rows[0].slots, [{ type: 'L300', count: 4 }]);
  assert.equal(truckCount(rows), 4);
});

test('the preview drop count is what importRouteFile actually creates', () => {
  // The ROUTE MAY 12 shape end to end: 6 preview rows (one FO spanning two
  // outlet rows, one convoy anchor keeping a surplus truck) -> the writer
  // emits one trip per truck per stop. The preview promises that number.
  const parse = loadParseRebiscoFile();
  const rows = parse([
    RAW_HEADER,
    ['6100043752', 6, 6, MALL, 'Alabang'],        // anchor: 6 trucks asked for
    ['6100043765', '', 0, MALL, 'Alabang'],       // riders take one each
    ['6100043766', '', 0, MALL, 'Alabang'],
    ['437462', '', 0, MALL, 'Alabang'],
    ['437463', '', 0, MALL, 'Alabang'],
    ['6100043739', 1, 1, 'SMCO TAYABAS', 'Quezon'],
    ['6100043739', '', 0, 'PG SARIAYA', 'Quezon'], // same FO, second stop
  ]);
  assert.equal(rows.length, 7);

  const { api } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', rows);

  assert.equal(res.success, true);
  assert.equal(res.imported, 8); // 7 rows + the anchor's unplaced 6th truck
  assert.equal(parse.dropCount(rows), res.imported);
});

test('drop count and row count agree when no FO asks for a second truck', () => {
  const parse = loadParseRebiscoFile();
  const { api } = asDispatcher(importSheets());
  const res = api.importRouteFile('6/16/2026', ROWS);

  assert.equal(parse.dropCount(ROWS), ROWS.length);
  assert.equal(res.imported, ROWS.length);
});
