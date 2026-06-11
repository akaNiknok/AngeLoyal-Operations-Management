// ============================================================
//  AngeLoyal Logistics — Operations Management System
//  Code.gs  |  Google Apps Script Backend
//  Phase 1: Architecture, Dispatch, Waybills
//
//  Built on top of the existing Truck Roster backend.
//  All existing saveAssignment / removeAssignment / getCurrentAssignments
//  functions are preserved and updated for the new column structure.
// ============================================================


// ============================================================
//  SHEET NAME CONSTANTS
// ============================================================

// Existing sheets
const SHEET_EMPLOYEES       = 'Employees';
const SHEET_TRUCKS          = 'Trucks';
const SHEET_ASSIGNMENTS     = 'Employee-Truck Assignment';
const SHEET_AUDIT           = 'Audit Log';

// New Phase 1 sheets
const SHEET_USERS           = 'Users';
const SHEET_TRUCK_TYPE_MAP  = 'Truck Type Map';
const SHEET_WB_PREFIXES     = 'Waybill Prefixes';
const SHEET_DEFAULT_ASSIGN  = 'Default Assignments';
const SHEET_OUTLETS         = 'Outlets';
const SHEET_TRIPS           = 'Trips';
const SHEET_ROUTE_FREQ      = 'Route Frequency Log';
const SHEET_WAYBILLS        = 'Waybills';


// ============================================================
//  ROLE-BASED ACCESS CONTROL (RBAC)
// ============================================================

const ROLES = {
  ADMIN:      'Admin',
  DISPATCHER: 'Dispatcher',
  PAYROLL:    'Payroll',
  VIEWER:     'Viewer',
};

// Permissions: which roles can perform which actions.
// Each key maps to the minimum set of roles that have access.
const PERMISSIONS = {
  VIEW_DISPATCH:          [ROLES.ADMIN, ROLES.DISPATCHER, ROLES.PAYROLL, ROLES.VIEWER],
  ASSIGN_CREW:            [ROLES.ADMIN, ROLES.DISPATCHER],
  ADD_MANUAL_TRIP:        [ROLES.ADMIN, ROLES.DISPATCHER],
  FLAG_TRIP_STATUS:       [ROLES.ADMIN, ROLES.DISPATCHER],
  CONFIRM_WAYBILL:        [ROLES.ADMIN, ROLES.DISPATCHER],
  EDIT_MASTER_RECORDS:    [ROLES.ADMIN],
  VIEW_AUDIT:             [ROLES.ADMIN],
};

/**
 * Returns the current user's email via Session.
 * Falls back to 'unknown' if the script runs without an authenticated session
 * (e.g. during manual testing in the Apps Script editor).
 * @returns {string}
 */
function _getCurrentUserEmail() {
  try {
    return Session.getActiveUser().getEmail() || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Looks up the current user in the Users sheet and returns their role object.
 * Returns null if the user is not found or is inactive.
 * @returns {{ id, email, displayName, role, active } | null}
 */
function _getCurrentUserRecord() {
  try {
    const email = _getCurrentUserEmail();
    if (!email || email === 'unknown') return null;

    const sheet = _getSheet(SHEET_USERS);
    const rows  = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowEmail  = String(_val(row, headers, 'Email')).trim().toLowerCase();
      const rowActive = _val(row, headers, 'Active');
      if (rowEmail === email.toLowerCase() && rowActive === true) {
        return {
          id:          _val(row, headers, 'ID'),
          email:       rowEmail,
          displayName: _val(row, headers, 'Display Name'),
          role:        _val(row, headers, 'Role'),
          active:      true,
        };
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Checks whether the current user has a given permission.
 * @param {string} permission  Key from PERMISSIONS object.
 * @returns {boolean}
 */
function _hasPermission(permission) {
  const user = _getCurrentUserRecord();
  if (!user) return false;
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(user.role);
}

/**
 * Throws an error if the current user lacks the required permission.
 * Use at the top of any sensitive writer function.
 * @param {string} permission
 */
function _requirePermission(permission) {
  if (!_hasPermission(permission)) {
    const user = _getCurrentUserRecord();
    const role = user ? user.role : 'unauthenticated';
    throw new Error(`Access denied. Your role (${role}) does not have permission to perform this action.`);
  }
}

/**
 * Returns the current user's session info for the client UI.
 * Called on page load so the UI can show/hide features based on role.
 * @returns {{ email, displayName, role } | { email, displayName: 'Unknown', role: null }}
 */
function getUserSession() {
  const user = _getCurrentUserRecord();
  if (user) {
    return { email: user.email, displayName: user.displayName, role: user.role };
  }
  const email = _getCurrentUserEmail();
  return { email, displayName: email || 'Unknown', role: null };
}


// ============================================================
//  WEB APP ENTRY POINT
// ============================================================

/**
 * Serves the web app HTML page.
 * Deploy as: Execute as ME, Who has access: Anyone in org (or Anyone with Google account).
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'devDump') {
    return _devDump(e.parameter);
  }
  return HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('AngeLoyal OMS')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ============================================================
//  DATA READERS — Config & Master Records
// ============================================================

/**
 * Returns all active employees.
 * @returns {Object[]} Array of { id, nick, firstName, middleName, lastName, role, active }
 */
function getEmployees() {
  const sheet   = _getSheet(SHEET_EMPLOYEES);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:         _numOrNull(_val(row, headers, 'ID')),
    nick:       _val(row, headers, 'Nickname'),
    firstName:  _val(row, headers, 'First Name'),
    middleName: _val(row, headers, 'Middle Name'),
    lastName:   _val(row, headers, 'Last Name'),
    role:       _val(row, headers, 'Role'),
    active:     _val(row, headers, 'Active') !== false,
  })).filter(e => e.id !== null && e.id !== '');
}

/**
 * Returns all active trucks, with their billing category resolved from Truck Type Map.
 * Also backfills the Billing Category column in the Trucks sheet if empty.
 * @returns {Object[]} Array of { id, plate, brand, type, billingCategory, active }
 */
function getTrucks() {
  const typeMap = _buildTruckTypeMap();
  const sheet   = _getSheet(SHEET_TRUCKS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  const result = [];
  const billingCatColIdx = headers.indexOf('Billing Category');

  rows.slice(1).forEach((row, idx) => {
    const id = _numOrNull(_val(row, headers, 'ID'));
    if (id === null || id === '') return;

    const type            = _val(row, headers, 'Type') || '';
    const billingCategory = typeMap[type] || _val(row, headers, 'Billing Category') || '';
    const active          = _val(row, headers, 'Active') !== false;

    // Backfill Billing Category in sheet if it's empty and we resolved one
    if (billingCatColIdx !== -1 && billingCategory && !row[billingCatColIdx]) {
      sheet.getRange(idx + 2, billingCatColIdx + 1).setValue(billingCategory);
    }

    result.push({
      id:              id,
      plate:           _val(row, headers, 'Plate Number') || '(no plate)',
      brand:           _val(row, headers, 'Brand'),
      type:            type,
      billingCategory: billingCategory,
      active:          active,
    });
  });

  return result;
}

/**
 * Returns all truck type map entries.
 * @returns {Object[]} Array of { id, fullModelName, billingCategory }
 */
function getTruckTypeMap() {
  const sheet   = _getSheet(SHEET_TRUCK_TYPE_MAP);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:              _numOrNull(_val(row, headers, 'ID')),
    fullModelName:   _val(row, headers, 'Full Model Name'),
    billingCategory: _val(row, headers, 'Billing Category'),
  })).filter(r => r.id !== null);
}

/**
 * Returns all waybill prefix entries.
 * @returns {Object[]} Array of { id, prefix, companyName, lastSequenceNumber }
 */
function getWaybillPrefixes() {
  const sheet   = _getSheet(SHEET_WB_PREFIXES);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:                 _numOrNull(_val(row, headers, 'ID')),
    prefix:             _val(row, headers, 'Prefix'),
    companyName:        _val(row, headers, 'Company Name'),
    lastSequenceNumber: Number(_val(row, headers, 'Last Sequence Number')) || 0,
  })).filter(r => r.id !== null);
}

/**
 * Returns all default truck-crew assignments.
 * @returns {Object[]} Array of { id, truckId, defaultDriverId, defaultHelperIds, notes }
 */
function getDefaultAssignments() {
  const sheet   = _getSheet(SHEET_DEFAULT_ASSIGN);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => {
    const rawHelpers = _val(row, headers, 'Default Helper IDs');
    const helperIds  = rawHelpers
      ? String(rawHelpers).split(',').map(s => _numOrNull(s.trim())).filter(n => n !== null)
      : [];

    return {
      id:               _numOrNull(_val(row, headers, 'ID')),
      truckId:          _numOrNull(_val(row, headers, 'Truck ID')),
      defaultDriverId:  _numOrNull(_val(row, headers, 'Default Driver ID')),
      defaultHelperIds: helperIds,
      notes:            _val(row, headers, 'Notes') || '',
    };
  }).filter(r => r.id !== null);
}

/**
 * Returns all outlets, ordered by name.
 * @returns {Object[]} Array of { id, outletName, area, address, customerGroup, notes }
 */
function getOutlets() {
  const sheet   = _getSheet(SHEET_OUTLETS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:            _numOrNull(_val(row, headers, 'ID')),
    outletName:    _val(row, headers, 'Outlet Name'),
    area:          _val(row, headers, 'Area'),
    address:       _val(row, headers, 'Address'),
    customerGroup: _val(row, headers, 'Customer Group'),
    notes:         _val(row, headers, 'Notes'),
  })).filter(r => r.id !== null);
}


// ============================================================
//  DATA READERS — Trips & Dispatch
// ============================================================

/**
 * Returns trips for a given date range (inclusive).
 * If no dates provided, returns today's trips.
 *
 * @param {string} [dateFrom]  'M/d/yyyy' or null for today
 * @param {string} [dateTo]    'M/d/yyyy' or null for today
 * @returns {Object[]}
 */
function getTrips(dateFrom, dateTo) {
  const sheet   = _getSheet(SHEET_TRIPS);
  const rows    = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.toString().trim());

  const tz = Session.getScriptTimeZone();
  const today = new Date();
  const from  = dateFrom ? _parseDate(dateFrom) : _startOfDay(today);
  const to    = dateTo   ? _parseDate(dateTo)   : _startOfDay(today);

  return rows.slice(1).map(row => {
    const id = _numOrNull(_val(row, headers, 'ID'));
    if (id === null) return null;

    const tripDate    = _readDateCell(_val(row, headers, 'Trip Date'));
    const billingDate = _readDateCell(_val(row, headers, 'Billing Date'));

    if (!tripDate) return null;
    const tripStart = _startOfDay(tripDate);
    if (tripStart < from || tripStart > to) return null;

    const rawHelpers = _val(row, headers, 'Helper IDs');
    const helperIds  = rawHelpers
      ? String(rawHelpers).split(',').map(s => _numOrNull(s.trim())).filter(n => n !== null)
      : [];

    return {
      id:                  id,
      tripDate:            _formatDate(tripDate),
      billingDate:         _formatDate(billingDate),
      foNumber:            _val(row, headers, 'FO Number') || '',
      foSplitSuffix:       _val(row, headers, 'FO Split Suffix') || '',
      outletId:            _numOrNull(_val(row, headers, 'Outlet ID')),
      area:                _val(row, headers, 'Area') || '',
      quantity:            _numOrNull(_val(row, headers, 'Quantity')),
      cbm:                 _numOrNull(_val(row, headers, 'CBM')),
      restrictions:        _val(row, headers, 'Restrictions') || '',
      truckId:             _numOrNull(_val(row, headers, 'Truck ID')),
      driverId:            _numOrNull(_val(row, headers, 'Driver ID')),
      helperIds:           helperIds,
      truckBillingCategory: _val(row, headers, 'Truck Billing Category') || '',
      tripStatus:          _val(row, headers, 'Trip Status') || 'Scheduled',
      parentTripId:        _numOrNull(_val(row, headers, 'Parent Trip ID')),
      source:              _val(row, headers, 'Source') || 'Import',
      tier:                _numOrNull(_val(row, headers, 'Tier')),
      remarks:             _val(row, headers, 'Remarks') || '',
      statusChangedBy:     _val(row, headers, 'Status Changed By') || '',
      statusChangedAt:     _valDateTime(row, headers, 'Status Changed At'),
      addedBy:             _val(row, headers, 'Added By') || '',
      addedAt:             _valDateTime(row, headers, 'Added At'),
    };
  }).filter(t => t !== null);
}

/**
 * Returns all trips for a date along with pre-resolved display data
 * (outlet name, driver nick, truck plate) so the UI doesn't need separate lookups.
 *
 * @param {string} dateStr  'M/d/yyyy'
 * @returns {Object}
 */
function getDispatchBoardData(dateStr) {
  const trips    = getTrips(dateStr, dateStr);
  const outlets  = _indexById(getOutlets());
  const employees = _indexById(getEmployees());
  const trucks   = _indexById(getTrucks());

  const enriched = trips.map(trip => {
    const outlet = outlets[trip.outletId] || {};
    const driver = employees[trip.driverId] || {};
    const truck  = trucks[trip.truckId]    || {};
    const helpers = trip.helperIds.map(hid => {
      const h = employees[hid];
      return h ? { id: hid, nick: h.nick } : { id: hid, nick: '?' };
    });

    return Object.assign({}, trip, {
      outletName:    outlet.outletName || '',
      driverNick:    driver.nick || '',
      truckPlate:    truck.plate || '',
      truckType:     truck.type || '',
      helperDetails: helpers,
    });
  });

  return {
    trips: enriched,
    date:  dateStr,
  };
}

/**
 * Returns all waybills for a given trip ID.
 * @param {number} tripId
 * @returns {Object[]}
 */
function getWaybillsForTrip(tripId) {
  const sheet   = _getSheet(SHEET_WAYBILLS);
  const rows    = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:              _numOrNull(_val(row, headers, 'ID')),
    waybillNumber:   _val(row, headers, 'Waybill Number'),
    prefixId:        _numOrNull(_val(row, headers, 'Prefix ID')),
    sequenceNumber:  _numOrNull(_val(row, headers, 'Sequence Number')),
    tripId:          _numOrNull(_val(row, headers, 'Trip ID')),
    foNumber:        _val(row, headers, 'FO Number'),
    waybillType:     _val(row, headers, 'Waybill Type'),
    parentWaybillId: _numOrNull(_val(row, headers, 'Parent Waybill ID')),
    status:          _val(row, headers, 'Status'),
    locked:          _val(row, headers, 'Locked') === true || _val(row, headers, 'Locked') === 'TRUE',
    confirmedBy:     _val(row, headers, 'Confirmed By'),
    confirmedAt:     _valDateTime(row, headers, 'Confirmed At'),
  })).filter(w => w.id !== null && Number(w.tripId) === Number(tripId));
}

/**
 * Returns the suggested next waybill number for a given prefix.
 * Does NOT write anything to the sheet.
 *
 * @param {number} prefixId
 * @returns {{ prefixId, prefix, nextNumber, suggested: string }}
 */
function getSuggestedWaybillNumber(prefixId) {
  const prefixes = getWaybillPrefixes();
  const pref     = prefixes.find(p => Number(p.id) === Number(prefixId));
  if (!pref) throw new Error(`Waybill prefix ID ${prefixId} not found.`);

  const next      = (pref.lastSequenceNumber || 0) + 1;
  const suggested = `${pref.prefix}-${next}`;
  return { prefixId: pref.id, prefix: pref.prefix, nextNumber: next, suggested };
}

/**
 * Returns route frequency data for a specific driver within a rolling window.
 * Used by the UI to surface the "assigned too often to same outlet" warning.
 *
 * @param {number} driverId
 * @param {number} [windowDays=21]
 * @returns {Object[]} Array of { outletId, count, outletName }
 */
function getRouteFrequencyForDriver(driverId, windowDays) {
  windowDays = windowDays || 21;
  const sheet   = _getSheet(SHEET_ROUTE_FREQ);
  const rows    = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  const headers   = rows[0].map(h => h.toString().trim());
  const cutoff    = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffMs  = cutoff.getTime();

  const counts = {};
  rows.slice(1).forEach(row => {
    if (Number(_val(row, headers, 'Driver ID')) !== Number(driverId)) return;
    const tripDateRaw = _val(row, headers, 'Trip Date');
    const tripDate    = _readDateCell(tripDateRaw);
    if (!tripDate || tripDate.getTime() < cutoffMs) return;
    const oid = Number(_val(row, headers, 'Outlet ID'));
    counts[oid] = (counts[oid] || 0) + 1;
  });

  const outlets = _indexById(getOutlets());
  return Object.entries(counts).map(([oid, count]) => ({
    outletId:   Number(oid),
    count:      count,
    outletName: (outlets[oid] || {}).outletName || '',
  }));
}

/**
 * Returns the latest assignment per employee from the Employee-Truck Assignment sheet.
 * Used by the Truck Roster web app.
 * Updated: removed reference to deleted Employee Nickname / Truck Plate Number columns.
 *
 * @returns {Object[]} Array of { id, dateMs, employeeId, truckId, type }
 */
function getCurrentAssignments() {
  const sheet   = _getSheet(SHEET_ASSIGNMENTS);
  const rows    = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.toString().trim());

  const all = rows.slice(1).map(row => {
    const rawTruckId = _val(row, headers, 'Truck ID');
    const rawDate    = _val(row, headers, 'Date');
    const dateMs     = (rawDate instanceof Date) ? rawDate.getTime() : new Date(rawDate).getTime();

    return {
      id:         _numOrNull(_val(row, headers, 'ID')),
      dateMs:     isNaN(dateMs) ? 0 : dateMs,
      employeeId: Number(_val(row, headers, 'Employee ID')),
      truckId:    (rawTruckId === '' || rawTruckId === null || rawTruckId === undefined)
                    ? null
                    : Number(rawTruckId),
      type:       _val(row, headers, 'Type'),
    };
  }).filter(a => a.employeeId);

  // Latest assignment per employee
  const latest = {};
  all.forEach(a => {
    const prev = latest[a.employeeId];
    if (!prev || a.dateMs >= prev.dateMs) latest[a.employeeId] = a;
  });

  return Object.values(latest).filter(a => a.truckId !== null);
}


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
 * Updates the trip status and optional remarks.
 * Handles carry-over logic for Redeliver / Foul Trip - For Redeliver.
 *
 * @param {number} tripId
 * @param {string} newStatus  One of the Trip Status enum values.
 * @param {string} [remarks]
 * @returns {{ success: boolean, newTripId?: number } | { success: false, error: string }}
 */
function updateTripStatus(tripId, newStatus, remarks) {
  _requirePermission('FLAG_TRIP_STATUS');
  try {
    const sheet   = _getSheet(SHEET_TRIPS);
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const rowIdx = _findRowById(rows, headers, tripId);
    if (rowIdx === -1) throw new Error(`Trip ID ${tripId} not found.`);

    const row       = rows[rowIdx];
    const oldStatus = _val(row, headers, 'Trip Status');
    const email     = _getCurrentUserEmail();
    const now       = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');

    // Update status, status metadata, and remarks
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Trip Status',       newStatus);
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Status Changed By', email);
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Status Changed At', now);
    if (remarks !== undefined && remarks !== null) {
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Remarks', remarks);
    }

    // Audit
    _auditLog('TRIP_STATUS_CHANGE', SHEET_TRIPS, tripId, oldStatus, newStatus);

    // Carry-over: create a follow-up trip for next business day
    let newTripId = null;
    const carryoverStatuses = ['Foul Trip - For Redeliver', 'Redeliver'];
    if (carryoverStatuses.includes(newStatus)) {
      newTripId = _createCarryoverTrip(row, headers, tripId, newStatus);
    }

    return { success: true, newTripId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Reassigns the driver and/or truck for an existing trip.
 * Updates the Truck Billing Category snapshot if the truck changes.
 * Updates the Route Frequency Log if the driver changes.
 *
 * @param {number} tripId
 * @param {Object} changes  Any of: { truckId, driverId, helperIds }
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function reassignTrip(tripId, changes) {
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

    if (changes.truckId !== undefined) {
      const newBillingCat = _resolveBillingCategory(changes.truckId) || '';
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Truck ID',               changes.truckId);
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Truck Billing Category', newBillingCat);
    }
    if (changes.driverId !== undefined) {
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Driver ID', changes.driverId);
    }
    if (changes.helperIds !== undefined) {
      const helperStr = Array.isArray(changes.helperIds)
        ? changes.helperIds.join(',')
        : (changes.helperIds || '');
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Helper IDs', helperStr);
    }

    // Update Route Frequency Log if driver changed
    if (changes.driverId !== undefined && changes.driverId !== oldDriverId) {
      const outletId = _numOrNull(_val(row, headers, 'Outlet ID'));
      const tripDate = _formatDate(_readDateCell(_val(row, headers, 'Trip Date')));
      if (outletId && changes.driverId) {
        _appendRouteFrequency(tripId, tripDate, changes.driverId, outletId);
      }
    }

    _auditLog('TRIP_REASSIGN', SHEET_TRIPS, tripId,
      JSON.stringify({ driverId: oldDriverId, truckId: oldTruckId }),
      JSON.stringify({ driverId: changes.driverId, truckId: changes.truckId }));

    return { success: true };
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

    // Lock the row
    const email = _getCurrentUserEmail();
    const now   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Waybill Number',  finalNumber);
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Sequence Number', seqNumber);
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Status',          'Confirmed');
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Locked',          true);
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Confirmed By',    email);
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Confirmed At',    now);

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

    const row      = rows[rowIdx];
    const oldDriver = _val(row, headers, 'Default Driver ID');
    const oldHelpers = _val(row, headers, 'Default Helper IDs');

    if (changes.defaultDriverId !== undefined) {
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Default Driver ID', changes.defaultDriverId);
    }
    if (changes.defaultHelperIds !== undefined) {
      const helperStr = Array.isArray(changes.defaultHelperIds)
        ? changes.defaultHelperIds.join(',')
        : (changes.defaultHelperIds || '');
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Default Helper IDs', helperStr);
    }
    if (changes.notes !== undefined) {
      _setCellByHeader(sheet, rowIdx + 1, headers, 'Notes', changes.notes);
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
 * Updates an outlet record.
 * @param {number} outletId
 * @param {Object} changes  Any of { area, address, customerGroup, notes }
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
      area:          _val(row, headers, 'Area'),
      address:       _val(row, headers, 'Address'),
      customerGroup: _val(row, headers, 'Customer Group'),
      notes:         _val(row, headers, 'Notes'),
    };

    if (changes.area          !== undefined) _setCellByHeader(sheet, rowIdx + 1, headers, 'Area',           changes.area);
    if (changes.address       !== undefined) _setCellByHeader(sheet, rowIdx + 1, headers, 'Address',        changes.address);
    if (changes.customerGroup !== undefined) _setCellByHeader(sheet, rowIdx + 1, headers, 'Customer Group', changes.customerGroup);
    if (changes.notes         !== undefined) _setCellByHeader(sheet, rowIdx + 1, headers, 'Notes',          changes.notes);

    _auditLog('OUTLET_EDIT', SHEET_OUTLETS, outletId, JSON.stringify(oldVal), JSON.stringify(changes));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  DATA WRITERS — Truck Roster (existing, updated column structure)
// ============================================================

/**
 * Appends a new assignment row to the Employee-Truck Assignment sheet.
 * Updated: removed Employee Nickname and Truck Plate Number columns.
 *
 * @param {number} employeeId
 * @param {number} truckId
 * @param {string} type  'Driver' | 'Helper'
 * @returns {{ success: boolean, rowId: number } | { success: false, error: string }}
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

    return { success: true, rowId: nextId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Removes an employee from their current truck (append-only: writes a null truck row).
 * Updated: removed Employee Nickname and Truck Plate Number columns.
 *
 * @param {number} employeeId
 * @param {string} type  'Driver' | 'Helper'
 * @returns {{ success: boolean } | { success: false, error: string }}
 */
function removeAssignment(employeeId, type) {
  _requirePermission('ASSIGN_CREW');
  try {
    const sheet  = _getSheet(SHEET_ASSIGNMENTS);
    const nextId = _nextRowId(sheet);

    // Empty truckId signals "unassigned"
    sheet.appendRow([
      nextId,
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss'),
      employeeId,
      '',   // null truckId
      type,
    ]);

    _auditLog('REMOVE', SHEET_ASSIGNMENTS, nextId, '',
      `Employee ${employeeId} unassigned`);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ============================================================
//  AUDIT LOG
// ============================================================

/**
 * Appends a row to the Audit Log sheet.
 * Extended to include Table, Row ID, Old Value, New Value columns.
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

  const current = Number(_val(rows[rowIdx], headers, 'Last Sequence Number')) || 0;
  if (newSeqNumber > current) {
    _setCellByHeader(sheet, rowIdx + 1, headers, 'Last Sequence Number', newSeqNumber);
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
//  INTERNAL HELPERS — Truck Type Map
// ============================================================

/**
 * Builds a { fullModelName → billingCategory } lookup from the Truck Type Map sheet.
 * @returns {Object}
 */
function _buildTruckTypeMap() {
  const sheet   = _getSheet(SHEET_TRUCK_TYPE_MAP);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  const map = {};
  rows.slice(1).forEach(row => {
    const name = _val(row, headers, 'Full Model Name');
    const cat  = _val(row, headers, 'Billing Category');
    if (name) map[name.trim()] = cat || '';
  });
  return map;
}

/**
 * Resolves the billing category for a given truck ID.
 * @param {number} truckId
 * @returns {string}
 */
function _resolveBillingCategory(truckId) {
  if (!truckId) return '';
  const typeMap = _buildTruckTypeMap();
  const sheet   = _getSheet(SHEET_TRUCKS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  for (let i = 1; i < rows.length; i++) {
    if (Number(_val(rows[i], headers, 'ID')) === Number(truckId)) {
      const type = _val(rows[i], headers, 'Type') || '';
      return typeMap[type] || _val(rows[i], headers, 'Billing Category') || '';
    }
  }
  return '';
}


// ============================================================
//  INTERNAL HELPERS — General utilities
// ============================================================

/**
 * Returns the sheet by name, throwing a clear error if not found.
 * @param {string} name
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _getSheet(name) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error(`Sheet "${name}" not found. Check that the sheet name matches exactly.`);
  return sheet;
}

/**
 * Gets the value at a named column header position in a row.
 * Returns '' if the column doesn't exist or the value is null/undefined.
 *
 * @param {Array}  row
 * @param {Array}  headers
 * @param {string} colName
 * @returns {*}
 */
function _val(row, headers, colName) {
  const idx = headers.indexOf(colName);
  if (idx === -1) return '';
  const v = row[idx];
  return (v === null || v === undefined) ? '' : v;
}

/**
 * Reads a cell that should be a timestamp string. If Sheets has auto-converted
 * the cell to a Date object (e.g. because the column is date-formatted),
 * formats it back to 'M/d/yyyy HH:mm:ss' so it serializes safely over
 * google.script.run (which can't handle raw Date objects nested in arrays).
 *
 * @param {Array} row
 * @param {string[]} headers
 * @param {string} colName
 * @returns {string}
 */
function _valDateTime(row, headers, colName) {
  const v = _val(row, headers, colName);
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
  return v || '';
}

/**
 * Converts a value to a number or returns null if not numeric.
 * Guards against Google Sheets returning empty strings for blank numeric cells.
 *
 * @param {*} v
 * @returns {number|null}
 */
function _numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/**
 * Reads a date cell value safely.
 * Google Sheets returns Date objects for formatted date cells and numeric serial numbers
 * for unformatted ones. Returns a JS Date or null.
 *
 * @param {*} val
 * @returns {Date|null}
 */
function _readDateCell(val) {
  if (!val || val === '') return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') return new Date((val - 25569) * 86400000); // Excel serial → JS Date
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parses a date string in 'M/d/yyyy' format into a JS Date at midnight.
 * @param {string} str
 * @returns {Date}
 */
function _parseDate(str) {
  if (!str) return new Date();
  const parts = str.split('/');
  if (parts.length < 3) return new Date(str);
  return new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]));
}

/**
 * Returns a Date set to midnight (start of day) in the script timezone.
 * @param {Date} d
 * @returns {Date}
 */
function _startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * Formats a Date as 'M/d/yyyy'.
 * @param {Date|null} d
 * @returns {string}
 */
function _formatDate(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/**
 * Returns the next business day (Monday-Saturday schedule; skips Sundays).
 * Adjust the logic here if the warehouse has different rest days.
 *
 * @param {Date} from
 * @returns {Date}
 */
function _nextBusinessDay(from) {
  const next = new Date(from);
  next.setDate(next.getDate() + 1);
  // Skip Sundays (0 = Sunday)
  if (next.getDay() === 0) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Computes the next available ID for a sheet by reading the last row's ID column.
 * Assumes column 1 is the ID column.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {number}
 */
function _nextRowId(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const lastId = Number(sheet.getRange(lastRow, 1).getValue());
  return isNaN(lastId) ? lastRow : lastId + 1;
}

/**
 * Appends multiple rows to a sheet in a single Sheets API call.
 * No-op if `rows2D` is empty.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array[]} rows2D  Array of row arrays, all the same length.
 */
function _appendRows(sheet, rows2D) {
  if (!rows2D || rows2D.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows2D.length, rows2D[0].length).setValues(rows2D);
}

/**
 * Finds the (1-based) row index of a row with a matching ID value.
 * Returns -1 if not found.
 * rowIdx returned is 0-based into the rows array; add 1 for sheet row number.
 *
 * @param {Array[]}  rows
 * @param {Array}    headers
 * @param {number}   id
 * @returns {number}  0-based index into rows array (rows[0] = header, rows[1] = first data row)
 */
function _findRowById(rows, headers, id) {
  const idIdx = headers.indexOf('ID');
  if (idIdx === -1) return -1;
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i][idIdx]) === Number(id)) return i;
  }
  return -1;
}

/**
 * Sets a cell value in a specific row by column header name.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} sheetRowNumber  1-based row number in the sheet
 * @param {Array}  headers
 * @param {string} colName
 * @param {*}      value
 */
function _setCellByHeader(sheet, sheetRowNumber, headers, colName, value) {
  const colIdx = headers.indexOf(colName);
  if (colIdx === -1) throw new Error(`Column "${colName}" not found in sheet "${sheet.getName()}".`);
  sheet.getRange(sheetRowNumber, colIdx + 1).setValue(value);
}

/**
 * Builds a { id → object } index from an array of objects that have an `id` field.
 * @param {Object[]} arr
 * @returns {Object}
 */
function _indexById(arr) {
  const map = {};
  (arr || []).forEach(item => { if (item.id !== null) map[item.id] = item; });
  return map;
}


// ============================================================
//  DEV DATA DUMP — read-only export for local testing
// ============================================================

/**
 * Read-only JSON dump of one or all sheets, gated by a shared-secret token
 * stored in Script Properties (DEV_DUMP_TOKEN). Used by local tooling
 * (scripts/fetch-sheet-data.js) to pull a snapshot of the live data for
 * tests/verification. Not linked from the UI.
 *
 * Usage: ?action=devDump&token=...           -> all sheets
 *        ?action=devDump&token=...&sheet=Trips -> single sheet
 *
 * @param {Object} params  e.parameter from doGet
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _devDump(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('DEV_DUMP_TOKEN');
  const out = (body) => ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);

  if (!expected || params.token !== expected) {
    return out({ error: 'forbidden' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetNames = params.sheet ? [params.sheet] : ss.getSheets().map(s => s.getName());

  const result = {};
  sheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    result[name] = sheet ? sheet.getDataRange().getValues() : null;
  });

  return out(result);
}

/**
 * One-time setup: generates and stores a random token in Script Properties
 * for the devDump endpoint. Run this once from the Apps Script editor
 * (select this function, click Run), then copy the token from the
 * execution log into your local .env as DEV_DUMP_TOKEN.
 * @returns {string} the generated token (also logged)
 */
function setupDevDumpToken() {
  const token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('DEV_DUMP_TOKEN', token);
  Logger.log('DEV_DUMP_TOKEN = %s', token);
  return token;
}
