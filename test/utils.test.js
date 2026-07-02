// ============================================================
//  Utils.gs — pure helper unit tests
//  These functions have no Sheets dependency; they encode the
//  date/ID/lookup logic everything else relies on.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');

const { api } = makeEnv();

// ---- _numOrNull ----
test('_numOrNull: blanks become null, numbers pass through', () => {
  assert.equal(api._numOrNull(''), null);
  assert.equal(api._numOrNull(null), null);
  assert.equal(api._numOrNull(undefined), null);
  assert.equal(api._numOrNull('abc'), null);
  assert.equal(api._numOrNull('42'), 42);
  assert.equal(api._numOrNull(0), 0); // zero must survive, not be coerced to null
  assert.equal(api._numOrNull(3.5), 3.5);
});

// ---- _val ----
test('_val: resolves by header name, null/undefined become empty string', () => {
  const headers = ['ID', 'Outlet Name', 'Area'];
  const row = [7, 'SM North', null];
  assert.equal(api._val(row, headers, 'ID'), 7);
  assert.equal(api._val(row, headers, 'Outlet Name'), 'SM North');
  assert.equal(api._val(row, headers, 'Area'), ''); // null -> ''
  assert.equal(api._val(row, headers, 'Missing Column'), ''); // unknown header -> ''
});

// ---- _parseDate / _formatDate round-trip ----
test('_parseDate parses M/d/yyyy at local midnight', () => {
  const d = api._parseDate('6/16/2026');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // June = 5
  assert.equal(d.getDate(), 16);
  assert.equal(d.getHours(), 0);
});

test('_formatDate is the inverse of _parseDate for M/d/yyyy', () => {
  assert.equal(api._formatDate(api._parseDate('1/5/2026')), '1/5/2026');
  assert.equal(api._formatDate(api._parseDate('12/31/2025')), '12/31/2025');
});

test('_formatDate returns empty string for invalid input', () => {
  assert.equal(api._formatDate(null), '');
  assert.equal(api._formatDate(new Date('not-a-date')), '');
  assert.equal(api._formatDate('6/16/2026'), ''); // not a Date object
});

// ---- _readDateCell: the Excel-serial conversion trap ----
test('_readDateCell handles Date objects, strings, and Excel serials', () => {
  assert.equal(api._readDateCell(''), null);
  assert.equal(api._readDateCell(null), null);

  const asDate = new Date(2026, 5, 16);
  assert.equal(api._readDateCell(asDate), asDate); // returned as-is

  const fromStr = api._readDateCell('6/16/2026');
  assert.equal(fromStr.getFullYear(), 2026);
  assert.equal(fromStr.getMonth(), 5);

  // Excel serial 45444 -> 2024-05-04 (serial 25569 == 1970-01-01)
  const fromSerial = api._readDateCell(45444);
  assert.ok(fromSerial instanceof Date);
  assert.equal(fromSerial.getUTCFullYear(), 2024);
});

// ---- _valDateTime: Date-coerced cells must serialize with separators ----
test('_valDateTime formats a Date-coerced cell as M/d/yyyy HH:mm:ss', () => {
  const headers = ['ID', 'Changed At'];
  const row = [1, new Date(2026, 5, 16, 9, 5, 3)];
  assert.equal(api._valDateTime(row, headers, 'Changed At'), '6/16/2026 09:05:03');
});

// ---- _nextBusinessDay: Sunday skip ----
test('_nextBusinessDay advances one day but skips Sundays', () => {
  // Friday 6/19/2026 -> Saturday 6/20
  const fri = new Date(2026, 5, 19);
  assert.equal(api._formatDate(api._nextBusinessDay(fri)), '6/20/2026');

  // Saturday 6/20/2026 -> would be Sunday, so skip to Monday 6/22
  const sat = new Date(2026, 5, 20);
  assert.equal(api._formatDate(api._nextBusinessDay(sat)), '6/22/2026');

  // Sunday itself 6/21 -> Monday 6/22 (next day is not Sunday)
  const sun = new Date(2026, 5, 21);
  assert.equal(api._formatDate(api._nextBusinessDay(sun)), '6/22/2026');
});

// ---- _startOfDay ----
test('_startOfDay zeroes the time component without mutating the input', () => {
  const original = new Date(2026, 5, 16, 14, 30, 45);
  const start = api._startOfDay(original);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(original.getHours(), 14); // original untouched
});

// ---- _round3: undoes binary float drift on numbers like CBM ----
test('_round3 rounds away float drift without altering clean values', () => {
  assert.equal(api._round3(10.568999999999999), 10.569);
  assert.equal(api._round3(10.569), 10.569);
  assert.equal(api._round3(null), null);
});

// ---- _findRowById ----
test('_findRowById returns the 0-based row index or -1', () => {
  const headers = ['ID', 'Name'];
  const rows = [headers, [1, 'a'], [2, 'b'], [3, 'c']];
  assert.equal(api._findRowById(rows, headers, 2), 2);
  assert.equal(api._findRowById(rows, headers, '3'), 3); // string id coerced
  assert.equal(api._findRowById(rows, headers, 99), -1);
});

// ---- _indexById ----
test('_indexById builds an id -> object map and skips null ids', () => {
  const idx = api._indexById([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: null, name: 'skip' },
  ]);
  assert.equal(idx[1].name, 'a');
  assert.equal(idx[2].name, 'b');
  assert.equal(Object.keys(idx).length, 2);
  assert.equal(api._indexById(null) && Object.keys(api._indexById(null)).length, 0);
});
