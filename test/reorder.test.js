// ============================================================
//  Dispatch board reorder + bulk status — server/writers/trips.js
//  reorderTrips: persists Sort Order = index*10 for a given id list.
//  bulkSetTripStatus: applies one status to many trips by re-calling
//  saveTripChanges per id, so the carry-over spawn keeps firing.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
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

test('reorderTrips writes Sort Order = index*10 for the given ids in order', async () => {
  const { api, db } = asDispatcher(
    baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2 }), tripRow({ ID: 3 })])
  );

  const res = await api.reorderTrips('6/16/2026', [3, 1, 2]);
  assert.equal(res.success, true);

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 3).sort_order, 0);
  assert.equal(trips.find((t) => t.id === 1).sort_order, 10);
  assert.equal(trips.find((t) => t.id === 2).sort_order, 20);
});

test('reorderTrips leaves trips not in the list untouched', async () => {
  const { api, db } = asDispatcher(
    baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2, 'Sort Order': 99 })])
  );

  await api.reorderTrips('6/16/2026', [1]);

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 1).sort_order, 0);
  assert.equal(trips.find((t) => t.id === 2).sort_order, 99); // untouched
});

test('reorderTrips rejects an unknown trip id', async () => {
  const { api } = asDispatcher(baseSheets([tripRow({ ID: 1 })]));
  const res = await api.reorderTrips('6/16/2026', [1, 99]);
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('reorderTrips is gated by ASSIGN_CREW permission', async () => {
  const { api } = makeEnv({
    sheets: baseSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  await assert.rejects(() => api.reorderTrips('6/16/2026', [1]), /Access denied/);
});

// ---------------- bulkSetTripStatus ----------------

test('bulkSetTripStatus sets status on every trip and fires carry-over per trip', async () => {
  const { api, db } = asDispatcher(
    baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })])
  );

  const res = await api.bulkSetTripStatus([1, 2], 'Redeliver');
  assert.equal(res.success, true);
  assert.equal(res.updated, 2);
  assert.equal(res.newTripIds.length, 2); // one carry-over spawned per trip

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 1).trip_status, 'Redeliver');
  assert.equal(trips.find((t) => t.id === 2).trip_status, 'Redeliver');

  // The spawned carry-over rows exist, linked back to their parents.
  res.newTripIds.forEach((newId) => {
    const carryOver = trips.find((t) => t.id === newId);
    assert.ok(carryOver, `expected a carry-over row for id ${newId}`);
    assert.equal(carryOver.source, 'Carry-over');
    assert.ok([1, 2].includes(carryOver.parent_trip_id));
  });
});

test('setting the status a trip already has spawns no second carry-over', async () => {
  const { api, db } = asDispatcher(baseSheets([tripRow({ ID: 1 })]));

  const first = await api.saveTripChanges(1, { tripStatus: 'Redeliver' });
  assert.equal(first.newTripId > 0, true);
  const again = await api.saveTripChanges(1, { tripStatus: 'Redeliver' });
  assert.equal(again.success, true);
  assert.equal(again.newTripId, null);
  assert.equal(again.trip.tripStatus, 'Redeliver');

  assert.equal(dump(db, 'trips').length, 2); // the trip + ONE carry-over
  const statusAudits = dump(db, 'audit_log').filter((r) => r.action === 'TRIP_STATUS_CHANGE');
  assert.equal(statusAudits.length, 1);
});

test('bulkSetTripStatus with a prefix reserves a distinct waybill number per load', async () => {
  // Blank FO Numbers -> two separate loads -> two distinct reserved numbers.
  const sheets = baseSheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })]);
  sheets['Waybill Prefixes'] = [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 5]];
  const { api, db } = asDispatcher(sheets);

  const res = await api.bulkSetTripStatus([1, 2], 'Scheduled', 1);
  assert.equal(res.success, true);
  assert.equal(res.updated, 2);

  const trips = dump(db, 'trips');
  const wbs = dump(db, 'waybills');
  assert.equal(wbs.length, 2);
  assert.deepEqual(trips.filter((t) => t.waybill_id).map((t) => t.id).sort(), [1, 2]);
  assert.deepEqual(wbs.map((w) => w.waybill_number).sort(), ['AL-6', 'AL-7']);
  wbs.forEach((w) => assert.equal(w.status, 'Suggested'));

  assert.equal(dump(db, 'waybill_prefixes')[0].last_sequence_number, 7); // both numbers reserved
});

test('bulkSetTripStatus shares one waybill number across the stops of one load', async () => {
  // Same FO Number + Truck ID + Trip Date = one truck load = one waybill.
  const sheets = baseSheets([
    tripRow({ ID: 1, 'FO Number': 'FO-9', 'Truck ID': 3 }),
    tripRow({ ID: 2, 'FO Number': 'FO-9', 'Truck ID': 3 }),
  ]);
  sheets.Trucks = [HEADERS.Trucks.slice(), [3, 'ABC-123', 'Isuzu', '6W', true, '6W']];
  sheets['Waybill Prefixes'] = [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 5]];
  const { api, db } = asDispatcher(sheets);

  const res = await api.bulkSetTripStatus([1, 2], 'Scheduled', 1);
  assert.equal(res.success, true);

  const trips = dump(db, 'trips');
  const wbs = dump(db, 'waybills');
  assert.equal(wbs.length, 1); // one row shared by both stops
  assert.equal(trips.find((t) => t.id === 1).waybill_id, trips.find((t) => t.id === 2).waybill_id);
  assert.equal(wbs[0].waybill_number, 'AL-6');

  assert.equal(dump(db, 'waybill_prefixes')[0].last_sequence_number, 6); // only one number reserved
});

test('bulkSetTripStatus is gated by ASSIGN_CREW permission', async () => {
  const { api } = makeEnv({
    sheets: baseSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  await assert.rejects(() => api.bulkSetTripStatus([1], 'Redeliver'), /Access denied/);
});
