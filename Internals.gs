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
//  INTERNAL HELPERS — Waybill logic
// ============================================================

/**
 * Creates a Suggested waybill row for a trip.
 * Does NOT confirm or lock it.
 *
 * @param {number} tripId
 * @param {number} prefixId
 * @param {string} foNumber
 * @param {string} waybillType  'Regular' | 'Redeliver' | 'Foul Trip'
 * @param {number|null} parentWaybillId
 * @returns {{ id: number, waybillNumber: string }}
 */
function _createSuggestedWaybill(tripId, prefixId, foNumber, waybillType, parentWaybillId) {
  const sheet    = _getSheet(SHEET_WAYBILLS);
  const prefixes = getWaybillPrefixes();
  const pref     = prefixes.find(p => Number(p.id) === Number(prefixId));
  if (!pref) throw new Error(`Waybill prefix ID ${prefixId} not found.`);

  const nextSeq = (pref.lastSequenceNumber || 0) + 1;
  let suffix    = '';
  if (waybillType === 'Redeliver')  suffix = '-R';
  if (waybillType === 'Foul Trip')  suffix = '-FT';

  const waybillNumber = `${pref.prefix}-${nextSeq}${suffix}`;
  const nextId        = _nextRowId(sheet);

  sheet.appendRow([
    nextId,
    waybillNumber,
    prefixId,
    nextSeq,
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
}

/**
 * Updates the Last Sequence Number in the Waybill Prefixes sheet.
 * Only updates if the new sequence number is higher than the stored one
 * (protects against out-of-order confirmations).
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

  const row     = rows[rowIdx];
  const current = Number(_val(row, headers, 'Last Sequence Number')) || 0;
  if (newSeqNumber > current) {
    _writeRowFields(sheet, row, rowIdx, headers, { 'Last Sequence Number': newSeqNumber });
  }
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
    const locked  = _val(row, headers, 'Locked');
    if (Number(rowTrip) === Number(tripId) && locked !== true && locked !== 'TRUE') {
      sheet.deleteRow(i + 1);
    }
  }
}


// ============================================================
//  INTERNAL HELPERS — Trip carry-over logic
// ============================================================

/**
 * Creates a carry-over trip for the next business day.
 * Called automatically when a trip is marked as Redeliver or Foul Trip - For Redeliver.
 *
 * @param {Array}  originalRow   The raw row array from the Trips sheet
 * @param {Array}  headers       The header row array
 * @param {number} originalTripId
 * @param {string} statusReason  The status that triggered the carry-over
 * @returns {number} The new trip ID
 */
function _createCarryoverTrip(originalRow, headers, originalTripId, statusReason) {
  const nextDay = _nextBusinessDay(new Date());
  const nextDayStr = _formatDate(nextDay);

  // Determine waybill type for the new trip's suggested waybill
  const waybillType = statusReason === 'Redeliver' ? 'Redeliver' : 'Foul Trip';

  // Find the confirmed waybill for the original trip (to get prefix and parent ID)
  const wbs           = getWaybillsForTrip(originalTripId);
  const confirmedWb   = wbs.find(w => w.locked) || wbs[0];
  const prefixId      = confirmedWb ? confirmedWb.prefixId : null;
  const parentWbId    = confirmedWb ? confirmedWb.id       : null;

  const foNumber       = _val(originalRow, headers, 'FO Number');
  const outletId       = _numOrNull(_val(originalRow, headers, 'Outlet ID'));
  const truckId        = _numOrNull(_val(originalRow, headers, 'Truck ID'));
  const driverId       = _numOrNull(_val(originalRow, headers, 'Driver ID'));
  const rawHelpers     = _val(originalRow, headers, 'Helper IDs');
  const helperIds      = rawHelpers ? String(rawHelpers).split(',').map(s => s.trim()).filter(Boolean) : [];
  const billingCat     = _val(originalRow, headers, 'Truck Billing Category');
  const billingDate    = _val(originalRow, headers, 'Billing Date')
                        || _val(originalRow, headers, 'Trip Date');
  const area           = _val(originalRow, headers, 'Area');
  const tier           = _val(originalRow, headers, 'Tier');

  const sheet   = _getSheet(SHEET_TRIPS);
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
    'Scheduled',     // New trip starts as Scheduled
    originalTripId,  // Parent Trip ID
    'Carry-over',
    tier,
    `Carried over from Trip ${originalTripId} (${statusReason})`,
    '',
    '',
    email,
    now,
  ]);

  // Suggest waybill with correct suffix
  if (prefixId) {
    _createSuggestedWaybill(nextId, prefixId, foNumber, waybillType, parentWbId);
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
    const sheet  = _getSheet(SHEET_ROUTE_FREQ);
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
