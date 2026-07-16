// ============================================================
//  Dispatch board reorder + bulk status — DataWriters.gs
//  reorderTrips: persists Sort Order = index*10 for a given id list.
//  bulkSetTripStatus: applies one status to many trips by re-calling
//  saveTripChanges per id, so the carry-over spawn keeps firing.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function tripRow(fields) {
  const defaults = { 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'Trip Status': 'Prepping', Source: 'Import' };
  return HEADERS.Trips.map((h) => (fields[h] !== undefined ? fields[h] : (defaults[h] !== undefined ? defaults[h] : '')));
}

function baseSheets(tripRows) {
  return {
    Users: usersSheet(),
    Trips: [HEADERS.Trips.slice(), ...tripRows],
    Waybills: emptySheet('Waybills'),
    'Route Frequency Log': emptySheet('Route Frequency Log'),
    'Audit Log': emptySheet('Audit Log'),
  };
}

function asDispatcher(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
}

// ---------------- reorderTrips ----------------

test('reorderTrips writes Sort Order = index*10 for the given ids in order', () => {
  const { api, ss } = asDispatcher(
    baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2 }), tripRow({ ID: 3 })])
  );

  const res = api.reorderTrips('6/16/2026', [3, 1, 2]);
  assert.equal(res.success, true);

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.equal(Number(trips.find((t) => Number(t.ID) === 3)['Sort Order']), 0);
  assert.equal(Number(trips.find((t) => Number(t.ID) === 1)['Sort Order']), 10);
  assert.equal(Number(trips.find((t) => Number(t.ID) === 2)['Sort Order']), 20);
});

test('reorderTrips leaves trips not in the list untouched', () => {
  const { api, ss } = asDispatcher(
    baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2, 'Sort Order': 99 })])
  );

  api.reorderTrips('6/16/2026', [1]);

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.equal(Number(trips.find((t) => Number(t.ID) === 1)['Sort Order']), 0);
  assert.equal(Number(trips.find((t) => Number(t.ID) === 2)['Sort Order']), 99); // untouched
});

test('reorderTrips rejects an unknown trip id', () => {
  const { api } = asDispatcher(baseSheets([tripRow({ ID: 1 })]));
  const res = api.reorderTrips('6/16/2026', [1, 99]);
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('reorderTrips is gated by ASSIGN_CREW permission', () => {
  const { api } = makeEnv({
    sheets: baseSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  assert.throws(() => api.reorderTrips('6/16/2026', [1]), /Access denied/);
});

// ---------------- bulkSetTripStatus ----------------

test('bulkSetTripStatus sets status on every trip and fires carry-over per trip', () => {
  const { api, ss } = asDispatcher(
    baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })])
  );

  const res = api.bulkSetTripStatus([1, 2], 'Redeliver');
  assert.equal(res.success, true);
  assert.equal(res.updated, 2);
  assert.equal(res.newTripIds.length, 2); // one carry-over spawned per trip

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.equal(trips.find((t) => Number(t.ID) === 1)['Trip Status'], 'Redeliver');
  assert.equal(trips.find((t) => Number(t.ID) === 2)['Trip Status'], 'Redeliver');

  // The spawned carry-over rows exist, linked back to their parents.
  res.newTripIds.forEach((newId) => {
    const carryOver = trips.find((t) => Number(t.ID) === Number(newId));
    assert.ok(carryOver, `expected a carry-over row for id ${newId}`);
    assert.equal(carryOver.Source, 'Carry-over');
    assert.ok([1, 2].includes(Number(carryOver['Parent Trip ID'])));
  });
});

test('bulkSetTripStatus is gated by ASSIGN_CREW permission', () => {
  const { api } = makeEnv({
    sheets: baseSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  assert.throws(() => api.bulkSetTripStatus([1], 'Redeliver'), /Access denied/);
});
