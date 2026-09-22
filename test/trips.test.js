// ============================================================
//  Dispatch write path — createTrip + saveTripChanges
//  (server/writers/trips.js, ported from DataWriters.gs). The
//  dispatch board is Phase 1's primary screen, so these are the
//  highest-traffic mutations.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

/** Build a Trips row aligned to HEADERS.Trips from a {Header: value} map. */
function tripRow(values) {
  return HEADERS.Trips.map((h) => (h in values ? values[h] : ''));
}

function dispatchSheets(extra = {}) {
  return Object.assign(
    {
      Users: usersSheet(),
      Employees: [
        HEADERS.Employees.slice(),
        [8, 'Driver Eight', '', '', '', 'Driver', true],
        [9, 'Driver Nine', '', '', '', 'Driver', true],
      ],
      Outlets: emptySheet('Outlets'),
      Trucks: [
        HEADERS.Trucks.slice(),
        [3, 'ABC-123', 'Isuzu', '10W', true, '10W'],
        [4, 'XYZ-999', 'Fuso', '6W', true, '6W'],
      ],
      Trips: emptySheet('Trips'),
      Waybills: emptySheet('Waybills'),
      'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 5]],
      'Route Frequency Log': emptySheet('Route Frequency Log'),
      'Audit Log': emptySheet('Audit Log'),
    },
    extra
  );
}

function asDispatcher(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
}

const trip = (db, id) => dump(db, 'trips').find((t) => t.id === id);

// ---------------- createTrip ----------------

test('createTrip seeds a new outlet, snapshots billing category, suggests a waybill', async () => {
  const { api, db } = asDispatcher(dispatchSheets());

  const res = await api.createTrip({
    outletName: 'SM Dasmariñas',
    area: 'Cavite',
    address: 'Gov. Dr.',
    truckId: 3, // category 10W
    driverId: 9,
    foNumber: 'FO-100',
    prefixId: 1,
    tripDate: '6/16/2026',
  });

  assert.equal(res.success, true);
  assert.equal(res.tripId, 1);
  assert.equal(res.waybillSuggested, 'AL-6');

  const t = trip(db, 1);
  assert.equal(t.outlet_id, 1); // outlet auto-created -> id 1
  assert.equal(t.truck_billing_category, '10W'); // snapshot from truck
  assert.equal(t.billing_date, '2026-06-16'); // defaults to trip date
  assert.equal(t.source, 'Manual');

  // side effects
  assert.equal(dump(db, 'outlets').length, 1);
  assert.equal(dump(db, 'route_frequency_log').length, 1);
  const wb = dump(db, 'waybills')[0];
  assert.equal(wb.status, 'Suggested');
});

test('createTrip reuses an existing outlet case-insensitively (no duplicate)', async () => {
  const sheets = dispatchSheets({
    Outlets: [HEADERS.Outlets.slice(), [7, 'SM North', 'QC', '', '', '', '6/1/2026']],
  });
  const { api, db } = asDispatcher(sheets);

  const res = await api.createTrip({ outletName: 'sm north', area: 'QC', truckId: 4, prefixId: 1 });
  assert.equal(res.success, true);

  const t = trip(db, res.tripId);
  assert.equal(t.outlet_id, 7); // matched existing
  assert.equal(dump(db, 'outlets').length, 1); // no new outlet
});

test('createTrip without a prefix creates no waybill', async () => {
  const { api, db } = asDispatcher(dispatchSheets());
  const res = await api.createTrip({ outletName: 'Outlet A', truckId: 3 });
  assert.equal(res.success, true);
  assert.equal(res.waybillSuggested, '');
  assert.equal(dump(db, 'waybills').length, 0);
});

test('createTrip is gated by ADD_MANUAL_TRIP permission', async () => {
  const { api } = makeEnv({ sheets: dispatchSheets(), userEmail: EMAIL.Viewer });
  await assert.rejects(() => api.createTrip({ outletName: 'X' }), /Access denied/);
});

// ---------------- saveTripChanges ----------------

function withExistingTrip(extra = {}) {
  const sheets = dispatchSheets(
    Object.assign(
      {
        Trips: [
          HEADERS.Trips.slice(),
          tripRow({
            ID: 50,
            'Trip Date': '6/16/2026',
            'Billing Date': '6/16/2026',
            'FO Number': 'FO-500',
            'Outlet ID': 12,
            Area: 'Cavite',
            'Truck ID': 3,
            'Driver ID': 8,
            'Truck Billing Category': '10W',
            'Trip Status': 'Scheduled',
            Source: 'Import',
          }),
        ],
        Outlets: [HEADERS.Outlets.slice(), [12, 'SM Dasma', 'Cavite', '', '', '', '6/1/2026']],
      },
      extra
    )
  );
  return asDispatcher(sheets);
}

test('saveTripChanges keeps the trip billing category fixed when the truck changes', async () => {
  const { api, db } = withExistingTrip();
  const res = await api.saveTripChanges(50, { truckId: 4 }); // truck 4 = 6W
  assert.equal(res.success, true);

  const t = trip(db, 50);
  assert.equal(t.truck_id, 4);
  // Required truck type is snapshotted at dispatch and must not re-price
  // when a physical truck is reassigned.
  assert.equal(t.truck_billing_category, '10W');
});

test('saveTripChanges stamps Status Changed By/At on a status change', async () => {
  const { api, db } = withExistingTrip();
  const res = await api.saveTripChanges(50, { tripStatus: 'Delivered' });
  assert.equal(res.success, true);

  const t = trip(db, 50);
  assert.equal(t.trip_status, 'Delivered');
  assert.equal(t.status_changed_by, EMAIL.Dispatcher);
  assert.notEqual(t.status_changed_at, null);
});

test('saveTripChanges spawns a carry-over trip on Redeliver', async () => {
  const { api, db } = withExistingTrip();
  const before = dump(db, 'trips').length;

  const res = await api.saveTripChanges(50, { tripStatus: 'Redeliver' });
  assert.equal(res.success, true);
  assert.ok(res.newTripId, 'expected a carry-over trip id');

  const after = dump(db, 'trips');
  assert.equal(after.length, before + 1);
  const carry = after.find((t) => t.id === res.newTripId);
  assert.equal(carry.parent_trip_id, 50);
  assert.equal(carry.billing_date, '2026-06-16'); // preserved from parent
});

// Two saves of the same status in flight at once (two dispatchers, or a
// retry while the first is still running) both read the old status.
test('two Redeliver saves in flight spawn one carry-over, not two', async () => {
  const { api, db } = withExistingTrip();
  const before = dump(db, 'trips').length;

  const [a, b] = await Promise.all([
    api.saveTripChanges(50, { tripStatus: 'Redeliver' }),
    api.saveTripChanges(50, { tripStatus: 'Redeliver' }),
  ]);
  assert.equal(a.success && b.success, true);
  assert.equal([a.newTripId, b.newTripId].filter(Boolean).length, 1);
  assert.equal(dump(db, 'trips').length, before + 1);
  assert.equal(dump(db, 'audit_log').filter((r) => r.action === 'TRIP_STATUS_CHANGE').length, 1);
});

test('saveTripChanges does not spawn a carry-over trip on Preload', async () => {
  const { api, db } = withExistingTrip();
  const before = dump(db, 'trips').length;

  const res = await api.saveTripChanges(50, { tripStatus: 'Preload' });
  assert.equal(res.success, true);
  assert.equal(res.newTripId, null);

  const after = dump(db, 'trips');
  assert.equal(after.length, before);
  assert.equal(after[0].trip_status, 'Preload');
});

// The route-frequency window is measured against the real clock (todayPH()),
// so fixtures must be dated relative to now — a hardcoded date ages out of it.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// getRouteFrequencyForDriver joins route_frequency_log to trips(trip_date)
// (route_frequency_log itself carries no date in the D1 schema), so each
// logged trip id needs a real Trips row dated inside the 21-day window.
function recentTripRows(ids, recentDate) {
  return ids.map((id) => tripRow({
    ID: id, 'Trip Date': recentDate, 'Billing Date': recentDate, 'Outlet ID': 12, 'Driver ID': 9, 'Trip Status': 'Delivered',
  }));
}

test('saveTripChanges warns when a driver exceeds the route-frequency threshold', async () => {
  // 5 recent trips for driver 9 to outlet 12; reassigning makes it the 6th.
  const recent = daysAgo(3);
  const priorTripIds = [101, 102, 103, 104, 105];
  const freqRows = [HEADERS['Route Frequency Log'].slice()];
  priorTripIds.forEach((tripId, i) => freqRows.push([i + 1, tripId, recent, 9, 12]));

  const { api } = withExistingTrip({
    'Route Frequency Log': freqRows,
    Trips: [HEADERS.Trips.slice(), tripRow({
      ID: 50, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-500',
      'Outlet ID': 12, Area: 'Cavite', 'Truck ID': 3, 'Driver ID': 8,
      'Truck Billing Category': '10W', 'Trip Status': 'Scheduled', Source: 'Import',
    }), ...recentTripRows(priorTripIds, recent)],
  });
  const res = await api.saveTripChanges(50, { driverId: 9 }); // old driver was 8
  assert.equal(res.success, true);
  assert.ok(res.routeFrequencyWarning, 'expected a route-frequency warning');
  assert.equal(res.routeFrequencyWarning.count, 6);
  assert.equal(res.routeFrequencyWarning.outletName, 'SM Dasma');
});

test('saveTripChanges does not warn below the threshold', async () => {
  const recent = daysAgo(3);
  const freqRows = [HEADERS['Route Frequency Log'].slice(), [1, 101, recent, 9, 12]];
  const { api } = withExistingTrip({
    'Route Frequency Log': freqRows,
    Trips: [HEADERS.Trips.slice(), tripRow({
      ID: 50, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-500',
      'Outlet ID': 12, Area: 'Cavite', 'Truck ID': 3, 'Driver ID': 8,
      'Truck Billing Category': '10W', 'Trip Status': 'Scheduled', Source: 'Import',
    }), ...recentTripRows([101], recent)],
  });
  const res = await api.saveTripChanges(50, { driverId: 9 }); // becomes 2nd assignment
  assert.equal(res.routeFrequencyWarning, null);
});

// Route frequency counts trips that were actually scheduled — a Prepping trip's
// crew is still being shuffled, so nothing is logged until it leaves Prepping.
async function withPreppingTrip(extra = {}) {
  const { api, db } = withExistingTrip(extra);
  await api.run(`UPDATE trips SET trip_status = 'Prepping' WHERE id = 50`);
  return { api, db };
}

test('saveTripChanges does not log route frequency while the trip is Prepping', async () => {
  const { api, db } = await withPreppingTrip();
  const res = await api.saveTripChanges(50, { driverId: 9 }); // reassign, still Prepping
  assert.equal(res.success, true);
  assert.equal(dump(db, 'route_frequency_log').length, 0);
  assert.equal(res.routeFrequencyWarning, null);
});

test('saveTripChanges logs route frequency when a Prepping trip is scheduled', async () => {
  const { api, db } = await withPreppingTrip();
  const res = await api.saveTripChanges(50, { tripStatus: 'Scheduled' }); // no driver change
  assert.equal(res.success, true);

  const rows = dump(db, 'route_frequency_log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trip_id, 50);
  assert.equal(rows[0].driver_id, 8);   // the driver it carried into Scheduled
  assert.equal(rows[0].outlet_id, 12);
});

test('saveTripChanges logs route frequency once when scheduling with a new driver', async () => {
  const { api, db } = await withPreppingTrip();
  const res = await api.saveTripChanges(50, { driverId: 9, tripStatus: 'Scheduled' });
  assert.equal(res.success, true);

  const rows = dump(db, 'route_frequency_log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].driver_id, 9);
});

test('saveTripChanges suggests a waybill when a Prepping trip is scheduled with a prefix', async () => {
  const { api, db } = await withPreppingTrip();
  const res = await api.saveTripChanges(50, { tripStatus: 'Scheduled', prefixId: 1 });
  assert.equal(res.success, true);
  assert.equal(res.trip.waybillSuggested, 'AL-6'); // last seq 5 + 1
  assert.ok(res.trip.suggestedWaybillId);

  const rows = dump(db, 'waybills');
  assert.equal(rows.length, 1);
  assert.equal(trip(db, 50).waybill_id, rows[0].id);
  assert.equal(rows[0].status, 'Suggested');

  // Suggesting reserves the number.
  assert.equal(dump(db, 'waybill_prefixes')[0].last_sequence_number, 6);
});

test('saveTripChanges joins the load\'s suggested waybill instead of reserving a new number', async () => {
  // Trip 51: same FO + truck + date as trip 50, already Scheduled with a
  // Suggested waybill. Scheduling 50 must ride AL-3, even with no prefix.
  const { api, db } = await withPreppingTrip({
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 50, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-500', 'Outlet ID': 12, 'Truck ID': 3, 'Driver ID': 8, 'Trip Status': 'Scheduled', Source: 'Import' }),
      tripRow({ ID: 51, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-500', 'Outlet ID': 12, 'Truck ID': 3, 'Driver ID': 8, 'Trip Status': 'Scheduled', Source: 'Import' }),
    ],
    Waybills: [
      HEADERS.Waybills.slice(),
      [1, 'AL-3', 1, 3, 51, 'FO-500', 'Regular', '', 'Suggested', false, '', ''],
    ],
  });

  const res = await api.saveTripChanges(50, { tripStatus: 'Scheduled' });
  assert.equal(res.success, true);
  assert.equal(res.trip.waybillSuggested, 'AL-3');

  const wbs = dump(db, 'waybills');
  assert.equal(wbs.length, 1); // one row per load, shared
  assert.equal(trip(db, 50).waybill_id, trip(db, 51).waybill_id);

  // No new number reserved for the join.
  assert.equal(dump(db, 'waybill_prefixes')[0].last_sequence_number, 5);
});

test('saveTripChanges without a prefix schedules the trip but suggests no waybill', async () => {
  const { api, db } = await withPreppingTrip();
  const res = await api.saveTripChanges(50, { tripStatus: 'Scheduled' });
  assert.equal(res.success, true);
  assert.equal(res.trip.tripStatus, 'Scheduled');
  assert.equal(dump(db, 'waybills').length, 0);
});

test('saveTripChanges does not duplicate an existing waybill on scheduling', async () => {
  const { api, db } = await withPreppingTrip({
    Waybills: [
      HEADERS.Waybills.slice(),
      [1, 'AL-3', 1, 3, 50, 'FO-500', 'Regular', '', 'Suggested', false, '', ''],
    ],
  });
  const res = await api.saveTripChanges(50, { tripStatus: 'Scheduled', prefixId: 1 });
  assert.equal(res.success, true);
  assert.equal(dump(db, 'waybills').length, 1);
  assert.equal(res.trip.waybillSuggested, undefined);
});

test('saveTripChanges does not re-log route frequency on a later status change', async () => {
  const { api, db } = withExistingTrip();   // already Scheduled
  await api.saveTripChanges(50, { tripStatus: 'Delivered' });
  assert.equal(dump(db, 'route_frequency_log').length, 0);
});

test('saveTripChanges is gated by ASSIGN_CREW permission', async () => {
  const { api } = makeEnv({ sheets: dispatchSheets(), userEmail: EMAIL.Viewer });
  await assert.rejects(() => api.saveTripChanges(1, { truckId: 4 }), /Access denied/);
});

test('saveTripChanges reports a clear error for an unknown trip', async () => {
  const { api } = withExistingTrip();
  const res = await api.saveTripChanges(9999, { remarks: 'x' });
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});
