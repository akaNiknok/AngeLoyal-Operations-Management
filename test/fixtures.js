// ============================================================
//  AngeLoyal OMS — Test fixtures
//  Header rows mirror Docs/Schema.md and the column order the
//  writers append in. Keep these in sync if the schema changes.
// ============================================================

const HEADERS = {
  Users: ['ID', 'Email', 'Display Name', 'Role', 'Active'],

  Trips: [
    'ID', 'Trip Date', 'Billing Date', 'FO Number', 'FO Split Suffix',
    'Outlet ID', 'Area', 'Quantity', 'CBM', 'Restrictions',
    'Truck ID', 'Driver ID', 'Helper IDs', 'Truck Billing Category',
    'Trip Status', 'Parent Trip ID', 'Source', 'Tier', 'Remarks',
    'Status Changed By', 'Status Changed At', 'Added By', 'Added At',
  ],

  Waybills: [
    'ID', 'Waybill Number', 'Prefix ID', 'Sequence Number', 'Trip ID',
    'FO Number', 'Waybill Type', 'Parent Waybill ID', 'Status', 'Locked',
    'Confirmed By', 'Confirmed At',
  ],

  'Waybill Prefixes': ['ID', 'Prefix', 'Company Name', 'Last Sequence Number'],

  'Audit Log': [
    'ID', 'Timestamp', 'User', 'Action', 'Detail',
    'Table', 'Row ID', 'Old Value', 'New Value',
  ],

  'Route Frequency Log': ['ID', 'Trip ID', 'Trip Date', 'Driver ID', 'Outlet ID'],
};

/** A Trips sheet with just the header row. */
function emptyTrips() {
  return [HEADERS.Trips.slice()];
}

/** A Users sheet seeded with one active user per role plus an inactive admin. */
function usersSheet() {
  return [
    HEADERS.Users.slice(),
    [1, 'admin@angeloyal.com', 'Ada Admin', 'Admin', true],
    [2, 'dispatch@angeloyal.com', 'Dan Dispatcher', 'Dispatcher', true],
    [3, 'payroll@angeloyal.com', 'Pat Payroll', 'Payroll', true],
    [4, 'viewer@angeloyal.com', 'Vi Viewer', 'Viewer', true],
    [5, 'former@angeloyal.com', 'Former Admin', 'Admin', false],
  ];
}

module.exports = { HEADERS, emptyTrips, usersSheet };
