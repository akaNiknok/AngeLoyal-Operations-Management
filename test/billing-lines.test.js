// ============================================================
//  The billing ledger — which waybills become lines, how a load
//  is priced, and what survives a refresh. This is the money
//  path, so the split-load rule, the Mano steps, the drop fee
//  and the date lock each get pinned down on their own.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

const DAY = '7/2/2026';

/** A trip row in Trips column order. Only the billing-relevant bits vary. */
function trip(o) {
  const t = Object.assign(
    {
      id: 1, tripDate: DAY, billingDate: DAY, fo: 'FO-1', outletId: 1,
      area: 'Calamba', qty: 50, truckId: 3, cat: '4W',
      status: 'Delivered', origin: 'TANZA',
    },
    o
  );
  return [
    t.id, t.tripDate, t.billingDate, t.fo, '', t.outletId, t.area, t.qty, 1,
    '', t.truckId, 9, '', t.cat, t.status, '', 'Import', 1, '', '', '',
    EMAIL.Dispatcher, '7/2/2026 08:00:00', '', '', t.origin,
  ];
}

/** A confirmed waybill row pointing at one trip. */
function waybill(id, number, tripId, locked = true) {
  return [
    id, number, 1, 11800 + id, tripId, 'FO-1', 'Regular', '',
    locked ? 'Confirmed' : 'Suggested', locked, EMAIL.Dispatcher,
    locked ? '7/2/2026 18:00:00' : '',
  ];
}

// Trip Area is no longer a column on the trip itself — the D1 schema joins
// it from Outlets — so each distinct area used by a test gets its own
// outlet row, and every trip's Outlet ID is rewritten to match.
function sheets(trips, waybills) {
  const outletIdForArea = {};
  let nextOutletId = 1;
  trips.forEach((row) => {
    const area = row[6];
    if (!(area in outletIdForArea)) outletIdForArea[area] = nextOutletId++;
    row[5] = outletIdForArea[area];
  });
  const outlets = [HEADERS.Outlets.slice()].concat(
    Object.keys(outletIdForArea).map((area) => [
      outletIdForArea[area], `Outlet ${area}`, area, '', '', '', '1/1/2020',
    ])
  );

  return {
    Users: usersSheet(),
    'Audit Log': emptySheet('Audit Log'),
    Trucks: [
      HEADERS.Trucks.slice(),
      [3, 'NLC9957', 'Isuzu', '4W', true, '4W'],
      [4, 'NLG3302', 'Isuzu', '6W', true, '6W'],
    ],
    Outlets: outlets,
    Trips: [HEADERS.Trips.slice()].concat(trips),
    Waybills: [HEADERS.Waybills.slice()].concat(waybills),
  };
}

function asPayroll(s) {
  return makeEnv({ sheets: s, userEmail: EMAIL.Payroll });
}

/** Seeds the rate matrix and one diesel price, then returns the env. */
async function seeded(s, rates = null) {
  const admin = makeEnv({ sheets: s, userEmail: EMAIL.Admin });
  await admin.api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  await admin.api.importFreightRates(
    'TANZA',
    '7/1/2026',
    rates || [
      { area: 'Calamba', truckType: '4W', bands: { '65.01-70': 17670 } },
      { area: 'Cabuyao', truckType: '4W', bands: { '65.01-70': 17290 } },
      { area: 'Lipa', truckType: '6W', bands: { '65.01-70': 21330 } },
    ]
  );
  return admin;
}

// ── Which waybills become lines ───────────────────────────────

test('a delivered load with a confirmed waybill becomes one line', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);

  const res = await api.getBillingLines(DAY, DAY);
  assert.equal(res.success, true);
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].waybillNumber, 'AY-11801');
  assert.equal(res.lines[0].plateNumber, 'NLC9957');
  assert.equal(res.lines[0].status, 'Not Billed');
});

test('a suggested waybill is not billable, and neither is an undelivered trip', async () => {
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, fo: 'FO-2', status: 'Scheduled' })],
    [waybill(1, 'AY-11801', 1, false), waybill(2, 'AY-11802', 2)]
  );
  const { api } = await seeded(s);

  assert.equal((await api.getBillingLines(DAY, DAY)).lines.length, 0);
});

test('one unfinished stop holds back the whole load', async () => {
  // Both stops share a waybill; the second is still out.
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, area: 'Cabuyao', status: 'Undelivered' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = await seeded(s);

  assert.equal((await api.getBillingLines(DAY, DAY)).lines.length, 0);
});

// ── The split-load rule ───────────────────────────────────────

test('a multi-area load bills at the highest rate and prints that area', async () => {
  // The sample billing does exactly this: FO 6100055846 drops in Cabuyao
  // (17290) and Calamba (17670) and bills as Calamba.
  const s = sheets(
    [trip({ id: 1, area: 'Cabuyao', qty: 30 }), trip({ id: 2, area: 'Calamba', qty: 20 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = await seeded(s);

  const line = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.equal(line.area, 'Calamba');
  assert.equal(line.haulingRate, 17670);
  assert.equal(line.drops, 2);
  assert.equal(line.cartons, 50);
});

test('the highest rate wins even when the cheaper drop is the bigger one', async () => {
  const s = sheets(
    [trip({ id: 1, area: 'Cabuyao', qty: 300 }), trip({ id: 2, area: 'Calamba', qty: 5 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = await seeded(s);

  assert.equal((await api.getBillingLines(DAY, DAY)).lines[0].haulingRate, 17670);
});

// ── Mano ──────────────────────────────────────────────────────

test('Mano steps once every full 100 cartons at one store', async () => {
  const cases = [
    [99, 0],
    [100, 392],
    [199, 392],
    [200, 784],
    [201, 784],
    [350, 1176],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [qty, expected] = cases[i];
    const s = sheets([trip({ id: 1, qty })], [waybill(1, 'AY-1180' + i, 1)]);
    const { api } = await seeded(s);
    assert.equal((await api.getBillingLines(DAY, DAY)).lines[0].mano, expected, `qty ${qty}`);
  }
});

test('Mano counts each store separately, it does not add the cartons up first', async () => {
  // 60 + 60 = 120 cartons, but neither store passed 100 — no Mano.
  const s = sheets(
    [trip({ id: 1, qty: 60 }), trip({ id: 2, area: 'Cabuyao', qty: 60 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = await seeded(s);

  const line = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.equal(line.cartons, 120);
  assert.equal(line.mano, 0);
});

// ── The drop fee ──────────────────────────────────────────────

test('the drop fee is flat from three drops up', async () => {
  const cases = [[1, 0], [2, 0], [3, 560], [4, 560], [7, 560]];
  for (let caseIdx = 0; caseIdx < cases.length; caseIdx++) {
    const [drops, expected] = cases[caseIdx];
    const trips = [];
    const wbs = [];
    for (let i = 1; i <= drops; i++) {
      trips.push(trip({ id: i, qty: 10 }));
      wbs.push(waybill(i, 'AY-118' + caseIdx, i));
    }
    const { api } = await seeded(sheets(trips, wbs));
    assert.equal(
      (await api.getBillingLines(DAY, DAY)).lines[0].dropFee,
      expected,
      `${drops} drops`
    );
  }
});

// ── Totals ────────────────────────────────────────────────────

test('the line total is the rate plus every fee, and the footer backs the VAT out', async () => {
  const s = sheets(
    [trip({ id: 1, qty: 150 }), trip({ id: 2, area: 'Cabuyao', qty: 10 }), trip({ id: 3, area: 'Cabuyao', qty: 10 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2), waybill(3, 'AY-11801', 3)]
  );
  const { api } = await seeded(s);

  const res = await api.getBillingLines(DAY, DAY);
  const line = res.lines[0];
  assert.equal(line.haulingRate, 17670);
  assert.equal(line.mano, 392);
  assert.equal(line.dropFee, 560);
  assert.equal(line.total, 17670 + 392 + 560);

  // Same arithmetic as the sample workbook's footer block.
  const t = res.totals;
  assert.equal(t.totalVatInc, line.total);
  assert.ok(Math.abs(t.netOfVat + t.lessVat - t.totalVatInc) < 1e-9);
  assert.ok(Math.abs(t.withholding - t.netOfVat * 0.02) < 1e-9);
  assert.ok(Math.abs(t.amountDue - (t.totalVatInc - t.withholding)) < 1e-9);
});

test('the footer reproduces the sample billing to the centavo', async () => {
  const { api } = makeEnv({ sheets: sheets([], []), userEmail: EMAIL.Payroll });
  // 02 Billing Output Sample.xlsx: 1,677,050 gross -> 1,647,102.68 due.
  const t = await api._billingTotals([{ total: 1677050 }]);
  assert.ok(Math.abs(t.lessVat - 179683.92857142855) < 1e-6);
  assert.ok(Math.abs(t.netOfVat - 1497366.0714285714) < 1e-6);
  assert.ok(Math.abs(t.withholding - 29947.321428571428) < 1e-6);
  assert.ok(Math.abs(t.amountDue - 1647102.6785714286) < 1e-6);
});

// ── The date lock ─────────────────────────────────────────────

test('a carry-over prices from its billing date, not the day it was delivered', async () => {
  // Ordered on 7/2 at 67.00 (band 65.01-70), delivered 7/20 after the
  // price moved to 72.00 (band 70.01-75).
  const s = sheets(
    [trip({ id: 1, tripDate: '7/20/2026', billingDate: '7/2/2026' })],
    [waybill(1, 'AY-11801', 1)]
  );
  const admin = await seeded(s);
  await admin.api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 72 });
  await admin.api.importFreightRates('TANZA', '7/15/2026', [
    { area: 'Calamba', truckType: '4W', bands: { '65.01-70': 19000, '70.01-75': 20000 } },
  ]);

  const line = (await admin.api.getBillingLines('7/20/2026', '7/20/2026')).lines[0];
  assert.equal(line.tripDate, '7/20/2026');   // the printed date is the delivery
  assert.equal(line.billingDate, '7/2/2026');
  assert.equal(line.dieselPrice, 67);          // the price is the original day's
  assert.equal(line.rateBand, '65.01-70');
  assert.equal(line.haulingRate, 17670);
});

// ── Unmatched rates ───────────────────────────────────────────

test('an area with no rate is flagged, not billed at zero in silence', async () => {
  const s = sheets([trip({ id: 1, area: 'Nowhere' })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);

  const line = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.equal(line.haulingRate, 0);
  assert.match(line.warning, /No rate for TANZA \/ Nowhere \/ 4W/);
});

test('a load with one unpriced drop bills on the drops it can price, and says so', async () => {
  const s = sheets(
    [trip({ id: 1, area: 'Calamba' }), trip({ id: 2, area: 'Nowhere' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = await seeded(s);

  const line = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.equal(line.haulingRate, 17670);
  assert.match(line.warning, /Priced without Nowhere/);
});

test('no diesel price on or before the billing date flags the line', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = makeEnv({ sheets: s, userEmail: EMAIL.Admin });
  await admin.api.importFreightRates('TANZA', '7/1/2026', [
    { area: 'Calamba', truckType: '4W', bands: { '65.01-70': 17670 } },
  ]);

  const line = (await admin.api.getBillingLines(DAY, DAY)).lines[0];
  assert.equal(line.haulingRate, 0);
  assert.match(line.warning, /No diesel price/);
});

// ── Idempotency and refresh ───────────────────────────────────

test('opening the same range twice creates no second line', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, db } = await seeded(s);

  await api.getBillingLines(DAY, DAY);
  await api.getBillingLines(DAY, DAY);

  assert.equal(dump(db, 'billing_lines').length, 1);
});

test('a second open of an unchanged range writes no row', async () => {
  // Every index entry counts against the daily row-write budget, so a panel
  // that recomputes to the same numbers must not write them back.
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, db } = await seeded(s);
  await api.getBillingLines(DAY, DAY);

  const sqls = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { sqls.push(sql); return prepare(sql); };
  await api.getBillingLines(DAY, DAY);

  assert.deepEqual(sqls.filter((q) => /^UPDATE billing_lines/.test(q)), []);
});

test('a refresh picks up a rate correction on a line nobody overrode', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = await seeded(s);
  assert.equal((await admin.api.getBillingLines(DAY, DAY)).lines[0].haulingRate, 17670);

  const rateId = (await admin.api.getFreightRates('TANZA')).find((r) => r.area === 'Calamba').id;
  await admin.api.updateFreightRate(rateId, '65.01-70', 18500);

  assert.equal((await admin.api.getBillingLines(DAY, DAY)).lines[0].haulingRate, 18500);
});

test('an overridden amount survives a refresh, and clearing it restores the computed one', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = await seeded(s);
  const id = (await admin.api.getBillingLines(DAY, DAY)).lines[0].id;

  assert.equal((await admin.api.saveBillingLine(id, { haulingRate: 20000 })).success, true);
  assert.equal((await admin.api.getBillingLines(DAY, DAY)).lines[0].haulingRate, 20000);

  assert.equal((await admin.api.saveBillingLine(id, { haulingRate: null })).success, true);
  assert.equal((await admin.api.getBillingLines(DAY, DAY)).lines[0].haulingRate, 17670);
});

test('a line already on a submitted billing is never recomputed', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = await seeded(s);
  const id = (await admin.api.getBillingLines(DAY, DAY)).lines[0].id;
  await admin.api.setBillingNumber([id], 'BILL-0001');

  const rateId = (await admin.api.getFreightRates('TANZA')).find((r) => r.area === 'Calamba').id;
  await admin.api.updateFreightRate(rateId, '65.01-70', 99999);

  const line = (await admin.api.getBillingLines(DAY, DAY)).lines[0];
  assert.equal(line.haulingRate, 17670);
  assert.equal(line.status, 'Billed');
  assert.equal(line.billingNumber, 'BILL-0001');
});

// ── Editing a line ────────────────────────────────────────────

test('manual charges add to the total and a zero drops the charge', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  let res = await api.saveBillingLine(id, { manualCharges: { 1: 250, 3: 75 } });
  assert.equal(res.success, true);
  assert.equal(res.line.total, 17670 + 325);

  res = await api.saveBillingLine(id, { manualCharges: { 1: 250, 3: 0 } });
  assert.equal(res.line.total, 17670 + 250);
  assert.deepEqual(Object.keys(res.line.manualCharges), ['1']);
});

// Tabbing along a row fires one save per cell, and each carries only its own
// charge. The second must not erase the first while the first is in flight.
test('a charge saved alone keeps the charges already on the line', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  await api.saveBillingLine(id, { manualCharges: { 1: 111 } });
  const res = await api.saveBillingLine(id, { manualCharges: { 2: 22 } });
  assert.deepEqual({ ...res.line.manualCharges }, { 1: 111, 2: 22 });
  assert.equal(res.line.total, 17670 + 133);
});

// The same, with both saves in flight at once: each read the line before the
// other wrote. Neither may write back its stale read.
test('two saves in flight on one line both land, and the total counts both', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  await Promise.all([
    api.saveBillingLine(id, { manualCharges: { 1: 111 } }),
    api.saveBillingLine(id, { manualCharges: { 2: 22 } }),
    api.saveBillingLine(id, { haulingRate: 20000 }),
    api.saveBillingLine(id, { mano: 50 }),
  ]);
  const line = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.deepEqual({ ...line.manualCharges }, { 1: 111, 2: 22 });
  assert.deepEqual([...line.overrides].sort(), ['haulingRate', 'mano']);
  assert.equal(line.haulingRate, 20000);
  assert.equal(line.mano, 50);
  assert.equal(line.total, 20000 + 50 + 133);

  // Clearing one override keeps the other.
  await Promise.all([
    api.saveBillingLine(id, { haulingRate: null }),
    api.saveBillingLine(id, { manualCharges: { 1: 0 } }),
  ]);
  const after = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.deepEqual([...after.overrides], ['mano']);
  assert.equal(after.haulingRate, 17670);
  assert.equal(after.total, 17670 + 50 + 22);
});

test('saveBillingLine refuses a negative override and a non-numeric charge', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  assert.match((await api.saveBillingLine(id, { mano: -1 })).error, /zero or more/);
  assert.match((await api.saveBillingLine(id, { manualCharges: { 1: 'x' } })).error, /must be a number/);
});

test('a submitted line cannot be edited until its billing number is cleared', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;
  await api.setBillingNumber([id], 'BILL-0001');

  assert.match((await api.saveBillingLine(id, { mano: 100 })).error, /already on a submitted billing/);

  await api.setBillingNumber([id], '');
  assert.equal((await api.saveBillingLine(id, { mano: 100 })).success, true);
});

// ── Deferring ─────────────────────────────────────────────────

test('a line can be deferred to a later billing and brought back', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  assert.equal((await api.setBillingLineStatus([id], 'Deferred')).updated, 1);
  assert.equal((await api.getBillingLines(DAY, DAY)).lines[0].status, 'Deferred');

  assert.equal((await api.setBillingLineStatus([id], 'Not Billed')).updated, 1);
  assert.equal((await api.getBillingLines(DAY, DAY)).lines[0].status, 'Not Billed');
});

test('deferring refuses an unknown status and a line already billed', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  assert.match((await api.setBillingLineStatus([id], 'Paid')).error, /Not Billed or Deferred/);
  await api.setBillingNumber([id], 'BILL-0001');
  assert.match((await api.setBillingLineStatus([id], 'Deferred')).error, /cannot be deferred/);
});

// ── Access ────────────────────────────────────────────────────

test('a Viewer cannot read or edit a billing', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  await seeded(s);
  const viewer = makeEnv({ sheets: s, userEmail: EMAIL.Viewer });

  await assert.rejects(() => viewer.api.getBillingLines(DAY, DAY), /Access denied/);
  await assert.rejects(() => viewer.api.saveBillingLine(1, { mano: 5 }), /Access denied/);
});

test('a Dispatcher cannot bill either — billing is Admin and Payroll work', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  await seeded(s);
  const dispatcher = makeEnv({ sheets: s, userEmail: EMAIL.Dispatcher });

  await assert.rejects(() => dispatcher.api.getBillingLines(DAY, DAY), /Access denied/);
});

// ── Audit ─────────────────────────────────────────────────────

test('creating, editing, deferring and stamping a line each leave an audit row', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, db } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;
  await api.saveBillingLine(id, { notes: 'checked against POD' });
  await api.setBillingLineStatus([id], 'Deferred');
  await api.setBillingLineStatus([id], 'Not Billed');
  await api.setBillingNumber([id], 'BILL-0001');

  const actions = dump(db, 'audit_log').map((r) => r.action);

  ['BILLING_LINE_CREATE', 'BILLING_LINE_EDIT', 'BILLING_LINE_STATUS_CHANGE',
   'BILLING_NUMBER_SET'].forEach((a) => assert.ok(actions.includes(a), a));
});

test('stamping a billing number audits each line with the number it had', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, db } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;
  await api.setBillingNumber([id], 'BILL-0001');
  await api.setBillingNumber([id], 'BILL-0002');

  const rows = dump(db, 'audit_log').filter((r) => r.action === 'BILLING_NUMBER_SET');
  assert.deepEqual(rows.map((r) => [r.row_id, r.old_value, r.new_value]),
    [[id, '', 'BILL-0001'], [id, 'BILL-0001', 'BILL-0002']]);
});

// ── Submitted billings ────────────────────────────────────────

test('stamping records the billing with its header, and a reprint reads it back as stored', async () => {
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, fo: 'FO-2', area: 'Cabuyao' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11802', 2)]
  );
  const { api } = await seeded(s);
  const ids = (await api.getBillingLines(DAY, DAY)).lines.map((l) => l.id);

  const res = await api.setBillingNumber(ids, 'B-0042', { docDate: '7/8/2026', from: '6/29/2026', to: '7/4/2026' });
  assert.equal(res.success, true);

  const list = (await api.getBillings()).billings;
  assert.equal(list.length, 1);
  assert.deepEqual(
    [list[0].billingNumber, list[0].docDate, list[0].from, list[0].to, list[0].lineCount, list[0].total],
    ['B-0042', '7/8/2026', '6/29/2026', '7/4/2026', 2, 17670 + 17290]);

  const one = await api.getBilling(list[0].id);
  assert.equal(one.success, true);
  assert.deepEqual(one.lines.map((l) => l.waybillNumber).sort(), ['AY-11801', 'AY-11802']);
  assert.ok(one.lines.every((l) => l.billingNumber === 'B-0042' && l.status === 'Billed'));
});

test('a reprint does not depend on the trips still being billable', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, raw } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;
  await api.setBillingNumber([id], 'B-1');
  raw.exec(`UPDATE trips SET trip_status = 'Undelivered'`);

  const billingId = (await api.getBillings()).billings[0].id;
  assert.equal((await api.getBilling(billingId)).lines.length, 1);
});

test('without a header the billing spans its lines, and a second stamp on the number widens it', async () => {
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, fo: 'FO-2', tripDate: '7/3/2026', billingDate: '7/3/2026' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11802', 2)]
  );
  const { api } = await seeded(s);
  const lines = (await api.getBillingLines(DAY, '7/3/2026')).lines;
  const byWb = Object.fromEntries(lines.map((l) => [l.waybillNumber, l.id]));

  await api.setBillingNumber([byWb['AY-11801']], 'B-1');
  let b = (await api.getBillings()).billings[0];
  assert.deepEqual([b.from, b.to, b.docDate], ['7/2/2026', '7/2/2026', '']);

  await api.setBillingNumber([byWb['AY-11802']], 'b-1', { docDate: '7/9/2026' });   // same billing, any case
  const all = (await api.getBillings()).billings;
  assert.equal(all.length, 1);
  b = all[0];
  assert.deepEqual([b.from, b.to, b.docDate, b.lineCount], ['7/2/2026', '7/3/2026', '7/9/2026', 2]);
});

test('a billing disappears when its last line is cleared or moved to another number', async () => {
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, fo: 'FO-2' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11802', 2)]
  );
  const { api, db } = await seeded(s);
  const [a, b] = (await api.getBillingLines(DAY, DAY)).lines.map((l) => l.id);

  await api.setBillingNumber([a, b], 'B-1');
  await api.setBillingNumber([a], 'B-2');
  assert.deepEqual(dump(db, 'billings').map((r) => r.billing_number).sort(), ['B-1', 'B-2']);

  await api.setBillingNumber([b], 'B-2');
  assert.deepEqual(dump(db, 'billings').map((r) => r.billing_number), ['B-2']);

  await api.setBillingNumber([a, b], '');
  assert.deepEqual(dump(db, 'billings'), []);
  assert.ok((await api.getBillingLines(DAY, DAY)).lines.every((l) => l.status === 'Not Billed' && !l.billingNumber));
});

test('stamping audits the billing once, with the header it was given', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, db } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;
  await api.setBillingNumber([id], 'B-1', { docDate: '7/8/2026' });

  const rows = dump(db, 'audit_log').filter((r) => r.action === 'BILLING_STAMP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table_name, 'billings');
  assert.deepEqual(JSON.parse(rows[0].new_value), { billingNumber: 'B-1', header: { docDate: '7/8/2026' }, lines: 1 });
});

test('a Viewer cannot list or reprint billings', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = await seeded(s);
  const id = (await admin.api.getBillingLines(DAY, DAY)).lines[0].id;
  await admin.api.setBillingNumber([id], 'B-1');

  const viewer = makeEnv({ sheets: s, userEmail: EMAIL.Viewer });
  await assert.rejects(() => viewer.api.getBillings());
  await assert.rejects(() => viewer.api.getBilling(1));
});

// ── How a line was built ──────────────────────────────────────

test('each line carries its stops and the computed amounts, even when typed over', async () => {
  const s = sheets(
    [trip({ id: 1, area: 'Cabuyao', qty: 250 }), trip({ id: 2, area: 'Calamba', qty: 20 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;
  await api.saveBillingLine(id, { haulingRate: 20000 });

  const line = (await api.getBillingLines(DAY, DAY)).lines[0];
  assert.deepEqual(line.stops.map((st) => [st.outlet, st.area, st.quantity, st.rate, st.mano]), [
    ['Outlet Cabuyao', 'Cabuyao', 250, 17290, 784],
    ['Outlet Calamba', 'Calamba', 20, 17670, 0],
  ]);
  assert.equal(line.haulingRate, 20000);
  assert.deepEqual({ ...line.computed }, { haulingRate: 17670, mano: 784, dropFee: 0, area: 'Calamba' });
});

test('a stop with no rate shows a blank rate, not zero', async () => {
  const s = sheets([trip({ id: 1, area: 'Nowhere' })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  assert.equal((await api.getBillingLines(DAY, DAY)).lines[0].stops[0].rate, null);
});

// ── Rate storage: one row per line (0008) ─────────────────────

const fs = require('node:fs');
const path = require('node:path');
const MIGRATION_0008 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0008_freight_rate_lines.sql'), 'utf8');

/** freight_rates before 0008: one row per band. */
const LONG_TABLE = `CREATE TABLE freight_rates (
  id INTEGER PRIMARY KEY, origin TEXT NOT NULL, area TEXT NOT NULL, area_key TEXT NOT NULL,
  truck_type TEXT NOT NULL, effective_date TEXT NOT NULL,
  band INTEGER NOT NULL CHECK (band BETWEEN 1 AND 25), rate REAL NOT NULL,
  UNIQUE (origin, area, truck_type, effective_date, band))`;

/** The grid getFreightRates built from the long table before 0008. */
function longGrid(api, raw) {
  const groups = [];
  const byKey = {};
  raw.prepare('SELECT * FROM freight_rates ORDER BY id').all().forEach((r) => {
    const key = `${r.origin}|${r.area}|${r.truck_type}|${r.effective_date}`;
    let g = byKey[key];
    if (!g) {
      const bands = {};
      for (let i = 1; i <= 25; i++) bands[api._fuelBandLabel(i)] = null;
      g = byKey[key] = {
        id: r.id, origin: r.origin, area: r.area, truckType: r.truck_type,
        effectiveDate: api.toClientDate(r.effective_date), bands,
      };
      groups.push(g);
    }
    if (r.id < g.id) g.id = r.id;
    g.bands[api._fuelBandLabel(r.band)] = r.rate;
  });
  return groups;
}

const priceOf = (l) => ({
  waybillNumber: l.waybillNumber, area: l.area, drops: l.drops, cartons: l.cartons,
  haulingRate: l.haulingRate, mano: l.mano, dropFee: l.dropFee, warning: l.warning,
  dieselPrice: l.dieselPrice, rateBand: l.rateBand,
});

test('0008 keeps every rate: a range prices the same before and after the migration', async () => {
  const s = sheets(
    [
      trip({ id: 1 }),                                                   // one stop
      trip({ id: 2, fo: 'FO-2', qty: 120 }),                             // split load: highest rate wins
      trip({ id: 3, fo: 'FO-2', area: 'Cabuyao', qty: 130 }),
      trip({ id: 4, fo: 'FO-3', area: 'San Juan' }),                     // 3 drops; two raw areas, one _normArea key
      trip({ id: 5, fo: 'FO-3', area: 'SAN JUAN.' }),
      trip({ id: 6, fo: 'FO-3', area: 'Cabuyao' }),
      trip({ id: 7, fo: 'FO-4', tripDate: '7/16/2026', billingDate: '7/10/2026' }),   // carry-over: early block
      trip({ id: 8, fo: 'FO-5', tripDate: '7/16/2026', billingDate: '7/16/2026' }),   // late block, band 9
      trip({ id: 9, fo: 'FO-6', area: 'Lipa', truckId: 4, cat: '6W' }),               // blank band
    ],
    [
      waybill(1, 'AY-1', 1), waybill(2, 'AY-2', 2), waybill(3, 'AY-2', 3),
      waybill(4, 'AY-3', 4), waybill(5, 'AY-3', 5), waybill(6, 'AY-3', 6),
      waybill(7, 'AY-4', 7), waybill(8, 'AY-5', 8), waybill(9, 'AY-6', 9),
    ]
  );
  const { api, raw } = makeEnv({ sheets: s, userEmail: EMAIL.Admin });
  await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });    // band 8
  await api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 72 });   // band 9

  raw.exec('DROP TABLE freight_rates');
  raw.exec(LONG_TABLE);
  const ins = raw.prepare(`INSERT INTO freight_rates (origin, area, area_key, truck_type, effective_date, band, rate)
                           VALUES ('TANZA', ?, ?, ?, ?, ?, ?)`);
  // Band 9 first, so a line's band ids are not one run.
  [
    ['Calamba', '4W', '2026-07-01', 9, 18100], ['Cabuyao', '4W', '2026-07-01', 9, 17500],
    ['Lipa', '6W', '2026-07-01', 9, 21330], ['Calamba', '4W', '2026-07-15', 9, 19500],
    ['Calamba', '4W', '2026-07-01', 8, 17670], ['Cabuyao', '4W', '2026-07-01', 8, 17290],
    ['San Juan', '4W', '2026-07-01', 8, 6760], ['SAN JUAN.', '4W', '2026-07-01', 8, 16500],
    ['Calamba', '4W', '2026-07-15', 8, 19000],
  ].forEach(([area, type, eff, band, rate]) => ins.run(area, api._normArea(area), type, eff, band, rate));

  const gridBefore = longGrid(api, raw);
  const prices = await api.getFuelPrices();
  const trucksById = {};
  (await api.getTrucks()).forEach((t) => { trucksById[t.id] = t; });
  const before = (await api._billableWaybillGroups('7/1/2026', '7/31/2026'))
    .map((g) => priceOf(api._priceWaybillGroup(g, gridBefore, prices, trucksById, {})))
    .sort((a, b) => a.waybillNumber.localeCompare(b.waybillNumber));

  raw.exec(MIGRATION_0008);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM freight_rates').get().n, 6);
  assert.deepEqual(await api.getFreightRates(), gridBefore);
  const res = await api.getBillingLines('7/1/2026', '7/31/2026');
  assert.equal(res.success, true);
  const after = res.lines.map(priceOf);
  assert.deepEqual(after, before);

  // Not vacuous: each rule priced something.
  const by = Object.fromEntries(after.map((l) => [l.waybillNumber, l]));
  assert.equal(by['AY-2'].haulingRate, 17670);
  assert.equal(by['AY-3'].dropFee > 0, true);
  assert.equal(by['AY-4'].haulingRate, 17670);
  assert.equal(by['AY-5'].haulingRate, 19500);
  assert.match(by['AY-6'].warning, /No rate/);
});

// ── The re-price warning on import ────────────────────────────

const RATES_V2 = [{ area: 'Calamba', truckType: '4W', bands: { '65.01-70': 18000 } }];

test('replacing a block that prices unbilled lines asks first and writes nothing', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, raw } = await seeded(s);
  await api.getBillingLines(DAY, DAY);
  const calamba = async () => (await api.getFreightRates('TANZA')).find((r) => r.area === 'Calamba');

  const res = await api.importFreightRates('TANZA', '7/1/2026', RATES_V2);
  assert.equal(res.success, false);
  assert.equal(res.needsConfirm, true);
  assert.equal(res.unbilled, 1);
  assert.equal((await calamba()).bands['65.01-70'], 17670);
  assert.equal(raw.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'FREIGHT_RATE_IMPORT'`).get().n, 1);

  const ok = await api.importFreightRates('TANZA', '7/1/2026', RATES_V2, true);
  assert.equal(ok.success, true);
  assert.equal(ok.replaced, 3);
  assert.equal((await api.getFreightRates('TANZA')).length, 1);
  assert.equal((await calamba()).bands['65.01-70'], 18000);
});

test('a new earlier block counts only the lines before the next block', async () => {
  const s = sheets(
    [trip({ id: 1, tripDate: '6/20/2026', billingDate: '6/20/2026' }), trip({ id: 2, fo: 'FO-2' })],
    [waybill(1, 'AY-1', 1), waybill(2, 'AY-2', 2)]
  );
  const { api } = await seeded(s);
  await api.addFuelPrice({ effectiveDate: '6/1/2026', dieselPrice: 67 });
  assert.equal((await api.getBillingLines('6/1/2026', '7/31/2026')).lines.length, 2);

  // The 7/2 line stays with the 7/1 block; only the 6/20 line re-prices.
  const res = await api.importFreightRates('TANZA', '6/1/2026', RATES_V2);
  assert.equal(res.needsConfirm, true);
  assert.equal(res.unbilled, 1);
});

test('a block that prices no unbilled line imports without asking', async () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = await seeded(s);
  const id = (await api.getBillingLines(DAY, DAY)).lines[0].id;

  assert.equal((await api.importFreightRates('LINGUNAN', '7/1/2026', RATES_V2)).success, true, 'another origin');
  assert.equal((await api.importFreightRates('TANZA', '8/1/2026', RATES_V2)).success, true, 'after every line');

  await api.setBillingNumber([id], 'BILL-0001');
  const res = await api.importFreightRates('TANZA', '7/1/2026', RATES_V2);
  assert.equal(res.success, true, 'a billed line never re-prices');
});

test('a repeated area and truck type in one sheet keeps the first row', async () => {
  const { api } = await seeded(sheets([], []));
  const res = await api.importFreightRates('LINGUNAN', '7/1/2026', [
    { area: 'STA. MARIA', truckType: '6W', bands: { '65.01-70': 6910 } },
    { area: 'STA. MARIA', truckType: '6W', bands: { '65.01-70': 28060 } },
    { area: 'Sta. Maria', truckType: '6W', bands: { '65.01-70': 7000 } },
  ]);
  assert.equal(res.success, true, res.error);
  assert.equal(res.imported, 2);
  assert.equal(res.duplicates, 1);
  const rows = (await api.getFreightRates('LINGUNAN')).filter((r) => r.effectiveDate === '7/1/2026');
  assert.deepEqual(rows.map((r) => [r.area, r.bands['65.01-70']]), [['STA. MARIA', 6910], ['Sta. Maria', 7000]]);
});
