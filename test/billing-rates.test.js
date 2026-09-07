// ============================================================
//  Billing foundation — the DOE band index, the freight rate
//  matrix, the fuel price history and the manual money columns.
//  These are the inputs every billing line is priced from, so
//  the band boundaries and the effective-date lock are the
//  things worth pinning down.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function base(extra = {}) {
  return Object.assign(
    { Users: usersSheet(), 'Audit Log': emptySheet('Audit Log') },
    extra
  );
}

function asAdmin(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Admin });
}

/** One rate row for importFreightRates, priced flat across every band. */
function rateRow(area, truckType, bands) {
  return { area, truckType, bands };
}

// ── Band indexing ─────────────────────────────────────────────

test('the diesel band steps at the .01 boundary, not at the round peso', () => {
  const { api } = asAdmin(base());

  // Band 1 is 30.01-35, band 2 is 35.01-40. 35.00 is still band 1.
  assert.equal(api._fuelBandIndex(30.01), 1);
  assert.equal(api._fuelBandIndex(35.0), 1);
  assert.equal(api._fuelBandIndex(35.01), 2);
  assert.equal(api._fuelBandIndex(40.0), 2);

  // The sample billing week priced at 65.01-70, which is band 8.
  assert.equal(api._fuelBandIndex(67.0), 8);
  assert.equal(api._fuelBandLabel(8), '65.01-70');
});

test('a price outside the matrix clamps instead of falling off the end', () => {
  const { api } = asAdmin(base());

  assert.equal(api._fuelBandIndex(30.0), 1);
  assert.equal(api._fuelBandIndex(12), 1);
  assert.equal(api._fuelBandIndex(155.0), 25);
  assert.equal(api._fuelBandIndex(400), 25);
  assert.equal(api._fuelBandLabel(1), '30.01-35');
  assert.equal(api._fuelBandLabel(25), '150.01-155');
});

test('areas match across the casing and punctuation the source files disagree on', () => {
  const { api } = asAdmin(base());

  assert.equal(api._normArea('Las PiNas'), api._normArea('LAS PINAS'));
  assert.equal(api._normArea('Sta. Rosa'), api._normArea('STA ROSA'));
  assert.equal(api._normArea('San Fernando P'), api._normArea('san fernando p'));
  assert.notEqual(api._normArea('San Pedro'), api._normArea('San Pablo'));
});

// ── Freight rate import ───────────────────────────────────────

test('importFreightRates writes one row per area and truck type', () => {
  const { api, ss } = asAdmin(base());

  const res = api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('Calamba', '4W', { '65.01-70': 17670 }),
    rateRow('Cabuyao', '4W', { '65.01-70': 17290 }),
  ]);

  assert.equal(res.success, true);
  assert.equal(res.imported, 2);
  assert.equal(res.replaced, 0);

  const rates = api.getFreightRates('TANZA');
  assert.equal(rates.length, 2);
  const calamba = rates.find((r) => r.area === 'Calamba');
  assert.equal(calamba.bands['65.01-70'], 17670);
  assert.equal(calamba.effectiveDate, '7/1/2026');
  // Untouched bands come back as null, not 0 — an absent rate is not a free trip.
  assert.equal(calamba.bands['70.01-75'], null);

  const audit = dump(ss, 'Audit Log').rows.map((r) => rowObject(HEADERS['Audit Log'], r));
  assert.ok(audit.some((a) => a.Action === 'FREIGHT_RATE_IMPORT'));
});

test('re-importing the same origin and date replaces the block instead of stacking it', () => {
  const { api } = asAdmin(base());

  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  const res = api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('Calamba', '4W', { '65.01-70': 18000 }),
  ]);

  assert.equal(res.replaced, 1);
  const rates = api.getFreightRates('TANZA');
  assert.equal(rates.length, 1);
  assert.equal(rates[0].bands['65.01-70'], 18000);
});

test('a later effective date is a new block, and the earlier one survives', () => {
  const { api } = asAdmin(base());

  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  api.importFreightRates('TANZA', '8/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 19000 })]);

  assert.equal(api.getFreightRates('TANZA').length, 2);
});

test('getFreightRates filters by origin without minding the case', () => {
  const { api } = asAdmin(base());

  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  api.importFreightRates('LINGUNAN', '7/1/2026', [rateRow('Valenzuela', '6W', { '65.01-70': 7440 })]);

  assert.equal(api.getFreightRates('tanza').length, 1);
  assert.equal(api.getFreightRates().length, 2);
  assert.deepEqual(Array.from(api.getFreightRateOrigins()), ['LINGUNAN', 'TANZA']);
});

test('importFreightRates refuses a bad date, an empty block and a nameless area', () => {
  const { api } = asAdmin(base());

  assert.match(api.importFreightRates('TANZA', '', [rateRow('A', '4W', {})]).error, /Effective date/);
  assert.match(api.importFreightRates('TANZA', '2/30/2026', [rateRow('A', '4W', {})]).error, /Effective date/);
  assert.match(api.importFreightRates('', '7/1/2026', [rateRow('A', '4W', {})]).error, /Origin/);
  assert.match(api.importFreightRates('TANZA', '7/1/2026', []).error, /No rate rows/);
  assert.match(
    api.importFreightRates('TANZA', '7/1/2026', [rateRow('', '4W', {})]).error,
    /area and a truck type/
  );
});

test('importFreightRates is gated by EDIT_FREIGHT_RATES', () => {
  const sheets = base();
  const dispatcher = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  assert.throws(
    () => dispatcher.api.importFreightRates('TANZA', '7/1/2026', [rateRow('A', '4W', {})]),
    /Access denied/
  );
});

// ── Single rate edit ──────────────────────────────────────────

test('updateFreightRate changes one band and leaves the others alone', () => {
  const { api } = asAdmin(base());
  api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('Calamba', '4W', { '65.01-70': 17670, '70.01-75': 18100 }),
  ]);
  const id = api.getFreightRates('TANZA')[0].id;

  const res = api.updateFreightRate(id, '65.01-70', 17999);
  assert.equal(res.success, true);
  assert.equal(res.rate.value, 17999);

  const row = api.getFreightRates('TANZA')[0];
  assert.equal(row.bands['65.01-70'], 17999);
  assert.equal(row.bands['70.01-75'], 18100);
});

test('updateFreightRate rejects an unknown band and a negative rate', () => {
  const { api } = asAdmin(base());
  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  const id = api.getFreightRates('TANZA')[0].id;

  assert.match(api.updateFreightRate(id, '67.5', 100).error, /not a price band/);
  assert.match(api.updateFreightRate(id, '65.01-70', -5).error, /zero or more/);
  assert.match(api.updateFreightRate(id, '65.01-70', 'abc').error, /zero or more/);
});

// ── Fuel prices ───────────────────────────────────────────────

test('addFuelPrice records the price and reports the band it lands in', () => {
  const { api } = asAdmin(base());

  const res = api.addFuelPrice({
    effectiveDate: '7/1/2026',
    dieselPrice: 67,
  });

  assert.equal(res.success, true);
  assert.equal(res.fuelPrice.band, '65.01-70');

  const prices = api.getFuelPrices();
  assert.equal(prices.length, 1);
  assert.equal(prices[0].dieselPrice, 67);
  assert.equal(prices[0].addedBy, EMAIL.Admin);
});

test('getFuelPrices returns the newest effective date first', () => {
  const { api } = asAdmin(base());
  api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 69 });
  api.addFuelPrice({ effectiveDate: '6/24/2026', dieselPrice: 64 });

  assert.deepEqual(
    api.getFuelPrices().map((p) => p.effectiveDate),
    ['7/15/2026', '7/1/2026', '6/24/2026']
  );
});

test('addFuelPrice refuses a missing date and a price that is not positive', () => {
  const { api } = asAdmin(base());

  assert.match(api.addFuelPrice({ dieselPrice: 67 }).error, /Effective date/);
  assert.match(api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 0 }).error, /greater than zero/);
  assert.match(api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 'x' }).error, /greater than zero/);
});

test('updateFuelPrice corrects the price and re-reports the band', () => {
  const { api } = asAdmin(base());
  const id = api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 }).fuelPrice.id;

  const res = api.updateFuelPrice(id, { effectiveDate: '7/14/2026', dieselPrice: 72 });
  assert.equal(res.success, true);
  assert.equal(res.fuelPrice.band, '70.01-75');

  const prices = api.getFuelPrices();
  assert.equal(prices.length, 1);
  assert.equal(prices[0].effectiveDate, '7/14/2026');
  assert.equal(prices[0].dieselPrice, 72);
});

test('updateFuelPrice can change one field alone and validates both', () => {
  const { api } = asAdmin(base());
  const id = api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 }).fuelPrice.id;

  assert.equal(api.updateFuelPrice(id, { dieselPrice: 68 }).success, true);
  assert.equal(api.getFuelPrices()[0].effectiveDate, '7/7/2026');
  assert.equal(api.getFuelPrices()[0].dieselPrice, 68);

  assert.match(api.updateFuelPrice(id, { dieselPrice: 0 }).error, /greater than zero/);
  assert.match(api.updateFuelPrice(id, { effectiveDate: 'soon' }).error, /Effective date/);
  assert.match(api.updateFuelPrice(id, {}).error, /Nothing to change/);
  assert.match(api.updateFuelPrice(9999, { dieselPrice: 70 }).error, /not found/);
});

test('deleteFuelPrice removes only that week and audits what it dropped', () => {
  const { api, ss } = asAdmin(base());
  const keep = api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 }).fuelPrice.id;
  const drop = api.addFuelPrice({ effectiveDate: '7/14/2026', dieselPrice: 72 }).fuelPrice.id;

  assert.equal(api.deleteFuelPrice(drop).success, true);
  assert.deepEqual(api.getFuelPrices().map((p) => p.id), [keep]);
  assert.match(api.deleteFuelPrice(drop).error, /not found/);

  const actions = dump(ss, 'Audit Log').rows
    .map((r) => rowObject(HEADERS['Audit Log'], r).Action);
  assert.ok(actions.includes('FUEL_PRICE_DELETE'));
});

test('editing and removing a fuel price need EDIT_FREIGHT_RATES', () => {
  const sheets = base();
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Admin });
  const id = api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 }).fuelPrice.id;

  const viewer = makeEnv({ sheets, userEmail: EMAIL.Viewer }).api;
  assert.throws(() => viewer.updateFuelPrice(id, { dieselPrice: 70 }), /Access denied/);
  assert.throws(() => viewer.deleteFuelPrice(id), /Access denied/);
});

// ── The date lock ─────────────────────────────────────────────

test('the price and the rate in force are the newest ones on or before the date', () => {
  const { api } = asAdmin(base());

  api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 72 });
  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  api.importFreightRates('TANZA', '7/15/2026', [rateRow('Calamba', '4W', { '65.01-70': 19000 })]);

  const prices = api.getFuelPrices();
  const rates = api.getFreightRates('TANZA');

  // A billing dated in the first week never sees the mid-month revision.
  const early = api._fuelPriceOn(prices, api._parseDate('7/6/2026'));
  assert.equal(early.price, 67);
  const earlyIndex = api._indexRates(rates, api._parseDate('7/6/2026'));
  assert.equal(api._rateFor(earlyIndex, 'TANZA', 'Calamba', '4W', 8), 17670);

  // A billing dated after the revision picks it up.
  const late = api._fuelPriceOn(prices, api._parseDate('7/20/2026'));
  assert.equal(late.price, 72);
  const lateIndex = api._indexRates(rates, api._parseDate('7/20/2026'));
  assert.equal(api._rateFor(lateIndex, 'TANZA', 'Calamba', '4W', 8), 19000);
});

test('a date before every rate block finds no price and no rate', () => {
  const { api } = asAdmin(base());
  api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);

  assert.equal(api._fuelPriceOn(api.getFuelPrices(), api._parseDate('6/1/2026')), null);
  const idx = api._indexRates(api.getFreightRates('TANZA'), api._parseDate('6/1/2026'));
  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '4W', 8), null);
});

test('an unknown area, type or origin answers null rather than a zero rate', () => {
  const { api } = asAdmin(base());
  api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  const idx = api._indexRates(api.getFreightRates(), api._parseDate('7/6/2026'));

  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '4W', 8), 17670);
  assert.equal(api._rateFor(idx, 'TANZA', 'Nowhere', '4W', 8), null);
  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '6W', 8), null);
  assert.equal(api._rateFor(idx, 'LINGUNAN', 'Calamba', '4W', 8), null);
  // A band the block never filled in is also null, not zero.
  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '4W', 9), null);
});

// ── Manual money columns ──────────────────────────────────────

test('the Billing Charge Types sheet self-seeds with the columns the paper billing carries', () => {
  const { api } = asAdmin(base());
  const types = api.getBillingChargeTypes();

  assert.deepEqual(
    types.map((t) => t.label),
    ['Parking Fee/Toll Fees', 'Packing Tape', 'Bad Orders @5.00 / Bx']
  );
  assert.ok(types.every((t) => t.active === true));
});

test('createBillingChargeType adds a column and refuses a duplicate label', () => {
  const { api } = asAdmin(base());

  const res = api.createBillingChargeType({ label: 'RORO Fee' });
  assert.equal(res.success, true);
  assert.equal(res.billingChargeType.label, 'RORO Fee');
  assert.ok(api.getBillingChargeTypes().some((t) => t.label === 'RORO Fee'));

  assert.match(api.createBillingChargeType({ label: 'roro fee' }).error, /already exists/);
  assert.match(api.createBillingChargeType({ label: '  ' }).error, /Label is required/);
});

test('updateBillingChargeType renames, reorders and deactivates a column', () => {
  const { api } = asAdmin(base());
  const id = api.getBillingChargeTypes()[0].id;

  assert.equal(api.updateBillingChargeType(id, { label: 'Parking / Toll / RORO' }).success, true);
  assert.equal(api.updateBillingChargeType(id, { sortOrder: 99 }).success, true);
  assert.equal(api.updateBillingChargeType(id, { active: false }).success, true);

  const t = api.getBillingChargeTypes().find((x) => x.id === id);
  assert.equal(t.label, 'Parking / Toll / RORO');
  assert.equal(t.sortOrder, 99);
  assert.equal(t.active, false);
  // Reordering actually reorders: the renamed column now sorts last.
  assert.equal(api.getBillingChargeTypes().slice(-1)[0].id, id);
});

test('billing columns are open to Payroll but closed to a Viewer', () => {
  const sheets = base();
  const payroll = makeEnv({ sheets, userEmail: EMAIL.Payroll });
  assert.equal(payroll.api.createBillingChargeType({ label: 'Ferry Fee' }).success, true);

  const viewer = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  assert.throws(() => viewer.api.createBillingChargeType({ label: 'Nope' }), /Access denied/);
});
