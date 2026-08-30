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

    // Every unlocked row of THIS waybill (same number + prefix + sequence).
    // An already-locked sibling is left alone rather than re-confirmed.
    const groupIdxs = [];
    for (let i = 1; i < rows.length; i++) {
      if (_val(rows[i], headers, 'Waybill Number') === origNumber
          && _numOrNull(_val(rows[i], headers, 'Prefix ID')) === prefixId
          && _numOrNull(_val(rows[i], headers, 'Sequence Number')) === seqNumber
          && !_isTrue(_val(rows[i], headers, 'Locked'))) {
        groupIdxs.push(i);
      }
    }
    if (groupIdxs.indexOf(rowIdx) === -1) groupIdxs.push(rowIdx);

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

    // Lock every row of the waybill — batched write per row, 6 fields each
    const email = _getCurrentUserEmail();
    const now   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
    groupIdxs.forEach(i => {
      _writeRowFields(sheet, rows[i], i, headers, {
        'Waybill Number':  finalNumber,
        'Sequence Number': seqNumber,
        'Status':          'Confirmed',
        'Locked':          true,
        'Confirmed By':    email,
        'Confirmed At':    now,
      });
      _auditLog('WAYBILL_CONFIRM', SHEET_WAYBILLS,
        _numOrNull(_val(rows[i], headers, 'ID')), 'Suggested', finalNumber);
    });

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
 * Renames a still-Suggested waybill (and every unlocked stop that shares its
 * number) WITHOUT confirming it — the pre-confirmation edit a dispatcher needs
 * when a load's booklet series differs from the auto-suggested one. Locked
 * (confirmed) waybills are immutable and rejected here; use confirmWaybill to
 * lock. Mirrors confirmWaybill's number parsing + duplicate guard, minus the
 * lock and Confirmed By/At stamps, so the row stays editable.
 *
 * @param {number} waybillId
 * @param {string} newNumber
 * @returns {{ success: boolean, waybillNumber: string, updated: number } | { success: false, error: string }}
 */
function updateSuggestedWaybill(waybillId, newNumber) {
  _requirePermission('CONFIRM_WAYBILL');
  try {
    const sheet   = _getSheet(SHEET_WAYBILLS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, waybillId);
    if (rowIdx === -1) throw new Error(`Waybill ID ${waybillId} not found.`);

    const row = rows[rowIdx];
    if (_isTrue(_val(row, headers, 'Locked'))) {
      throw new Error(`Waybill ${_val(row, headers, 'Waybill Number')} is already confirmed and locked.`);
    }

    const finalNumber = (newNumber == null ? '' : newNumber).toString().trim();
    if (!finalNumber) throw new Error('Waybill number cannot be blank.');

    const origNumber = _val(row, headers, 'Waybill Number');
    const prefixId   = _numOrNull(_val(row, headers, 'Prefix ID'));
    const origSeq    = _numOrNull(_val(row, headers, 'Sequence Number'));

    // Every unlocked row of THIS waybill (same number + prefix + sequence) —
    // one load's stops share the number and must be renamed together.
    const groupIdxs = [];
    for (let i = 1; i < rows.length; i++) {
      if (_val(rows[i], headers, 'Waybill Number') === origNumber
          && _numOrNull(_val(rows[i], headers, 'Prefix ID')) === prefixId
          && _numOrNull(_val(rows[i], headers, 'Sequence Number')) === origSeq
          && !_isTrue(_val(rows[i], headers, 'Locked'))) {
        groupIdxs.push(i);
      }
    }
    if (groupIdxs.indexOf(rowIdx) === -1) groupIdxs.push(rowIdx);

    if (finalNumber === origNumber) {
      return { success: true, waybillNumber: origNumber, updated: 0 };
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

    groupIdxs.forEach(i => {
      _writeRowFields(sheet, rows[i], i, headers, {
        'Waybill Number':  finalNumber,
        'Sequence Number': seqNum,
      });
    });
    _auditLog('WAYBILL_OVERRIDE', SHEET_WAYBILLS, waybillId, origNumber, finalNumber);

    // Keep the booklet counter ahead of an edit that raises the number, so a
    // later suggestion can't re-issue it. Only advances (see the helper).
    if (prefixId && seqNum) _updateWaybillPrefixSequence(prefixId, seqNum);

    return { success: true, waybillNumber: finalNumber, updated: groupIdxs.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
 * @param {string}   tripDate   'M/d/yyyy' — the date these trips are for
 * @param {Object[]} rowData    Array of parsed route rows
 * @returns {{ success: boolean, imported: number, skipped: number, errors: string[],
 *             newOutlets: { id: number, outletName: string, area: string, address: string,
 *                           customerGroup: string, notes: string }[] }}
 */
function importRouteFile(tripDate, rowData) {
  _requirePermission('ADD_MANUAL_TRIP');
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
    // second import's batch tokens don't collide with the first's.
    const usedTruckIds = {};
    let convoyTokenBase = 0;
    getTrips(tripDate, tripDate).forEach(t => {
      if (t.truckId) usedTruckIds[t.truckId] = true;
      const cg = Number(t.convoyGroup);
      if (cg > convoyTokenBase) convoyTokenBase = cg;
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
    const auditSheet = _getSheet(SHEET_AUDIT);
    let nextTripId  = _nextRowId(tripsSheet);
    let nextAuditId = _nextRowId(auditSheet);

    const newTripRows  = [];
    const newAuditRows = [];

    let imported = 0;
    let skipped  = 0;
    const errors = [];

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

    return { success: true, imported, skipped, errors, newOutlets };
  } catch (e) {
    return { success: false, imported: 0, skipped: 0, errors: [e.message] };
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
