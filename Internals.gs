// ============================================================
//  AngeLoyal OMS — Internals.gs
//  Audit logging + internal helpers used by DataWriters.gs.
// ============================================================


// ============================================================
//  AUDIT LOG
// ============================================================

/**
 * Appends a row to the Audit Log sheet.
 * Includes Table, Row ID, Old Value, New Value columns.
 * Best-effort — never crashes the caller.
 *
 * @param {string} action
 * @param {string} [table]
 * @param {number} [rowId]
 * @param {string} [oldValue]
 * @param {string} [newValue]
 */
function _auditLog(action, table, rowId, oldValue, newValue) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_AUDIT);
    if (!sheet) return;

    const nextId = _nextRowId(sheet);
    sheet.appendRow([
      nextId,
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss'),
      _getCurrentUserEmail() || 'unknown',
      action,
      '',                        // Detail column (legacy — kept for compatibility)
      table    || '',
      rowId    || '',
      oldValue !== undefined ? String(oldValue) : '',
      newValue !== undefined ? String(newValue) : '',
    ]);
  } catch (_) {
    // Audit is best-effort; never propagate errors
  }
}


// ============================================================
//  INTERNAL HELPERS — Data reset
// ============================================================

/**
 * Deletes every data row (header row survives) from the transactional sheets.
 * Master data — Employees, Trucks, Users, Billing Categories, Waybill Prefixes
 * and their sequence counters, Default Assignments, Route Type Map, Freight
 * Rates, Fuel Prices, Billing Charge Types — is left alone: this resets
 * operations, it does not re-provision the company.
 *
 * Shared by the token-gated _devClear endpoint (scripts/clear-sheet-data.js)
 * and the Admin panel's clearAllData() so there is exactly one definition of
 * "clear the data" in the system.
 *
 * @returns {string[]} names of the sheets that were cleared (missing ones are skipped)
 */
function _clearTransactionalSheets() {
  const sheetNames = [SHEET_TRIPS, SHEET_OUTLETS, SHEET_ROUTE_FREQ, SHEET_WAYBILLS,
                      SHEET_BILLING_LINES, SHEET_AUDIT];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cleared = [];
  sheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
    cleared.push(name);
  });
  return cleared;
}

// ============================================================
//  INTERNAL HELPERS — Waybill logic
// ============================================================

var _LOCK_DEPTH = 0;

/**
 * Runs `fn` holding the script lock, and flushes the Sheet before releasing it.
 *
 * Every writer is a read → decide → append sequence, and nothing serializes
 * client calls: the dispatch board fires saves in the background (`bgSave`), so
 * marking three stops of one load Redeliver runs as three parallel executions.
 * Unserialized they all read the same Last Sequence Number, the same last row
 * ID, and none of them sees the sibling row the others just wrote — which is
 * how prod ended up with two trips sharing ID 91, waybill IDs restarting at 1,
 * and one carried-over load split across 12870-R/12871-R/12872-R.
 *
 * The flush matters as much as the lock: appends are queued, so a lock released
 * before the flush lets the next execution read a half-written row (a blank ID
 * cell reads as 0, and `_nextRowId` then hands out 1 again).
 *
 * `rpc()` wraps every writer in this, so inner calls nest — hence the depth
 * guard: a second getScriptLock() in the same execution would block on the
 * first.
 *
 * @param {Function} fn
 * @returns {*} whatever `fn` returns
 */
function _withLock(fn) {
  if (_LOCK_DEPTH > 0) return fn();          // already ours — don't self-deadlock

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error('The system is busy with another change. Please try again.');
  }
  _LOCK_DEPTH++;
  try {
    return fn();
  } finally {
    _LOCK_DEPTH--;
    try { SpreadsheetApp.flush(); } catch (_) {}
    lock.releaseLock();
  }
}

/**
 * Looks up a waybill prefix by ID.
 * @param {number} prefixId
 * @returns {Object} the prefix record from getWaybillPrefixes()
 */
function _requireWaybillPrefix(prefixId) {
  const pref = getWaybillPrefixes().find(p => Number(p.id) === Number(prefixId));
  if (!pref) throw new Error(`Waybill prefix ID ${prefixId} not found.`);
  return pref;
}

/**
 * Highest Sequence Number already recorded against a prefix in the Waybills
 * ledger.
 *
 * The prefix's Last Sequence Number is only a cache of this. Consulting the
 * ledger as well means a counter that failed to advance — or one an admin
 * re-based too low — can still never re-issue a number that is already out.
 *
 * @param {number}  prefixId
 * @param {Array[]} wbRows     Waybills rows, header included.
 * @param {Array}   wbHeaders
 * @returns {number} 0 if the prefix has never been used
 */
function _highestIssuedSequence(prefixId, wbRows, wbHeaders) {
  let max = 0;
  for (let i = 1; i < wbRows.length; i++) {
    if (Number(_numOrNull(_val(wbRows[i], wbHeaders, 'Prefix ID'))) !== Number(prefixId)) continue;
    const seq = Number(_numOrNull(_val(wbRows[i], wbHeaders, 'Sequence Number'))) || 0;
    if (seq > max) max = seq;
  }
  return max;
}

/**
 * Reserves a sequence number on a prefix: writes Last Sequence Number and the
 * booklet's pad width, then reads the cell back to prove the write landed.
 *
 * Both are written as plain numbers. The previous version stored the counter
 * zero-padded *as text* and inferred the width from that text's length, so
 * every padded booklet took a `setNumberFormat('@').setValue(...)` write that
 * silently did nothing — those prefixes never advanced and re-issued the same
 * number forever (AY froze at 0358, GL at 039, both minting one number across
 * several loads). The width now lives in its own column, so no code path
 * depends on how a cell happens to be formatted.
 *
 * @param {number} prefixId
 * @param {number} newSeqNumber
 * @param {number} width         Booklet pad width to persist alongside.
 */
function _reserveWaybillSequence(prefixId, newSeqNumber, width) {
  const sheet   = _getSheet(SHEET_WB_PREFIXES);
  const rows    = sheet.getDataRange().getValues();
  const headers = _ensureColumn(sheet, rows[0].map(h => h.toString().trim()), 'Sequence Width');
  const rowIdx  = _findRowById(rows, headers, prefixId);
  if (rowIdx === -1) throw new Error(`Waybill prefix ID ${prefixId} not found.`);

  _writeRowFields(sheet, rows[rowIdx], rowIdx, headers, {
    'Last Sequence Number': Number(newSeqNumber),
    'Sequence Width':       Number(width) || String(newSeqNumber).length,
  });

  // Read back. The defect this replaces was a write that no-opped in silence
  // while the waybill row was minted anyway; a caller that can't reserve must
  // fail instead of handing out a number it hasn't secured.
  const col    = headers.indexOf('Last Sequence Number') + 1;
  const stored = Number(sheet.getRange(rowIdx + 1, col).getValue());
  if (stored !== Number(newSeqNumber)) {
    throw new Error(
      `Could not reserve waybill sequence ${newSeqNumber} — the prefix counter still reads ${stored}.`);
  }
}

/**
 * Creates a Suggested waybill row for a trip.
 * Does NOT confirm or lock it.
 *
 * A NEW number is minted (and the prefix's Last Sequence Number reserved, so
 * the next suggestion can't collide) — except on the carry-over path.
 *
 * A carry-over passes `parentWaybillId`, and Rebisco requires the redelivered
 * load to keep the ORIGINAL number: waybill 1001 redelivered is 1001-R, never
 * the next free number with -R stapled on. So when a parent is given, the row
 * reuses the parent's prefix, sequence and number base, and reserves nothing —
 * the sequence was already spent when the parent was issued. `-R` / `-FT` is
 * stripped off the parent's number first, so redelivering a redeliver stays
 * 1001-R instead of growing 1001-R-R.
 *
 * Two rows then share one Sequence Number for the prefix (1001 and 1001-R).
 * That is intended: _highestIssuedSequence still reports 1001, so the next
 * Regular waybill is 1002.
 *
 * @param {number} tripId
 * @param {number} prefixId
 * @param {string} foNumber
 * @param {string} waybillType  'Regular' | 'Redeliver' | 'Foul Trip'
 * @param {number|null} parentWaybillId
 * @returns {{ id: number, waybillNumber: string }}
 */
function _createSuggestedWaybill(tripId, prefixId, foNumber, waybillType, parentWaybillId) {
  return _withLock(() => {
    const sheet     = _getSheet(SHEET_WAYBILLS);
    const wbRows    = sheet.getDataRange().getValues();
    const wbHeaders = wbRows[0].map(h => h.toString().trim());

    let suffix = '';
    if (waybillType === 'Redeliver')  suffix = '-R';
    if (waybillType === 'Foul Trip')  suffix = '-FT';

    const parent = parentWaybillId
      ? wbRows.slice(1).find(r =>
          Number(_numOrNull(_val(r, wbHeaders, 'ID'))) === Number(parentWaybillId))
      : null;

    let seq, waybillNumber, usePrefixId;
    if (parent) {
      usePrefixId   = _numOrNull(_val(parent, wbHeaders, 'Prefix ID'));
      seq           = _numOrNull(_val(parent, wbHeaders, 'Sequence Number'));
      waybillNumber = _baseWaybillNumber(_val(parent, wbHeaders, 'Waybill Number')) + suffix;
    } else {
      const pref    = _requireWaybillPrefix(prefixId);
      usePrefixId   = prefixId;
      seq           = Math.max(
        pref.lastSequenceNumber || 0,
        _highestIssuedSequence(prefixId, wbRows, wbHeaders)) + 1;
      waybillNumber = _waybillNumberString(pref.prefix, seq, pref.sequenceWidth, suffix);

      // Reserve before minting: the old order appended the waybill first and
      // swallowed a failed bump, which is exactly how duplicates got out.
      _reserveWaybillSequence(prefixId, seq, pref.sequenceWidth);
    }

    const nextId = _nextRowIdFromRows(wbRows);
    sheet.appendRow([
      nextId,
      waybillNumber,
      usePrefixId,
      seq,
      tripId,
      foNumber,
      waybillType,
      parentWaybillId || '',
      'Suggested',
      false,
      '',
      '',
    ]);

    _auditLog('WAYBILL_SUGGEST', SHEET_WAYBILLS, nextId, '', waybillNumber);
    return { id: nextId, waybillNumber };
  });
}

/**
 * Batch-creates Suggested 'Regular' waybills for groups of trips.
 * One waybill number per group; every trip in a group shares that
 * number/sequence (= a truck's several drops on one load). Groups with
 * no trips are skipped. Reserves the numbers: the prefix's Last Sequence
 * Number advances to the last one issued.
 *
 * @param {number} prefixId
 * @param {Array<{foNumber: string, tripIds: number[]}>} groups
 * @returns {Array<{tripId: number, waybillId: number, waybillNumber: string}>}
 */
function _suggestWaybillsForGroups(prefixId, groups) {
  return _withLock(() => {
    const sheet     = _getSheet(SHEET_WAYBILLS);
    const wbRows    = sheet.getDataRange().getValues();
    const wbHeaders = wbRows[0].map(h => h.toString().trim());
    const pref      = _requireWaybillPrefix(prefixId);

    let nextId  = _nextRowIdFromRows(wbRows);
    let nextSeq = Math.max(
      pref.lastSequenceNumber || 0,
      _highestIssuedSequence(prefixId, wbRows, wbHeaders));

    const newRows = [];
    const out     = [];
    groups.forEach(g => {
      if (!g.tripIds || g.tripIds.length === 0) return;
      nextSeq += 1;
      const waybillNumber = _waybillNumberString(pref.prefix, nextSeq, pref.sequenceWidth);
      g.tripIds.forEach(tripId => {
        const id = nextId++;
        newRows.push([
          id,
          waybillNumber,
          prefixId,
          nextSeq,
          tripId,
          g.foNumber || '',
          'Regular',
          '',                      // Parent Waybill ID
          'Suggested',
          false,
          '',                      // Confirmed By
          '',                      // Confirmed At
        ]);
        out.push({ tripId, waybillId: id, waybillNumber });
      });
    });

    // Reserve the whole span before appending, so a counter that won't advance
    // aborts the batch rather than issuing numbers it hasn't secured.
    if (newRows.length) {
      _reserveWaybillSequence(prefixId, nextSeq, pref.sequenceWidth);
      _appendRows(sheet, newRows);
    }

    // Audit is best-effort, like _auditLog — but batched.
    try {
      const auditSheet = _getSheet(SHEET_AUDIT);
      let nextAuditId  = _nextRowId(auditSheet);
      const email      = _getCurrentUserEmail() || 'unknown';
      const nowStr     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
      _appendRows(auditSheet, out.map(o =>
        [nextAuditId++, nowStr, email, 'WAYBILL_SUGGEST', '', SHEET_WAYBILLS, o.waybillId, '', o.waybillNumber]
      ));
    } catch (_) {}

    return out;
  });
}

/**
 * Waybill for one trip promoted out of Prepping by hand (saveTripChanges),
 * honoring the one-waybill-per-truck-load rule now that suggestions reserve
 * sequence numbers:
 * - the trip already has a waybill row → null (nothing to do);
 * - a sibling stop of the same load (same Trip Date + FO Number + Truck ID)
 *   has a Suggested 'Regular' waybill → append a row sharing its number
 *   (no new number reserved);
 * - otherwise, if a prefixId is given → reserve the next number.
 *
 * Carry-overs reuse this with type 'Redeliver'/'Foul Trip': the stops of one
 * merged load each spawn their own carry-over trip, and they must land on one
 * shared -R/-FT number or the next day's board shows the load unmerged.
 *
 * @param {Array[]} tripRows     Full Trips sheet rows (incl. header row)
 * @param {Array}   tripHeaders
 * @param {Array}   tripRow      The promoted trip's row
 * @param {number}  tripId
 * @param {number|null} prefixId
 * @param {string}  [waybillType='Regular']
 * @param {number|null} [parentWaybillId]
 * @returns {{ id: number, waybillNumber: string } | null}
 */
function _suggestWaybillForScheduledTrip(tripRows, tripHeaders, tripRow, tripId, prefixId, waybillType, parentWaybillId) {
  const wbType = waybillType || 'Regular';
  const wbSheet   = _getSheet(SHEET_WAYBILLS);
  const wbRows    = wbSheet.getDataRange().getValues();
  const wbHeaders = wbRows[0].map(h => h.toString().trim());

  const hasOwn = wbRows.slice(1).some(r =>
    Number(_numOrNull(_val(r, wbHeaders, 'Trip ID'))) === Number(tripId));
  if (hasOwn) return null;

  const fo = String(_val(tripRow, tripHeaders, 'FO Number') || '');
  if (fo) {
    const date  = _formatDate(_readDateCell(_val(tripRow, tripHeaders, 'Trip Date')));
    const truck = _numOrNull(_val(tripRow, tripHeaders, 'Truck ID')) || '';
    const siblings = {};
    tripRows.slice(1).forEach(r => {
      const id = _numOrNull(_val(r, tripHeaders, 'ID'));
      if (id === null || Number(id) === Number(tripId)) return;
      if (String(_val(r, tripHeaders, 'FO Number') || '') !== fo) return;
      if ((_numOrNull(_val(r, tripHeaders, 'Truck ID')) || '') !== truck) return;
      if (_formatDate(_readDateCell(_val(r, tripHeaders, 'Trip Date'))) !== date) return;
      siblings[id] = true;
    });
    const shared = wbRows.slice(1).find(r =>
      siblings[_numOrNull(_val(r, wbHeaders, 'Trip ID'))] &&
      _val(r, wbHeaders, 'Status') === 'Suggested' &&
      _val(r, wbHeaders, 'Waybill Type') === wbType);
    if (shared) {
      const nextId = _nextRowId(wbSheet);
      const number = _val(shared, wbHeaders, 'Waybill Number');
      wbSheet.appendRow([
        nextId,
        number,
        _numOrNull(_val(shared, wbHeaders, 'Prefix ID')),
        _val(shared, wbHeaders, 'Sequence Number'),
        tripId,
        fo,
        wbType,
        parentWaybillId || '',
        'Suggested',
        false,
        '',
        '',
      ]);
      _auditLog('WAYBILL_SUGGEST', SHEET_WAYBILLS, nextId, '', number);
      return { id: nextId, waybillNumber: number };
    }
  }

  return prefixId
    ? _createSuggestedWaybill(tripId, prefixId, fo, wbType, parentWaybillId || null)
    : null;
}

/**
 * Advances the Last Sequence Number in the Waybill Prefixes sheet, keeping the
 * booklet's stored pad width. Only moves forward — a lower number is ignored,
 * which protects against out-of-order confirmations.
 *
 * Used by the confirmation path, where a dispatcher may key in a custom number
 * ahead of the counter. Suggestion goes through `_reserveWaybillSequence`,
 * which must not be skipped silently.
 *
 * @param {number} prefixId
 * @param {number} newSeqNumber
 */
function _updateWaybillPrefixSequence(prefixId, newSeqNumber) {
  const sheet   = _getSheet(SHEET_WB_PREFIXES);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());
  const rowIdx  = _findRowById(rows, headers, prefixId);
  if (rowIdx === -1) return;

  const current = Number(_val(rows[rowIdx], headers, 'Last Sequence Number')) || 0;
  if (newSeqNumber <= current) return;   // only advances, never regresses

  const pref = getWaybillPrefixes().find(p => Number(p.id) === Number(prefixId));
  _reserveWaybillSequence(prefixId, newSeqNumber, pref ? pref.sequenceWidth : 0);
}

/**
 * Deletes all non-confirmed waybill rows for a trip.
 * Used when an imported trip is deleted before confirmation.
 *
 * @param {number} tripId
 */
function _deleteSuggestedWaybillsForTrip(tripId) {
  const sheet   = _getSheet(SHEET_WAYBILLS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  // Iterate from bottom to avoid row-shift issues on deletion
  for (let i = rows.length - 1; i >= 1; i--) {
    const row     = rows[i];
    const rowTrip = _numOrNull(_val(row, headers, 'Trip ID'));
    if (Number(rowTrip) === Number(tripId) && !_isTrue(_val(row, headers, 'Locked'))) {
      sheet.deleteRow(i + 1);
    }
  }
}


// ============================================================
//  INTERNAL HELPERS — Trip carry-over logic
// ============================================================

/**
 * Creates a carry-over trip for the next business day.
 * Called automatically when a trip is marked as Redeliver, Foul Trip - For
 * Redeliver, or Backlog.
 *
 * A Backlog trip never left the yard (no crew at the scheduling cutoff), so it
 * has no waybill to carry a suffix from and re-enters the next day's planning
 * phase as Prepping instead of Scheduled.
 *
 * @param {Array}  originalRow   The raw row array from the Trips sheet
 * @param {Array}  headers       The header row array
 * @param {number} originalTripId
 * @param {string} statusReason  The status that triggered the carry-over
 * @returns {number} The new trip ID
 */
function _createCarryoverTrip(originalRow, headers, originalTripId, statusReason) {
  // Next day relative to the TRIP's date, not today — a status keyed in late
  // (or the morning after) must still carry over to the day after the trip.
  const nextDay = _nextBusinessDay(
    _readDateCell(_val(originalRow, headers, 'Trip Date')) || new Date());
  const nextDayStr = _formatDate(nextDay);
  const isBacklog = statusReason === 'Backlog';

  // Determine waybill type for the new trip's suggested waybill
  const waybillType = statusReason === 'Redeliver' ? 'Redeliver' : 'Foul Trip';

  // Find the confirmed waybill for the original trip (to get prefix and parent ID)
  const wbs           = isBacklog ? [] : getWaybillsForTrip(originalTripId);
  const confirmedWb   = wbs.find(w => w.locked) || wbs[0];
  const prefixId      = confirmedWb ? confirmedWb.prefixId : null;
  const parentWbId    = confirmedWb ? confirmedWb.id       : null;

  const foNumber       = _val(originalRow, headers, 'FO Number');
  const outletId       = _numOrNull(_val(originalRow, headers, 'Outlet ID'));
  const truckId        = _numOrNull(_val(originalRow, headers, 'Truck ID'));
  const driverId       = _numOrNull(_val(originalRow, headers, 'Driver ID'));
  const rawHelpers     = _val(originalRow, headers, 'Helper IDs');
  const helperIds      = rawHelpers ? String(rawHelpers).split(',').map(s => _numOrNull(s.trim())).filter(n => n !== null) : [];
  const billingCat     = _val(originalRow, headers, 'Truck Billing Category');
  const billingDate    = _val(originalRow, headers, 'Billing Date')
                        || _val(originalRow, headers, 'Trip Date');
  const area           = _val(originalRow, headers, 'Area');
  const tier           = _val(originalRow, headers, 'Tier');

  const sheet   = _getSheet(SHEET_TRIPS);
  _ensureTripColumns(sheet);
  const nextId  = _nextRowId(sheet);
  const email   = _getCurrentUserEmail();
  const now     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

  sheet.appendRow([
    nextId,
    nextDayStr,      // Trip Date = next business day
    billingDate,     // Billing Date = original date (preserved)
    foNumber,
    '',              // FO Split Suffix — blank for carry-over
    outletId,
    area,
    _val(originalRow, headers, 'Quantity'),
    _val(originalRow, headers, 'CBM'),
    _val(originalRow, headers, 'Restrictions'),
    truckId,
    driverId,
    helperIds.join(','),
    billingCat,
    isBacklog ? 'Prepping' : 'Scheduled',
    originalTripId,  // Parent Trip ID
    'Carry-over',
    tier,
    `Carried over from Trip ${originalTripId} (${statusReason})`,
    '',
    '',
    email,
    now,
    '',              // Convoy Group — a next-day carry-over leaves its convoy
    '',              // Sort Order — the new day orders its own board
    _val(originalRow, headers, 'Origin'),  // same load, same warehouse
  ]);

  // Suggest waybill with correct suffix. Re-read the Trips sheet so the row
  // just appended is visible: the sibling stops of a merged load carry over
  // one at a time, and each later one must join the first one's number.
  const freshRows    = sheet.getDataRange().getValues();
  const freshHeaders = freshRows[0].map(h => h.toString().trim());
  const newRowIdx    = _findRowById(freshRows, freshHeaders, nextId);
  if (newRowIdx !== -1) {
    _suggestWaybillForScheduledTrip(
      freshRows, freshHeaders, freshRows[newRowIdx], nextId, prefixId, waybillType, parentWbId);
  }

  // Update route frequency log
  if (driverId && outletId) {
    _appendRouteFrequency(nextId, nextDayStr, driverId, outletId);
  }

  _auditLog('TRIP_CREATE', SHEET_TRIPS, nextId, '',
    JSON.stringify({ parentTripId: originalTripId, reason: statusReason, tripDate: nextDayStr }));

  return nextId;
}


// ============================================================
//  INTERNAL HELPERS — Outlets
// ============================================================

/**
 * Finds an outlet by name (case-insensitive) or creates a new one.
 * Returns the outlet ID.
 *
 * @param {string} outletName
 * @param {string} area
 * @param {string} address
 * @returns {number} outletId
 */
function _resolveOrCreateOutlet(outletName, area, address) {
  if (!outletName) return '';

  const sheet   = _getSheet(SHEET_OUTLETS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  const nameLower = outletName.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const existing = String(_val(rows[i], headers, 'Outlet Name')).trim().toLowerCase();
    if (existing === nameLower) {
      return _numOrNull(_val(rows[i], headers, 'ID'));
    }
  }

  // Create new outlet
  const nextId = _nextRowId(sheet);
  const now    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
  sheet.appendRow([
    nextId,
    outletName.trim(),
    area    || '',
    address || '',
    '',   // Customer Group — blank until Admin fills in
    '',   // Notes
    now,
  ]);

  _auditLog('OUTLET_CREATE', SHEET_OUTLETS, nextId, '', outletName.trim());
  return nextId;
}


// ============================================================
//  INTERNAL HELPERS — Route Frequency Log
// ============================================================

/**
 * Appends a row to the Route Frequency Log.
 *
 * @param {number} tripId
 * @param {string} tripDate
 * @param {number} driverId
 * @param {number} outletId
 */
function _appendRouteFrequency(tripId, tripDate, driverId, outletId) {
  try {
    const sheet  = _getOrCreateSheet(SHEET_ROUTE_FREQ, ['ID', 'Trip ID', 'Trip Date', 'Driver ID', 'Outlet ID']);
    const nextId = _nextRowId(sheet);
    sheet.appendRow([nextId, tripId, tripDate, driverId, outletId]);
  } catch (_) {
    // Best-effort
  }
}


// ============================================================
//  INTERNAL HELPERS — Billing Categories
// ============================================================

/**
 * Resolves the billing category for a given truck ID by reading it
 * directly from the Trucks sheet.
 * @param {number} truckId
 * @returns {string}
 */
function _resolveBillingCategory(truckId) {
  if (!truckId) return '';
  const sheet   = _getSheet(SHEET_TRUCKS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  for (let i = 1; i < rows.length; i++) {
    if (Number(_val(rows[i], headers, 'ID')) === Number(truckId)) {
      return _val(rows[i], headers, 'Billing Category') || '';
    }
  }
  return '';
}

/**
 * Updates the Billing Category column on every Trucks row currently set to
 * oldName so it reads newName instead. Called when an Admin renames a
 * Billing Categories entry, keeping existing truck records in sync.
 *
 * @param {string} oldName
 * @param {string} newName
 */
function _renameTruckBillingCategory(oldName, newName) {
  const sheet   = _getSheet(SHEET_TRUCKS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());
  const colIdx  = headers.indexOf('Billing Category');
  if (colIdx === -1 || rows.length < 2) return;

  let changed = false;
  const colValues = rows.slice(1).map(row => {
    const val = String(row[colIdx]).trim() === oldName ? newName : row[colIdx];
    if (val !== row[colIdx]) changed = true;
    return [val];
  });

  if (changed) {
    sheet.getRange(2, colIdx + 1, colValues.length, 1).setValues(colValues);
  }
}


/**
 * Adds any Trips column this build writes but an older Sheet does not have
 * yet, and returns the header row.
 *
 * Every trip writer appends a fixed-width array, so a Sheet that predates a
 * column would either take the value in the wrong place or reject the range
 * outright. Same self-migration the Waybill Prefixes sheet does for
 * Sequence Width — see _reserveWaybillSequence.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {string[]} headers, including any column just added
 */
function _ensureTripColumns(sheet) {
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(h => h.toString().trim());
  ['Convoy Group', 'Sort Order', 'Origin'].forEach(col => {
    headers = _ensureColumn(sheet, headers, col);
  });
  return headers;
}


// ============================================================
//  BILLING — rate lookup and line computation
// ============================================================

/**
 * Normalizes an area name for matching. The rate matrix and the route files
 * disagree on case and punctuation for the same place — "Las PiNas" vs
 * "LAS PINAS", "Sta. Rosa" vs "STA ROSA" — so both sides compare on this key.
 *
 * @param {string} s
 * @returns {string} Uppercase, letters and digits only.
 */
function _normArea(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Returns the 1-based diesel price band for a price, clamped to the matrix.
 * Band 1 is 30.01-35, band 25 is 150.01-155. A price at or below the base
 * clamps to 1 and a price above the top clamps to 25, so a lookup can never
 * fall off the end of the matrix.
 *
 * @param {number} price  Peso price per liter.
 * @returns {number} 1..FUEL_BAND_COUNT
 */
function _fuelBandIndex(price) {
  const p = Number(price);
  if (!isFinite(p)) return 1;
  const i = Math.ceil((p - FUEL_BAND_BASE) / FUEL_BAND_WIDTH);
  return Math.min(Math.max(i, 1), FUEL_BAND_COUNT);
}

/**
 * Returns the Freight Rates column header for a band index, e.g. 8 -> '65.01-70'.
 * Kept in step with the 'Freight Rates' headers in test/fixtures.js.
 *
 * @param {number} bandIndex  1-based.
 * @returns {string}
 */
function _fuelBandLabel(bandIndex) {
  const lower = FUEL_BAND_BASE + FUEL_BAND_WIDTH * (bandIndex - 1);
  return `${lower}.01-${lower + FUEL_BAND_WIDTH}`;
}

/**
 * Returns the diesel price in force on a date: the newest Fuel Prices row
 * whose Effective Date is on or before it. Returns null when the sheet holds
 * no price that early — the caller flags the line rather than billing at zero.
 *
 * @param {Object[]} prices  From getFuelPrices(), newest first or any order.
 * @param {Date}     onDate
 * @returns {{ price: number, effectiveDate: string } | null}
 */
function _fuelPriceOn(prices, onDate) {
  const t = onDate ? onDate.getTime() : 0;
  let best = null;
  (prices || []).forEach(p => {
    // _parseDate('') answers today, which would let an undated row price
    // every past billing. A row with no Effective Date is not in force.
    if (!p.effectiveDate) return;
    const d = _parseDate(p.effectiveDate);
    if (!d || d.getTime() > t) return;
    if (!best || d.getTime() > _parseDate(best.effectiveDate).getTime()) best = p;
  });
  return best ? { price: best.dieselPrice, effectiveDate: best.effectiveDate } : null;
}

/**
 * Indexes rate rows for lookup by origin, area and truck type. Only the rows
 * whose Effective Date is on or before `onDate` are kept, and where a key has
 * several such blocks the newest one wins — that is the date lock: a rate
 * revision published today can never re-price a billing from last week.
 *
 * @param {Object[]} rates   From getFreightRates().
 * @param {Date}     onDate
 * @returns {Object} Map of 'ORIGIN|AREA|TYPE' -> rate row.
 */
function _indexRates(rates, onDate) {
  const t   = onDate ? onDate.getTime() : 0;
  const map = {};
  (rates || []).forEach(r => {
    if (!r.effectiveDate) return;   // undated rows are not in force — see _fuelPriceOn
    const eff = _parseDate(r.effectiveDate);
    if (!eff || eff.getTime() > t) return;
    const key = _normArea(r.origin) + '|' + _normArea(r.area) + '|' + _normArea(r.truckType);
    const cur = map[key];
    if (!cur || eff.getTime() > _parseDate(cur.effectiveDate).getTime()) map[key] = r;
  });
  return map;
}

/**
 * Looks one rate out of an index built by _indexRates.
 * Returns null when the combination has no rate — an unknown area, a truck
 * type the matrix does not carry, or an origin nobody has seeded yet.
 *
 * @param {Object} rateIndex
 * @param {string} origin
 * @param {string} area
 * @param {string} truckType
 * @param {number} bandIndex
 * @returns {number|null}
 */
function _rateFor(rateIndex, origin, area, truckType, bandIndex) {
  const row = rateIndex[_normArea(origin) + '|' + _normArea(area) + '|' + _normArea(truckType)];
  if (!row) return null;
  const v = row.bands[_fuelBandLabel(bandIndex)];
  return (v === null || v === undefined || v === '') ? null : Number(v);
}

/**
 * Computes one billing line from the trips that share a waybill.
 *
 * The load bills at the highest-rate drop, not the first: Rebisco pays the
 * farthest point of a multi-area route. Mano is a per-store fee, so it counts
 * full carton blocks on each drop separately and then sums. The drop fee is
 * flat once the load has DROP_FEE_MIN stops.
 *
 * Returns the computed money fields plus `warning`, which is set when no rate
 * matched — the panel shows the line flagged rather than billing it at zero.
 *
 * @param {Object[]} trips      Trip rows of one waybill (at least one).
 * @param {Object}   rateIndex  From _indexRates() for this line's Billing Date.
 * @param {number}   bandIndex
 * @returns {{ area: string, drops: number, cartons: number, haulingRate: number,
 *             mano: number, dropFee: number, warning: string }}
 */
function _computeBillingLine(trips, rateIndex, bandIndex) {
  const origin    = (trips[0] && trips[0].origin) || '';
  const truckType = (trips[0] && trips[0].truckBillingCategory) || '';

  let area = (trips[0] && trips[0].area) || '';
  let haulingRate = null;
  let cartons = 0;
  let mano    = 0;
  const unpriced = [];

  trips.forEach(t => {
    const qty = Number(t.quantity) || 0;
    cartons += qty;
    mano    += Math.floor(qty / MANO_CARTON_STEP) * MANO_FEE;

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
    area:        area,
    drops:       trips.length,
    cartons:     cartons,
    haulingRate: haulingRate === null ? 0 : haulingRate,
    mano:        mano,
    dropFee:     trips.length >= DROP_FEE_MIN ? DROP_FEE : 0,
    warning:     warning,
  };
}

/**
 * Sums the manual charge amounts on a billing line.
 * @param {Object} manualCharges  { chargeTypeId: amount }
 * @returns {number}
 */
function _sumManualCharges(manualCharges) {
  let sum = 0;
  Object.keys(manualCharges || {}).forEach(k => { sum += Number(manualCharges[k]) || 0; });
  return sum;
}

/**
 * Parses a JSON cell, returning `fallback` on anything unreadable. Sheet cells
 * get edited by hand, so a malformed blob must not take down a whole billing.
 *
 * @param {*} raw
 * @param {*} fallback
 * @returns {*}
 */
function _parseJsonCell(raw, fallback) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object') ? v : fallback;
  } catch (e) {
    return fallback;
  }
}
