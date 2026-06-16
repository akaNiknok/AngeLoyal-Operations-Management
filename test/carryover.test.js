// ============================================================
//  Carry-over trip tests (Internals._createCarryoverTrip)
//  The contract: when a trip is flagged Redeliver / Foul Trip,
//  a next-business-day trip is spawned that PRESERVES the original
//  Billing Date (so fuel/rate indexing stays correct), copies the
//  crew, links the parent, and suggests a -R / -FT waybill.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet } = require('./fixtures');

const ORIGINAL_TRIP_ID = 50;

function buildSheets() {
  // One original trip: dispatched 6/15, but its operational Billing Date is 6/10.
  const tripRow = [
    ORIGINAL_TRIP_ID, '6/15/2026', '6/10/2026', 'FO-777', '',
    12 /* Outlet ID */, 'Cavite', 100 /* Qty */, 8.5 /* CBM */, 'Closed Van',
    3 /* Truck ID */, 9 /* Driver ID */, '21,22,23' /* Helpers */, '10W',
    'Foul Trip - For Redeliver', '', 'Import', 2 /* Tier */, 'spoiled load',
    '', '', 'dispatch@angeloyal.com', '6/15/2026 08:00:00',
  ];

  return {
    Users: usersSheet(),
    Trips: [HEADERS.Trips.slice(), tripRow],
    Waybills: [
      HEADERS.Waybills.slice(),
      // a confirmed waybill on the original trip so prefix/parent resolve
      [70, 'AL-40', 1, 40, ORIGINAL_TRIP_ID, 'FO-777', 'Regular', '', 'Confirmed', true, 'd', 'd'],
    ],
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 40]],
    'Route Frequency Log': [HEADERS['Route Frequency Log'].slice()],
    'Audit Log': [HEADERS['Audit Log'].slice()],
  };
}

function setup(statusReason) {
  const sheets = buildSheets();
  const { api, ss } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const { headers, rows } = dump(ss, 'Trips');
  const originalRow = rows[0];

  const newId = api._createCarryoverTrip(originalRow, headers, ORIGINAL_TRIP_ID, statusReason);

  const after = dump(ss, 'Trips');
  const newRow = after.rows.find((r) => Number(r[0]) === Number(newId));
  return { api, ss, newId, newTrip: rowObject(after.headers, newRow) };
}

test('carry-over preserves the original Billing Date', () => {
  const { newTrip } = setup('Redeliver');
  assert.equal(newTrip['Billing Date'], '6/10/2026'); // NOT the dispatch date, NOT today
});

test('carry-over Trip Date is the next business day from today', () => {
  const { api, newTrip } = setup('Redeliver');
  const expected = api._formatDate(api._nextBusinessDay(new Date()));
  assert.equal(newTrip['Trip Date'], expected);
  assert.notEqual(newTrip['Trip Date'], '6/15/2026');
});

test('carry-over copies crew and links the parent trip', () => {
  const { newTrip } = setup('Redeliver');
  assert.equal(Number(newTrip['Truck ID']), 3);
  assert.equal(Number(newTrip['Driver ID']), 9);
  assert.equal(newTrip['Helper IDs'], '21,22,23'); // helper CSV round-trips intact
  assert.equal(Number(newTrip['Outlet ID']), 12);
  assert.equal(Number(newTrip['Parent Trip ID']), ORIGINAL_TRIP_ID);
  assert.equal(newTrip.Source, 'Carry-over');
  assert.equal(newTrip['Trip Status'], 'Scheduled'); // a carry-over starts fresh
  assert.equal(newTrip['Truck Billing Category'], '10W'); // snapshot copied
});

test('Redeliver spawns a -R suggested waybill on the new trip', () => {
  const { ss, newId } = setup('Redeliver');
  const { headers, rows } = dump(ss, 'Waybills');
  const wb = rows
    .map((r) => rowObject(headers, r))
    .find((w) => Number(w['Trip ID']) === Number(newId));
  assert.ok(wb, 'expected a waybill for the carry-over trip');
  assert.equal(wb['Waybill Number'], 'AL-41-R'); // next seq + redeliver suffix
  assert.equal(wb['Waybill Type'], 'Redeliver');
  assert.equal(Number(wb['Parent Waybill ID']), 70);
  assert.equal(wb.Locked, false); // suggested, not confirmed
});

test('Foul Trip spawns a -FT suggested waybill', () => {
  const { ss, newId } = setup('Foul Trip');
  const { headers, rows } = dump(ss, 'Waybills');
  const wb = rows
    .map((r) => rowObject(headers, r))
    .find((w) => Number(w['Trip ID']) === Number(newId));
  assert.equal(wb['Waybill Number'], 'AL-41-FT');
  assert.equal(wb['Waybill Type'], 'Foul Trip');
});

test('carry-over logs to the Route Frequency Log when driver + outlet are set', () => {
  const { ss, newId } = setup('Redeliver');
  const { headers, rows } = dump(ss, 'Route Frequency Log');
  const logged = rows
    .map((r) => rowObject(headers, r))
    .find((l) => Number(l['Trip ID']) === Number(newId));
  assert.ok(logged, 'expected a route-frequency entry for the carry-over');
  assert.equal(Number(logged['Driver ID']), 9);
  assert.equal(Number(logged['Outlet ID']), 12);
});
