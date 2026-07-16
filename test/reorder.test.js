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

test('bulkSetTripStatus with a prefix reserves a distinct waybill number per load', () => {
  // Blank FO Numbers -> two separate loads -> two distinct reserved numbers.
  const sheets = baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })]);
  sheets['Waybill Prefixes'] = [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 5]];
  const { api, ss } = asDispatcher(sheets);

  const res = api.bulkSetTripStatus([1, 2], 'Scheduled', 1);
  assert.equal(res.success, true);
  assert.equal(res.updated, 2);

  const wbs = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.equal(wbs.length, 2);
  assert.deepEqual(wbs.map((w) => Number(w['Trip ID'])).sort(), [1, 2]);
  assert.deepEqual(wbs.map((w) => w['Waybill Number']).sort(), ['AL-6', 'AL-7']);
  wbs.forEach((w) => assert.equal(w.Status, 'Suggested'));

  const pref = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0]);
  assert.equal(pref['Last Sequence Number'], 7); // both numbers reserved
});

test('bulkSetTripStatus shares one waybill number across the stops of one load', () => {
  // Same FO Number + Truck ID + Trip Date = one truck load = one waybill.
  const sheets = baseSheets([
    tripRow({ ID: 1, 'FO Number': 'FO-9', 'Truck ID': 3 }),
    tripRow({ ID: 2, 'FO Number': 'FO-9', 'Truck ID': 3 }),
  ]);
  sheets['Waybill Prefixes'] = [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 5]];
  const { api, ss } = asDispatcher(sheets);

  const res = api.bulkSetTripStatus([1, 2], 'Scheduled', 1);
  assert.equal(res.success, true);

  const wbs = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.equal(wbs.length, 2); // one row per stop...
  assert.deepEqual(wbs.map((w) => w['Waybill Number']), ['AL-6', 'AL-6']); // ...sharing one number

  const pref = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0]);
  assert.equal(pref['Last Sequence Number'], 6); // only one number reserved
});

test('bulkSetTripStatus is gated by ASSIGN_CREW permission', () => {
  const { api } = makeEnv({
    sheets: baseSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  assert.throws(() => api.bulkSetTripStatus([1], 'Redeliver'), /Access denied/);
});
