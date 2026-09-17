// ============================================================
//  deleteImportedTrip and bulkDeleteTrips (split out of the legacy
//  import suite for W1, the trips writer).
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

// ---------------- bulkDeleteTrips ----------------

function withThreeTrips() {
  const trip = (id, fo) =>
    HEADERS.Trips.map((h) => (h === 'ID' ? id : h === 'FO Number' ? fo : ''));
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

test('bulkDeleteTrips removes every selected trip and its suggested waybills', () => {
  const { api, ss } = withThreeTrips();
  const res = api.bulkDeleteTrips([70, 72]);

  assert.equal(res.success, true);
  assert.equal(res.deleted, 2);
  assert.equal(res.blocked.length, 0);
  const ids = dump(ss, 'Trips').rows.map((r) => Number(r[0]));
  assert.deepEqual(ids, [71]);
  // 70's suggested waybill went with it; 71's confirmed one stayed.
  const wbIds = dump(ss, 'Waybills').rows.map((r) => Number(r[0]));
  assert.deepEqual(wbIds, [81]);
});

// One refusal must not abort the rest — the dispatcher selected a block and
// expects everything deletable in it to go.
test('bulkDeleteTrips keeps a confirmed-waybill trip and still deletes the others', () => {
  const { api, ss } = withThreeTrips();
  const res = api.bulkDeleteTrips([70, 71, 72]);

  assert.equal(res.success, true);
  assert.equal(res.deleted, 2);
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].tripId, 71);
  assert.match(res.blocked[0].error, /confirmed waybill/);
  assert.deepEqual(dump(ss, 'Trips').rows.map((r) => Number(r[0])), [71]);
});

test('bulkDeleteTrips rejects an empty selection', () => {
  const { api } = withThreeTrips();
  const res = api.bulkDeleteTrips([]);
  assert.equal(res.success, false);
  assert.match(res.error, /No trips selected/);
});

test('bulkDeleteTrips is gated by ADD_MANUAL_TRIP permission', () => {
  const { api } = makeEnv({ sheets: withThreeTripsSheets(), userEmail: EMAIL.Viewer });
  assert.throws(() => api.bulkDeleteTrips([70]), /permission/i);
});

function withThreeTripsSheets() {
  const trip = (id, fo) =>
    HEADERS.Trips.map((h) => (h === 'ID' ? id : h === 'FO Number' ? fo : ''));
  return importSheets({
    Trips: [HEADERS.Trips.slice(), trip(70, 'FO-700'), trip(71, 'FO-701'), trip(72, 'FO-702')],
  });
}

