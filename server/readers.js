// ============================================================
//  AngeLoyal OMS — server/readers.js
//  Read-only accessors (DataReaders.gs). THE EXEMPLAR: every writer
//  module copies these patterns.
//
//  Contract: function names, arguments and return shapes are frozen
//  at what the .gs readers returned — camelCase keys, dates as
//  'M/d/yyyy', timestamps as 'M/d/yyyy HH:mm:ss', booleans as JS
//  booleans, helpers as an array of employee IDs. The normalized
//  tables are rebuilt into those shapes here, not in web/.
//
//  Pattern: `await q(sql, ...args)` -> rows with snake_case keys ->
//  map to the client object. One query per collection; a child
//  table (helpers, charges) is fetched once and grouped in memory.
// ============================================================

import { q, one, numOrNull, round3, todayPH, addDays, fromClientDate, toClientDate, toClientDateTime } from './db.js';
import { requirePermission, getUserSession } from './rbac.js';
import { FUEL_BAND_COUNT, _fuelBandLabel, _normArea, _parseJsonCell, VAT_RATE, WITHHOLDING_RATE } from './internals.js';

export { getUserSession };

const bool = (v) => v === 1 || v === true || v === '1';

/** Groups child rows by a key into { key: [rows] }. */
function groupBy(rows, key) {
  const out = {};
  rows.forEach((r) => { (out[r[key]] = out[r[key]] || []).push(r); });
  return out;
}

// ============================================================
//  BOOT — single round trip for all master data
// ============================================================

/**
 * Everything the client needs to boot: session + all master data. A verified
 * account with no role gets its session only — never master data.
 */
export async function getBootData() {
  const session = await getUserSession();
  if (!session.role) return { session };

  const [employees, trucks, waybillPrefixes, outlets, defaultAssignments, billingCategories,
    routeTypeMap, customerGroupColors, billingChargeTypes, origins] = await Promise.all([
    getEmployees(), getTrucks(), getWaybillPrefixes(), getOutlets(), getDefaultAssignments(),
    getBillingCategories(), getRouteTypeMap(), getCustomerGroupColors(), getBillingChargeTypes(),
    getFreightRateOrigins(),
  ]);

  return {
    session, employees, trucks, waybillPrefixes, outlets, defaultAssignments, billingCategories,
    routeTypeMap, customerGroupColors, billingChargeTypes,
    // Just the warehouse names, not the rate matrix — the Import panel offers
    // them as origin suggestions. The Billing Matrix panel fetches one origin.
    origins,
  };
}

// ============================================================
//  Master records
// ============================================================

/** @returns {Promise<Array<{ id, nick, firstName, middleName, lastName, role, active }>>} */
export async function getEmployees() {
  const rows = await q(`SELECT * FROM employees ORDER BY id`);
  return rows.map((r) => ({
    id: r.id,
    nick: r.nickname || '',
    firstName: r.first_name || '',
    middleName: r.middle_name || '',
    lastName: r.last_name || '',
    role: r.role || '',
    active: bool(r.active),
  }));
}

/** @returns {Promise<Array<{ id, plate, brand, type, billingCategory, active }>>} */
export async function getTrucks() {
  const rows = await q(
    `SELECT t.*, c.name AS category_name FROM trucks t
     LEFT JOIN billing_categories c ON c.id = t.billing_category_id ORDER BY t.id`);
  return rows.map((r) => ({
    id: r.id,
    plate: r.plate_number || '(no plate)',
    brand: r.brand || '',
    type: r.type || '',
    billingCategory: r.category_name || '',
    active: bool(r.active),
  }));
}

/** @returns {Promise<Array<{ id, name, active }>>} */
export async function getBillingCategories() {
  const rows = await q(`SELECT * FROM billing_categories ORDER BY id`);
  return rows.map((r) => ({ id: r.id, name: r.name, active: bool(r.active) }));
}

/**
 * Every user, active or not. Admin-only and kept out of getBootData on
 * purpose: nobody else needs the account list.
 * @returns {Promise<Array<{ id, email, displayName, role, active }>>}
 */
export async function getUsers() {
  await requirePermission('EDIT_USERS');
  const rows = await q(`SELECT * FROM users ORDER BY id`);
  return rows.map((r) => ({
    id: r.id, email: r.email, displayName: r.display_name, role: r.role, active: bool(r.active),
  }));
}

/**
 * One page of the audit log, newest first. The log is append-only and grows
 * without limit, so a page is always bounded by a date range AND a row cap:
 * the range rides the `audit_ts` index, and ordering by ts reads that index
 * back in reverse instead of sorting the whole table.
 *
 * `search` is one box over every readable column. A dropdown of the action
 * vocabulary would need a DISTINCT scan of the whole log on every open.
 *
 * @param {{ from?: string, to?: string, search?: string, limit?: number, offset?: number }} [filters]
 *        from/to are 'M/d/yyyy' and both ends are inclusive.
 * @returns {Promise<{ entries: Array, hasMore: boolean }>}
 */
export async function getAuditLog(filters) {
  await requirePermission('VIEW_AUDIT');
  const f = filters || {};
  const to = fromClientDate(f.to) || todayPH();
  const from = fromClientDate(f.from) || addDays(to, -6);
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);

  const args = [from, addDays(to, 1)];
  let where = `ts >= ? AND ts < ?`;
  const search = String(f.search == null ? '' : f.search).trim();
  if (search) {
    const like = `%${search}%`;
    where += ` AND (action LIKE ? OR table_name LIKE ? OR user_email LIKE ?
                    OR detail LIKE ? OR old_value LIKE ? OR new_value LIKE ?)`;
    args.push(like, like, like, like, like, like);
  }

  // One row past the page, so the client knows there is a next page without
  // a second COUNT(*) over the range.
  const rows = await q(
    `SELECT * FROM audit_log WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    ...args, limit + 1, offset,
  );
  const hasMore = rows.length > limit;

  return {
    entries: rows.slice(0, limit).map((r) => ({
      id: r.id,
      timestamp: toClientDateTime(r.ts),
      userEmail: r.user_email || '',
      action: r.action || '',
      detail: r.detail || '',
      tableName: r.table_name || '',
      rowId: numOrNull(r.row_id),
      oldValue: r.old_value == null ? '' : String(r.old_value),
      newValue: r.new_value == null ? '' : String(r.new_value),
    })),
    hasMore,
  };
}

/**
 * How the truck-type codes in a Rebisco route file (6WF, 6WC, 4WC) map to a
 * billing category. The category comes back as its NAME, as before.
 * @returns {Promise<Array<{ id, fileTypeCode, billingCategory, active }>>}
 */
export async function getRouteTypeMap() {
  const rows = await q(
    `SELECT m.*, c.name AS category_name FROM route_type_map m
     LEFT JOIN billing_categories c ON c.id = m.billing_category_id ORDER BY m.id`);
  return rows.map((r) => ({
    id: r.id,
    fileTypeCode: String(r.file_type_code || '').trim(),
    billingCategory: String(r.category_name || '').trim(),
    active: bool(r.active),
  }));
}

/** Uppercase File Type Code -> billing category name, active rows only. */
export async function getRouteTypeCategoryLookup() {
  const lookup = {};
  (await getRouteTypeMap()).forEach((m) => {
    if (m.active && m.fileTypeCode) lookup[m.fileTypeCode.toUpperCase()] = m.billingCategory;
  });
  return lookup;
}

/** @returns {Promise<Array<{ id, customerGroup, color, active }>>} */
export async function getCustomerGroupColors() {
  const rows = await q(`SELECT * FROM customer_group_colors ORDER BY id`);
  return rows.map((r) => ({
    id: r.id,
    customerGroup: String(r.customer_group || '').trim(),
    color: String(r.color || '').trim(),
    active: bool(r.active),
  }));
}

/** @returns {Promise<Array<{ id, prefix, companyName, lastSequenceNumber, sequenceWidth, active }>>} */
export async function getWaybillPrefixes() {
  const rows = await q(`SELECT * FROM waybill_prefixes ORDER BY id`);
  return rows.map((r) => ({
    id: r.id,
    prefix: r.prefix || '',
    companyName: r.company_name || '',
    lastSequenceNumber: Number(r.last_sequence_number) || 0,
    sequenceWidth: Number(r.sequence_width) || 0,
    active: bool(r.active),
  }));
}

/**
 * The default crew of every truck. Default Assignments folded into trucks, so
 * `id` IS the truck id (updateDefaultAssignment takes it as before).
 * @returns {Promise<Array<{ id, truckId, defaultDriverId, defaultHelperIds, notes }>>}
 */
export async function getDefaultAssignments() {
  const [trucks, helpers] = await Promise.all([
    q(`SELECT id, default_driver_id, roster_notes FROM trucks ORDER BY id`),
    q(`SELECT truck_id, employee_id FROM truck_default_helpers ORDER BY truck_id, slot`),
  ]);
  const byTruck = groupBy(helpers, 'truck_id');
  return trucks.map((t) => ({
    id: t.id,
    truckId: t.id,
    defaultDriverId: numOrNull(t.default_driver_id),
    defaultHelperIds: (byTruck[t.id] || []).map((h) => h.employee_id),
    notes: t.roster_notes || '',
  }));
}

/** @returns {Promise<Array<{ id, outletName, area, address, customerGroup, notes }>>} */
export async function getOutlets() {
  const rows = await q(`SELECT * FROM outlets ORDER BY id`);
  return rows.map((r) => ({
    id: r.id,
    outletName: r.outlet_name || '',
    area: r.area || '',
    address: r.address || '',
    customerGroup: r.customer_group || '',
    notes: r.notes || '',
  }));
}

// ============================================================
//  Trips & dispatch
// ============================================================

/** Maps a trips row (joined with outlets.area) plus its helper ids to the client shape. */
export function tripFromRow(r, helperIds) {
  return {
    id: r.id,
    tripDate: toClientDate(r.trip_date),
    billingDate: toClientDate(r.billing_date),
    foNumber: r.fo_number || '',
    foSplitSuffix: r.fo_split_suffix || '',
    outletId: numOrNull(r.outlet_id),
    area: r.area || '',
    quantity: numOrNull(r.quantity),
    cbm: round3(numOrNull(r.cbm)),
    restrictions: r.restrictions || '',
    truckId: numOrNull(r.truck_id),
    driverId: numOrNull(r.driver_id),
    helperIds: helperIds || [],
    truckBillingCategory: r.truck_billing_category || '',
    tripStatus: r.trip_status || 'Scheduled',
    parentTripId: numOrNull(r.parent_trip_id),
    source: r.source || 'Import',
    tier: numOrNull(r.tier),
    remarks: r.remarks || '',
    statusChangedBy: r.status_changed_by || '',
    statusChangedAt: toClientDateTime(r.status_changed_at),
    addedBy: r.added_by || '',
    addedAt: toClientDateTime(r.added_at),
    convoyGroup: r.convoy_group == null ? '' : String(r.convoy_group),
    sortOrder: numOrNull(r.sort_order),
    origin: r.origin || '',
  };
}

const TRIP_SELECT = `SELECT t.*, o.area AS area FROM trips t LEFT JOIN outlets o ON o.id = t.outlet_id`;

/** Helper ids for a set of trips: { tripId: [employeeId, …] } in slot order. */
async function helpersFor(tripIds) {
  if (!tripIds.length) return {};
  const marks = tripIds.map(() => '?').join(',');
  const rows = await q(
    `SELECT trip_id, employee_id FROM trip_helpers WHERE trip_id IN (${marks}) ORDER BY trip_id, slot`,
    ...tripIds);
  const out = {};
  rows.forEach((h) => { (out[h.trip_id] = out[h.trip_id] || []).push(h.employee_id); });
  return out;
}

/**
 * Trips whose Trip Date falls in the inclusive range; today when omitted.
 * @param {string} [dateFrom]  'M/d/yyyy'
 * @param {string} [dateTo]    'M/d/yyyy'
 */
export async function getTrips(dateFrom, dateTo) {
  const from = fromClientDate(dateFrom) || todayPH();
  const to = fromClientDate(dateTo) || todayPH();
  const rows = await q(`${TRIP_SELECT} WHERE t.trip_date BETWEEN ? AND ? ORDER BY t.id`, from, to);
  const helpers = await helpersFor(rows.map((r) => r.id));
  return rows.map((r) => tripFromRow(r, helpers[r.id]));
}

/**
 * The trips of one date with their waybill state. Display names are NOT
 * included — the client derives them from getBootData() via indexById().
 * @param {string} dateStr  'M/d/yyyy'
 * @returns {Promise<{ trips: Object[], date: string }>}
 */
export async function getDispatchBoardData(dateStr) {
  const day = fromClientDate(dateStr) || todayPH();
  const rows = await q(
    `SELECT t.*, o.area AS area, w.waybill_number AS wb_number, w.status AS wb_status
     FROM trips t
     LEFT JOIN outlets o ON o.id = t.outlet_id
     LEFT JOIN waybills w ON w.id = t.waybill_id
     WHERE t.trip_date = ? ORDER BY t.id`, day);
  const helpers = await helpersFor(rows.map((r) => r.id));
  const trips = rows.map((r) => Object.assign(tripFromRow(r, helpers[r.id]), {
    waybillSuggested: r.wb_status === 'Suggested' ? r.wb_number || '' : '',
    waybillConfirmed: r.wb_status === 'Confirmed' ? r.wb_number || '' : '',
    suggestedWaybillId: r.wb_status === 'Suggested' ? r.waybill_id : null,
  }));
  return { trips, date: dateStr };
}

/** Maps a waybills row (joined with one trip) to the client shape. */
export function waybillFromRow(r) {
  return {
    id: r.id,
    waybillNumber: r.waybill_number || '',
    prefixId: numOrNull(r.prefix_id),
    sequenceNumber: numOrNull(r.sequence_number),
    tripId: numOrNull(r.trip_id),
    foNumber: r.fo_number || '',
    waybillType: r.waybill_type || '',
    parentWaybillId: numOrNull(r.parent_waybill_id),
    status: r.status || '',
    locked: r.status === 'Confirmed',
    confirmedBy: r.confirmed_by || '',
    confirmedAt: toClientDateTime(r.confirmed_at),
  };
}

/**
 * The waybill of a trip, as a one-element array (empty when none). A trip
 * now holds at most one waybill; its stops share the row.
 * @param {number} tripId
 */
export async function getWaybillsForTrip(tripId) {
  const rows = await q(
    `SELECT w.*, t.id AS trip_id, t.fo_number FROM trips t
     JOIN waybills w ON w.id = t.waybill_id WHERE t.id = ?`, Number(tripId));
  return rows.map(waybillFromRow);
}

/**
 * How often a driver went to each outlet inside a rolling window. Feeds the
 * "assigned too often to the same outlet" warning.
 * @param {number} driverId
 * @param {number} [windowDays=21]
 * @param {number} [exceptTripId]  Leave this trip out (the caller adds it itself).
 * @returns {Promise<Array<{ outletId, count, outletName }>>}
 */
export async function getRouteFrequencyForDriver(driverId, windowDays, exceptTripId) {
  const cutoff = addDays(todayPH(), -(windowDays || 21));
  // The log is append-only: a driver swap on a trip adds a row and leaves the
  // old driver's row in place, and re-scheduling a trip logs it again. So a
  // trip counts once, and only for the driver it has now.
  const rows = await q(
    `SELECT f.outlet_id, COUNT(DISTINCT f.trip_id) AS n, o.outlet_name
     FROM route_frequency_log f
     JOIN trips t ON t.id = f.trip_id AND t.driver_id = f.driver_id
     LEFT JOIN outlets o ON o.id = f.outlet_id
     WHERE f.driver_id = ? AND t.trip_date >= ? AND t.id IS NOT ?
     GROUP BY f.outlet_id`, Number(driverId), cutoff, numOrNull(exceptTripId));
  return rows.map((r) => ({ outletId: r.outlet_id, count: r.n, outletName: r.outlet_name || '' }));
}

// ============================================================
//  Billing
// ============================================================

/**
 * The freight rate matrix, one object per (origin, area, truck type,
 * effective date) with its 25 bands under `bands` keyed by band label. `id`
 * is the lowest row id of that group; any band row's id resolves the group.
 * @param {string|string[]} [origin]  Case-insensitive warehouse filter.
 * @returns {Promise<Array<{ id, origin, area, truckType, effectiveDate, bands }>>}
 */
export async function getFreightRates(origin) {
  await requirePermission('VIEW_BILLING');
  const want = (Array.isArray(origin) ? origin : [origin]).filter(Boolean).map(_normArea);

  // A filtered read narrows in SQL, not in JS: the table holds about 36,750
  // rows and one origin is about a third of them. _normArea still does the
  // matching, so read the spellings first and pass the raw ones the filter hit.
  let rows;
  if (want.length) {
    const origins = (await q(`SELECT DISTINCT origin FROM freight_rates`))
      .map((r) => r.origin)
      .filter((o) => want.includes(_normArea(o)));
    if (!origins.length) return [];
    rows = await q(
      `SELECT * FROM freight_rates WHERE origin IN (${origins.map(() => '?').join(', ')}) ORDER BY id`,
      ...origins);
  } else {
    rows = await q(`SELECT * FROM freight_rates ORDER BY id`);
  }

  const groups = [];
  const byKey = {};
  rows.forEach((r) => {
    // Grouped on the raw area: "San Juan" and "SAN JUAN" are two matrix rows.
    const key = `${r.origin}|${r.area}|${r.truck_type}|${r.effective_date}`;
    let g = byKey[key];
    if (!g) {
      const bands = {};
      for (let i = 1; i <= FUEL_BAND_COUNT; i++) bands[_fuelBandLabel(i)] = null;
      g = byKey[key] = {
        id: r.id,
        origin: String(r.origin).trim(),
        area: String(r.area).trim(),
        truckType: String(r.truck_type).trim(),
        effectiveDate: toClientDate(r.effective_date),
        bands,
      };
      groups.push(g);
    }
    if (r.id < g.id) g.id = r.id;
    g.bands[_fuelBandLabel(r.band)] = numOrNull(r.rate);
  });
  return groups;
}

/** Distinct warehouse names in the matrix, sorted, one spelling per key. */
export async function getFreightRateOrigins() {
  const rows = await q(`SELECT DISTINCT origin FROM freight_rates`);
  const seen = {};
  rows.forEach((r) => {
    const v = String(r.origin || '').trim();
    if (v && !seen[_normArea(v)]) seen[_normArea(v)] = v;
  });
  return Object.values(seen).sort();
}

/** Diesel price history, newest effective date first. */
export async function getFuelPrices() {
  await requirePermission('VIEW_BILLING');
  const rows = await q(`SELECT * FROM fuel_prices ORDER BY effective_date DESC, id DESC`);
  return rows.map((r) => ({
    id: r.id,
    effectiveDate: toClientDate(r.effective_date),
    dieselPrice: numOrNull(r.diesel_price),
    addedBy: r.added_by || '',
    addedAt: toClientDateTime(r.added_at),
  }));
}

/** The manual money columns of the billing output, in display order. */
export async function getBillingChargeTypes() {
  const rows = await q(`SELECT * FROM billing_charge_types ORDER BY sort_order IS NULL, sort_order, id`);
  return rows.map((r) => ({
    id: r.id,
    label: String(r.label || '').trim(),
    sortOrder: numOrNull(r.sort_order),
    active: bool(r.active),
  }));
}

/**
 * Maps a billing_lines row (joined with waybills.waybill_number) plus its
 * charge rows to the client shape. `manualCharges` is { chargeTypeId: amount }
 * and `rateBand` the band label, as the sheet held them.
 * @param {Object}   r        billing_lines row with `waybill_number`
 * @param {Object[]} charges  billing_line_charges rows of this line
 */
export function billingLineFromRow(r, charges) {
  const manualCharges = {};
  (charges || []).forEach((c) => { manualCharges[c.charge_type_id] = Number(c.amount) || 0; });
  const line = {
    id: r.id,
    waybillNumber: String(r.waybill_number || ''),
    waybillId: numOrNull(r.waybill_id),
    tripDate: toClientDate(r.trip_date),
    billingDate: toClientDate(r.billing_date),
    origin: r.origin || '',
    plateNumber: r.plate_number || '',
    foNumber: r.fo_number || '',
    truckType: r.truck_type || '',
    area: r.area || '',
    drops: numOrNull(r.drops),
    cartons: numOrNull(r.cartons),
    dieselPrice: numOrNull(r.diesel_price),
    rateBand: r.rate_band ? _fuelBandLabel(r.rate_band) : '',
    haulingRate: numOrNull(r.hauling_rate) || 0,
    mano: numOrNull(r.mano) || 0,
    dropFee: numOrNull(r.drop_fee) || 0,
    manualCharges,
    total: numOrNull(r.total) || 0,
    billingNumber: r.billing_number || '',
    status: r.status || 'Not Billed',
    overrides: _parseJsonCell(r.overrides, []),
    notes: r.notes || '',
    addedBy: r.added_by || '',
    addedAt: toClientDateTime(r.added_at),
    updatedBy: r.updated_by || '',
    updatedAt: toClientDateTime(r.updated_at),
  };
  // The stored row, so a writer can compare before it writes. Non-enumerable:
  // JSON.stringify drops it, so the frozen client shape is unchanged.
  Object.defineProperty(line, 'row', { value: r });
  return line;
}

/** Stored billing lines by waybill id, in the client shape. */
export async function billingLinesByWaybill(waybillIds) {
  if (!waybillIds.length) return {};
  const marks = waybillIds.map(() => '?').join(',');
  const [lines, charges] = await Promise.all([
    q(`SELECT b.*, w.waybill_number FROM billing_lines b JOIN waybills w ON w.id = b.waybill_id
       WHERE b.waybill_id IN (${marks})`, ...waybillIds),
    q(`SELECT c.* FROM billing_line_charges c JOIN billing_lines b ON b.id = c.billing_line_id
       WHERE b.waybill_id IN (${marks})`, ...waybillIds),
  ]);
  const byLine = groupBy(charges, 'billing_line_id');
  const out = {};
  lines.forEach((l) => { out[l.waybill_id] = billingLineFromRow(l, byLine[l.id]); });
  return out;
}

/**
 * The VAT and withholding footer of a billing. Every Total is VAT inclusive,
 * so VAT is backed out of the gross and the 2% withholding applies to the net.
 */
export function _billingTotals(lines) {
  let totalVatInc = 0;
  (lines || []).forEach((l) => { totalVatInc += Number(l.total) || 0; });
  const lessVat = (totalVatInc / (1 + VAT_RATE)) * VAT_RATE;
  const netOfVat = totalVatInc - lessVat;
  return {
    lineCount: (lines || []).length,
    totalVatInc,
    lessVat,
    netOfVat,
    addVat: netOfVat * VAT_RATE,
    withholding: netOfVat * WITHHOLDING_RATE,
    amountDue: totalVatInc - netOfVat * WITHHOLDING_RATE,
  };
}

/** One row by id, or null — the read-back every writer returns. */
export async function rowById(table, id) {
  return await one(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
}
