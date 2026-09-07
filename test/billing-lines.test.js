// ============================================================
//  The billing ledger — which waybills become lines, how a load
//  is priced, and what survives a refresh. This is the money
//  path, so the split-load rule, the Mano steps, the drop fee
//  and the date lock each get pinned down on their own.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
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

function sheets(trips, waybills) {
  return {
    Users: usersSheet(),
    'Audit Log': emptySheet('Audit Log'),
    Trucks: [
      HEADERS.Trucks.slice(),
      [3, 'NLC9957', 'Isuzu', '4W', true, '4W'],
      [4, 'NLG3302', 'Isuzu', '6W', true, '6W'],
    ],
    Trips: [HEADERS.Trips.slice()].concat(trips),
    Waybills: [HEADERS.Waybills.slice()].concat(waybills),
  };
}

function asPayroll(s) {
  return makeEnv({ sheets: s, userEmail: EMAIL.Payroll });
}

/** Seeds the rate matrix and one diesel price, then returns the env. */
function seeded(s, rates = null) {
  const admin = makeEnv({ sheets: s, userEmail: EMAIL.Admin });
  admin.api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  admin.api.importFreightRates(
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

test('a delivered load with a confirmed waybill becomes one line', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);

  const res = api.getBillingLines(DAY, DAY);
  assert.equal(res.success, true);
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].waybillNumber, 'AY-11801');
  assert.equal(res.lines[0].plateNumber, 'NLC9957');
  assert.equal(res.lines[0].status, 'Not Billed');
});

test('a suggested waybill is not billable, and neither is an undelivered trip', () => {
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, fo: 'FO-2', status: 'Scheduled' })],
    [waybill(1, 'AY-11801', 1, false), waybill(2, 'AY-11802', 2)]
  );
  const { api } = seeded(s);

  assert.equal(api.getBillingLines(DAY, DAY).lines.length, 0);
});

test('one unfinished stop holds back the whole load', () => {
  // Both stops share a waybill; the second is still out.
  const s = sheets(
    [trip({ id: 1 }), trip({ id: 2, area: 'Cabuyao', status: 'Undelivered' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = seeded(s);

  assert.equal(api.getBillingLines(DAY, DAY).lines.length, 0);
});

// ── The split-load rule ───────────────────────────────────────

test('a multi-area load bills at the highest rate and prints that area', () => {
  // The sample billing does exactly this: FO 6100055846 drops in Cabuyao
  // (17290) and Calamba (17670) and bills as Calamba.
  const s = sheets(
    [trip({ id: 1, area: 'Cabuyao', qty: 30 }), trip({ id: 2, area: 'Calamba', qty: 20 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = seeded(s);

  const line = api.getBillingLines(DAY, DAY).lines[0];
  assert.equal(line.area, 'Calamba');
  assert.equal(line.haulingRate, 17670);
  assert.equal(line.drops, 2);
  assert.equal(line.cartons, 50);
});

test('the highest rate wins even when the cheaper drop is the bigger one', () => {
  const s = sheets(
    [trip({ id: 1, area: 'Cabuyao', qty: 300 }), trip({ id: 2, area: 'Calamba', qty: 5 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = seeded(s);

  assert.equal(api.getBillingLines(DAY, DAY).lines[0].haulingRate, 17670);
});

// ── Mano ──────────────────────────────────────────────────────

test('Mano steps once every full 100 cartons at one store', () => {
  const cases = [
    [99, 0],
    [100, 392],
    [199, 392],
    [200, 784],
    [201, 784],
    [350, 1176],
  ];
  cases.forEach(([qty, expected], i) => {
    const s = sheets([trip({ id: 1, qty })], [waybill(1, 'AY-1180' + i, 1)]);
    const { api } = seeded(s);
    assert.equal(api.getBillingLines(DAY, DAY).lines[0].mano, expected, `qty ${qty}`);
  });
});

test('Mano counts each store separately, it does not add the cartons up first', () => {
  // 60 + 60 = 120 cartons, but neither store passed 100 — no Mano.
  const s = sheets(
    [trip({ id: 1, qty: 60 }), trip({ id: 2, area: 'Cabuyao', qty: 60 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = seeded(s);

  const line = api.getBillingLines(DAY, DAY).lines[0];
  assert.equal(line.cartons, 120);
  assert.equal(line.mano, 0);
});

// ── The drop fee ──────────────────────────────────────────────

test('the drop fee is flat from three drops up', () => {
  const cases = [[1, 0], [2, 0], [3, 560], [4, 560], [7, 560]];
  cases.forEach(([drops, expected], caseIdx) => {
    const trips = [];
    const wbs = [];
    for (let i = 1; i <= drops; i++) {
      trips.push(trip({ id: i, qty: 10 }));
      wbs.push(waybill(i, 'AY-118' + caseIdx, i));
    }
    const { api } = seeded(sheets(trips, wbs));
    assert.equal(
      api.getBillingLines(DAY, DAY).lines[0].dropFee,
      expected,
      `${drops} drops`
    );
  });
});

// ── Totals ────────────────────────────────────────────────────

test('the line total is the rate plus every fee, and the footer backs the VAT out', () => {
  const s = sheets(
    [trip({ id: 1, qty: 150 }), trip({ id: 2, area: 'Cabuyao', qty: 10 }), trip({ id: 3, area: 'Cabuyao', qty: 10 })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2), waybill(3, 'AY-11801', 3)]
  );
  const { api } = seeded(s);

  const res = api.getBillingLines(DAY, DAY);
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

test('the footer reproduces the sample billing to the centavo', () => {
  const { api } = makeEnv({ sheets: sheets([], []), userEmail: EMAIL.Payroll });
  // 02 Billing Output Sample.xlsx: 1,677,050 gross -> 1,647,102.68 due.
  const t = api._billingTotals([{ total: 1677050 }]);
  assert.ok(Math.abs(t.lessVat - 179683.92857142855) < 1e-6);
  assert.ok(Math.abs(t.netOfVat - 1497366.0714285714) < 1e-6);
  assert.ok(Math.abs(t.withholding - 29947.321428571428) < 1e-6);
  assert.ok(Math.abs(t.amountDue - 1647102.6785714286) < 1e-6);
});

// ── The date lock ─────────────────────────────────────────────

test('a carry-over prices from its billing date, not the day it was delivered', () => {
  // Ordered on 7/2 at 67.00 (band 65.01-70), delivered 7/20 after the
  // price moved to 72.00 (band 70.01-75).
  const s = sheets(
    [trip({ id: 1, tripDate: '7/20/2026', billingDate: '7/2/2026' })],
    [waybill(1, 'AY-11801', 1)]
  );
  const admin = seeded(s);
  admin.api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 72 });
  admin.api.importFreightRates('TANZA', '7/15/2026', [
    { area: 'Calamba', truckType: '4W', bands: { '65.01-70': 19000, '70.01-75': 20000 } },
  ]);

  const line = admin.api.getBillingLines('7/20/2026', '7/20/2026').lines[0];
  assert.equal(line.tripDate, '7/20/2026');   // the printed date is the delivery
  assert.equal(line.billingDate, '7/2/2026');
  assert.equal(line.dieselPrice, 67);          // the price is the original day's
  assert.equal(line.rateBand, '65.01-70');
  assert.equal(line.haulingRate, 17670);
});

// ── Unmatched rates ───────────────────────────────────────────

test('an area with no rate is flagged, not billed at zero in silence', () => {
  const s = sheets([trip({ id: 1, area: 'Nowhere' })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);

  const line = api.getBillingLines(DAY, DAY).lines[0];
  assert.equal(line.haulingRate, 0);
  assert.match(line.warning, /No rate for TANZA \/ Nowhere \/ 4W/);
});

test('a load with one unpriced drop bills on the drops it can price, and says so', () => {
  const s = sheets(
    [trip({ id: 1, area: 'Calamba' }), trip({ id: 2, area: 'Nowhere' })],
    [waybill(1, 'AY-11801', 1), waybill(2, 'AY-11801', 2)]
  );
  const { api } = seeded(s);

  const line = api.getBillingLines(DAY, DAY).lines[0];
  assert.equal(line.haulingRate, 17670);
  assert.match(line.warning, /Priced without Nowhere/);
});

test('no diesel price on or before the billing date flags the line', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = makeEnv({ sheets: s, userEmail: EMAIL.Admin });
  admin.api.importFreightRates('TANZA', '7/1/2026', [
    { area: 'Calamba', truckType: '4W', bands: { '65.01-70': 17670 } },
  ]);

  const line = admin.api.getBillingLines(DAY, DAY).lines[0];
  assert.equal(line.haulingRate, 0);
  assert.match(line.warning, /No diesel price/);
});

// ── Idempotency and refresh ───────────────────────────────────

test('opening the same range twice creates no second line', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, ss } = seeded(s);

  api.getBillingLines(DAY, DAY);
  api.getBillingLines(DAY, DAY);

  assert.equal(dump(ss, 'Billing Lines').rows.length, 1);
});

test('a refresh picks up a rate correction on a line nobody overrode', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = seeded(s);
  assert.equal(admin.api.getBillingLines(DAY, DAY).lines[0].haulingRate, 17670);

  const rateId = admin.api.getFreightRates('TANZA').find((r) => r.area === 'Calamba').id;
  admin.api.updateFreightRate(rateId, '65.01-70', 18500);

  assert.equal(admin.api.getBillingLines(DAY, DAY).lines[0].haulingRate, 18500);
});

test('an overridden amount survives a refresh, and clearing it restores the computed one', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = seeded(s);
  const id = admin.api.getBillingLines(DAY, DAY).lines[0].id;

  assert.equal(admin.api.saveBillingLine(id, { haulingRate: 20000 }).success, true);
  assert.equal(admin.api.getBillingLines(DAY, DAY).lines[0].haulingRate, 20000);

  assert.equal(admin.api.saveBillingLine(id, { haulingRate: null }).success, true);
  assert.equal(admin.api.getBillingLines(DAY, DAY).lines[0].haulingRate, 17670);
});

test('a line already on a submitted billing is never recomputed', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const admin = seeded(s);
  const id = admin.api.getBillingLines(DAY, DAY).lines[0].id;
  admin.api.setBillingNumber([id], 'BILL-0001');

  const rateId = admin.api.getFreightRates('TANZA').find((r) => r.area === 'Calamba').id;
  admin.api.updateFreightRate(rateId, '65.01-70', 99999);

  const line = admin.api.getBillingLines(DAY, DAY).lines[0];
  assert.equal(line.haulingRate, 17670);
  assert.equal(line.status, 'Billed');
  assert.equal(line.billingNumber, 'BILL-0001');
});

// ── Editing a line ────────────────────────────────────────────

test('manual charges add to the total and a zero drops the charge', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);
  const id = api.getBillingLines(DAY, DAY).lines[0].id;

  let res = api.saveBillingLine(id, { manualCharges: { 1: 250, 3: 75 } });
  assert.equal(res.success, true);
  assert.equal(res.line.total, 17670 + 325);

  res = api.saveBillingLine(id, { manualCharges: { 1: 250, 3: 0 } });
  assert.equal(res.line.total, 17670 + 250);
  assert.deepEqual(Object.keys(res.line.manualCharges), ['1']);
});

test('saveBillingLine refuses a negative override and a non-numeric charge', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);
  const id = api.getBillingLines(DAY, DAY).lines[0].id;

  assert.match(api.saveBillingLine(id, { mano: -1 }).error, /zero or more/);
  assert.match(api.saveBillingLine(id, { manualCharges: { 1: 'x' } }).error, /must be a number/);
});

test('a submitted line cannot be edited until its billing number is cleared', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);
  const id = api.getBillingLines(DAY, DAY).lines[0].id;
  api.setBillingNumber([id], 'BILL-0001');

  assert.match(api.saveBillingLine(id, { mano: 100 }).error, /already on a submitted billing/);

  api.setBillingNumber([id], '');
  assert.equal(api.saveBillingLine(id, { mano: 100 }).success, true);
});

// ── Deferring ─────────────────────────────────────────────────

test('a line can be deferred to a later billing and brought back', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);
  const id = api.getBillingLines(DAY, DAY).lines[0].id;

  assert.equal(api.setBillingLineStatus([id], 'Deferred').updated, 1);
  assert.equal(api.getBillingLines(DAY, DAY).lines[0].status, 'Deferred');

  assert.equal(api.setBillingLineStatus([id], 'Not Billed').updated, 1);
  assert.equal(api.getBillingLines(DAY, DAY).lines[0].status, 'Not Billed');
});

test('deferring refuses an unknown status and a line already billed', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api } = seeded(s);
  const id = api.getBillingLines(DAY, DAY).lines[0].id;

  assert.match(api.setBillingLineStatus([id], 'Paid').error, /Not Billed or Deferred/);
  api.setBillingNumber([id], 'BILL-0001');
  assert.match(api.setBillingLineStatus([id], 'Deferred').error, /cannot be deferred/);
});

// ── Access ────────────────────────────────────────────────────

test('a Viewer cannot read or edit a billing', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  seeded(s);
  const viewer = makeEnv({ sheets: s, userEmail: EMAIL.Viewer });

  assert.throws(() => viewer.api.getBillingLines(DAY, DAY), /Access denied/);
  assert.throws(() => viewer.api.saveBillingLine(1, { mano: 5 }), /Access denied/);
});

test('a Dispatcher cannot bill either — billing is Admin and Payroll work', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  seeded(s);
  const dispatcher = makeEnv({ sheets: s, userEmail: EMAIL.Dispatcher });

  assert.throws(() => dispatcher.api.getBillingLines(DAY, DAY), /Access denied/);
});

// ── Audit ─────────────────────────────────────────────────────

test('creating, editing, deferring and stamping a line each leave an audit row', () => {
  const s = sheets([trip({ id: 1 })], [waybill(1, 'AY-11801', 1)]);
  const { api, ss } = seeded(s);
  const id = api.getBillingLines(DAY, DAY).lines[0].id;
  api.saveBillingLine(id, { notes: 'checked against POD' });
  api.setBillingLineStatus([id], 'Deferred');
  api.setBillingLineStatus([id], 'Not Billed');
  api.setBillingNumber([id], 'BILL-0001');

  const actions = dump(ss, 'Audit Log')
    .rows.map((r) => rowObject(HEADERS['Audit Log'], r).Action);

  ['BILLING_LINE_CREATE', 'BILLING_LINE_EDIT', 'BILLING_LINE_STATUS_CHANGE',
   'BILLING_NUMBER_SET'].forEach((a) => assert.ok(actions.includes(a), a));
});
