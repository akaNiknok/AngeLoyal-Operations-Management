// ============================================================
//  Waybill Prefix writers (server/writers/waybills.js).
//  Covers validation, dedup, the digit-width-preserving sequence
//  cell, and the EDIT_WAYBILL_PREFIXES gate (Admin + Dispatcher).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, EMAIL } = require('./fixtures');

function base(rows = [[1, 'AY', 'AngeLoyal Logistics', '0357']]) {
  return {
    Users: usersSheet(),
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice()].concat(rows),
  };
}

const prefixRows = (db) => dump(db, 'waybill_prefixes');
const prefixById = (db, id) => prefixRows(db).find((r) => r.id === id);

/** Waybills sheet row builder from named fields; everything else blank. */
function waybillRow(fields) {
  return HEADERS.Waybills.map((h) => (fields[h] !== undefined ? fields[h] : ''));
}

test('a dispatcher can add a prefix and its zero-padded width survives', async () => {
  const { api, db } = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });

  const res = await api.createWaybillPrefix({
    prefix: 'RB',
    companyName: 'Rebisco Hauling',
    lastSequenceNumber: '0000',
  });
  assert.equal(res.success, true);
  assert.equal(res.waybillPrefix.id, 2);
  assert.equal(res.waybillPrefix.sequenceWidth, 4);

  // The counter is a plain number and the booklet width has its own column —
  // nothing depends on how the cell happens to be formatted.
  const stored = prefixById(db, 2);
  assert.equal(stored.last_sequence_number, 0);
  assert.equal(stored.sequence_width, 4);

  const read = (await api.getWaybillPrefixes()).find((p) => p.id === 2);
  assert.equal(read.prefix, 'RB');
  assert.equal(read.companyName, 'Rebisco Hauling');
  assert.equal(read.lastSequenceNumber, 0);
  assert.equal(read.sequenceWidth, 4);

  const audit = dump(db, 'audit_log');
  assert.equal(audit.filter((r) => r.action === 'WAYBILL_PREFIX_CREATE').length, 1);
});

test('createWaybillPrefix rejects a duplicate prefix and a non-numeric sequence', async () => {
  const { api } = makeEnv({ sheets: base(), userEmail: EMAIL.Admin });

  const dup = await api.createWaybillPrefix({ prefix: 'ay', companyName: 'X', lastSequenceNumber: '1' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const bad = await api.createWaybillPrefix({ prefix: 'ZZ', companyName: 'X', lastSequenceNumber: '12a' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /digits only/);

  const noName = await api.createWaybillPrefix({ prefix: 'ZZ', companyName: '', lastSequenceNumber: '1' });
  assert.equal(noName.success, false);
  assert.match(noName.error, /Company name is required/);
});

test('re-basing Last Sequence Number rewrites width and leaves the other columns intact', async () => {
  const { api, db } = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });

  const res = await api.updateWaybillPrefix(1, { lastSequenceNumber: '010760' });
  assert.equal(res.success, true);
  assert.equal(res.waybillPrefix.lastSequenceNumber, 10760);
  assert.equal(res.waybillPrefix.sequenceWidth, 6);

  let row = prefixById(db, 1);
  assert.equal(row.last_sequence_number, 10760);
  assert.equal(row.sequence_width, 6);   // width comes from the typed text's length
  assert.equal(row.prefix, 'AY');
  assert.equal(row.company_name, 'AngeLoyal Logistics');

  // Re-basing narrower rewrites the width too.
  await api.updateWaybillPrefix(1, { lastSequenceNumber: '412' });
  row = prefixById(db, 1);
  assert.equal(row.last_sequence_number, 412);
  assert.equal(row.sequence_width, 3);

  const audit = dump(db, 'audit_log');
  assert.equal(audit.filter((r) => r.action === 'WAYBILL_PREFIX_EDIT').length, 2);
});

test('updateWaybillPrefix renames without touching the stored sequence', async () => {
  const { api, db } = makeEnv({ sheets: base(), userEmail: EMAIL.Admin });

  const res = await api.updateWaybillPrefix(1, { prefix: '', companyName: 'AngeLoyal Logistics Inc.' });
  assert.equal(res.success, true);
  assert.equal(res.waybillPrefix.sequenceWidth, 4);

  const row = prefixById(db, 1);
  assert.equal(row.prefix, '');
  assert.equal(row.company_name, 'AngeLoyal Logistics Inc.');
  assert.equal(row.last_sequence_number, 357);   // untouched
});

test('waybill prefix writers are gated to Admin + Dispatcher', async () => {
  for (const email of [EMAIL.Payroll, EMAIL.Viewer, EMAIL.Unknown]) {
    const { api } = makeEnv({ sheets: base(), userEmail: email });
    await assert.rejects(() => api.updateWaybillPrefix(1, { companyName: 'X' }), /Access denied/);
    await assert.rejects(
      () => api.createWaybillPrefix({ prefix: 'Q', companyName: 'X', lastSequenceNumber: '1' }),
      /Access denied/,
    );
  }
});

test('removing a prefix is a soft delete, and restoring it brings it back', async () => {
  const { api, db } = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });

  const removed = await api.updateWaybillPrefix(1, { active: false });
  assert.equal(removed.success, true);
  assert.equal(removed.waybillPrefix.active, false);
  assert.equal(prefixById(db, 1).active, 0);
  // Soft delete: the row (and its sequence) survives for waybills already issued.
  assert.equal((await api.getWaybillPrefixes()).find((p) => p.id === 1).lastSequenceNumber, 357);

  const restored = await api.updateWaybillPrefix(1, { active: true });
  assert.equal(restored.waybillPrefix.active, true);
  assert.equal((await api.getWaybillPrefixes()).find((p) => p.id === 1).active, true);
});

test('re-adding a removed prefix points at Restore', async () => {
  const { api } = makeEnv({ sheets: base(), userEmail: EMAIL.Admin });

  await api.updateWaybillPrefix(1, { active: false });

  const res = await api.createWaybillPrefix({
    prefix: 'ay',
    companyName: 'AngeLoyal Logistics',
    lastSequenceNumber: '0357',
  });
  assert.equal(res.success, false);
  assert.match(res.error, /already exists but was removed — restore it/);
});

// ---- Zero-padded booklets: the counter that never advanced ----
//
// Regression for the production bug: a prefix whose Last Sequence Number was
// stored zero-padded as text (AY "0358", GL "039") never advanced, because the
// only write that could move it went through setNumberFormat('@').setValue(),
// which silently did nothing. Those booklets re-issued one number forever —
// AY-0359 landed on four different FOs and GL-040 on two — while every prefix
// stored without a leading zero advanced normally. The pad width now lives in
// its own column and the counter is written as a plain number.

test('a zero-padded booklet advances instead of re-issuing the same number', async () => {
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);   // legacy padded text
  const { api, db } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  assert.equal((await api._createSuggestedWaybill(70, 1, '6100063927', 'Regular', null)).waybillNumber, 'GL-040');
  assert.equal((await api._createSuggestedWaybill(72, 1, '6100063928', 'Regular', null)).waybillNumber, 'GL-041');
  assert.equal((await api._createSuggestedWaybill(73, 1, '6100063929', 'Regular', null)).waybillNumber, 'GL-042');

  // The counter really moved, and the booklet width was migrated alongside it.
  const row = prefixById(db, 1);
  assert.equal(row.last_sequence_number, 42);
  assert.equal(row.sequence_width, 3);

  // Every number is distinct — that is what the bug broke.
  const numbers = dump(db, 'waybills').map((w) => w.waybill_number);
  assert.deepEqual(numbers, ['GL-040', 'GL-041', 'GL-042']);
  assert.equal(new Set(numbers).size, 3);
});

test('a stalled counter cannot re-issue a number the ledger already shows', async () => {
  // Simulates the damaged production state: waybills out at 040 while the
  // prefix counter still reads 039. The ledger, not the counter, is the floor.
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);
  sheets.Waybills = [HEADERS.Waybills.slice(), waybillRow({
    ID: 1, 'Waybill Number': 'GL-040', 'Prefix ID': 1, 'Sequence Number': 40,
    'Trip ID': 70, 'FO Number': '6100063927', 'Waybill Type': 'Regular',
    Status: 'Suggested', Locked: false,
  })];
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  const r = await api._createSuggestedWaybill(72, 1, '6100063928', 'Regular', null);
  assert.equal(r.waybillNumber, 'GL-041');
});

test('re-basing a counter below what the booklet already issued is refused', async () => {
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);
  const { api, db } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  await api._createSuggestedWaybill(70, 1, '6100063927', 'Regular', null);   // issues GL-040

  // A stale admin panel still showing "039" must not rewind the booklet.
  const res = await api.updateWaybillPrefix(1, { lastSequenceNumber: '039' });
  assert.equal(res.success, false);
  assert.match(res.error, /already issued up to 40/);
  assert.equal(prefixById(db, 1).last_sequence_number, 40);

  // Setting it to the issued number, or beyond, is fine.
  assert.equal((await api.updateWaybillPrefix(1, { lastSequenceNumber: '040' })).success, true);
  assert.equal((await api.updateWaybillPrefix(1, { lastSequenceNumber: '099' })).success, true);
});
