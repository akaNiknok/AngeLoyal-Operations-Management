// ============================================================
//  Prepping phase — markDayScheduled (DataWriters.gs).
//  Import lands trips in 'Prepping' with no waybills; promotion
//  flips them to 'Scheduled' and suggests waybills grouped by
//  (FO Number, Truck ID): one number per truck load.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
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

test('markDayScheduled promotes Prepping trips of the date and suggests grouped waybills', () => {
  // FO-1 on truck 3: two drops -> one shared waybill.
  // FO-1 on truck 4: split load -> own waybill.
  // FO-2 unassigned: own waybill.
  const { api, ss } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3 }),
      tripRow({ ID: 2, 'FO Number': 'FO-1', 'Truck ID': 3 }),
      tripRow({ ID: 3, 'FO Number': 'FO-1', 'Truck ID': 4 }),
      tripRow({ ID: 4, 'FO Number': 'FO-2' }),
    ])
  );

  const res = api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.success, true);
  assert.equal(res.promoted, 4);
  assert.equal(res.waybillsSuggested, 3);

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.ok(trips.every((t) => t['Trip Status'] === 'Scheduled'));
  assert.ok(trips.every((t) => t['Status Changed By'] === EMAIL.Dispatcher));
  assert.ok(trips.every((t) => t['Status Changed At'] !== ''));

  const wbs = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  const byTrip = {};
  wbs.forEach((w) => { byTrip[w['Trip ID']] = w['Waybill Number']; });
  assert.equal(byTrip[1], byTrip[2]);      // same FO + same truck share
  assert.notEqual(byTrip[1], byTrip[3]);   // split truck gets its own
  assert.notEqual(byTrip[3], byTrip[4]);
  assert.deepEqual(Object.values(byTrip).sort(), ['AL-41', 'AL-41', 'AL-42', 'AL-43'].sort());
});

test('markDayScheduled logs route frequency for promoted trips with a driver + outlet', () => {
  const { api, ss } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1', 'Truck ID': 3, 'Driver ID': 9, 'Outlet ID': 12 }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Truck ID': 4, 'Driver ID': 10, 'Outlet ID': 13 }),
      tripRow({ ID: 3, 'FO Number': 'FO-3', 'Outlet ID': 14 }),                  // no driver
      tripRow({ ID: 4, 'FO Number': 'FO-4', 'Driver ID': 9 }),                   // no outlet
      tripRow({ ID: 5, 'FO Number': 'FO-5', 'Driver ID': 9, 'Outlet ID': 15, 'Trip Date': '6/17/2026' }),
    ])
  );

  api.markDayScheduled('6/16/2026', 1);

  const { headers, rows } = dump(ss, 'Route Frequency Log');
  const logged = rows.map((r) => rowObject(headers, r));
  assert.equal(logged.length, 2);   // trips 3, 4 incomplete; trip 5 is another date
  assert.deepEqual(logged.map((f) => Number(f['Trip ID'])).sort(), [1, 2]);
  assert.deepEqual(logged.map((f) => f['Trip Date']), ['6/16/2026', '6/16/2026']);
  assert.equal(Number(logged[0]['Driver ID']), 9);
  assert.equal(Number(logged[0]['Outlet ID']), 12);
});

test('markDayScheduled leaves other dates and non-Prepping trips alone', () => {
  const { api, ss } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1' }),
      tripRow({ ID: 2, 'FO Number': 'FO-2', 'Trip Date': '6/17/2026' }),          // other date
      tripRow({ ID: 3, 'FO Number': 'FO-3', 'Trip Status': 'Delivered' }),        // not Prepping
    ])
  );

  const res = api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.promoted, 1);

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.equal(trips.find((t) => Number(t.ID) === 2)['Trip Status'], 'Prepping');
  assert.equal(trips.find((t) => Number(t.ID) === 3)['Trip Status'], 'Delivered');
  assert.equal(dump(ss, 'Waybills').rows.length, 1);
});

test('markDayScheduled trips of one FO with no truck share one waybill', () => {
  // ponytail-documented delta: unassigned slots of an FO collapse to one
  // waybill at promotion (Prepping exists so trucks get assigned first).
  const { api, ss } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1' }),
      tripRow({ ID: 2, 'FO Number': 'FO-1' }),
    ])
  );
  const res = api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.waybillsSuggested, 1);
  const wbs = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.equal(wbs[0]['Waybill Number'], wbs[1]['Waybill Number']);
});

test('markDayScheduled gives blank-FO trips their own waybills', () => {
  const { api, ss } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1 }),
      tripRow({ ID: 2 }),
    ])
  );
  const res = api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.waybillsSuggested, 2);
  const wbs = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.notEqual(wbs[0]['Waybill Number'], wbs[1]['Waybill Number']);
});

test('markDayScheduled skips trips that already have a waybill (idempotent-ish)', () => {
  const { api, ss } = asDispatcher(
    preppingSheets(
      [tripRow({ ID: 1, 'FO Number': 'FO-1' })],
      { Waybills: [HEADERS.Waybills.slice(), [9, 'AL-40', 1, 40, 1, 'FO-1', 'Regular', '', 'Suggested', false, '', '']] }
    )
  );
  const res = api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.promoted, 1);
  assert.equal(res.waybillsSuggested, 0);
  assert.equal(dump(ss, 'Waybills').rows.length, 1); // no duplicate
});

test('markDayScheduled is a no-op when nothing is Prepping', () => {
  const { api, ss } = asDispatcher(
    preppingSheets([tripRow({ ID: 1, 'Trip Status': 'Scheduled' })])
  );
  const res = api.markDayScheduled('6/16/2026', 1);
  assert.equal(res.success, true);
  assert.equal(res.promoted, 0);
  assert.equal(res.waybillsSuggested, 0);
  assert.equal(dump(ss, 'Waybills').rows.length, 0);
});

test('markDayScheduled fails cleanly for an unknown prefix', () => {
  const { api, ss } = asDispatcher(preppingSheets([tripRow({ ID: 1 })]));
  const res = api.markDayScheduled('6/16/2026', 999);
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
  // Nothing written.
  const trip = rowObject(HEADERS.Trips, dump(ss, 'Trips').rows[0]);
  assert.equal(trip['Trip Status'], 'Prepping');
});

test('markDayScheduled writes batched TRIP_STATUS_CHANGE audit rows', () => {
  const { api, ss } = asDispatcher(
    preppingSheets([
      tripRow({ ID: 1, 'FO Number': 'FO-1' }),
      tripRow({ ID: 2, 'FO Number': 'FO-2' }),
    ])
  );
  api.markDayScheduled('6/16/2026', 1);
  const audit = dump(ss, 'Audit Log');
  const actionIdx = audit.headers.indexOf('Action');
  const statusRows = audit.rows.filter((r) => r[actionIdx] === 'TRIP_STATUS_CHANGE');
  assert.equal(statusRows.length, 2);
  const oldIdx = audit.headers.indexOf('Old Value');
  const newIdx = audit.headers.indexOf('New Value');
  assert.ok(statusRows.every((r) => r[oldIdx] === 'Prepping' && r[newIdx] === 'Scheduled'));
});

test('markDayScheduled is gated by ADD_MANUAL_TRIP permission', () => {
  const { api } = makeEnv({
    sheets: preppingSheets([tripRow({ ID: 1 })]),
    userEmail: EMAIL.Viewer,
  });
  assert.throws(() => api.markDayScheduled('6/16/2026', 1), /Access denied/);
});
