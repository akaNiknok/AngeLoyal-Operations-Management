// ============================================================
//  Rebisco route-file import — importRouteFile and
//  _resolveOrCreateOutlet (server/writers/import.js, ported from
//  DataWriters.gs / Internals.gs). The batched import is the trickiest
//  writer: it seeds outlets, pre-fills crew from defaults, and lands
//  trips in Prepping (waybills come later, via markDayScheduled).
//
//  deleteImportedTrip / bulkDeleteTrips tests were NOT ported here —
//  those two functions belong to writers/trips.js (W1), still a stub
//  in this tree. Port them alongside that module.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function importSheets(extra = {}) {
  return Object.assign(
    {
      Users: usersSheet(),
      Employees: [
        HEADERS.Employees.slice(),
        [9, 'Driver Nine', '', '', '', 'Driver', true],
        [10, 'Driver Ten', '', '', '', 'Driver', true],
        [21, 'Helper Two-One', '', '', '', 'Helper', true],
        [22, 'Helper Two-Two', '', '', '', 'Helper', true],
      ],
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

const helperIdsOf = (db, tripId) =>
  dump(db, 'trip_helpers').filter((h) => h.trip_id === tripId).sort((a, b) => a.slot - b.slot)
    .map((h) => h.employee_id);

// Truck type lives in the per-type "slots"; "restrictions" is the separate
// client constraint column. Route Type Map (self-seeded) maps 6WC/4WC -> 6W.
const ROWS = [
  { foNumber: 'FO-1', outletName: 'Outlet Alpha', area: 'Cavite', restrictions: '6W', quantity: 10, cbm: 2, tier: 1, slots: [{ type: '6WC', count: 1 }] },
  { foNumber: 'FO-2', outletName: 'Outlet Beta', area: 'Laguna', restrictions: '4W', quantity: 5, cbm: 1, tier: 2, slots: [{ type: '4WC', count: 1 }] },
  { foNumber: 'FO-3', outletName: 'outlet alpha', area: 'Cavite', restrictions: '6W', quantity: 8, cbm: 1, tier: 1, slots: [{ type: '6WC', count: 1 }] },
];

test('importRouteFile imports every row as Prepping with no waybills yet', async () => {
  const { api, db } = asDispatcher(importSheets());
  const res = await api.importRouteFile('6/16/2026', ROWS);

  assert.equal(res.success, true);
  assert.equal(res.imported, 3);
  assert.equal(res.skipped, 0);

  const trips = dump(db, 'trips');
  assert.ok(trips.every((t) => t.trip_status === 'Prepping'));
  // Waybills are suggested at day promotion (markDayScheduled), not import.
  assert.equal(dump(db, 'waybills').length, 0);
});

test('importRouteFile stamps the origin warehouse on every trip it writes', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS, 'TANZA');

  const trips = dump(db, 'trips');
  assert.ok(trips.length > 0);
  assert.ok(trips.every((t) => t.origin === 'TANZA'));
  // Sort Order stays blank — the board sets it by dragging.
  assert.ok(trips.every((t) => t.sort_order === null));
});

test('importRouteFile leaves Origin blank when none is given', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);

  const trips = dump(db, 'trips');
  assert.ok(trips.every((t) => t.origin === ''));
});

test('importRouteFile seeds new outlets once and dedupes case-insensitively', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);

  const outlets = dump(db, 'outlets');
  // "Outlet Alpha" and "outlet alpha" collapse to one; plus "Outlet Beta" = 2 total
  assert.equal(outlets.length, 2);
  const names = outlets.map((o) => o.outlet_name).sort();
  assert.deepEqual(names, ['Outlet Alpha', 'Outlet Beta']);

  // Both alpha trips point at the same outlet id
  const trips = dump(db, 'trips');
  const alphaTrips = trips.filter((t) => ['FO-1', 'FO-3'].includes(t.fo_number));
  assert.equal(alphaTrips[0].outlet_id, alphaTrips[1].outlet_id);
});

test('importRouteFile returns newly created outlets for the client to merge into its cache', async () => {
  const { api } = asDispatcher(importSheets());
  const res = await api.importRouteFile('6/16/2026', ROWS);

  // "Outlet Alpha" / "outlet alpha" dedupe to one outlet; "Outlet Beta" is
  // the other -> 2 distinct new outlets, not 3 rows.
  assert.equal(res.newOutlets.length, 2);
  const names = Array.from(res.newOutlets, (o) => o.outletName).sort();
  assert.deepEqual(names, ['Outlet Alpha', 'Outlet Beta']);
});

test('importRouteFile assigns the right truck type + default crew and distributes without double-booking', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);
  const trips = dump(db, 'trips');

  // FO-1 (6WC -> 6W) takes the first free 6W truck.
  const fo1 = trips.find((t) => t.fo_number === 'FO-1');
  assert.equal(fo1.truck_id, 3);
  assert.equal(fo1.driver_id, 9);
  assert.deepEqual(helperIdsOf(db, fo1.id), [21, 22]);
  assert.equal(fo1.truck_billing_category, '6W');
  assert.equal(fo1.billing_date, '2026-06-16'); // = trip date on import

  // FO-2 (4WC -> 6W) takes the next free 6W truck (not the same as FO-1).
  const fo2 = trips.find((t) => t.fo_number === 'FO-2');
  assert.equal(fo2.truck_id, 4);
  assert.equal(fo2.driver_id, 10);
  assert.equal(fo2.truck_billing_category, '6W');

  // FO-3 (6WC -> 6W) finds no free 6W truck left -> unassigned, but the
  // required category is still recorded so the dispatcher sees the type.
  const fo3 = trips.find((t) => t.fo_number === 'FO-3');
  assert.equal(fo3.truck_id, null);
  assert.equal(fo3.driver_id, null);
  assert.equal(fo3.truck_billing_category, '6W');
});

test('importRouteFile keeps Restrictions distinct from the resolved truck type', async () => {
  const { api, db } = asDispatcher(importSheets());
  // Restriction column says "6W" but the truck-type column is 4WC (-> 6W).
  await api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-R', outletName: 'Outlet R', restrictions: '6W', slots: [{ type: '4WC', count: 1 }] },
  ]);
  const trip = dump(db, 'trips')[0];
  assert.equal(trip.restrictions, '6W');             // client constraint, verbatim
  assert.equal(trip.truck_billing_category, '6W');   // resolved truck type via map
});

test('importRouteFile rides a truck\'s multiple outlet rows on one truck', async () => {
  const { api, db } = asDispatcher(importSheets());
  // One FO, two outlet rows; the 2nd row has no type column (continuation),
  // so it rides the same truck (multi-drop load).
  await api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-M', outletName: 'Stop One', slots: [{ type: '6WC', count: 1 }] },
    { foNumber: 'FO-M', outletName: 'Stop Two', slots: [] },
  ]);
  const trips = dump(db, 'trips');

  assert.equal(trips.length, 2);
  assert.equal(trips[0].truck_id, 3);
  assert.equal(trips[1].truck_id, 3); // continuation inherits the truck
});

test('importRouteFile creates one trip per truck for a multi-truck FO', async () => {
  const { api, db } = asDispatcher(importSheets());
  // One outlet, two trucks of the same type requested (count 2).
  await api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-T', outletName: 'Big Outlet', slots: [{ type: '6WC', count: 2 }] },
  ]);
  const trips = dump(db, 'trips');

  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map((t) => t.truck_id).sort(), [3, 4]);
});

test('importRouteFile logs no route frequency — trips land Prepping, not scheduled', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);
  // Crew is still shuffleable while Prepping; markDayScheduled does the logging.
  assert.equal(dump(db, 'route_frequency_log').length, 0);
});

test('importRouteFile skips blank rows', async () => {
  const { api } = asDispatcher(importSheets());
  const res = await api.importRouteFile('6/16/2026', [
    { foNumber: '', outletName: '' },
    { foNumber: 'FO-9', outletName: 'Outlet Z', restrictions: '6W' },
  ]);
  assert.equal(res.imported, 1);
  assert.equal(res.skipped, 1);
});

test('importRouteFile persists convoy groups, offset past the date\'s existing tokens', async () => {
  // A pre-existing same-date trip already uses convoy token 2.
  const existing = HEADERS.Trips.map((h) =>
    h === 'ID' ? 60
      : h === 'Trip Date' ? '6/16/2026'
      : h === 'Billing Date' ? '6/16/2026'
      : h === 'Convoy Group' ? '2'
      : h === 'Trip Status' ? 'Prepping'
      : h === 'Source' ? 'Import'
      : h === 'Added By' ? 'seed@angeloyal.com'
      : h === 'Added At' ? '6/1/2026 00:00:00'
      : ''
  );
  const { api, db } = asDispatcher(importSheets({ Trips: [HEADERS.Trips.slice(), existing] }));

  await api.importRouteFile('6/16/2026', [
    { foNumber: 'FO-A', outletName: 'Outlet A', slots: [{ type: '6WC', count: 1 }], convoyGroup: '1' },
    { foNumber: 'FO-B', outletName: 'Outlet B', slots: [{ type: '4WC', count: 1 }], convoyGroup: '1' },
    { foNumber: 'FO-C', outletName: 'Outlet C', slots: [{ type: '6WC', count: 1 }] },
  ]);

  const trips = dump(db, 'trips');
  // Incoming token 1 offsets past the existing max (2) -> 3.
  assert.equal(trips.find((t) => t.fo_number === 'FO-A').convoy_group, '3');
  assert.equal(trips.find((t) => t.fo_number === 'FO-B').convoy_group, '3');
  assert.equal(trips.find((t) => t.fo_number === 'FO-C').convoy_group, '');
});

test('importRouteFile is gated by ADD_MANUAL_TRIP permission', async () => {
  const { api } = makeEnv({ sheets: importSheets(), userEmail: EMAIL.Viewer });
  await assert.rejects(() => api.importRouteFile('6/16/2026', ROWS), /Access denied/);
});

// ---------------- re-import idempotency ----------------
// The transport cannot guarantee the client sees the response. A long import
// that times out on the way back is written all the same, and the dispatcher
// retries — which once put three copies of one route file on one board.

test('re-importing the same file on the same date adds nothing', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);
  const afterFirst = dump(db, 'trips').length;

  const res = await api.importRouteFile('6/16/2026', ROWS);

  assert.equal(res.success, true);
  assert.equal(res.imported, 0);
  assert.equal(res.duplicates, 3);
  assert.equal(res.skipped, 3);
  assert.equal(dump(db, 'trips').length, afterFirst); // no second copy
});

test('a third attempt still adds nothing', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);
  await api.importRouteFile('6/16/2026', ROWS);
  await api.importRouteFile('6/16/2026', ROWS);
  assert.equal(dump(db, 'trips').length, 3); // not 9
});

test('a second import brings in only the FOs the date does not have', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);

  const mixed = ROWS.concat([
    { foNumber: 'FO-9', outletName: 'Outlet Gamma', area: 'Batangas', restrictions: '6W',
      quantity: 4, cbm: 1, tier: 1, slots: [{ type: '6WC', count: 1 }] },
  ]);
  const res = await api.importRouteFile('6/16/2026', mixed);

  assert.equal(res.imported, 1);     // only FO-9
  assert.equal(res.duplicates, 3);
  assert.equal(dump(db, 'trips').length, 4);
});

test('the same FO on a DIFFERENT date still imports', async () => {
  const { api, db } = asDispatcher(importSheets());
  await api.importRouteFile('6/16/2026', ROWS);
  const res = await api.importRouteFile('6/17/2026', ROWS);

  assert.equal(res.imported, 3);     // dedupe is per date, not global
  assert.equal(res.duplicates, 0);
  assert.equal(dump(db, 'trips').length, 6);
});

test('blank-FO rows are never deduped — they have no key', async () => {
  const blanks = [
    { foNumber: '', outletName: 'Walk-in A', area: 'Cavite', quantity: 1, cbm: 1, slots: [{ type: '6WC', count: 1 }] },
    { foNumber: '', outletName: 'Walk-in B', area: 'Cavite', quantity: 1, cbm: 1, slots: [{ type: '6WC', count: 1 }] },
  ];
  const { api, db } = asDispatcher(importSheets());
  const res = await api.importRouteFile('6/16/2026', blanks);
  assert.equal(res.imported, 2);
  assert.equal(res.duplicates, 0);
  assert.equal(dump(db, 'trips').length, 2);
});

// ---------------- _resolveOrCreateOutlet ----------------

test('_resolveOrCreateOutlet returns existing id (case-insensitive) or creates one', async () => {
  const sheets = importSheets({
    Outlets: [HEADERS.Outlets.slice(), [5, 'Puregold Imus', 'Cavite', '', '', '', '6/1/2026']],
  });
  const { api, db } = asDispatcher(sheets);

  assert.equal(await api._resolveOrCreateOutlet('  puregold imus ', 'Cavite', ''), 5); // matched
  assert.equal(dump(db, 'outlets').length, 1);

  const newId = await api._resolveOrCreateOutlet('Brand New Outlet', 'Laguna', 'Addr');
  assert.equal(newId, 6); // next id
  assert.equal(dump(db, 'outlets').length, 2);

  assert.equal(await api._resolveOrCreateOutlet('', 'X', 'Y'), ''); // empty name -> ''
});

// Another request lands a trip and an outlet between the import's reads and
// its batch. The import must not have claimed their ids in advance.
test('importRouteFile survives trips and outlets written while it runs', async () => {
  const { api, db } = asDispatcher(importSheets());
  const [imp, manual] = await Promise.all([
    api.importRouteFile('6/16/2026', ROWS),
    api.createTrip({ tripDate: '6/16/2026', foNumber: 'FO-M', outletName: 'Outlet Beta', area: 'Laguna' }),
  ]);
  assert.equal(imp.success, true, (imp.errors || []).join());
  assert.equal(manual.success, true, manual.error);
  assert.equal(imp.imported, 3);

  const trips = dump(db, 'trips');
  assert.equal(trips.length, 4);
  const beta = dump(db, 'outlets').filter((o) => o.outlet_name === 'Outlet Beta');
  assert.equal(beta.length, 1, 'one Outlet Beta, shared by both writers');
  assert.equal(trips.find((t) => t.fo_number === 'FO-2').outlet_id, beta[0].id);
  assert.equal(imp.newOutlets.find((o) => o.outletName === 'Outlet Beta').id, beta[0].id);

  // Helpers land on their own trip, found inside the batch.
  const t1 = trips.find((t) => t.fo_number === 'FO-1');
  assert.deepEqual(helperIdsOf(db, t1.id), [21, 22]);
  // The audit rows name the real trip ids.
  const audited = dump(db, 'audit_log').filter((r) => r.action === 'TRIP_CREATE').map((r) => r.row_id).sort();
  assert.deepEqual(audited, trips.map((t) => t.id).sort());
});

test('importRouteFile refuses a trip date it cannot read', async () => {
  const { api, db } = asDispatcher(importSheets());
  const res = await api.importRouteFile('16/6/2026', ROWS);
  assert.equal(res.success, false);
  assert.match(res.errors[0], /M\/d\/yyyy/);
  assert.equal(dump(db, 'trips').length, 0);
});
