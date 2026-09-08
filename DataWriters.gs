// ============================================================
//  AngeLoyal OMS — DataWriters.gs
//  All sheet-mutating endpoints. Multi-field row updates use
//  _writeRowFields() (one setValues() per row).
// ============================================================


// ============================================================
//  DATA WRITERS — Trips
// ============================================================

/**
 * Creates a new trip row from a Rebisco import payload.
 * Also auto-seeds the Outlets sheet with any new outlet names.
 * Also writes a suggested waybill row.
 * Also appends to Route Frequency Log — unless the trip is created 'Prepping',
 * in which case markDayScheduled logs it at promotion.
 *
 * @param {Object} tripData  Fields matching the Trips sheet columns.
 * @returns {{ success: boolean, tripId: number, waybillSuggested: string } | { success: false, error: string }}
 */
function createTrip(tripData) {
  _requirePermission('ADD_MANUAL_TRIP');
  try {
    // 1. Resolve or create outlet
    const outletId = _resolveOrCreateOutlet(
      tripData.outletName,
      tripData.area,
      tripData.address || ''
    );

    // 2. Resolve truck billing category snapshot
    const truckBillingCategory = _resolveBillingCategory(tripData.truckId) || tripData.truckBillingCategory || '';

    // 3. Write trip row
    const sheet   = _getSheet(SHEET_TRIPS);
    _ensureTripColumns(sheet);
    const nextId  = _nextRowId(sheet);
    const now     = new Date();
    const email   = _getCurrentUserEmail();
    const tz      = Session.getScriptTimeZone();

    const tripDate    = tripData.tripDate    || _formatDate(now);
    const billingDate = tripData.billingDate || tripDate;
    const tripStatus  = tripData.tripStatus  || 'Scheduled';

    sheet.appendRow([
      nextId,
      tripDate,
      billingDate,
      tripData.foNumber        || '',
      tripData.foSplitSuffix   || '',
      outletId,
      tripData.area            || '',
      tripData.quantity        || '',
      tripData.cbm             || '',
      tripData.restrictions    || '',
      tripData.truckId         || '',
      tripData.driverId        || '',
      Array.isArray(tripData.helperIds) ? tripData.helperIds.join(',') : (tripData.helperIds || ''),
      truckBillingCategory,
      tripStatus,
      tripData.parentTripId    || '',
      tripData.source          || 'Manual',
      tripData.tier            || '',
      tripData.remarks         || '',
      '',  // Status Changed By — set on first status change
      '',  // Status Changed At
      email,
      Utilities.formatDate(now, tz, 'M/d/yyyy HH:mm:ss'),
      tripData.convoyGroup     || '',
      '',                          // Sort Order — set by dragging the board
      tripData.origin          || '',
    ]);

    // 4. Write suggested waybill if a prefix is provided
    let waybillSuggested = '';
    if (tripData.prefixId) {
      const wb = _createSuggestedWaybill(nextId, tripData.prefixId, tripData.foNumber || '', 'Regular', null);
      waybillSuggested = wb.waybillNumber;
    }

    // 5. Append to Route Frequency Log — only once the trip is out of Prepping;
    //    a Prepping trip's crew is still being shuffled (markDayScheduled logs it).
    if (tripStatus !== 'Prepping' && tripData.driverId && outletId) {
      _appendRouteFrequency(nextId, tripDate, tripData.driverId, outletId);
    }

    // 6. Audit
    _auditLog('TRIP_CREATE', SHEET_TRIPS, nextId, '', JSON.stringify({ foNumber: tripData.foNumber, outletId, tripDate }));

    return { success: true, tripId: nextId, waybillSuggested };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Combined trip-edit endpoint: reassigns truck/driver/helpers and/or updates
 * trip status + remarks in a single read-modify-write pass over the Trips sheet.
 * Replaces the old reassignTrip() + updateTripStatus() pair (previously 2
 * round trips, each with multiple per-cell writes).
 *
 * - If `driverId` changes, checks the Route Frequency Log for the new
 *   driver/outlet combo and returns a `routeFrequencyWarning` if the
 *   driver will have been assigned to this outlet more than 5 times in
 *   the last 21 days (per schema rule), then logs the new assignment.
 * - If `tripStatus` becomes 'Foul Trip - For Redeliver', 'Redeliver' or
 *   'Backlog', creates the next-day carry-over trip as before.
 * - If a 'Prepping' trip is promoted to 'Scheduled' by hand (rather than via
 *   markDayScheduled) and `prefixId` is given, suggests its waybill too —
 *   unless the trip already has a waybill row.
 *
 * @param {number} tripId
 * @param {Object} changes  Any of: { truckId, driverId, helperIds, tripStatus, remarks, prefixId }
 * @returns {{ success: boolean, trip: Object, newTripId: number|null,
 *             routeFrequencyWarning: {outletName: string, count: number}|null }
 *           | { success: false, error: string }}
 */
function saveTripChanges(tripId, changes) {
  _requirePermission('ASSIGN_CREW');
  try {
    const sheet   = _getSheet(SHEET_TRIPS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, tripId);
    if (rowIdx === -1) throw new Error(`Trip ID ${tripId} not found.`);

    const row         = rows[rowIdx];
    const oldDriverId = _numOrNull(_val(row, headers, 'Driver ID'));
    const oldTruckId  = _numOrNull(_val(row, headers, 'Truck ID'));
    const oldStatus   = _val(row, headers, 'Trip Status');

    const updates = {};

    if (changes.truckId !== undefined) {
      updates['Truck ID'] = changes.truckId;
      // Truck Billing Category is the required truck type for the trip
      // (snapshotted at dispatch/import). Reassigning a physical truck must
      // NOT re-price the trip, so it is intentionally left untouched here.
    }
    if (changes.driverId !== undefined) {
      updates['Driver ID'] = changes.driverId;
    }
    if (changes.helperIds !== undefined) {
      updates['Helper IDs'] = Array.isArray(changes.helperIds)
        ? changes.helperIds.join(',')
        : (changes.helperIds || '');
    }
    if (changes.tripStatus !== undefined) {
      const email = _getCurrentUserEmail();
      const now   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
      updates['Trip Status']        = changes.tripStatus;
      updates['Status Changed By']  = email;
      updates['Status Changed At']  = now;
    }
    if (changes.remarks !== undefined && changes.remarks !== null) {
      updates['Remarks'] = changes.remarks;
    }

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    // Audit
    if (changes.truckId !== undefined || changes.driverId !== undefined || changes.helperIds !== undefined) {
      _auditLog('TRIP_REASSIGN', SHEET_TRIPS, tripId,
        JSON.stringify({ driverId: oldDriverId, truckId: oldTruckId }),
        JSON.stringify({ driverId: changes.driverId, truckId: changes.truckId }));
    }
    if (changes.tripStatus !== undefined) {
      _auditLog('TRIP_STATUS_CHANGE', SHEET_TRIPS, tripId, oldStatus, changes.tripStatus);
    }

    // Route frequency check + log. A trip only counts once it's out of Prepping:
    // imported trips land Prepping and get reassigned freely, so logging earlier
    // credits drivers for trips they never took. Logged on the transition out of
    // Prepping (this endpoint or markDayScheduled), and on later driver changes.
    const newStatus     = changes.tripStatus !== undefined ? changes.tripStatus : oldStatus;
    const newDriverId   = changes.driverId   !== undefined ? changes.driverId   : oldDriverId;
    const justScheduled = oldStatus === 'Prepping' && newStatus !== 'Prepping';
    const driverChanged = changes.driverId !== undefined && changes.driverId !== oldDriverId;

    let routeFrequencyWarning = null;
    if (newStatus !== 'Prepping' && newDriverId && (justScheduled || driverChanged)) {
      const outletId = _numOrNull(_val(row, headers, 'Outlet ID'));
      const tripDate = _formatDate(_readDateCell(_val(row, headers, 'Trip Date')));
      if (outletId) {
        const freq     = getRouteFrequencyForDriver(newDriverId);
        const existing = freq.find(f => f.outletId === Number(outletId));
        const newCount = (existing ? existing.count : 0) + 1;
        if (newCount > 5) {
          routeFrequencyWarning = {
            outletName: existing ? existing.outletName : '',
            count:      newCount,
          };
        }
        _appendRouteFrequency(tripId, tripDate, newDriverId, outletId);
      }
    }

    // Waybill: a Prepping trip promoted to Scheduled by hand still needs its
    // suggested waybill (markDayScheduled covers the whole-day path). A stop
    // whose load already has a suggested waybill joins that number; otherwise
    // a new number is reserved from `changes.prefixId`.
    let waybill = null;
    if (justScheduled && newStatus === 'Scheduled') {
      waybill = _suggestWaybillForScheduledTrip(rows, headers, row, tripId, changes.prefixId || null);
    }

    // Carry-over: create a follow-up trip for next business day
    let newTripId = null;
    const carryoverStatuses = ['Foul Trip - For Redeliver', 'Redeliver', 'Backlog'];
    if (changes.tripStatus !== undefined && carryoverStatuses.includes(changes.tripStatus)) {
      newTripId = _createCarryoverTrip(row, headers, tripId, changes.tripStatus);
    }

    const rawHelpers = _val(row, headers, 'Helper IDs');
    const helperIds  = rawHelpers
      ? String(rawHelpers).split(',').map(s => _numOrNull(s.trim())).filter(n => n !== null)
      : [];

    const tripOut = {
      id:                   tripId,
      truckId:              _numOrNull(_val(row, headers, 'Truck ID')),
      driverId:             _numOrNull(_val(row, headers, 'Driver ID')),
      helperIds:            helperIds,
      truckBillingCategory: _val(row, headers, 'Truck Billing Category') || '',
      tripStatus:           _val(row, headers, 'Trip Status') || 'Scheduled',
      remarks:              _val(row, headers, 'Remarks') || '',
      statusChangedBy:      _val(row, headers, 'Status Changed By') || '',
      statusChangedAt:      _valDateTime(row, headers, 'Status Changed At'),
    };
    // Only set when a waybill was suggested — Object.assign on the client
    // must not wipe existing waybill fields on unrelated saves.
    if (waybill) {
      tripOut.waybillSuggested   = waybill.waybillNumber;
      tripOut.suggestedWaybillId = waybill.id;
    }

    return {
      success: true,
      trip:                   tripOut,
      newTripId:              newTripId,
      routeFrequencyWarning:  routeFrequencyWarning,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Sets Trip Status on multiple trips in one call (bulk row-selection action
 * on the dispatch board). Reuses saveTripChanges per trip so the carry-over
 * spawn (_createCarryoverTrip), audit trail, and route-frequency check all
 * fire exactly as they do for a single-trip status change.
 *
 * @param {number[]} tripIds
 * @param {string}   status
 * @param {number}   [prefixId]  Waybill prefix for Prepping → Scheduled promotions
 * @returns {{ success: true, updated: number, newTripIds: number[] } | { success: false, error: string }}
 */
function bulkSetTripStatus(tripIds, status, prefixId) {
  _requirePermission('ASSIGN_CREW');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (ids.length === 0) throw new Error('No trips selected.');

    // Trips run sequentially, so a load's first stop reserves a number and
    // its later stops join it (see _suggestWaybillForScheduledTrip); stops
    // of different loads get distinct numbers.
    const changes = prefixId ? { tripStatus: status, prefixId: prefixId } : { tripStatus: status };
    const newTripIds = [];
    let updated = 0;
    ids.forEach(id => {
      const r = saveTripChanges(id, changes);
      if (r && r.success) {
        updated++;
        if (r.newTripId) newTripIds.push(r.newTripId);
      }
    });

    return { success: true, updated: updated, newTripIds: newTripIds };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Waybills
// ============================================================

/**
 * Confirms a waybill number (locking it permanently).
 * The dispatcher may pass a custom number; the system checks for duplicates.
 *
 * A multi-stop load has ONE waybill spread over one Waybill row per trip, all
 * carrying the same number/prefix/sequence (see `_suggestWaybillsForGroups`).
 * They are a single waybill, so confirming locks every row of it — confirming
 * one at a time would leave the rest of the load Suggested, and a second call
 * carrying the same custom number would trip the duplicate check below.
 *
 * @param {number} waybillId          The ID of any Suggested row of the waybill.
 * @param {string} [customNumber]     If provided, use this instead of the suggested number.
 * @returns {{ success: boolean, waybillNumber: string, confirmed: number }
 *           | { success: false, error: string }}
 */
function confirmWaybill(waybillId, customNumber) {
  _requirePermission('CONFIRM_WAYBILL');
  try {
    const sheet   = _getSheet(SHEET_WAYBILLS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, waybillId);
    if (rowIdx === -1) throw new Error(`Waybill ID ${waybillId} not found.`);

    const row    = rows[rowIdx];
    if (_isTrue(_val(row, headers, 'Locked'))) {
      throw new Error(`Waybill ${_val(row, headers, 'Waybill Number')} is already confirmed and locked.`);
    }

    const origNumber = _val(row, headers, 'Waybill Number');
    let finalNumber  = origNumber;
    const prefixId   = _numOrNull(_val(row, headers, 'Prefix ID'));
    let seqNumber    = _numOrNull(_val(row, headers, 'Sequence Number'));

    // Every unlocked row of THIS load. An already-locked sibling is left alone
    // rather than re-confirmed.
    const groupIdxs = _waybillGroupIdxs(rows, headers, rowIdx);

    // If dispatcher provided a custom number, validate and parse it
    if (customNumber && customNumber !== finalNumber) {
      // Check for duplicate confirmed waybills. This waybill's own rows are not
      // duplicates of each other — sharing the number is the point.
      const isDuplicate = rows.slice(1).some((r, i) => {
        if (groupIdxs.indexOf(i + 1) !== -1) return false; // this waybill's own rows
        return _val(r, headers, 'Waybill Number') === customNumber
            && _isTrue(_val(r, headers, 'Locked'));
      });
      if (isDuplicate) {
        throw new Error(`Waybill number "${customNumber}" is already confirmed and in use.`);
      }
      finalNumber = customNumber;
      // Parse sequence number from the custom number (numeric suffix)
      const match = customNumber.match(/(\d+)(?:-[A-Z]+)?$/);
      seqNumber   = match ? Number(match[1]) : seqNumber;

      // Log the override
      _auditLog('WAYBILL_OVERRIDE', SHEET_WAYBILLS, waybillId,
        origNumber, finalNumber);
    }

    // Lock every row of the waybill — one write per contiguous run of stops,
    // one append for the whole audit trail.
    const email   = _getCurrentUserEmail();
    const now     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
    const lockFields = {
      'Waybill Number':  finalNumber,
      'Sequence Number': seqNumber,
      'Status':          'Confirmed',
      'Locked':          true,
      'Confirmed By':    email,
      'Confirmed At':    now,
    };
    const audits = groupIdxs.map(i => {
      Object.keys(lockFields).forEach(col => {
        const c = headers.indexOf(col);
        if (c === -1) throw new Error(`Column "${col}" not found in sheet "${SHEET_WAYBILLS}".`);
        rows[i][c] = lockFields[col];
      });
      return {
        action: 'WAYBILL_CONFIRM', table: SHEET_WAYBILLS,
        rowId: _numOrNull(_val(rows[i], headers, 'ID')),
        oldValue: 'Suggested', newValue: finalNumber,
      };
    });
    _writeRowRuns(sheet, rows, groupIdxs);
    _auditLogBatch(audits);

    // Update Last Sequence Number in Waybill Prefixes
    if (prefixId && seqNumber) {
      _updateWaybillPrefixSequence(prefixId, seqNumber);
    }

    return { success: true, waybillNumber: finalNumber, confirmed: groupIdxs.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


/**
 * Renames still-Suggested waybills (and every unlocked stop that shares each
 * one's number) WITHOUT confirming them — the pre-confirmation edit a
 * dispatcher needs when a load's booklet series differs from the auto-suggested
 * one. Locked (confirmed) waybills are immutable and rejected here; use
 * confirmWaybill to lock. Mirrors confirmWaybill's number parsing + duplicate
 * guard, minus the lock and Confirmed By/At stamps, so the row stays editable.
 *
 * Batched because a dispatcher renumbers a whole column by hand: every edit
 * used to be its own request, and each one paid a round trip, a Users read, a
 * full ledger read, a booklet-counter read and a script-lock wait — in series,
 * because writers queue. One request now pays that once. Edits apply to the
 * in-memory ledger in order, so a later edit sees an earlier one.
 *
 * One bad edit does not sink the batch: it reports its own error and the rest
 * still land.
 *
 * @param {Array<{waybillId: number, number: string}>} edits
 * @returns {{ success: boolean, results: Array<{waybillId: number, success: boolean,
 *             waybillNumber?: string, updated?: number, error?: string }> }}
 */
function updateSuggestedWaybills(edits) {
  _requirePermission('CONFIRM_WAYBILL');

  const list = edits || [];
  if (list.length === 0) return { success: true, results: [] };

  const sheet   = _getSheet(SHEET_WAYBILLS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  const results  = [];
  const audits   = [];
  const dirty    = {};        // rowIdx -> true, deduped across edits
  const maxSeq   = {};        // prefixId -> highest sequence this batch issued

  list.forEach(edit => {
    const waybillId = edit && edit.waybillId;
    try {
      const rowIdx = _findRowById(rows, headers, waybillId);
      if (rowIdx === -1) throw new Error(`Waybill ID ${waybillId} not found.`);

      const row = rows[rowIdx];
      if (_isTrue(_val(row, headers, 'Locked'))) {
        throw new Error(`Waybill ${_val(row, headers, 'Waybill Number')} is already confirmed and locked.`);
      }

      const finalNumber = (edit.number == null ? '' : edit.number).toString().trim();
      if (!finalNumber) throw new Error('Waybill number cannot be blank.');

      const origNumber = _val(row, headers, 'Waybill Number');
      const prefixId   = _numOrNull(_val(row, headers, 'Prefix ID'));
      const origSeq    = _numOrNull(_val(row, headers, 'Sequence Number'));

      // Every unlocked row of THIS load — one load's stops share the number and
      // must be renamed together. A stop of ANOTHER load must not move.
      const groupIdxs = _waybillGroupIdxs(rows, headers, rowIdx);

      if (finalNumber === origNumber) {
        results.push({ waybillId, success: true, waybillNumber: origNumber, updated: 0 });
        return;
      }

      // A confirmed waybill already owns this number → refuse (matches confirm).
      // Suggested siblings sharing a number are legitimate and not duplicates.
      const clash = rows.slice(1).some((r, i) => {
        if (groupIdxs.indexOf(i + 1) !== -1) return false;
        return _val(r, headers, 'Waybill Number') === finalNumber
            && _isTrue(_val(r, headers, 'Locked'));
      });
      if (clash) throw new Error(`Waybill number "${finalNumber}" is already confirmed and in use.`);

      // Parse the sequence from the custom number (numeric tail), like confirm.
      const match  = finalNumber.match(/(\d+)(?:-[A-Z]+)?$/);
      const seqNum = match ? Number(match[1]) : origSeq;

      const numIdx = headers.indexOf('Waybill Number');
      const seqIdx = headers.indexOf('Sequence Number');
      groupIdxs.forEach(i => {
        rows[i][numIdx] = finalNumber;
        rows[i][seqIdx] = seqNum;
        dirty[i] = true;
      });
      audits.push({
        action: 'WAYBILL_OVERRIDE', table: SHEET_WAYBILLS,
        rowId: waybillId, oldValue: origNumber, newValue: finalNumber,
      });
      if (prefixId && seqNum && seqNum > (maxSeq[prefixId] || 0)) maxSeq[prefixId] = seqNum;

      results.push({ waybillId, success: true, waybillNumber: finalNumber, updated: groupIdxs.length });
    } catch (e) {
      results.push({ waybillId: waybillId, success: false, error: e.message });
    }
  });

  const dirtyIdxs = Object.keys(dirty).map(Number);
  if (dirtyIdxs.length) _writeRowRuns(sheet, rows, dirtyIdxs);
  _auditLogBatch(audits);

  // Keep the booklet counter ahead of an edit that raises the number, so a
  // later suggestion can't re-issue it. Only advances (see the helper), so the
  // batch's highest number per booklet is the only one worth writing.
  Object.keys(maxSeq).forEach(prefixId => _updateWaybillPrefixSequence(Number(prefixId), maxSeq[prefixId]));

  return { success: true, results: results };
}

/**
 * One-edit form of `updateSuggestedWaybills`. The board sends the batch now, but
 * `.gs` and `web/` deploy separately (clasp vs wrangler), so a page cached from
 * before the batch landed still calls this name.
 *
 * @param {number} waybillId
 * @param {string} newNumber
 * @returns {{ success: boolean, waybillNumber: string, updated: number } | { success: false, error: string }}
 */
function updateSuggestedWaybill(waybillId, newNumber) {
  const r = updateSuggestedWaybills([{ waybillId: waybillId, number: newNumber }]).results[0];
  return r.success
    ? { success: true, waybillNumber: r.waybillNumber, updated: r.updated }
    : { success: false, error: r.error };
}


// ============================================================
//  DATA WRITERS — Rebisco Route File Import
// ============================================================

/**
 * Imports a parsed Rebisco route file for a given date.
 * Accepts an array of row objects pre-parsed from the Excel file on the client.
 * All rows are imported; the dispatcher filters/deletes non-applicable ones in the UI.
 *
 * Expected rowData fields:
 *   foNumber, outletName, area, address, quantity, cbm, restrictions, tier,
 *   slots        — [{ type, count }] from the file's truck-type columns (e.g. 6WC×2),
 *   convoyGroup  — optional batch index from the file's fill-color runs; rows
 *                  sharing it must travel together (convoy / split load). Tokens
 *                  are offset by the date's existing maximum so re-imports on the
 *                  same day never collide.
 *
 * Each row is a delivery drop. Rows are grouped by FO Number; one FO can span
 * several outlet rows (one truck, multiple stops) and/or request several trucks
 * (split load). For each FO:
 *   - Truck slots are expanded (one per truck needed) and each slot's type code
 *     is mapped to a Billing Category via the Route Type Map, then to the next
 *     free truck of that category (no double-booking within the date).
 *   - The primary truck visits every outlet row of the FO — one multi-drop
 *     load. Each additional truck rides the FO's first outlet (split load).
 *   - Outlets are auto-seeded; default driver/helpers are pre-filled per truck.
 *   - "Restrictions" stores the client's requested constraint (file column);
 *     "Truck Billing Category" stores the required/assigned truck type.
 *
 * Trips land in 'Prepping' with NO waybills: the dispatcher regroups and
 * reassigns freely, then markDayScheduled promotes the day and suggests the
 * waybills (one per truck load — same FO + same truck = same waybill).
 *
 * Unlike createTrip (used for single manual trips), this writes each affected
 * sheet in one batch at the end instead of once per row — needed because a
 * 44-row import previously meant 400+ individual Sheets API calls.
 *
 * An FO already present on the date is a re-import and is skipped whole —
 * the response can be lost after the write lands, and the retry used to append
 * the file a second and third time.
 *
 * One route file covers one Rebisco warehouse, so the origin is chosen once in
 * the Import panel and stamped on every trip the file creates. Billing reads it
 * back to pick the right sheet of the Freight Rates matrix.
 *
 * @param {string}   tripDate   'M/d/yyyy' — the date these trips are for
 * @param {Object[]} rowData    Array of parsed route rows
 * @param {string}   [origin]   Warehouse the file departs from (e.g. 'TANZA')
 * @returns {{ success: boolean, imported: number, skipped: number, duplicates: number, errors: string[],
 *             newOutlets: { id: number, outletName: string, area: string, address: string,
 *                           customerGroup: string, notes: string }[] }}
 */
function importRouteFile(tripDate, rowData, origin) {
  _requirePermission('ADD_MANUAL_TRIP');
  origin = String(origin || '').trim();
  try {
    const defaults       = getDefaultAssignments();
    const trucks         = getTrucks();
    const typeToCategory = getRouteTypeCategoryLookup();   // { FILECODE: 'Billing Category' }

    // Pool of available (active) trucks per uppercased billing category,
    // ordered by ID so allocation is deterministic.
    const trucksByCategory = {};
    trucks.filter(t => t.active).forEach(t => {
      const cat = String(t.billingCategory || '').toUpperCase();
      (trucksByCategory[cat] = trucksByCategory[cat] || []).push(t);
    });
    Object.keys(trucksByCategory).forEach(c => trucksByCategory[c].sort((a, b) => a.id - b.id));

    const defaultByTruck = {};
    defaults.forEach(d => { defaultByTruck[d.truckId] = d; });

    // Trucks already committed on this date (existing trips) — never double-book.
    // Same pass finds the highest convoy token already used on the date, so a
    // second import's batch tokens don't collide with the first's, and records
    // which FOs the date already holds (see importedFOs below).
    const usedTruckIds = {};
    const existingFOs  = {};
    let convoyTokenBase = 0;
    getTrips(tripDate, tripDate).forEach(t => {
      if (t.truckId) usedTruckIds[t.truckId] = true;
      const cg = Number(t.convoyGroup);
      if (cg > convoyTokenBase) convoyTokenBase = cg;
      const fo = String(t.foNumber || '').trim();
      if (fo) existingFOs[fo] = true;
    });

    // Resolve a file type code (e.g. "4WC") → billing category → next free truck.
    // Returns { truck, category }; truck is null when none are free, but the
    // required category is still reported for the trip's snapshot.
    const allocateTruck = (typeCode) => {
      const code     = String(typeCode || '').toUpperCase();
      const category = code ? (typeToCategory[code] || code) : '';
      const pool     = trucksByCategory[String(category).toUpperCase()] || [];
      let chosen     = null;
      for (let i = 0; i < pool.length; i++) {
        if (!usedTruckIds[pool[i].id]) { chosen = pool[i]; break; }
      }
      if (chosen) usedTruckIds[chosen.id] = true;
      return { truck: chosen, category: category };
    };

    const email  = _getCurrentUserEmail();
    const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

    // --- Outlets: read once, build a name → ID lookup we can extend in-memory ---
    const outletsSheet   = _getSheet(SHEET_OUTLETS);
    const outletsRows    = outletsSheet.getDataRange().getValues();
    const outletsHeaders = outletsRows[0].map(h => h.toString().trim());
    const outletNameToId = {};
    outletsRows.slice(1).forEach(row => {
      const id   = _numOrNull(_val(row, outletsHeaders, 'ID'));
      const name = String(_val(row, outletsHeaders, 'Outlet Name')).trim().toLowerCase();
      if (id !== null && name) outletNameToId[name] = id;
    });
    let nextOutletId = _nextRowId(outletsSheet);
    const newOutletRows = [];
    // Returned to the client so it can merge these into its cached outlet
    // list without a full reboot — otherwise newly-created outlets show
    // blank on the Dispatch board until the next page load.
    const newOutlets = [];

    const resolveOutlet = (rd) => {
      if (!rd.outletName) return '';
      const nameLower = rd.outletName.trim().toLowerCase();
      if (outletNameToId[nameLower] !== undefined) return outletNameToId[nameLower];
      const id = nextOutletId++;
      outletNameToId[nameLower] = id;
      const name = rd.outletName.trim();
      const area = rd.area || '';
      const address = rd.address || '';
      const customerGroup = rd.customer || '';
      newOutletRows.push([id, name, area, address, customerGroup, '', nowStr]);
      newOutlets.push({ id, outletName: name, area, address, customerGroup, notes: '' });
      return id;
    };

    // --- Next IDs for the sheets we'll append to ---
    const tripsSheet = _getSheet(SHEET_TRIPS);
    _ensureTripColumns(tripsSheet);
    const auditSheet = _getSheet(SHEET_AUDIT);
    let nextTripId  = _nextRowId(tripsSheet);
    let nextAuditId = _nextRowId(auditSheet);

    const newTripRows  = [];
    const newAuditRows = [];

    let imported   = 0;
    let skipped    = 0;
    let duplicates = 0;     // drops dropped because their FO is already on the date
    const errors   = [];

    // Creates one trip row and returns its ID. No waybills yet — imported
    // trips land in 'Prepping'; markDayScheduled suggests the waybills
    // once the dispatcher promotes the day.
    const emitTrip = (rd, outletId, slotTruck, category) => {
      const truckId   = slotTruck ? slotTruck.id : '';
      const def       = slotTruck ? defaultByTruck[slotTruck.id] : null;
      const driverId  = def ? def.defaultDriverId : '';
      const helperIds = def ? def.defaultHelperIds : [];

      const tripId = nextTripId++;
      newTripRows.push([
        tripId,
        tripDate,
        tripDate,                // Billing Date = Trip Date on import
        rd.foNumber || '',
        '',                      // FO Split Suffix
        outletId,
        rd.area     || '',
        rd.quantity || '',
        rd.cbm      || '',
        rd.restrictions || '',   // client-requested constraint (file column)
        truckId,
        driverId,
        Array.isArray(helperIds) ? helperIds.join(',') : (helperIds || ''),
        category || '',          // required/assigned truck type
        'Prepping',
        '',                      // Parent Trip ID
        'Import',
        rd.tier || '',
        '',                      // Remarks
        '',                      // Status Changed By
        '',                      // Status Changed At
        email,
        nowStr,
        rd.convoyGroup ? String(convoyTokenBase + Number(rd.convoyGroup)) : '',
        '',                      // Sort Order — set later by dragging the board
        origin,                  // selects the Freight Rates sheet at billing time
      ]);

      newAuditRows.push([
        nextAuditId++,
        nowStr,
        email || 'unknown',
        'TRIP_CREATE',
        '',
        SHEET_TRIPS,
        tripId,
        '',
        JSON.stringify({ foNumber: rd.foNumber || '', outletId, tripDate }),
      ]);

      imported++;
      return tripId;
    };

    // --- Group rows by FO (first-seen order). Rows with no FO each stand alone. ---
    const groups    = [];
    const groupByFO = {};
    rowData.forEach(rd => {
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

    groups.forEach(g => {
      try {
        // Idempotency. The transport cannot guarantee the client sees the
        // response: a long import that times out on the way back is written
        // all the same, and the dispatcher retries. Three retries once put
        // three copies of a whole route file on one board. An FO already on
        // the date is therefore a re-import, not new work — skip it.
        // Blank-FO rows have no key, so they are never deduped.
        // ponytail: per-FO, not per-row. A corrected file that adds a stop to
        // an FO already imported needs that stop keyed in by hand; today it
        // silently duplicated the whole FO instead.
        const foKey = String(g.foNumber || '').trim();
        if (foKey && existingFOs[foKey]) {
          duplicates += g.rows.length;
          skipped    += g.rows.length;
          return;
        }
        if (foKey) existingFOs[foKey] = true;

        // Expand truck slots: one entry per truck needed across the FO's rows.
        const slotTypes = [];
        g.rows.forEach(rd => (rd.slots || []).forEach(s => {
          for (let k = 0; k < (s.count || 1); k++) slotTypes.push(s.type);
        }));
        // FOs with no type column still get one (possibly unassigned) slot so
        // their outlet rows still produce trips and a waybill.
        if (slotTypes.length === 0) slotTypes.push('');

        // Allocate a truck for every slot.
        const slots = slotTypes.map(type => allocateTruck(type));

        const primary = slots[0];

        // Primary truck visits every outlet row — one multi-drop load.
        g.rows.forEach(rd => {
          const outletId = resolveOutlet(rd);
          emitTrip(rd, outletId, primary.truck, primary.category);
        });

        // Additional trucks (split load) ride the first outlet.
        const firstRow      = g.rows[0];
        const firstOutletId = resolveOutlet(firstRow);
        for (let s = 1; s < slots.length; s++) {
          emitTrip(firstRow, firstOutletId, slots[s].truck, slots[s].category);
        }
      } catch (rowErr) {
        errors.push(`FO ${g.foNumber || '(none)'}: ${rowErr.message}`);
        skipped++;
      }
    });

    _appendRows(outletsSheet, newOutletRows);
    _appendRows(tripsSheet, newTripRows);
    _appendRows(auditSheet, newAuditRows);

    return { success: true, imported, skipped, duplicates, errors, newOutlets };
  } catch (e) {
    return { success: false, imported: 0, skipped: 0, duplicates: 0, errors: [e.message] };
  }
}

/**
 * Deletes a trip row that is not applicable (any source: imported, manual,
 * or a carry-over spawned from a mis-set status).
 * Only allowed before the trip has a confirmed waybill.
 * This is the only genuine delete in the system.
 *
 * @param {number} tripId
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function deleteImportedTrip(tripId) {
  _requirePermission('ADD_MANUAL_TRIP');
  try {
    // Safety: refuse to delete if trip has a confirmed waybill
    const wbs = getWaybillsForTrip(tripId);
    if (wbs.some(w => w.locked)) {
      throw new Error('Cannot delete a trip with a confirmed waybill. Use Trip Status instead.');
    }

    const sheet   = _getSheet(SHEET_TRIPS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());
    const rowIdx  = _findRowById(rows, headers, tripId);
    if (rowIdx === -1) throw new Error(`Trip ID ${tripId} not found.`);

    sheet.deleteRow(rowIdx + 1);

    // Also delete any suggested (not confirmed) waybill rows for this trip
    _deleteSuggestedWaybillsForTrip(tripId);

    _auditLog('TRIP_DELETE', SHEET_TRIPS, tripId, 'Trip deleted (pre-confirmation)', '');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Deletes several trips in one call (bulk row-selection action on the dispatch
 * board). Reuses deleteImportedTrip per id, so the confirmed-waybill guard,
 * the suggested-waybill cleanup and the audit trail behave exactly as they do
 * for the per-row delete.
 *
 * A trip that refuses to delete does not abort the rest: the caller gets back
 * how many went and which ones stayed, so the board can say why.
 *
 * ponytail: one sheet read + deleteRow per trip. A dispatcher clears a handful
 * of rows at a time; batch the row removal only if someone starts deleting a
 * whole board.
 *
 * @param {number[]} tripIds
 * @returns {{ success: true, deleted: number, blocked: { tripId: number, error: string }[] }
 *          | { success: false, error: string }}
 */
function bulkDeleteTrips(tripIds) {
  _requirePermission('ADD_MANUAL_TRIP');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (ids.length === 0) throw new Error('No trips selected.');

    let deleted = 0;
    const blocked = [];
    ids.forEach(id => {
      const r = deleteImportedTrip(id);
      if (r && r.success) deleted++;
      else blocked.push({ tripId: id, error: (r && r.error) || 'Delete failed.' });
    });

    return { success: true, deleted: deleted, blocked: blocked };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


/**
 * Promotes every 'Prepping' trip on a date to 'Scheduled' and suggests
 * their waybills — the end of the planning phase started by importRouteFile.
 *
 * Prepping trips still without a crew at this point aren't going out today:
 * they're marked 'Backlog' instead and carried over to the next business day
 * (as fresh Prepping trips), so they don't get a waybill or count as scheduled.
 *
 * Waybills are grouped by (FO Number, Truck ID): a truck's several drops on
 * one FO share one waybill; each truck of a split FO gets its own. Trips
 * with no FO Number each get their own waybill. Trips that already have a
 * waybill row are skipped, so a second click is a no-op.
 *
 * @param {string} tripDate  'M/d/yyyy'
 * @param {number} prefixId  Waybill prefix for the suggested numbers
 * @returns {{ success: boolean, promoted: number, waybillsSuggested: number,
 *             backlogged: number, newTripIds: number[] }
 *           | { success: false, error: string }}
 */
function markDayScheduled(tripDate, prefixId) {
  _requirePermission('ADD_MANUAL_TRIP');
  try {
    if (!getWaybillPrefixes().some(p => Number(p.id) === Number(prefixId))) {
      throw new Error(`Waybill prefix ID ${prefixId} not found.`);
    }

    const sheet   = _getSheet(SHEET_TRIPS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const promoted   = [];  // { rowIdx, tripId, foNumber, truckId, driverId, outletId } → Scheduled
    const backlogged = [];  // same, but no crew → Backlog + next-day carry-over
    rows.forEach((row, i) => {
      if (i === 0) return;
      if (_val(row, headers, 'Trip Status') !== 'Prepping') return;
      if (_formatDate(_readDateCell(_val(row, headers, 'Trip Date'))) !== tripDate) return;
      const rec = {
        rowIdx:   i,
        tripId:   _numOrNull(_val(row, headers, 'ID')),
        foNumber: String(_val(row, headers, 'FO Number') || ''),
        truckId:  _numOrNull(_val(row, headers, 'Truck ID')),
        driverId: _numOrNull(_val(row, headers, 'Driver ID')),
        outletId: _numOrNull(_val(row, headers, 'Outlet ID')),
      };
      (rec.truckId || rec.driverId ? promoted : backlogged).push(rec);
    });

    if (promoted.length === 0 && backlogged.length === 0) {
      return { success: true, promoted: 0, waybillsSuggested: 0, backlogged: 0, newTripIds: [] };
    }

    // Batch the status stamps: mutate the in-memory rows, write back the
    // span between the first and last affected row in one setValues call
    // (imported rows are contiguous, so the span is tight in practice).
    const email  = _getCurrentUserEmail();
    const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
    const colOf  = (name) => headers.indexOf(name);
    const touched = promoted.concat(backlogged).sort((a, b) => a.rowIdx - b.rowIdx);
    const statusOf = (p) => (p.truckId || p.driverId ? 'Scheduled' : 'Backlog');
    touched.forEach(p => {
      rows[p.rowIdx][colOf('Trip Status')]       = statusOf(p);
      rows[p.rowIdx][colOf('Status Changed By')] = email;
      rows[p.rowIdx][colOf('Status Changed At')] = nowStr;
    });
    const minIdx = touched[0].rowIdx;
    const maxIdx = touched[touched.length - 1].rowIdx;
    sheet.getRange(minIdx + 1, 1, maxIdx - minIdx + 1, headers.length)
      .setValues(rows.slice(minIdx, maxIdx + 1));

    // Batched audit rows (mirrors importRouteFile's batching rationale).
    const auditSheet  = _getSheet(SHEET_AUDIT);
    let   nextAuditId = _nextRowId(auditSheet);
    _appendRows(auditSheet, touched.map(p =>
      [nextAuditId++, nowStr, email || 'unknown', 'TRIP_STATUS_CHANGE', '', SHEET_TRIPS, p.tripId, 'Prepping', statusOf(p)]
    ));

    // Backlogged trips get their next-day copy. Reuses the same helper as a
    // Redeliver/Foul carry-over, so parenting, audit and remarks all match.
    const newTripIds = backlogged.map(p =>
      _createCarryoverTrip(rows[p.rowIdx], headers, p.tripId, 'Backlog'));

    // Route frequency is logged here rather than at import: a Prepping trip's
    // crew is still being shuffled, so only the promoted assignment ran.
    // ponytail: no over-threshold warning on bulk promotion — the dispatcher
    // gets one per driver reassignment already. Add if they ask to see it here.
    const freqSheet = _getOrCreateSheet(SHEET_ROUTE_FREQ, ['ID', 'Trip ID', 'Trip Date', 'Driver ID', 'Outlet ID']);
    let nextFreqId  = _nextRowId(freqSheet);
    _appendRows(freqSheet, promoted
      .filter(p => p.driverId && p.outletId)
      .map(p => [nextFreqId++, p.tripId, tripDate, p.driverId, p.outletId]));

    // Suggest waybills: skip trips that already have a waybill row.
    const wbSheet   = _getSheet(SHEET_WAYBILLS);
    const wbRows    = wbSheet.getDataRange().getValues();
    const wbHeaders = wbRows[0].map(h => h.toString().trim());
    const hasWaybill = {};
    wbRows.slice(1).forEach(row => {
      const t = _numOrNull(_val(row, wbHeaders, 'Trip ID'));
      if (t !== null) hasWaybill[t] = true;
    });

    const groups  = [];
    const byKey   = {};
    promoted.forEach(p => {
      if (hasWaybill[p.tripId]) return;
      const key = p.foNumber ? `${p.foNumber}|${p.truckId || ''}` : `solo|${p.tripId}`;
      if (!byKey[key]) {
        byKey[key] = { foNumber: p.foNumber, tripIds: [] };
        groups.push(byKey[key]);
      }
      byKey[key].tripIds.push(p.tripId);
    });
    _suggestWaybillsForGroups(prefixId, groups);

    // groups.length = distinct waybill numbers (every group has ≥1 trip)
    return {
      success:           true,
      promoted:          promoted.length,
      waybillsSuggested: groups.length,
      backlogged:        backlogged.length,
      newTripIds:        newTripIds,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


/**
 * Groups or ungroups trips as a convoy (trucks that must travel together).
 * 'group' mints a fresh token — (max numeric Convoy Group on the trips'
 * date) + 1 — and stamps it on every trip; 'ungroup' blanks the column.
 * All trips must share one Trip Date.
 *
 * @param {number[]} tripIds
 * @param {'group'|'ungroup'} action
 * @returns {{ success: boolean, group: string } | { success: false, error: string }}
 */
function setTripConvoyGroup(tripIds, action) {
  _requirePermission('ASSIGN_CREW');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (ids.length === 0) throw new Error('No trips selected.');
    if (action === 'group' && ids.length < 2) {
      throw new Error('Select at least two trips to form a convoy.');
    }

    const sheet   = _getSheet(SHEET_TRIPS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const targets = [];
    let tripDate = null;
    ids.forEach(id => {
      const rowIdx = _findRowById(rows, headers, id);
      if (rowIdx === -1) throw new Error(`Trip ID ${id} not found.`);
      const d = _formatDate(_readDateCell(_val(rows[rowIdx], headers, 'Trip Date')));
      if (tripDate === null) tripDate = d;
      else if (d !== tripDate) throw new Error('All trips in a convoy must share one Trip Date.');
      targets.push({ id, rowIdx });
    });

    let group = '';
    if (action === 'group') {
      let maxToken = 0;
      rows.slice(1).forEach(row => {
        if (_formatDate(_readDateCell(_val(row, headers, 'Trip Date'))) !== tripDate) return;
        const t = Number(_val(row, headers, 'Convoy Group'));
        if (t > maxToken) maxToken = t;
      });
      group = String(maxToken + 1);
    }

    targets.forEach(t => {
      const old = String(_val(rows[t.rowIdx], headers, 'Convoy Group') || '');
      _writeRowFields(sheet, rows[t.rowIdx], t.rowIdx, headers, { 'Convoy Group': group });
      _auditLog('TRIP_CONVOY_CHANGE', SHEET_TRIPS, t.id, old, group);
    });

    return { success: true, group };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Persists the dispatcher's manual row order for a Trip Date. Writes
 * `Sort Order = index * 10` (leaving gaps for future manual nudges) for each
 * id in `orderedTripIds`, in order. Purely presentational — not audited.
 *
 * @param {string}   dateStr         'M/d/yyyy' — unused beyond intent; every
 *                                   id is trusted as belonging to that date
 *                                   (the client only ever sends the day it has loaded).
 * @param {number[]} orderedTripIds  Full ordered list of trip ids for the day.
 * @returns {{ success: true } | { success: false, error: string }}
 */
function reorderTrips(dateStr, orderedTripIds) {
  _requirePermission('ASSIGN_CREW');
  try {
    const ids = (orderedTripIds || []).map(Number).filter(Boolean);
    if (ids.length === 0) throw new Error('No trips to reorder.');

    const sheet   = _getSheet(SHEET_TRIPS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    ids.forEach((id, i) => {
      const rowIdx = _findRowById(rows, headers, id);
      if (rowIdx === -1) throw new Error(`Trip ID ${id} not found.`);
      _writeRowFields(sheet, rows[rowIdx], rowIdx, headers, { 'Sort Order': i * 10 });
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Default Assignments (the truck roster; Admin + Dispatcher)
// ============================================================

/**
 * Updates the default driver and/or helpers for a truck.
 * This only affects future dispatch pre-fills, not existing trips.
 *
 * @param {number} defaultAssignId   ID in the Default Assignments sheet
 * @param {Object} changes           { defaultDriverId?, defaultHelperIds?, notes? }
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function updateDefaultAssignment(defaultAssignId, changes) {
  _requirePermission('ASSIGN_CREW');
  try {
    const sheet   = _getSheet(SHEET_DEFAULT_ASSIGN);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, defaultAssignId);
    if (rowIdx === -1) throw new Error(`Default Assignment ID ${defaultAssignId} not found.`);

    const row        = rows[rowIdx];
    const oldDriver  = _val(row, headers, 'Default Driver ID');
    const oldHelpers = _val(row, headers, 'Default Helper IDs');

    const updates = {};
    if (changes.defaultDriverId !== undefined) {
      updates['Default Driver ID'] = changes.defaultDriverId;
    }
    if (changes.defaultHelperIds !== undefined) {
      updates['Default Helper IDs'] = Array.isArray(changes.defaultHelperIds)
        ? changes.defaultHelperIds.join(',')
        : (changes.defaultHelperIds || '');
    }
    if (changes.notes !== undefined) {
      updates['Notes'] = changes.notes;
    }

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    _auditLog('DEFAULT_ASSIGN_CHANGE', SHEET_DEFAULT_ASSIGN, defaultAssignId,
      JSON.stringify({ driverId: oldDriver, helperIds: oldHelpers }),
      JSON.stringify(changes));

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Master records (Admin / Dispatcher)
//
//  Every endpoint below is the same read-modify-write shape, so the
//  mechanical half lives in Utils.gs (_openSheet / _openRow / _readFields /
//  _writerResult / _requireUnique) and only the per-record validation is
//  written out here. The *_FIELDS maps are the single declaration of which
//  sheet column backs which camelCase key — used for both the audit snapshot
//  and the read-back.
// ============================================================


// ============================================================
//  Outlets (Admin only)
// ============================================================

const OUTLET_FIELDS = {
  outletName:    'Outlet Name',
  area:          'Area',
  address:       'Address',
  customerGroup: 'Customer Group',
  notes:         'Notes',
};

/**
 * Creates a new outlet record.
 * @param {Object} data  { outletName, area, address, customerGroup, notes }
 * @returns {{ success: boolean, outlet: Object } | { success: false, error: string }}
 */
function createOutlet(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const outletName = String(data.outletName || '').trim();
    if (!outletName) throw new Error('Outlet name is required.');

    const area          = String(data.area          || '').trim();
    const address       = String(data.address       || '').trim();
    const customerGroup = String(data.customerGroup || '').trim();
    const notes         = String(data.notes         || '').trim();

    const sheet  = _getSheet(SHEET_OUTLETS);
    const nextId = _nextRowId(sheet);
    sheet.appendRow([nextId, outletName, area, address, customerGroup, notes, new Date()]);

    _auditLog('OUTLET_CREATE', SHEET_OUTLETS, nextId, '', outletName);
    return { outlet: { id: nextId, outletName, area, address, customerGroup, notes } };
  });
}

/**
 * Updates an outlet record.
 * @param {number} outletId
 * @param {Object} changes  Any of { outletName, area, address, customerGroup, notes }
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function updateOutlet(outletId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const ctx    = _openRow(SHEET_OUTLETS, outletId, 'Outlet');
    const oldVal = _readFields(ctx.row, ctx.headers, OUTLET_FIELDS);

    const updates = {};
    if (changes.outletName !== undefined) {
      const outletName = String(changes.outletName).trim();
      if (!outletName) throw new Error('Outlet name is required.');
      updates['Outlet Name'] = outletName;
    }
    // Free-text columns are stored exactly as typed (no trim), as they always were.
    ['area', 'address', 'customerGroup', 'notes'].forEach(k => {
      if (changes[k] !== undefined) updates[OUTLET_FIELDS[k]] = changes[k];
    });

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }
    _auditLog('OUTLET_EDIT', SHEET_OUTLETS, outletId, JSON.stringify(oldVal), JSON.stringify(changes));
  });
}


// ============================================================
//  Trucks (Admin only)
// ============================================================

const TRUCK_FIELDS = {
  plate:           'Plate Number',
  brand:           'Brand',
  type:            'Type',
  billingCategory: 'Billing Category',
  active:          'Active',
};

/**
 * Creates a new truck record. Billing category is selected directly by
 * the Admin from the Billing Categories list (not auto-resolved).
 * Also appends a blank Default Assignments row so the truck shows up
 * in the Truck Roster panel immediately.
 *
 * @param {Object} data  { plate, brand, type, billingCategory }
 * @returns {{ success: boolean, truck: Object, defaultAssignment: Object } | { success: false, error: string }}
 */
function createTruck(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const plate = String(data.plate || '').trim();
    if (!plate) throw new Error('Plate number is required.');

    const ctx = _openSheet(SHEET_TRUCKS);
    _requireUnique(ctx.rows, ctx.headers, 'Plate Number', plate,
      `A truck with plate "${plate}" already exists.`);

    const brand           = String(data.brand || '').trim();
    const type            = String(data.type  || '').trim();
    const billingCategory = String(data.billingCategory || '').trim();

    const nextId = _nextRowId(ctx.sheet);
    ctx.sheet.appendRow([nextId, plate, brand, type, true, billingCategory]);

    // Seed a blank Default Assignments row for this truck
    const defSheet  = _getSheet(SHEET_DEFAULT_ASSIGN);
    const nextDefId = _nextRowId(defSheet);
    defSheet.appendRow([nextDefId, nextId, '', '', '']);

    _auditLog('TRUCK_CREATE', SHEET_TRUCKS, nextId, '', JSON.stringify({ plate, brand, type, billingCategory }));

    return {
      truck: { id: nextId, plate, brand, type, billingCategory, active: true },
      defaultAssignment: { id: nextDefId, truckId: nextId, defaultDriverId: null, defaultHelperIds: [], notes: '' },
    };
  });
}

/**
 * Updates a truck record, including a direct Admin-selected change to
 * its Billing Category.
 *
 * @param {number} truckId
 * @param {Object} changes  Any of { plate, brand, type, billingCategory, active }
 * @returns {{ success: boolean, truck: Object } | { success: false, error: string }}
 */
function updateTruck(truckId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const ctx    = _openRow(SHEET_TRUCKS, truckId, 'Truck');
    const oldVal = _readFields(ctx.row, ctx.headers, TRUCK_FIELDS);

    const updates = {};
    if (changes.plate !== undefined) {
      const plate = String(changes.plate).trim();
      if (!plate) throw new Error('Plate number is required.');
      _requireUnique(ctx.rows, ctx.headers, 'Plate Number', plate,
        `A truck with plate "${plate}" already exists.`, ctx.rowIdx);
      updates['Plate Number'] = plate;
    }
    ['brand', 'type', 'billingCategory'].forEach(k => {
      if (changes[k] !== undefined) updates[TRUCK_FIELDS[k]] = String(changes[k]).trim();
    });
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }
    _auditLog('TRUCK_EDIT', SHEET_TRUCKS, truckId, JSON.stringify(oldVal), JSON.stringify(changes));

    // Read back from the row _writeRowFields just updated in place.
    const truck = Object.assign({ id: truckId }, _readFields(ctx.row, ctx.headers, TRUCK_FIELDS));
    truck.active = truck.active !== false;
    return { truck: truck };
  });
}


// ============================================================
//  Billing Categories (Admin only)
// ============================================================

const BILLING_CATEGORY_FIELDS = { name: 'Name', active: 'Active' };

/**
 * Creates a new billing category.
 * @param {Object} data  { name }
 * @returns {{ success: boolean, billingCategory: Object } | { success: false, error: string }}
 */
function createBillingCategory(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('Name is required.');

    const ctx = _openSheet(SHEET_BILLING_CATEGORIES);
    _requireUnique(ctx.rows, ctx.headers, 'Name', name,
      `A billing category named "${name}" already exists.`);

    const nextId = _nextRowId(ctx.sheet);
    ctx.sheet.appendRow([nextId, name, true]);

    _auditLog('BILLING_CATEGORY_CREATE', SHEET_BILLING_CATEGORIES, nextId, '', name);
    return { billingCategory: { id: nextId, name: name, active: true } };
  });
}

/**
 * Updates a billing category. Renaming cascades to every Trucks row
 * currently using the old name, so existing trucks stay matched.
 *
 * @param {number} categoryId
 * @param {Object} changes  Any of { name, active }
 * @returns {{ success: boolean, billingCategory: Object } | { success: false, error: string }}
 */
function updateBillingCategory(categoryId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const ctx    = _openRow(SHEET_BILLING_CATEGORIES, categoryId, 'Billing category');
    const oldVal = _readFields(ctx.row, ctx.headers, BILLING_CATEGORY_FIELDS);

    const updates = {};
    let renamedFrom = null;
    if (changes.name !== undefined) {
      const name = String(changes.name).trim();
      if (!name) throw new Error('Name is required.');
      _requireUnique(ctx.rows, ctx.headers, 'Name', name,
        `A billing category named "${name}" already exists.`, ctx.rowIdx);
      if (name !== String(oldVal.name)) renamedFrom = String(oldVal.name);
      updates['Name'] = name;
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }
    if (renamedFrom) _renameTruckBillingCategory(renamedFrom, updates['Name']);

    _auditLog('BILLING_CATEGORY_EDIT', SHEET_BILLING_CATEGORIES, categoryId,
      JSON.stringify(oldVal), JSON.stringify(changes));

    const billingCategory = Object.assign({ id: categoryId },
      _readFields(ctx.row, ctx.headers, BILLING_CATEGORY_FIELDS));
    billingCategory.active = billingCategory.active !== false;
    return { billingCategory: billingCategory };
  });
}


// ============================================================
//  Route Type Map (Admin only)
// ============================================================

const ROUTE_TYPE_MAP_FIELDS = {
  fileTypeCode:    'File Type Code',
  billingCategory: 'Billing Category',
  active:          'Active',
};

/**
 * Creates a new Route Type Map entry (route-file truck-type code → billing
 * category) used to resolve truck assignment during import.
 *
 * @param {Object} data  { fileTypeCode, billingCategory }
 * @returns {{ success: boolean, mapping: Object } | { success: false, error: string }}
 */
function createRouteTypeMapping(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const code     = String(data.fileTypeCode || '').trim();
    const category = String(data.billingCategory || '').trim();
    if (!code) throw new Error('File type code is required.');
    if (!category) throw new Error('Billing category is required.');

    getRouteTypeMap(); // ensure the sheet exists (self-bootstraps)
    const ctx = _openSheet(SHEET_ROUTE_TYPE_MAP);
    _requireUnique(ctx.rows, ctx.headers, 'File Type Code', code,
      `A mapping for "${code}" already exists.`);

    const nextId = _nextRowId(ctx.sheet);
    ctx.sheet.appendRow([nextId, code, category, true]);

    _auditLog('ROUTE_TYPE_MAP_CREATE', SHEET_ROUTE_TYPE_MAP, nextId, '', `${code} → ${category}`);
    return { mapping: { id: nextId, fileTypeCode: code, billingCategory: category, active: true } };
  });
}

/**
 * Updates an existing Route Type Map entry.
 *
 * @param {number} mappingId
 * @param {Object} changes  { fileTypeCode?, billingCategory?, active? }
 * @returns {{ success: boolean, mapping: Object } | { success: false, error: string }}
 */
function updateRouteTypeMapping(mappingId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    getRouteTypeMap(); // ensure the sheet exists
    const ctx    = _openRow(SHEET_ROUTE_TYPE_MAP, mappingId, 'Route type mapping');
    const oldVal = _readFields(ctx.row, ctx.headers, ROUTE_TYPE_MAP_FIELDS);

    const updates = {};
    if (changes.fileTypeCode !== undefined) {
      const code = String(changes.fileTypeCode).trim();
      if (!code) throw new Error('File type code is required.');
      _requireUnique(ctx.rows, ctx.headers, 'File Type Code', code,
        `A mapping for "${code}" already exists.`, ctx.rowIdx);
      updates['File Type Code'] = code;
    }
    if (changes.billingCategory !== undefined) {
      const category = String(changes.billingCategory).trim();
      if (!category) throw new Error('Billing category is required.');
      updates['Billing Category'] = category;
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }
    _auditLog('ROUTE_TYPE_MAP_EDIT', SHEET_ROUTE_TYPE_MAP, mappingId,
      JSON.stringify(oldVal), JSON.stringify(changes));

    const mapping = Object.assign({ id: mappingId },
      _readFields(ctx.row, ctx.headers, ROUTE_TYPE_MAP_FIELDS));
    mapping.active = mapping.active !== false;
    return { mapping: mapping };
  });
}


// ============================================================
//  Customer Group Colors (Admin only)
// ============================================================

/**
 * Sets the color for a customer group (upsert by group code, case-insensitive).
 * Passing a blank color deactivates the row, so the group falls back to the
 * client's hashed color. Groups are the free-text Customer Group values on
 * outlets — no separate group registry, this only stores the color choice.
 *
 * @param {string} group  Customer group code (e.g. "PG")
 * @param {string} color  Hex color like "#92d050", or "" to clear
 * @returns {{ success: boolean, customerGroupColor: Object } | { success: false, error: string }}
 */
function saveCustomerGroupColor(group, color) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const code = String(group || '').trim();
    if (!code) throw new Error('Customer group is required.');
    const hex = String(color || '').trim();
    if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      throw new Error('Color must be a hex value like #92d050.');
    }
    const active = hex !== '';

    getCustomerGroupColors(); // ensure the sheet exists (self-bootstraps)
    const ctx = _openSheet(SHEET_CG_COLORS);

    // Upsert by group code, not by ID — the client only knows the code.
    const want   = code.toUpperCase();
    const rowIdx = ctx.rows.findIndex((r, i) => i > 0
      && String(_val(r, ctx.headers, 'Customer Group')).trim().toUpperCase() === want);

    let id;
    if (rowIdx === -1) {
      id = _nextRowId(ctx.sheet);
      ctx.sheet.appendRow([id, code, hex, active]);
    } else {
      id = _numOrNull(_val(ctx.rows[rowIdx], ctx.headers, 'ID'));
      _writeRowFields(ctx.sheet, ctx.rows[rowIdx], rowIdx, ctx.headers, { 'Color': hex, 'Active': active });
    }

    _auditLog('CG_COLOR_EDIT', SHEET_CG_COLORS, id, '', `${code} → ${hex || '(cleared)'}`);
    return { customerGroupColor: { id: id, customerGroup: code, color: hex, active: active } };
  });
}


// ============================================================
//  Waybill Prefixes (Admin + Dispatcher)
// ============================================================

// Both prefix endpoints self-migrate a Sheet that predates these columns.
const WB_PREFIX_ENSURE = ['Active', 'Sequence Width'];

/**
 * Normalizes a Last Sequence Number input. Kept as a digit string so the
 * booklet's fixed width (leading zeros) survives the round trip.
 * @param {*} value
 * @returns {string}
 */
function _normalizeSequenceInput(value) {
  const seq = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(seq)) throw new Error('Last sequence number must be digits only (e.g. 0357).');
  return seq;
}

/**
 * Returns the "already exists" error message if another row already uses this
 * prefix, or '' if it's free. A removed (inactive) row still collides — it's
 * only hidden from the pickers — so the message points at Restore instead of
 * leaving the user hunting for a prefix they can't see.
 *
 * Bespoke rather than _requireUnique because the message depends on whether
 * the colliding row is active.
 *
 * @param {Array[]}  rows       All sheet rows, header included.
 * @param {string[]} headers
 * @param {string}   prefix     The candidate prefix, already trimmed.
 * @param {number}   [skipRowIdx] Row index (into rows) to ignore — the row being edited.
 * @returns {string}
 */
function _prefixDupMessage(rows, headers, prefix, skipRowIdx) {
  const dup = rows.slice(1).find((r, i) => (i + 1) !== skipRowIdx
    && String(_val(r, headers, 'Prefix')).trim().toUpperCase() === prefix.toUpperCase());
  if (!dup) return '';
  const removed = _val(dup, headers, 'Active') === false;
  return `A prefix "${prefix || '(blank)'}" already exists`
    + (removed ? ' but was removed — restore it instead of adding it again.' : '.');
}

/**
 * Creates a new waybill prefix.
 * @param {Object} data  { prefix, companyName, lastSequenceNumber }
 * @returns {{ success: boolean, waybillPrefix: Object } | { success: false, error: string }}
 */
function createWaybillPrefix(data) {
  _requirePermission('EDIT_WAYBILL_PREFIXES');
  return _writerResult(() => {
    // A blank prefix is legal (waybill number is then the bare sequence).
    const prefix      = String(data.prefix || '').trim();
    const companyName = String(data.companyName || '').trim();
    const seq         = _normalizeSequenceInput(data.lastSequenceNumber);
    if (!companyName) throw new Error('Company name is required.');

    const ctx = _openSheet(SHEET_WB_PREFIXES, WB_PREFIX_ENSURE);
    const dup = _prefixDupMessage(ctx.rows, ctx.headers, prefix);
    if (dup) throw new Error(dup);

    // The typed value carries the booklet width in its own length ("0000" → 4);
    // that width is stored in its own column and the counter as a plain number,
    // so nothing later depends on the cell's formatting.
    const nextId = _nextRowId(ctx.sheet);
    const values = {
      'ID':                   nextId,
      'Prefix':               prefix,
      'Company Name':         companyName,
      'Last Sequence Number': Number(seq),
      'Active':               true,
      'Sequence Width':       seq.length,
    };
    ctx.sheet.appendRow(ctx.headers.map(h => (values[h] !== undefined ? values[h] : '')));

    _auditLog('WAYBILL_PREFIX_CREATE', SHEET_WB_PREFIXES, nextId, '',
      JSON.stringify({ prefix, companyName, lastSequenceNumber: seq }));

    return {
      waybillPrefix: {
        id: nextId,
        prefix,
        companyName,
        lastSequenceNumber: Number(seq),
        sequenceWidth: seq.length,
        active: true,
      },
    };
  });
}

/**
 * Updates a waybill prefix. Editing Last Sequence Number re-bases the
 * numbering (and its zero-pad width) — suggestion/confirmation continue from
 * whatever is stored here, so it is audited like any other master change.
 *
 * Setting active=false removes the prefix from the pickers; existing waybills
 * keep referencing it, so it is a soft delete like every other master record.
 *
 * @param {number} prefixId
 * @param {Object} changes  Any of { prefix, companyName, lastSequenceNumber, active }
 * @returns {{ success: boolean, waybillPrefix: Object } | { success: false, error: string }}
 */
function updateWaybillPrefix(prefixId, changes) {
  _requirePermission('EDIT_WAYBILL_PREFIXES');
  return _writerResult(() => {
    const ctx = _openRow(SHEET_WB_PREFIXES, prefixId, 'Waybill prefix', WB_PREFIX_ENSURE);
    const oldVal = {
      prefix:             _val(ctx.row, ctx.headers, 'Prefix'),
      companyName:        _val(ctx.row, ctx.headers, 'Company Name'),
      lastSequenceNumber: _val(ctx.row, ctx.headers, 'Last Sequence Number'),
      active:             _val(ctx.row, ctx.headers, 'Active') !== false,
    };

    const updates = {};
    if (changes.prefix !== undefined) {
      const prefix = String(changes.prefix).trim();
      const dup = _prefixDupMessage(ctx.rows, ctx.headers, prefix, ctx.rowIdx);
      if (dup) throw new Error(dup);
      updates['Prefix'] = prefix;
    }
    if (changes.companyName !== undefined) {
      const companyName = String(changes.companyName).trim();
      if (!companyName) throw new Error('Company name is required.');
      updates['Company Name'] = companyName;
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    let seq = null;
    if (changes.lastSequenceNumber !== undefined) {
      // The typed text carries the booklet width in its length ("0357" → 4).
      const text = _normalizeSequenceInput(changes.lastSequenceNumber);
      seq = { value: Number(text), width: text.length };

      // Re-basing at or below a number already out would re-mint it. The
      // automatic path only ever advances; the manual one used to write
      // whatever was typed, so a stale panel could silently rewind the booklet.
      const wbRows    = _getSheet(SHEET_WAYBILLS).getDataRange().getValues();
      const wbHeaders = wbRows[0].map(h => h.toString().trim());
      const highest   = _highestIssuedSequence(prefixId, wbRows, wbHeaders);
      if (seq.value < highest) {
        throw new Error(
          `This booklet has already issued up to ${highest}. `
          + `Set the last sequence number to ${highest} or higher.`);
      }

      updates['Last Sequence Number'] = seq.value;
      updates['Sequence Width']       = seq.width;
    }

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }

    _auditLog('WAYBILL_PREFIX_EDIT', SHEET_WB_PREFIXES, prefixId,
      JSON.stringify(oldVal), JSON.stringify(changes));

    const storedSeq   = seq !== null ? seq.value : Number(oldVal.lastSequenceNumber) || 0;
    const storedWidth = seq !== null
      ? seq.width
      : (Number(_val(ctx.row, ctx.headers, 'Sequence Width'))
         || String(oldVal.lastSequenceNumber == null ? '' : oldVal.lastSequenceNumber).trim().length);
    return {
      waybillPrefix: {
        id:                 prefixId,
        prefix:             _val(ctx.row, ctx.headers, 'Prefix'),
        companyName:        _val(ctx.row, ctx.headers, 'Company Name'),
        lastSequenceNumber: storedSeq,
        sequenceWidth:      storedWidth,
        active:             _val(ctx.row, ctx.headers, 'Active') !== false,
      },
    };
  });
}


// ============================================================
//  Employees (Admin only)
// ============================================================

const EMPLOYEE_FIELDS = { nick: 'Nickname', role: 'Role', active: 'Active' };

/**
 * Creates a new employee record.
 * @param {Object} data  { nick, firstName, middleName, lastName, role }
 * @returns {{ success: boolean, employee: Object } | { success: false, error: string }}
 */
function createEmployee(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const nick = String(data.nick || '').trim();
    if (!nick) throw new Error('Nickname is required.');
    const role = String(data.role || '').trim();
    if (!role) throw new Error('Role is required.');

    const firstName  = String(data.firstName  || '').trim();
    const middleName = String(data.middleName || '').trim();
    const lastName   = String(data.lastName   || '').trim();

    const sheet  = _getSheet(SHEET_EMPLOYEES);
    const nextId = _nextRowId(sheet);
    sheet.appendRow([nextId, nick, firstName, middleName, lastName, role, true]);

    _auditLog('EMPLOYEE_CREATE', SHEET_EMPLOYEES, nextId, '', JSON.stringify({ nick, role }));
    return { employee: { id: nextId, nick, firstName, middleName, lastName, role, active: true } };
  });
}

/**
 * Updates an employee record.
 * @param {number} employeeId
 * @param {Object} changes  Any of { nick, firstName, middleName, lastName, role, active }
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function updateEmployee(employeeId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  return _writerResult(() => {
    const ctx    = _openRow(SHEET_EMPLOYEES, employeeId, 'Employee');
    const oldVal = _readFields(ctx.row, ctx.headers, EMPLOYEE_FIELDS);

    const updates = {};
    // Nickname and Role are required; the name parts are free-text.
    [['nick', 'Nickname', 'Nickname is required.'], ['role', 'Role', 'Role is required.']]
      .forEach(pair => {
        if (changes[pair[0]] === undefined) return;
        const v = String(changes[pair[0]]).trim();
        if (!v) throw new Error(pair[2]);
        updates[pair[1]] = v;
      });
    [['firstName', 'First Name'], ['middleName', 'Middle Name'], ['lastName', 'Last Name']]
      .forEach(pair => {
        if (changes[pair[0]] !== undefined) updates[pair[1]] = String(changes[pair[0]]).trim();
      });
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }
    _auditLog('EMPLOYEE_EDIT', SHEET_EMPLOYEES, employeeId, JSON.stringify(oldVal), JSON.stringify(changes));
  });
}


// ============================================================
//  Users (Admin only)
// ============================================================

const USER_FIELDS = { email: 'Email', displayName: 'Display Name', role: 'Role', active: 'Active' };

/**
 * Validates one user field set. Shared by create and update so a bad role or
 * a malformed email cannot reach the sheet from either path.
 * @param {Object} data     { email, displayName, role } — any may be absent on update.
 * @param {Object} updates  Column-name map the caller writes into.
 */
function _applyUserFields(data, updates) {
  if (data.email !== undefined) {
    const email = String(data.email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required.');
    updates['Email'] = email;
  }
  if (data.displayName !== undefined) {
    const name = String(data.displayName).trim();
    if (!name) throw new Error('Display name is required.');
    updates['Display Name'] = name;
  }
  if (data.role !== undefined) {
    const role = String(data.role).trim();
    const valid = Object.keys(ROLES).map(k => ROLES[k]);
    if (valid.indexOf(role) === -1) throw new Error(`Role must be one of: ${valid.join(', ')}.`);
    updates['Role'] = role;
  }
}

/**
 * Adds a user to the access list.
 * @param {Object} data  { email, displayName, role }
 * @returns {{ success: boolean, user: Object } | { success: false, error: string }}
 */
function createUser(data) {
  _requirePermission('EDIT_USERS');
  return _writerResult(() => {
    const updates = {};
    _applyUserFields({
      email:       data.email,
      displayName: data.displayName,
      role:        data.role,
    }, updates);
    if (!updates['Email'])        throw new Error('A valid email is required.');
    if (!updates['Display Name']) throw new Error('Display name is required.');
    if (!updates['Role'])         throw new Error('Role is required.');

    const ctx = _openSheet(SHEET_USERS);
    _requireUnique(ctx.rows, ctx.headers, 'Email', updates['Email'],
      `A user with the email "${updates['Email']}" already exists.`);

    const nextId = _nextRowId(ctx.sheet);
    ctx.sheet.appendRow([nextId, updates['Email'], updates['Display Name'], updates['Role'], true]);

    _auditLog('USER_CREATE', SHEET_USERS, nextId, '',
      JSON.stringify({ email: updates['Email'], role: updates['Role'] }));
    return { user: {
      id: nextId, email: updates['Email'], displayName: updates['Display Name'],
      role: updates['Role'], active: true,
    } };
  });
}

/**
 * Updates a user. An Admin cannot change their own Role or Active flag — that
 * is the one edit nobody can undo from inside the app, because it takes away
 * the panel that would undo it.
 *
 * @param {number} userId
 * @param {Object} changes  Any of { email, displayName, role, active }
 * @returns {{ success: boolean, user: Object } | { success: false, error: string }}
 */
function updateUser(userId, changes) {
  _requirePermission('EDIT_USERS');
  return _writerResult(() => {
    const ctx    = _openRow(SHEET_USERS, userId, 'User');
    const oldVal = _readFields(ctx.row, ctx.headers, USER_FIELDS);

    const isSelf = String(oldVal.email).trim().toLowerCase() ===
      String(_getCurrentUserEmail()).trim().toLowerCase();
    const dropsSelfRole = changes.role !== undefined && String(changes.role).trim() !== String(oldVal.role);
    if (isSelf && (changes.active === false || dropsSelfRole)) {
      throw new Error('You cannot change your own role or remove your own access.');
    }

    const updates = {};
    _applyUserFields(changes, updates);
    if (updates['Email']) {
      _requireUnique(ctx.rows, ctx.headers, 'Email', updates['Email'],
        `A user with the email "${updates['Email']}" already exists.`, ctx.rowIdx);
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }
    _auditLog('USER_EDIT', SHEET_USERS, userId, JSON.stringify(oldVal), JSON.stringify(changes));

    const user = Object.assign({ id: userId }, _readFields(ctx.row, ctx.headers, USER_FIELDS));
    user.active = user.active !== false;
    return { user: user };
  });
}


// ============================================================
//  DATA WRITERS — Maintenance
// ============================================================

// The exact phrase an Admin has to type to wipe the environment. Long and
// unambiguous on purpose — nobody types this by reflex. The web/ Admin panel
// shows the same string; this copy is the one that actually decides.
const CLEAR_DATA_PHRASE = 'PERMANENTLY DELETE ALL DATA';

/**
 * Wipes every transactional row from this environment's spreadsheet (Trips,
 * Outlets, Route Frequency Log, Waybills, Audit Log), keeping headers and all
 * master data. Admin-only, and only with the confirmation phrase typed exactly.
 *
 * Which environment gets wiped is decided by which backend the caller reached:
 * the DEV frontend talks to the DEV script/sheet, prod to prod. There is no
 * cross-environment clear.
 *
 * @param {string} confirmPhrase  Must equal CLEAR_DATA_PHRASE.
 * @returns {{ success: boolean, cleared: string[] } | { success: false, error: string }}
 */
function clearAllData(confirmPhrase) {
  _requirePermission('CLEAR_ALL_DATA');
  try {
    if (String(confirmPhrase == null ? '' : confirmPhrase).trim() !== CLEAR_DATA_PHRASE) {
      throw new Error('Confirmation phrase did not match. Nothing was deleted.');
    }

    const cleared = _clearTransactionalSheets();
    // Logged *after* the wipe on purpose — the Audit Log is one of the sheets
    // being cleared, so this row is the surviving record of who did it.
    _auditLog('DATA_CLEAR', '', '', '', JSON.stringify(cleared));

    return { success: true, cleared };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  BILLING — Freight Rates, Fuel Prices, Charge Types
// ============================================================

/**
 * Seeds or replaces one origin's rate block.
 *
 * A rates workbook holds one sheet per warehouse, so the Billing Matrix panel
 * parses a sheet and posts it here as flat rows. Re-posting the same origin and
 * effective date replaces that block rather than stacking a second copy — a
 * partial paste is the normal way this goes wrong, and two blocks with the same
 * date would make the lookup arbitrary.
 *
 * @param {string} origin         Warehouse name, e.g. 'TANZA'.
 * @param {string} effectiveDate  'M/d/yyyy' — first date the block applies.
 * @param {Object[]} rows         [{ area, truckType, bands: { '65.01-70': 15300, ... } }]
 * @returns {{ success: boolean, imported: number, replaced: number } | { success: false, error: string }}
 */
function importFreightRates(origin, effectiveDate, rows) {
  _requirePermission('EDIT_FREIGHT_RATES');
  return _writerResult(() => {
    const originName = String(origin || '').trim();
    if (!originName) throw new Error('Origin warehouse is required.');

    const effDate = String(effectiveDate || '').trim();
    if (!_parseDateStrict(effDate)) {
      throw new Error('Effective date is required, in M/d/yyyy format.');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('No rate rows to import.');
    }

    const headers = _freightRateHeaders();
    const sheet   = _getOrCreateSheet(SHEET_FREIGHT_RATES, headers);
    const sheetRows = sheet.getDataRange().getValues();
    const sheetHeaders = sheetRows[0].map(h => h.toString().trim());

    // Drop any earlier block for the same origin and date. Deleting bottom-up
    // keeps the remaining row indexes valid.
    const wantOrigin = _normArea(originName);
    const doomed = [];
    for (let i = 1; i < sheetRows.length; i++) {
      if (_normArea(_val(sheetRows[i], sheetHeaders, 'Origin')) !== wantOrigin) continue;
      const eff = _readDateCell(_val(sheetRows[i], sheetHeaders, 'Effective Date'));
      if (_formatDate(eff) === effDate) doomed.push(i + 1);
    }
    for (let i = doomed.length - 1; i >= 0; i--) sheet.deleteRow(doomed[i]);

    let nextId = _nextRowId(sheet);
    const newRows = rows.map(r => {
      const area = String(r.area || '').trim();
      const type = String(r.truckType || '').trim();
      if (!area || !type) throw new Error('Every rate row needs an area and a truck type.');
      const bands = r.bands || {};
      const values = [nextId++, originName, area, type, effDate];
      for (let i = 1; i <= FUEL_BAND_COUNT; i++) {
        const v = bands[_fuelBandLabel(i)];
        values.push((v === null || v === undefined || v === '') ? '' : Number(v));
      }
      return values;
    });

    _appendRows(sheet, newRows);

    _auditLog('FREIGHT_RATE_IMPORT', SHEET_FREIGHT_RATES, '', '',
      `${originName} → ${newRows.length} rows effective ${effDate}`);

    return { imported: newRows.length, replaced: doomed.length };
  });
}

/**
 * Edits one rate cell from the Billing Matrix panel.
 *
 * @param {number} rateId
 * @param {string} bandLabel  Band column, e.g. '65.01-70'.
 * @param {number|string} value  Blank clears the cell.
 * @returns {{ success: boolean, rate: Object } | { success: false, error: string }}
 */
function updateFreightRate(rateId, bandLabel, value) {
  _requirePermission('EDIT_FREIGHT_RATES');
  return _writerResult(() => {
    const label = String(bandLabel || '').trim();
    let known = false;
    for (let i = 1; i <= FUEL_BAND_COUNT; i++) if (_fuelBandLabel(i) === label) known = true;
    if (!known) throw new Error(`"${label}" is not a price band on the matrix.`);

    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (raw !== '' && !(isFinite(Number(raw)) && Number(raw) >= 0)) {
      throw new Error('A rate must be a number that is zero or more.');
    }
    const newVal = raw === '' ? '' : Number(raw);

    // One cell of a 1,500-row, 30-column matrix. Reading the whole sheet to
    // reach it made tabbing along a row cost a full matrix scan per keystroke,
    // and the read is held under the script lock.
    // ponytail: still one locked round trip per cell. Batch the edits into an
    // updateFreightRates(edits[]) if a whole-row entry pass still drags.
    const sheet   = _getSheet(SHEET_FREIGHT_RATES);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => h.toString().trim());
    const idCol   = headers.indexOf('ID') + 1;
    const bandCol = headers.indexOf(label) + 1;
    if (idCol === 0)   throw new Error(`Column "ID" not found in sheet "${SHEET_FREIGHT_RATES}".`);
    if (bandCol === 0) throw new Error(`Column "${label}" not found in sheet "${SHEET_FREIGHT_RATES}".`);

    const lastRow = sheet.getLastRow();
    const ids     = lastRow > 1 ? sheet.getRange(2, idCol, lastRow - 1, 1).getValues() : [];
    let rowNum    = -1;
    for (let i = 0; i < ids.length; i++) {
      if (Number(ids[i][0]) === Number(rateId)) { rowNum = i + 2; break; }
    }
    if (rowNum === -1) throw new Error(`Freight rate ID ${rateId} not found.`);

    const row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
    const old = _val(row, headers, label);
    sheet.getRange(rowNum, bandCol).setValue(newVal);

    _auditLog('FREIGHT_RATE_EDIT', SHEET_FREIGHT_RATES, rateId,
      JSON.stringify({ band: label, value: old }),
      JSON.stringify({ band: label, value: newVal }));

    return {
      rate: {
        id:        rateId,
        origin:    String(_val(row, headers, 'Origin')).trim(),
        area:      String(_val(row, headers, 'Area')).trim(),
        truckType: String(_val(row, headers, 'Truck Type')).trim(),
        band:      label,
        value:     newVal,
      },
    };
  });
}

/**
 * Records the weekly DOE diesel price for NCR (the Quezon City "Common Price").
 * The DOE publishes a PDF only, so this is typed in by hand.
 *
 * The DOE posts on a Monday and the price runs Tuesday to the following
 * Monday, so an effective date is always a Tuesday. A non-Tuesday date is
 * accepted — a mid-week special adjustment happens — but the panel warns.
 *
 * A row can be corrected with updateFuelPrice or dropped with deleteFuelPrice.
 * The Audit Log carries the trail of what changed; the sheet carries only the
 * current truth, so an operator can fix a typo without leaving a wrong price
 * behind that a later billing might index on.
 *
 * @param {{ effectiveDate: string, dieselPrice: number }} data
 * @returns {{ success: boolean, fuelPrice: Object } | { success: false, error: string }}
 */
function addFuelPrice(data) {
  _requirePermission('EDIT_FREIGHT_RATES');
  return _writerResult(() => {
    const effDate = String((data && data.effectiveDate) || '').trim();
    if (!_parseDateStrict(effDate)) {
      throw new Error('Effective date is required, in M/d/yyyy format.');
    }

    const price = Number(data && data.dieselPrice);
    if (!isFinite(price) || price <= 0) {
      throw new Error('Enter the diesel price as a number greater than zero.');
    }

    const headers = ['ID', 'Effective Date', 'Diesel Price', 'Added By', 'Added At'];
    const sheet   = _getOrCreateSheet(SHEET_FUEL_PRICES, headers);
    const nextId  = _nextRowId(sheet);
    const email   = _getCurrentUserEmail();
    const now     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

    sheet.appendRow([nextId, effDate, price, email, now]);

    _auditLog('FUEL_PRICE_ADD', SHEET_FUEL_PRICES, nextId, '',
      `${price} effective ${effDate}`);

    return {
      fuelPrice: {
        id: nextId, effectiveDate: effDate, dieselPrice: price,
        addedBy: email, addedAt: now,
        band: _fuelBandLabel(_fuelBandIndex(price)),
      },
    };
  });
}

/**
 * Corrects one recorded diesel price. Only the effective date and the price
 * itself are editable — everything else on the row is provenance.
 *
 * @param {number} priceId
 * @param {{ effectiveDate: string, dieselPrice: number }} changes
 * @returns {{ success: boolean, fuelPrice: Object } | { success: false, error: string }}
 */
function updateFuelPrice(priceId, changes) {
  _requirePermission('EDIT_FREIGHT_RATES');
  return _writerResult(() => {
    const ctx  = _openRow(SHEET_FUEL_PRICES, priceId, 'Fuel price');
    const next = {};

    if (changes && changes.effectiveDate !== undefined) {
      const effDate = String(changes.effectiveDate || '').trim();
      if (!_parseDateStrict(effDate)) {
        throw new Error('Effective date is required, in M/d/yyyy format.');
      }
      next['Effective Date'] = effDate;
    }
    if (changes && changes.dieselPrice !== undefined) {
      const price = Number(changes.dieselPrice);
      if (!isFinite(price) || price <= 0) {
        throw new Error('Enter the diesel price as a number greater than zero.');
      }
      next['Diesel Price'] = price;
    }
    if (Object.keys(next).length === 0) throw new Error('Nothing to change.');

    const oldDate  = _formatDate(_readDateCell(_val(ctx.row, ctx.headers, 'Effective Date')));
    const oldPrice = _numOrNull(_val(ctx.row, ctx.headers, 'Diesel Price'));
    _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, next);

    const effDate = next['Effective Date'] !== undefined ? next['Effective Date'] : oldDate;
    const price   = next['Diesel Price']   !== undefined ? next['Diesel Price']   : oldPrice;

    _auditLog('FUEL_PRICE_EDIT', SHEET_FUEL_PRICES, priceId,
      `${oldPrice} effective ${oldDate}`, `${price} effective ${effDate}`);

    return {
      fuelPrice: {
        id:            priceId,
        effectiveDate: effDate,
        dieselPrice:   price,
        addedBy:       String(_val(ctx.row, ctx.headers, 'Added By') || ''),
        band:          _fuelBandLabel(_fuelBandIndex(price)),
      },
    };
  });
}

/**
 * Removes one recorded diesel price — a duplicate, or a week entered twice.
 * A billing already stamped with a billing number keeps the rate it was priced
 * at, so this cannot re-price closed history.
 *
 * @param {number} priceId
 * @returns {{ success: boolean, deleted: number } | { success: false, error: string }}
 */
function deleteFuelPrice(priceId) {
  _requirePermission('EDIT_FREIGHT_RATES');
  return _writerResult(() => {
    const ctx   = _openRow(SHEET_FUEL_PRICES, priceId, 'Fuel price');
    const date  = _formatDate(_readDateCell(_val(ctx.row, ctx.headers, 'Effective Date')));
    const price = _numOrNull(_val(ctx.row, ctx.headers, 'Diesel Price'));

    ctx.sheet.deleteRow(ctx.rowIdx + 1);

    _auditLog('FUEL_PRICE_DELETE', SHEET_FUEL_PRICES, priceId,
      `${price} effective ${date}`, '');

    return { deleted: priceId };
  });
}

const BILLING_CHARGE_TYPE_FIELDS = { label: 'Label', sortOrder: 'Sort Order', active: 'Active' };

/**
 * Adds a manual money column to the billing output.
 * @param {{ label: string, sortOrder: number }} data
 * @returns {{ success: boolean, billingChargeType: Object } | { success: false, error: string }}
 */
function createBillingChargeType(data) {
  _requirePermission('EDIT_BILLING');
  return _writerResult(() => {
    const label = String((data && data.label) || '').trim();
    if (!label) throw new Error('Label is required.');

    getBillingChargeTypes();   // self-seeds the sheet on a Sheet that predates billing
    const ctx = _openSheet(SHEET_BILLING_CHARGE_TYPES);
    _requireUnique(ctx.rows, ctx.headers, 'Label', label,
      `A billing column named "${label}" already exists.`);

    const nextId    = _nextRowId(ctx.sheet);
    const sortOrder = _numOrNull(data && data.sortOrder);
    ctx.sheet.appendRow([nextId, label, sortOrder === null ? nextId * 10 : sortOrder, true]);

    _auditLog('BILLING_CHARGE_TYPE_CREATE', SHEET_BILLING_CHARGE_TYPES, nextId, '', label);

    return {
      billingChargeType: {
        id: nextId, label: label,
        sortOrder: sortOrder === null ? nextId * 10 : sortOrder, active: true,
      },
    };
  });
}

/**
 * Renames, reorders or deactivates a manual money column.
 *
 * Deactivating keeps the column off new billings but never touches the amounts
 * already recorded against it — a past billing must still print what it billed.
 *
 * @param {number} chargeTypeId
 * @param {{ label?: string, sortOrder?: number, active?: boolean }} changes
 * @returns {{ success: boolean, billingChargeType: Object } | { success: false, error: string }}
 */
function updateBillingChargeType(chargeTypeId, changes) {
  _requirePermission('EDIT_BILLING');
  return _writerResult(() => {
    getBillingChargeTypes();   // self-seeds the sheet on a Sheet that predates billing
    const ctx    = _openRow(SHEET_BILLING_CHARGE_TYPES, chargeTypeId, 'Billing column');
    const oldVal = _readFields(ctx.row, ctx.headers, BILLING_CHARGE_TYPE_FIELDS);
    const updates = {};

    if (changes && changes.label !== undefined) {
      const label = String(changes.label).trim();
      if (!label) throw new Error('Label is required.');
      _requireUnique(ctx.rows, ctx.headers, 'Label', label,
        `A billing column named "${label}" already exists.`, ctx.rowIdx);
      updates['Label'] = label;
    }
    if (changes && changes.sortOrder !== undefined) {
      updates['Sort Order'] = _numOrNull(changes.sortOrder);
    }
    if (changes && changes.active !== undefined) {
      updates['Active'] = changes.active === true;
    }

    if (Object.keys(updates).length > 0) {
      _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    }

    _auditLog('BILLING_CHARGE_TYPE_EDIT', SHEET_BILLING_CHARGE_TYPES, chargeTypeId,
      JSON.stringify(oldVal), JSON.stringify(changes));

    const rec = Object.assign({ id: chargeTypeId },
      _readFields(ctx.row, ctx.headers, BILLING_CHARGE_TYPE_FIELDS));
    rec.active    = rec.active !== false;
    rec.sortOrder = _numOrNull(rec.sortOrder);
    return { billingChargeType: rec };
  });
}


// ============================================================
//  BILLING — the billing ledger
// ============================================================

/** Trip statuses whose waybill is finished work and can be billed. */
const BILLABLE_TRIP_STATUSES = ['Delivered', 'Two-Day Trip'];

/**
 * Groups the billable trips of a date range by waybill number.
 *
 * The billable unit is a waybill, and a waybill covers every stop one truck
 * makes on one freight order. The stops are what carry the cartons and the
 * areas, so the group — not any single trip row — is what a billing line is
 * computed from.
 *
 * A load only counts once every one of its stops is delivered: a half-delivered
 * load is still in progress, and billing it would price the drops it has, not
 * the drops it will end up making.
 *
 * @param {string} from  'M/d/yyyy'
 * @param {string} to    'M/d/yyyy'
 * @returns {Object[]} [{ waybillNumber, waybillId, trips: [...] }]
 */
function _billableWaybillGroups(from, to) {
  const trips = getTrips(from, to);
  if (trips.length === 0) return [];

  const wbSheet   = _getSheet(SHEET_WAYBILLS);
  const wbRows    = wbSheet.getDataRange().getValues();
  const wbHeaders = wbRows[0].map(h => h.toString().trim());

  // Trip ID -> the confirmed waybill covering it.
  const wbByTrip = {};
  for (let i = 1; i < wbRows.length; i++) {
    if (_val(wbRows[i], wbHeaders, 'Locked') !== true) continue;
    const tripId = _numOrNull(_val(wbRows[i], wbHeaders, 'Trip ID'));
    if (tripId === null) continue;
    wbByTrip[tripId] = {
      id:     _numOrNull(_val(wbRows[i], wbHeaders, 'ID')),
      number: String(_val(wbRows[i], wbHeaders, 'Waybill Number') || ''),
    };
  }

  const groups   = {};
  const rejected = {};
  trips.forEach(t => {
    const wb = wbByTrip[t.id];
    if (!wb || !wb.number) return;
    if (BILLABLE_TRIP_STATUSES.indexOf(t.tripStatus) === -1) {
      rejected[wb.number] = true;   // one unfinished stop holds the whole load
      return;
    }
    const g = groups[wb.number] || (groups[wb.number] = {
      waybillNumber: wb.number, waybillId: wb.id, trips: [],
    });
    g.trips.push(t);
    if (wb.id < g.waybillId) g.waybillId = wb.id;
  });

  return Object.keys(groups)
    .filter(n => !rejected[n])
    .map(n => groups[n]);
}

/**
 * Builds the values a billing line holds for a waybill group, from the rate
 * matrix and the diesel price in force on the load's Billing Date.
 *
 * @param {Object} group      From _billableWaybillGroups().
 * @param {Object[]} rates    From getFreightRates().
 * @param {Object[]} prices   From getFuelPrices().
 * @param {Object} trucksById
 * @param {Object} [indexCache]  Rate indexes already built, keyed by billing
 *   date. Building one walks every rate row, and a week of loads shares six
 *   dates between hundreds of waybills — pass a cache and it is built once.
 * @returns {Object} the computed fields, plus `warning`
 */
function _priceWaybillGroup(group, rates, prices, trucksById, indexCache) {
  // Trip Date is the day the load was delivered and is what the billing
  // prints. Billing Date is the original operational day and is what selects
  // the price — a carry-over keeps the fuel band of the day it was ordered.
  const first       = group.trips[0];
  const billingDate = _parseDate(first.billingDate || first.tripDate);

  const fuel  = _fuelPriceOn(prices, billingDate);
  const band  = fuel ? _fuelBandIndex(fuel.price) : null;
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
    waybillId:     group.waybillId,
    tripDate:      first.tripDate,
    billingDate:   first.billingDate || first.tripDate,
    origin:        first.origin || '',
    plateNumber:   truck ? truck.plate : '',
    foNumber:      first.foNumber || '',
    truckType:     first.truckBillingCategory || '',
    dieselPrice:   fuel ? fuel.price : '',
    rateBand:      band === null ? '' : _fuelBandLabel(band),
  });
}

/**
 * Returns the billing lines for a date range, creating the ones that do not
 * exist yet and refreshing the computed fields on the ones that do.
 *
 * This reads *and* writes, so it is marked 'w' in RPC_ALLOWED and runs under
 * the script lock: opening the same range in two tabs would otherwise mint two
 * lines for one waybill.
 *
 * A line is left alone once it carries a Billing Number — a submitted billing
 * is history and must keep the numbers it was submitted with. On an unbilled
 * line, only the fields the user has not overridden are recomputed.
 *
 * @param {string} from  'M/d/yyyy' — matched against Trip Date
 * @param {string} to    'M/d/yyyy'
 * @returns {{ success: boolean, lines: Object[], chargeTypes: Object[], totals: Object }
 *           | { success: false, error: string }}
 */
function getBillingLines(from, to) {
  _requirePermission('VIEW_BILLING');
  return _writerResult(() => {
    const sheet     = _getOrCreateSheet(SHEET_BILLING_LINES, BILLING_LINE_HEADERS);
    const rows      = sheet.getDataRange().getValues();
    const headers   = rows[0].map(h => h.toString().trim());

    const groups     = _billableWaybillGroups(from, to);
    // Only the warehouses these loads left from. The matrix carries every
    // origin and a week's billing prices out of one or two of them.
    const originSet  = {};
    groups.forEach(g => {
      const o = g.trips[0] && g.trips[0].origin;
      if (o) originSet[o] = true;
    });
    const rates      = getFreightRates(Object.keys(originSet));
    const prices     = getFuelPrices();
    const trucksById = _indexById(getTrucks());
    const rateCache  = {};   // one rate index per billing date, not per waybill

    const email = _getCurrentUserEmail();
    const now   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

    // Existing lines by waybill number, so a re-open updates instead of appending.
    const byNumber = {};
    for (let i = 1; i < rows.length; i++) {
      const num = String(_val(rows[i], headers, 'Waybill Number') || '');
      if (num) byNumber[num] = i;
    }

    const newRows  = [];
    const newAudit = [];
    const dirty    = [];   // row indexes updated in place, written as one block
    const warnByNumber = {};
    let nextId     = _nextRowId(sheet);

    groups.forEach(g => {
      const priced   = _priceWaybillGroup(g, rates, prices, trucksById, rateCache);
      const existing = byNumber[g.waybillNumber];

      // The warnings describe the rate matrix as it stands now, which is what
      // the user can act on, so they are carried out of the pricing pass
      // rather than stored on the row.
      if (priced.warning) warnByNumber[g.waybillNumber] = priced.warning;

      if (existing === undefined) {
        const total = priced.haulingRate + priced.mano + priced.dropFee;
        const id = nextId++;
        newRows.push([
          id, priced.waybillNumber, priced.waybillId, priced.tripDate,
          priced.billingDate, priced.origin, priced.plateNumber, priced.foNumber,
          priced.truckType, priced.area, priced.drops, priced.cartons,
          priced.dieselPrice, priced.rateBand, priced.haulingRate, priced.mano,
          priced.dropFee, '', total, '', 'Not Billed', '', '', email, now, '', '',
        ]);
        newAudit.push(['BILLING_LINE_CREATE', id, '', priced.waybillNumber]);
        return;
      }

      // A billed line is frozen. So is any field the user typed over.
      const row = rows[existing];
      if (String(_val(row, headers, 'Billing Number') || '').trim()) return;

      const overrides = _parseJsonCell(_val(row, headers, 'Overrides'), []);
      const updates   = {
        'Trip Date': priced.tripDate, 'Billing Date': priced.billingDate,
        'Origin': priced.origin, 'Plate Number': priced.plateNumber,
        'FO Number': priced.foNumber, 'Truck Type': priced.truckType,
        'Drops': priced.drops, 'Cartons': priced.cartons,
        'Diesel Price': priced.dieselPrice, 'Rate Band': priced.rateBand,
      };
      if (overrides.indexOf('haulingRate') === -1) {
        updates['Hauling Rate'] = priced.haulingRate;
        updates['Area']         = priced.area;
      }
      if (overrides.indexOf('mano') === -1)    updates['Mano']     = priced.mano;
      if (overrides.indexOf('dropFee') === -1) updates['Drop Fee'] = priced.dropFee;

      const manual = _parseJsonCell(_val(row, headers, 'Manual Charges'), {});
      updates['Total'] =
        (updates['Hauling Rate'] !== undefined ? updates['Hauling Rate'] : (_numOrNull(_val(row, headers, 'Hauling Rate')) || 0)) +
        (updates['Mano']         !== undefined ? updates['Mano']         : (_numOrNull(_val(row, headers, 'Mano')) || 0)) +
        (updates['Drop Fee']     !== undefined ? updates['Drop Fee']     : (_numOrNull(_val(row, headers, 'Drop Fee')) || 0)) +
        _sumManualCharges(manual);

      // Updated in memory here and flushed below in one write. A refresh of a
      // week touches hundreds of rows, and one setValues per row is hundreds
      // of Sheets round trips inside the script lock.
      Object.keys(updates).forEach(colName => {
        const colIdx = _colIdx(headers, colName);
        if (colIdx === -1) throw new Error(`Column "${colName}" not found in sheet "${SHEET_BILLING_LINES}".`);
        row[colIdx] = updates[colName];
      });
      dirty.push(existing);
    });

    _flushDirtyRows(sheet, rows, dirty);

    if (newRows.length) {
      _appendRows(sheet, newRows);
      newAudit.forEach(a => _auditLog(a[0], SHEET_BILLING_LINES, a[1], a[2], a[3]));
    }

    // `rows` already carries the updates and `newRows` the appends, so the
    // answer is built in memory. Re-reading the sheet here cost a full scan of
    // every billing line ever written, on every refresh.
    const wanted = {};
    groups.forEach(g => { wanted[g.waybillNumber] = true; });

    const lines = rows.slice(1).concat(newRows)
      .map(r => _billingLineFromRow(r, headers))
      .filter(l => l !== null && wanted[l.waybillNumber])
      .sort((a, b) => a.waybillNumber < b.waybillNumber ? -1 : (a.waybillNumber > b.waybillNumber ? 1 : 0));

    lines.forEach(l => { l.warning = warnByNumber[l.waybillNumber] || ''; });

    return {
      lines:       lines,
      chargeTypes: getBillingChargeTypes(),
      totals:      _billingTotals(lines),
    };
  });
}

/**
 * Edits one billing line: a manual charge, an override of a computed amount,
 * or the notes. Total is always recomputed here and is never accepted from the
 * client.
 *
 * Passing null for haulingRate, mano or dropFee drops the override and lets the
 * next refresh recompute that field.
 *
 * @param {number} lineId
 * @param {{ manualCharges?: Object, haulingRate?: number|null, mano?: number|null,
 *           dropFee?: number|null, notes?: string }} changes
 * @returns {{ success: boolean, line: Object } | { success: false, error: string }}
 */
function saveBillingLine(lineId, changes) {
  _requirePermission('EDIT_BILLING');
  return _writerResult(() => {
    const ctx = _openRow(SHEET_BILLING_LINES, lineId, 'Billing line');

    if (String(_val(ctx.row, ctx.headers, 'Billing Number') || '').trim()) {
      throw new Error('This line is already on a submitted billing. Clear its billing number first.');
    }

    const oldVal    = _billingLineFromRow(ctx.row, ctx.headers);
    const overrides = _parseJsonCell(_val(ctx.row, ctx.headers, 'Overrides'), []);
    const updates   = {};

    const OVERRIDABLE = { haulingRate: 'Hauling Rate', mano: 'Mano', dropFee: 'Drop Fee' };
    Object.keys(OVERRIDABLE).forEach(key => {
      if (!changes || changes[key] === undefined) return;
      const at = overrides.indexOf(key);
      if (changes[key] === null) {
        if (at !== -1) overrides.splice(at, 1);   // back to the computed value
        return;
      }
      const n = Number(changes[key]);
      if (!isFinite(n) || n < 0) throw new Error(`${OVERRIDABLE[key]} must be a number that is zero or more.`);
      updates[OVERRIDABLE[key]] = n;
      if (at === -1) overrides.push(key);
    });

    let manual = _parseJsonCell(_val(ctx.row, ctx.headers, 'Manual Charges'), {});
    if (changes && changes.manualCharges !== undefined) {
      const clean = {};
      Object.keys(changes.manualCharges || {}).forEach(k => {
        const n = Number(changes.manualCharges[k]);
        if (!isFinite(n)) throw new Error('A manual charge must be a number.');
        if (n !== 0) clean[String(k)] = n;   // a zero is the same as no charge
      });
      manual = clean;
      updates['Manual Charges'] = Object.keys(clean).length ? JSON.stringify(clean) : '';
    }

    if (changes && changes.notes !== undefined) updates['Notes'] = String(changes.notes);

    updates['Overrides'] = overrides.length ? JSON.stringify(overrides) : '';

    const rate = updates['Hauling Rate'] !== undefined ? updates['Hauling Rate'] : oldVal.haulingRate;
    const mano = updates['Mano']         !== undefined ? updates['Mano']         : oldVal.mano;
    const drop = updates['Drop Fee']     !== undefined ? updates['Drop Fee']     : oldVal.dropFee;
    updates['Total'] = rate + mano + drop + _sumManualCharges(manual);

    updates['Updated By'] = _getCurrentUserEmail();
    updates['Updated At'] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

    _writeRowFields(ctx.sheet, ctx.row, ctx.rowIdx, ctx.headers, updates);
    _auditLog('BILLING_LINE_EDIT', SHEET_BILLING_LINES, lineId,
      JSON.stringify({ haulingRate: oldVal.haulingRate, mano: oldVal.mano,
                       dropFee: oldVal.dropFee, manualCharges: oldVal.manualCharges }),
      JSON.stringify(changes));

    return { line: _billingLineFromRow(ctx.row, ctx.headers) };
  });
}

/**
 * Defers a line to a later billing, or brings a deferred line back.
 *
 * @param {number[]} lineIds
 * @param {string}   status  'Not Billed' or 'Deferred'
 * @returns {{ success: boolean, updated: number } | { success: false, error: string }}
 */
function setBillingLineStatus(lineIds, status) {
  _requirePermission('EDIT_BILLING');
  return _writerResult(() => {
    const next = String(status || '').trim();
    if (['Not Billed', 'Deferred'].indexOf(next) === -1) {
      throw new Error('A line can only be set to Not Billed or Deferred.');
    }
    const ids = Array.isArray(lineIds) ? lineIds : [lineIds];
    if (!ids.length) throw new Error('No lines selected.');

    const ctx = _openSheet(SHEET_BILLING_LINES);
    let updated = 0;
    ids.forEach(id => {
      const rowIdx = _findRowById(ctx.rows, ctx.headers, id);
      if (rowIdx === -1) return;
      const row = ctx.rows[rowIdx];
      if (String(_val(row, ctx.headers, 'Billing Number') || '').trim()) {
        throw new Error('A line already on a submitted billing cannot be deferred.');
      }
      const old = String(_val(row, ctx.headers, 'Status') || '');
      if (old === next) return;
      _writeRowFields(ctx.sheet, row, rowIdx, ctx.headers, { 'Status': next });
      _auditLog('BILLING_LINE_STATUS_CHANGE', SHEET_BILLING_LINES, id, old, next);
      updated++;
    });

    return { updated: updated };
  });
}

/**
 * Stamps a Rebisco billing number on a set of lines and marks them Billed.
 * Passing a blank number clears the stamp, which is how a billing submitted by
 * mistake is reopened for editing.
 *
 * @param {number[]} lineIds
 * @param {string}   billingNumber
 * @returns {{ success: boolean, updated: number, billingNumber: string }
 *           | { success: false, error: string }}
 */
function setBillingNumber(lineIds, billingNumber) {
  _requirePermission('EDIT_BILLING');
  return _writerResult(() => {
    const ids = Array.isArray(lineIds) ? lineIds : [lineIds];
    if (!ids.length) throw new Error('No lines selected.');

    const num     = String(billingNumber || '').trim();
    const clearing = num === '';

    const ctx = _openSheet(SHEET_BILLING_LINES);
    let updated = 0;
    ids.forEach(id => {
      const rowIdx = _findRowById(ctx.rows, ctx.headers, id);
      if (rowIdx === -1) return;
      _writeRowFields(ctx.sheet, ctx.rows[rowIdx], rowIdx, ctx.headers, {
        'Billing Number': num,
        'Status':         clearing ? 'Not Billed' : 'Billed',
      });
      updated++;
    });

    _auditLog('BILLING_NUMBER_SET', SHEET_BILLING_LINES, '', '',
      `${clearing ? '(cleared)' : num} → ${updated} lines`);

    return { updated: updated, billingNumber: num };
  });
}
