// ============================================================
//  AngeLoyal OMS — server/internals.js
//  Audit logging, area/band/rate helpers and billing constants
//  (from Internals.gs and Code.gs). Waybill suggestion and the
//  carry-over helpers arrive with the Phase 1 writers.
// ============================================================

import { currentEmail } from './ctx.js';
import { batch, stmt, nowPH, addDays, dayOfWeek, fromClientDate } from './db.js';

// ------------------------------------------------------------
//  Billing constants (Code.gs)
// ------------------------------------------------------------

// The DOE rate matrix indexes on a diesel price band 5 pesos wide. The first
// band is 30.01-35, so band 1 = 32.5 and band 25 = 152.5. A price outside
// that range clamps.
export const FUEL_BAND_WIDTH = 5;
export const FUEL_BAND_BASE  = 30;   // the lower edge of band 1
export const FUEL_BAND_COUNT = 25;

// Contractual fees, VAT inclusive. A billing line snapshots the amounts it
// used, so a change here can never re-price a past billing.
export const MANO_CARTON_STEP = 100;  // one Mano fee for each full 100 cartons at one store
export const MANO_FEE         = 392;  // 350 + 12% VAT
export const DROP_FEE_MIN     = 3;    // the fee starts at this many drops on one FO
export const DROP_FEE         = 560;  // 500 + 12% VAT
export const VAT_RATE         = 0.12;
export const WITHHOLDING_RATE = 0.02;

// ------------------------------------------------------------
//  Audit log — best-effort, never throws
// ------------------------------------------------------------

function auditStmt(e, ts, email) {
  return stmt(
    `INSERT INTO audit_log (ts, user_email, action, detail, table_name, row_id, old_value, new_value)
     VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
    ts, email, e.action,
    e.table || '',
    e.rowId === undefined || e.rowId === null || e.rowId === '' ? null : e.rowId,
    e.oldValue !== undefined ? String(e.oldValue) : '',
    e.newValue !== undefined ? String(e.newValue) : '',
  );
}

/**
 * Appends one audit row. `table` is the SQL table name.
 * @param {string} action   Vocabulary token from Docs/Schema.md
 * @param {string} [table]
 * @param {number} [rowId]
 * @param {*}      [oldValue]
 * @param {*}      [newValue]
 */
export async function _auditLog(action, table, rowId, oldValue, newValue) {
  try {
    await auditStmt({ action, table, rowId, oldValue, newValue }, nowPH(), currentEmail() || 'unknown').run();
  } catch (_) {
    // Audit is best-effort; never propagate errors
  }
}

/**
 * Batched _auditLog: one round trip for many entries.
 * @param {Array<{action: string, table?: string, rowId?: *, oldValue?: *, newValue?: *}>} entries
 */
export async function _auditLogBatch(entries) {
  if (!entries || !entries.length) return;
  try {
    const ts = nowPH();
    const email = currentEmail() || 'unknown';
    await batch(entries.map((e) => auditStmt(e, ts, email)));
  } catch (_) {
    // Audit is best-effort; never propagate errors
  }
}

// ------------------------------------------------------------
//  Dates
// ------------------------------------------------------------

/**
 * The next business day after a storage date (Monday–Saturday; skips Sunday).
 * @param {string} ymd  'YYYY-MM-DD'
 * @returns {string} 'YYYY-MM-DD'
 */
export function nextBusinessDay(ymd) {
  let next = addDays(ymd, 1);
  if (dayOfWeek(next) === 0) next = addDays(next, 1);
  return next;
}

// ------------------------------------------------------------
//  Areas, bands, rates (Internals.gs)
// ------------------------------------------------------------

/**
 * Normalizes an area name for matching. The rate matrix and the route files
 * disagree on case and punctuation for the same place ("Las PiNas" vs
 * "LAS PINAS", "Sta. Rosa" vs "STA ROSA"), so both sides compare on this key.
 * @param {string} s
 * @returns {string} Uppercase, letters and digits only.
 */
export function _normArea(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The 1-based diesel price band for a price, clamped to the matrix.
 * @param {number} price  Peso price per liter.
 * @returns {number} 1..FUEL_BAND_COUNT
 */
export function _fuelBandIndex(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return 1;
  const i = Math.ceil((p - FUEL_BAND_BASE) / FUEL_BAND_WIDTH);
  return Math.min(Math.max(i, 1), FUEL_BAND_COUNT);
}

/**
 * The band label for a band index, e.g. 8 -> '65.01-70'. FUEL_BANDS in
 * web/billing-matrix.js must name the bands exactly this way.
 * @param {number} bandIndex  1-based.
 * @returns {string}
 */
export function _fuelBandLabel(bandIndex) {
  const lower = FUEL_BAND_BASE + FUEL_BAND_WIDTH * (bandIndex - 1);
  return `${lower}.01-${lower + FUEL_BAND_WIDTH}`;
}

/** Band label -> index, or null when the label is not a band. */
export function _fuelBandFromLabel(label) {
  for (let i = 1; i <= FUEL_BAND_COUNT; i++) if (_fuelBandLabel(i) === String(label).trim()) return i;
  return null;
}

/**
 * The diesel price in force on a date: the newest fuel price whose effective
 * date is on or before it. Null when nothing that early exists — the caller
 * flags the line rather than billing at zero.
 * @param {Object[]} prices  From getFuelPrices() (client shape, any order).
 * @param {string}   onDate  'YYYY-MM-DD' or client 'M/d/yyyy'.
 * @returns {{ price: number, effectiveDate: string } | null}
 */
export function _fuelPriceOn(prices, onDate) {
  const t = fromClientDate(onDate) || '';
  let best = null;
  let bestDate = '';
  (prices || []).forEach((p) => {
    const d = fromClientDate(p.effectiveDate);   // an undated row is not in force
    if (!d || d > t) return;
    if (!best || d > bestDate) { best = p; bestDate = d; }
  });
  return best ? { price: best.dieselPrice, effectiveDate: best.effectiveDate } : null;
}

/**
 * Indexes rate rows for lookup by origin, area and truck type. Only rows in
 * force on `onDate` are kept, and the newest block wins — that is the date
 * lock: a revision published today never re-prices last week's billing.
 * @param {Object[]} rates   From getFreightRates().
 * @param {string}   onDate  'YYYY-MM-DD' or client 'M/d/yyyy'.
 * @returns {Object} Map of 'ORIGIN|AREA|TYPE' -> rate row.
 */
export function _indexRates(rates, onDate) {
  const t = fromClientDate(onDate) || '';
  const map = {};
  const eff = {};
  (rates || []).forEach((r) => {
    const d = fromClientDate(r.effectiveDate);
    if (!d || d > t) return;
    const key = _normArea(r.origin) + '|' + _normArea(r.area) + '|' + _normArea(r.truckType);
    if (!map[key] || d > eff[key]) { map[key] = r; eff[key] = d; }
  });
  return map;
}

/** _indexRates memoized on the date, for a range of many loads. */
export function _cachedRateIndex(rates, onDate, cache) {
  if (!cache) return _indexRates(rates, onDate);
  const key = fromClientDate(onDate) || '';
  if (!cache[key]) cache[key] = _indexRates(rates, onDate);
  return cache[key];
}

/**
 * One rate out of an index from _indexRates, or null when the combination has
 * no rate (unknown area, a truck type the matrix lacks, an unseeded origin).
 */
export function _rateFor(rateIndex, origin, area, truckType, bandIndex) {
  const row = rateIndex[_normArea(origin) + '|' + _normArea(area) + '|' + _normArea(truckType)];
  if (!row) return null;
  const v = row.bands[_fuelBandLabel(bandIndex)];
  return v === null || v === undefined || v === '' ? null : Number(v);
}

/**
 * Computes one billing line from the trips that share a waybill. The load
 * bills at the highest-rate drop; Mano counts full carton blocks per drop;
 * the drop fee is flat from DROP_FEE_MIN stops. `warning` is set when no
 * rate matched, so the panel flags the line instead of billing it at zero.
 * @param {Object[]} trips      Client-shaped trip rows of one waybill.
 * @param {Object}   rateIndex  From _indexRates() for the Billing Date.
 * @param {number}   bandIndex
 */
export function _computeBillingLine(trips, rateIndex, bandIndex) {
  const origin    = (trips[0] && trips[0].origin) || '';
  const truckType = (trips[0] && trips[0].truckBillingCategory) || '';

  let area = (trips[0] && trips[0].area) || '';
  let haulingRate = null;
  let cartons = 0;
  let mano = 0;
  const unpriced = [];

  trips.forEach((t) => {
    const qty = Number(t.quantity) || 0;
    cartons += qty;
    mano += Math.floor(qty / MANO_CARTON_STEP) * MANO_FEE;

    const rate = _rateFor(rateIndex, origin, t.area, truckType, bandIndex);
    if (rate === null) { unpriced.push(t.area || '(blank)'); return; }
    if (haulingRate === null || rate > haulingRate) { haulingRate = rate; area = t.area; }
  });

  let warning = '';
  if (haulingRate === null) {
    warning = `No rate for ${origin || '(no origin)'} / ${unpriced.join(', ')} / ${truckType || '(no type)'}.`;
  } else if (unpriced.length) {
    warning = `Priced without ${unpriced.join(', ')} — no rate for those areas.`;
  }

  return {
    area,
    drops: trips.length,
    cartons,
    haulingRate: haulingRate === null ? 0 : haulingRate,
    mano,
    dropFee: trips.length >= DROP_FEE_MIN ? DROP_FEE : 0,
    warning,
  };
}

/** Sums the manual charge amounts on a billing line ({ chargeTypeId: amount }). */
export function _sumManualCharges(manualCharges) {
  let sum = 0;
  Object.keys(manualCharges || {}).forEach((k) => { sum += Number(manualCharges[k]) || 0; });
  return sum;
}

/** Parses a JSON column, returning `fallback` on anything unreadable. */
export function _parseJsonCell(raw, fallback) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Rows of a comma-separated ID cell -> [{ slot, employee_id }] (0–3 helpers). */
export function helperSlots(ids) {
  return (ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 3)
    .map((employee_id, i) => ({ slot: i + 1, employee_id }));
}
