// ============================================================
//  Waybill numbering & confirmation tests
//  Covers server/writers/waybills.js: _createSuggestedWaybill,
//  _suggestWaybillsForGroups, _updateWaybillPrefixSequence,
//  confirmWaybill, updateSuggestedWaybill(s).
//
//  D1 rewrite: one `waybills` row per LOAD (trips sharing a number on one
//  FO), not one row per stop. A group's trips all get the same waybillId,
//  and confirming/renaming touches that one row — no per-row scan needed.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { loadWeb, plain } = require('./webharness');
const { HEADERS, usersSheet } = require('./fixtures');

function baseSheets({ lastSeq = 5 } = {}) {
  return {
    Users: usersSheet(),
    'Waybill Prefixes': [
      HEADERS['Waybill Prefixes'].slice(),
      [1, 'AL', 'AngeLoyal', lastSeq],
    ],
  };
}

function asAdmin(sheets) {
  return makeEnv({ sheets, userEmail: 'admin@angeloyal.com' });
}

/** A Waybills sheet row (legacy one-row-per-stop shape) from named fields. */
function waybillRow(fields) {
  return HEADERS.Waybills.map((h) => (fields[h] !== undefined ? fields[h] : ''));
}

/** A Trips sheet row from named fields; 'Trip Date' defaults so the row is valid. */
function tripRow(fields) {
  const f = { 'Trip Date': '1/1/2026', ...fields };
  return HEADERS.Trips.map((h) => (f[h] !== undefined ? f[h] : ''));
}

const prefixRow = (db) => dump(db, 'waybill_prefixes')[0];
const waybill = (db, id) => dump(db, 'waybills').find((w) => w.id === id);
const trip = (db, id) => dump(db, 'trips').find((t) => t.id === id);

// ---- _createSuggestedWaybill: suffix rules ----
test('suggested waybill number = prefix + (lastSeq+1) with type suffix', async () => {
  const { api, db } = asAdmin(baseSheets({ lastSeq: 5 }));

  const reg = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  assert.equal(reg.waybillNumber, 'AL-6');

  const redeliver = await api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null);
  assert.equal(redeliver.waybillNumber, 'AL-7-R'); // 6 was reserved by the first suggestion

  const foul = await api._createSuggestedWaybill(103, 1, 'FO-3', 'Foul Trip', null);
  assert.equal(foul.waybillNumber, 'AL-8-FT');

  // Suggesting reserves the number: the prefix's Last Sequence Number advances.
  assert.equal(prefixRow(db).last_sequence_number, 8);
});

test('sequence pads to the width implied by the stored value, and never truncates', async () => {
  // Width 4 is implied by the stored "0357".
  const sheets = baseSheets();
  sheets['Waybill Prefixes'][1] = [1, 'AL', 'AngeLoyal', '0357'];
  const { api } = asAdmin(sheets);

  assert.equal((await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null)).waybillNumber, 'AL-0358');
  // suffix rides after the padded number; 0358 was reserved, so the next is 0359
  assert.equal((await api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null)).waybillNumber, 'AL-0359-R');

  // A value already wider than any leading zeros prints in full — no truncation.
  const wide = baseSheets();
  wide['Waybill Prefixes'][1] = [1, 'AL', 'AngeLoyal', 12118];
  const r = await asAdmin(wide).api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  assert.equal(r.waybillNumber, 'AL-12119');
});

test('confirming preserves the booklet width alongside the stored sequence', async () => {
  const sheets = baseSheets();
  sheets['Waybill Prefixes'][1] = [1, 'AL', 'AngeLoyal', '0357'];
  const { api, db } = asAdmin(sheets);

  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  await api.confirmWaybill(id, null);

  // The counter is a plain number; the width it prints at lives in its own
  // column, so the next number still comes out as AL-0359.
  const pref = prefixRow(db);
  assert.equal(pref.last_sequence_number, 358);
  assert.equal(pref.sequence_width, 4);
  assert.equal((await api._createSuggestedWaybill(102, 1, 'FO-2', 'Regular', null)).waybillNumber, 'AL-0359');
});

test('blank prefix produces a bare sequence number, no leading dash', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets['Waybill Prefixes'][1] = [1, '', 'AngeLoyal', 5]; // Prefix column blank
  const { api } = asAdmin(sheets);

  const reg = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  assert.equal(reg.waybillNumber, '6');

  const redeliver = await api._createSuggestedWaybill(102, 1, 'FO-2', 'Redeliver', null);
  assert.equal(redeliver.waybillNumber, '7-R'); // 6 was reserved by the first suggestion
});

test('suggested waybills are written Suggested, and the trip is linked through waybill_id', async () => {
  const sheets = baseSheets();
  sheets.Trips = [HEADERS.Trips.slice(), tripRow({ ID: 101, 'FO Number': 'FO-1' })];
  const { api, db } = asAdmin(sheets);

  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  const wb = dump(db, 'waybills')[0];
  assert.equal(wb.status, 'Suggested');
  assert.equal(trip(db, 101).waybill_id, id);
});

test('_createSuggestedWaybill throws for an unknown prefix', async () => {
  const { api } = asAdmin(baseSheets());
  await assert.rejects(() => api._createSuggestedWaybill(1, 999, 'FO', 'Regular', null), /not found/);
});

// ---- _suggestWaybillsForGroups: one row per LOAD ----
test('_suggestWaybillsForGroups shares one row within a group, increments across groups', async () => {
  const sheets = baseSheets({ lastSeq: 40 });
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-1' }),
    tripRow({ ID: 102, 'FO Number': 'FO-1' }),
    tripRow({ ID: 103, 'FO Number': 'FO-2' }),
    tripRow({ ID: 104, 'FO Number': 'FO-4' }),
  ];
  const { api, db } = asAdmin(sheets);

  const out = await api._suggestWaybillsForGroups(1, [
    { foNumber: 'FO-1', tripIds: [101, 102] },   // multi-drop: 1 row, shared by 2 trips
    { foNumber: 'FO-2', tripIds: [103] },
    { foNumber: 'FO-3', tripIds: [] },           // empty group -> skipped, no number burned
    { foNumber: 'FO-4', tripIds: [104] },
  ]);

  assert.deepEqual(out.map((o) => o.waybillNumber), ['AL-41', 'AL-41', 'AL-42', 'AL-43']);
  assert.deepEqual(out.map((o) => o.tripId), [101, 102, 103, 104]);
  assert.equal(out[0].waybillId, out[1].waybillId); // FO-1's two stops share one row

  const wbRows = dump(db, 'waybills');
  assert.equal(wbRows.length, 3); // one row per LOAD, not per stop
  assert.deepEqual(wbRows.map((w) => w.sequence_number), [41, 42, 43]);
  assert.ok(wbRows.every((w) => w.status === 'Suggested' && w.waybill_type === 'Regular'));

  assert.equal(trip(db, 101).waybill_id, trip(db, 102).waybill_id);
  assert.notEqual(trip(db, 101).waybill_id, trip(db, 103).waybill_id);

  // Suggesting reserves the numbers: the prefix advances to the last one issued.
  assert.equal(prefixRow(db).last_sequence_number, 43);

  // Audit: one WAYBILL_SUGGEST row per LOAD (waybills row), not per stop.
  const audit = dump(db, 'audit_log');
  assert.equal(audit.filter((r) => r.action === 'WAYBILL_SUGGEST').length, 3);
});

test('_suggestWaybillsForGroups supports a blank prefix', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets['Waybill Prefixes'][1] = [1, '', 'AngeLoyal', 5];
  const { api } = asAdmin(sheets);
  const out = await api._suggestWaybillsForGroups(1, [{ foNumber: 'FO-1', tripIds: [101] }]);
  assert.equal(out[0].waybillNumber, '6');
});

test('_suggestWaybillsForGroups throws for an unknown prefix', async () => {
  const { api } = asAdmin(baseSheets());
  await assert.rejects(() => api._suggestWaybillsForGroups(999, [{ foNumber: 'FO', tripIds: [1] }]), /not found/);
});

// ---- _updateWaybillPrefixSequence: out-of-order guard ----
test('prefix sequence only advances, never regresses', async () => {
  const { api, db } = asAdmin(baseSheets({ lastSeq: 10 }));

  await api._updateWaybillPrefixSequence(1, 12); // higher -> applied
  assert.equal(prefixRow(db).last_sequence_number, 12);

  await api._updateWaybillPrefixSequence(1, 9); // lower -> ignored (out-of-order confirm)
  assert.equal(prefixRow(db).last_sequence_number, 12);
});

// ---- confirmWaybill ----
test('confirmWaybill locks the waybill and bumps the prefix sequence', async () => {
  const { api, db } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null); // AL-6

  const res = await api.confirmWaybill(id, null);
  assert.equal(res.success, true);
  assert.equal(res.waybillNumber, 'AL-6');

  const wb = waybill(db, id);
  assert.equal(wb.status, 'Confirmed');
  assert.equal(wb.confirmed_by, 'admin@angeloyal.com');

  assert.equal(prefixRow(db).last_sequence_number, 6);
});

test('confirmWaybill accepts a custom number and parses its sequence', async () => {
  const { api, db } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);

  const res = await api.confirmWaybill(id, 'AL-250-R');
  assert.equal(res.success, true);
  assert.equal(res.waybillNumber, 'AL-250-R');

  const wb = waybill(db, id);
  assert.equal(Number(wb.sequence_number), 250); // parsed from the custom number
  // prefix advanced to the custom sequence
  assert.equal(prefixRow(db).last_sequence_number, 250);
});

test('confirmWaybill rejects a custom number already confirmed elsewhere', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  // Pre-seed a confirmed waybill (a different load) using the number we collide with.
  sheets.Waybills = [
    HEADERS.Waybills.slice(),
    waybillRow({
      ID: 99, 'Waybill Number': 'AL-99', 'Prefix ID': 1, 'Sequence Number': 99, 'Trip ID': 500,
      'FO Number': 'FO-X', 'Waybill Type': 'Regular', Status: 'Confirmed', Locked: true, 'Confirmed By': 'x',
    }),
  ];
  const { api } = asAdmin(sheets);
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);

  const res = await api.confirmWaybill(id, 'AL-99');
  assert.equal(res.success, false);
  assert.match(res.error, /already confirmed/);
});

test('confirmWaybill refuses to re-confirm a locked waybill', async () => {
  const { api } = asAdmin(baseSheets());
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  await api.confirmWaybill(id, null);

  const res = await api.confirmWaybill(id, null);
  assert.equal(res.success, false);
  assert.match(res.error, /already confirmed and locked/);
});

// ---- confirmWaybill: one waybill row, several stops ----
test('confirmWaybill on a multi-stop load confirms every stop through its one shared row', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-1' }),
    tripRow({ ID: 102, 'FO Number': 'FO-1' }),
    tripRow({ ID: 103, 'FO Number': 'FO-1' }),
  ];
  const { api, db } = asAdmin(sheets);
  const out = await api._suggestWaybillsForGroups(1, [{ foNumber: 'FO-1', tripIds: [101, 102, 103] }]); // one row, AL-6
  const waybillId = out[0].waybillId;

  const res = await api.confirmWaybill(waybillId, null);
  assert.equal(res.success, true);
  assert.equal(res.confirmed, 3); // three stops confirmed through the one row

  assert.equal(waybill(db, waybillId).status, 'Confirmed');
  assert.ok([101, 102, 103].every((id) => trip(db, id).waybill_id === waybillId));
});

test('confirmWaybill applies a custom number to every stop of the load', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-1' }),
    tripRow({ ID: 102, 'FO Number': 'FO-1' }),
    tripRow({ ID: 103, 'FO Number': 'FO-1' }),
  ];
  const { api, db } = asAdmin(sheets);
  const out = await api._suggestWaybillsForGroups(1, [{ foNumber: 'FO-1', tripIds: [101, 102, 103] }]);

  const res = await api.confirmWaybill(out[0].waybillId, 'AL-250');
  assert.equal(res.success, true);
  assert.equal(res.confirmed, 3);

  const wb = waybill(db, out[0].waybillId);
  assert.equal(wb.waybill_number, 'AL-250');
  assert.equal(Number(wb.sequence_number), 250);
  assert.equal(wb.status, 'Confirmed');
});

test('confirmWaybill leaves a different load alone', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-1' }),
    tripRow({ ID: 102, 'FO Number': 'FO-1' }),
    tripRow({ ID: 201, 'FO Number': 'FO-2' }),
    tripRow({ ID: 202, 'FO Number': 'FO-2' }),
  ];
  const { api, db } = asAdmin(sheets);
  const out = await api._suggestWaybillsForGroups(1, [
    { foNumber: 'FO-1', tripIds: [101, 102] }, // AL-6
    { foNumber: 'FO-2', tripIds: [201, 202] }, // AL-7
  ]);
  const wbA = out[0].waybillId;
  const wbB = out[2].waybillId;

  const res = await api.confirmWaybill(wbA, null);
  assert.equal(res.confirmed, 2); // only FO-1's two stops

  assert.equal(waybill(db, wbA).status, 'Confirmed');
  assert.equal(waybill(db, wbB).status, 'Suggested');
});

test('confirmWaybill is gated by CONFIRM_WAYBILL permission', async () => {
  const sheets = baseSheets();
  sheets.Waybills = [
    HEADERS.Waybills.slice(),
    waybillRow({
      ID: 1, 'Waybill Number': 'AL-6', 'Prefix ID': 1, 'Sequence Number': 6, 'Trip ID': 101,
      'FO Number': 'FO-1', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false,
    }),
  ];
  const env = makeEnv({ sheets, userEmail: 'viewer@angeloyal.com' });
  // requirePermission runs before confirmWaybill's try/catch, so it rejects
  // rather than resolving to a { success:false } envelope.
  await assert.rejects(() => env.api.confirmWaybill(1, null), /Access denied/);
});

// ---- updateSuggestedWaybill: edit before confirmation, stays Suggested ----
test('updateSuggestedWaybill renames the number but leaves it unlocked/Suggested', async () => {
  const { api, db } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null); // AL-6

  const res = await api.updateSuggestedWaybill(id, 'GL-200');
  assert.equal(res.success, true);
  assert.equal(res.waybillNumber, 'GL-200');

  const wb = waybill(db, id);
  assert.equal(wb.waybill_number, 'GL-200');
  assert.equal(Number(wb.sequence_number), 200); // parsed from the custom number
  assert.equal(wb.status, 'Suggested'); // still editable, not confirmed
  assert.equal(wb.confirmed_by, null);
});

test('updateSuggestedWaybill renames every stop of a multi-stop load through its one row', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-1' }),
    tripRow({ ID: 102, 'FO Number': 'FO-1' }),
    tripRow({ ID: 103, 'FO Number': 'FO-1' }),
  ];
  const { api, db } = asAdmin(sheets);
  const out = await api._suggestWaybillsForGroups(1, [{ foNumber: 'FO-1', tripIds: [101, 102, 103] }]); // one row, AL-6

  const res = await api.updateSuggestedWaybill(out[0].waybillId, 'AL-9');
  assert.equal(res.updated, 3);
  const wb = waybill(db, out[0].waybillId);
  assert.equal(wb.waybill_number, 'AL-9');
  assert.equal(wb.status, 'Suggested');
});

// Regression: renaming one load must not drag another load that happens to
// hold the same number (waybill_number is not unique across loads).
test('updateSuggestedWaybill leaves another load that shares the number alone', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills = [
    HEADERS.Waybills.slice(),
    waybillRow({ ID: 1, 'Waybill Number': '13098', 'Prefix ID': 1, 'Sequence Number': 13098, 'Trip ID': 101, 'FO Number': 'FO-A', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
    waybillRow({ ID: 2, 'Waybill Number': '13098', 'Prefix ID': 1, 'Sequence Number': 13098, 'Trip ID': 102, 'FO Number': 'FO-A', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
    waybillRow({ ID: 3, 'Waybill Number': '13098', 'Prefix ID': 1, 'Sequence Number': 13098, 'Trip ID': 103, 'FO Number': 'FO-B', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
  ];
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-A' }),
    tripRow({ ID: 102, 'FO Number': 'FO-A' }),
    tripRow({ ID: 103, 'FO Number': 'FO-B' }),
  ];
  const { api, db } = asAdmin(sheets);

  // FO-A's two rows merge into one load (kept id 1); FO-B is its own load (id 3).
  assert.equal(dump(db, 'waybills').length, 2);

  const res = await api.updateSuggestedWaybill(1, '13094');
  assert.equal(res.success, true);
  assert.equal(res.updated, 2); // both stops of FO-A, not FO-B

  assert.equal(waybill(db, 1).waybill_number, '13094');
  assert.equal(waybill(db, 3).waybill_number, '13098'); // FO-B untouched
});

test('updateSuggestedWaybill refuses a number already confirmed elsewhere', async () => {
  const { api } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  const other = await api._createSuggestedWaybill(202, 1, 'FO-2', 'Regular', null);
  await api.confirmWaybill(other.id, 'AL-99'); // lock AL-99

  const res = await api.updateSuggestedWaybill(id, 'AL-99');
  assert.equal(res.success, false);
  assert.match(res.error, /already confirmed/);
});

test('updateSuggestedWaybill refuses to edit a locked waybill', async () => {
  const { api } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  await api.confirmWaybill(id, null); // lock it

  const res = await api.updateSuggestedWaybill(id, 'AL-123');
  assert.equal(res.success, false);
  assert.match(res.error, /locked/);
});

test('updateSuggestedWaybill rejects a blank number', async () => {
  const { api } = asAdmin(baseSheets({ lastSeq: 5 }));
  const { id } = await api._createSuggestedWaybill(101, 1, 'FO-1', 'Regular', null);
  const res = await api.updateSuggestedWaybill(id, '   ');
  assert.equal(res.success, false);
  assert.match(res.error, /blank/);
});

test('updateSuggestedWaybill is gated by CONFIRM_WAYBILL permission', async () => {
  const sheets = baseSheets();
  sheets.Waybills = [
    HEADERS.Waybills.slice(),
    waybillRow({ ID: 1, 'Waybill Number': 'AL-6', 'Prefix ID': 1, 'Sequence Number': 6, 'Trip ID': 101, 'FO Number': 'FO-1', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
  ];
  const env = makeEnv({ sheets, userEmail: 'viewer@angeloyal.com' });
  await assert.rejects(() => env.api.updateSuggestedWaybill(1, 'AL-7'), /Access denied/);
});

// ---- updateSuggestedWaybills: the batch a renumbered column sends ----
test('updateSuggestedWaybills applies every edit in one pass', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills = [
    HEADERS.Waybills.slice(),
    waybillRow({ ID: 1, 'Waybill Number': 'AL-6', 'Prefix ID': 1, 'Sequence Number': 6, 'Trip ID': 101, 'FO Number': 'FO-A', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
    waybillRow({ ID: 2, 'Waybill Number': 'AL-6', 'Prefix ID': 1, 'Sequence Number': 6, 'Trip ID': 102, 'FO Number': 'FO-A', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
    waybillRow({ ID: 3, 'Waybill Number': 'AL-7', 'Prefix ID': 1, 'Sequence Number': 7, 'Trip ID': 103, 'FO Number': 'FO-B', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
  ];
  sheets.Trips = [
    HEADERS.Trips.slice(),
    tripRow({ ID: 101, 'FO Number': 'FO-A' }),
    tripRow({ ID: 102, 'FO Number': 'FO-A' }),
    tripRow({ ID: 103, 'FO Number': 'FO-B' }),
  ];
  const { api, db } = asAdmin(sheets);

  // FO-A's rows (1, 2) merge into one load (kept id 1); FO-B keeps id 3.
  const res = await api.updateSuggestedWaybills([
    { waybillId: 1, number: 'AL-20' },
    { waybillId: 3, number: 'AL-21' },
  ]);
  assert.equal(res.success, true);
  assert.deepEqual(res.results.map((r) => r.updated), [2, 1]); // FO-A has two stops

  const rows = dump(db, 'waybills');
  assert.equal(rows.length, 2); // one row per load
  assert.equal(waybill(db, 1).waybill_number, 'AL-20');
  assert.equal(waybill(db, 3).waybill_number, 'AL-21');
  // The booklet counter is written once, at the batch's highest number.
  assert.equal(prefixRow(db).last_sequence_number, 21);
});

test('updateSuggestedWaybills lets the good edits land when one is rejected', async () => {
  const sheets = baseSheets({ lastSeq: 5 });
  sheets.Waybills = [
    HEADERS.Waybills.slice(),
    waybillRow({ ID: 1, 'Waybill Number': 'AL-6', 'Prefix ID': 1, 'Sequence Number': 6, 'Trip ID': 101, 'FO Number': 'FO-A', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
    waybillRow({ ID: 2, 'Waybill Number': 'AL-9', 'Prefix ID': 1, 'Sequence Number': 9, 'Trip ID': 102, 'FO Number': 'FO-B', 'Waybill Type': 'Regular', Status: 'Confirmed', Locked: true, 'Confirmed By': 'a@b.c' }),
    waybillRow({ ID: 3, 'Waybill Number': 'AL-7', 'Prefix ID': 1, 'Sequence Number': 7, 'Trip ID': 103, 'FO Number': 'FO-C', 'Waybill Type': 'Regular', Status: 'Suggested', Locked: false }),
  ];
  const { api, db } = asAdmin(sheets);

  const res = await api.updateSuggestedWaybills([
    { waybillId: 1, number: 'AL-9' },   // clashes with a confirmed number
    { waybillId: 2, number: 'AL-30' },  // locked
    { waybillId: 3, number: 'AL-31' },  // fine
    { waybillId: 99, number: 'AL-32' }, // no such row
  ]);

  assert.deepEqual(res.results.map((r) => r.success), [false, false, true, false]);
  assert.match(res.results[0].error, /already confirmed/);
  assert.match(res.results[1].error, /locked/);
  assert.match(res.results[3].error, /not found/);

  assert.equal(waybill(db, 1).waybill_number, 'AL-6');
  assert.equal(waybill(db, 2).waybill_number, 'AL-9');
  assert.equal(waybill(db, 3).waybill_number, 'AL-31');
});

// ---- the board coalesces the edits instead of firing one call each ----
// Client-side batching in web/dispatch.js — the updateSuggestedWaybills call
// shape is unchanged by the D1 port, so these run against the frontend only.
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
