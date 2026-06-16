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

// ---------------- Truck roster (append-only) ----------------

test('saveAssignment / removeAssignment drive getCurrentAssignments to the latest state', () => {
  const sheets = base({
    'Employee-Truck Assignment': emptySheet('Employee-Truck Assignment'),
    Outlets: emptySheet('Outlets'),
  });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Dispatcher });

  api.saveAssignment(100, 5, 'Driver');
  api.saveAssignment(100, 6, 'Driver'); // reassigned to a different truck

  let current = api.getCurrentAssignments();
  const emp100 = current.find((a) => a.employeeId === 100);
  assert.ok(emp100, 'employee 100 should be assigned');
  assert.equal(emp100.truckId, 6); // latest row wins

  api.removeAssignment(100, 'Driver'); // append a null-truck row
  current = api.getCurrentAssignments();
  assert.equal(current.find((a) => a.employeeId === 100), undefined); // filtered out
});

test('roster writes are gated by ASSIGN_CREW permission', () => {
  const sheets = base({ 'Employee-Truck Assignment': emptySheet('Employee-Truck Assignment') });
  const { api } = makeEnv({ sheets, userEmail: EMAIL.Viewer });
  assert.throws(() => api.saveAssignment(1, 2, 'Driver'), /Access denied/);
});
