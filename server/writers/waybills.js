// ============================================================
//  AngeLoyal OMS — server/writers/waybills.js
//  Waybill numbering & confirmation (DataWriters.gs, Internals.gs).
//
//  The 1:N rewrite (Docs/D1 Migration.md §3): one `waybills` row per LOAD —
//  the trips that share a number on one FO — not one row per trip/stop as
//  the Sheet held it. `trips.waybill_id` points every stop of a load at that
//  single row. Confirming or renaming a load is now ONE row update instead
//  of a scan for every sheet row that shares the number+FO (_waybillGroupIdxs
//  in Internals.gs, which has no D1 equivalent — the group IS the row now).
//  `confirmed` / `updated` in the return values still count STOPS (trips),
//  read back through a join, so the client-facing shape is unchanged.
//
//  waybill_number is NOT unique (schema note, migrations/0001_init.sql): a
//  hand-typed number can land on two different loads. Duplicate checks below
//  scope on `status = 'Confirmed' AND id != ?`, matching the .gs semantics
//  (a load's own row is never a duplicate of itself; two Suggested loads may
//  share a number; only a live Confirmed number blocks a save).
//
//  Sequence reservation has no script lock (D1 serializes writes per
//  database instead): `_reserveWaybillSequence` allocates the
//  next number(s) inside one UPDATE ... RETURNING, so two concurrent
//  suggestions can never compute the same number.
// ============================================================

import { currentEmail } from '../ctx.js';
import { one, run, batch, stmt, numOrNull, nowPH } from '../db.js';
import { requirePermission } from '../rbac.js';
import { _auditLog, _auditLogBatch } from '../internals.js';
import { getWaybillPrefixes } from '../readers.js';

// ------------------------------------------------------------
//  Waybill number formatting (Utils.gs)
// ------------------------------------------------------------

/**
 * Builds the printed waybill number: `prefix-sequence` zero-padded to width,
 * plus a redeliver/foul-trip suffix. A blank prefix omits the leading
 * "prefix-" segment. `width` 0/blank means no padding; padStart never
 * truncates a sequence that is already wider than the booklet's width.
 * @param {string} prefix
 * @param {number} seq
 * @param {number} [width]
 * @param {string} [suffix]
 * @returns {string}
 */
export function _waybillNumberString(prefix, seq, width, suffix) {
  const s = String(seq).padStart(width || 0, '0');
  return (prefix ? `${prefix}-${s}` : `${s}`) + (suffix || '');
}

/**
 * Strips a trailing -R / -FT off a waybill number, so redelivering a
 * redeliver stays 1001-R instead of growing into 1001-R-R.
 * @param {string} waybillNumber
 * @returns {string}
 */
export function _baseWaybillNumber(waybillNumber) {
  return String(waybillNumber || '').replace(/-(R|FT)$/, '');
}

/**
 * Validates a typed "Last Sequence Number" and keeps it as a digit string so
 * its own length still carries the booklet's zero-pad width.
 * @param {*} value
 * @returns {string}
 * @throws {Error} when `value` is not all digits.
 */
export function _normalizeSequenceInput(value) {
  const seq = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(seq)) throw new Error('Last sequence number must be digits only (e.g. 0357).');
  return seq;
}

// ------------------------------------------------------------
//  Sequence reservation (Internals.gs)
// ------------------------------------------------------------

/**
 * The prefix row shaped like getWaybillPrefixes(), or throws.
 * @param {number} prefixId
 * @returns {Promise<{id, prefix, companyName, lastSequenceNumber, sequenceWidth, active}>}
 */
export async function _requireWaybillPrefix(prefixId) {
  const pref = (await getWaybillPrefixes()).find((p) => Number(p.id) === Number(prefixId));
  if (!pref) throw new Error(`Waybill prefix ID ${prefixId} not found.`);
  return pref;
}

/**
 * Highest sequence_number already recorded against a prefix in `waybills` —
 * the floor a counter can never re-issue below, even if its own cached value
 * fell behind (a failed write, a bad manual re-base).
 * @param {number} prefixId
 * @returns {Promise<number>} 0 if the prefix has never been used.
 */
export async function _highestIssuedSequence(prefixId) {
  const row = await one(`SELECT MAX(sequence_number) AS m FROM waybills WHERE prefix_id = ?`, Number(prefixId));
  return (row && row.m) || 0;
}

/**
 * Allocates `count` consecutive sequence numbers on a prefix in ONE statement
 * and returns the first. The counter moves past max(counter, highest sequence
 * already in waybills), so two concurrent requests can never compute the same
 * number: the second one's UPDATE reads the first one's result (D1 serializes
 * writes). The number is spent before any waybill row is minted against it.
 * @param {number} prefixId
 * @param {number} [count=1]
 * @returns {Promise<number>} The first allocated sequence number.
 * @throws {Error} when the prefix does not exist.
 */
export async function _reserveWaybillSequence(prefixId, count) {
  const n = Number(count) || 1;
  const row = await one(
    `UPDATE waybill_prefixes SET last_sequence_number = MAX(last_sequence_number,
       COALESCE((SELECT MAX(sequence_number) FROM waybills WHERE prefix_id = ?1), 0)) + ?2
     WHERE id = ?1 RETURNING last_sequence_number`,
    Number(prefixId), n);
  if (!row) throw new Error(`Waybill prefix ID ${prefixId} not found.`);
  return Number(row.last_sequence_number) - n + 1;
}

/**
 * Advances a prefix's Last Sequence Number to at least `newSeqNumber` (a
 * confirmed custom number). Only moves forward — a lower number (an
 * out-of-order confirm) is ignored — and never throws on a concurrent move.
 * @param {number} prefixId
 * @param {number} newSeqNumber
 */
export async function _updateWaybillPrefixSequence(prefixId, newSeqNumber) {
  await run(
    `UPDATE waybill_prefixes SET last_sequence_number = MAX(last_sequence_number, ?) WHERE id = ?`,
    Number(newSeqNumber), Number(prefixId));
}

// ------------------------------------------------------------
//  Waybill suggestion (Internals.gs)
// ------------------------------------------------------------

/**
 * Creates a Suggested waybill row for one trip and points that trip's
 * `waybill_id` at it. A new number is minted and reserved — except on the
 * carry-over path (`parentWaybillId` given), where Rebisco requires the
 * redelivered load to keep the ORIGINAL number (1001 redelivered is 1001-R,
 * never the next free number): the row reuses the parent's prefix/sequence
 * and reserves nothing, since that sequence was already spent.
 * @param {number} tripId
 * @param {number} prefixId        Ignored when parentWaybillId is given.
 * @param {string} foNumber
 * @param {string} waybillType     'Regular' | 'Redeliver' | 'Foul Trip'
 * @param {number|null} [parentWaybillId]
 * @returns {Promise<{ id: number, waybillNumber: string }>}
 */
export async function _createSuggestedWaybill(tripId, prefixId, foNumber, waybillType, parentWaybillId) {
  let suffix = '';
  if (waybillType === 'Redeliver') suffix = '-R';
  if (waybillType === 'Foul Trip') suffix = '-FT';

  const parent = parentWaybillId
    ? await one(`SELECT * FROM waybills WHERE id = ?`, Number(parentWaybillId))
    : null;

  let seq;
  let waybillNumber;
  let usePrefixId;
  if (parent) {
    usePrefixId = parent.prefix_id;
    seq = parent.sequence_number;
    waybillNumber = _baseWaybillNumber(parent.waybill_number) + suffix;
  } else {
    const pref = await _requireWaybillPrefix(prefixId);
    usePrefixId = prefixId;
    // Reserve before minting: the number is spent even if the insert fails.
    seq = await _reserveWaybillSequence(prefixId, 1);
    waybillNumber = _waybillNumberString(pref.prefix, seq, pref.sequenceWidth, suffix);
  }

  const [ins] = await batch([
    stmt(`INSERT INTO waybills (waybill_number, prefix_id, sequence_number, waybill_type, parent_waybill_id, status)
          VALUES (?, ?, ?, ?, ?, 'Suggested') RETURNING id`,
      waybillNumber, usePrefixId, seq, waybillType, parentWaybillId || null),
    stmt(`UPDATE trips SET waybill_id = (SELECT MAX(id) FROM waybills) WHERE id = ?`, Number(tripId)),
  ]);
  const id = ins.results[0].id;

  await _auditLog('WAYBILL_SUGGEST', 'waybills', id, '', waybillNumber);
  return { id, waybillNumber };
}

/**
 * Batch-suggests Regular waybills for groups of trips. One waybill ROW per
 * group (a truck's several drops on one load = one LOAD), and every trip in
 * the group gets that row's id in `trips.waybill_id`. Groups with no trips
 * are skipped and burn no number. The whole span is reserved once, at the
 * final sequence number, before any row is inserted.
 * @param {number} prefixId
 * @param {Array<{foNumber: string, tripIds: number[]}>} groups
 * @returns {Promise<Array<{tripId: number, waybillId: number, waybillNumber: string}>>}
 *   One entry per trip (not per group) — a group's trips share one waybillId.
 */
export async function _suggestWaybillsForGroups(prefixId, groups) {
  const pref = await _requireWaybillPrefix(prefixId);
  const live = (groups || []).filter((g) => g.tripIds && g.tripIds.length);
  if (!live.length) return [];

  // The whole span is allocated in one statement before any row is inserted.
  const first = await _reserveWaybillSequence(prefixId, live.length);
  const batches = live.map((g, i) => ({
    seq: first + i,
    waybillNumber: _waybillNumberString(pref.prefix, first + i, pref.sequenceWidth),
    tripIds: g.tripIds,
  }));

  const inserted = await batch(batches.map((b) => stmt(
    `INSERT INTO waybills (waybill_number, prefix_id, sequence_number, waybill_type, status)
     VALUES (?, ?, ?, 'Regular', 'Suggested') RETURNING id`,
    b.waybillNumber, prefixId, b.seq)));

  const out = [];
  const audits = [];
  inserted.forEach((r, i) => {
    const b = batches[i];
    const waybillId = r.results[0].id;
    b.tripIds.forEach((tripId) => out.push({ tripId, waybillId, waybillNumber: b.waybillNumber }));
    audits.push({ action: 'WAYBILL_SUGGEST', table: 'waybills', rowId: waybillId, oldValue: '', newValue: b.waybillNumber });
  });

  await batch(out.map((o) => stmt(`UPDATE trips SET waybill_id = ? WHERE id = ?`, o.waybillId, o.tripId)));
  await _auditLogBatch(audits);

  return out;
}

/**
 * Waybill for one trip promoted out of Prepping by hand (saveTripChanges) or
 * a carry-over, honoring the one-waybill-per-truck-load rule:
 * - the trip already has a waybill_id -> null (nothing to do);
 * - a sibling stop of the same load (same Trip Date + FO Number + Truck ID)
 *   already points at a Suggested waybill of the same type -> this trip is
 *   pointed at that SAME row (no new row, no number spent — the row already
 *   covers the whole load now, unlike the old one-row-per-stop sheet);
 * - otherwise, if a prefixId is given -> a new number is reserved.
 *
 * Takes the trip's own fields rather than a sheet row: the caller (a writer
 * that already has the trip, e.g. from a `SELECT * FROM trips` row or a
 * freshly-built insert) passes them straight through.
 * @param {number} tripId
 * @param {string} foNumber
 * @param {number|null} truckId
 * @param {string} tripDate       Storage 'YYYY-MM-DD'.
 * @param {number|null} prefixId
 * @param {string} [waybillType='Regular']
 * @param {number|null} [parentWaybillId]
 * @returns {Promise<{ id: number, waybillNumber: string } | null>}
 */
export async function _suggestWaybillForScheduledTrip(tripId, foNumber, truckId, tripDate, prefixId, waybillType, parentWaybillId) {
  const wbType = waybillType || 'Regular';
  const id = Number(tripId);

  const own = await one(`SELECT waybill_id FROM trips WHERE id = ?`, id);
  if (own && own.waybill_id) return null;

  const fo = String(foNumber || '');
  if (fo) {
    const truck = numOrNull(truckId);
    const sibling = await one(
      `SELECT w.id AS waybill_id, w.waybill_number
       FROM trips t JOIN waybills w ON w.id = t.waybill_id
       WHERE t.fo_number = ? AND t.trip_date = ? AND t.id != ?
         AND (t.truck_id = ? OR (t.truck_id IS NULL AND ? IS NULL))
         AND w.status = 'Suggested' AND w.waybill_type = ?
       LIMIT 1`,
      fo, tripDate, id, truck, truck, wbType);
    if (sibling) {
      await run(`UPDATE trips SET waybill_id = ? WHERE id = ?`, sibling.waybill_id, id);
      return { id: sibling.waybill_id, waybillNumber: sibling.waybill_number };
    }
  }

  return prefixId
    ? await _createSuggestedWaybill(id, prefixId, fo, wbType, parentWaybillId || null)
    : null;
}

/**
 * Detaches or removes a trip's Suggested waybill (an imported trip deleted
 * before confirmation). A Confirmed waybill is left alone — it is immutable.
 * Since a row can now cover several stops, only this trip is detached
 * (`waybill_id` cleared) when siblings remain; the row itself is deleted only
 * when this was its last trip.
 * @param {number} tripId
 */
export async function _deleteSuggestedWaybillsForTrip(tripId) {
  const id = Number(tripId);
  const trip = await one(`SELECT waybill_id FROM trips WHERE id = ?`, id);
  if (!trip || !trip.waybill_id) return;

  const wb = await one(`SELECT status FROM waybills WHERE id = ?`, trip.waybill_id);
  if (!wb || wb.status !== 'Suggested') return;

  // Detach first: trips.waybill_id is a foreign key, so the row can only go
  // once no trip points at it.
  await batch([
    stmt(`UPDATE trips SET waybill_id = NULL WHERE id = ?`, id),
    stmt(`DELETE FROM waybills WHERE id = ? AND status = 'Suggested'
          AND NOT EXISTS (SELECT 1 FROM trips WHERE waybill_id = ?)`, trip.waybill_id, trip.waybill_id),
  ]);
}

// ------------------------------------------------------------
//  Client-callable writers (DataWriters.gs)
// ------------------------------------------------------------

/** Number of trips (stops) a waybill row covers — the client-facing "how many rows did this touch" count. */
async function _stopCount(waybillId) {
  const row = await one(`SELECT COUNT(*) AS c FROM trips WHERE waybill_id = ?`, waybillId);
  return row.c;
}

/**
 * Confirms a waybill (locks it permanently). A multi-stop load is one
 * `waybills` row now, so confirming it confirms every stop in the same
 * statement — no per-row scan is needed the way the Sheet's
 * `_waybillGroupIdxs` needed one.
 * @param {number} waybillId
 * @param {string} [customNumber]  Overrides the suggested number.
 * @returns {Promise<{ success: true, waybillNumber: string, confirmed: number }
 *   | { success: false, error: string }>}
 */
export async function confirmWaybill(waybillId, customNumber) {
  await requirePermission('CONFIRM_WAYBILL');
  try {
    const id = Number(waybillId);
    const row = await one(`SELECT * FROM waybills WHERE id = ?`, id);
    if (!row) throw new Error(`Waybill ID ${waybillId} not found.`);
    if (row.status === 'Confirmed') {
      throw new Error(`Waybill ${row.waybill_number} is already confirmed and locked.`);
    }

    const origNumber = row.waybill_number;
    let finalNumber = origNumber;
    const prefixId = numOrNull(row.prefix_id);
    let seqNumber = numOrNull(row.sequence_number);

    if (customNumber && customNumber !== finalNumber) {
      const dup = await one(
        `SELECT id FROM waybills WHERE waybill_number = ? AND status = 'Confirmed' AND id != ?`,
        customNumber, id);
      if (dup) throw new Error(`Waybill number "${customNumber}" is already confirmed and in use.`);

      finalNumber = customNumber;
      const match = customNumber.match(/(\d+)(?:-[A-Z]+)?$/);
      seqNumber = match ? Number(match[1]) : seqNumber;

      await _auditLog('WAYBILL_OVERRIDE', 'waybills', id, origNumber, finalNumber);
    }

    await run(
      `UPDATE waybills SET waybill_number = ?, sequence_number = ?, status = 'Confirmed',
       confirmed_by = ?, confirmed_at = ? WHERE id = ?`,
      finalNumber, seqNumber, currentEmail() || 'unknown', nowPH(), id);
    await _auditLog('WAYBILL_CONFIRM', 'waybills', id, 'Suggested', finalNumber);

    if (prefixId && seqNumber) await _updateWaybillPrefixSequence(prefixId, seqNumber);

    return { success: true, waybillNumber: finalNumber, confirmed: await _stopCount(id) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Renames still-Suggested waybills WITHOUT confirming them. Locked
 * (Confirmed) waybills are immutable and rejected. One bad edit does not
 * sink the batch: it reports its own error and the rest still land.
 * @param {Array<{waybillId: number, number: string}>} edits
 * @returns {Promise<{ success: true, results: Array<{waybillId: number, success: boolean,
 *   waybillNumber?: string, updated?: number, error?: string }> }>}
 */
export async function updateSuggestedWaybills(edits) {
  await requirePermission('CONFIRM_WAYBILL');

  const list = edits || [];
  if (!list.length) return { success: true, results: [] };

  const results = [];
  const toApply = [];   // { id, finalNumber, seqNum }
  const audits = [];
  const maxSeq = {};    // prefixId -> highest sequence this batch issued

  for (const edit of list) {
    const waybillId = edit && edit.waybillId;
    try {
      const id = Number(waybillId);
      const row = await one(`SELECT * FROM waybills WHERE id = ?`, id);
      if (!row) throw new Error(`Waybill ID ${waybillId} not found.`);
      if (row.status === 'Confirmed') {
        throw new Error(`Waybill ${row.waybill_number} is already confirmed and locked.`);
      }

      const finalNumber = (edit.number == null ? '' : edit.number).toString().trim();
      if (!finalNumber) throw new Error('Waybill number cannot be blank.');

      const origNumber = row.waybill_number;
      if (finalNumber === origNumber) {
        results.push({ waybillId, success: true, waybillNumber: origNumber, updated: 0 });
        continue;
      }

      const clash = await one(
        `SELECT id FROM waybills WHERE waybill_number = ? AND status = 'Confirmed' AND id != ?`,
        finalNumber, id);
      if (clash) throw new Error(`Waybill number "${finalNumber}" is already confirmed and in use.`);

      const prefixId = numOrNull(row.prefix_id);
      const origSeq = numOrNull(row.sequence_number);
      const match = finalNumber.match(/(\d+)(?:-[A-Z]+)?$/);
      const seqNum = match ? Number(match[1]) : origSeq;

      toApply.push({ id, finalNumber, seqNum });
      audits.push({ action: 'WAYBILL_OVERRIDE', table: 'waybills', rowId: id, oldValue: origNumber, newValue: finalNumber });
      if (prefixId && seqNum && seqNum > (maxSeq[prefixId] || 0)) maxSeq[prefixId] = seqNum;

      results.push({ waybillId, success: true, waybillNumber: finalNumber, updated: await _stopCount(id) });
    } catch (e) {
      results.push({ waybillId, success: false, error: e.message });
    }
  }

  if (toApply.length) {
    await batch(toApply.map((u) => stmt(
      `UPDATE waybills SET waybill_number = ?, sequence_number = ? WHERE id = ?`,
      u.finalNumber, u.seqNum, u.id)));
  }
  await _auditLogBatch(audits);

  // Keep the booklet counter ahead of an edit that raises the number, so a
  // later suggestion can't re-issue it. Only advances (see the helper).
  for (const prefixId of Object.keys(maxSeq)) {
    await _updateWaybillPrefixSequence(Number(prefixId), maxSeq[prefixId]);
  }

  return { success: true, results };
}

/**
 * One-edit form of `updateSuggestedWaybills`, kept for a client cached from
 * before the batch call existed.
 * @param {number} waybillId
 * @param {string} newNumber
 * @returns {Promise<{ success: true, waybillNumber: string, updated: number } | { success: false, error: string }>}
 */
export async function updateSuggestedWaybill(waybillId, newNumber) {
  const r = (await updateSuggestedWaybills([{ waybillId, number: newNumber }])).results[0];
  return r.success
    ? { success: true, waybillNumber: r.waybillNumber, updated: r.updated }
    : { success: false, error: r.error };
}

// ------------------------------------------------------------
//  Waybill Prefixes (Admin + Dispatcher)
// ------------------------------------------------------------

/**
 * The "already exists" error for a prefix, or '' if it's free. A soft-deleted
 * (inactive) row still collides — it's only hidden from the pickers — so the
 * message points at Restore instead of leaving the dispatcher hunting for a
 * prefix they can't see. `waybill_prefixes.prefix` is UNIQUE COLLATE NOCASE,
 * so this is a friendly pre-check ahead of that constraint, not a substitute
 * for it.
 * @param {string} prefix       Already trimmed.
 * @param {number} [skipId]     The row being edited, excluded from the check.
 * @returns {Promise<string>}
 */
export async function _prefixDupMessage(prefix, skipId) {
  const dup = skipId == null
    ? await one(`SELECT active FROM waybill_prefixes WHERE prefix = ? COLLATE NOCASE`, prefix)
    : await one(`SELECT active FROM waybill_prefixes WHERE prefix = ? COLLATE NOCASE AND id != ?`, prefix, Number(skipId));
  if (!dup) return '';
  const removed = dup.active !== 1;
  return `A prefix "${prefix || '(blank)'}" already exists`
    + (removed ? ' but was removed — restore it instead of adding it again.' : '.');
}

/**
 * Creates a new waybill prefix.
 * @param {Object} data  { prefix, companyName, lastSequenceNumber }
 * @returns {Promise<{ success: true, waybillPrefix: Object } | { success: false, error: string }>}
 */
export async function createWaybillPrefix(data) {
  await requirePermission('EDIT_WAYBILL_PREFIXES');
  try {
    const prefix = String(data.prefix || '').trim();
    const companyName = String(data.companyName || '').trim();
    const seq = _normalizeSequenceInput(data.lastSequenceNumber);
    if (!companyName) throw new Error('Company name is required.');

    const dup = await _prefixDupMessage(prefix, null);
    if (dup) throw new Error(dup);

    const width = seq.length;
    const { last_row_id: id } = await run(
      `INSERT INTO waybill_prefixes (prefix, company_name, last_sequence_number, sequence_width, active)
       VALUES (?, ?, ?, ?, 1)`,
      prefix, companyName, Number(seq), width);

    await _auditLog('WAYBILL_PREFIX_CREATE', 'waybill_prefixes', id, '',
      JSON.stringify({ prefix, companyName, lastSequenceNumber: seq }));

    return {
      success: true,
      waybillPrefix: { id, prefix, companyName, lastSequenceNumber: Number(seq), sequenceWidth: width, active: true },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Updates a waybill prefix. Editing Last Sequence Number re-bases the
 * numbering (and its zero-pad width); setting active=false is a soft
 * delete — existing waybills keep referencing the row.
 * @param {number} prefixId
 * @param {Object} changes  Any of { prefix, companyName, lastSequenceNumber, active }
 * @returns {Promise<{ success: true, waybillPrefix: Object } | { success: false, error: string }>}
 */
export async function updateWaybillPrefix(prefixId, changes) {
  await requirePermission('EDIT_WAYBILL_PREFIXES');
  try {
    const id = Number(prefixId);
    const row = await one(`SELECT * FROM waybill_prefixes WHERE id = ?`, id);
    if (!row) throw new Error(`Waybill prefix ID ${prefixId} not found.`);

    const oldVal = {
      prefix: row.prefix, companyName: row.company_name,
      lastSequenceNumber: row.last_sequence_number, active: row.active === 1,
    };

    const sets = [];
    const args = [];
    if (changes.prefix !== undefined) {
      const prefix = String(changes.prefix).trim();
      const dup = await _prefixDupMessage(prefix, id);
      if (dup) throw new Error(dup);
      sets.push('prefix = ?'); args.push(prefix);
    }
    if (changes.companyName !== undefined) {
      const companyName = String(changes.companyName).trim();
      if (!companyName) throw new Error('Company name is required.');
      sets.push('company_name = ?'); args.push(companyName);
    }
    if (changes.active !== undefined) { sets.push('active = ?'); args.push(changes.active ? 1 : 0); }

    if (changes.lastSequenceNumber !== undefined) {
      const text = _normalizeSequenceInput(changes.lastSequenceNumber);
      const seqValue = Number(text);
      const seqWidth = text.length;

      // Re-basing at or below a number already out would re-mint it.
      const highest = await _highestIssuedSequence(id);
      if (seqValue < highest) {
        throw new Error(
          `This booklet has already issued up to ${highest}. `
          + `Set the last sequence number to ${highest} or higher.`);
      }
      sets.push('last_sequence_number = ?'); args.push(seqValue);
      sets.push('sequence_width = ?'); args.push(seqWidth);
    }

    if (sets.length) {
      args.push(id);
      await run(`UPDATE waybill_prefixes SET ${sets.join(', ')} WHERE id = ?`, ...args);
    }

    await _auditLog('WAYBILL_PREFIX_EDIT', 'waybill_prefixes', id, JSON.stringify(oldVal), JSON.stringify(changes));

    const fresh = await one(`SELECT * FROM waybill_prefixes WHERE id = ?`, id);
    return {
      success: true,
      waybillPrefix: {
        id,
        prefix: fresh.prefix,
        companyName: fresh.company_name,
        lastSequenceNumber: Number(fresh.last_sequence_number) || 0,
        sequenceWidth: Number(fresh.sequence_width) || 0,
        active: fresh.active === 1,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
