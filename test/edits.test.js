// ============================================================
//  Remaining Phase 1 edit paths + small readers, left over from the
//  by-module split: updateOutlet / updateEmployee /
//  updateDefaultAssignment / updateTruck (server/writers/masters.js),
//  _resolveBillingCategory (server/writers/trips.js), and the
//  master-list readers (server/readers.js).
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

// ---------------- updateOutlet ----------------

test('updateOutlet applies partial changes and keeps other fields', async () => {
  const sheets = base({
    Outlets: [HEADERS.Outlets.slice(), [5, 'Old Name', 'Cavite', 'Addr', 'Group', 'Note', '6/1/2026']],
  });
  const { api, db } = asAdmin(sheets);

  const res = await api.updateOutlet(5, { outletName: 'New Name', area: 'Laguna' });
  assert.equal(res.success, true);

  const outlet = dump(db, 'outlets')[0];
  assert.equal(outlet.outlet_name, 'New Name');
  assert.equal(outlet.area, 'Laguna');
  assert.equal(outlet.address, 'Addr'); // untouched
});

test('updateOutlet rejects a blank name and unknown ids', async () => {
  const sheets = base({
    Outlets: [HEADERS.Outlets.slice(), [5, 'Old', 'Cavite', '', '', '', '6/1/2026']],
  });
  const { api } = asAdmin(sheets);
  assert.match((await api.updateOutlet(5, { outletName: '   ' })).error, /required/);
  assert.match((await api.updateOutlet(999, { area: 'X' })).error, /not found/);
});

test('updateOutlet is gated by EDIT_MASTER_RECORDS', async () => {
  const sheets = base({ Outlets: [HEADERS.Outlets.slice(), [5, 'Old', '', '', '', '', '']] });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  await assert.rejects(() => api.updateOutlet(5, { area: 'X' }), /Access denied/);
});

// ---------------- updateEmployee ----------------

test('updateEmployee validates required fields and toggles active', async () => {
  const sheets = base({
    Employees: [HEADERS.Employees.slice(), [1, 'Boy', 'Juan', '', 'Cruz', 'Driver', true]],
  });
  const { api, db } = asAdmin(sheets);

  assert.match((await api.updateEmployee(1, { nick: '' })).error, /Nickname/);
  assert.match((await api.updateEmployee(1, { role: '' })).error, /Role/);

  const res = await api.updateEmployee(1, { nick: 'Boyet', active: false });
  assert.equal(res.success, true);
  const emp = dump(db, 'employees')[0];
  assert.equal(emp.nickname, 'Boyet');
  assert.equal(emp.active, 0);
});

// ---------------- updateDefaultAssignment ----------------
// Folded into trucks in D1: the id passed is the TRUCK id (server/readers.js
// getDefaultAssignments), and helpers live in truck_default_helpers rows.

test('updateDefaultAssignment updates driver, helper set, and notes', async () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [3, 'ABC-123', 'Isuzu', '6W', true, '6W']],
    Employees: [
      HEADERS.Employees.slice(),
      [9, 'Driver Nine', '', '', '', 'Driver', true],
      [10, 'Driver Ten', '', '', '', 'Driver', true],
      [21, 'Helper 21', '', '', '', 'Helper', true],
      [22, 'Helper 22', '', '', '', 'Helper', true],
    ],
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [3, 3, 9, '21', 'old']],
  });
  const { api, db } = asAdmin(sheets);

  const res = await api.updateDefaultAssignment(3, {
    defaultDriverId: 10,
    defaultHelperIds: [21, 22],
    notes: 'new note',
  });
  assert.equal(res.success, true);

  const truck = dump(db, 'trucks')[0];
  assert.equal(truck.default_driver_id, 10);
  assert.equal(truck.roster_notes, 'new note');
  const helperIds = dump(db, 'truck_default_helpers').filter((h) => h.truck_id === 3)
    .sort((a, b) => a.slot - b.slot).map((h) => h.employee_id);
  assert.deepEqual(helperIds, [21, 22]);
});

test('updateDefaultAssignment errors on unknown id and denies a Viewer', async () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [3, 'ABC-123', 'Isuzu', '6W', true, '6W']],
  });
  const { api } = asAdmin(sheets);
  assert.match((await api.updateDefaultAssignment(99, { notes: 'x' })).error, /not found/);

  // The roster is ASSIGN_CREW-gated (Admin + Dispatcher), so a Viewer is denied.
  const { api: viewApi } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  await assert.rejects(() => viewApi.updateDefaultAssignment(3, { notes: 'x' }), /Access denied/);
});

// ---------------- updateTruck active toggle ----------------

test('updateTruck toggles active and returns the refreshed record', async () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', 'Isuzu', '6W', true, '6W']],
  });
  const { api, db } = asAdmin(sheets);

  const res = await api.updateTruck(1, { active: false, brand: 'Hino' });
  assert.equal(res.success, true);
  assert.equal(res.truck.active, false);
  assert.equal(res.truck.brand, 'Hino');

  const truck = dump(db, 'trucks')[0];
  assert.equal(truck.active, 0);
});

// ---------------- _resolveBillingCategory ----------------

test('_resolveBillingCategory reads a truck category, else empty string', async () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [3, 'ABC-123', 'Isuzu', '10W', true, '10W']],
  });
  const { api } = asAdmin(sheets);
  assert.equal(await api._resolveBillingCategory(3), '10W');
  assert.equal(await api._resolveBillingCategory(999), ''); // unknown truck
  assert.equal(await api._resolveBillingCategory(''), ''); // falsy id short-circuits
});

// ---------------- master-list readers ----------------

test('master readers map rows and surface the active flag', async () => {
  const sheets = base({
    Employees: [
      HEADERS.Employees.slice(),
      [1, 'Boy', 'Juan', '', 'Cruz', 'Driver', true],
      [2, 'Ben', 'Pedro', '', 'Reyes', 'Helper', false],
    ],
    Trucks: [HEADERS.Trucks.slice(), [1, '', 'Isuzu', '6W', true, '6W']],
    Outlets: [HEADERS.Outlets.slice(), [1, 'Outlet A', 'Cavite', '', '', '', '6/1/2026']],
    'Billing Categories': [HEADERS['Billing Categories'].slice(), [1, '6W', true], [2, '10W', false]],
  });
  const { api } = asAdmin(sheets);

  const emps = await api.getEmployees();
  assert.equal(emps.length, 2);
  assert.equal(emps.find((e) => e.id === 2).active, false);

  // blank plate falls back to a placeholder so the UI never shows an empty cell
  assert.equal((await api.getTrucks())[0].plate, '(no plate)');

  assert.equal((await api.getOutlets())[0].outletName, 'Outlet A');

  const cats = await api.getBillingCategories();
  assert.equal(cats.find((c) => c.id === 2).active, false);
});
