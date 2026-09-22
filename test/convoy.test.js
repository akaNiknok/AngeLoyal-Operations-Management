// ============================================================
//  Convoy grouping — setTripConvoyGroup (server/writers/trips.js,
//  ported from DataWriters.gs). 'group' mints a per-date-unique
//  token onto every selected trip; 'ungroup' blanks it. Trips
//  must share one Trip Date.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function tripRow(fields) {
  const defaults = { 'Trip Date': '6/16/2026', 'Billing Date': '6/16/2026', 'Trip Status': 'Prepping', Source: 'Import' };
  return HEADERS.Trips.map((h) => (fields[h] !== undefined ? fields[h] : (defaults[h] !== undefined ? defaults[h] : '')));
}

function convoySheets(tripRows) {
  return {
    Users: usersSheet(),
    Trips: [HEADERS.Trips.slice(), ...tripRows],
    'Audit Log': emptySheet('Audit Log'),
  };
}

function asDispatcher(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
}

test('group mints a token past the date\'s existing maximum', async () => {
  const { api, db } = asDispatcher(
    convoySheets([
      tripRow({ ID: 1 }),
      tripRow({ ID: 2 }),
      tripRow({ ID: 3, 'Convoy Group': '4' }),               // existing group on the date
      tripRow({ ID: 4, 'Trip Date': '6/17/2026', 'Convoy Group': '9' }), // other date — ignored
    ])
  );

  const res = await api.setTripConvoyGroup([1, 2], 'group');
  assert.equal(res.success, true);
  assert.equal(res.group, '5'); // max(4) + 1, not max(9) + 1

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 1).convoy_group, '5');
  assert.equal(trips.find((t) => t.id === 2).convoy_group, '5');
  assert.equal(trips.find((t) => t.id === 3).convoy_group, '4'); // untouched
});

test('ungroup blanks the column', async () => {
  const { api, db } = asDispatcher(
    convoySheets([tripRow({ ID: 1, 'Convoy Group': '2' }), tripRow({ ID: 2, 'Convoy Group': '2' })])
  );
  const res = await api.setTripConvoyGroup([1], 'ungroup');
  assert.equal(res.success, true);
  assert.equal(res.group, '');

  const trips = dump(db, 'trips');
  assert.equal(trips.find((t) => t.id === 1).convoy_group, '');
  assert.equal(trips.find((t) => t.id === 2).convoy_group, '2'); // partner keeps its group
});

test('group rejects fewer than two trips', async () => {
  const { api } = asDispatcher(convoySheets([tripRow({ ID: 1 })]));
  const res = await api.setTripConvoyGroup([1], 'group');
  assert.equal(res.success, false);
  assert.match(res.error, /at least two/);
});

test('rejects trips spanning multiple dates', async () => {
  const { api, db } = asDispatcher(
    convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2, 'Trip Date': '6/17/2026' })])
  );
  const res = await api.setTripConvoyGroup([1, 2], 'group');
  assert.equal(res.success, false);
  assert.match(res.error, /one Trip Date/);
  // nothing written
  const trips = dump(db, 'trips');
  assert.ok(trips.every((t) => !t.convoy_group));
});

test('rejects an unknown trip id', async () => {
  const { api } = asDispatcher(convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })]));
  const res = await api.setTripConvoyGroup([1, 99], 'group');
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('writes a TRIP_CONVOY_CHANGE audit row per trip', async () => {
  const { api, db } = asDispatcher(
    convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2, 'Convoy Group': '1' })])
  );
  await api.setTripConvoyGroup([1, 2], 'group');

  const rows = dump(db, 'audit_log').filter((r) => r.action === 'TRIP_CONVOY_CHANGE');
  assert.equal(rows.length, 2);
  // trip 2's old group '1' is recorded; both get the new token '2'
  assert.deepEqual(rows.map((r) => [r.old_value, r.new_value]).sort(), [['', '2'], ['1', '2']]);
});

test('setTripConvoyGroup is gated by ASSIGN_CREW permission', async () => {
  const { api } = makeEnv({
    sheets: convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })]),
    userEmail: EMAIL.Viewer,
  });
  await assert.rejects(() => api.setTripConvoyGroup([1, 2], 'group'), /Access denied/);
});

// Two dispatchers group different trips on one date at the same moment.
// Each must get its own token, or the two convoys merge into one.
test('two groupings in flight on one date get two different tokens', async () => {
  const { api, db } = asDispatcher(
    convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2 }), tripRow({ ID: 3 }), tripRow({ ID: 4 })])
  );

  const [a, b] = await Promise.all([
    api.setTripConvoyGroup([1, 2], 'group'),
    api.setTripConvoyGroup([3, 4], 'group'),
  ]);
  assert.notEqual(a.group, b.group);
  const byId = Object.fromEntries(dump(db, 'trips').map((t) => [t.id, t.convoy_group]));
  assert.deepEqual([byId[1], byId[2], byId[3], byId[4]], [a.group, a.group, b.group, b.group]);
});
