// ============================================================
//  The trip-status vocabulary (TRIP_STATUSES in web/core.js).
//  Three UI surfaces read it — the chip color, the short label and
//  the status dropdown — and they used to be three hand-kept copies.
//  These tests pin the mapping and the fallbacks so a future edit to
//  one surface cannot silently desync the other two, and check the
//  list still covers the statuses the backend can put on a trip.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadWeb, plain } = require('./webharness');

function board() {
  const { sandbox } = loadWeb(
    ['core.js', 'dispatch.js'],
    {},
    'globalThis.__statuses = TRIP_STATUSES;',
  );
  return sandbox;
}

test('every status maps to its own chip class and short label', () => {
  const ui = board();
  const expected = [
    ['Prepping', 'sc-prepping', 'Prepping'],
    ['Backlog', 'sc-backlog', 'Backlog'],
    ['Scheduled', 'sc-scheduled', 'Scheduled'],
    ['Preload', 'sc-preload', 'Preload'],
    ['Delivered', 'sc-delivered', 'Delivered'],
    ['Undelivered', 'sc-undelivered', 'Undelivered'],
    ['Foul Trip - No Redeliver', 'sc-fouln', 'Foul – No RD'],
    ['Foul Trip - For Redeliver', 'sc-foutr', 'Foul – For RD'],
    ['Redeliver', 'sc-redeliver', 'Redeliver'],
    ['Two-Day Trip', 'sc-twoday', 'Two-Day'],
  ];

  assert.equal(ui.__statuses.length, expected.length);
  for (const [value, cls, label] of expected) {
    assert.equal(ui.statusChipClass(value), cls, `chip class for ${value}`);
    assert.equal(ui.shortStatus(value), label, `short label for ${value}`);
  }

  // Chip classes must be distinct, or two statuses would look identical.
  const classes = expected.map((e) => e[1]);
  assert.equal(new Set(classes).size, classes.length);
});

test('an unknown status still renders instead of blanking the cell', () => {
  const ui = board();
  assert.equal(ui.statusChipClass('Something New'), 'sc-scheduled');
  assert.equal(ui.shortStatus('Something New'), 'Something New');
});

test('the status dropdown offers exactly the known statuses, and marks the current one', () => {
  const ui = board();
  const html = ui.statusSelectOptions('Delivered');

  const values = [...html.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(values, plain(ui.__statuses).map((s) => s[0]));

  const selected = [...html.matchAll(/value="([^"]*)" selected/g)].map((m) => m[1]);
  assert.deepEqual(selected, ['Delivered']);
});

test('the dropdown shows short labels, not raw values', () => {
  const ui = board();
  const html = ui.statusSelectOptions('Scheduled');
  assert.match(html, />Foul – For RD</);
  assert.doesNotMatch(html, />Foul Trip - For Redeliver</);
});

// The backend decides a trip's status; the board has to be able to draw
// whatever it writes. These are the statuses DataWriters.gs acts on by name.
test('the statuses the backend writes are all known to the board', () => {
  const ui = board();
  const known = new Set(ui.__statuses.map((s) => s[0]));
  const writers = fs.readFileSync(
    path.resolve(__dirname, '..', 'DataWriters.gs'), 'utf8',
  );

  const carryover = /const carryoverStatuses = \[([^\]]*)\]/.exec(writers);
  assert.ok(carryover, 'carryoverStatuses list still exists in DataWriters.gs');

  const names = [...carryover[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 3);
  for (const name of names) {
    assert.equal(known.has(name), true, `backend status "${name}" is missing from TRIP_STATUSES`);
  }
});
