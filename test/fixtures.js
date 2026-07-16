// ============================================================
//  AngeLoyal OMS — Test fixtures
//  Header rows mirror Docs/Schema.md and the column order the
//  writers append in. Keep these in sync if the schema changes.
// ============================================================

const HEADERS = {
  Users: ['ID', 'Email', 'Display Name', 'Role', 'Active'],

  Employees: ['ID', 'Nickname', 'First Name', 'Middle Name', 'Last Name', 'Role', 'Active'],

  // createTruck appends [id, plate, brand, type, active, billingCategory]
  Trucks: ['ID', 'Plate Number', 'Brand', 'Type', 'Active', 'Billing Category'],

  'Billing Categories': ['ID', 'Name', 'Active'],

  Outlets: ['ID', 'Outlet Name', 'Area', 'Address', 'Customer Group', 'Notes', 'Created At'],

  'Default Assignments': ['ID', 'Truck ID', 'Default Driver ID', 'Default Helper IDs', 'Notes'],

  Trips: [
    'ID', 'Trip Date', 'Billing Date', 'FO Number', 'FO Split Suffix',
    'Outlet ID', 'Area', 'Quantity', 'CBM', 'Restrictions',
    'Truck ID', 'Driver ID', 'Helper IDs', 'Truck Billing Category',
    'Trip Status', 'Parent Trip ID', 'Source', 'Tier', 'Remarks',
    'Status Changed By', 'Status Changed At', 'Added By', 'Added At',
    'Convoy Group', 'Sort Order',
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

/** A sheet seeded with just its header row. */
function emptySheet(name) {
  return [HEADERS[name].slice()];
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

const EMAIL = {
  Admin: 'admin@angeloyal.com',
  Dispatcher: 'dispatch@angeloyal.com',
  Payroll: 'payroll@angeloyal.com',
  Viewer: 'viewer@angeloyal.com',
  Inactive: 'former@angeloyal.com',
  Unknown: 'nobody@angeloyal.com',
};

module.exports = { HEADERS, emptySheet, usersSheet, EMAIL };
