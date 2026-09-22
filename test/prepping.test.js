// ============================================================
//  Prepping phase — markDayScheduled (server/writers/trips.js,
//  ported from DataWriters.gs). Import lands trips in 'Prepping'
//  with no waybills; promotion flips them to 'Scheduled' and
//  suggests waybills grouped by (FO Number, Truck ID): one number
//  per truck load.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

/** Trips row builder from named fields; everything else blank. */
function tripRow(fields) {
  const defaults = {
    'Trip Date': '6/16/2026',
    'Billing Date': '6/16/2026',
    'Trip Status': 'Prepping',
    Source: 'Import',
  };
  return HEADERS.Trips.map((h) => (fields[h] !== undefined ? fields[h] : (defaults[h] !== undefined ? defaults[h] : '')));
}

function preppingSheets(tripRows, extra = {}) {
  return Object.assign(
    {
      Users: usersSheet(),
      Employees: [
        HEADERS.Employees.slice(),
        [9, 'Driver Nine', '', '', '', 'Driver', true],
        [10, 'Driver Ten', '', '', '', 'Driver', true],
      ],
      Trucks: [
        HEADERS.Trucks.slice(),
        [3, 'ABC-123', 'Isuzu', '6W', true, '6W'],
        [4, 'DEF-456', 'Isuzu', '6W', true, '6W'],
        [5, 'GHI-789', 'Isuzu', '6W', true, '6W'],
      ],
      Outlets: [
        HEADERS.Outlets.slice(),
        [12, 'SM Dasma', 'Cavite', '', '', '', '6/1/2026'],
        [13, 'SM North', 'QC', '', '', '', '6/1/2026'],
        [14, 'SM South', 'Laguna', '', '', '', '6/1/2026'],
        [15, 'SM East', 'Rizal', '', '', '', '6/1/2026'],
      ],
      Trips: [HEADERS.Trips.slice(), ...tripRows],
      Waybills: emptySheet('Waybills'),
      'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 40]],
      'Route Frequency Log': emptySheet('Route Frequency Log'),
      'Audit Log': emptySheet('Audit Log'),
    },
    extra
  );
}

function asDispatcher(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
}

test('markDayScheduled promotes Prepping trips of the date and suggests grouped waybills', async () => {
  // FO-1 on truck 3: two drops -> one shared waybill.
  // FO-1 on truck 4: split load -> own waybill.
  // FO-2 on truck 5: own waybill.
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3 }),
      tripRow({ ID: 2, 'FO Number': 'FO-1', 'Truck ID': 3 }),
      tripRow({ ID: 3, 'FO Number': 'FO-1', 'Truck ID': 4 }),
      tripRow({ ID: 4, 'FO Number': 'FO-2', 'Truck ID': 5 }),
    ])
  );

  const res = await api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.success, true);
  assert.equal(res.promoted, 4);
  assert.equal(res.waybillsSuggested, 3);

  const trips = dump(db, 'trips');
  assert.ok(trips.every((t) => t.trip_status === 'Scheduled'));
  assert.ok(trips.every((t) => t.status_changed_by === EMAIL.Dispatcher));
  assert.ok(trips.every((t) => t.status_changed_at));

  const wbs = dump(db, 'waybills');
  const byTrip = {};
  trips.forEach((t) => { byTrip[t.id] = (wbs.find((w) => w.id === t.waybill_id) || {}).waybill_number; });
  assert.equal(byTrip[1], byTrip[2]);      // same FO + same truck share
  assert.notEqual(byTrip[1], byTrip[3]);   // split truck gets its own
  assert.notEqual(byTrip[3], byTrip[4]);
  assert.deepEqual(Object.values(byTrip).sort(), ['AL-41', 'AL-41', 'AL-42', 'AL-43'].sort());
});

test('markDayScheduled logs route frequency for promoted trips with a driver + outlet', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3, 'Driver ID': 9, 'Outlet ID': 12 }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Truck ID': 4, 'Driver ID': 10, 'Outlet ID': 13 }),
      tripRow({ ID: 3, 'FO Number': 'FO-3', 'Truck ID': 5, 'Outlet ID': 14 }),   // no driver
      tripRow({ ID: 4, 'FO Number': 'FO-4', 'Driver ID': 9 }),                   // no outlet
      tripRow({ ID: 5, 'FO Number': 'FO-5', 'Driver ID': 9, 'Outlet ID': 15, 'Trip Date': '6/17/2026' }),
    ])
  );

  await api.markDayScheduled('6/16/2026', 1);

  const logged = dump(db, 'route_frequency_log');
  assert.equal(logged.length, 2);   // trips 3, 4 incomplete; trip 5 is another date
  assert.deepEqual(logged.map((f) => f.trip_id).sort(), [1, 2]);
  assert.equal(logged.find((f) => f.trip_id === 1).driver_id, 9);
  assert.equal(logged.find((f) => f.trip_id === 1).outlet_id, 12);
});

test('markDayScheduled leaves other dates and non-Prepping trips alone', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3 }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Truck ID': 4, 'Trip Date': '6/17/2026' }), // other date
      tripRow({ ID: 3, 'FO Number': 'FO-3', 'Truck ID': 5, 'Trip Status': 'Delivered' }), // not Prepping
    ])
  );

  const res = await api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.promoted, 1);

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 2).trip_status, 'Prepping');
  assert.equal(trips.find((t) => t.id === 3).trip_status, 'Delivered');
  assert.equal(dump(db, 'waybills').length, 1);
});

test('markDayScheduled marks crewless Prepping trips Backlog and carries them over', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3, 'Driver ID': 9, 'Outlet ID': 12 }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Outlet ID': 13 }),   // no crew
    ])
  );

  const res = await api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.success, true);
  assert.equal(res.promoted, 1);
  assert.equal(res.backlogged, 1);
  assert.equal(res.waybillsSuggested, 1);   // only the crewed trip
  assert.equal(res.newTripIds.length, 1);

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 1).trip_status, 'Scheduled');
  assert.equal(trips.find((t) => t.id === 2).trip_status, 'Backlog');

  // The carry-over re-enters the next day's planning phase, un-waybilled.
  const carried = trips.find((t) => t.id === res.newTripIds[0]);
  assert.equal(carried.trip_status, 'Prepping');
  assert.equal(carried.source, 'Carry-over');
  assert.equal(carried.parent_trip_id, 2);
  assert.equal(carried.fo_number, 'FO-2');
  assert.equal(carried.billing_date, '2026-06-16');     // original day preserved
  assert.notEqual(carried.trip_date, '2026-06-16');

  const wbs = dump(db, 'waybills');
  assert.deepEqual(trips.filter((t) => t.waybill_id).map((t) => t.id), [1]);
});

test('two markDayScheduled runs in flight promote the day once', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3, 'Driver ID': 9, 'Outlet ID': 12 }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Outlet ID': 13 }),   // no crew
    ])
  );

  const [a, b] = await Promise.all([
    api.markDayScheduled('6/16/2026', 1),
    api.markDayScheduled('6/16/2026', 1),
  ]);
  assert.equal(a.promoted + b.promoted, 1);
  assert.equal(a.backlogged + b.backlogged, 1);
  assert.equal(dump(db, 'trips').length, 3, 'one backlog copy, not two');
  assert.equal(dump(db, 'waybills').length, 1, 'one waybill, not two');
  assert.equal(dump(db, 'route_frequency_log').length, 1);
});

test('markDayScheduled gives blank-FO trips their own waybills', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'Truck ID': 3 }),
      tripRow({ ID: 2, 'Truck ID': 4 }),
    ])
  );
  const res = await api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.waybillsSuggested, 2);
  const trips = dump(db, 'trips');
  const wbs = dump(db, 'waybills');
  assert.notEqual(
    wbs.find((w) => w.id === trips.find((t) => t.id === 1).waybill_id).waybill_number,
    wbs.find((w) => w.id === trips.find((t) => t.id === 2).waybill_id).waybill_number);
});

test('markDayScheduled skips trips that already have a waybill (idempotent-ish)', async () => {
  const { api, db } = asDispatcher(
    preppingSheets(
      [tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3 })],
      { Waybills: [HEADERS.Waybills.slice(), [9, 'AL-40', 1, 40, 1, 'FO-1', 'Regular', '', 'Suggested', false, '', '']] }
    )
  );
  const res = await api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.promoted, 1);
  assert.equal(res.waybillsSuggested, 0);
  assert.equal(dump(db, 'waybills').length, 1); // no duplicate
});

test('markDayScheduled is a no-op when nothing is Prepping', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([tripRow({ ID: 1, 'Trip Status': 'Scheduled' })])
  );
  const res = await api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.success, true);
  assert.equal(res.promoted, 0);
  assert.equal(res.waybillsSuggested, 0);
  assert.equal(dump(db, 'waybills').length, 0);
});

test('markDayScheduled fails cleanly for an unknown prefix', async () => {
  const { api, db } = asDispatcher(preppingSheets([tripRow({ ID: 1 })]));
  const res = await api.markDayScheduled('6/16/2026', 999);
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
  // Nothing written.
  assert.equal(dump(db, 'trips')[0].trip_status, 'Prepping');
});

test('markDayScheduled writes batched TRIP_STATUS_CHANGE audit rows', async () => {
  const { api, db } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3 }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Truck ID': 4 }),
    ])
  );
  await api.markDayScheduled('6/16/2026', 1);
  const statusRows = dump(db, 'audit_log').filter((r) => r.action === 'TRIP_STATUS_CHANGE');
  assert.equal(statusRows.length, 2);
  assert.ok(statusRows.every((r) => r.old_value === 'Prepping' && r.new_value === 'Scheduled'));
});

test('markDayScheduled is gated by ADD_MANUAL_TRIP permission', async () => {
  const { api } = makeEnv({
    sheets: preppingSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  await assert.rejects(() => api.markDayScheduled('6/16/2026', 1), /Access denied/);
});
