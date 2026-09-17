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
const { loadWeb, plain } = require('./webharness');
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
  assert.equal(redeliver.waybillNumber, 'AL-7-R'); // 6 was reserved by the first suggestion

  const foul = api._createSuggestedWaybill(103, 1, 'FO-3', 'Foul Trip', null);
  assert.equal(foul.waybillNumber, 'AL-8-FT');

  // Suggesting reserves the number: the prefix's Last Sequence Number advances.
  const { rows } = dump(ss, 'Waybill Prefixes');
  assert.equal(rowObject(HEADERS['Waybill Prefixes'], rows[0])['Last Sequence Number'], 8);
});

test('sequence pads to the width implied by the stored value, and never truncates', () => {
  // Width 4 is implied by the stored "0357".
  const sheets = baseSheets();
  sheets['Waybill Prefixes'][1] = [1, 'AL', 'AngeLoyal', '0357'];
  const { api } = asAdmin(sheets);

  assert.equal(api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null).waybillNumber, 'AL-0358');
  // suffix rides after the padded number; 0358 was reserved, so the next is 0359
  assert.equal(api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null).waybillNumber, 'AL-0359-R');

  // A value already wider than any leading zeros prints in full — no truncation.
  const wide = baseSheets();
  wide['Waybill Prefixes'][1] = [1, 'AL', 'AngeLoyal', 12118];
  assert.equal(asAdmin(wide).api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null).waybillNumber, 'AL-12119');
});

test('confirming preserves the booklet width alongside the stored sequence', () => {
  const sheets = baseSheets();
  sheets['Waybill Prefixes'][1] = [1, 'AL', 'AngeLoyal', '0357'];
  const { api, ss } = asAdmin(sheets);

  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  api.confirmWaybill(id, null);

  // The counter is a plain number; the width it prints at lives in its own
  // column, so the next number still comes out as AL-0359.
  const stored = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0]);
  assert.equal(stored['Last Sequence Number'], 358);
  assert.equal(stored['Sequence Width'], 4);
  assert.equal(api._createSuggestedWaybill(102, 1, 'FO-2', 'Regular', null).waybillNumber, 'AL-0359');
});

test('blank prefix produces a bare sequence number, no leading dash', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets['Waybill Prefixes'][1] = [1, '', 'AngeLoyal', 5]; // Prefix column blank
  const { api } = asAdmin(sheets);

  const reg = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  assert.equal(reg.waybillNumber, '6');

  const redeliver = api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null);
  assert.equal(redeliver.waybillNumber, '7-R'); // 6 was reserved by the first suggestion
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

  // Suggesting reserves the numbers: the prefix advances to the last one issued.
  const seq = rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'];
  assert.equal(seq, 43);

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

// ---- confirmWaybill: one waybill, one row per stop of the load ----
// _suggestWaybillsForGroups gives a multi-stop load ONE number spread over one
// Waybill row per trip. Those rows are a single waybill, so confirming any of
// them must lock all of them — the dispatch board merges them into one cell and
// confirms from whichever row leads the run.
function loadOf(api, tripIds) {
  api._suggestWaybillsForGroups(1, [{ foNumber: 'FO-1', tripIds }]);
}

test('confirmWaybill locks every row of a multi-stop load, not just the one passed', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  loadOf(api, [101, 102, 103]); // one load, three stops, all AL-6

  const rows = () => dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.deepEqual(rows().map((w) => w['Waybill Number']), ['AL-6', 'AL-6', 'AL-6']);

  // Confirm via the MIDDLE row's id — any row of the waybill is a valid handle.
  const res = api.confirmWaybill(rows()[1].ID, null);
  assert.equal(res.success, true);
  assert.equal(res.confirmed, 3);

  const after = rows();
  assert.deepEqual(after.map((w) => w.Locked), [true, true, true]);
  assert.deepEqual(after.map((w) => w.Status), ['Confirmed', 'Confirmed', 'Confirmed']);
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-6', 'AL-6', 'AL-6']);
});

test('confirmWaybill applies a custom number to every stop of the load', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  loadOf(api, [101, 102, 103]);
  const rows = () => dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));

  // The old per-row confirm would have thrown "already confirmed and in use"
  // on the 2nd stop: the 1st was by then locked carrying the same number.
  const res = api.confirmWaybill(rows()[0].ID, 'AL-250');
  assert.equal(res.success, true);
  assert.equal(res.confirmed, 3);

  const after = rows();
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-250', 'AL-250', 'AL-250']);
  assert.deepEqual(after.map((w) => Number(w['Sequence Number'])), [250, 250, 250]);
  assert.deepEqual(after.map((w) => w.Locked), [true, true, true]);
});

test('confirmWaybill leaves a different load alone', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  api._suggestWaybillsForGroups(1, [
    { foNumber: 'FO-1', tripIds: [101, 102] }, // AL-6
    { foNumber: 'FO-2', tripIds: [201, 202] }, // AL-7
  ]);
  const rows = () => dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));

  const res = api.confirmWaybill(rows()[0].ID, null);
  assert.equal(res.confirmed, 2); // only FO-1's two stops

  const after = rows();
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-6', 'AL-6', 'AL-7', 'AL-7']);
  assert.deepEqual(after.map((w) => w.Locked), [true, true, false, false]);
});

test('confirmWaybill does not re-confirm an already-locked sibling', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  loadOf(api, [101, 102]);
  const rows = () => dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));

  // Simulate legacy half-confirmed data: lock one stop by hand, with a
  // different confirmer, and check the group confirm does not overwrite it.
  const ws = ss.getSheetByName('Waybills');
  const hdr = HEADERS.Waybills;
  ws.getRange(2, hdr.indexOf('Locked') + 1).setValue(true);
  ws.getRange(2, hdr.indexOf('Status') + 1).setValue('Confirmed');
  ws.getRange(2, hdr.indexOf('Confirmed By') + 1).setValue('someone.else@angeloyal.com');

  const res = api.confirmWaybill(rows()[1].ID, null);
  assert.equal(res.success, true);
  assert.equal(res.confirmed, 1); // only the still-unlocked stop

  const after = rows();
  assert.equal(after[0]['Confirmed By'], 'someone.else@angeloyal.com'); // untouched
  assert.equal(after[1]['Confirmed By'], 'admin@angeloyal.com');
  assert.deepEqual(after.map((w) => w.Locked), [true, true]);
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

// ---- updateSuggestedWaybill: edit before confirmation, stays Suggested ----
test('updateSuggestedWaybill renames the number but leaves it unlocked/Suggested', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null); // AL-6

  const res = api.updateSuggestedWaybill(id, 'GL-200');
  assert.equal(res.success, true);
  assert.equal(res.waybillNumber, 'GL-200');

  const wb = rowObject(HEADERS.Waybills, dump(ss, 'Waybills').rows[0]);
  assert.equal(wb['Waybill Number'], 'GL-200');
  assert.equal(Number(wb['Sequence Number']), 200); // parsed from the custom number
  assert.equal(wb.Status, 'Suggested');
  assert.equal(wb.Locked, false); // still editable, not confirmed
  assert.equal(wb['Confirmed By'], '');
});

test('updateSuggestedWaybill renames every stop of a multi-stop load', () => {
  const { api, ss } = asAdmin(baseSheets({ lastSeq: 5 }));
  loadOf(api, [101, 102, 103]); // one load, three stops, all AL-6
  const rows = () => dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));

  const res = api.updateSuggestedWaybill(rows()[1].ID, 'AL-9'); // via the middle stop
  assert.equal(res.updated, 3);
  const after = rows();
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-9', 'AL-9', 'AL-9']);
  assert.deepEqual(after.map((w) => w.Locked), [false, false, false]);
});

// Regression: renaming one load must not drag another load that happens to
// hold the same number. Two FOs on 13098 (a state the old value-only match
// created), rename one → only its rows move.
test('updateSuggestedWaybill leaves another load that shares the number alone', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills.push(
    [1, '13098', 1, 13098, 101, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
    [2, '13098', 1, 13098, 102, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
    [3, '13098', 1, 13098, 103, 'FO-B', 'Regular', '', 'Suggested', false, '', ''],
  );
  const { api, ss } = asAdmin(sheets);

  const res = api.updateSuggestedWaybill(1, '13094');
  assert.equal(res.success, true);
  assert.equal(res.updated, 2); // both stops of FO-A, not FO-B

  const after = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['13094', '13094', '13098']);
  assert.deepEqual(after.map((w) => Number(w['Sequence Number'])), [13094, 13094, 13098]);
});

test('updateSuggestedWaybill refuses a number already confirmed elsewhere', () => {
  const { api } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  const other = api._createSuggestedWaybill(202, 1, 'FO-2', 'Regular', null);
  api.confirmWaybill(other.id, 'AL-99'); // lock AL-99

  const res = api.updateSuggestedWaybill(id, 'AL-99');
  assert.equal(res.success, false);
  assert.match(res.error, /already confirmed/);
});

test('updateSuggestedWaybill refuses to edit a locked waybill', () => {
  const { api } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  api.confirmWaybill(id, null); // lock it

  const res = api.updateSuggestedWaybill(id, 'AL-123');
  assert.equal(res.success, false);
  assert.match(res.error, /locked/);
});

test('updateSuggestedWaybill rejects a blank number', () => {
  const { api } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  const res = api.updateSuggestedWaybill(id, '   ');
  assert.equal(res.success, false);
  assert.match(res.error, /blank/);
});

test('updateSuggestedWaybill is gated by CONFIRM_WAYBILL permission', () => {
  const sheets = baseSheets();
  const env = makeEnv({ sheets, userEmail: 'viewer@angeloyal.com' });
  sheets.Waybills.push([1, 'AL-6', 1, 6, 101, 'FO-1', 'Regular', '', 'Suggested', false, '', '']);
  assert.throws(() => env.api.updateSuggestedWaybill(1, 'AL-7'), /Access denied/);
});

// ---- updateSuggestedWaybills: the batch a renumbered column sends ----
test('updateSuggestedWaybills applies every edit in one pass', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills.push(
    [1, 'AL-6', 1, 6, 101, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
    [2, 'AL-6', 1, 6, 102, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
    [3, 'AL-7', 1, 7, 103, 'FO-B', 'Regular', '', 'Suggested', false, '', ''],
  );
  const { api, ss } = asAdmin(sheets);

  const res = api.updateSuggestedWaybills([
    { waybillId: 1, number: 'AL-20' },
    { waybillId: 3, number: 'AL-21' },
  ]);
  assert.equal(res.success, true);
  assert.deepEqual(plain(res.results).map((r) => r.updated), [2, 1]); // FO-A has two stops

  const after = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-20', 'AL-20', 'AL-21']);
  // The booklet counter is written once, at the batch's highest number.
  const pref = dump(ss, 'Waybill Prefixes').rows[0];
  assert.equal(Number(pref[3]), 21);
});

test('updateSuggestedWaybills lets the good edits land when one is rejected', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills.push(
    [1, 'AL-6', 1, 6, 101, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
    [2, 'AL-9', 1, 9, 102, 'FO-B', 'Regular', '', 'Confirmed', true, 'a@b.c', ''],
    [3, 'AL-7', 1, 7, 103, 'FO-C', 'Regular', '', 'Suggested', false, '', ''],
  );
  const { api, ss } = asAdmin(sheets);

  const res = api.updateSuggestedWaybills([
    { waybillId: 1, number: 'AL-9' },   // clashes with a confirmed number
    { waybillId: 2, number: 'AL-30' },  // locked
    { waybillId: 3, number: 'AL-31' },  // fine
    { waybillId: 99, number: 'AL-32' }, // no such row
  ]);

  assert.deepEqual(plain(res.results).map((r) => r.success), [false, false, true, false]);
  assert.match(res.results[0].error, /already confirmed/);
  assert.match(res.results[1].error, /locked/);
  assert.match(res.results[3].error, /not found/);

  const after = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-6', 'AL-9', 'AL-31']);
});

test('updateSuggestedWaybills sees an earlier edit of the same batch', () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills.push(
    [1, 'AL-6', 1, 6, 101, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
    [2, 'AL-6', 1, 6, 102, 'FO-A', 'Regular', '', 'Suggested', false, '', ''],
  );
  const { api, ss } = asAdmin(sheets);

  // Same load renamed twice in one batch — the second wins for both stops.
  api.updateSuggestedWaybills([
    { waybillId: 1, number: 'AL-20' },
    { waybillId: 2, number: 'AL-21' },
  ]);
  const after = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r));
  assert.deepEqual(after.map((w) => w['Waybill Number']), ['AL-21', 'AL-21']);
});

// ---- the board coalesces the edits instead of firing one call each ----
function boardWithTrips() {
  const { sandbox } = loadWeb(
    ['core.js', 'dispatch.js'],
    {},
    `
    currentUser = { email: 'a@b.c', displayName: 'A', role: 'Admin' };
    dispatchData = { trips: [
      { id: 1, foNumber: 'FO-A', suggestedWaybillId: 11, waybillSuggested: 'AL-1' },
      { id: 2, foNumber: 'FO-B', suggestedWaybillId: 12, waybillSuggested: 'AL-2' },
      { id: 3, foNumber: 'FO-C', suggestedWaybillId: 13, waybillSuggested: 'AL-3' },
    ] };
    globalThis.__calls = [];
    globalThis.renderDispatch = () => {};
    globalThis.showToast = () => {};
    globalThis.call = (fn, ...args) => {
      globalThis.__calls.push({ fn, args });
      return new Promise((res) => { globalThis.__settle = res; });
    };
    globalThis.__trips = () => dispatchData.trips;
    `,
  );
  return sandbox;
}

const tick = () => new Promise((r) => setImmediate(r));

test('a lone waybill edit goes out immediately', () => {
  const ui = boardWithTrips();
  ui.saveSuggestedWaybill(1, 'AL-90');

  assert.equal(ui.__calls.length, 1);
  assert.equal(ui.__calls[0].fn, 'updateSuggestedWaybills');
  assert.deepEqual(plain(ui.__calls[0].args[0]), [{ waybillId: 11, number: 'AL-90' }]);
  assert.equal(ui.__trips()[0].waybillSuggested, 'AL-90'); // optimistic
});

test('edits typed while a save is in flight ride home in one batch', async () => {
  const ui = boardWithTrips();
  ui.saveSuggestedWaybill(1, 'AL-90');
  ui.saveSuggestedWaybill(2, 'AL-91');
  ui.saveSuggestedWaybill(3, 'AL-92');
  assert.equal(ui.__calls.length, 1); // still just the first

  ui.__settle({
    success: true,
    results: [{ waybillId: 11, success: true, waybillNumber: 'AL-90', updated: 1 }],
  });
  await tick();

  assert.equal(ui.__calls.length, 2);
  assert.deepEqual(plain(ui.__calls[1].args[0]), [
    { waybillId: 12, number: 'AL-91' },
    { waybillId: 13, number: 'AL-92' },
  ]);
});

test('re-editing the same waybill before it is sent keeps only the last number', async () => {
  const ui = boardWithTrips();
  ui.saveSuggestedWaybill(1, 'AL-90'); // in flight
  ui.saveSuggestedWaybill(2, 'AL-91');
  ui.saveSuggestedWaybill(2, 'AL-95'); // corrected before the batch goes

  ui.__settle({ success: true,
    results: [{ waybillId: 11, success: true, waybillNumber: 'AL-90', updated: 1 }] });
  await tick();

  assert.deepEqual(plain(ui.__calls[1].args[0]), [{ waybillId: 12, number: 'AL-95' }]);
});

test('a rejected edit rolls back only its own rows', async () => {
  const ui = boardWithTrips();
  ui.saveSuggestedWaybill(1, 'AL-90');
  ui.saveSuggestedWaybill(2, 'AL-91');
  ui.__settle({ success: true,
    results: [{ waybillId: 11, success: true, waybillNumber: 'AL-90', updated: 1 }] });
  await tick();

  ui.__settle({
    success: true,
    results: [{ waybillId: 12, success: false, error: 'already confirmed and in use' }],
  });
  await tick();

  const trips = ui.__trips();
  assert.equal(trips[0].waybillSuggested, 'AL-90'); // kept
  assert.equal(trips[1].waybillSuggested, 'AL-2');  // rolled back
});

// --- helper: find a waybill row by id and return [headers, row] for rowObject ---
function rowFor(ss, sheetName, id) {
  const { headers, rows } = dump(ss, sheetName);
  const idIdx = headers.indexOf('ID');
  const row = rows.find((r) => Number(r[idIdx]) === Number(id));
  return [headers, row];
}
