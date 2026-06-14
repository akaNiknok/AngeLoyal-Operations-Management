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
      updates['Truck ID']               = changes.truckId;
      updates['Truck Billing Category'] = _resolveBillingCategory(changes.truckId) || '';
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
    const locked = _val(row, headers, 'Locked');
    if (locked === true || locked === 'TRUE') {
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
            && (_val(r, headers, 'Locked') === true || _val(r, headers, 'Locked') === 'TRUE');
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
 *   foNumber, outletName, area, address, quantity, cbm, restrictions, tier
 *
 * For each row:
 *   - Auto-seeds the Outlets sheet if the outlet is new.
 *   - Pre-fills driver/truck from Default Assignments.
 *   - Creates a suggested waybill.
 *   - Appends to Route Frequency Log if a default driver is known.
 *
 * Unlike createTrip (used for single manual trips), this writes each affected
 * sheet in one batch at the end instead of once per row — needed because a
 * 44-row import previously meant 400+ individual Sheets API calls.
 *
 * @param {string}   tripDate   'M/d/yyyy' — the date these trips are for
 * @param {number}   prefixId   Waybill prefix to use for auto-generation
 * @param {Object[]} rowData    Array of parsed route rows
 * @returns {{ success: boolean, imported: number, skipped: number, errors: string[] }}
 */
function importRouteFile(tripDate, prefixId, rowData) {
  _requirePermission('ADD_MANUAL_TRIP');
  try {
    const defaults = getDefaultAssignments();    // [{truckId, defaultDriverId, defaultHelperIds}]
    const trucks   = getTrucks();

    // Build a lookup of restriction → list of trucks that match that billing category
    // so we can pre-fill the most likely truck per row.
    const trucksByCategory = {};
    trucks.forEach(t => {
      const cat = t.billingCategory || '';
      if (!trucksByCategory[cat]) trucksByCategory[cat] = [];
      trucksByCategory[cat].push(t);
    });

    // Build default assignment lookup by truckId
    const defaultByTruck = {};
    defaults.forEach(d => { defaultByTruck[d.truckId] = d; });

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

    // --- Waybill prefix: track the running sequence number in-memory so
    //     every row in this import gets a unique suggested number ---
    const prefixes = getWaybillPrefixes();
    const pref = prefixes.find(p => Number(p.id) === Number(prefixId));
    if (!pref) throw new Error(`Waybill prefix ID ${prefixId} not found.`);
    let nextSeq = pref.lastSequenceNumber || 0;

    // --- Next IDs for the sheets we'll append to ---
    const tripsSheet     = _getSheet(SHEET_TRIPS);
    const waybillsSheet  = _getSheet(SHEET_WAYBILLS);
    const routeFreqSheet = _getSheet(SHEET_ROUTE_FREQ);
    const auditSheet     = _getSheet(SHEET_AUDIT);
    let nextTripId      = _nextRowId(tripsSheet);
    let nextWaybillId   = _nextRowId(waybillsSheet);
    let nextRouteFreqId = _nextRowId(routeFreqSheet);
    let nextAuditId     = _nextRowId(auditSheet);

    const newTripRows      = [];
    const newWaybillRows   = [];
    const newRouteFreqRows = [];
    const newAuditRows     = [];

    const email  = _getCurrentUserEmail();
    const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

    let imported = 0;
    let skipped  = 0;
    const errors = [];

    rowData.forEach((rd, idx) => {
      try {
        if (!rd.foNumber && !rd.outletName) { skipped++; return; }

        // Resolve or create the outlet
        let outletId = '';
        if (rd.outletName) {
          const nameLower = rd.outletName.trim().toLowerCase();
          if (outletNameToId[nameLower] !== undefined) {
            outletId = outletNameToId[nameLower];
          } else {
            outletId = nextOutletId++;
            outletNameToId[nameLower] = outletId;
            newOutletRows.push([
              outletId,
              rd.outletName.trim(),
              rd.area    || '',
              rd.address || '',
              '',   // Customer Group
              '',   // Notes
              nowStr,
            ]);
          }
        }

        // Try to match a truck to the restriction hint (e.g. "6W", "4W", "L300")
        // If no match, leave truck/driver blank for dispatcher to fill
        const restriction      = (rd.restrictions || '').trim().toUpperCase();
        const matchedTrucks    = trucksByCategory[restriction] || [];
        const candidateTruck   = matchedTrucks[0] || null;
        const candidateDefault = candidateTruck ? defaultByTruck[candidateTruck.id] : null;

        const truckId    = candidateTruck   ? candidateTruck.id                 : '';
        const driverId   = candidateDefault ? candidateDefault.defaultDriverId  : '';
        const helperIds  = candidateDefault ? candidateDefault.defaultHelperIds : [];
        const billingCat = candidateTruck   ? candidateTruck.billingCategory    : '';

        // Trip row
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
          rd.restrictions || '',
          truckId,
          driverId,
          Array.isArray(helperIds) ? helperIds.join(',') : (helperIds || ''),
          billingCat,
          'Scheduled',
          '',                      // Parent Trip ID
          'Import',
          rd.tier || '',
          '',                      // Remarks
          '',                      // Status Changed By
          '',                      // Status Changed At
          email,
          nowStr,
        ]);

        // Suggested waybill — sequence increments per row within this import
        nextSeq += 1;
        const waybillId = nextWaybillId++;
        newWaybillRows.push([
          waybillId,
          `${pref.prefix}-${nextSeq}`,
          prefixId,
          nextSeq,
          tripId,
          rd.foNumber || '',
          'Regular',
          '',                      // Parent Waybill ID
          'Suggested',
          false,
          '',                      // Confirmed By
          '',                      // Confirmed At
        ]);

        // Route frequency log
        if (driverId && outletId) {
          newRouteFreqRows.push([nextRouteFreqId++, tripId, tripDate, driverId, outletId]);
        }

        // Audit log
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
      } catch (rowErr) {
        errors.push(`Row ${idx + 1}: ${rowErr.message}`);
        skipped++;
      }
    });

    _appendRows(outletsSheet, newOutletRows);
    _appendRows(tripsSheet, newTripRows);
    _appendRows(waybillsSheet, newWaybillRows);
    _appendRows(routeFreqSheet, newRouteFreqRows);
    _appendRows(auditSheet, newAuditRows);

    return { success: true, imported, skipped, errors };
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
    const confirmed = wbs.some(w => w.locked === true);
    if (confirmed) {
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


// ============================================================
//  DATA WRITERS — Default Assignments (Admin only)
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
  _requirePermission('EDIT_MASTER_RECORDS');
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


// ============================================================
//  DATA WRITERS — Truck Roster
// ============================================================

/**
 * Appends a new assignment row to the Employee-Truck Assignment sheet.
 * Returns the new row so the client can patch its local roster state
 * without a follow-up getCurrentAssignments() call.
 *
 * @param {number} employeeId
 * @param {number} truckId
 * @param {string} type  'Driver' | 'Helper'
 * @returns {{ success: boolean, row: { id, dateMs, employeeId, truckId, type } } | { success: false, error: string }}
 */
function saveAssignment(employeeId, truckId, type) {
  _requirePermission('ASSIGN_CREW');
  try {
    const sheet   = _getSheet(SHEET_ASSIGNMENTS);
    const nextId  = _nextRowId(sheet);
    const now     = new Date();

    // Column order: ID | Date | Employee ID | Truck ID | Type
    sheet.appendRow([
      nextId,
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss'),
      employeeId,
      truckId,
      type,
    ]);

    _auditLog('ASSIGN', SHEET_ASSIGNMENTS, nextId, '',
      `Employee ${employeeId} → Truck ${truckId} as ${type}`);

    return {
      success: true,
      row: { id: nextId, dateMs: now.getTime(), employeeId: Number(employeeId), truckId: Number(truckId), type: type },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Removes an employee from their current truck (append-only: writes a null truck row).
 * Returns the new row so the client can remove the employee from its local
 * roster state without a follow-up getCurrentAssignments() call.
 *
 * @param {number} employeeId
 * @param {string} type  'Driver' | 'Helper'
 * @returns {{ success: boolean, row: { id, dateMs, employeeId, truckId: null, type } } | { success: false, error: string }}
 */
function removeAssignment(employeeId, type) {
  _requirePermission('ASSIGN_CREW');
  try {
    const sheet  = _getSheet(SHEET_ASSIGNMENTS);
    const nextId = _nextRowId(sheet);
    const now    = new Date();

    // Empty truckId signals "unassigned"
    sheet.appendRow([
      nextId,
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss'),
      employeeId,
      '',   // null truckId
      type,
    ]);

    _auditLog('REMOVE', SHEET_ASSIGNMENTS, nextId, '',
      `Employee ${employeeId} unassigned`);

    return {
      success: true,
      row: { id: nextId, dateMs: now.getTime(), employeeId: Number(employeeId), truckId: null, type: type },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
