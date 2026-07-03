// ============================================================
//  Read path — getTrips date filtering, getDispatchBoardData
//  waybill join, getRouteFrequencyForDriver windowing, and the
//  getBootData aggregate (DataReaders.gs).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function tripRow(values) {
  return HEADERS.Trips.map((h) => (h in values ? values[h] : ''));
}

// ---------------- getTrips date filtering ----------------

test('getTrips returns only trips whose Trip Date falls in the range', () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/14/2026', 'Billing Date': '6/14/2026', 'FO Number': 'A' }),
      tripRow({ ID: 2, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'B' }),
      tripRow({ ID: 3, 'Trip Date': '6/20/2026', 'Billing Date': '6/20/2026', 'FO Number': 'C' }),
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });

  const inRange = api.getTrips('6/15/2026', '6/17/2026');
  assert.deepEqual(inRange.map((t) => t.id), [2]);

  // boundaries are inclusive
  assert.equal(api.getTrips('6/14/2026', '6/20/2026').length, 3);
});

test('getTrips parses helper CSV into a numeric array', () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'Helper IDs': '7,8,9' }),
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const [trip] = api.getTrips('6/16/2026', '6/16/2026');
  // spread into a host array — the bundle built this one via .split() in the vm realm
  assert.deepEqual([...trip.helperIds], [7, 8, 9]);
});

test('getTrips returns convoyGroup as a string, blank when unset', () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 1, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'Convoy Group': 3 }),
      tripRow({ ID: 2, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026' }),
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const trips = api.getTrips('6/16/2026', '6/16/2026');
  assert.equal(trips.find((t) => t.id === 1).convoyGroup, '3');
  assert.equal(trips.find((t) => t.id === 2).convoyGroup, '');
});

// ---------------- getDispatchBoardData ----------------

test('getDispatchBoardData joins suggested + confirmed waybills onto each trip', () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 50, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'FO Number': 'FO-50' }),
    ],
    Waybills: [
      HEADERS.Waybills.slice(),
      [90, 'AL-7', 1, 7, 50, 'FO-50', 'Regular', '', 'Suggested', false, '', ''],
      [91, 'AL-6', 1, 6, 50, 'FO-50', 'Regular', '', 'Confirmed', true, 'd', 'd'],
    ],
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });

  const board = api.getDispatchBoardData('6/16/2026');
  assert.equal(board.date, '6/16/2026');
  assert.equal(board.trips.length, 1);

  const t = board.trips[0];
  assert.equal(t.waybillSuggested, 'AL-7');
  assert.equal(t.suggestedWaybillId, 90);
  assert.equal(t.waybillConfirmed, 'AL-6');
});

test('getDispatchBoardData returns empty waybill fields when none exist', () => {
  const sheets = {
    Trips: [
      HEADERS.Trips.slice(),
      tripRow({ ID: 51, 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026' }),
    ],
    Waybills: emptySheet('Waybills'),
  };
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  const t = api.getDispatchBoardData('6/16/2026').trips[0];
  assert.equal(t.waybillSuggested, '');
  assert.equal(t.waybillConfirmed, '');
  assert.equal(t.suggestedWaybillId, null);
});

// ---------------- getRouteFrequencyForDriver ----------------

test('getRouteFrequencyForDriver counts only in-window trips and joins outlet names', () => {
  const { api: helperApi } = makeEnv({ sheets: {}, userEmail: EMAIL.Viewer });
  const today = helperApi._formatDate(new Date());

  const sheets = {
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

  const freq = api.getRouteFrequencyForDriver(9);
  assert.equal(freq.length, 1);
  assert.equal(freq[0].outletId, 12);
  assert.equal(freq[0].count, 2); // the two in-window rows
  assert.equal(freq[0].outletName, 'SM Dasma');
});

// ---------------- getBootData ----------------

test('getBootData returns the session plus all master collections in one call', () => {
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

  const boot = api.getBootData();
  assert.equal(boot.session.role, 'Admin');
  assert.equal(boot.employees.length, 1);
  assert.equal(boot.trucks.length, 1);
  assert.equal(boot.waybillPrefixes.length, 1);
  assert.equal(boot.outlets.length, 1);
  assert.equal(boot.defaultAssignments.length, 1);
  assert.equal(boot.billingCategories.length, 1);
});
