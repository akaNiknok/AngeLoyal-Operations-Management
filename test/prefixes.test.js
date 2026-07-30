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
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice()].concat(rows),
  };
}

function prefixRows(ss) {
  return dump(ss, 'Waybill Prefixes').rows.map((r) => rowObject(HEADERS['Waybill Prefixes'], r));
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

  const stored = prefixRows(ss).find((r) => r.ID === 2);
  assert.equal(stored['Last Sequence Number'], '0000'); // text, not the number 0

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
  assert.equal(row['Last Sequence Number'], '010760');
  assert.equal(row.Prefix, 'AY');
  assert.equal(row['Company Name'], 'AngeLoyal Logistics');

  // A sequence with no leading zero lands as a plain number.
  api.updateWaybillPrefix(1, { lastSequenceNumber: '412' });
  assert.equal(prefixRows(ss).find((r) => r.ID === 1)['Last Sequence Number'], 412);

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
  assert.equal(row['Last Sequence Number'], '0357');
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
