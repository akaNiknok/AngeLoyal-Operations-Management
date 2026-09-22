// ============================================================
//  server/readers.js — the read path and its frozen shapes.
//  getTrips date filtering, the dispatch-board waybill join, the
//  route-frequency window, getBootData, and the rebuilt shapes
//  (helper ids, default assignments, the rate grid, billing lines).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function tripRow(values) {
  return HEADERS.Trips.map((h) => (h in values ? values[h] : ''));
}

// ---------------- getTrips ----------------

test('getTrips returns only trips whose Trip Date falls in the range', async () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/14/2026', 'Billing Date': '6/14/2026', 'FO Number': 'A' }),
      tripRow({ ID: 2, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'B' }),
      tripRow({ ID: 3, 'Trip Date': '6/20/2026', 'Billing Date': '6/20/2026', 'FO Number': 'C' }),
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });

  const inRange = await api.getTrips('6/15/2026', '6/17/2026');
  assert.deepEqual(inRange.map((t) => t.id), [2]);
  // boundaries are inclusive
  assert.equal((await api.getTrips('6/14/2026', '6/20/2026')).length, 3);
});

test('getTrips rebuilds helperIds from trip_helpers, in slot order, and area from the outlet', async () => {
  const sheets = {
    Outlets: [HEADERS.Outlets.slice(), [12, 'SM Dasma', 'Cavite', '', 'SM', '', '6/1/2026']],
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'Helper IDs': '7,8,9', 'Outlet ID': 12, CBM: 3.638000000000001 }),
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const [trip] = await api.getTrips('6/16/2026', '6/16/2026');
  assert.deepEqual(trip.helperIds, [7, 8, 9]);
  assert.equal(trip.area, 'Cavite');
  assert.equal(trip.cbm, 3.638);
  assert.equal(trip.tripDate, '6/16/2026');
  assert.equal(trip.tripStatus, 'Scheduled');
});

test('getTrips returns convoyGroup as a string, blank when unset', async () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'Convoy Group': 3 }),
      tripRow({ ID: 2, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026' }),
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const trips = await api.getTrips('6/16/2026', '6/16/2026');
  assert.equal(trips.find((t) => t.id === 1).convoyGroup, '3');
  assert.equal(trips.find((t) => t.id === 2).convoyGroup, '');
});

test('getTrips emits timestamps in the client format', async () => {
  const { api } = makeEnv({
    tables: {
      trips: [{
        id: 5, trip_date: '2026-06-16', billing_date: '2026-06-15', trip_status: 'Delivered', source: 'Import',
        added_by: 'd@x', added_at: '2026-06-16 07:05:09', status_changed_at: '2026-06-16 18:30:00',
      }],
    },
    userEmail: EMAIL.Viewer,
  });
  const [t] = await api.getTrips('6/16/2026', '6/16/2026');
  assert.equal(t.addedAt, '6/16/2026 07:05:09');
  assert.equal(t.statusChangedAt, '6/16/2026 18:30:00');
  assert.equal(t.billingDate, '6/15/2026');
});

// ---------------- getDispatchBoardData ----------------

test('getDispatchBoardData joins each trip to its waybill: suggested or confirmed', async () => {
  const sheets = {
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 7, true, 0]],
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 50, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-50' }),
      tripRow({ ID: 51, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-51' }),
    ],
    Waybills: [
      HEADERS.Waybills.slice(),
      [90, 'AL-7', 1, 7, 50, 'FO-50', 'Regular', '', 'Suggested', false, '', ''],
      [91, 'AL-6', 1, 6, 51, 'FO-51', 'Regular', '', 'Confirmed', true, 'd', '6/16/2026 08:00:00'],
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });

  const board = await api.getDispatchBoardData('6/16/2026');
  assert.equal(board.date, '6/16/2026');
  assert.equal(board.trips.length, 2);

  const a = board.trips.find((t) => t.id === 50);
  assert.equal(a.waybillSuggested, 'AL-7');
  assert.equal(a.suggestedWaybillId, 90);
  assert.equal(a.waybillConfirmed, '');

  const b = board.trips.find((t) => t.id === 51);
  assert.equal(b.waybillConfirmed, 'AL-6');
  assert.equal(b.waybillSuggested, '');
  assert.equal(b.suggestedWaybillId, null);
});

test('getDispatchBoardData returns empty waybill fields when none exist', async () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 51, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026' }),
    ],
    Waybills: emptySheet('Waybills'),
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const t = (await api.getDispatchBoardData('6/16/2026')).trips[0];
  assert.equal(t.waybillSuggested, '');
  assert.equal(t.waybillConfirmed, '');
  assert.equal(t.suggestedWaybillId, null);
});

test('a load shares one waybill row: the stops of one number+FO all point at it', async () => {
  const sheets = {
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, '', 'AngeLoyal', 100, true, 5]],
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': '610001' }),
      tripRow({ ID: 2, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': '610001' }),
      tripRow({ ID: 3, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': '610002' }),
    ],
    Waybills: [
      HEADERS.Waybills.slice(),
      [10, '00100', 1, 100, 1, '610001', 'Regular', '', 'Suggested', false, '', ''],
      [11, '00100', 1, 100, 2, '610001', 'Regular', '', 'Suggested', false, '', ''],
      [12, '00100', 1, 100, 3, '610002', 'Regular', '', 'Suggested', false, '', ''],   // same number, other load
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const board = await api.getDispatchBoardData('6/16/2026');
  const wb = (id) => board.trips.find((t) => t.id === id).suggestedWaybillId;
  assert.equal(wb(1), 10);
  assert.equal(wb(2), 10, 'the second stop shares the first stop\'s waybill row');
  assert.equal(wb(3), 12, 'a different FO with the same number stays its own load');

  const forTrip = await api.getWaybillsForTrip(2);
  assert.equal(forTrip.length, 1);
  assert.equal(forTrip[0].waybillNumber, '00100');
  assert.equal(forTrip[0].tripId, 2);
  assert.equal(forTrip[0].foNumber, '610001');
  assert.equal(forTrip[0].locked, false);
});

// ---------------- getRouteFrequencyForDriver ----------------

test('getRouteFrequencyForDriver counts only in-window trips and joins outlet names', async () => {
  const { api: helperApi } = makeEnv();
  const today = helperApi.toClientDate(helperApi.todayPH());

  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 101, 'Trip Date': today, 'Billing Date': today, 'Driver ID': 9 }),
      tripRow({ ID: 102, 'Trip Date': today, 'Billing Date': today, 'Driver ID': 9 }),
      tripRow({ ID: 103, 'Trip Date': '1/1/2020', 'Billing Date': '1/1/2020', 'Driver ID': 9 }),
      tripRow({ ID: 104, 'Trip Date': today, 'Billing Date': today, 'Driver ID': 99 }),
    ],
    'Route Frequency Log': [
      HEADERS['Route Frequency Log'].slice(),
      [1, 101, today, 9, 12],
      [2, 102, today, 9, 12],
      [3, 103, '1/1/2020', 9, 12], // far outside the 21-day window -> excluded
      [4, 104, today, 99, 12], // different driver -> excluded
    ],
    Outlets: [HEADERS.Outlets.slice(), [12, 'SM Dasma', 'Cavite', '', '', '', '6/1/2026']],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });

  const freq = await api.getRouteFrequencyForDriver(9);
  assert.equal(freq.length, 1);
  assert.equal(freq[0].outletId, 12);
  assert.equal(freq[0].count, 2);
  assert.equal(freq[0].outletName, 'SM Dasma');
});

// The log only grows: a swap adds a row for the new driver and keeps the old
// one, and a re-scheduled trip is logged again. A trip counts once, for the
// driver it has now.
test('getRouteFrequencyForDriver counts each trip once, for its current driver', async () => {
  const { api: helperApi } = makeEnv();
  const today = helperApi.toClientDate(helperApi.todayPH());
  const t = (id, driver) => tripRow({ ID: id, 'Trip Date': today, 'Billing Date': today, 'Driver ID': driver });

  const sheets = {
    Trips: [HEADERS.Trips.slice(), t(101, 9), t(102, 9), t(105, 10)],
    'Route Frequency Log': [
      HEADERS['Route Frequency Log'].slice(),
      [1, 101, today, 9, 12], [2, 101, today, 10, 12], [3, 101, today, 9, 12],   // 9 -> 10 -> 9
      [4, 102, today, 9, 12], [5, 102, today, 9, 12],                           // logged twice
      [6, 105, today, 9, 12], [7, 105, today, 10, 12],                          // 9 -> 10
    ],
    Outlets: [HEADERS.Outlets.slice(), [12, 'SM Dasma', 'Cavite', '', '', '', '6/1/2026']],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });

  assert.equal((await api.getRouteFrequencyForDriver(9))[0].count, 2);
  assert.equal((await api.getRouteFrequencyForDriver(10))[0].count, 1);
  assert.equal((await api.getRouteFrequencyForDriver(9, 21, 101))[0].count, 1, 'the caller\'s own trip is left out');
});

// ---------------- getBootData and the master shapes ----------------

test('getBootData returns the session plus all master collections in one call', async () => {
  const sheets = {
    Users: usersSheet(),
    Employees: [HEADERS.Employees.slice(), [1, 'Boy', 'Juan', '', 'Cruz', 'Driver', true]],
    Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', 'Isuzu', '6W', true, '6W']],
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 40]],
    Outlets: [HEADERS.Outlets.slice(), [1, 'Outlet A', 'Cavite', '', '', '', '6/1/2026']],
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [1, 1, 1, '', '']],
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [1, '6W', true]],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Admin });

  const boot = await api.getBootData();
  assert.equal(boot.session.role, 'Admin');
  assert.equal(boot.employees.length, 1);
  assert.equal(boot.trucks.length, 1);
  assert.equal(boot.trucks[0].billingCategory, '6W', 'the category comes back as its name');
  assert.equal(boot.waybillPrefixes.length, 1);
  assert.equal(boot.waybillPrefixes[0].sequenceWidth, 2, 'a legacy row infers the width from "40"');
  assert.equal(boot.outlets.length, 1);
  assert.equal(boot.defaultAssignments.length, 1);
  assert.equal(boot.billingCategories.length, 1);
  assert.ok(Array.isArray(boot.routeTypeMap));
  assert.ok(Array.isArray(boot.customerGroupColors));
  assert.ok(Array.isArray(boot.billingChargeTypes));
  assert.deepEqual(boot.origins, []);
});

test('getBootData gives a verified stranger the session only', async () => {
  const { api } = makeEnv({ sheets: { Users: usersSheet() }, userEmail: EMAIL.Unknown });
  const boot = await api.getBootData();
  assert.equal(boot.session.role, null);
  assert.equal(boot.employees, undefined);
});

test('getDefaultAssignments folds the truck\'s driver and helper rows; id is the truck id', async () => {
  const sheets = {
    Trucks: [HEADERS.Trucks.slice(), [4, 'BBB-222', '', '6W', true, ''], [5, 'CCC-333', '', '6W', true, '']],
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [9, 4, 21, '30, 31', 'night crew']],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const defs = await api.getDefaultAssignments();
  assert.deepEqual(defs, [
    { id: 4, truckId: 4, defaultDriverId: 21, defaultHelperIds: [30, 31], notes: 'night crew' },
    { id: 5, truckId: 5, defaultDriverId: null, defaultHelperIds: [], notes: '' },
  ]);
});

test('self-seeding tables get their defaults only when the test provides none', async () => {
  const { api } = makeEnv({ userEmail: EMAIL.Viewer });
  const map = await api.getRouteTypeMap();
  assert.deepEqual(map.map((m) => [m.fileTypeCode, m.billingCategory]),
    [['10W', '10W'], ['6WF', '6W'], ['6WC', '6W'], ['4WC', '6W'], ['L300', 'L300']]);
  assert.deepEqual(await api.getRouteTypeCategoryLookup(), { '10W': '10W', '6WF': '6W', '6WC': '6W', '4WC': '6W', L300: 'L300' });
  assert.equal((await api.getCustomerGroupColors()).length, 7);
  assert.deepEqual((await api.getBillingChargeTypes()).map((c) => c.sortOrder), [10, 20, 30]);

  const given = makeEnv({ sheets: { 'Route Type Map': [['ID', 'File Type Code', 'Billing Category', 'Active'], [1, 'X', '6W', true]] } });
  assert.equal((await given.api.getRouteTypeMap()).length, 1);
});

test('getUsers is Admin-only and lists inactive accounts too', async () => {
  const admin = makeEnv({ sheets: { Users: usersSheet() }, userEmail: EMAIL.Admin });
  const users = await admin.api.getUsers();
  assert.equal(users.length, 5);
  assert.equal(users.find((u) => u.id === 5).active, false);

  const dispatcher = makeEnv({ sheets: { Users: usersSheet() }, userEmail: EMAIL.Dispatcher });
  await assert.rejects(() => dispatcher.api.getUsers(), /Access denied/);
});

// ---------------- Billing readers ----------------

test('getFreightRates rebuilds the 25-band grid per rate block and filters by origin', async () => {
  const bands = Array.from({ length: 25 }, (_, i) => (i === 7 ? 1000 : i === 8 ? 1100 : ''));
  const sheets = {
    Users: usersSheet(),
    'Freight Rates': [
      HEADERS['Freight Rates'].slice(),
      [1, 'Cabuyao', 'Sta. Rosa', '6W', '1/1/2026', ...bands],
      [2, 'Naic', 'Dasma', '6W', '1/1/2026', ...bands],
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Payroll });

  const all = await api.getFreightRates();
  assert.equal(all.length, 2);
  const row = all.find((r) => r.origin === 'Cabuyao');
  assert.equal(row.area, 'Sta. Rosa');
  assert.equal(row.truckType, '6W');
  assert.equal(row.effectiveDate, '1/1/2026');
  assert.equal(Object.keys(row.bands).length, 25);
  assert.equal(row.bands['65.01-70'], 1000);
  assert.equal(row.bands['70.01-75'], 1100);
  assert.equal(row.bands['30.01-35'], null);

  assert.equal((await api.getFreightRates('CABUYAO')).length, 1);
  assert.equal((await api.getFreightRates(['cabuyao', 'naic'])).length, 2);
  assert.deepEqual(await api.getFreightRateOrigins(), ['Cabuyao', 'Naic']);
});

test('getFuelPrices comes back newest first', async () => {
  const sheets = {
    Users: usersSheet(),
    'Fuel Prices': [
      HEADERS['Fuel Prices'].slice(),
      [1, '6/2/2026', 60.5, 'a@x', '6/2/2026 08:00:00'],
      [2, '6/9/2026', 61.0, 'a@x', '6/9/2026 08:00:00'],
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Payroll });
  const prices = await api.getFuelPrices();
  assert.deepEqual(prices.map((p) => p.effectiveDate), ['6/9/2026', '6/2/2026']);
  assert.equal(prices[1].dieselPrice, 60.5);
  assert.equal(prices[1].addedAt, '6/2/2026 08:00:00');
});

test('billingLineFromRow restores manualCharges, the band label and overrides', async () => {
  const sheets = {
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 7, true, 0]],
    Trips: [HEADERS.Trips.slice(), tripRow({ ID: 1, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'F' })],
    Waybills: [HEADERS.Waybills.slice(), [90, 'AL-7', 1, 7, 1, 'F', 'Regular', '', 'Confirmed', true, 'd', '']],
    'Billing Lines': [
      HEADERS['Billing Lines'].slice(),
      [1, 'AL-7', 90, '6/16/2026', '6/16/2026', 'Cabuyao', 'AAA-111', 'F', '6W', 'Sta. Rosa', 3, 250,
        61, '60.01-65', 5000, 784, 560, '{"1": 150, "2": 0}', 6494, '', 'Not Billed', '["mano"]', 'n',
        'p@x', '6/17/2026 09:00:00', '', ''],
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Payroll });
  const lines = await api.billingLinesByWaybill([90]);
  const l = lines[90];
  assert.equal(l.waybillNumber, 'AL-7');
  assert.equal(l.rateBand, '60.01-65');
  assert.deepEqual(l.manualCharges, { 1: 150 }, 'a zero charge is not stored');
  assert.deepEqual(l.overrides, ['mano']);
  assert.equal(l.total, 6494);
  assert.equal(l.addedAt, '6/17/2026 09:00:00');

  const totals = api._billingTotals([l]);
  assert.equal(totals.lineCount, 1);
  assert.equal(Math.round(totals.amountDue * 100) / 100, Math.round((6494 - (6494 / 1.12) * 0.02) * 100) / 100);
});
