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
 *             waybillPrefixes: Object[], outlets: Object[],
 *             defaultAssignments: Object[], billingCategories: Object[] }}
 */
function getBootData() {
  const session = getUserSession();

  // A verified Google account that isn't an authorized OMS user (role null)
  // gets only its session — never master data. The client shows the gate.
  if (!session.role) {
    return { session: session };
  }

  return {
    session:            session,
    employees:          getEmployees(),
    trucks:             getTrucks(),
    waybillPrefixes:    getWaybillPrefixes(),
    outlets:            getOutlets(),
    defaultAssignments: getDefaultAssignments(),
    billingCategories:  getBillingCategories(),
    routeTypeMap:       getRouteTypeMap(),
    customerGroupColors: getCustomerGroupColors(),
    billingChargeTypes: getBillingChargeTypes(),
    // Just the warehouse names, not the 1,500-row rate matrix — the Import
    // panel offers them as origin suggestions. The matrix itself is fetched by
    // the Billing Matrix panel, one origin at a time.
    origins:            getFreightRateOrigins(),
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
 * Returns every row of the Users sheet, active or not. Admin-only, and kept
 * out of getBootData on purpose: nobody else needs the account list, and it
 * would otherwise sit in every admin's localStorage boot cache.
 * @returns {Object[]} Array of { id, email, displayName, role, active }
 */
function getUsers() {
  _requirePermission('EDIT_USERS');
  const sheet   = _getSheet(SHEET_USERS);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:          _numOrNull(_val(row, headers, 'ID')),
    email:       _val(row, headers, 'Email'),
    displayName: _val(row, headers, 'Display Name'),
    role:        _val(row, headers, 'Role'),
    active:      _val(row, headers, 'Active') !== false,
  })).filter(u => u.id !== null);
}

/** Default Route Type Map rows seeded the first time the sheet is created. */
const ROUTE_TYPE_MAP_DEFAULTS = [
  ['10W', '10W'],
  ['6WF', '6W'],
  ['6WC', '6W'],
  ['4WC', '6W'],
  ['L300', 'L300'],
];

/**
 * Returns the Route Type Map: how the truck-type column codes in a Rebisco
 * route file (e.g. 6WF, 6WC, 4WC) map to a truck Billing Category used for
 * assignment. Self-bootstraps with sensible defaults if the sheet is missing.
 *
 * @returns {Object[]} Array of { id, fileTypeCode, billingCategory, active }
 */
function getRouteTypeMap() {
  const seed   = ROUTE_TYPE_MAP_DEFAULTS.map((r, i) => [i + 1, r[0], r[1], true]);
  const sheet  = _getOrCreateSheet(SHEET_ROUTE_TYPE_MAP,
    ['ID', 'File Type Code', 'Billing Category', 'Active'], seed);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:              _numOrNull(_val(row, headers, 'ID')),
    fileTypeCode:    String(_val(row, headers, 'File Type Code')).trim(),
    billingCategory: String(_val(row, headers, 'Billing Category')).trim(),
    active:          _val(row, headers, 'Active') !== false,
  })).filter(r => r.id !== null);
}

/**
 * Default customer-group → color rows, seeded the first time the sheet is
 * created. Mirrors the fixed chain-code palette the client used to hard-code
 * (see colorChip in web/core.js), so the board stays matched to the paper
 * route file until someone edits a color in Settings.
 */
const CG_COLOR_DEFAULTS = [
  ['PG',   '#92d050'],
  ['SM',   '#00b0f0'],
  ['WM',   '#ffe94d'],
  ['RO',   '#e5b8b7'],
  ['SW',   '#e5b8b7'],
  ['PS',   '#ffc000'],
  ['ALFA', '#ffc000'],
];

/**
 * Returns saved customer-group colors. Groups themselves are just the free-text
 * Customer Group field on outlets — this sheet only stores a chosen color per
 * code; groups without a row fall back to the client's hashed color.
 * Self-bootstraps with the fixed palette defaults if the sheet is missing.
 *
 * @returns {Object[]} Array of { id, customerGroup, color, active }
 */
function getCustomerGroupColors() {
  const seed   = CG_COLOR_DEFAULTS.map((r, i) => [i + 1, r[0], r[1], true]);
  const sheet  = _getOrCreateSheet(SHEET_CG_COLORS,
    ['ID', 'Customer Group', 'Color', 'Active'], seed);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => ({
    id:            _numOrNull(_val(row, headers, 'ID')),
    customerGroup: String(_val(row, headers, 'Customer Group')).trim(),
    color:         String(_val(row, headers, 'Color')).trim(),
    active:        _val(row, headers, 'Active') !== false,
  })).filter(r => r.id !== null);
}

/**
 * Builds an uppercase lookup of active File Type Code → Billing Category from
 * the Route Type Map, for resolving a route file's truck-type column to a
 * billing category during import.
 *
 * @returns {Object<string,string>}
 */
function getRouteTypeCategoryLookup() {
  const lookup = {};
  getRouteTypeMap().forEach(m => {
    if (m.active && m.fileTypeCode) {
      lookup[m.fileTypeCode.toUpperCase()] = m.billingCategory;
    }
  });
  return lookup;
}

/**
 * Returns all waybill prefix entries.
 * @returns {Object[]} Array of { id, prefix, companyName, lastSequenceNumber, sequenceWidth, active }
 *   sequenceWidth is the booklet's fixed digit width, inferred from the length
 *   of the stored Last Sequence Number (e.g. "0357" → 4). 0 = no padding.
 */
function getWaybillPrefixes() {
  const sheet   = _getSheet(SHEET_WB_PREFIXES);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => {
    const rawLast  = _val(row, headers, 'Last Sequence Number');
    const rawWidth = Number(_val(row, headers, 'Sequence Width')) || 0;
    return {
      id:                 _numOrNull(_val(row, headers, 'ID')),
      prefix:             _val(row, headers, 'Prefix'),
      companyName:        _val(row, headers, 'Company Name'),
      lastSequenceNumber: Number(rawLast) || 0,
      // The booklet's pad width has its own column. Rows written before that
      // column existed fall back to the old rule — the stored value's own
      // length ("0358" → 4) — so a sheet carrying hand-seeded zero-padded
      // counters keeps printing at the right width until the next issue
      // rewrites both fields as plain numbers.
      sequenceWidth:      rawWidth > 0
        ? rawWidth
        : String(rawLast == null ? '' : rawLast).trim().length,
      active:             _val(row, headers, 'Active') !== false,
    };
  }).filter(r => r.id !== null);
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
      cbm:                 _round3(_numOrNull(_val(row, headers, 'CBM'))),
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
      convoyGroup:         String(_val(row, headers, 'Convoy Group') || ''),
      sortOrder:           _numOrNull(_val(row, headers, 'Sort Order')),
      origin:              _val(row, headers, 'Origin') || '',
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

      const isLocked = _isTrue(_val(row, wbHeaders, 'Locked'));
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
    locked:          _isTrue(_val(row, headers, 'Locked')),
    confirmedBy:     _val(row, headers, 'Confirmed By'),
    confirmedAt:     _valDateTime(row, headers, 'Confirmed At'),
  })).filter(w => w.id !== null && Number(w.tripId) === Number(tripId));
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


// ============================================================
//  DATA READERS — Billing
// ============================================================

/** Header row of the Freight Rates sheet: keys, then the 25 band columns. */
function _freightRateHeaders() {
  const bands = [];
  for (let i = 1; i <= FUEL_BAND_COUNT; i++) bands.push(_fuelBandLabel(i));
  return ['ID', 'Origin', 'Area', 'Truck Type', 'Effective Date'].concat(bands);
}

/**
 * Returns the freight rate matrix. Each row carries its 25 price bands under
 * `bands`, keyed by the band label ('65.01-70'), so a caller indexes once and
 * then reads a rate without touching the sheet again.
 *
 * Pass `origin` to read one warehouse only — the Billing Matrix panel edits one
 * sheet at a time and does not need the other two.
 *
 * ponytail: the whole matrix is about 1,500 rows and is read in full for each
 * billing request. Move it into CacheService if that read ever gets slow.
 *
 * @param {string} [origin]  Case-insensitive warehouse filter.
 * @returns {Object[]} Array of { id, origin, area, truckType, effectiveDate, bands }
 */
function getFreightRates(origin) {
  const sheet   = _getOrCreateSheet(SHEET_FREIGHT_RATES, _freightRateHeaders());
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());
  const want    = origin ? _normArea(origin) : '';

  const bandLabels = [];
  for (let i = 1; i <= FUEL_BAND_COUNT; i++) bandLabels.push(_fuelBandLabel(i));

  return rows.slice(1).map(row => {
    const id = _numOrNull(_val(row, headers, 'ID'));
    if (id === null) return null;
    const rowOrigin = String(_val(row, headers, 'Origin')).trim();
    if (want && _normArea(rowOrigin) !== want) return null;

    const bands = {};
    bandLabels.forEach(label => {
      bands[label] = _numOrNull(_val(row, headers, label));
    });

    return {
      id:            id,
      origin:        rowOrigin,
      area:          String(_val(row, headers, 'Area')).trim(),
      truckType:     String(_val(row, headers, 'Truck Type')).trim(),
      effectiveDate: _formatDate(_readDateCell(_val(row, headers, 'Effective Date'))),
      bands:         bands,
    };
  }).filter(r => r !== null);
}

/**
 * Returns the distinct warehouse names the rate matrix carries, sorted. The
 * Import panel offers these as suggestions when the dispatcher picks the origin
 * of a route file.
 *
 * @returns {string[]}
 */
function getFreightRateOrigins() {
  const sheet   = _getOrCreateSheet(SHEET_FREIGHT_RATES, _freightRateHeaders());
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());
  const colIdx  = headers.indexOf('Origin');
  if (colIdx === -1) return [];

  const seen = {};
  rows.slice(1).forEach(row => {
    const v = String(row[colIdx] || '').trim();
    if (v) seen[_normArea(v)] = v;
  });
  return Object.keys(seen).map(k => seen[k]).sort();
}

/**
 * Returns the DOE diesel price history, newest effective date first.
 * @returns {Object[]} Array of { id, effectiveDate, dieselPrice, addedBy, addedAt }
 */
function getFuelPrices() {
  const sheet   = _getOrCreateSheet(SHEET_FUEL_PRICES,
    ['ID', 'Effective Date', 'Diesel Price', 'Added By', 'Added At']);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => {
    const id = _numOrNull(_val(row, headers, 'ID'));
    if (id === null) return null;
    return {
      id:            id,
      effectiveDate: _formatDate(_readDateCell(_val(row, headers, 'Effective Date'))),
      dieselPrice:   _numOrNull(_val(row, headers, 'Diesel Price')),
      addedBy:       String(_val(row, headers, 'Added By') || ''),
      addedAt:       _valDateTime(row, headers, 'Added At'),
    };
  }).filter(r => r !== null)
    .sort((a, b) => _parseDate(b.effectiveDate) - _parseDate(a.effectiveDate));
}

/** Default manual money columns, seeded the first time the sheet is created. */
const BILLING_CHARGE_TYPE_DEFAULTS = [
  'Parking Fee/Toll Fees',
  'Packing Tape',
  'Bad Orders @5.00 / Bx',
];

/**
 * Returns the manual money columns of the billing output, in display order.
 * Self-bootstraps with the three columns the paper billing already carries.
 *
 * @returns {Object[]} Array of { id, label, sortOrder, active }
 */
function getBillingChargeTypes() {
  const seed   = BILLING_CHARGE_TYPE_DEFAULTS.map((label, i) => [i + 1, label, (i + 1) * 10, true]);
  const sheet  = _getOrCreateSheet(SHEET_BILLING_CHARGE_TYPES,
    ['ID', 'Label', 'Sort Order', 'Active'], seed);
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => h.toString().trim());

  return rows.slice(1).map(row => {
    const id = _numOrNull(_val(row, headers, 'ID'));
    if (id === null) return null;
    return {
      id:        id,
      label:     String(_val(row, headers, 'Label')).trim(),
      sortOrder: _numOrNull(_val(row, headers, 'Sort Order')),
      active:    _val(row, headers, 'Active') !== false,
    };
  }).filter(r => r !== null)
    .sort((a, b) => (a.sortOrder === null ? Infinity : a.sortOrder) -
                    (b.sortOrder === null ? Infinity : b.sortOrder));
}

/** Header row of the Billing Lines sheet. Mirrors Docs/Schema.md Sheet 17. */
const BILLING_LINE_HEADERS = [
  'ID', 'Waybill Number', 'Waybill ID', 'Trip Date', 'Billing Date', 'Origin',
  'Plate Number', 'FO Number', 'Truck Type', 'Area', 'Drops', 'Cartons',
  'Diesel Price', 'Rate Band', 'Hauling Rate', 'Mano', 'Drop Fee',
  'Manual Charges', 'Total', 'Billing Number', 'Status', 'Overrides', 'Notes',
  'Added By', 'Added At', 'Updated By', 'Updated At',
];

/**
 * Maps one Billing Lines row to the client shape. The two JSON cells are
 * parsed here so no caller has to know they are strings on the sheet.
 *
 * @param {Array} row
 * @param {Array} headers
 * @returns {Object|null} null when the row has no ID
 */
function _billingLineFromRow(row, headers) {
  const id = _numOrNull(_val(row, headers, 'ID'));
  if (id === null) return null;
  return {
    id:             id,
    waybillNumber:  String(_val(row, headers, 'Waybill Number') || ''),
    waybillId:      _numOrNull(_val(row, headers, 'Waybill ID')),
    tripDate:       _formatDate(_readDateCell(_val(row, headers, 'Trip Date'))),
    billingDate:    _formatDate(_readDateCell(_val(row, headers, 'Billing Date'))),
    origin:         String(_val(row, headers, 'Origin') || ''),
    plateNumber:    String(_val(row, headers, 'Plate Number') || ''),
    foNumber:       String(_val(row, headers, 'FO Number') || ''),
    truckType:      String(_val(row, headers, 'Truck Type') || ''),
    area:           String(_val(row, headers, 'Area') || ''),
    drops:          _numOrNull(_val(row, headers, 'Drops')),
    cartons:        _numOrNull(_val(row, headers, 'Cartons')),
    dieselPrice:    _numOrNull(_val(row, headers, 'Diesel Price')),
    rateBand:       String(_val(row, headers, 'Rate Band') || ''),
    haulingRate:    _numOrNull(_val(row, headers, 'Hauling Rate')) || 0,
    mano:           _numOrNull(_val(row, headers, 'Mano')) || 0,
    dropFee:        _numOrNull(_val(row, headers, 'Drop Fee')) || 0,
    manualCharges:  _parseJsonCell(_val(row, headers, 'Manual Charges'), {}),
    total:          _numOrNull(_val(row, headers, 'Total')) || 0,
    billingNumber:  String(_val(row, headers, 'Billing Number') || ''),
    status:         String(_val(row, headers, 'Status') || 'Not Billed'),
    overrides:      _parseJsonCell(_val(row, headers, 'Overrides'), []),
    notes:          String(_val(row, headers, 'Notes') || ''),
    addedBy:        String(_val(row, headers, 'Added By') || ''),
    addedAt:        _valDateTime(row, headers, 'Added At'),
    updatedBy:      String(_val(row, headers, 'Updated By') || ''),
    updatedAt:      _valDateTime(row, headers, 'Updated At'),
  };
}

/**
 * Returns the VAT and withholding footer of a billing, from the sum of the
 * lines' Total. Every Total is VAT inclusive, so the VAT is backed out of the
 * gross and the 2% withholding applies to the net.
 *
 * @param {Object[]} lines
 * @returns {{ lineCount: number, totalVatInc: number, lessVat: number,
 *             netOfVat: number, addVat: number, withholding: number, amountDue: number }}
 */
function _billingTotals(lines) {
  let totalVatInc = 0;
  (lines || []).forEach(l => { totalVatInc += Number(l.total) || 0; });

  const lessVat  = (totalVatInc / (1 + VAT_RATE)) * VAT_RATE;
  const netOfVat = totalVatInc - lessVat;

  return {
    lineCount:   (lines || []).length,
    totalVatInc: totalVatInc,
    lessVat:     lessVat,
    netOfVat:    netOfVat,
    addVat:      netOfVat * VAT_RATE,
    withholding: netOfVat * WITHHOLDING_RATE,
    amountDue:   totalVatInc - netOfVat * WITHHOLDING_RATE,
  };
}
