// ============================================================
//  Master-record admin writers + truck roster (DataWriters.gs).
//  Covers validation, dedup, the billing-category rename cascade,
//  the append-only roster, and the EDIT_MASTER_RECORDS gate.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function asAdmin(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Admin });
}

function base(extra = {}) {
  return Object.assign({ Users: usersSheet(), 'Audit Log': emptySheet('Audit Log') }, extra);
}

// ---------------- Trucks ----------------

test('createTruck rejects a duplicate plate and seeds a Default Assignments row', () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', 'Isuzu', '6W', true, '6W']],
    'Default Assignments': emptySheet('Default Assignments'),
  });
  const { api, ss } = asAdmin(sheets);

  const dup = api.createTruck({ plate: 'aaa-111' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const ok = api.createTruck({ plate: 'BBB-222', brand: 'Fuso', type: '10W', billingCategory: '10W' });
  assert.equal(ok.success, true);
  assert.equal(ok.truck.id, 2);

  // a blank default-assignment row was seeded for the new truck
  const defs = dump(ss, 'Default Assignments').rows.map((r) => rowObject(HEADERS['Default Assignments'], r));
  assert.equal(defs.length, 1);
  assert.equal(Number(defs[0]['Truck ID']), 2);
});

test('updateTruck rejects renaming a plate onto another truck', () => {
  const sheets = base({
    Trucks: [
      HEADERS.Trucks.slice(),
      [1, 'AAA-111', '', '', true, '6W'],
      [2, 'BBB-222', '', '', true, '6W'],
    ],
    'Default Assignments': emptySheet('Default Assignments'),
  });
  const { api } = asAdmin(sheets);
  const res = api.updateTruck(2, { plate: 'AAA-111' });
  assert.equal(res.success, false);
  assert.match(res.error, /already exists/);
});

// ---------------- Billing Categories (rename cascade) ----------------

test('renaming a billing category cascades to every truck using the old name', () => {
  const sheets = base({
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [10, '6W', true]],
    Trucks: [
      HEADERS.Trucks.slice(),
      [1, 'AAA-111', '', '', true, '6W'],
      [2, 'BBB-222', '', '', true, '6W'],
      [3, 'CCC-333', '', '', true, '10W'], // unaffected
    ],
  });
  const { api, ss } = asAdmin(sheets);

  const res = api.updateBillingCategory(10, { name: '6 Wheeler' });
  assert.equal(res.success, true);

  const trucks = dump(ss, 'Trucks').rows.map((r) => rowObject(HEADERS.Trucks, r));
  assert.equal(trucks.find((t) => t.ID === 1)['Billing Category'], '6 Wheeler');
  assert.equal(trucks.find((t) => t.ID === 2)['Billing Category'], '6 Wheeler');
  assert.equal(trucks.find((t) => t.ID === 3)['Billing Category'], '10W'); // untouched
});

test('createBillingCategory rejects duplicates and requires a name', () => {
  const sheets = base({
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [1, '6W', true]],
    Trucks: emptySheet('Trucks'),
  });
  const { api } = asAdmin(sheets);

  assert.equal(api.createBillingCategory({ name: '   ' }).success, false);
  assert.match(api.createBillingCategory({ name: '6w' }).error, /already exists/);
  assert.equal(api.createBillingCategory({ name: '4W' }).success, true);
});

// ---------------- Outlets / Employees validation ----------------

test('createOutlet requires a name and returns the new record', () => {
  const sheets = base({ Outlets: emptySheet('Outlets') });
  const { api } = asAdmin(sheets);

  assert.match(api.createOutlet({ outletName: '' }).error, /required/);
  const res = api.createOutlet({ outletName: 'New Outlet', area: 'Cavite' });
  assert.equal(res.success, true);
  assert.equal(res.outlet.outletName, 'New Outlet');
});

test('createEmployee requires a nickname and a role', () => {
  const sheets = base({ Employees: emptySheet('Employees') });
  const { api } = asAdmin(sheets);

  assert.match(api.createEmployee({ nick: '', role: 'Driver' }).error, /Nickname/);
  assert.match(api.createEmployee({ nick: 'Boy', role: '' }).error, /Role/);
  assert.equal(api.createEmployee({ nick: 'Boy', role: 'Driver' }).success, true);
});

// ---------------- Master writers are Admin-only ----------------

test('master writers reject non-admins', () => {
  const sheets = base({
    Trucks: emptySheet('Trucks'),
    'Default Assignments': emptySheet('Default Assignments'),
  });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  assert.throws(() => api.createTruck({ plate: 'ZZZ-000' }), /Access denied/);
});

// ---------------- Truck roster (Default Assignments) ----------------
// The roster is now the Default Assignments sheet, edited via
// updateDefaultAssignment. It is gated by ASSIGN_CREW (Admin + Dispatcher),
// not the Admin-only EDIT_MASTER_RECORDS the other master writers use.

test('updateDefaultAssignment (the roster) is editable by a Dispatcher', () => {
  const sheets = base({
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [1, 5, '', '', '']],
  });
  const { api, ss } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  const res = api.updateDefaultAssignment(1, {
    defaultDriverId: 100,
    defaultHelperIds: [21, 22],
    notes: 'A team',
  });
  assert.equal(res.success, true);

  const row = rowObject(HEADERS['Default Assignments'], dump(ss, 'Default Assignments').rows[0]);
  assert.equal(row['Default Driver ID'], 100);
  assert.equal(row['Default Helper IDs'], '21,22');
  assert.equal(row['Notes'], 'A team');
});

test('roster writes are gated by ASSIGN_CREW permission', () => {
  const sheets = base({
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [1, 5, '', '', '']],
  });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  assert.throws(() => api.updateDefaultAssignment(1, { notes: 'x' }), /Access denied/);
});

// ---------------- Route Type Map ----------------

test('getRouteTypeMap self-seeds the sheet with defaults when missing', () => {
  const { api } = asAdmin(base());
  const map = api.getRouteTypeMap();
  const lookup = {};
  map.forEach((m) => (lookup[m.fileTypeCode] = m.billingCategory));
  assert.equal(lookup['4WC'], '6W');
  assert.equal(lookup['6WC'], '6W');
  assert.equal(lookup['10W'], '10W');
  assert.equal(lookup['L300'], 'L300');
});

test('createRouteTypeMapping validates, dedupes, and is admin-gated', () => {
  const { api } = asAdmin(base());
  api.getRouteTypeMap(); // seed defaults

  const blank = api.createRouteTypeMapping({ fileTypeCode: '', billingCategory: '6W' });
  assert.equal(blank.success, false);

  const dup = api.createRouteTypeMapping({ fileTypeCode: '4wc', billingCategory: '6W' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const ok = api.createRouteTypeMapping({ fileTypeCode: '8W', billingCategory: '10W' });
  assert.equal(ok.success, true);
  assert.equal(ok.mapping.fileTypeCode, '8W');

  const viewer = makeEnv({ sheets: base(), userEmail: EMAIL.Viewer });
  assert.throws(() => viewer.api.createRouteTypeMapping({ fileTypeCode: 'X', billingCategory: 'Y' }), /Access denied/);
});

test('updateRouteTypeMapping edits the category and feeds the import lookup', () => {
  const { api } = asAdmin(base());
  const map = api.getRouteTypeMap();
  const fourWc = map.find((m) => m.fileTypeCode === '4WC');

  const res = api.updateRouteTypeMapping(fourWc.id, { billingCategory: 'L300' });
  assert.equal(res.success, true);

  const lookup = api.getRouteTypeCategoryLookup();
  assert.equal(lookup['4WC'], 'L300'); // change is reflected in the lookup
});

// ---------------- Customer Group Colors ----------------

test('getCustomerGroupColors self-seeds the fixed palette', () => {
  const { api } = asAdmin(base());
  const rows = api.getCustomerGroupColors();
  const pg = rows.find((r) => r.customerGroup === 'PG');
  assert.equal(pg.color, '#92d050');
  assert.equal(pg.active, true);
});

test('saveCustomerGroupColor upserts case-insensitively, validates hex, and clears on blank', () => {
  const { api } = asAdmin(base());
  api.getCustomerGroupColors(); // seed

  // bad hex is rejected
  assert.match(api.saveCustomerGroupColor('PG', 'green').error, /hex/);
  // blank group is rejected
  assert.equal(api.saveCustomerGroupColor('', '#111111').success, false);

  // edits the existing PG row (matched case-insensitively), doesn't add one
  const before = api.getCustomerGroupColors().length;
  const edit = api.saveCustomerGroupColor('pg', '#123456');
  assert.equal(edit.success, true);
  const after = api.getCustomerGroupColors();
  assert.equal(after.length, before);
  assert.equal(after.find((r) => r.customerGroup === 'PG').color, '#123456');

  // a new group is appended
  const add = api.saveCustomerGroupColor('XYZ', '#abcdef');
  assert.equal(add.success, true);
  assert.equal(api.getCustomerGroupColors().find((r) => r.customerGroup === 'XYZ').color, '#abcdef');

  // blank color clears → row goes inactive
  const clear = api.saveCustomerGroupColor('XYZ', '');
  assert.equal(clear.success, true);
  const xyz = api.getCustomerGroupColors().find((r) => r.customerGroup === 'XYZ');
  assert.equal(xyz.active, false);
});

test('saveCustomerGroupColor is admin-gated', () => {
  const viewer = makeEnv({ sheets: base(), userEmail: EMAIL.Viewer });
  assert.throws(() => viewer.api.saveCustomerGroupColor('PG', '#111111'), /Access denied/);
});
