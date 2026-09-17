// ============================================================
//  AngeLoyal OMS — server/writers/trips.js
//  Trip lifecycle: create, edit, bulk status, reorder, convoy,
//  delete, day promotion, and the carry-over spawn (DataWriters.gs,
//  Internals.gs _createCarryoverTrip / _appendRouteFrequency /
//  _resolveBillingCategory).
//
//  A trip points at at most one waybill row now (trips.waybill_id),
//  so the waybill-suggestion helpers below come straight from
//  writers/waybills.js — there is no more per-stop scan to dedupe.
// ============================================================

import { currentEmail } from '../ctx.js';
import {
  q, one, run, batch, stmt, numOrNull, nowPH, todayPH,
  fromClientDate, toClientDate, toClientDateTime,
} from '../db.js';
import { requirePermission } from '../rbac.js';
import { _auditLog, _auditLogBatch, helperSlots, nextBusinessDay } from '../internals.js';
import { getWaybillPrefixes, getWaybillsForTrip, getRouteFrequencyForDriver } from '../readers.js';
import {
  _createSuggestedWaybill, _suggestWaybillsForGroups,
  _suggestWaybillForScheduledTrip, _deleteSuggestedWaybillsForTrip,
} from './waybills.js';
import { _resolveOrCreateOutlet } from './import.js';

// ------------------------------------------------------------
//  Small internal helpers (Internals.gs)
// ------------------------------------------------------------

/**
 * The billing category NAME assigned to a truck, or '' when the truck has
 * none or does not exist (Internals.gs _resolveBillingCategory).
 * @param {number|string|null} truckId
 * @returns {Promise<string>}
 */
export async function _resolveBillingCategory(truckId) {
  if (!truckId) return '';
  const row = await one(
    `SELECT c.name AS category_name FROM trucks t
     LEFT JOIN billing_categories c ON c.id = t.billing_category_id
     WHERE t.id = ?`, Number(truckId));
  return (row && row.category_name) || '';
}

/**
 * Appends one Route Frequency Log row. Best-effort, like Internals.gs's
 * version — a logging failure must never sink the trip write that earned it.
 * The table carries no trip_date column (§3 of the migration plan): the
 * 21-day window reader joins trips(trip_date) instead.
 * @param {number} tripId
 * @param {number} driverId
 * @param {number} outletId
 */
export async function _appendRouteFrequency(tripId, driverId, outletId) {
  try {
    await run(
      `INSERT INTO route_frequency_log (trip_id, driver_id, outlet_id) VALUES (?, ?, ?)`,
      Number(tripId), Number(driverId), Number(outletId));
  } catch (_) {
    // Best-effort; never propagate.
  }
}

/**
 * Creates the next-business-day copy of a trip that just went Redeliver,
 * Foul Trip - For Redeliver, or Backlog, and suggests its waybill. A
 * Backlog trip never left the yard, so it donates no waybill number and
 * re-enters planning as Prepping instead of Scheduled.
 * @param {number} originalTripId
 * @param {string} statusReason  The status that triggered the carry-over.
 * @returns {Promise<number>} The new trip id.
 */
export async function _createCarryoverTrip(originalTripId, statusReason) {
  const row = await one(`SELECT * FROM trips WHERE id = ?`, Number(originalTripId));
  if (!row) throw new Error(`Trip ID ${originalTripId} not found.`);
  const helperIds = (await q(
    `SELECT employee_id FROM trip_helpers WHERE trip_id = ? ORDER BY slot`, row.id))
    .map((h) => h.employee_id);

  const isBacklog = statusReason === 'Backlog';
  const nextDay = nextBusinessDay(row.trip_date);
  const waybillType = statusReason === 'Redeliver' ? 'Redeliver' : 'Foul Trip';

  // The original trip's own waybill (if any) donates its number/prefix for
  // the -R/-FT suffix. Backlog has none: it re-enters planning fresh.
  const wb = (!isBacklog && row.waybill_id)
    ? await one(`SELECT * FROM waybills WHERE id = ?`, row.waybill_id)
    : null;
  const prefixId = wb ? wb.prefix_id : null;
  const parentWbId = wb ? wb.id : null;

  const email = currentEmail() || 'unknown';
  const now = nowPH();

  // The trip and its crew land together: a carry-over without its helpers
  // would put the wrong crew on tomorrow's board.
  const [ins] = await batch([stmt(
    `INSERT INTO trips (
       trip_date, billing_date, fo_number, fo_split_suffix, outlet_id,
       quantity, cbm, restrictions, truck_id, driver_id, truck_billing_category,
       trip_status, parent_trip_id, source, tier, remarks,
       status_changed_by, status_changed_at, added_by, added_at,
       convoy_group, sort_order, origin
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    nextDay, row.billing_date, row.fo_number || '', '', row.outlet_id,
    row.quantity, row.cbm, row.restrictions, row.truck_id, row.driver_id, row.truck_billing_category,
    isBacklog ? 'Prepping' : 'Scheduled', row.id, 'Carry-over', row.tier,
    `Carried over from Trip ${row.id} (${statusReason})`,
    '', null, email, now, '', null, row.origin),
    ...helperSlots(helperIds).map((h) => stmt(
      `INSERT INTO trip_helpers (trip_id, employee_id, slot) VALUES ((SELECT MAX(id) FROM trips), ?, ?)`,
      h.employee_id, h.slot)),
  ]);
  const newTripId = ins.results[0].id;

  // Joins a sibling stop's already-Suggested row of the same type when one
  // exists (a merged load carrying over one stop at a time), else reserves
  // a fresh number (or none, for Backlog, since prefixId is null there).
  await _suggestWaybillForScheduledTrip(
    newTripId, row.fo_number || '', row.truck_id, nextDay, prefixId, waybillType, parentWbId);

  if (row.driver_id && row.outlet_id) await _appendRouteFrequency(newTripId, row.driver_id, row.outlet_id);

  await _auditLog('TRIP_CREATE', 'trips', newTripId, '',
    JSON.stringify({ parentTripId: row.id, reason: statusReason, tripDate: toClientDate(nextDay) }));

  return newTripId;
}

// ------------------------------------------------------------
//  Client-callable writers (DataWriters.gs)
// ------------------------------------------------------------

/**
 * Creates a new trip row, usually from a manual dispatch-board entry.
 * Auto-seeds an unknown outlet, snapshots the truck's billing category,
 * optionally suggests a waybill, and logs route frequency once the trip is
 * out of Prepping.
 * @param {Object} tripData  Fields matching the trips columns (camelCase).
 * @returns {Promise<{ success: true, tripId: number, waybillSuggested: string }
 *   | { success: false, error: string }>}
 */
export async function createTrip(tripData) {
  await requirePermission('ADD_MANUAL_TRIP');
  try {
    const outletId = await _resolveOrCreateOutlet(tripData.outletName, tripData.area, tripData.address || '');
    const truckBillingCategory = (await _resolveBillingCategory(tripData.truckId))
      || tripData.truckBillingCategory || '';

    const tripDate = fromClientDate(tripData.tripDate) || todayPH();
    const billingDate = fromClientDate(tripData.billingDate) || tripDate;
    const tripStatus = tripData.tripStatus || 'Scheduled';
    const email = currentEmail() || 'unknown';
    const now = nowPH();
    const helperIdsRaw = Array.isArray(tripData.helperIds)
      ? tripData.helperIds : String(tripData.helperIds || '').split(',');

    const { last_row_id: tripId } = await run(
      `INSERT INTO trips (
         trip_date, billing_date, fo_number, fo_split_suffix, outlet_id,
         quantity, cbm, restrictions, truck_id, driver_id, truck_billing_category,
         trip_status, parent_trip_id, source, tier, remarks,
         status_changed_by, status_changed_at, added_by, added_at,
         convoy_group, sort_order, origin
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tripDate, billingDate, tripData.foNumber || '', tripData.foSplitSuffix || '', numOrNull(outletId),
      numOrNull(tripData.quantity), numOrNull(tripData.cbm), tripData.restrictions || '',
      numOrNull(tripData.truckId), numOrNull(tripData.driverId), truckBillingCategory,
      tripStatus, numOrNull(tripData.parentTripId), tripData.source || 'Manual', numOrNull(tripData.tier),
      tripData.remarks || '', '', null, email, now,
      tripData.convoyGroup || '', null, tripData.origin || '');

    if (helperIdsRaw.length) {
      await batch(helperSlots(helperIdsRaw).map((h) => stmt(
        `INSERT INTO trip_helpers (trip_id, employee_id, slot) VALUES (?, ?, ?)`,
        tripId, h.employee_id, h.slot)));
    }

    let waybillSuggested = '';
    if (tripData.prefixId) {
      const wb = await _createSuggestedWaybill(tripId, tripData.prefixId, tripData.foNumber || '', 'Regular', null);
      waybillSuggested = wb.waybillNumber;
    }

    if (tripStatus !== 'Prepping' && tripData.driverId && outletId) {
      await _appendRouteFrequency(tripId, tripData.driverId, outletId);
    }

    await _auditLog('TRIP_CREATE', 'trips', tripId, '',
      JSON.stringify({ foNumber: tripData.foNumber, outletId, tripDate: toClientDate(tripDate) }));

    return { success: true, tripId, waybillSuggested };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Combined trip-edit endpoint: reassigns truck/driver/helpers and/or updates
 * trip status + remarks in one pass.
 * - A driver change is checked against the Route Frequency Log and logged.
 * - A status of 'Foul Trip - For Redeliver', 'Redeliver' or 'Backlog' spawns
 *   the next-day carry-over trip.
 * - A hand-promoted Prepping → Scheduled trip gets its waybill suggested too
 *   (markDayScheduled covers the whole-day path), unless it already has one.
 * @param {number} tripId
 * @param {Object} changes  Any of { truckId, driverId, helperIds, tripStatus, remarks, prefixId }
 * @returns {Promise<{ success: true, trip: Object, newTripId: number|null,
 *   routeFrequencyWarning: {outletName: string, count: number}|null }
 *   | { success: false, error: string }>}
 */
export async function saveTripChanges(tripId, changes) {
  await requirePermission('ASSIGN_CREW');
  try {
    const id = Number(tripId);
    const before = await one(`SELECT * FROM trips WHERE id = ?`, id);
    if (!before) throw new Error(`Trip ID ${tripId} not found.`);

    const oldDriverId = numOrNull(before.driver_id);
    const oldTruckId = numOrNull(before.truck_id);
    const oldStatus = before.trip_status;

    // Setting the status a trip already has is a no-op — otherwise a lost
    // save's retry would spawn a second carry-over for the same status.
    changes = Object.assign({}, changes);
    if (changes.tripStatus !== undefined && changes.tripStatus === oldStatus) delete changes.tripStatus;

    const sets = {};
    if (changes.truckId !== undefined) sets.truck_id = numOrNull(changes.truckId);
    if (changes.driverId !== undefined) sets.driver_id = numOrNull(changes.driverId);
    if (changes.tripStatus !== undefined) {
      sets.trip_status = changes.tripStatus;
      sets.status_changed_by = currentEmail() || 'unknown';
      sets.status_changed_at = nowPH();
    }
    if (changes.remarks !== undefined && changes.remarks !== null) sets.remarks = changes.remarks;

    const stmts = [];
    const cols = Object.keys(sets);
    if (cols.length) {
      stmts.push(stmt(`UPDATE trips SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...cols.map((c) => sets[c]), id));
    }
    if (changes.helperIds !== undefined) {
      const raw = Array.isArray(changes.helperIds) ? changes.helperIds : String(changes.helperIds || '').split(',');
      stmts.push(stmt(`DELETE FROM trip_helpers WHERE trip_id = ?`, id));
      helperSlots(raw).forEach((h) => stmts.push(stmt(
        `INSERT INTO trip_helpers (trip_id, employee_id, slot) VALUES (?, ?, ?)`, id, h.employee_id, h.slot)));
    }
    if (stmts.length) await batch(stmts);

    if (changes.truckId !== undefined || changes.driverId !== undefined || changes.helperIds !== undefined) {
      await _auditLog('TRIP_REASSIGN', 'trips', id,
        JSON.stringify({ driverId: oldDriverId, truckId: oldTruckId }),
        JSON.stringify({ driverId: changes.driverId, truckId: changes.truckId }));
    }
    if (changes.tripStatus !== undefined) {
      await _auditLog('TRIP_STATUS_CHANGE', 'trips', id, oldStatus, changes.tripStatus);
    }

    // Re-read: every branch below needs the row as it stands after the
    // update above (mirrors the .gs in-memory row it kept mutating).
    const row = await one(`SELECT * FROM trips WHERE id = ?`, id);

    const newStatus = row.trip_status;
    const newDriverId = numOrNull(row.driver_id);
    const justScheduled = oldStatus === 'Prepping' && newStatus !== 'Prepping';
    const driverChanged = changes.driverId !== undefined && numOrNull(changes.driverId) !== oldDriverId;

    let routeFrequencyWarning = null;
    if (newStatus !== 'Prepping' && newDriverId && (justScheduled || driverChanged)) {
      const outletId = numOrNull(row.outlet_id);
      if (outletId) {
        const freq = await getRouteFrequencyForDriver(newDriverId);
        const existing = freq.find((f) => f.outletId === Number(outletId));
        const newCount = (existing ? existing.count : 0) + 1;
        if (newCount > 5) {
          routeFrequencyWarning = { outletName: existing ? existing.outletName : '', count: newCount };
        }
        await _appendRouteFrequency(id, newDriverId, outletId);
      }
    }

    let waybill = null;
    if (justScheduled && newStatus === 'Scheduled') {
      waybill = await _suggestWaybillForScheduledTrip(
        id, row.fo_number || '', row.truck_id, row.trip_date, changes.prefixId || null);
    }

    let newTripId = null;
    const carryoverStatuses = ['Foul Trip - For Redeliver', 'Redeliver', 'Backlog'];
    if (changes.tripStatus !== undefined && carryoverStatuses.includes(changes.tripStatus)) {
      newTripId = await _createCarryoverTrip(id, changes.tripStatus);
    }

    const helperIds = (await q(
      `SELECT employee_id FROM trip_helpers WHERE trip_id = ? ORDER BY slot`, id)).map((h) => h.employee_id);

    const tripOut = {
      id,
      truckId: numOrNull(row.truck_id),
      driverId: numOrNull(row.driver_id),
      helperIds,
      truckBillingCategory: row.truck_billing_category || '',
      tripStatus: row.trip_status || 'Scheduled',
      remarks: row.remarks || '',
      statusChangedBy: row.status_changed_by || '',
      statusChangedAt: toClientDateTime(row.status_changed_at),
    };
    // Only set when a waybill was suggested — the client Object.assigns this
    // onto its cached trip and must not wipe existing waybill fields.
    if (waybill) {
      tripOut.waybillSuggested = waybill.waybillNumber;
      tripOut.suggestedWaybillId = waybill.id;
    }

    return { success: true, trip: tripOut, newTripId, routeFrequencyWarning };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Sets Trip Status on several trips in one call (a bulk row-selection action
 * on the dispatch board). Reuses saveTripChanges per trip, sequentially, so a
 * load's first stop reserves a waybill number and its later stops join it.
 * @param {number[]} tripIds
 * @param {string} status
 * @param {number} [prefixId]  Waybill prefix for Prepping → Scheduled promotions.
 * @returns {Promise<{ success: true, updated: number, newTripIds: number[] } | { success: false, error: string }>}
 */
export async function bulkSetTripStatus(tripIds, status, prefixId) {
  await requirePermission('ASSIGN_CREW');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error('No trips selected.');

    const changes = prefixId ? { tripStatus: status, prefixId } : { tripStatus: status };
    const newTripIds = [];
    let updated = 0;
    for (const id of ids) {
      const r = await saveTripChanges(id, changes);
      if (r && r.success) {
        updated++;
        if (r.newTripId) newTripIds.push(r.newTripId);
      }
    }

    return { success: true, updated, newTripIds };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Deletes a trip that is not applicable (imported, manual, or a mis-set
 * carry-over) — the only genuine delete in the system. Refused once the
 * trip carries a confirmed waybill.
 * @param {number} tripId
 * @returns {Promise<{ success: true } | { success: false, error: string }>}
 */
export async function deleteImportedTrip(tripId) {
  await requirePermission('ADD_MANUAL_TRIP');
  try {
    const id = Number(tripId);
    const wbs = await getWaybillsForTrip(id);
    if (wbs.some((w) => w.locked)) {
      throw new Error('Cannot delete a trip with a confirmed waybill. Use Trip Status instead.');
    }

    const row = await one(`SELECT id FROM trips WHERE id = ?`, id);
    if (!row) throw new Error(`Trip ID ${tripId} not found.`);

    // trips.waybill_id and a child's parent_trip_id are real FKs here (the
    // Sheet had neither): detach the Suggested waybill and clear any
    // carry-over's back-link before the row itself can go. trip_helpers
    // cascades; route_frequency_log does not, so it is cleared explicitly.
    await _deleteSuggestedWaybillsForTrip(id);
    await batch([
      stmt(`DELETE FROM route_frequency_log WHERE trip_id = ?`, id),
      stmt(`UPDATE trips SET parent_trip_id = NULL WHERE parent_trip_id = ?`, id),
      stmt(`DELETE FROM trips WHERE id = ?`, id),
    ]);

    await _auditLog('TRIP_DELETE', 'trips', id, 'Trip deleted (pre-confirmation)', '');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Deletes several trips in one call. Reuses deleteImportedTrip per id, so
 * the confirmed-waybill guard and cleanup behave exactly as the single
 * delete does. A trip that refuses to delete does not abort the rest.
 * @param {number[]} tripIds
 * @returns {Promise<{ success: true, deleted: number, blocked: { tripId: number, error: string }[] }
 *   | { success: false, error: string }>}
 */
export async function bulkDeleteTrips(tripIds) {
  await requirePermission('ADD_MANUAL_TRIP');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error('No trips selected.');

    let deleted = 0;
    const blocked = [];
    for (const id of ids) {
      const r = await deleteImportedTrip(id);
      if (r && r.success) deleted++;
      else blocked.push({ tripId: id, error: (r && r.error) || 'Delete failed.' });
    }

    return { success: true, deleted, blocked };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Promotes every 'Prepping' trip on a date to 'Scheduled' (or 'Backlog' when
 * it still has no crew, carrying that one over as a fresh Prepping trip for
 * the next business day) and suggests waybills for the promoted trips,
 * grouped by (FO Number, Truck ID) — a truck's several drops on one FO share
 * one waybill. Trips that already have a waybill are skipped.
 * @param {string} tripDate  'M/d/yyyy'
 * @param {number} prefixId  Waybill prefix for the suggested numbers.
 * @returns {Promise<{ success: true, promoted: number, waybillsSuggested: number,
 *   backlogged: number, newTripIds: number[] } | { success: false, error: string }>}
 */
export async function markDayScheduled(tripDate, prefixId) {
  await requirePermission('ADD_MANUAL_TRIP');
  try {
    const prefixes = await getWaybillPrefixes();
    if (!prefixes.some((p) => Number(p.id) === Number(prefixId))) {
      throw new Error(`Waybill prefix ID ${prefixId} not found.`);
    }

    const day = fromClientDate(tripDate) || tripDate;
    const rows = await q(
      `SELECT id, fo_number, truck_id, driver_id, outlet_id, waybill_id FROM trips
       WHERE trip_status = 'Prepping' AND trip_date = ?`, day);

    const promoted = [];
    const backlogged = [];
    rows.forEach((r) => {
      const rec = {
        tripId: r.id, foNumber: String(r.fo_number || ''),
        truckId: numOrNull(r.truck_id), driverId: numOrNull(r.driver_id),
        outletId: numOrNull(r.outlet_id), waybillId: r.waybill_id,
      };
      (rec.truckId || rec.driverId ? promoted : backlogged).push(rec);
    });

    if (!promoted.length && !backlogged.length) {
      return { success: true, promoted: 0, waybillsSuggested: 0, backlogged: 0, newTripIds: [] };
    }

    const email = currentEmail() || 'unknown';
    const now = nowPH();
    const touched = promoted.concat(backlogged);
    const statusOf = (p) => (p.truckId || p.driverId ? 'Scheduled' : 'Backlog');

    await batch(touched.map((p) => stmt(
      `UPDATE trips SET trip_status = ?, status_changed_by = ?, status_changed_at = ? WHERE id = ?`,
      statusOf(p), email, now, p.tripId)));

    await _auditLogBatch(touched.map((p) => ({
      action: 'TRIP_STATUS_CHANGE', table: 'trips', rowId: p.tripId, oldValue: 'Prepping', newValue: statusOf(p),
    })));

    // Backlogged trips get their next-day copy — same helper as a
    // Redeliver/Foul carry-over, run in order.
    const newTripIds = [];
    for (const p of backlogged) newTripIds.push(await _createCarryoverTrip(p.tripId, 'Backlog'));

    // Route frequency: a Prepping trip's crew was still being shuffled, so
    // only the promoted assignment (not the backlog) ever ran.
    const freqRows = promoted.filter((p) => p.driverId && p.outletId);
    if (freqRows.length) {
      await batch(freqRows.map((p) => stmt(
        `INSERT INTO route_frequency_log (trip_id, driver_id, outlet_id) VALUES (?, ?, ?)`,
        p.tripId, p.driverId, p.outletId)));
    }

    // Suggest waybills: skip trips that already have one.
    const groups = [];
    const byKey = {};
    promoted.forEach((p) => {
      if (p.waybillId) return;
      const key = p.foNumber ? `${p.foNumber}|${p.truckId || ''}` : `solo|${p.tripId}`;
      if (!byKey[key]) { byKey[key] = { foNumber: p.foNumber, tripIds: [] }; groups.push(byKey[key]); }
      byKey[key].tripIds.push(p.tripId);
    });
    await _suggestWaybillsForGroups(prefixId, groups);

    // groups.length = distinct waybill numbers (every group has >=1 trip)
    return {
      success: true, promoted: promoted.length, waybillsSuggested: groups.length,
      backlogged: backlogged.length, newTripIds,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Groups or ungroups trips as a convoy (trucks that must travel together).
 * 'group' mints a fresh token — (max numeric Convoy Group on the trips'
 * date) + 1 — and stamps it on every trip; 'ungroup' blanks it. All trips
 * must share one Trip Date.
 * @param {number[]} tripIds
 * @param {'group'|'ungroup'} action
 * @returns {Promise<{ success: true, group: string } | { success: false, error: string }>}
 */
export async function setTripConvoyGroup(tripIds, action) {
  await requirePermission('ASSIGN_CREW');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error('No trips selected.');
    if (action === 'group' && ids.length < 2) throw new Error('Select at least two trips to form a convoy.');

    const marks = ids.map(() => '?').join(',');
    const rows = await q(`SELECT id, trip_date, convoy_group FROM trips WHERE id IN (${marks})`, ...ids);
    const byId = {};
    rows.forEach((r) => { byId[r.id] = r; });

    let tripDate = null;
    ids.forEach((id) => {
      const r = byId[id];
      if (!r) throw new Error(`Trip ID ${id} not found.`);
      if (tripDate === null) tripDate = r.trip_date;
      else if (r.trip_date !== tripDate) throw new Error('All trips in a convoy must share one Trip Date.');
    });

    let group = '';
    if (action === 'group') {
      const maxRow = await one(
        `SELECT MAX(CAST(convoy_group AS INTEGER)) AS m FROM trips
         WHERE trip_date = ? AND convoy_group IS NOT NULL AND convoy_group != ''`, tripDate);
      group = String(((maxRow && maxRow.m) || 0) + 1);
    }

    const audits = ids.map((id) => ({
      action: 'TRIP_CONVOY_CHANGE', table: 'trips', rowId: id,
      oldValue: byId[id].convoy_group || '', newValue: group,
    }));
    await batch(ids.map((id) => stmt(`UPDATE trips SET convoy_group = ? WHERE id = ?`, group, id)));
    await _auditLogBatch(audits);

    return { success: true, group };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Persists the dispatcher's manual row order for a Trip Date: writes
 * `sort_order = index * 10` (gaps left for future manual nudges) for each id
 * in order. Purely presentational — not audited.
 * @param {string} dateStr           Unused beyond intent — every id is
 *                                   trusted as belonging to that date.
 * @param {number[]} orderedTripIds  Full ordered list of trip ids for the day.
 * @returns {Promise<{ success: true } | { success: false, error: string }>}
 */
export async function reorderTrips(dateStr, orderedTripIds) {
  await requirePermission('ASSIGN_CREW');
  try {
    const ids = (orderedTripIds || []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error('No trips to reorder.');

    const marks = ids.map(() => '?').join(',');
    const rows = await q(`SELECT id FROM trips WHERE id IN (${marks})`, ...ids);
    const existing = new Set(rows.map((r) => r.id));
    ids.forEach((id) => { if (!existing.has(id)) throw new Error(`Trip ID ${id} not found.`); });

    await batch(ids.map((id, i) => stmt(`UPDATE trips SET sort_order = ? WHERE id = ?`, i * 10, id)));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
