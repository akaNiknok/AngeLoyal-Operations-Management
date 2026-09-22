// ============================================================
//  AngeLoyal OMS — server/writers/import.js
//  Rebisco route-file import (DataWriters.gs importRouteFile,
//  Internals.gs _resolveOrCreateOutlet).
//
//  importRouteFile stays one in-memory pass over the parsed rows —
//  masters (trucks, defaults, outlets, the date's existing trips) are
//  read once up front — then a single atomic batch() of outlet, trip
//  and trip_helpers inserts. A query per row would blow the 10ms CPU
//  budget on a 40+ row file.
// ============================================================

import { requirePermission } from '../rbac.js';
import { currentEmail } from '../ctx.js';
import { one, run, stmt, batch, numOrNull, nowPH, fromClientDate } from '../db.js';
import { _auditLog, _auditLogBatch, helperSlots } from '../internals.js';
import { getDefaultAssignments, getTrucks, getRouteTypeCategoryLookup, getOutlets, getTrips } from '../readers.js';

/**
 * Finds an outlet by name (case-insensitive, via the column's own
 * COLLATE NOCASE) or creates one. A standalone helper for a single
 * lookup outside a bulk import — importRouteFile below does its own
 * in-memory version instead, to avoid a query per row.
 * @param {string} outletName
 * @param {string} [area]
 * @param {string} [address]
 * @returns {Promise<number|''>}
 */
export async function _resolveOrCreateOutlet(outletName, area, address) {
  if (!outletName) return '';
  const name = String(outletName).trim();

  const existing = await one(`SELECT id FROM outlets WHERE outlet_name = ?`, name);
  if (existing) return existing.id;

  const res = await run(
    `INSERT INTO outlets (outlet_name, area, address, customer_group, notes, created_at)
     VALUES (?, ?, ?, '', '', ?)`,
    name, area || '', address || '', nowPH());
  await _auditLog('OUTLET_CREATE', 'outlets', res.last_row_id, '', name);
  return res.last_row_id;
}

/**
 * Imports a parsed Rebisco route file for one trip date (DataWriters.gs).
 * Every row lands 'Prepping' with no waybill — waybills are suggested
 * later, at day promotion (markDayScheduled).
 *
 * An FO already on the date is a re-import and is skipped whole: the
 * transport can lose the response after the write lands, and a
 * dispatcher's retry used to triple the file.
 *
 * One route file covers one Rebisco warehouse, so `origin` is stamped on
 * every trip the file creates — Billing reads it back to pick the right
 * sheet of the freight rate matrix.
 *
 * @param {string}   tripDate  'M/d/yyyy'
 * @param {Object[]} rowData   Parsed route rows (outletName, foNumber, area,
 *                             quantity, cbm, restrictions, tier, convoyGroup,
 *                             slots: [{ type, count }]).
 * @param {string}   [origin]  Warehouse the file departs from (e.g. 'TANZA').
 * @returns {Promise<{ success: boolean, imported: number, skipped: number,
 *   duplicates: number, errors: string[], newOutlets: Object[] }>}
 */
export async function importRouteFile(tripDate, rowData, origin) {
  await requirePermission('ADD_MANUAL_TRIP');
  origin = String(origin || '').trim();
  const day = fromClientDate(tripDate);

  try {
    if (!day) throw new Error('Trip date is required, in M/d/yyyy format.');
    const [defaults, trucks, typeToCategory, outlets, existingTrips] = await Promise.all([
      getDefaultAssignments(), getTrucks(), getRouteTypeCategoryLookup(), getOutlets(),
      getTrips(tripDate, tripDate),
    ]);

    // Pool of available (active) trucks per uppercased billing category,
    // ordered by ID so allocation is deterministic.
    const trucksByCategory = {};
    trucks.filter((t) => t.active).forEach((t) => {
      const cat = String(t.billingCategory || '').toUpperCase();
      (trucksByCategory[cat] = trucksByCategory[cat] || []).push(t);
    });
    Object.keys(trucksByCategory).forEach((c) => trucksByCategory[c].sort((a, b) => a.id - b.id));

    const defaultByTruck = {};
    defaults.forEach((d) => { defaultByTruck[d.truckId] = d; });

    // Trucks already committed on this date (existing trips) — never
    // double-book. Same pass finds the highest convoy token already used on
    // the date, and which FOs the date already holds (re-import dedupe).
    const usedTruckIds = {};
    const existingFOs = {};
    let convoyTokenBase = 0;
    existingTrips.forEach((t) => {
      if (t.truckId) usedTruckIds[t.truckId] = true;
      const cg = Number(t.convoyGroup);
      if (cg > convoyTokenBase) convoyTokenBase = cg;
      const fo = String(t.foNumber || '').trim();
      if (fo) existingFOs[fo] = true;
    });

    // Resolve a file type code (e.g. "4WC") -> billing category -> next free
    // truck. Returns { truck, category }; truck is null when none are free,
    // but the required category is still reported for the trip's snapshot.
    const allocateTruck = (typeCode) => {
      const code = String(typeCode || '').toUpperCase();
      const category = code ? (typeToCategory[code] || code) : '';
      const pool = trucksByCategory[String(category).toUpperCase()] || [];
      let chosen = null;
      for (let i = 0; i < pool.length; i++) {
        if (!usedTruckIds[pool[i].id]) { chosen = pool[i]; break; }
      }
      if (chosen) usedTruckIds[chosen.id] = true;
      return { truck: chosen, category };
    };

    const email = currentEmail() || 'unknown';
    const now = nowPH();

    // No ids are computed here. D1 runs each batch whole, but another request
    // can write between the reads above and the batch below, so an id taken
    // from MAX(id) could already be gone. SQLite assigns every id: a new
    // outlet is found by its unique name, and a trip's helpers by MAX(id)
    // right after that trip's insert, inside the same atomic batch.

    // --- Outlets: resolved in memory, extended as new ones show up ---
    // { id } for an outlet that exists, { name } for one this file adds.
    const outletByName = {};
    outlets.forEach((o) => { outletByName[o.outletName.trim().toLowerCase()] = { id: o.id }; });
    const newOutletStmts = [];
    // Returned to the client so it can merge these into its cached outlet
    // list without a full reboot. The ids are filled in after the batch.
    const newOutlets = [];

    const resolveOutlet = (rd) => {
      if (!rd.outletName) return null;
      const nameLower = rd.outletName.trim().toLowerCase();
      if (outletByName[nameLower]) return outletByName[nameLower];
      const name = rd.outletName.trim();
      const area = rd.area || '';
      const address = rd.address || '';
      const customerGroup = rd.customer || '';
      // DO NOTHING: another request may have added the same outlet since the
      // read above. The trips then attach to that row by name.
      newOutletStmts.push(stmt(
        `INSERT INTO outlets (outlet_name, area, address, customer_group, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (outlet_name) DO NOTHING RETURNING id`,
        name, area, address, customerGroup, '', now));
      newOutlets.push({ id: null, outletName: name, area, address, customerGroup, notes: '' });
      return (outletByName[nameLower] = { name });
    };

    const tripStmts = [];   // each trip insert, followed by its helper inserts
    const tripAt = [];      // the index in tripStmts of each trip insert
    const auditEntries = [];
    let imported = 0;
    let skipped = 0;
    let duplicates = 0;
    const errors = [];

    // Creates one trip row. No waybill yet — imported trips land in
    // 'Prepping'; markDayScheduled suggests the waybills once the
    // dispatcher promotes the day.
    const emitTrip = (rd, outlet, slotTruck, category) => {
      const truckId = slotTruck ? slotTruck.id : null;
      const def = slotTruck ? defaultByTruck[slotTruck.id] : null;
      const driverId = def ? def.defaultDriverId : null;
      const helperIds = def ? def.defaultHelperIds : [];
      const byName = !!(outlet && outlet.name);

      tripAt.push(tripStmts.length);
      tripStmts.push(stmt(
        `INSERT INTO trips (
           trip_date, billing_date, fo_number, fo_split_suffix, outlet_id,
           quantity, cbm, restrictions, truck_id, driver_id, truck_billing_category,
           trip_status, parent_trip_id, source, tier, remarks,
           status_changed_by, status_changed_at, added_by, added_at,
           convoy_group, sort_order, origin
         ) VALUES (?,?,?,?,${byName ? '(SELECT id FROM outlets WHERE outlet_name = ?)' : '?'},
           ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        day, day, rd.foNumber || '', '', outlet ? (byName ? outlet.name : outlet.id) : null,
        numOrNull(rd.quantity), numOrNull(rd.cbm), rd.restrictions || '', truckId, driverId, category || '',
        'Prepping', null, 'Import', numOrNull(rd.tier), '',
        '', null, email, now,
        rd.convoyGroup ? String(convoyTokenBase + Number(rd.convoyGroup)) : '', null, origin));

      helperSlots(helperIds).forEach((h) => {
        tripStmts.push(stmt(
          `INSERT INTO trip_helpers (trip_id, employee_id, slot) VALUES ((SELECT MAX(id) FROM trips), ?, ?)`,
          h.employee_id, h.slot));
      });

      auditEntries.push({ foNumber: rd.foNumber || '', outlet });
      imported++;
    };

    // --- Group rows by FO (first-seen order). Rows with no FO each stand alone. ---
    const groups = [];
    const groupByFO = {};
    rowData.forEach((rd) => {
      if (!rd.foNumber && !rd.outletName) { skipped++; return; }
      const key = rd.foNumber || null;
      if (key && groupByFO[key]) {
        groupByFO[key].rows.push(rd);
      } else {
        const g = { foNumber: rd.foNumber || '', rows: [rd] };
        groups.push(g);
        if (key) groupByFO[key] = g;
      }
    });

    groups.forEach((g) => {
      try {
        // Idempotency: an FO already on the date is a re-import, not new
        // work — skip it. Blank-FO rows have no key, so they are never
        // deduped.
        const foKey = String(g.foNumber || '').trim();
        if (foKey && existingFOs[foKey]) {
          duplicates += g.rows.length;
          skipped += g.rows.length;
          return;
        }
        if (foKey) existingFOs[foKey] = true;

        // Expand truck slots: one entry per truck needed across the FO's rows.
        const slotTypes = [];
        g.rows.forEach((rd) => (rd.slots || []).forEach((s) => {
          for (let k = 0; k < (s.count || 1); k++) slotTypes.push(s.type);
        }));
        // FOs with no type column still get one (possibly unassigned) slot
        // so their outlet rows still produce trips.
        if (slotTypes.length === 0) slotTypes.push('');

        const slots = slotTypes.map((type) => allocateTruck(type));
        const primary = slots[0];

        // Primary truck visits every outlet row — one multi-drop load.
        g.rows.forEach((rd) => emitTrip(rd, resolveOutlet(rd), primary.truck, primary.category));

        // Additional trucks (split load) ride the first outlet.
        const firstRow = g.rows[0];
        const firstOutlet = resolveOutlet(firstRow);
        for (let s = 1; s < slots.length; s++) {
          emitTrip(firstRow, firstOutlet, slots[s].truck, slots[s].category);
        }
      } catch (rowErr) {
        errors.push(`FO ${g.foNumber || '(none)'}: ${rowErr.message}`);
        skipped++;
      }
    });

    const res = await batch([...newOutletStmts, ...tripStmts]);
    const tripRes = res.slice(newOutletStmts.length);

    for (let i = 0; i < newOutlets.length; i++) {
      const row = res[i].results[0];
      // No row back: a concurrent request added the outlet first.
      newOutlets[i].id = row ? row.id
        : (await one(`SELECT id FROM outlets WHERE outlet_name = ?`, newOutlets[i].outletName)).id;
    }
    const outletIdOf = (o) => (!o ? null
      : o.id || newOutlets.find((n) => n.outletName.toLowerCase() === o.name.toLowerCase()).id);

    await _auditLogBatch(auditEntries.map((a, i) => ({
      action: 'TRIP_CREATE', table: 'trips', rowId: tripRes[tripAt[i]].results[0].id, oldValue: '',
      newValue: JSON.stringify({ foNumber: a.foNumber, outletId: outletIdOf(a.outlet), tripDate }),
    })));

    return { success: true, imported, skipped, duplicates, errors, newOutlets };
  } catch (e) {
    return { success: false, imported: 0, skipped: 0, duplicates: 0, errors: [e.message] };
  }
}
