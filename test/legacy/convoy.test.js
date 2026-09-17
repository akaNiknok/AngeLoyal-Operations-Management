// ============================================================
//  Convoy grouping — setTripConvoyGroup (DataWriters.gs).
//  'group' mints a per-date-unique token onto every selected
//  trip; 'ungroup' blanks it. Trips must share one Trip Date.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
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

test('group mints a token past the date\'s existing maximum', () => {
  const { api, ss } = asDispatcher(
    convoySheets([
      tripRow({ ID: 1 }),
      tripRow({ ID: 2 }),
      tripRow({ ID: 3, 'Convoy Group': '4' }),               // existing group on the date
      tripRow({ ID: 4, 'Trip Date': '6/17/2026', 'Convoy Group': '9' }), // other date — ignored
    ])
  );

  const res = api.setTripConvoyGroup([1, 2], 'group');
  assert.equal(res.success, true);
  assert.equal(res.group, '5'); // max(4) + 1, not max(9) + 1

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.equal(trips.find((t) => Number(t.ID) === 1)['Convoy Group'], '5');
  assert.equal(trips.find((t) => Number(t.ID) === 2)['Convoy Group'], '5');
  assert.equal(trips.find((t) => Number(t.ID) === 3)['Convoy Group'], '4'); // untouched
});

test('ungroup blanks the column', () => {
  const { api, ss } = asDispatcher(
    convoySheets([tripRow({ ID: 1, 'Convoy Group': '2' }), tripRow({ ID: 2, 'Convoy Group': '2' })])
  );
  const res = api.setTripConvoyGroup([1], 'ungroup');
  assert.equal(res.success, true);
  assert.equal(res.group, '');

  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.equal(trips.find((t) => Number(t.ID) === 1)['Convoy Group'], '');
  assert.equal(trips.find((t) => Number(t.ID) === 2)['Convoy Group'], '2'); // partner keeps its group
});

test('group rejects fewer than two trips', () => {
  const { api } = asDispatcher(convoySheets([tripRow({ ID: 1 })]));
  const res = api.setTripConvoyGroup([1], 'group');
  assert.equal(res.success, false);
  assert.match(res.error, /at least two/);
});

test('rejects trips spanning multiple dates', () => {
  const { api, ss } = asDispatcher(
    convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2, 'Trip Date': '6/17/2026' })])
  );
  const res = api.setTripConvoyGroup([1, 2], 'group');
  assert.equal(res.success, false);
  assert.match(res.error, /one Trip Date/);
  // nothing written
  const trips = dump(ss, 'Trips').rows.map((r) => rowObject(HEADERS.Trips, r));
  assert.ok(trips.every((t) => t['Convoy Group'] === ''));
});

test('rejects an unknown trip id', () => {
  const { api } = asDispatcher(convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })]));
  const res = api.setTripConvoyGroup([1, 99], 'group');
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('writes a TRIP_CONVOY_CHANGE audit row per trip', () => {
  const { api, ss } = asDispatcher(
    convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2, 'Convoy Group': '1' })])
  );
  api.setTripConvoyGroup([1, 2], 'group');

  const audit = dump(ss, 'Audit Log');
  const actionIdx = audit.headers.indexOf('Action');
  const rows = audit.rows.filter((r) => r[actionIdx] === 'TRIP_CONVOY_CHANGE');
  assert.equal(rows.length, 2);
  const oldIdx = audit.headers.indexOf('Old Value');
  const newIdx = audit.headers.indexOf('New Value');
  // trip 2's old group '1' is recorded; both get the new token '2'
  assert.deepEqual(rows.map((r) => [String(r[oldIdx]), String(r[newIdx])]).sort(), [['', '2'], ['1', '2']]);
});

test('setTripConvoyGroup is gated by ASSIGN_CREW permission', () => {
  const { api } = makeEnv({
    sheets: convoySheets([tripRow({ ID: 1 }), tripRow({ ID: 2 })]),
    userEmail: EMAIL.Viewer,
  });
  assert.throws(() => api.setTripConvoyGroup([1, 2], 'group'), /Access denied/);
});
