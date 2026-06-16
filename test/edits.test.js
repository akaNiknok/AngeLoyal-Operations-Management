// ============================================================
//  Remaining Phase 1 edit paths + small readers:
//  updateOutlet / updateEmployee / updateDefaultAssignment /
//  updateTruck(active), getSuggestedWaybillNumber,
//  _resolveBillingCategory, and the master-list readers.
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

// ---------------- updateOutlet ----------------

test('updateOutlet applies partial changes and keeps other fields', () => {
  const sheets = base({
    Outlets: [HEADERS.Outlets.slice(), [5, 'Old Name', 'Cavite', 'Addr', 'Group', 'Note', '6/1/2026']],
  });
  const { api, ss } = asAdmin(sheets);

  const res = api.updateOutlet(5, { outletName: 'New Name', area: 'Laguna' });
  assert.equal(res.success, true);

  const outlet = rowObject(HEADERS.Outlets, dump(ss, 'Outlets').rows[0]);
  assert.equal(outlet['Outlet Name'], 'New Name');
  assert.equal(outlet.Area, 'Laguna');
  assert.equal(outlet.Address, 'Addr'); // untouched
});

test('updateOutlet rejects a blank name and unknown ids', () => {
  const sheets = base({
    Outlets: [HEADERS.Outlets.slice(), [5, 'Old', 'Cavite', '', '', '', '6/1/2026']],
  });
  const { api } = asAdmin(sheets);
  assert.match(api.updateOutlet(5, { outletName: '   ' }).error, /required/);
  assert.match(api.updateOutlet(999, { area: 'X' }).error, /not found/);
});

test('updateOutlet is gated by EDIT_MASTER_RECORDS', () => {
  const sheets = base({ Outlets: [HEADERS.Outlets.slice(), [5, 'Old', '', '', '', '', '']] });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  assert.throws(() => api.updateOutlet(5, { area: 'X' }), /Access denied/);
});

// ---------------- updateEmployee ----------------

test('updateEmployee validates required fields and toggles active', () => {
  const sheets = base({
    Employees: [HEADERS.Employees.slice(), [1, 'Boy', 'Juan', '', 'Cruz', 'Driver', true]],
  });
  const { api, ss } = asAdmin(sheets);

  assert.match(api.updateEmployee(1, { nick: '' }).error, /Nickname/);
  assert.match(api.updateEmployee(1, { role: '' }).error, /Role/);

  const res = api.updateEmployee(1, { nick: 'Boyet', active: false });
  assert.equal(res.success, true);
  const emp = rowObject(HEADERS.Employees, dump(ss, 'Employees').rows[0]);
  assert.equal(emp.Nickname, 'Boyet');
  assert.equal(emp.Active, false);
});

// ---------------- updateDefaultAssignment ----------------

test('updateDefaultAssignment updates driver, helper CSV, and notes', () => {
  const sheets = base({
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [1, 3, 9, '21', 'old']],
  });
  const { api, ss } = asAdmin(sheets);

  const res = api.updateDefaultAssignment(1, {
    defaultDriverId: 10,
    defaultHelperIds: [21, 22],
    notes: 'new note',
  });
  assert.equal(res.success, true);

  const row = rowObject(HEADERS['Default Assignments'], dump(ss, 'Default Assignments').rows[0]);
  assert.equal(Number(row['Default Driver ID']), 10);
  assert.equal(row['Default Helper IDs'], '21,22'); // array joined to CSV
  assert.equal(row.Notes, 'new note');
});

test('updateDefaultAssignment errors on unknown id and requires admin', () => {
  const sheets = base({
    'Default Assignments': [HEADERS['Default Assignments'].slice(), [1, 3, 9, '', '']],
  });
  const { api } = asAdmin(sheets);
  assert.match(api.updateDefaultAssignment(99, { notes: 'x' }).error, /not found/);

  const { api: dispApi } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });
  assert.throws(() => dispApi.updateDefaultAssignment(1, { notes: 'x' }), /Access denied/);
});

// ---------------- updateTruck active toggle ----------------

test('updateTruck toggles active and returns the refreshed record', () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [1, 'AAA-111', 'Isuzu', '6W', true, '6W']],
  });
  const { api, ss } = asAdmin(sheets);

  const res = api.updateTruck(1, { active: false, brand: 'Hino' });
  assert.equal(res.success, true);
  assert.equal(res.truck.active, false);
  assert.equal(res.truck.brand, 'Hino');

  const truck = rowObject(HEADERS.Trucks, dump(ss, 'Trucks').rows[0]);
  assert.equal(truck.Active, false);
});

// ---------------- getSuggestedWaybillNumber ----------------

test('getSuggestedWaybillNumber previews the next number without writing', () => {
  const sheets = base({
    'Waybill Prefixes': [HEADERS['Waybill Prefixes'].slice(), [1, 'AL', 'AngeLoyal', 40]],
  });
  const { api, ss } = asAdmin(sheets);

  const res = api.getSuggestedWaybillNumber(1);
  assert.equal(res.nextNumber, 41);
  assert.equal(res.suggested, 'AL-41');
  // unchanged on the sheet
  assert.equal(rowObject(HEADERS['Waybill Prefixes'], dump(ss, 'Waybill Prefixes').rows[0])['Last Sequence Number'], 40);

  assert.throws(() => api.getSuggestedWaybillNumber(999), /not found/);
});

// ---------------- _resolveBillingCategory ----------------

test('_resolveBillingCategory reads a truck category, else empty string', () => {
  const sheets = base({
    Trucks: [HEADERS.Trucks.slice(), [3, 'ABC-123', 'Isuzu', '10W', true, '10W']],
  });
  const { api } = asAdmin(sheets);
  assert.equal(api._resolveBillingCategory(3), '10W');
  assert.equal(api._resolveBillingCategory(999), ''); // unknown truck
  assert.equal(api._resolveBillingCategory(''), ''); // falsy id short-circuits
});

// ---------------- master-list readers ----------------

test('master readers map rows and surface the active flag', () => {
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

  const emps = api.getEmployees();
  assert.equal(emps.length, 2);
  assert.equal(emps.find((e) => e.id === 2).active, false);

  // blank plate falls back to a placeholder so the UI never shows an empty cell
  assert.equal(api.getTrucks()[0].plate, '(no plate)');

  assert.equal(api.getOutlets()[0].outletName, 'Outlet A');

  const cats = api.getBillingCategories();
  assert.equal(cats.find((c) => c.id === 2).active, false);
});
