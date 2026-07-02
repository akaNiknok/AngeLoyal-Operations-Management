// ============================================================
//  Dispatch write path — createTrip + saveTripChanges
//  (DataWriters.gs). The dispatch board is Phase 1's primary
//  screen, so these are the highest-traffic mutations.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

/** Build a Trips row aligned to HEADERS.Trips from a {Header: value} map. */
function tripRow(values) {
  return HEADERS.Trips.map((h) => (h in values ? values[h] : ''));
}

function dispatchSheets(extra = {}) {
  return Object.assign(
    {
      Users: usersSheet(),
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

// ---------------- createTrip ----------------

test('createTrip seeds a new outlet, snapshots billing category, suggests a waybill', () => {
  const { api, ss } = asDispatcher(dispatchSheets());

  const res = api.createTrip({
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

  const trip = rowObject(...firstRow(ss, 'Trips'));
  assert.equal(Number(trip['Outlet ID']), 1); // outlet auto-created -> id 1
  assert.equal(trip['Truck Billing Category'], '10W'); // snapshot from truck
  assert.equal(trip['Billing Date'], '6/16/2026'); // defaults to trip date
  assert.equal(trip.Source, 'Manual');

  // side effects
  assert.equal(dump(ss, 'Outlets').rows.length, 1);
  assert.equal(dump(ss, 'Route Frequency Log').rows.length, 1);
  const wb = rowObject(...firstRow(ss, 'Waybills'));
  assert.equal(wb.Status, 'Suggested');
});

test('createTrip reuses an existing outlet case-insensitively (no duplicate)', () => {
  const sheets = dispatchSheets({
    Outlets: [HEADERS.Outlets.slice(), [7, 'SM North', 'QC', '', '', '', '6/1/2026']],
  });
  const { api, ss } = asDispatcher(sheets);

  const res = api.createTrip({ outletName: 'sm north', area: 'QC', truckId: 4, prefixId: 1 });
  assert.equal(res.success, true);

  const trip = rowObject(...firstRow(ss, 'Trips'));
  assert.equal(Number(trip['Outlet ID']), 7); // matched existing
  assert.equal(dump(ss, 'Outlets').rows.length, 1); // no new outlet
});

test('createTrip without a prefix creates no waybill', () => {
  const { api, ss } = asDispatcher(dispatchSheets());
  const res = api.createTrip({ outletName: 'Outlet A', truckId: 3 });
  assert.equal(res.success, true);
  assert.equal(res.waybillSuggested, '');
  assert.equal(dump(ss, 'Waybills').rows.length, 0);
});

test('createTrip is gated by ADD_MANUAL_TRIP permission', () => {
  const { api } = makeEnv({ sheets: dispatchSheets(), userEmail: EMAIL.Viewer });
  assert.throws(() => api.createTrip({ outletName: 'X' }), /Access denied/);
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

test('saveTripChanges re-snapshots the billing category when the truck changes', () => {
  const { api, ss } = withExistingTrip();
  const res = api.saveTripChanges(50, { truckId: 4 }); // truck 4 = 6W
  assert.equal(res.success, true);

  const trip = rowObject(...firstRow(ss, 'Trips'));
  assert.equal(Number(trip['Truck ID']), 4);
  assert.equal(trip['Truck Billing Category'], '6W'); // re-snapshotted
});

test('saveTripChanges stamps Status Changed By/At on a status change', () => {
  const { api, ss } = withExistingTrip();
  const res = api.saveTripChanges(50, { tripStatus: 'Delivered' });
  assert.equal(res.success, true);

  const trip = rowObject(...firstRow(ss, 'Trips'));
  assert.equal(trip['Trip Status'], 'Delivered');
  assert.equal(trip['Status Changed By'], EMAIL.Dispatcher);
  assert.notEqual(trip['Status Changed At'], '');
});

test('saveTripChanges spawns a carry-over trip on Redeliver', () => {
  const { api, ss } = withExistingTrip();
  const before = dump(ss, 'Trips').rows.length;

  const res = api.saveTripChanges(50, { tripStatus: 'Redeliver' });
  assert.equal(res.success, true);
  assert.ok(res.newTripId, 'expected a carry-over trip id');

  const after = dump(ss, 'Trips');
  assert.equal(after.rows.length, before + 1);
  const carry = after.rows.map((r) => rowObject(after.headers, r)).find((t) => Number(t.ID) === res.newTripId);
  assert.equal(Number(carry['Parent Trip ID']), 50);
  assert.equal(carry['Billing Date'], '6/16/2026'); // preserved from parent
});

test('saveTripChanges does not spawn a carry-over trip on Preload', () => {
  const { api, ss } = withExistingTrip();
  const before = dump(ss, 'Trips').rows.length;

  const res = api.saveTripChanges(50, { tripStatus: 'Preload' });
  assert.equal(res.success, true);
  assert.equal(res.newTripId, null);

  const after = dump(ss, 'Trips');
  assert.equal(after.rows.length, before);
  assert.equal(rowObject(after.headers, after.rows[0])['Trip Status'], 'Preload');
});

test('saveTripChanges warns when a driver exceeds the route-frequency threshold', () => {
  // 5 recent trips for driver 9 to outlet 12; reassigning makes it the 6th.
  const today = '6/16/2026';
  const freqRows = [HEADERS['Route Frequency Log'].slice()];
  for (let i = 1; i <= 5; i++) freqRows.push([i, 100 + i, today, 9, 12]);

  const { api } = withExistingTrip({ 'Route Frequency Log': freqRows });
  const res = api.saveTripChanges(50, { driverId: 9 }); // old driver was 8
  assert.equal(res.success, true);
  assert.ok(res.routeFrequencyWarning, 'expected a route-frequency warning');
  assert.equal(res.routeFrequencyWarning.count, 6);
  assert.equal(res.routeFrequencyWarning.outletName, 'SM Dasma');
});

test('saveTripChanges does not warn below the threshold', () => {
  const today = '6/16/2026';
  const freqRows = [HEADERS['Route Frequency Log'].slice(), [1, 101, today, 9, 12]];
  const { api } = withExistingTrip({ 'Route Frequency Log': freqRows });
  const res = api.saveTripChanges(50, { driverId: 9 }); // becomes 2nd assignment
  assert.equal(res.routeFrequencyWarning, null);
});

test('saveTripChanges is gated by ASSIGN_CREW permission', () => {
  const { api } = makeEnv({ sheets: dispatchSheets(), userEmail: EMAIL.Viewer });
  assert.throws(() => api.saveTripChanges(1, { truckId: 4 }), /Access denied/);
});

test('saveTripChanges reports a clear error for an unknown trip', () => {
  const { api } = withExistingTrip();
  const res = api.saveTripChanges(9999, { remarks: 'x' });
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

// --- helper: first data row of a sheet as [headers, row] ---
function firstRow(ss, sheetName) {
  const { headers, rows } = dump(ss, sheetName);
  return [headers, rows[0]];
}
