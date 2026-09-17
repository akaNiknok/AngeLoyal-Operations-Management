// ============================================================
//  Waybill Prefix writers (DataWriters.gs).
//  Covers validation, dedup, the digit-width-preserving sequence
//  cell, and the EDIT_WAYBILL_PREFIXES gate (Admin + Dispatcher).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function base(rows = [[1, 'AY', 'AngeLoyal Logistics', '0357']]) {
  return {
    Users: usersSheet(),
    'Audit Log': emptySheet('Audit Log'),
    // Re-basing a counter is checked against the ledger, so the writers read it.
    Waybills: emptySheet('Waybills'),
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice()].concat(rows),
  };
}

function prefixRows(ss) {
  return dump(ss, 'Waybill Prefixes').rows.map((r) => rowObject(HEADERS['Waybill Prefixes'], r));
}

/** Waybills row builder from named fields; everything else blank. */
function waybillRow(fields) {
  return HEADERS.Waybills.map((h) => (fields[h] !== undefined ? fields[h] : ''));
}

test('a dispatcher can add a prefix and its zero-padded width survives', () => {
  const { api, ss } = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });

  const res = api.createWaybillPrefix({
    prefix: 'RB',
    companyName: 'Rebisco Hauling',
    lastSequenceNumber: '0000',
  });
  assert.equal(res.success, true);
  assert.equal(res.waybillPrefix.id, 2);
  assert.equal(res.waybillPrefix.sequenceWidth, 4);

  // The counter is a plain number and the booklet width has its own column —
  // nothing depends on how the cell happens to be formatted.
  const stored = prefixRows(ss).find((r) => r.ID === 2);
  assert.equal(stored['Last Sequence Number'], 0);
  assert.equal(stored['Sequence Width'], 4);

  const read = api.getWaybillPrefixes().find((p) => p.id === 2);
  assert.equal(read.prefix, 'RB');
  assert.equal(read.companyName, 'Rebisco Hauling');
  assert.equal(read.lastSequenceNumber, 0);
  assert.equal(read.sequenceWidth, 4);

  const audit = dump(ss, 'Audit Log');
  const actionIdx = audit.headers.indexOf('Action');
  assert.equal(audit.rows.filter((r) => r[actionIdx] === 'WAYBILL_PREFIX_CREATE').length, 1);
});

test('createWaybillPrefix rejects a duplicate prefix and a non-numeric sequence', () => {
  const { api } = makeEnv({ sheets: base(), userEmail: EMAIL.Admin });

  const dup = api.createWaybillPrefix({ prefix: 'ay', companyName: 'X', lastSequenceNumber: '1' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const bad = api.createWaybillPrefix({ prefix: 'ZZ', companyName: 'X', lastSequenceNumber: '12a' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /digits only/);

  const noName = api.createWaybillPrefix({ prefix: 'ZZ', companyName: '', lastSequenceNumber: '1' });
  assert.equal(noName.success, false);
  assert.match(noName.error, /Company name is required/);
});

test('re-basing Last Sequence Number rewrites width and leaves the other columns intact', () => {
  const { api, ss } = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });

  const res = api.updateWaybillPrefix(1, { lastSequenceNumber: '010760' });
  assert.equal(res.success, true);
  assert.equal(res.waybillPrefix.lastSequenceNumber, 10760);
  assert.equal(res.waybillPrefix.sequenceWidth, 6);

  const row = prefixRows(ss).find((r) => r.ID === 1);
  assert.equal(row['Last Sequence Number'], 10760);
  assert.equal(row['Sequence Width'], 6);   // width comes from the typed text's length
  assert.equal(row.Prefix, 'AY');
  assert.equal(row['Company Name'], 'AngeLoyal Logistics');

  // Re-basing narrower rewrites the width too.
  api.updateWaybillPrefix(1, { lastSequenceNumber: '412' });
  const narrowed = prefixRows(ss).find((r) => r.ID === 1);
  assert.equal(narrowed['Last Sequence Number'], 412);
  assert.equal(narrowed['Sequence Width'], 3);

  const audit = dump(ss, 'Audit Log');
  const actionIdx = audit.headers.indexOf('Action');
  assert.equal(audit.rows.filter((r) => r[actionIdx] === 'WAYBILL_PREFIX_EDIT').length, 2);
});

test('updateWaybillPrefix renames without touching the stored sequence', () => {
  const { api, ss } = makeEnv({ sheets: base(), userEmail: EMAIL.Admin });

  const res = api.updateWaybillPrefix(1, { prefix: '', companyName: 'AngeLoyal Logistics Inc.' });
  assert.equal(res.success, true);
  assert.equal(res.waybillPrefix.sequenceWidth, 4);

  const row = prefixRows(ss).find((r) => r.ID === 1);
  assert.equal(row.Prefix, '');
  assert.equal(row['Company Name'], 'AngeLoyal Logistics Inc.');
  assert.equal(row['Last Sequence Number'], '0357');   // untouched
});

test('waybill prefix writers are gated to Admin + Dispatcher', () => {
  [EMAIL.Payroll, EMAIL.Viewer, EMAIL.Unknown].forEach((email) => {
    const { api } = makeEnv({ sheets: base(), userEmail: email });
    assert.throws(() => api.updateWaybillPrefix(1, { companyName: 'X' }), /Access denied/);
    assert.throws(
      () => api.createWaybillPrefix({ prefix: 'Q', companyName: 'X', lastSequenceNumber: '1' }),
      /Access denied/
    );
  });
});

test('removing a prefix is a soft delete, and restoring it brings it back', () => {
  const { api, ss } = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });

  const removed = api.updateWaybillPrefix(1, { active: false });
  assert.equal(removed.success, true);
  assert.equal(removed.waybillPrefix.active, false);
  assert.equal(prefixRows(ss).find((r) => r.ID === 1).Active, false);
  // Soft delete: the row (and its sequence) survives for waybills already issued.
  assert.equal(api.getWaybillPrefixes().find((p) => p.id === 1).lastSequenceNumber, 357);

  const restored = api.updateWaybillPrefix(1, { active: true });
  assert.equal(restored.waybillPrefix.active, true);
  assert.equal(api.getWaybillPrefixes().find((p) => p.id === 1).active, true);
});

test('a sheet without an Active column self-migrates, and its rows stay active', () => {
  const legacy = base();
  legacy['Waybill Prefixes'] = [
    ['ID', 'Prefix', 'Company Name', 'Last Sequence Number'],
    [1, 'AY', 'AngeLoyal Logistics', '0357'],
    [2, 'RB', 'Rebisco Hauling', '0000'],
  ];
  const { api, ss } = makeEnv({ sheets: legacy, userEmail: EMAIL.Admin });

  assert.equal(api.getWaybillPrefixes().every((p) => p.active), true);

  api.updateWaybillPrefix(2, { active: false });
  assert.equal(dump(ss, 'Waybill Prefixes').headers.includes('Active'), true);

  const after = api.getWaybillPrefixes();
  assert.equal(after.find((p) => p.id === 1).active, true);  // untouched row stays active
  assert.equal(after.find((p) => p.id === 2).active, false);
});

test('re-adding a removed prefix points at Restore', () => {
  const { api } = makeEnv({ sheets: base(), userEmail: EMAIL.Admin });

  api.updateWaybillPrefix(1, { active: false });

  const res = api.createWaybillPrefix({
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

test('a zero-padded booklet advances instead of re-issuing the same number', () => {
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);   // legacy padded text
  sheets.Trips = [HEADERS.Trips.slice()];
  const { api, ss } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  assert.equal(api._createSuggestedWaybill(70, 1, '6100063927', 'Regular', null).waybillNumber, 'GL-040');
  assert.equal(api._createSuggestedWaybill(72, 1, '6100063928', 'Regular', null).waybillNumber, 'GL-041');
  assert.equal(api._createSuggestedWaybill(73, 1, '6100063929', 'Regular', null).waybillNumber, 'GL-042');

  // The counter really moved, and the booklet width was migrated alongside it.
  const row = prefixRows(ss).find((r) => r.ID === 1);
  assert.equal(row['Last Sequence Number'], 42);
  assert.equal(row['Sequence Width'], 3);

  // Every number is distinct — that is what the bug broke.
  const numbers = dump(ss, 'Waybills').rows.map((r) => rowObject(HEADERS.Waybills, r)['Waybill Number']);
  assert.deepEqual(numbers, ['GL-040', 'GL-041', 'GL-042']);
  assert.equal(new Set(numbers).size, 3);
});

test('a stalled counter cannot re-issue a number the ledger already shows', () => {
  // Simulates the damaged production state: waybills out at 040 while the
  // prefix counter still reads 039. The ledger, not the counter, is the floor.
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);
  sheets.Waybills = [HEADERS.Waybills.slice(), waybillRow({
    ID: 1, 'Waybill Number': 'GL-040', 'Prefix ID': 1, 'Sequence Number': 40,
    'Trip ID': 70, 'FO Number': '6100063927', 'Waybill Type': 'Regular',
    Status: 'Suggested', Locked: false,
  })];
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  assert.equal(api._createSuggestedWaybill(72, 1, '6100063928', 'Regular', null).waybillNumber, 'GL-041');
});

test('re-basing a counter below what the booklet already issued is refused', () => {
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);
  const { api, ss } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  api._createSuggestedWaybill(70, 1, '6100063927', 'Regular', null);   // issues GL-040

  // A stale admin panel still showing "039" must not rewind the booklet.
  const res = api.updateWaybillPrefix(1, { lastSequenceNumber: '039' });
  assert.equal(res.success, false);
  assert.match(res.error, /already issued up to 40/);
  assert.equal(prefixRows(ss).find((r) => r.ID === 1)['Last Sequence Number'], 40);

  // Setting it to the issued number, or beyond, is fine.
  assert.equal(api.updateWaybillPrefix(1, { lastSequenceNumber: '040' }).success, true);
  assert.equal(api.updateWaybillPrefix(1, { lastSequenceNumber: '099' }).success, true);
});

test('a sheet without a Sequence Width column self-migrates on the next issue', () => {
  const legacy = base();
  legacy['Waybill Prefixes'] = [
    ['ID', 'Prefix', 'Company Name', 'Last Sequence Number', 'Active'],
    [1, 'AY', 'Triple A-Yan', '0358', true],
  ];
  const { api, ss } = makeEnv({ sheets: legacy, userEmail: EMAIL.Dispatcher });

  // Width is still inferred from the stored text until the column exists.
  assert.equal(api.getWaybillPrefixes()[0].sequenceWidth, 4);
  assert.equal(api._createSuggestedWaybill(64, 1, '6100063921', 'Regular', null).waybillNumber, 'AY-0359');

  assert.equal(dump(ss, 'Waybill Prefixes').headers.includes('Sequence Width'), true);
  const row = prefixRows(ss).find((r) => r.ID === 1);
  assert.equal(row['Last Sequence Number'], 359);
  assert.equal(row['Sequence Width'], 4);
  assert.equal(row.Active, true);   // migration doesn't disturb the other columns

  // Still prints at the booklet width now that the width is explicit.
  assert.equal(api._createSuggestedWaybill(68, 1, '6100063924', 'Regular', null).waybillNumber, 'AY-0360');
});

test('minting a waybill number gives up rather than duplicating when the lock is held', () => {
  const sheets = base([[1, 'GL', 'GL Trucking', '039']]);
  const { api, ss } = makeEnv({
    sheets, userEmail: EMAIL.Dispatcher, lockUnavailable: true,
  });

  assert.throws(() => api._createSuggestedWaybill(70, 1, '6100063927', 'Regular', null), /busy with another change/);
  assert.equal(dump(ss, 'Waybills').rows.length, 0);   // nothing minted
  assert.equal(prefixRows(ss).find((r) => r.ID === 1)['Last Sequence Number'], '039');
});
