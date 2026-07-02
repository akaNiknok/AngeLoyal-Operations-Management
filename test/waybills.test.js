// ============================================================
//  Waybill numbering & confirmation tests
//  Covers Internals.gs (_createSuggestedWaybill,
//  _updateWaybillPrefixSequence) and DataWriters.confirmWaybill:
//  suffix rules, sequence increment, the out-of-order guard,
//  custom-number parsing, duplicate detection, and immutability.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet } = require('./fixtures');

function baseSheets({ lastSeq = 5 } = {}) {
  return {
    Users: usersSheet(),
    Waybills: [HEADERS.Waybills.slice()],
    'Waybill Prefixes': [
      HEADERS['Waybill Prefixes'].slice(),
      [1, 'AL', 'AngeLoyal', lastSeq],
    ],
    'Audit Log': [HEADERS['Audit Log'].slice()],
  };
}

function asAdmin(sheets) {
  return makeEnv({ sheets, userEmail: 'admin@angeloyal.com' });
}

// ---- _createSuggestedWaybill: suffix rules ----
test('suggested waybill number = prefix + (lastSeq+1) with type suffix', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));

  const reg = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  assert.equal(reg.waybillNumber, 'AL-6');

  const redeliver = api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null);
  assert.equal(redeliver.waybillNumber, 'AL-6-R'); // does NOT advance the prefix

  const foul = api._createSuggestedWaybill(103, 1, 'FO-3', 'Foul Trip', null);
  assert.equal(foul.waybillNumber, 'AL-6-FT');

  // Suggesting must NOT bump the prefix's Last Sequence Number — only confirming does.
  const { rows } = dump(ss, 'Waybill Prefixes');
  assert.equal(rowObject(HEADERS['Waybill Prefixes'], rows[0])['Last Sequence Number'], 5);
});

test('blank prefix produces a bare sequence number, no leading dash', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets['Waybill Prefixes'][1] = [1, '', 'AngeLoyal', 5]; // Prefix column blank
  const { api } = asAdmin(sheets);

  const reg = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  assert.equal(reg.waybillNumber, '6');

  const redeliver = api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null);
  assert.equal(redeliver.waybillNumber, '6-R');
});

test('suggested waybills are written unlocked / Suggested', () => {
  const { api, ss } = asAdmin(baseSheets());
  api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  const { headers, rows } = dump(ss, 'Waybills');
  const wb = rowObject(headers, rows[0]);
  assert.equal(wb.Status, 'Suggested');
  assert.equal(wb.Locked, false);
  assert.equal(wb['Trip ID'], 101);
});

test('_createSuggestedWaybill throws for an unknown prefix', () => {
  const { api } = asAdmin(baseSheets());
  assert.throws(() => api._createSuggestedWaybill(1, 999, 'FO', 'Regular', null), /not found/);
});

// ---- _suggestWaybillsForGroups: batch suggestion ----
test('_suggestWaybillsForGroups shares one number within a group, increments across groups', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 40 }));

  const out = api._suggestWaybillsForGroups(1, [
    { foNumber: 'FO-1', tripIds: [101, 102] },   // multi-drop: 2 rows, 1 number
    { foNumber: 'FO-2', tripIds: [103] },
    { foNumber: 'FO-3', tripIds: [] },           // empty group -> skipped, no number burned
    { foNumber: 'FO-4', tripIds: [104] },
  ]);

  assert.deepEqual([...out].map((o) => o.waybillNumber), ['AL-41', 'AL-41', 'AL-42', 'AL-43']);
  assert.deepEqual([...out].map((o) => o.tripId), [101, 102, 103, 104]);

  const { headers, rows } = dump(ss, 'Waybills');
  assert.equal(rows.length, 4);
  const wbs = rows.map((r) => rowObject(headers, r));
  assert.deepEqual(wbs.map((w) => w['Sequence Number']), [41, 41, 42, 43]);
  assert.ok(wbs.every((w) => w.Status === 'Suggested' && w.Locked === false && w['Waybill Type'] === 'Regular'));

  // Suggesting must NOT bump the prefix — only confirming does.
  const seq = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'];
  assert.equal(seq, 40);

  // Audit: one WAYBILL_SUGGEST row per waybill row.
  const audit = dump(ss, 'Audit Log');
  const actionIdx = audit.headers.indexOf('Action');
  assert.equal(audit.rows.filter((r) => r[actionIdx] === 'WAYBILL_SUGGEST').length, 4);
});

test('_suggestWaybillsForGroups supports a blank prefix', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets['Waybill Prefixes'][1] = [1, '', 'AngeLoyal', 5];
  const { api } = asAdmin(sheets);
  const out = api._suggestWaybillsForGroups(1, [{ foNumber: 'FO-1', tripIds: [101] }]);
  assert.equal(out[0].waybillNumber, '6');
});

test('_suggestWaybillsForGroups throws for an unknown prefix', () => {
  const { api } = asAdmin(baseSheets());
  assert.throws(() => api._suggestWaybillsForGroups(999, [{ foNumber: 'FO', tripIds: [1] }]), /not found/);
});

// ---- _updateWaybillPrefixSequence: out-of-order guard ----
test('prefix sequence only advances, never regresses', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 10 }));

  api._updateWaybillPrefixSequence(1, 12); // higher -> applied
  let val = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'];
  assert.equal(val, 12);

  api._updateWaybillPrefixSequence(1, 9); // lower -> ignored (out-of-order confirm)
  val = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'];
  assert.equal(val, 12);
});

// ---- confirmWaybill ----
test('confirmWaybill locks the row and bumps the prefix sequence', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null); // AL-6

  const res = api.confirmWaybill(id, null);
  assert.equal(res.success, true);
  assert.equal(res.waybillNumber, 'AL-6');

  const wb = rowObject(...rowFor(ss, 'Waybills', id));
  assert.equal(wb.Status, 'Confirmed');
  assert.equal(wb.Locked, true);
  assert.equal(wb['Confirmed By'], 'admin@angeloyal.com');

  const seq = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'];
  assert.equal(seq, 6);
});

test('confirmWaybill accepts a custom number and parses its sequence', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);

  const res = api.confirmWaybill(id, 'AL-250-R');
  assert.equal(res.success, true);
  assert.equal(res.waybillNumber, 'AL-250-R');

  const wb = rowObject(...rowFor(ss, 'Waybills', id));
  assert.equal(Number(wb['Sequence Number']), 250); // parsed from the custom number
  // prefix advanced to the custom sequence
  const seq = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'];
  assert.equal(seq, 250);
});

test('confirmWaybill rejects a custom number already confirmed elsewhere', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  // Pre-seed a confirmed waybill using the number we will collide with.
  sheets.Waybills.push([99, 'AL-99', 1, 99, 500, 'FO-X', 'Regular', '', 'Confirmed', true, 'x', 'x']);
  const { api } = asAdmin(sheets);
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);

  const res = api.confirmWaybill(id, 'AL-99');
  assert.equal(res.success, false);
  assert.match(res.error, /already confirmed/);
});

test('confirmWaybill refuses to re-confirm a locked waybill', () => {
  const { api } = asAdmin(baseSheets());
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  api.confirmWaybill(id, null);

  const res = api.confirmWaybill(id, null);
  assert.equal(res.success, false);
  assert.match(res.error, /already confirmed and locked/);
});

test('confirmWaybill is gated by CONFIRM_WAYBILL permission', () => {
  const sheets = baseSheets();
  const env = makeEnv({ sheets, userEmail: 'viewer@angeloyal.com' });
  // Seed a suggested waybill directly (viewer cannot create, and that is fine here).
  sheets.Waybills.push([1, 'AL-6', 1, 6, 101, 'FO-1', 'Regular', '', 'Suggested', false, '', '']);
  // _requirePermission runs before confirmWaybill's try/catch, so it throws
  // rather than returning a { success:false } envelope.
  assert.throws(() => env.api.confirmWaybill(1, null), /Access denied/);
});

// --- helper: find a waybill row by id and return [headers, row] for rowObject ---
function rowFor(ss, sheetName, id) {
  const { headers, rows } = dump(ss, sheetName);
  const idIdx = headers.indexOf('ID');
  const row = rows.find((r) => Number(r[idIdx]) === Number(id));
  return [headers, row];
}
