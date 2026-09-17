// ============================================================
//  Master-record admin writers + truck roster (server/writers/masters.js).
//  Covers validation, dedup, the no-cascade FK rename, the folded-in
//  roster (Default Assignments -> trucks), and the EDIT_MASTER_RECORDS gate.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { HEADERS, usersSheet, emptySheet, EMAIL } = require('./fixtures');

function asAdmin(sheets) {
  return makeEnv({ sheets, userEmail: EMAIL.Admin });
}

function base(extra = {}) {
  return Object.assign({ Users: usersSheet(), 'Audit Log': emptySheet('Audit Log') }, extra);
}

// ---------------- Trucks ----------------

test('createTruck rejects a duplicate plate and creates a blank roster row', async () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', 'Isuzu', '6W', true, '6W']],
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [10, '6W', true], [11, '10W', true]],
  });
  const { api } = asAdmin(sheets);

  const dup = await api.createTruck({ plate: 'aaa-111' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const ok = await api.createTruck({ plate: 'BBB-222', brand: 'Fuso', type: '10W', billingCategory: '10W' });
  assert.equal(ok.success, true);
  assert.equal(ok.truck.id, 2);
  assert.equal(ok.truck.billingCategory, '10W');

  // Default Assignments folded into trucks: the new truck IS a blank roster row.
  const defs = await api.getDefaultAssignments();
  const newDef = defs.find((d) => d.truckId === 2);
  assert.ok(newDef);
  assert.equal(newDef.defaultDriverId, null);
  assert.deepEqual(newDef.defaultHelperIds, []);
});

test('createTruck refuses an unknown billing category name', async () => {
  const { api } = asAdmin(base({ Trucks: emptySheet('Trucks') }));
  const res = await api.createTruck({ plate: 'ZZZ-999', billingCategory: 'Not A Category' });
  assert.equal(res.success, false);
  assert.match(res.error, /Unknown billing category/);
});

test('updateTruck rejects renaming a plate onto another truck', async () => {
  const sheets = base({
    Trucks: [
      HEADERS.Trucks.slice(),
      [1, 'AAA-111', '', '', true, ''],
      [2, 'BBB-222', '', '', true, ''],
    ],
  });
  const { api } = asAdmin(sheets);
  const res = await api.updateTruck(2, { plate: 'AAA-111' });
  assert.equal(res.success, false);
  assert.match(res.error, /already exists/);
});

// The uniqueness check has to skip the row being edited, or every inline edit
// would fail: the panel re-sends the plate unchanged alongside whatever the
// admin actually touched.
test('a record does not collide with itself on save', async () => {
  const sheets = base({
    Trucks: [
      HEADERS.Trucks.slice(),
      [1, 'AAA-111', 'Isuzu', '6W', true, '6W'],
      [2, 'BBB-222', '', '', true, '6W'],
    ],
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [10, '6W', true]],
  });
  const { api } = asAdmin(sheets);

  const truck = await api.updateTruck(1, { plate: 'AAA-111', brand: 'Hino' });
  assert.equal(truck.success, true);
  assert.equal(truck.truck.brand, 'Hino');
  assert.equal(truck.truck.plate, 'AAA-111');

  const cat = await api.updateBillingCategory(10, { name: '6W' });
  assert.equal(cat.success, true);
  assert.equal(cat.billingCategory.name, '6W');
});

// ---------------- Billing Categories (FK now, no rename cascade) ----------------

test('renaming a billing category is reflected on every truck through the FK, no cascade needed', async () => {
  const sheets = base({
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [10, '6W', true]],
    Trucks: [
      HEADERS.Trucks.slice(),
      [1, 'AAA-111', '', '', true, '6W'],
      [2, 'BBB-222', '', '', true, '6W'],
      [3, 'CCC-333', '', '', true, '10W'], // unaffected
    ],
  });
  const { api } = asAdmin(sheets);

  const res = await api.updateBillingCategory(10, { name: '6 Wheeler' });
  assert.equal(res.success, true);

  const trucks = await api.getTrucks();
  assert.equal(trucks.find((t) => t.id === 1).billingCategory, '6 Wheeler');
  assert.equal(trucks.find((t) => t.id === 2).billingCategory, '6 Wheeler');
  assert.equal(trucks.find((t) => t.id === 3).billingCategory, '10W'); // untouched
});

test('createBillingCategory rejects duplicates and requires a name', async () => {
  const sheets = base({
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [1, '6W', true]],
  });
  const { api } = asAdmin(sheets);

  assert.equal((await api.createBillingCategory({ name: '   ' })).success, false);
  assert.match((await api.createBillingCategory({ name: '6w' })).error, /already exists/);
  assert.equal((await api.createBillingCategory({ name: '4W' })).success, true);
});

// ---------------- Outlets / Employees validation ----------------

test('createOutlet requires a name and returns the new record', async () => {
  const { api } = asAdmin(base({ Outlets: emptySheet('Outlets') }));

  assert.match((await api.createOutlet({ outletName: '' })).error, /required/);
  const res = await api.createOutlet({ outletName: 'New Outlet', area: 'Cavite' });
  assert.equal(res.success, true);
  assert.equal(res.outlet.outletName, 'New Outlet');
});

test('createEmployee requires a nickname and a role', async () => {
  const { api } = asAdmin(base({ Employees: emptySheet('Employees') }));

  assert.match((await api.createEmployee({ nick: '', role: 'Driver' })).error, /Nickname/);
  assert.match((await api.createEmployee({ nick: 'Boy', role: '' })).error, /Role/);
  assert.equal((await api.createEmployee({ nick: 'Boy', role: 'Driver' })).success, true);
});

// ---------------- Master writers are Admin-only ----------------

test('master writers reject non-admins', async () => {
  const { api } = makeEnv({ sheets: base({ Trucks: emptySheet('Trucks') }), userEmail: EMAIL.Dispatcher });
  await assert.rejects(api.createTruck({ plate: 'ZZZ-000' }), /Access denied/);
});

// ---------------- Truck roster (Default Assignments folded into trucks) ----------------
// updateDefaultAssignment now takes the TRUCK id. Gated by ASSIGN_CREW
// (Admin + Dispatcher), not the Admin-only EDIT_MASTER_RECORDS the other
// master writers use.

test('updateDefaultAssignment (the roster) is editable by a Dispatcher', async () => {
  const sheets = base({
    Employees: [
      HEADERS.Employees.slice(),
      [10, 'Driver A', '', '', '', 'Driver', true],
      [21, 'Helper A', '', '', '', 'Helper', true],
      [22, 'Helper B', '', '', '', 'Helper', true],
    ],
    Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', '', '', true, '']],
  });
  const { api, db } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  const res = await api.updateDefaultAssignment(1, {
    defaultDriverId: 10,
    defaultHelperIds: [21, 22],
    notes: 'A team',
  });
  assert.equal(res.success, true);

  const truck = dump(db, 'trucks').find((t) => t.id === 1);
  assert.equal(truck.default_driver_id, 10);
  assert.equal(truck.roster_notes, 'A team');
  const helperIds = dump(db, 'truck_default_helpers')
    .filter((h) => h.truck_id === 1)
    .sort((a, b) => a.slot - b.slot)
    .map((h) => h.employee_id);
  assert.deepEqual(helperIds, [21, 22]);
});

test('roster writes are gated by ASSIGN_CREW permission', async () => {
  const sheets = base({ Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', '', '', true, '']] });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  await assert.rejects(api.updateDefaultAssignment(1, { notes: 'x' }), /Access denied/);
});

// ---------------- Route Type Map ----------------

test('route type map ships with the default mappings', async () => {
  const { api } = asAdmin(base());
  const map = await api.getRouteTypeMap();
  const lookup = {};
  map.forEach((m) => (lookup[m.fileTypeCode] = m.billingCategory));
  assert.equal(lookup['4WC'], '6W');
  assert.equal(lookup['6WC'], '6W');
  assert.equal(lookup['10W'], '10W');
  assert.equal(lookup['L300'], 'L300');
});

test('createRouteTypeMapping validates, dedupes, and is admin-gated', async () => {
  const { api } = asAdmin(base());

  const blank = await api.createRouteTypeMapping({ fileTypeCode: '', billingCategory: '6W' });
  assert.equal(blank.success, false);

  const dup = await api.createRouteTypeMapping({ fileTypeCode: '4wc', billingCategory: '6W' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const ok = await api.createRouteTypeMapping({ fileTypeCode: '8W', billingCategory: '10W' });
  assert.equal(ok.success, true);
  assert.equal(ok.mapping.fileTypeCode, '8W');

  const viewer = makeEnv({ sheets: base(), userEmail: EMAIL.Viewer });
  await assert.rejects(
    viewer.api.createRouteTypeMapping({ fileTypeCode: 'X', billingCategory: 'Y' }), /Access denied/);
});

test('createRouteTypeMapping refuses an unknown billing category', async () => {
  const { api } = asAdmin(base());
  const res = await api.createRouteTypeMapping({ fileTypeCode: '8W', billingCategory: 'Not A Category' });
  assert.equal(res.success, false);
  assert.match(res.error, /Unknown billing category/);
});

test('updateRouteTypeMapping edits the category and feeds the import lookup', async () => {
  const { api } = asAdmin(base());
  const map = await api.getRouteTypeMap();
  const fourWc = map.find((m) => m.fileTypeCode === '4WC');

  const res = await api.updateRouteTypeMapping(fourWc.id, { billingCategory: 'L300' });
  assert.equal(res.success, true);

  const lookup = await api.getRouteTypeCategoryLookup();
  assert.equal(lookup['4WC'], 'L300'); // change is reflected in the lookup
});

// ---------------- Customer Group Colors ----------------

test('customer group colors ship with the fixed palette', async () => {
  const { api } = asAdmin(base());
  const rows = await api.getCustomerGroupColors();
  const pg = rows.find((r) => r.customerGroup === 'PG');
  assert.equal(pg.color, '#92d050');
  assert.equal(pg.active, true);
});

test('saveCustomerGroupColor upserts case-insensitively, validates hex, and clears on blank', async () => {
  const { api } = asAdmin(base());

  // bad hex is rejected
  assert.match((await api.saveCustomerGroupColor('PG', 'green')).error, /hex/);
  // blank group is rejected
  assert.equal((await api.saveCustomerGroupColor('', '#111111')).success, false);

  // edits the existing PG row (matched case-insensitively), doesn't add one
  const before = (await api.getCustomerGroupColors()).length;
  const edit = await api.saveCustomerGroupColor('pg', '#123456');
  assert.equal(edit.success, true);
  const after = await api.getCustomerGroupColors();
  assert.equal(after.length, before);
  assert.equal(after.find((r) => r.customerGroup === 'PG').color, '#123456');

  // a new group is appended
  const add = await api.saveCustomerGroupColor('XYZ', '#abcdef');
  assert.equal(add.success, true);
  assert.equal((await api.getCustomerGroupColors()).find((r) => r.customerGroup === 'XYZ').color, '#abcdef');

  // blank color clears -> row goes inactive
  const clear = await api.saveCustomerGroupColor('XYZ', '');
  assert.equal(clear.success, true);
  const xyz = (await api.getCustomerGroupColors()).find((r) => r.customerGroup === 'XYZ');
  assert.equal(xyz.active, false);
});

test('saveCustomerGroupColor is admin-gated', async () => {
  const viewer = makeEnv({ sheets: base(), userEmail: EMAIL.Viewer });
  await assert.rejects(viewer.api.saveCustomerGroupColor('PG', '#111111'), /Access denied/);
});

// ---------------- Users ----------------

test('createUser validates the email and the role, and refuses a duplicate', async () => {
  const { api, db } = asAdmin(base());

  assert.match((await api.createUser({ email: 'not-an-email', displayName: 'X', role: 'Viewer' })).error, /valid email/);
  assert.match((await api.createUser({ email: 'x@y.com', displayName: '', role: 'Viewer' })).error, /Display name/);
  assert.match((await api.createUser({ email: 'x@y.com', displayName: 'X', role: 'Owner' })).error, /Role must be one of/);

  const ok = await api.createUser({ email: ' New@Angeloyal.com ', displayName: 'New Guy', role: 'Dispatcher' });
  assert.equal(ok.success, true);
  assert.equal(ok.user.email, 'New@Angeloyal.com');
  assert.equal(ok.user.active, true);

  const dup = await api.createUser({ email: 'new@angeloyal.com', displayName: 'Twin', role: 'Viewer' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);

  const rows = dump(db, 'users');
  assert.equal(rows[rows.length - 1].role, 'Dispatcher');
});

test('an admin cannot demote or deactivate their own account', async () => {
  const { api } = asAdmin(base());
  // fixture row 1 is the signed-in admin
  assert.match((await api.updateUser(1, { role: 'Viewer' })).error, /your own role/);
  assert.match((await api.updateUser(1, { active: false })).error, /your own role/);
  // renaming yourself is fine
  assert.equal((await api.updateUser(1, { displayName: 'Ada A.' })).success, true);
  // and so is touching somebody else
  assert.equal((await api.updateUser(4, { role: 'Payroll', active: false })).success, true);
});

test('getUsers and the user writers are admin-gated', async () => {
  const dispatcher = makeEnv({ sheets: base(), userEmail: EMAIL.Dispatcher });
  await assert.rejects(dispatcher.api.getUsers(), /Access denied/);
  await assert.rejects(dispatcher.api.createUser({ email: 'a@b.com', displayName: 'A', role: 'Viewer' }), /Access denied/);
  await assert.rejects(dispatcher.api.updateUser(4, { active: false }), /Access denied/);

  const { api } = asAdmin(base());
  assert.equal((await api.getUsers()).length, 5);
});

// ---------------- Billing Charge Types ----------------

test('createBillingChargeType assigns a sort order and dedupes the label', async () => {
  const { api } = makeEnv({ sheets: base(), userEmail: EMAIL.Payroll });
  const ok = await api.createBillingChargeType({ label: 'Toll Fee' });
  assert.equal(ok.success, true);
  assert.equal(ok.billingChargeType.sortOrder, ok.billingChargeType.id * 10);

  const dup = await api.createBillingChargeType({ label: 'toll fee' });
  assert.equal(dup.success, false);
  assert.match(dup.error, /already exists/);
});

test('updateBillingChargeType renames without disturbing sort order', async () => {
  const { api } = makeEnv({ sheets: base(), userEmail: EMAIL.Payroll });
  const created = await api.createBillingChargeType({ label: 'Toll Fee', sortOrder: 5 });
  const res = await api.updateBillingChargeType(created.billingChargeType.id, { label: 'Toll Fees' });
  assert.equal(res.success, true);
  assert.equal(res.billingChargeType.label, 'Toll Fees');
  assert.equal(res.billingChargeType.sortOrder, 5);
});
