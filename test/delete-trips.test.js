// ============================================================
//  deleteImportedTrip and bulkDeleteTrips (server/writers/trips.js,
//  split out of the legacy import suite for W1, the trips writer).
//  D1 adds real FKs the Sheet never had: a Suggested waybill is
//  detached before the trip goes, and any carry-over child's
//  parent_trip_id back-link is cleared first.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
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

function trip(id, fo) {
  const f = { ID: id, 'FO Number': fo, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026' };
  return HEADERS.Trips.map((h) => (f[h] !== undefined ? f[h] : ''));
}

// ---------------- deleteImportedTrip ----------------

function withTripAndWaybill(locked) {
  const sheets = importSheets({
    Trips: [HEADERS.Trips.slice(), trip(70, 'FO-700')],
    Waybills: [
      HEADERS.Waybills.slice(),
      [80, 'AL-50', 1, 50, 70, 'FO-700', 'Regular', '', locked ? 'Confirmed' : 'Suggested', locked, '', ''],
    ],
  });
  return asDispatcher(sheets);
}

test('deleteImportedTrip removes the trip and its suggested waybills', async () => {
  const { api, db } = withTripAndWaybill(false);
  const res = await api.deleteImportedTrip(70);
  assert.equal(res.success, true);
  assert.equal(dump(db, 'trips').length, 0);
  assert.equal(dump(db, 'waybills').length, 0); // suggested waybill cleaned up
});

test('deleteImportedTrip refuses to delete a trip with a confirmed waybill', async () => {
  const { api, db } = withTripAndWaybill(true);
  const res = await api.deleteImportedTrip(70);
  assert.equal(res.success, false);
  assert.match(res.error, /confirmed waybill/);
  assert.equal(dump(db, 'trips').length, 1); // untouched
});

test('deleteImportedTrip clears a carry-over child\'s parent link so the FK does not block', async () => {
  const { api, db } = asDispatcher(importSheets({
    Trips: [HEADERS.Trips.slice(), trip(70, 'FO-700')],
  }));
  const child = await api._createCarryoverTrip(70, 'Backlog');
  assert.equal(dump(db, 'trips').find((t) => t.id === child).parent_trip_id, 70);

  const res = await api.deleteImportedTrip(70);
  assert.equal(res.success, true);
  assert.equal(dump(db, 'trips').find((t) => t.id === child).parent_trip_id, null);
});

// ---------------- bulkDeleteTrips ----------------

function withThreeTrips() {
  return asDispatcher(importSheets({
    Trips: [HEADERS.Trips.slice(), trip(70, 'FO-700'), trip(71, 'FO-701'), trip(72, 'FO-702')],
    Waybills: [
      HEADERS.Waybills.slice(),
      // 71 is confirmed — the bulk delete must keep it and take the others.
      [80, 'AL-50', 1, 50, 70, 'FO-700', 'Regular', '', 'Suggested', false, '', ''],
      [81, 'AL-51', 1, 51, 71, 'FO-701', 'Regular', '', 'Confirmed', true, '', ''],
    ],
  }));
}

test('bulkDeleteTrips removes every selected trip and its suggested waybills', async () => {
  const { api, db } = withThreeTrips();
  const res = await api.bulkDeleteTrips([70, 72]);

  assert.equal(res.success, true);
  assert.equal(res.deleted, 2);
  assert.equal(res.blocked.length, 0);
  assert.deepEqual(dump(db, 'trips').map((t) => t.id), [71]);
  // 70's suggested waybill went with it; 71's confirmed one stayed.
  assert.deepEqual(dump(db, 'waybills').map((w) => w.id), [81]);
});

// One refusal must not abort the rest — the dispatcher selected a block and
// expects everything deletable in it to go.
test('bulkDeleteTrips keeps a confirmed-waybill trip and still deletes the others', async () => {
  const { api, db } = withThreeTrips();
  const res = await api.bulkDeleteTrips([70, 71, 72]);

  assert.equal(res.success, true);
  assert.equal(res.deleted, 2);
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].tripId, 71);
  assert.match(res.blocked[0].error, /confirmed waybill/);
  assert.deepEqual(dump(db, 'trips').map((t) => t.id), [71]);
});

test('bulkDeleteTrips rejects an empty selection', async () => {
  const { api } = withThreeTrips();
  const res = await api.bulkDeleteTrips([]);
  assert.equal(res.success, false);
  assert.match(res.error, /No trips selected/);
});

test('bulkDeleteTrips is gated by ADD_MANUAL_TRIP permission', async () => {
  const { api } = makeEnv({ sheets: importSheets({
    Trips: [HEADERS.Trips.slice(), trip(70, 'FO-700'), trip(71, 'FO-701'), trip(72, 'FO-702')],
  }), userEmail: EMAIL.Viewer });
  await assert.rejects(() => api.bulkDeleteTrips([70]), /Access denied/);
});

// Redeliver on a trip whose waybill is still Suggested: the -R row names that
// waybill as its parent. Deleting the original trip must not trip the FK.
test('deleteImportedTrip works when a carry-over waybill names its waybill as parent', async () => {
  const { api, db } = withTripAndWaybill(false);
  const childTripId = await api._createCarryoverTrip(70, 'Redeliver');

  const res = await api.deleteImportedTrip(70);
  assert.equal(res.success, true, res.error);
  const wbs = dump(db, 'waybills');
  assert.deepEqual(wbs.map((w) => w.waybill_number), ['AL-50-R'], 'the carry-over keeps its number');
  assert.equal(wbs[0].parent_waybill_id, null);
  assert.equal(dump(db, 'trips').find((t) => t.id === childTripId).waybill_id, wbs[0].id);
});
