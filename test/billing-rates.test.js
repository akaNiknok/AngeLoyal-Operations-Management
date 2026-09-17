// ============================================================
//  Billing foundation — the DOE band index, the freight rate
//  matrix, the fuel price history and the manual money columns.
//  These are the inputs every billing line is priced from, so
//  the band boundaries and the effective-date lock are the
//  things worth pinning down.
//
//  Charge-type CRUD (createBillingChargeType, updateBillingChargeType)
//  moved to writers/masters.js in the D1 port — it manages a master
//  list, not billing math — so those cases live in that worker's
//  test file, not here.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { usersSheet, emptySheet, EMAIL } = require('./fixtures');

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

test('importFreightRates writes one row per area and truck type', async () => {
  const { api, db } = asAdmin(base());

  const res = await api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('Calamba', '4W', { '65.01-70': 17670 }),
    rateRow('Cabuyao', '4W', { '65.01-70': 17290 }),
  ]);

  assert.equal(res.success, true);
  assert.equal(res.imported, 2);
  assert.equal(res.replaced, 0);

  const rates = await api.getFreightRates('TANZA');
  assert.equal(rates.length, 2);
  const calamba = rates.find((r) => r.area === 'Calamba');
  assert.equal(calamba.bands['65.01-70'], 17670);
  assert.equal(calamba.effectiveDate, '7/1/2026');
  // Untouched bands come back as null, not 0 — an absent rate is not a free trip.
  assert.equal(calamba.bands['70.01-75'], null);

  const audit = dump(db, 'audit_log');
  assert.ok(audit.some((a) => a.action === 'FREIGHT_RATE_IMPORT'));
});

test('re-importing the same origin and date replaces the block instead of stacking it', async () => {
  const { api } = asAdmin(base());

  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  const res = await api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('Calamba', '4W', { '65.01-70': 18000 }),
  ]);

  assert.equal(res.replaced, 1);
  const rates = await api.getFreightRates('TANZA');
  assert.equal(rates.length, 1);
  assert.equal(rates[0].bands['65.01-70'], 18000);
});

test('a later effective date is a new block, and the earlier one survives', async () => {
  const { api } = asAdmin(base());

  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  await api.importFreightRates('TANZA', '8/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 19000 })]);

  assert.equal((await api.getFreightRates('TANZA')).length, 2);
});

test('getFreightRates filters by origin without minding the case', async () => {
  const { api } = asAdmin(base());

  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  await api.importFreightRates('LINGUNAN', '7/1/2026', [rateRow('Valenzuela', '6W', { '65.01-70': 7440 })]);

  assert.equal((await api.getFreightRates('tanza')).length, 1);
  assert.equal((await api.getFreightRates()).length, 2);
  assert.deepEqual(Array.from(await api.getFreightRateOrigins()), ['LINGUNAN', 'TANZA']);
});

test('importFreightRates refuses a bad date, an empty block and a nameless area', async () => {
  const { api } = asAdmin(base());

  assert.match((await api.importFreightRates('TANZA', '', [rateRow('A', '4W', {})])).error, /Effective date/);
  assert.match((await api.importFreightRates('TANZA', '2/30/2026', [rateRow('A', '4W', {})])).error, /Effective date/);
  assert.match((await api.importFreightRates('', '7/1/2026', [rateRow('A', '4W', {})])).error, /Origin/);
  assert.match((await api.importFreightRates('TANZA', '7/1/2026', [])).error, /No rate rows/);
  assert.match(
    (await api.importFreightRates('TANZA', '7/1/2026', [rateRow('', '4W', {})])).error,
    /area and a truck type/
  );
});

test('importFreightRates is gated by EDIT_FREIGHT_RATES', async () => {
  const sheets = base();
  const dispatcher = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  await assert.rejects(
    () => dispatcher.api.importFreightRates('TANZA', '7/1/2026', [rateRow('A', '4W', {})]),
    /Access denied/
  );
});

// ── Single rate edit ──────────────────────────────────────────

test('updateFreightRate changes one band and leaves the others alone', async () => {
  const { api } = asAdmin(base());
  await api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('Calamba', '4W', { '65.01-70': 17670, '70.01-75': 18100 }),
  ]);
  const id = (await api.getFreightRates('TANZA'))[0].id;

  const res = await api.updateFreightRate(id, '65.01-70', 17999);
  assert.equal(res.success, true);
  assert.equal(res.rate.value, 17999);

  const row = (await api.getFreightRates('TANZA'))[0];
  assert.equal(row.bands['65.01-70'], 17999);
  assert.equal(row.bands['70.01-75'], 18100);
});

test('updateFreightRate rejects an unknown band and a negative rate', async () => {
  const { api } = asAdmin(base());
  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  const id = (await api.getFreightRates('TANZA'))[0].id;

  assert.match((await api.updateFreightRate(id, '67.5', 100)).error, /not a price band/);
  assert.match((await api.updateFreightRate(id, '65.01-70', -5)).error, /zero or more/);
  assert.match((await api.updateFreightRate(id, '65.01-70', 'abc')).error, /zero or more/);
});

// ── Fuel prices ───────────────────────────────────────────────

test('addFuelPrice records the price and reports the band it lands in', async () => {
  const { api } = asAdmin(base());

  const res = await api.addFuelPrice({
    effectiveDate: '7/1/2026',
    dieselPrice: 67,
  });

  assert.equal(res.success, true);
  assert.equal(res.fuelPrice.band, '65.01-70');

  const prices = await api.getFuelPrices();
  assert.equal(prices.length, 1);
  assert.equal(prices[0].dieselPrice, 67);
  assert.equal(prices[0].addedBy, EMAIL.Admin);
});

test('getFuelPrices returns the newest effective date first', async () => {
  const { api } = asAdmin(base());
  await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  await api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 69 });
  await api.addFuelPrice({ effectiveDate: '6/24/2026', dieselPrice: 64 });

  assert.deepEqual(
    (await api.getFuelPrices()).map((p) => p.effectiveDate),
    ['7/15/2026', '7/1/2026', '6/24/2026']
  );
});

test('addFuelPrice refuses a missing date and a price that is not positive', async () => {
  const { api } = asAdmin(base());

  assert.match((await api.addFuelPrice({ dieselPrice: 67 })).error, /Effective date/);
  assert.match((await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 0 })).error, /greater than zero/);
  assert.match((await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 'x' })).error, /greater than zero/);
});

test('updateFuelPrice corrects the price and re-reports the band', async () => {
  const { api } = asAdmin(base());
  const id = (await api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 })).fuelPrice.id;

  const res = await api.updateFuelPrice(id, { effectiveDate: '7/14/2026', dieselPrice: 72 });
  assert.equal(res.success, true);
  assert.equal(res.fuelPrice.band, '70.01-75');

  const prices = await api.getFuelPrices();
  assert.equal(prices.length, 1);
  assert.equal(prices[0].effectiveDate, '7/14/2026');
  assert.equal(prices[0].dieselPrice, 72);
});

test('updateFuelPrice can change one field alone and validates both', async () => {
  const { api } = asAdmin(base());
  const id = (await api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 })).fuelPrice.id;

  assert.equal((await api.updateFuelPrice(id, { dieselPrice: 68 })).success, true);
  assert.equal((await api.getFuelPrices())[0].effectiveDate, '7/7/2026');
  assert.equal((await api.getFuelPrices())[0].dieselPrice, 68);

  assert.match((await api.updateFuelPrice(id, { dieselPrice: 0 })).error, /greater than zero/);
  assert.match((await api.updateFuelPrice(id, { effectiveDate: 'soon' })).error, /Effective date/);
  assert.match((await api.updateFuelPrice(id, {})).error, /Nothing to change/);
  assert.match((await api.updateFuelPrice(9999, { dieselPrice: 70 })).error, /not found/);
});

test('deleteFuelPrice removes only that week and audits what it dropped', async () => {
  const { api, db } = asAdmin(base());
  const keep = (await api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 })).fuelPrice.id;
  const drop = (await api.addFuelPrice({ effectiveDate: '7/14/2026', dieselPrice: 72 })).fuelPrice.id;

  assert.equal((await api.deleteFuelPrice(drop)).success, true);
  assert.deepEqual((await api.getFuelPrices()).map((p) => p.id), [keep]);
  assert.match((await api.deleteFuelPrice(drop)).error, /not found/);

  const actions = dump(db, 'audit_log').map((r) => r.action);
  assert.ok(actions.includes('FUEL_PRICE_DELETE'));
});

test('editing and removing a fuel price need EDIT_FREIGHT_RATES', async () => {
  const sheets = base();
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Admin });
  const id = (await api.addFuelPrice({ effectiveDate: '7/7/2026', dieselPrice: 67 })).fuelPrice.id;

  const viewer = makeEnv({ sheets, userEmail: EMAIL.Viewer }).api;
  await assert.rejects(() => viewer.updateFuelPrice(id, { dieselPrice: 70 }), /Access denied/);
  await assert.rejects(() => viewer.deleteFuelPrice(id), /Access denied/);
});

// ── The date lock ─────────────────────────────────────────────

test('the price and the rate in force are the newest ones on or before the date', async () => {
  const { api } = asAdmin(base());

  await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  await api.addFuelPrice({ effectiveDate: '7/15/2026', dieselPrice: 72 });
  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  await api.importFreightRates('TANZA', '7/15/2026', [rateRow('Calamba', '4W', { '65.01-70': 19000 })]);

  const prices = await api.getFuelPrices();
  const rates = await api.getFreightRates('TANZA');

  // A billing dated in the first week never sees the mid-month revision.
  const early = api._fuelPriceOn(prices, '7/6/2026');
  assert.equal(early.price, 67);
  const earlyIndex = api._indexRates(rates, '7/6/2026');
  assert.equal(api._rateFor(earlyIndex, 'TANZA', 'Calamba', '4W', 8), 17670);

  // A billing dated after the revision picks it up.
  const late = api._fuelPriceOn(prices, '7/20/2026');
  assert.equal(late.price, 72);
  const lateIndex = api._indexRates(rates, '7/20/2026');
  assert.equal(api._rateFor(lateIndex, 'TANZA', 'Calamba', '4W', 8), 19000);
});

test('a date before every rate block finds no price and no rate', async () => {
  const { api } = asAdmin(base());
  await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);

  assert.equal(api._fuelPriceOn(await api.getFuelPrices(), '6/1/2026'), null);
  const idx = api._indexRates(await api.getFreightRates('TANZA'), '6/1/2026');
  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '4W', 8), null);
});

test('an unknown area, type or origin answers null rather than a zero rate', async () => {
  const { api } = asAdmin(base());
  await api.importFreightRates('TANZA', '7/1/2026', [rateRow('Calamba', '4W', { '65.01-70': 17670 })]);
  const idx = api._indexRates(await api.getFreightRates(), '7/6/2026');

  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '4W', 8), 17670);
  assert.equal(api._rateFor(idx, 'TANZA', 'Nowhere', '4W', 8), null);
  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '6W', 8), null);
  assert.equal(api._rateFor(idx, 'LINGUNAN', 'Calamba', '4W', 8), null);
  // A band the block never filled in is also null, not zero.
  assert.equal(api._rateFor(idx, 'TANZA', 'Calamba', '4W', 9), null);
});

// ── Manual money columns ────────────────────────────────────────
// createBillingChargeType / updateBillingChargeType live in masters.js;
// only the reader is exercised here.

test('the Billing Charge Types sheet self-seeds with the columns the paper billing carries', async () => {
  const { api } = asAdmin(base());
  const types = await api.getBillingChargeTypes();

  assert.deepEqual(
    types.map((t) => t.label),
    ['Parking Fee/Toll Fees', 'Packing Tape', 'Bad Orders @5.00 / Bx']
  );
  assert.ok(types.every((t) => t.active === true));
});

// ── The rate index cache ──────────────────────────────────────

test('_cachedRateIndex reuses one index per date and still locks by date', () => {
  const { api } = asAdmin(base());
  const rates = [
    { id: 1, origin: 'TANZA', area: 'CALAMBA', truckType: '4W',
      effectiveDate: '1/1/2026', bands: { '65.01-70': 100 } },
    { id: 2, origin: 'TANZA', area: 'CALAMBA', truckType: '4W',
      effectiveDate: '6/1/2026', bands: { '65.01-70': 200 } },
  ];
  const cache = {};
  const may = '5/1/2026';
  const july = '7/1/2026';

  const a = api._cachedRateIndex(rates, may, cache);
  const b = api._cachedRateIndex(rates, may, cache);
  assert.equal(a, b, 'the same date must hand back the same index object');

  // A later date sees the newer block — the cache must not blur the date lock.
  const c = api._cachedRateIndex(rates, july, cache);
  assert.notEqual(c, a);
  assert.equal(api._rateFor(a, 'TANZA', 'CALAMBA', '4W', 8), 100);
  assert.equal(api._rateFor(c, 'TANZA', 'CALAMBA', '4W', 8), 200);

  // No cache passed is still a plain _indexRates call.
  assert.equal(api._rateFor(api._cachedRateIndex(rates, july), 'TANZA', 'CALAMBA', '4W', 8), 200);
});

test('getFreightRates takes a set of origins, and no filter still means all', async () => {
  const { api } = asAdmin(base());
  await api.importFreightRates('TANZA', '1/1/2026', [rateRow('CALAMBA', '4W', { '65.01-70': 100 })]);
  await api.importFreightRates('VILLASIS', '1/1/2026', [rateRow('URDANETA', '4W', { '65.01-70': 200 })]);
  await api.importFreightRates('CEBU', '1/1/2026', [rateRow('MANDAUE', '4W', { '65.01-70': 300 })]);

  const names = (r) => r.map((x) => x.origin).sort();

  assert.deepEqual(names(await api.getFreightRates(['TANZA', 'CEBU'])), ['CEBU', 'TANZA']);
  assert.deepEqual(names(await api.getFreightRates('VILLASIS')), ['VILLASIS'], 'a plain string still works');
  assert.deepEqual(names(await api.getFreightRates()), ['CEBU', 'TANZA', 'VILLASIS']);
  assert.deepEqual(names(await api.getFreightRates([])), ['CEBU', 'TANZA', 'VILLASIS'],
    'an empty set is no filter, not an empty answer');
  // The filter normalizes the same way the rate lookup does.
  assert.deepEqual(names(await api.getFreightRates(['  tanza '])), ['TANZA']);
});

// ── Review fixes ─────────────────────────────────────────────

test('updateFreightRate edits only its own town when two areas differ only by case', async () => {
  const { api } = asAdmin(base());
  await api.importFreightRates('TANZA', '7/1/2026', [
    rateRow('San Juan', '6W', { '65.01-70': 6760 }),
    rateRow('SAN JUAN', '6W', { '65.01-70': 16490 }),
  ]);
  const upper = (await api.getFreightRates('TANZA')).find((r) => r.area === 'SAN JUAN');
  assert.equal((await api.updateFreightRate(upper.id, '65.01-70', 16500)).success, true);

  const rows = await api.getFreightRates('TANZA');
  assert.equal(rows.find((r) => r.area === 'San Juan').bands['65.01-70'], 6760);
  assert.equal(rows.find((r) => r.area === 'SAN JUAN').bands['65.01-70'], 16500);
});

test('a second diesel price on the same effective date is refused with a readable error', async () => {
  const { api } = asAdmin(base());
  await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 67 });
  const other = (await api.addFuelPrice({ effectiveDate: '7/8/2026', dieselPrice: 68 })).fuelPrice.id;

  assert.match((await api.addFuelPrice({ effectiveDate: '7/1/2026', dieselPrice: 70 })).error, /already exists/);
  assert.match((await api.updateFuelPrice(other, { effectiveDate: '7/1/2026' })).error, /already exists/);
  assert.equal((await api.updateFuelPrice(other, { effectiveDate: '7/8/2026', dieselPrice: 69 })).success, true);
});
