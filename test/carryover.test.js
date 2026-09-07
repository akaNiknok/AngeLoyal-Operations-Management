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

test('carry-over Trip Date is the next business day from the TRIP date, not today', () => {
  const { newTrip } = setup('Redeliver');
  assert.equal(newTrip['Trip Date'], '6/16/2026'); // 6/15 + 1, not today + 1
});

test('carry-over Trip Date skips Sunday', () => {
  const sheets = buildSheets();
  sheets.Trips[1][1] = '6/20/2026'; // a Saturday
  const { api, ss } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });
  const { headers, rows } = dump(ss, 'Trips');
  const newId = api._createCarryoverTrip(rows[0], headers, ORIGINAL_TRIP_ID, 'Redeliver');
  const after = dump(ss, 'Trips');
  const newTrip = rowObject(after.headers, after.rows.find((r) => Number(r[0]) === Number(newId)));
  assert.equal(newTrip['Trip Date'], '6/22/2026'); // Monday
});

// A merged load = several stops of one FO on one truck sharing one waybill.
// Each stop spawns its own carry-over trip, but the carried-over stops are
// still one load, so they must share ONE -R number or the next day's board
// renders them unmerged.
test('carry-over stops of one merged load share a single -R waybill', () => {
  const sheets = buildSheets();
  const second = sheets.Trips[1].slice();
  second[0] = ORIGINAL_TRIP_ID + 1;
  second[5] = 13; // a different outlet — same FO, same truck, same day
  sheets.Trips.push(second);
  // the load's waybill is one number spread over one row per stop
  sheets.Waybills.push([71, 'AL-40', 1, 40, ORIGINAL_TRIP_ID + 1, 'FO-777',
    'Regular', '', 'Confirmed', true, 'd', 'd']);

  const { api, ss } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });
  const { headers, rows } = dump(ss, 'Trips');
  const idA = api._createCarryoverTrip(rows[0], headers, ORIGINAL_TRIP_ID, 'Redeliver');
  const idB = api._createCarryoverTrip(rows[1], headers, ORIGINAL_TRIP_ID + 1, 'Redeliver');

  const wb = dump(ss, 'Waybills');
  const forTrip = (id) => wb.rows.map((r) => rowObject(wb.headers, r))
    .find((w) => Number(w['Trip ID']) === Number(id));
  assert.equal(forTrip(idA)['Waybill Number'], 'AL-40-R'); // the load's own number
  assert.equal(forTrip(idB)['Waybill Number'], 'AL-40-R'); // joined, not AL-41-R
  assert.equal(forTrip(idB)['Waybill Type'], 'Redeliver');
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
  // Rebisco's rule: the redeliver keeps the ORIGINAL number. AL-40 → AL-40-R,
  // never the next free number with -R stapled on.
  assert.equal(wb['Waybill Number'], 'AL-40-R');
  assert.equal(wb['Waybill Type'], 'Redeliver');
  assert.equal(Number(wb['Parent Waybill ID']), 70);
  assert.equal(Number(wb['Sequence Number']), 40); // the parent's, not a new one
  assert.equal(wb.Locked, false); // suggested, not confirmed
});

// The number came out of the parent, so the prefix counter must not move —
// spending a sequence here is what pushed every later Regular waybill off by
// one against the physical booklet.
test('a Redeliver does not advance the prefix counter', () => {
  const { ss } = setup('Redeliver');
  const { headers, rows } = dump(ss, 'Waybill Prefixes');
  const pref = rowObject(headers, rows[0]);
  assert.equal(Number(pref['Last Sequence Number']), 40); // untouched
});

// Redelivering a redeliver stays -R. The suffix is stripped off the parent
// before the new one goes on, so it can never grow into AL-40-R-R.
test('redelivering a redeliver stays -R', () => {
  const sheets = buildSheets();
  const { api, ss } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const first = api._createCarryoverTrip(
    dump(ss, 'Trips').rows[0], dump(ss, 'Trips').headers, ORIGINAL_TRIP_ID, 'Redeliver');

  // Confirm the carry-over's -R waybill, then carry IT over again.
  const wb1 = dump(ss, 'Waybills');
  const rowIdx = wb1.rows.findIndex((r) => Number(rowObject(wb1.headers, r)['Trip ID']) === first);
  assert.ok(rowIdx !== -1);

  const trips2 = dump(ss, 'Trips');
  const firstRow = trips2.rows.find((r) => Number(r[0]) === first);
  const second = api._createCarryoverTrip(firstRow, trips2.headers, first, 'Redeliver');

  const wb2 = dump(ss, 'Waybills');
  const forTrip = (id) => wb2.rows.map((r) => rowObject(wb2.headers, r))
    .find((w) => Number(w['Trip ID']) === Number(id));
  assert.equal(forTrip(second)['Waybill Number'], 'AL-40-R'); // not AL-40-R-R
});

// A brand-new Regular waybill must still mint and reserve normally — the
// carry-over path is the only one that reuses a number.
test('a Regular waybill still mints the next number and reserves it', () => {
  const sheets = buildSheets();
  const { api, ss } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const made = api._createSuggestedWaybill(99, 1, 'FO-888', 'Regular', null);
  assert.equal(made.waybillNumber, 'AL-41');

  const { headers, rows } = dump(ss, 'Waybill Prefixes');
  assert.equal(Number(rowObject(headers, rows[0])['Last Sequence Number']), 41);
});

test('Foul Trip spawns a -FT suggested waybill', () => {
  const { ss, newId } = setup('Foul Trip');
  const { headers, rows } = dump(ss, 'Waybills');
  const wb = rows
    .map((r) => rowObject(headers, r))
    .find((w) => Number(w['Trip ID']) === Number(newId));
  assert.equal(wb['Waybill Number'], 'AL-40-FT'); // the original number + -FT
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
