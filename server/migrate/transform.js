// ============================================================
//  AngeLoyal OMS — server/migrate/transform.js
//  Sheet snapshot (the JSON from `npm run fetch-data`: one 2D array
//  per sheet, header row first) -> normalized table rows in insert
//  order. Shared by scripts/sheets-to-d1.mjs and test/harness.js, so
//  legacy sheet-shaped fixtures keep working. Rules: Docs/D1
//  Migration.md §3.1.
//
//  strict (the migration): an unknown category name, a waybill
//  number with mixed statuses, or an orphan parent that cannot be
//  dropped fails the run with the rows listed. Orphan trip FKs are
//  nulled and orphan log rows dropped, each reported.
//  lenient (the harness): fixtures are partial on purpose — unknown
//  categories are created and no FK is checked.
// ============================================================

import { _normArea, _fuelBandFromLabel, _parseJsonCell, FUEL_BAND_COUNT, _fuelBandLabel } from '../internals.js';
import { numOrNull, toPHTimestamp } from '../db.js';

const pad = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------
//  Cell normalizers
// ------------------------------------------------------------

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const int = (v) => { const n = numOrNull(typeof v === 'string' ? v.trim() : v); return n === null ? null : Math.trunc(n); };
const num = (v) => numOrNull(typeof v === 'string' ? v.trim() : v);
const strOrNull = (v) => { const s = str(v); return s === '' ? null : s; };

/** TRUE/FALSE/true/false/1/0 -> 1/0; blank -> dflt. */
function bool(v, dflt = 1) {
  if (v === '' || v === null || v === undefined) return dflt;
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE' || s === '1' || s === 'YES') return 1;
  if (s === 'FALSE' || s === '0' || s === 'NO') return 0;
  return dflt;
}

/**
 * Any date-ish cell -> 'YYYY-MM-DD HH:MM:SS' or null.
 *  - ISO string with a zone ('…Z'): an instant; shifted to Manila.
 *  - Date object: the fixture author's local wall time.
 *  - 'M/d/yyyy[ HH:mm[:ss]]' or 'YYYY-MM-DD[ HH:MM[:SS]]': taken as wall time.
 *  - number: an Excel serial (days since 1899-12-30), wall time.
 */
function timestamp(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : local(v);
  if (typeof v === 'number') return toPHTimestamp(Math.round((v - 25569) * 86400000) - 8 * 3600000); // serial = wall time
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/.exec(s)) && /(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return toPHTimestamp(s);
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
    return `${m[3]}-${pad(m[1])}-${pad(m[2])} ${pad(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}`;
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : local(d);
}

function local(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Any date-ish cell -> 'YYYY-MM-DD' or null. */
function date(v) {
  const t = timestamp(v);
  return t ? t.slice(0, 10) : null;
}

/** '7, 8,9' -> [7, 8, 9] */
function idList(v) {
  return str(v).split(',').map((s) => int(s)).filter((n) => n !== null);
}

// ------------------------------------------------------------
//  Sheet access
// ------------------------------------------------------------

/** A sheet as [{ 'Header': value }], or [] when absent. Header names are trimmed. */
function sheetRows(snapshot, name) {
  const data = snapshot[name];
  if (!Array.isArray(data) || data.length < 2) return [];
  const headers = data[0].map((h) => str(h));
  return data.slice(1).map((row) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = row[i] === undefined ? '' : row[i]; });
    return o;
  }).filter((o) => int(o.ID) !== null);
}

// ------------------------------------------------------------
//  Transform
// ------------------------------------------------------------

/**
 * @param {Object} snapshot  { 'Sheet Name': [[headers…], [row…], …] }
 * @param {{ strict?: boolean }} [opts]  strict defaults to true.
 * @returns {{ tables: Object<string, Object[]>, report: { counts, dropped: string[], warnings: string[] } }}
 * @throws {Error} in strict mode when a rule fails; message lists every failure.
 */
export function transform(snapshot, opts = {}) {
  const strict = opts.strict !== false;
  const errors = [];
  const dropped = [];
  const warnings = [];
  const counts = {};
  const rows = (name) => { const r = sheetRows(snapshot, name); counts[name] = r.length; return r; };

  const T = {
    users: [], billing_categories: [], route_type_map: [], customer_group_colors: [],
    waybill_prefixes: [], employees: [], trucks: [], truck_default_helpers: [], outlets: [],
    waybills: [], trips: [], trip_helpers: [], route_frequency_log: [], freight_rates: [],
    fuel_prices: [], billing_charge_types: [], billing_lines: [], billing_line_charges: [],
    audit_log: [],
  };

  // ---- users
  rows('Users').forEach((r) => T.users.push({
    id: int(r.ID), email: str(r.Email).toLowerCase(), display_name: str(r['Display Name']) || str(r.Email),
    role: str(r.Role), active: bool(r.Active),
  }));

  // ---- billing categories (+ name -> id, created on demand when lenient)
  const catId = {};
  rows('Billing Categories').forEach((r) => {
    const row = { id: int(r.ID), name: str(r.Name), active: bool(r.Active) };
    T.billing_categories.push(row);
    catId[row.name.toUpperCase()] = row.id;
  });
  let nextCatId = Math.max(0, ...T.billing_categories.map((c) => c.id)) + 1;
  const resolveCategory = (name, where) => {
    const key = str(name).toUpperCase();
    if (!key) return null;
    if (catId[key] !== undefined) return catId[key];
    if (strict) { errors.push(`${where}: unknown Billing Category "${str(name)}"`); return null; }
    const row = { id: nextCatId++, name: str(name), active: 1 };
    T.billing_categories.push(row);
    catId[key] = row.id;
    return row.id;
  };

  rows('Route Type Map').forEach((r) => T.route_type_map.push({
    id: int(r.ID), file_type_code: str(r['File Type Code']),
    billing_category_id: resolveCategory(r['Billing Category'], `Route Type Map ID ${r.ID}`),
    active: bool(r.Active),
  }));

  rows('Customer Group Colors').forEach((r) => T.customer_group_colors.push({
    id: int(r.ID), customer_group: str(r['Customer Group']), color: strOrNull(r.Color), active: bool(r.Active),
  }));

  rows('Waybill Prefixes').forEach((r) => {
    const rawLast = r['Last Sequence Number'];
    const rawWidth = int(r['Sequence Width']) || 0;
    T.waybill_prefixes.push({
      id: int(r.ID), prefix: str(r.Prefix), company_name: str(r['Company Name']),
      last_sequence_number: int(rawLast) || 0,
      // Rows written before the width column existed carry the old rule: the
      // stored value's own length ("0358" -> 4).
      sequence_width: rawWidth > 0 ? rawWidth : Math.max(1, str(rawLast).length),
      active: bool(r.Active),
    });
  });

  rows('Employees').forEach((r) => T.employees.push({
    id: int(r.ID), nickname: str(r.Nickname), first_name: strOrNull(r['First Name']),
    middle_name: strOrNull(r['Middle Name']), last_name: strOrNull(r['Last Name']),
    role: str(r.Role), active: r.Status !== undefined ? (str(r.Status).toLowerCase() === 'inactive' ? 0 : 1) : bool(r.Active),
  }));
  const employeeIds = new Set(T.employees.map((e) => e.id));

  // ---- trucks + default assignments
  const trucksById = {};
  rows('Trucks').forEach((r) => {
    const row = {
      id: int(r.ID), plate_number: str(r['Plate Number']), brand: strOrNull(r.Brand), type: strOrNull(r.Type),
      active: r.Status !== undefined ? (str(r.Status).toLowerCase() === 'inactive' ? 0 : 1) : bool(r.Active),
      billing_category_id: resolveCategory(r['Billing Category'], `Trucks ID ${r.ID}`),
      default_driver_id: null, roster_notes: null,
    };
    T.trucks.push(row);
    trucksById[row.id] = row;
  });
  rows('Default Assignments').forEach((r) => {
    const truck = trucksById[int(r['Truck ID'])];
    if (!truck) { dropped.push(`Default Assignments ID ${r.ID}: truck ${str(r['Truck ID'])} not found`); return; }
    truck.default_driver_id = int(r['Default Driver ID']);
    truck.roster_notes = strOrNull(r.Notes);
    idList(r['Default Helper IDs']).slice(0, 3).forEach((employee_id, i) => {
      T.truck_default_helpers.push({ truck_id: truck.id, employee_id, slot: i + 1 });
    });
  });

  rows('Outlets').forEach((r) => T.outlets.push({
    id: int(r.ID), outlet_name: str(r['Outlet Name']), area: strOrNull(r.Area), address: strOrNull(r.Address),
    customer_group: strOrNull(r['Customer Group']), notes: strOrNull(r.Notes),
    created_at: timestamp(r['Created At']) || '1970-01-01 00:00:00',
  }));
  const outletIds = new Set(T.outlets.map((o) => o.id));

  // ---- waybills: one row per load (number + FO). Lowest ID kept; every
  //      original Trip ID maps to it through trips.waybill_id.
  const wbRows = rows('Waybills');
  const prefixIds = new Set(T.waybill_prefixes.map((p) => p.id));
  const keptIdOf = {};        // original waybill id -> kept id
  const waybillOfTrip = {};   // trip id -> kept waybill id
  const groups = {};
  wbRows.forEach((r) => {
    const key = `${str(r['Waybill Number']).toUpperCase()}|${str(r['FO Number'])}`;
    (groups[key] = groups[key] || []).push(r);
  });
  Object.values(groups).forEach((g) => {
    g.sort((a, b) => int(a.ID) - int(b.ID));
    const statuses = new Set(g.map((r) => str(r.Status)));
    if (statuses.size > 1) {
      errors.push(`Waybills "${str(g[0]['Waybill Number'])}" FO ${str(g[0]['FO Number'])}: mixed statuses on IDs ${g.map((r) => r.ID).join(', ')}`);
    }
    const head = g[0];
    const confirmed = g.find((r) => str(r.Status) === 'Confirmed' && str(r['Confirmed By'])) || g.find((r) => str(r.Status) === 'Confirmed');
    const id = int(head.ID);
    if (strict && !prefixIds.has(int(head['Prefix ID']))) {
      errors.push(`Waybills ID ${head.ID}: Prefix ID ${str(head['Prefix ID'])} not found`);
    }
    T.waybills.push({
      id,
      waybill_number: str(head['Waybill Number']),
      prefix_id: int(head['Prefix ID']),
      sequence_number: int(head['Sequence Number']) || 0,
      waybill_type: str(head['Waybill Type']) || 'Regular',
      parent_waybill_id: int(head['Parent Waybill ID']),   // remapped below
      status: str(head.Status) || 'Suggested',
      confirmed_by: confirmed ? strOrNull(confirmed['Confirmed By']) : null,
      confirmed_at: confirmed ? timestamp(confirmed['Confirmed At']) : null,
    });
    g.forEach((r) => {
      keptIdOf[int(r.ID)] = id;
      const tripId = int(r['Trip ID']);
      if (tripId !== null) waybillOfTrip[tripId] = id;
    });
  });
  T.waybills.forEach((w) => {
    if (w.parent_waybill_id === null) return;
    const kept = keptIdOf[w.parent_waybill_id];
    if (kept === undefined) {
      if (strict) dropped.push(`Waybills ID ${w.id}: parent waybill ${w.parent_waybill_id} not found — parent cleared`);
      w.parent_waybill_id = strict ? null : w.parent_waybill_id;
    } else {
      w.parent_waybill_id = kept;
    }
  });
  T.waybills.sort((a, b) => a.id - b.id);

  // ---- trips
  const tripRows = rows('Trips');
  const tripIds = new Set(tripRows.map((r) => int(r.ID)));
  const fk = (value, set, label, where) => {
    const id = int(value);
    if (id === null || !strict || set.has(id)) return id;
    dropped.push(`${where}: ${label} ${id} not found — cleared`);
    return null;
  };
  tripRows.forEach((r) => {
    const id = int(r.ID);
    const where = `Trips ID ${id}`;
    const tripDate = date(r['Trip Date']);
    const billingDate = date(r['Billing Date']) || tripDate;
    if (!tripDate) { errors.push(`${where}: blank Trip Date`); return; }
    T.trips.push({
      id,
      trip_date: tripDate,
      billing_date: billingDate,
      fo_number: strOrNull(r['FO Number']),
      fo_split_suffix: strOrNull(r['FO Split Suffix']),
      outlet_id: fk(r['Outlet ID'], outletIds, 'outlet', where),
      quantity: int(r.Quantity),
      cbm: num(r.CBM),
      restrictions: strOrNull(r.Restrictions),
      truck_id: fk(r['Truck ID'], new Set(Object.keys(trucksById).map(Number)), 'truck', where),
      driver_id: fk(r['Driver ID'], employeeIds, 'driver', where),
      truck_billing_category: strOrNull(r['Truck Billing Category']),
      trip_status: str(r['Trip Status']) || 'Scheduled',
      parent_trip_id: fk(r['Parent Trip ID'], tripIds, 'parent trip', where),
      source: str(r.Source) || 'Import',
      tier: int(r.Tier),
      remarks: strOrNull(r.Remarks),
      status_changed_by: strOrNull(r['Status Changed By']),
      status_changed_at: timestamp(r['Status Changed At']),
      added_by: str(r['Added By']),
      added_at: timestamp(r['Added At']) || `${tripDate} 00:00:00`,
      convoy_group: strOrNull(r['Convoy Group']),
      sort_order: int(r['Sort Order']),
      origin: strOrNull(r.Origin),
      waybill_id: waybillOfTrip[id] === undefined ? null : waybillOfTrip[id],
    });
    idList(r['Helper IDs']).slice(0, 3).forEach((employee_id, i) => {
      if (strict && !employeeIds.has(employee_id)) { dropped.push(`${where}: helper ${employee_id} not found — dropped`); return; }
      T.trip_helpers.push({ trip_id: id, employee_id, slot: i + 1 });
    });
  });
  T.trips.sort((a, b) => a.id - b.id);
  if (strict) {
    wbRows.forEach((r) => {
      const tripId = int(r['Trip ID']);
      if (tripId !== null && !tripIds.has(tripId)) errors.push(`Waybills ID ${r.ID}: Trip ID ${tripId} not found`);
    });
  }

  rows('Route Frequency Log').forEach((r) => {
    const row = { id: int(r.ID), trip_id: int(r['Trip ID']), driver_id: int(r['Driver ID']), outlet_id: int(r['Outlet ID']) };
    if (strict && (!tripIds.has(row.trip_id) || !employeeIds.has(row.driver_id) || !outletIds.has(row.outlet_id))) {
      dropped.push(`Route Frequency Log ID ${row.id}: trip ${row.trip_id} / driver ${row.driver_id} / outlet ${row.outlet_id} not found — dropped`);
      return;
    }
    T.route_frequency_log.push(row);
  });

  // ---- freight rates: 25 band columns -> up to 25 rows
  let rateId = 1;
  const seenRate = {};
  rows('Freight Rates').forEach((r) => {
    const eff = date(r['Effective Date']);
    if (!eff) { errors.push(`Freight Rates ID ${r.ID}: blank Effective Date`); return; }
    // The same (origin, area, type, date) twice is one block imported twice:
    // the first wins, as _indexRates did.
    const key = [str(r.Origin), str(r.Area), str(r['Truck Type']), eff].join('|');
    if (seenRate[key]) { dropped.push(`Freight Rates ID ${r.ID}: duplicate of ID ${seenRate[key]} (${key}) — dropped`); return; }
    seenRate[key] = r.ID;
    for (let band = 1; band <= FUEL_BAND_COUNT; band++) {
      const rate = num(r[_fuelBandLabel(band)]);
      if (rate === null) continue;
      T.freight_rates.push({
        id: rateId++, origin: str(r.Origin), area: str(r.Area), area_key: _normArea(r.Area),
        truck_type: str(r['Truck Type']), effective_date: eff, band, rate,
      });
    }
  });

  rows('Fuel Prices').forEach((r) => {
    const eff = date(r['Effective Date']);
    const price = num(r['Diesel Price']);
    if (!eff || price === null) { errors.push(`Fuel Prices ID ${r.ID}: blank date or price`); return; }
    T.fuel_prices.push({
      id: int(r.ID), effective_date: eff, diesel_price: price,
      added_by: str(r['Added By']) || 'unknown', added_at: timestamp(r['Added At']) || `${eff} 00:00:00`,
    });
  });

  rows('Billing Charge Types').forEach((r) => T.billing_charge_types.push({
    id: int(r.ID), label: str(r.Label), sort_order: int(r['Sort Order']), active: bool(r.Active),
  }));

  // ---- billing lines
  const waybillByNumber = {};
  T.waybills.forEach((w) => { const k = w.waybill_number.toUpperCase(); if (!waybillByNumber[k]) waybillByNumber[k] = w.id; });
  rows('Billing Lines').forEach((r) => {
    const id = int(r.ID);
    const oldWb = int(r['Waybill ID']);
    const waybillId = oldWb !== null && keptIdOf[oldWb] !== undefined ? keptIdOf[oldWb]
      : waybillByNumber[str(r['Waybill Number']).toUpperCase()];
    if (waybillId === undefined) {
      if (strict) { errors.push(`Billing Lines ID ${id}: waybill "${str(r['Waybill Number'])}" not found`); return; }
    }
    const tripDate = date(r['Trip Date']);
    T.billing_lines.push({
      id, waybill_id: waybillId === undefined ? oldWb : waybillId,
      trip_date: tripDate, billing_date: date(r['Billing Date']) || tripDate,
      origin: strOrNull(r.Origin), plate_number: strOrNull(r['Plate Number']), fo_number: strOrNull(r['FO Number']),
      truck_type: strOrNull(r['Truck Type']), area: strOrNull(r.Area),
      drops: int(r.Drops) || 0, cartons: int(r.Cartons) || 0,
      diesel_price: num(r['Diesel Price']), rate_band: _fuelBandFromLabel(r['Rate Band']),
      hauling_rate: num(r['Hauling Rate']) || 0, mano: num(r.Mano) || 0, drop_fee: num(r['Drop Fee']) || 0,
      total: num(r.Total) || 0, billing_number: strOrNull(r['Billing Number']),
      status: str(r.Status) || 'Not Billed',
      overrides: strOrNull(r.Overrides), notes: strOrNull(r.Notes),
      added_by: str(r['Added By']) || 'unknown', added_at: timestamp(r['Added At']) || `${tripDate} 00:00:00`,
      updated_by: strOrNull(r['Updated By']), updated_at: timestamp(r['Updated At']),
    });
    const charges = _parseJsonCell(r['Manual Charges'], {});
    Object.keys(charges).forEach((k) => {
      const amount = num(charges[k]);
      const typeId = int(k);
      if (amount === null || amount === 0 || typeId === null) return;
      T.billing_line_charges.push({ billing_line_id: id, charge_type_id: typeId, amount });
    });
  });

  rows('Audit Log').forEach((r) => T.audit_log.push({
    id: int(r.ID), ts: timestamp(r.Timestamp) || '1970-01-01 00:00:00', user_email: strOrNull(r.User),
    action: str(r.Action), detail: strOrNull(r.Detail), table_name: strOrNull(r.Table),
    row_id: int(r['Row ID']), old_value: strOrNull(r['Old Value']), new_value: strOrNull(r['New Value']),
  }));

  if (errors.length) {
    const err = new Error(`Transform failed:\n  - ${errors.join('\n  - ')}`);
    err.errors = errors;
    throw err;
  }
  return { tables: T, report: { counts, dropped, warnings } };
}
