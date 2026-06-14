// ============================================================
//  AngeLoyal OMS — DataReaders.gs
//  Read-only sheet accessors.
// ============================================================


// ============================================================
//  BOOT — single round trip for all master data
// ============================================================

/**
 * Returns everything the client needs to boot the UI in one call:
 * session info + all master/reference data.
 * Replaces 7 separate google.script.run calls at startup.
 *
 * @returns {{ session: Object, employees: Object[], trucks: Object[],
 *             rosterAssignments: Object[], waybillPrefixes: Object[],
 *             outlets: Object[], defaultAssignments: Object[],
 *             billingCategories: Object[] }}
 */
function getBootData() {
  return {
    session:            getUserSession(),
    employees:          getEmployees(),
    trucks:             getTrucks(),
    rosterAssignments:  getCurrentAssignments(),
    waybillPrefixes:    getWaybillPrefixes(),
    outlets:            getOutlets(),
    defaultAssignments: getDefaultAssignments(),
    billingCategories:  getBillingCategories(),
  };
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
 * Returns all trucks.
 * @returns {Object[]} Array of { id, plate, brand, type, billingCategory, active }
 */
function getTrucks() {
  const sheet   = _getSheet(SHEET_TRUCKS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => {
    const id = _numOrNull(_val(row, headers, 'ID'));
    if (id === null) return null;

    return {
      id:              id,
      plate:           _val(row, headers, 'Plate Number') || '(no plate)',
      brand:           _val(row, headers, 'Brand'),
      type:            _val(row, headers, 'Type'),
      billingCategory: _val(row, headers, 'Billing Category') || '',
      active:          _val(row, headers, 'Active') !== false,
    };
  }).filter(t => t !== null);
}

/**
 * Returns all billing category entries.
 * @returns {Object[]} Array of { id, name, active }
 */
function getBillingCategories() {
  const sheet   = _getSheet(SHEET_BILLING_CATEGORIES);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:     _numOrNull(_val(row, headers, 'ID')),
    name:   _val(row, headers, 'Name'),
    active: _val(row, headers, 'Active') !== false,
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
 * Returns all trips for a date, joined with their Waybills sheet status.
 *
 * Note: outlet/driver/truck/helper display fields (outletName, driverNick,
 * truckPlate, truckType, helperDetails) are intentionally NOT included here —
 * the client already holds outlets/employees/trucks from getBootData() and
 * derives them locally via indexById(). This avoids 3 redundant sheet reads
 * on every dispatch board load.
 *
 * @param {string} dateStr  'M/d/yyyy'
 * @returns {{ trips: Object[], date: string }}
 */
function getDispatchBoardData(dateStr) {
  const trips = getTrips(dateStr, dateStr);

  // Single read of Waybills, mapped by Trip ID.
  const wbSheet = _getSheet(SHEET_WAYBILLS);
  const wbRows  = wbSheet.getDataRange().getValues();
  const wbByTrip = {};

  if (wbRows.length > 1) {
    const wbHeaders = wbRows[0].map(h => h.toString().trim());
    wbRows.slice(1).forEach(row => {
      const tripId = _numOrNull(_val(row, wbHeaders, 'Trip ID'));
      if (tripId === null) return;

      const locked = _val(row, wbHeaders, 'Locked');
      const isLocked = locked === true || locked === 'TRUE';
      const entry = wbByTrip[tripId] || {};

      if (isLocked) {
        entry.waybillConfirmed = _val(row, wbHeaders, 'Waybill Number') || '';
      } else {
        entry.waybillSuggested   = _val(row, wbHeaders, 'Waybill Number') || '';
        entry.suggestedWaybillId = _numOrNull(_val(row, wbHeaders, 'ID'));
      }
      wbByTrip[tripId] = entry;
    });
  }

  const enriched = trips.map(trip => {
    const wb = wbByTrip[trip.id] || {};
    return Object.assign({}, trip, {
      waybillSuggested:   wb.waybillSuggested   || '',
      waybillConfirmed:   wb.waybillConfirmed   || '',
      suggestedWaybillId: wb.suggestedWaybillId || null,
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
 * Used by saveTripChanges() to surface the "assigned too often to same outlet" warning.
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
