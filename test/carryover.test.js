// ============================================================
//  Carry-over trip tests (server/writers/trips.js _createCarryoverTrip,
//  ported from Internals.gs). The contract: when a trip is flagged
//  Redeliver / Foul Trip, a next-business-day trip is spawned that
//  PRESERVES the original Billing Date (so fuel/rate indexing stays
//  correct), copies the crew, links the parent, and suggests a
//  -R / -FT waybill.
//
//  D1 signature: _createCarryoverTrip(originalTripId, statusReason) —
//  it reads the trip and its helpers itself, rather than taking a raw
//  sheet row/headers pair.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
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
    Employees: [
      HEADERS.Employees.slice(),
      [9, 'Driver Nine', '', '', '', 'Driver', true],
      [21, 'Helper 21', '', '', '', 'Helper', true],
      [22, 'Helper 22', '', '', '', 'Helper', true],
      [23, 'Helper 23', '', '', '', 'Helper', true],
    ],
    Outlets: [HEADERS.Outlets.slice(), [12, 'SM Dasma', 'Cavite', '', '', '', '6/1/2026'], [13, 'SM North', 'QC', '', '', '', '6/1/2026']],
    Trucks: [HEADERS.Trucks.slice(), [3, 'ABC-123', 'Isuzu', '10W', true, '10W']],
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

async function setup(statusReason) {
  const sheets = buildSheets();
  const { api, db } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const newId = await api._createCarryoverTrip(ORIGINAL_TRIP_ID, statusReason);
  const newTrip = dump(db, 'trips').find((t) => t.id === newId);
  return { api, db, newId, newTrip };
}

test('carry-over preserves the original Billing Date', async () => {
  const { newTrip } = await setup('Redeliver');
  assert.equal(newTrip.billing_date, '2026-06-10'); // NOT the dispatch date, NOT today
});

test('carry-over Trip Date is the next business day from the TRIP date, not today', async () => {
  const { newTrip } = await setup('Redeliver');
  assert.equal(newTrip.trip_date, '2026-06-16'); // 6/15 + 1, not today + 1
});

test('carry-over Trip Date skips Sunday', async () => {
  const sheets = buildSheets();
  sheets.Trips[1][1] = '6/20/2026'; // a Saturday
  const { api, db } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });
  const newId = await api._createCarryoverTrip(ORIGINAL_TRIP_ID, 'Redeliver');
  const newTrip = dump(db, 'trips').find((t) => t.id === newId);
  assert.equal(newTrip.trip_date, '2026-06-22'); // Monday
});

// A merged load = several stops of one FO on one truck sharing one waybill.
// Each stop spawns its own carry-over trip, but the carried-over stops are
// still one load, so they must share ONE -R number or the next day's board
// renders them unmerged.
test('carry-over stops of one merged load share a single -R waybill', async () => {
  const sheets = buildSheets();
  const second = sheets.Trips[1].slice();
  second[0] = ORIGINAL_TRIP_ID + 1;
  second[5] = 13; // a different outlet — same FO, same truck, same day
  sheets.Trips.push(second);
  // the load's waybill is one number spread over one row per stop (legacy shape)
  sheets.Waybills.push([71, 'AL-40', 1, 40, ORIGINAL_TRIP_ID + 1, 'FO-777',
    'Regular', '', 'Confirmed', true, 'd', 'd']);

  const { api, db } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });
  const idA = await api._createCarryoverTrip(ORIGINAL_TRIP_ID, 'Redeliver');
  const idB = await api._createCarryoverTrip(ORIGINAL_TRIP_ID + 1, 'Redeliver');

  const forTrip = (id) => {
    const t = dump(db, 'trips').find((tr) => tr.id === id);
    return dump(db, 'waybills').find((w) => w.id === t.waybill_id);
  };
  assert.equal(forTrip(idA).waybill_number, 'AL-40-R'); // the load's own number
  assert.equal(forTrip(idB).waybill_number, 'AL-40-R'); // joined, not AL-41-R
  assert.equal(forTrip(idB).waybill_type, 'Redeliver');
});

test('carry-over copies crew and links the parent trip', async () => {
  const { newTrip } = await setup('Redeliver');
  assert.equal(newTrip.truck_id, 3);
  assert.equal(newTrip.driver_id, 9);
  assert.equal(newTrip.outlet_id, 12);
  assert.equal(newTrip.parent_trip_id, ORIGINAL_TRIP_ID);
  assert.equal(newTrip.source, 'Carry-over');
  assert.equal(newTrip.trip_status, 'Scheduled'); // a carry-over starts fresh
  assert.equal(newTrip.truck_billing_category, '10W'); // snapshot copied
});

test('carry-over copies the helper slots', async () => {
  const { db, newId } = await setup('Redeliver');
  const helperIds = dump(db, 'trip_helpers').filter((h) => h.trip_id === newId)
    .sort((a, b) => a.slot - b.slot).map((h) => h.employee_id);
  assert.deepEqual(helperIds, [21, 22, 23]); // helper set round-trips intact
});

test('Redeliver spawns a -R suggested waybill on the new trip', async () => {
  const { db, newTrip } = await setup('Redeliver');
  const wb = dump(db, 'waybills').find((w) => w.id === newTrip.waybill_id);
  assert.ok(wb, 'expected a waybill for the carry-over trip');
  // Rebisco's rule: the redeliver keeps the ORIGINAL number. AL-40 -> AL-40-R,
  // never the next free number with -R stapled on.
  assert.equal(wb.waybill_number, 'AL-40-R');
  assert.equal(wb.waybill_type, 'Redeliver');
  assert.equal(wb.parent_waybill_id, 70);
  assert.equal(wb.sequence_number, 40); // the parent's, not a new one
  assert.equal(wb.status, 'Suggested'); // suggested, not confirmed
});

// The number came out of the parent, so the prefix counter must not move —
// spending a sequence here is what pushed every later Regular waybill off by
// one against the physical booklet.
test('a Redeliver does not advance the prefix counter', async () => {
  const { db } = await setup('Redeliver');
  assert.equal(dump(db, 'waybill_prefixes')[0].last_sequence_number, 40); // untouched
});

// Redelivering a redeliver stays -R. The suffix is stripped off the parent
// before the new one goes on, so it can never grow into AL-40-R-R.
test('redelivering a redeliver stays -R', async () => {
  const sheets = buildSheets();
  const { api, db } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const first = await api._createCarryoverTrip(ORIGINAL_TRIP_ID, 'Redeliver');
  // Confirm the carry-over's -R waybill, then carry IT over again.
  const second = await api._createCarryoverTrip(first, 'Redeliver');

  const secondTrip = dump(db, 'trips').find((t) => t.id === second);
  const wb = dump(db, 'waybills').find((w) => w.id === secondTrip.waybill_id);
  assert.equal(wb.waybill_number, 'AL-40-R'); // not AL-40-R-R
});

// A brand-new Regular waybill must still mint and reserve normally — the
// carry-over path is the only one that reuses a number.
test('a Regular waybill still mints the next number and reserves it', async () => {
  const sheets = buildSheets();
  sheets.Trips.push(sheets.Trips[1].map((v, i) => (i === 0 ? 99 : i === 3 ? 'FO-888' : v)));
  const { api, db } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const made = await api._createSuggestedWaybill(99, 1, 'FO-888', 'Regular', null);
  assert.equal(made.waybillNumber, 'AL-41');
  assert.equal(dump(db, 'waybill_prefixes')[0].last_sequence_number, 41);
});

test('Foul Trip spawns a -FT suggested waybill', async () => {
  const { db, newTrip } = await setup('Foul Trip');
  const wb = dump(db, 'waybills').find((w) => w.id === newTrip.waybill_id);
  assert.equal(wb.waybill_number, 'AL-40-FT'); // the original number + -FT
  assert.equal(wb.waybill_type, 'Foul Trip');
});

test('carry-over logs to the Route Frequency Log when driver + outlet are set', async () => {
  const { db, newId } = await setup('Redeliver');
  const logged = dump(db, 'route_frequency_log').find((l) => l.trip_id === newId);
  assert.ok(logged, 'expected a route-frequency entry for the carry-over');
  assert.equal(logged.driver_id, 9);
  assert.equal(logged.outlet_id, 12);
});

// Backlog never left the yard: it re-enters planning Prepping, with no
// waybill donated (it never had one) and no waybill created either.
test('Backlog carry-over lands Prepping with no waybill', async () => {
  const sheets = buildSheets();
  sheets.Trips[1][14] = 'Backlog'; // Trip Status
  const { api, db } = makeEnv({ sheets, userEmail: 'dispatch@angeloyal.com' });

  const newId = await api._createCarryoverTrip(ORIGINAL_TRIP_ID, 'Backlog');
  const newTrip = dump(db, 'trips').find((t) => t.id === newId);
  assert.equal(newTrip.trip_status, 'Prepping');
  assert.equal(newTrip.waybill_id, null);
});
