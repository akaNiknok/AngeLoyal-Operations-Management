// ============================================================
//  AngeLoyal OMS — server/writers/billing.js
//  Freight rates, fuel prices and the billing ledger (DataWriters.gs
//  BILLING section). Money logic: correctness and an audit trail
//  over cleverness. Charge-type CRUD (createBillingChargeType,
//  updateBillingChargeType) lives in writers/masters.js — it manages
//  a master list, not billing math.
// ============================================================

import {
  q, one, run, batch, stmt, numOrNull, nowPH, todayPH,
  fromClientDate, toClientDate, toClientDateTime,
} from '../db.js';
import { currentEmail } from '../ctx.js';
import { requirePermission } from '../rbac.js';
import {
  _auditLog, _auditLogBatch, FUEL_BAND_COUNT, _fuelBandIndex, _fuelBandLabel,
  _fuelBandFromLabel, _normArea, _fuelPriceOn, _cachedRateIndex, _computeBillingLine,
  _sumManualCharges,
} from '../internals.js';
import {
  tripFromRow, getFreightRates, getFuelPrices, getTrucks, getBillingChargeTypes,
  billingLineFromRow, billingLinesByWaybill, _billingTotals,
} from '../readers.js';

/** Trip statuses whose waybill is finished work and can be billed. */
const BILLABLE_TRIP_STATUSES = ['Delivered', 'Two-Day Trip'];

// ============================================================
//  Freight rates
// ============================================================

/**
 * Seeds or replaces one origin's rate block. Re-posting the same origin and
 * effective date replaces that block instead of stacking a second copy.
 * @param {string} origin
 * @param {string} effectiveDate  'M/d/yyyy'
 * @param {Object[]} rows  [{ area, truckType, bands: { '65.01-70': 15300, ... } }]
 */
export async function importFreightRates(origin, effectiveDate, rows) {
  await requirePermission('EDIT_FREIGHT_RATES');
  try {
    const originName = String(origin || '').trim();
    if (!originName) throw new Error('Origin warehouse is required.');

    const effDate = fromClientDate(effectiveDate);
    if (!effDate) throw new Error('Effective date is required, in M/d/yyyy format.');

    if (!Array.isArray(rows) || rows.length === 0) throw new Error('No rate rows to import.');

    const parsedRows = rows.map((r) => {
      const area = String(r.area || '').trim();
      const type = String(r.truckType || '').trim();
      if (!area || !type) throw new Error('Every rate row needs an area and a truck type.');
      return { area, type, bands: r.bands || {} };
    });

    // Drop any earlier block for the same origin and date — matched by the
    // same normalized-origin comparison the rate lookup uses.
    const wantOrigin = _normArea(originName);
    const candidates = await q(
      `SELECT id, origin, area, truck_type FROM freight_rates WHERE effective_date = ?`, effDate);
    const doomed = candidates.filter((r) => _normArea(r.origin) === wantOrigin);
    const replacedGroups = new Set(doomed.map((r) => `${_normArea(r.area)}|${_normArea(r.truck_type)}`));

    const stmts = [];
    if (doomed.length) {
      const marks = doomed.map(() => '?').join(',');
      stmts.push(stmt(`DELETE FROM freight_rates WHERE id IN (${marks})`, ...doomed.map((r) => r.id)));
    }
    parsedRows.forEach((r) => {
      const areaKey = _normArea(r.area);
      for (let i = 1; i <= FUEL_BAND_COUNT; i++) {
        const v = r.bands[_fuelBandLabel(i)];
        if (v === null || v === undefined || v === '') continue;   // a blank band has no row
        stmts.push(stmt(
          `INSERT INTO freight_rates (origin, area, area_key, truck_type, effective_date, band, rate)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          originName, r.area, areaKey, r.type, effDate, i, Number(v)));
      }
    });
    if (stmts.length) await batch(stmts);

    await _auditLog('FREIGHT_RATE_IMPORT', 'freight_rates', null, '',
      `${originName} → ${parsedRows.length} rows effective ${toClientDate(effDate)}`);

    return { success: true, imported: parsedRows.length, replaced: replacedGroups.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Edits one rate cell from the Billing Matrix panel. `rateId` may be any row
 * of the (origin, area, truck type, effective date) block — it resolves the
 * whole block on the RAW area ("San Juan" and "SAN JUAN" are two towns), then upserts or deletes just the one band's row.
 * @param {number} rateId
 * @param {string} bandLabel
 * @param {number|string} value  Blank clears the cell.
 */
export async function updateFreightRate(rateId, bandLabel, value) {
  await requirePermission('EDIT_FREIGHT_RATES');
  try {
    const label = String(bandLabel || '').trim();
    const bandIndex = _fuelBandFromLabel(label);
    if (!bandIndex) throw new Error(`"${label}" is not a price band on the matrix.`);

    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (raw !== '' && !(isFinite(Number(raw)) && Number(raw) >= 0)) {
      throw new Error('A rate must be a number that is zero or more.');
    }

    const anyRow = await one(`SELECT * FROM freight_rates WHERE id = ?`, Number(rateId));
    if (!anyRow) throw new Error(`Freight rate ID ${rateId} not found.`);

    const bandRow = await one(
      `SELECT * FROM freight_rates
       WHERE origin = ? AND area = ? AND truck_type = ? AND effective_date = ? AND band = ?`,
      anyRow.origin, anyRow.area, anyRow.truck_type, anyRow.effective_date, bandIndex);

    const oldVal = bandRow ? bandRow.rate : null;
    const newVal = raw === '' ? '' : Number(raw);

    if (raw === '') {
      if (bandRow) await run(`DELETE FROM freight_rates WHERE id = ?`, bandRow.id);
    } else if (bandRow) {
      await run(`UPDATE freight_rates SET rate = ? WHERE id = ?`, newVal, bandRow.id);
    } else {
      await run(
        `INSERT INTO freight_rates (origin, area, area_key, truck_type, effective_date, band, rate)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        anyRow.origin, anyRow.area, anyRow.area_key, anyRow.truck_type, anyRow.effective_date,
        bandIndex, newVal);
    }

    await _auditLog('FREIGHT_RATE_EDIT', 'freight_rates', Number(rateId),
      JSON.stringify({ band: label, value: oldVal }), JSON.stringify({ band: label, value: newVal }));

    return {
      success: true,
      rate: {
        id: Number(rateId),
        origin: String(anyRow.origin).trim(),
        area: String(anyRow.area).trim(),
        truckType: String(anyRow.truck_type).trim(),
        band: label,
        value: newVal,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
//  Fuel prices
// ============================================================

/** One diesel price per effective date (fuel_prices.effective_date is UNIQUE). */
async function _requireFreeFuelDate(effDate, skipId) {
  const dup = await one(`SELECT id FROM fuel_prices WHERE effective_date = ? AND id IS NOT ?`, effDate, skipId);
  if (dup) throw new Error(`A diesel price effective ${toClientDate(effDate)} already exists. Edit that one instead.`);
}

/** @param {{ effectiveDate: string, dieselPrice: number }} data */
export async function addFuelPrice(data) {
  await requirePermission('EDIT_FREIGHT_RATES');
  try {
    const effDate = fromClientDate(data && data.effectiveDate);
    if (!effDate) throw new Error('Effective date is required, in M/d/yyyy format.');

    const price = Number(data && data.dieselPrice);
    if (!isFinite(price) || price <= 0) {
      throw new Error('Enter the diesel price as a number greater than zero.');
    }

    await _requireFreeFuelDate(effDate, null);

    const email = currentEmail() || 'unknown';
    const now = nowPH();
    const { last_row_id } = await run(
      `INSERT INTO fuel_prices (effective_date, diesel_price, added_by, added_at) VALUES (?, ?, ?, ?)`,
      effDate, price, email, now);

    await _auditLog('FUEL_PRICE_ADD', 'fuel_prices', last_row_id, '',
      `${price} effective ${toClientDate(effDate)}`);

    return {
      success: true,
      fuelPrice: {
        id: last_row_id, effectiveDate: toClientDate(effDate), dieselPrice: price,
        addedBy: email, addedAt: toClientDateTime(now),
        band: _fuelBandLabel(_fuelBandIndex(price)),
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Corrects one recorded diesel price.
 * @param {number} priceId
 * @param {{ effectiveDate?: string, dieselPrice?: number }} changes
 */
export async function updateFuelPrice(priceId, changes) {
  await requirePermission('EDIT_FREIGHT_RATES');
  try {
    const row = await one(`SELECT * FROM fuel_prices WHERE id = ?`, Number(priceId));
    if (!row) throw new Error('Fuel price not found.');

    const fields = {};
    if (changes && changes.effectiveDate !== undefined) {
      const effDate = fromClientDate(changes.effectiveDate);
      if (!effDate) throw new Error('Effective date is required, in M/d/yyyy format.');
      await _requireFreeFuelDate(effDate, row.id);
      fields.effective_date = effDate;
    }
    if (changes && changes.dieselPrice !== undefined) {
      const price = Number(changes.dieselPrice);
      if (!isFinite(price) || price <= 0) {
        throw new Error('Enter the diesel price as a number greater than zero.');
      }
      fields.diesel_price = price;
    }
    if (Object.keys(fields).length === 0) throw new Error('Nothing to change.');

    const oldDate = toClientDate(row.effective_date);
    const oldPrice = numOrNull(row.diesel_price);

    const cols = Object.keys(fields);
    await run(
      `UPDATE fuel_prices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => fields[c]), row.id);

    const effDate = fields.effective_date !== undefined ? toClientDate(fields.effective_date) : oldDate;
    const price = fields.diesel_price !== undefined ? fields.diesel_price : oldPrice;

    await _auditLog('FUEL_PRICE_EDIT', 'fuel_prices', row.id,
      `${oldPrice} effective ${oldDate}`, `${price} effective ${effDate}`);

    return {
      success: true,
      fuelPrice: {
        id: row.id, effectiveDate: effDate, dieselPrice: price,
        addedBy: row.added_by || '',
        band: _fuelBandLabel(_fuelBandIndex(price)),
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Removes one recorded diesel price. A billing already stamped with a billing
 * number keeps the rate it was priced at, so this cannot re-price history.
 * @param {number} priceId
 */
export async function deleteFuelPrice(priceId) {
  await requirePermission('EDIT_FREIGHT_RATES');
  try {
    const row = await one(`SELECT * FROM fuel_prices WHERE id = ?`, Number(priceId));
    if (!row) throw new Error('Fuel price not found.');

    await run(`DELETE FROM fuel_prices WHERE id = ?`, row.id);

    await _auditLog('FUEL_PRICE_DELETE', 'fuel_prices', row.id,
      `${row.diesel_price} effective ${toClientDate(row.effective_date)}`, '');

    return { success: true, deleted: row.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
//  The billing ledger
// ============================================================

/**
 * Groups the billable trips of a date range by waybill. A waybill's stops
 * share one `trips.waybill_id` in the normalized schema, so the group is a
 * straight join — no more matching rows by waybill number. A load only
 * counts once every one of its stops (within the range) is delivered.
 * @param {string} from  'M/d/yyyy'
 * @param {string} to    'M/d/yyyy'
 * @returns {Promise<Array<{ waybillNumber: string, waybillId: number, trips: Object[] }>>}
 */
export async function _billableWaybillGroups(from, to) {
  const f = fromClientDate(from) || todayPH();
  const t = fromClientDate(to) || todayPH();
  const rows = await q(
    `SELECT t.*, o.area AS area, w.waybill_number
     FROM trips t
     JOIN waybills w ON w.id = t.waybill_id
     LEFT JOIN outlets o ON o.id = t.outlet_id
     WHERE w.status = 'Confirmed' AND t.trip_date BETWEEN ? AND ?
     ORDER BY t.waybill_id, t.id`,
    f, t);
  if (!rows.length) return [];

  const groups = {};
  const rejectedIds = new Set();
  rows.forEach((r) => {
    const wbId = r.waybill_id;
    const trip = tripFromRow(r, []);
    if (BILLABLE_TRIP_STATUSES.indexOf(trip.tripStatus) === -1) { rejectedIds.add(wbId); return; }
    const g = groups[wbId] || (groups[wbId] = {
      waybillNumber: String(r.waybill_number || ''), waybillId: wbId, trips: [],
    });
    g.trips.push(trip);
  });

  return Object.keys(groups).filter((k) => !rejectedIds.has(groups[k].waybillId)).map((k) => groups[k]);
}

/**
 * Builds the values a billing line holds for a waybill group, from the rate
 * matrix and the diesel price in force on the load's Billing Date.
 * @param {Object} group  From _billableWaybillGroups().
 * @param {Object[]} rates
 * @param {Object[]} prices
 * @param {Object} trucksById
 * @param {Object} [indexCache]
 */
export function _priceWaybillGroup(group, rates, prices, trucksById, indexCache) {
  // Trip Date is the day the load was delivered and is what the billing
  // prints. Billing Date is the original operational day and is what selects
  // the price — a carry-over keeps the fuel band of the day it was ordered.
  const first = group.trips[0];
  const billingDate = first.billingDate || first.tripDate;

  const fuel = _fuelPriceOn(prices, billingDate);
  const band = fuel ? _fuelBandIndex(fuel.price) : null;
  const truck = trucksById[first.truckId];

  const computed = band === null
    ? {
        area: first.area || '', drops: group.trips.length,
        cartons: group.trips.reduce((s, t) => s + (Number(t.quantity) || 0), 0),
        haulingRate: 0, mano: 0, dropFee: 0,
        warning: `No diesel price recorded on or before ${first.billingDate || first.tripDate}.`,
      }
    : _computeBillingLine(group.trips, _cachedRateIndex(rates, billingDate, indexCache), band);

  return Object.assign(computed, {
    waybillNumber: group.waybillNumber,
    waybillId: group.waybillId,
    tripDate: first.tripDate,
    billingDate: first.billingDate || first.tripDate,
    origin: first.origin || '',
    plateNumber: truck ? truck.plate : '',
    foNumber: first.foNumber || '',
    truckType: first.truckBillingCategory || '',
    dieselPrice: fuel ? fuel.price : '',
    rateBand: band === null ? '' : _fuelBandLabel(band),
  });
}

/**
 * Returns the billing lines for a date range, creating the ones that do not
 * exist yet and refreshing the computed fields on the ones that do. A line
 * already carrying a Billing Number is history and is left alone; on an
 * unbilled line, only the fields the user has not overridden are recomputed.
 * @param {string} from  'M/d/yyyy' — matched against Trip Date
 * @param {string} to    'M/d/yyyy'
 */
export async function getBillingLines(from, to) {
  await requirePermission('VIEW_BILLING');
  try {
    const groups = await _billableWaybillGroups(from, to);

    const originSet = {};
    groups.forEach((g) => { const o = g.trips[0] && g.trips[0].origin; if (o) originSet[o] = true; });

    const [rates, prices, trucks, chargeTypes] = await Promise.all([
      getFreightRates(Object.keys(originSet)),
      getFuelPrices(),
      getTrucks(),
      getBillingChargeTypes(),
    ]);
    const trucksById = {};
    trucks.forEach((tr) => { trucksById[tr.id] = tr; });
    const rateCache = {};

    const waybillIds = groups.map((g) => g.waybillId);
    const existingByWaybill = waybillIds.length ? await billingLinesByWaybill(waybillIds) : {};

    const email = currentEmail() || 'unknown';
    const now = nowPH();

    const insertStmts = [];
    const insertMeta = [];
    const updateStmts = [];
    const warnByWaybillId = {};

    groups.forEach((g) => {
      const priced = _priceWaybillGroup(g, rates, prices, trucksById, rateCache);
      if (priced.warning) warnByWaybillId[g.waybillId] = priced.warning;

      const rateBandIdx = priced.rateBand ? _fuelBandFromLabel(priced.rateBand) : null;
      const dieselPrice = priced.dieselPrice === '' ? null : priced.dieselPrice;
      const existing = existingByWaybill[g.waybillId];

      if (!existing) {
        const total = priced.haulingRate + priced.mano + priced.dropFee;
        insertStmts.push(stmt(
          `INSERT INTO billing_lines
             (waybill_id, trip_date, billing_date, origin, plate_number, fo_number, truck_type,
              area, drops, cartons, diesel_price, rate_band, hauling_rate, mano, drop_fee, total,
              status, added_by, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (waybill_id) DO NOTHING RETURNING id`,
          g.waybillId, fromClientDate(priced.tripDate), fromClientDate(priced.billingDate),
          priced.origin, priced.plateNumber, priced.foNumber, priced.truckType,
          priced.area, priced.drops, priced.cartons, dieselPrice, rateBandIdx,
          priced.haulingRate, priced.mano, priced.dropFee, total, 'Not Billed', email, now));
        insertMeta.push(g.waybillNumber);
        return;
      }

      if (String(existing.billingNumber || '').trim()) return;   // frozen: a submitted billing

      const overrides = Array.isArray(existing.overrides) ? existing.overrides : [];
      const fields = {
        trip_date: fromClientDate(priced.tripDate), billing_date: fromClientDate(priced.billingDate),
        origin: priced.origin, plate_number: priced.plateNumber, fo_number: priced.foNumber,
        truck_type: priced.truckType, drops: priced.drops, cartons: priced.cartons,
        diesel_price: dieselPrice, rate_band: rateBandIdx,
      };
      let haulingRate = existing.haulingRate, mano = existing.mano, dropFee = existing.dropFee;
      if (overrides.indexOf('haulingRate') === -1) {
        fields.hauling_rate = priced.haulingRate; fields.area = priced.area; haulingRate = priced.haulingRate;
      }
      if (overrides.indexOf('mano') === -1) { fields.mano = priced.mano; mano = priced.mano; }
      if (overrides.indexOf('dropFee') === -1) { fields.drop_fee = priced.dropFee; dropFee = priced.dropFee; }
      fields.total = haulingRate + mano + dropFee + _sumManualCharges(existing.manualCharges);

      const cols = Object.keys(fields);
      // Opening the panel recomputes every line, but the rates and the trips
      // rarely moved since the last open. Writing a row that already holds
      // these values spends the daily row-write budget for nothing.
      if (cols.every((c) => fields[c] === existing.row[c])) return;
      updateStmts.push(stmt(
        `UPDATE billing_lines SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...cols.map((c) => fields[c]), existing.id));
    });

    // A concurrent refresh may have created a line first: its insert returns
    // no row and is skipped, instead of failing the whole range on UNIQUE.
    const created = [];
    if (insertStmts.length) {
      (await batch(insertStmts)).forEach((r, i) => {
        if (r.results.length) created.push({ id: r.results[0].id, number: insertMeta[i] });
      });
    }
    if (updateStmts.length) await batch(updateStmts);

    await _auditLogBatch(created.map((c) => ({
      action: 'BILLING_LINE_CREATE', table: 'billing_lines', rowId: c.id, oldValue: '', newValue: c.number,
    })));

    const finalByWaybill = waybillIds.length ? await billingLinesByWaybill(waybillIds) : {};
    const lines = Object.values(finalByWaybill)
      .map((l) => Object.assign(l, { warning: warnByWaybillId[l.waybillId] || '' }))
      .sort((a, b) => (a.waybillNumber < b.waybillNumber ? -1 : (a.waybillNumber > b.waybillNumber ? 1 : 0)));

    return { success: true, lines, chargeTypes, totals: _billingTotals(lines) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const OVERRIDABLE = { haulingRate: 'hauling_rate', mano: 'mano', dropFee: 'drop_fee' };
const OVERRIDABLE_LABEL = { haulingRate: 'Hauling Rate', mano: 'Mano', dropFee: 'Drop Fee' };

/** One billing_lines row with its waybill number joined in, or null. */
async function _billingLineRow(id) {
  return await one(
    `SELECT b.*, w.waybill_number FROM billing_lines b
     JOIN waybills w ON w.id = b.waybill_id WHERE b.id = ?`, Number(id));
}

/**
 * Edits one billing line: a manual charge, an override of a computed amount,
 * or the notes. Total is always recomputed here and never accepted from the
 * client. Passing null for haulingRate, mano or dropFee drops the override.
 * @param {number} lineId
 * @param {{ manualCharges?: Object, haulingRate?: number|null, mano?: number|null,
 *           dropFee?: number|null, notes?: string }} changes
 */
export async function saveBillingLine(lineId, changes) {
  await requirePermission('EDIT_BILLING');
  try {
    const row = await _billingLineRow(lineId);
    if (!row) throw new Error('Billing line not found.');
    if (String(row.billing_number || '').trim()) {
      throw new Error('This line is already on a submitted billing. Clear its billing number first.');
    }

    const charges = await q(`SELECT * FROM billing_line_charges WHERE billing_line_id = ?`, row.id);
    const oldVal = billingLineFromRow(row, charges);

    const overrides = Array.isArray(oldVal.overrides) ? oldVal.overrides.slice() : [];
    const fields = {};
    Object.keys(OVERRIDABLE).forEach((key) => {
      if (!changes || changes[key] === undefined) return;
      const at = overrides.indexOf(key);
      if (changes[key] === null) {
        if (at !== -1) overrides.splice(at, 1);   // back to the computed value
        return;
      }
      const n = Number(changes[key]);
      if (!isFinite(n) || n < 0) throw new Error(`${OVERRIDABLE_LABEL[key]} must be a number that is zero or more.`);
      fields[OVERRIDABLE[key]] = n;
      if (at === -1) overrides.push(key);
    });

    const manual = Object.assign({}, oldVal.manualCharges);
    if (changes && changes.manualCharges !== undefined) {
      Object.keys(changes.manualCharges || {}).forEach((k) => {
        const n = Number(changes.manualCharges[k]);
        if (!isFinite(n)) throw new Error('A manual charge must be a number.');
        if (n !== 0) manual[String(k)] = n;   // a zero is the same as no charge
        else delete manual[String(k)];
      });
    }

    if (changes && changes.notes !== undefined) fields.notes = String(changes.notes);
    fields.overrides = overrides.length ? JSON.stringify(overrides) : null;

    const haulingRate = fields.hauling_rate !== undefined ? fields.hauling_rate : oldVal.haulingRate;
    const mano = fields.mano !== undefined ? fields.mano : oldVal.mano;
    const dropFee = fields.drop_fee !== undefined ? fields.drop_fee : oldVal.dropFee;
    fields.total = haulingRate + mano + dropFee + _sumManualCharges(manual);

    fields.updated_by = currentEmail() || 'unknown';
    fields.updated_at = nowPH();

    const cols = Object.keys(fields);
    // The amounts, the total and the charge set land together or not at all:
    // a total that disagrees with its charges is a wrong invoice.
    const chargeStmts = [
      stmt(`UPDATE billing_lines SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...cols.map((c) => fields[c]), row.id),
      stmt(`DELETE FROM billing_line_charges WHERE billing_line_id = ?`, row.id),
    ];
    Object.keys(manual).forEach((chargeTypeId) => {
      chargeStmts.push(stmt(
        `INSERT INTO billing_line_charges (billing_line_id, charge_type_id, amount) VALUES (?, ?, ?)`,
        row.id, Number(chargeTypeId), manual[chargeTypeId]));
    });
    await batch(chargeStmts);

    await _auditLog('BILLING_LINE_EDIT', 'billing_lines', row.id,
      JSON.stringify({
        haulingRate: oldVal.haulingRate, mano: oldVal.mano,
        dropFee: oldVal.dropFee, manualCharges: oldVal.manualCharges,
      }),
      JSON.stringify(changes));

    const newRow = await _billingLineRow(row.id);
    const newCharges = await q(`SELECT * FROM billing_line_charges WHERE billing_line_id = ?`, row.id);
    return { success: true, line: billingLineFromRow(newRow, newCharges) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Defers a line to a later billing, or brings a deferred line back.
 * @param {number[]|number} lineIds
 * @param {string} status  'Not Billed' or 'Deferred'
 */
export async function setBillingLineStatus(lineIds, status) {
  await requirePermission('EDIT_BILLING');
  try {
    const next = String(status || '').trim();
    if (['Not Billed', 'Deferred'].indexOf(next) === -1) {
      throw new Error('A line can only be set to Not Billed or Deferred.');
    }
    const ids = (Array.isArray(lineIds) ? lineIds : [lineIds]).map(Number).filter((n) => Number.isFinite(n));
    if (!ids.length) throw new Error('No lines selected.');

    const marks = ids.map(() => '?').join(',');
    const rows = await q(`SELECT * FROM billing_lines WHERE id IN (${marks})`, ...ids);
    const byId = {};
    rows.forEach((r) => { byId[r.id] = r; });

    const updates = [];
    const auditEntries = [];
    ids.forEach((id) => {
      const row = byId[id];
      if (!row) return;
      if (String(row.billing_number || '').trim()) {
        throw new Error('A line already on a submitted billing cannot be deferred.');
      }
      const old = String(row.status || '');
      if (old === next) return;
      updates.push(stmt(`UPDATE billing_lines SET status = ? WHERE id = ?`, next, id));
      auditEntries.push({ action: 'BILLING_LINE_STATUS_CHANGE', table: 'billing_lines', rowId: id, oldValue: old, newValue: next });
    });

    if (updates.length) await batch(updates);
    await _auditLogBatch(auditEntries);
    return { success: true, updated: updates.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Stamps a Rebisco billing number on a set of lines and marks them Billed. A
 * blank number clears the stamp, reopening the lines for editing.
 * @param {number[]|number} lineIds
 * @param {string} billingNumber
 */
export async function setBillingNumber(lineIds, billingNumber) {
  await requirePermission('EDIT_BILLING');
  try {
    const ids = (Array.isArray(lineIds) ? lineIds : [lineIds]).map(Number).filter((n) => Number.isFinite(n));
    if (!ids.length) throw new Error('No lines selected.');

    const num = String(billingNumber || '').trim();
    const clearing = num === '';

    const marks = ids.map(() => '?').join(',');
    const found = await q(`SELECT id FROM billing_lines WHERE id IN (${marks})`, ...ids);

    if (found.length) {
      await batch(found.map((r) => stmt(
        `UPDATE billing_lines SET billing_number = ?, status = ? WHERE id = ?`,
        clearing ? null : num, clearing ? 'Not Billed' : 'Billed', r.id)));
    }

    await _auditLog('BILLING_NUMBER_SET', 'billing_lines', null, '',
      `${clearing ? '(cleared)' : num} → ${found.length} lines`);

    return { success: true, updated: found.length, billingNumber: num };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
