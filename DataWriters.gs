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
 * Also appends to Route Frequency Log.
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
      tripData.tripStatus      || 'Scheduled',
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

    // 5. Append to Route Frequency Log if driver and outlet are set
    if (tripData.driverId && outletId) {
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
 * - If `tripStatus` becomes 'Foul Trip - For Redeliver' or 'Redeliver',
 *   creates the next-day carry-over trip as before.
 *
 * @param {number} tripId
 * @param {Object} changes  Any of: { truckId, driverId, helperIds, tripStatus, remarks }
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

    // Route frequency check + log if driver changed
    let routeFrequencyWarning = null;
    if (changes.driverId !== undefined && changes.driverId !== oldDriverId && changes.driverId) {
      const outletId = _numOrNull(_val(row, headers, 'Outlet ID'));
      const tripDate = _formatDate(_readDateCell(_val(row, headers, 'Trip Date')));
      if (outletId) {
        const freq     = getRouteFrequencyForDriver(changes.driverId);
        const existing = freq.find(f => f.outletId === Number(outletId));
        const newCount = (existing ? existing.count : 0) + 1;
        if (newCount > 5) {
          routeFrequencyWarning = {
            outletName: existing ? existing.outletName : '',
            count:      newCount,
          };
        }
        _appendRouteFrequency(tripId, tripDate, changes.driverId, outletId);
      }
    }

    // Carry-over: create a follow-up trip for next business day
    let newTripId = null;
    const carryoverStatuses = ['Foul Trip - For Redeliver', 'Redeliver'];
    if (changes.tripStatus !== undefined && carryoverStatuses.includes(changes.tripStatus)) {
      newTripId = _createCarryoverTrip(row, headers, tripId, changes.tripStatus);
    }

    const rawHelpers = _val(row, headers, 'Helper IDs');
    const helperIds  = rawHelpers
      ? String(rawHelpers).split(',').map(s => _numOrNull(s.trim())).filter(n => n !== null)
      : [];

    return {
      success: true,
      trip: {
        id:                   tripId,
        truckId:              _numOrNull(_val(row, headers, 'Truck ID')),
        driverId:             _numOrNull(_val(row, headers, 'Driver ID')),
        helperIds:            helperIds,
        truckBillingCategory: _val(row, headers, 'Truck Billing Category') || '',
        tripStatus:           _val(row, headers, 'Trip Status') || 'Scheduled',
        remarks:              _val(row, headers, 'Remarks') || '',
        statusChangedBy:      _val(row, headers, 'Status Changed By') || '',
        statusChangedAt:      _valDateTime(row, headers, 'Status Changed At'),
      },
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
 * @returns {{ success: true, updated: number, newTripIds: number[] } | { success: false, error: string }}
 */
function bulkSetTripStatus(tripIds, status) {
  _requirePermission('ASSIGN_CREW');
  try {
    const ids = (tripIds || []).map(Number).filter(Boolean);
    if (ids.length === 0) throw new Error('No trips selected.');

    const newTripIds = [];
    let updated = 0;
    ids.forEach(id => {
      const r = saveTripChanges(id, { tripStatus: status });
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
 * @param {number} waybillId          The ID of the Suggested waybill row.
 * @param {string} [customNumber]     If provided, use this instead of the suggested number.
 * @returns {{ success: boolean, waybillNumber: string } | { success: false, error: string }}
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

    let finalNumber = _val(row, headers, 'Waybill Number');
    const prefixId  = _numOrNull(_val(row, headers, 'Prefix ID'));
    let seqNumber   = _numOrNull(_val(row, headers, 'Sequence Number'));

    // If dispatcher provided a custom number, validate and parse it
    if (customNumber && customNumber !== finalNumber) {
      // Check for duplicate confirmed waybills
      const isDuplicate = rows.slice(1).some((r, i) => {
        if (i === rowIdx - 1) return false; // skip current row
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
        _val(row, headers, 'Waybill Number'), finalNumber);
    }

    // Lock the row — single batched write for all 6 fields
    const email = _getCurrentUserEmail();
    const now   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
    _writeRowFields(sheet, row, rowIdx, headers, {
      'Waybill Number':  finalNumber,
      'Sequence Number': seqNumber,
      'Status':          'Confirmed',
      'Locked':          true,
      'Confirmed By':    email,
      'Confirmed At':    now,
    });

    // Update Last Sequence Number in Waybill Prefixes
    if (prefixId && seqNumber) {
      _updateWaybillPrefixSequence(prefixId, seqNumber);
    }

    _auditLog('WAYBILL_CONFIRM', SHEET_WAYBILLS, waybillId, 'Suggested', finalNumber);

    return { success: true, waybillNumber: finalNumber };
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
    const tripsSheet     = _getSheet(SHEET_TRIPS);
    const routeFreqSheet = _getOrCreateSheet(SHEET_ROUTE_FREQ, ['ID', 'Trip ID', 'Trip Date', 'Driver ID', 'Outlet ID']);
    const auditSheet     = _getSheet(SHEET_AUDIT);
    let nextTripId      = _nextRowId(tripsSheet);
    let nextRouteFreqId = _nextRowId(routeFreqSheet);
    let nextAuditId     = _nextRowId(auditSheet);

    const newTripRows      = [];
    const newRouteFreqRows = [];
    const newAuditRows     = [];

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

      if (driverId && outletId) {
        newRouteFreqRows.push([nextRouteFreqId++, tripId, tripDate, driverId, outletId]);
      }

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
    _appendRows(routeFreqSheet, newRouteFreqRows);
    _appendRows(auditSheet, newAuditRows);

    return { success: true, imported, skipped, errors, newOutlets };
  } catch (e) {
    return { success: false, imported: 0, skipped: 0, errors: [e.message] };
  }
}

/**
 * Deletes a trip row that was imported but is not applicable.
 * Only allowed before the trip has a confirmed waybill.
 * This is the only genuine delete in the system — used only during import cleanup.
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

    _auditLog('TRIP_DELETE', SHEET_TRIPS, tripId, 'Imported trip deleted (pre-confirmation)', '');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Promotes every 'Prepping' trip on a date to 'Scheduled' and suggests
 * their waybills — the end of the planning phase started by importRouteFile.
 *
 * Waybills are grouped by (FO Number, Truck ID): a truck's several drops on
 * one FO share one waybill; each truck of a split FO gets its own. Trips
 * with no FO Number each get their own waybill. Trips that already have a
 * waybill row are skipped, so a second click is a no-op.
 * ponytail: trips of one FO left with NO truck share one waybill (import
 * used to give each unassigned slot its own) — Prepping exists precisely
 * so trucks are assigned before promotion.
 *
 * @param {string} tripDate  'M/d/yyyy'
 * @param {number} prefixId  Waybill prefix for the suggested numbers
 * @returns {{ success: boolean, promoted: number, waybillsSuggested: number }
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

    const promoted = [];   // { rowIdx, tripId, foNumber, truckId }
    rows.forEach((row, i) => {
      if (i === 0) return;
      if (_val(row, headers, 'Trip Status') !== 'Prepping') return;
      if (_formatDate(_readDateCell(_val(row, headers, 'Trip Date'))) !== tripDate) return;
      promoted.push({
        rowIdx:   i,
        tripId:   _numOrNull(_val(row, headers, 'ID')),
        foNumber: String(_val(row, headers, 'FO Number') || ''),
        truckId:  _numOrNull(_val(row, headers, 'Truck ID')),
      });
    });

    if (promoted.length === 0) {
      return { success: true, promoted: 0, waybillsSuggested: 0 };
    }

    // Batch the status stamps: mutate the in-memory rows, write back the
    // span between the first and last affected row in one setValues call
    // (imported rows are contiguous, so the span is tight in practice).
    const email  = _getCurrentUserEmail();
    const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
    const colOf  = (name) => headers.indexOf(name);
    promoted.forEach(p => {
      rows[p.rowIdx][colOf('Trip Status')]       = 'Scheduled';
      rows[p.rowIdx][colOf('Status Changed By')] = email;
      rows[p.rowIdx][colOf('Status Changed At')] = nowStr;
    });
    const minIdx = promoted[0].rowIdx;
    const maxIdx = promoted[promoted.length - 1].rowIdx;
    sheet.getRange(minIdx + 1, 1, maxIdx - minIdx + 1, headers.length)
      .setValues(rows.slice(minIdx, maxIdx + 1));

    // Batched audit rows (mirrors importRouteFile's batching rationale).
    const auditSheet  = _getSheet(SHEET_AUDIT);
    let   nextAuditId = _nextRowId(auditSheet);
    _appendRows(auditSheet, promoted.map(p =>
      [nextAuditId++, nowStr, email || 'unknown', 'TRIP_STATUS_CHANGE', '', SHEET_TRIPS, p.tripId, 'Prepping', 'Scheduled']
    ));

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
    return { success: true, promoted: promoted.length, waybillsSuggested: groups.length };
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
//  DATA WRITERS — Outlets (Admin only)
// ============================================================

/**
 * Creates a new outlet record.
 * @param {Object} data  { outletName, area, address, customerGroup, notes }
 * @returns {{ success: boolean, outlet: Object } | { success: false, error: string }}
 */
function createOutlet(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  try {
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

    return {
      success: true,
      outlet: { id: nextId, outletName, area, address, customerGroup, notes },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Updates an outlet record.
 * @param {number} outletId
 * @param {Object} changes  Any of { outletName, area, address, customerGroup, notes }
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function updateOutlet(outletId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  try {
    const sheet   = _getSheet(SHEET_OUTLETS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, outletId);
    if (rowIdx === -1) throw new Error(`Outlet ID ${outletId} not found.`);

    const row    = rows[rowIdx];
    const oldVal = {
      outletName:    _val(row, headers, 'Outlet Name'),
      area:          _val(row, headers, 'Area'),
      address:       _val(row, headers, 'Address'),
      customerGroup: _val(row, headers, 'Customer Group'),
      notes:         _val(row, headers, 'Notes'),
    };

    const updates = {};
    if (changes.outletName !== undefined) {
      const outletName = String(changes.outletName).trim();
      if (!outletName) throw new Error('Outlet name is required.');
      updates['Outlet Name'] = outletName;
    }
    if (changes.area          !== undefined) updates['Area']           = changes.area;
    if (changes.address       !== undefined) updates['Address']        = changes.address;
    if (changes.customerGroup !== undefined) updates['Customer Group'] = changes.customerGroup;
    if (changes.notes         !== undefined) updates['Notes']          = changes.notes;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    _auditLog('OUTLET_EDIT', SHEET_OUTLETS, outletId, JSON.stringify(oldVal), JSON.stringify(changes));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Trucks (Admin only)
// ============================================================

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
  try {
    const plate = String(data.plate || '').trim();
    if (!plate) throw new Error('Plate number is required.');

    const sheet   = _getSheet(SHEET_TRUCKS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const dup = rows.slice(1).some(row =>
      String(_val(row, headers, 'Plate Number')).trim().toLowerCase() === plate.toLowerCase());
    if (dup) throw new Error(`A truck with plate "${plate}" already exists.`);

    const brand           = String(data.brand || '').trim();
    const type            = String(data.type  || '').trim();
    const billingCategory = String(data.billingCategory || '').trim();

    const nextId = _nextRowId(sheet);
    sheet.appendRow([nextId, plate, brand, type, true, billingCategory]);

    // Seed a blank Default Assignments row for this truck
    const defSheet  = _getSheet(SHEET_DEFAULT_ASSIGN);
    const nextDefId = _nextRowId(defSheet);
    defSheet.appendRow([nextDefId, nextId, '', '', '']);

    _auditLog('TRUCK_CREATE', SHEET_TRUCKS, nextId, '', JSON.stringify({ plate, brand, type, billingCategory }));

    return {
      success: true,
      truck: { id: nextId, plate, brand, type, billingCategory, active: true },
      defaultAssignment: { id: nextDefId, truckId: nextId, defaultDriverId: null, defaultHelperIds: [], notes: '' },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
  try {
    const sheet   = _getSheet(SHEET_TRUCKS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, truckId);
    if (rowIdx === -1) throw new Error(`Truck ID ${truckId} not found.`);

    const row    = rows[rowIdx];
    const oldVal = {
      plate:           _val(row, headers, 'Plate Number'),
      brand:           _val(row, headers, 'Brand'),
      type:            _val(row, headers, 'Type'),
      billingCategory: _val(row, headers, 'Billing Category'),
      active:          _val(row, headers, 'Active'),
    };

    const updates = {};
    if (changes.plate !== undefined) {
      const plate = String(changes.plate).trim();
      if (!plate) throw new Error('Plate number is required.');
      const dup = rows.slice(1).some((r, i) => (i !== rowIdx - 1)
        && String(_val(r, headers, 'Plate Number')).trim().toLowerCase() === plate.toLowerCase());
      if (dup) throw new Error(`A truck with plate "${plate}" already exists.`);
      updates['Plate Number'] = plate;
    }
    if (changes.brand !== undefined) updates['Brand'] = String(changes.brand).trim();
    if (changes.type !== undefined) updates['Type'] = String(changes.type).trim();
    if (changes.billingCategory !== undefined) updates['Billing Category'] = String(changes.billingCategory).trim();
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    _auditLog('TRUCK_EDIT', SHEET_TRUCKS, truckId, JSON.stringify(oldVal), JSON.stringify(changes));

    return {
      success: true,
      truck: {
        id:              truckId,
        plate:           _val(row, headers, 'Plate Number'),
        brand:           _val(row, headers, 'Brand'),
        type:            _val(row, headers, 'Type'),
        billingCategory: _val(row, headers, 'Billing Category'),
        active:          _val(row, headers, 'Active') !== false,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Billing Categories (Admin only)
// ============================================================

/**
 * Creates a new billing category.
 * @param {Object} data  { name }
 * @returns {{ success: boolean, billingCategory: Object } | { success: false, error: string }}
 */
function createBillingCategory(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  try {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('Name is required.');

    const sheet   = _getSheet(SHEET_BILLING_CATEGORIES);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const dup = rows.slice(1).some(row =>
      String(_val(row, headers, 'Name')).trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new Error(`A billing category named "${name}" already exists.`);

    const nextId = _nextRowId(sheet);
    sheet.appendRow([nextId, name, true]);

    _auditLog('BILLING_CATEGORY_CREATE', SHEET_BILLING_CATEGORIES, nextId, '', name);

    return { success: true, billingCategory: { id: nextId, name, active: true } };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
  try {
    const sheet   = _getSheet(SHEET_BILLING_CATEGORIES);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, categoryId);
    if (rowIdx === -1) throw new Error(`Billing category ID ${categoryId} not found.`);

    const row    = rows[rowIdx];
    const oldVal = {
      name:   _val(row, headers, 'Name'),
      active: _val(row, headers, 'Active'),
    };

    const updates = {};
    let renamedFrom = null;
    if (changes.name !== undefined) {
      const name = String(changes.name).trim();
      if (!name) throw new Error('Name is required.');
      const dup = rows.slice(1).some((r, i) => (i !== rowIdx - 1)
        && String(_val(r, headers, 'Name')).trim().toLowerCase() === name.toLowerCase());
      if (dup) throw new Error(`A billing category named "${name}" already exists.`);
      if (name !== String(oldVal.name)) renamedFrom = String(oldVal.name);
      updates['Name'] = name;
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    if (renamedFrom) {
      _renameTruckBillingCategory(renamedFrom, updates['Name']);
    }

    _auditLog('BILLING_CATEGORY_EDIT', SHEET_BILLING_CATEGORIES, categoryId, JSON.stringify(oldVal), JSON.stringify(changes));

    return {
      success: true,
      billingCategory: {
        id:     categoryId,
        name:   _val(row, headers, 'Name'),
        active: _val(row, headers, 'Active') !== false,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Route Type Map (Admin only)
// ============================================================

/**
 * Creates a new Route Type Map entry (route-file truck-type code → billing
 * category) used to resolve truck assignment during import.
 *
 * @param {Object} data  { fileTypeCode, billingCategory }
 * @returns {{ success: boolean, mapping: Object } | { success: false, error: string }}
 */
function createRouteTypeMapping(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  try {
    const code     = String(data.fileTypeCode || '').trim();
    const category = String(data.billingCategory || '').trim();
    if (!code) throw new Error('File type code is required.');
    if (!category) throw new Error('Billing category is required.');

    getRouteTypeMap(); // ensure the sheet exists (self-bootstraps)
    const sheet   = _getSheet(SHEET_ROUTE_TYPE_MAP);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const dup = rows.slice(1).some(row =>
      String(_val(row, headers, 'File Type Code')).trim().toUpperCase() === code.toUpperCase());
    if (dup) throw new Error(`A mapping for "${code}" already exists.`);

    const nextId = _nextRowId(sheet);
    sheet.appendRow([nextId, code, category, true]);

    _auditLog('ROUTE_TYPE_MAP_CREATE', SHEET_ROUTE_TYPE_MAP, nextId, '', `${code} → ${category}`);

    return {
      success: true,
      mapping: { id: nextId, fileTypeCode: code, billingCategory: category, active: true },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
  try {
    getRouteTypeMap(); // ensure the sheet exists
    const sheet   = _getSheet(SHEET_ROUTE_TYPE_MAP);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, mappingId);
    if (rowIdx === -1) throw new Error(`Route type mapping ID ${mappingId} not found.`);

    const row    = rows[rowIdx];
    const oldVal = {
      fileTypeCode:    _val(row, headers, 'File Type Code'),
      billingCategory: _val(row, headers, 'Billing Category'),
      active:          _val(row, headers, 'Active'),
    };

    const updates = {};
    if (changes.fileTypeCode !== undefined) {
      const code = String(changes.fileTypeCode).trim();
      if (!code) throw new Error('File type code is required.');
      const dup = rows.slice(1).some((r, i) => (i !== rowIdx - 1)
        && String(_val(r, headers, 'File Type Code')).trim().toUpperCase() === code.toUpperCase());
      if (dup) throw new Error(`A mapping for "${code}" already exists.`);
      updates['File Type Code'] = code;
    }
    if (changes.billingCategory !== undefined) {
      const category = String(changes.billingCategory).trim();
      if (!category) throw new Error('Billing category is required.');
      updates['Billing Category'] = category;
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    _auditLog('ROUTE_TYPE_MAP_EDIT', SHEET_ROUTE_TYPE_MAP, mappingId,
      JSON.stringify(oldVal), JSON.stringify(changes));

    return {
      success: true,
      mapping: {
        id:              mappingId,
        fileTypeCode:    _val(row, headers, 'File Type Code'),
        billingCategory: _val(row, headers, 'Billing Category'),
        active:          _val(row, headers, 'Active') !== false,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Employees (Admin only)
// ============================================================

/**
 * Creates a new employee record.
 * @param {Object} data  { nick, firstName, middleName, lastName, role }
 * @returns {{ success: boolean, employee: Object } | { success: false, error: string }}
 */
function createEmployee(data) {
  _requirePermission('EDIT_MASTER_RECORDS');
  try {
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

    return {
      success: true,
      employee: { id: nextId, nick, firstName, middleName, lastName, role, active: true },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Updates an employee record.
 * @param {number} employeeId
 * @param {Object} changes  Any of { nick, firstName, middleName, lastName, role, active }
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function updateEmployee(employeeId, changes) {
  _requirePermission('EDIT_MASTER_RECORDS');
  try {
    const sheet   = _getSheet(SHEET_EMPLOYEES);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, employeeId);
    if (rowIdx === -1) throw new Error(`Employee ID ${employeeId} not found.`);

    const row    = rows[rowIdx];
    const oldVal = {
      nick:   _val(row, headers, 'Nickname'),
      role:   _val(row, headers, 'Role'),
      active: _val(row, headers, 'Active'),
    };

    const updates = {};
    if (changes.nick !== undefined) {
      const nick = String(changes.nick).trim();
      if (!nick) throw new Error('Nickname is required.');
      updates['Nickname'] = nick;
    }
    if (changes.firstName  !== undefined) updates['First Name']  = String(changes.firstName).trim();
    if (changes.middleName !== undefined) updates['Middle Name'] = String(changes.middleName).trim();
    if (changes.lastName   !== undefined) updates['Last Name']   = String(changes.lastName).trim();
    if (changes.role !== undefined) {
      const role = String(changes.role).trim();
      if (!role) throw new Error('Role is required.');
      updates['Role'] = role;
    }
    if (changes.active !== undefined) updates['Active'] = !!changes.active;

    if (Object.keys(updates).length > 0) {
      _writeRowFields(sheet, row, rowIdx, headers, updates);
    }

    _auditLog('EMPLOYEE_EDIT', SHEET_EMPLOYEES, employeeId, JSON.stringify(oldVal), JSON.stringify(changes));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
