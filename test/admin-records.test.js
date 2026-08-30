// ============================================================
//  web/masters.js — the shared admin-record plumbing.
//  The six admin tables (users, trucks, employees, billing
//  categories, route type map, waybill prefixes) all route Remove/Restore and
//  Add through toggleRecordActive() / submitAddRecord(). What has to
//  hold: each entity hits its own rpc, the saved row is adopted into
//  the right local list, and the confirm/toast wording per entity
//  survives — that wording is the only thing the dispatcher sees.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb, plain } = require('./webharness');

/** Lets pending promise callbacks run — call() settles on a microtask. */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Loads web/masters.js with the globals it closes over stubbed, recording
 * every backend call. bgSave and call are the two transport seams.
 */
function loadMasters(overrides = {}) {
  const calls = { bgSave: [], rpc: [], toasts: [], closed: [], confirms: [] };
  // loadWeb builds the real sandbox; the stubs close over it late so they and
  // the tests read the same object (tests set ctx.__reply to script a response).
  let ctx;
  const stubs = {
    // the lists the specs point at
    trucks: [], employees: [], billingCategories: [], routeTypeMap: [],
    waybillPrefixes: [], defaultAssignments: [], outlets: [], customerGroupColors: [],
    users: [],
    currentUser: { role: 'Admin', email: 'admin@angeloyal.com' },
    // UI seams
    confirm: (msg) => { calls.confirms.push(msg); return true; },
    showToast: (msg, kind) => calls.toasts.push({ msg, kind }),
    setSyncing: () => {},
    openModal: () => {},
    closeModal: (id) => calls.closed.push(id),
    // helpers that live in other web/*.js files
    esc: (s) => String(s == null ? '' : s),
    catSwatch: () => '', colorChip: () => '', billingCategoryOptions: () => '',
    renderTruckList: () => {}, renderEmpList: () => {}, populatePrefixSelects: () => {},
    cgEffectiveHex: () => '#000000', prefixSeqText: () => '',
    OMS_ENV: { label: 'test' },
    ...overrides,
  };

  stubs.bgSave = (rpcName, args, opts) => calls.bgSave.push({ rpcName, args, opts });
  stubs.call = (fn, ...args) => {
    calls.rpc.push({ fn, args });
    // No reply scripted = a call that never settles, so no handler runs.
    return ctx.__reply ? Promise.resolve(ctx.__reply) : new Promise(() => {});
  };
  stubs.toastError = (err) =>
    calls.toasts.push({ msg: String(err && err.message), kind: 'error' });

  ctx = loadWeb(['masters.js'], stubs, 'globalThis.__specs = ADMIN_RECORDS;').sandbox;
  return { sandbox: ctx, calls };
}

// ---------------- Remove / Restore ----------------

test('each admin table removes through its own rpc and adopts the echoed row', () => {
  const { sandbox, calls } = loadMasters();
  sandbox.trucks.push({ id: 1, plate: 'AAA-111', active: true });

  sandbox.toggleRecordActive('truck', 1);

  assert.equal(calls.bgSave.length, 1);
  assert.equal(calls.bgSave[0].rpcName, 'updateTruck');
  assert.deepEqual(plain(calls.bgSave[0].args), [1, { active: false }]);
  assert.match(calls.confirms[0], /remove AAA-111\?/);

  // the server echoes the saved row back under spec.echo — it wins
  calls.bgSave[0].opts.onOk({ truck: { id: 1, plate: 'AAA-111', active: false, brand: 'Hino' } });
  assert.equal(sandbox.trucks[0].active, false);
  assert.equal(sandbox.trucks[0].brand, 'Hino');
  assert.match(calls.toasts[0].msg, /AAA-111 removed\./);
});

test('a writer that echoes nothing still flips Active locally', () => {
  // updateEmployee returns only { success: true }, so the optimistic flag has
  // to stand in for a server echo or the row would never repaint.
  const { sandbox, calls } = loadMasters();
  sandbox.employees.push({ id: 7, nick: 'Boyet', active: true });

  sandbox.toggleRecordActive('employee', 7);
  calls.bgSave[0].opts.onOk({ success: true });

  assert.equal(calls.bgSave[0].rpcName, 'updateEmployee');
  assert.equal(sandbox.employees[0].active, false);
});

test('restoring reads as Restore, not Remove', () => {
  const { sandbox, calls } = loadMasters();
  sandbox.billingCategories.push({ id: 3, name: '6W', active: false });

  sandbox.toggleRecordActive('billingCategory', 3);

  assert.match(calls.confirms[0], /restore 6W\?/);
  assert.deepEqual(plain(calls.bgSave[0].args), [3, { active: true }]);
  calls.bgSave[0].opts.onOk({ billingCategory: { id: 3, name: '6W', active: true } });
  assert.match(calls.toasts[0].msg, /6W restored\./);
});

test('the route type map keeps its "the <code> mapping" wording', () => {
  const { sandbox, calls } = loadMasters();
  sandbox.routeTypeMap.push({ id: 2, fileTypeCode: '4WC', billingCategory: '6W', active: true });

  sandbox.toggleRecordActive('routeTypeMap', 2);

  assert.match(calls.confirms[0], /remove the 4WC mapping\?/);
});

test('a blank waybill prefix is named, not shown as an empty string', () => {
  const { sandbox, calls } = loadMasters();
  sandbox.waybillPrefixes.push({ id: 5, prefix: '', active: true });

  sandbox.toggleRecordActive('waybillPrefix', 5);

  assert.match(calls.confirms[0], /remove \(blank prefix\)\?/);
});

test('toggling an id that is not in the list does nothing', () => {
  const { sandbox, calls } = loadMasters();
  sandbox.toggleRecordActive('truck', 999);
  assert.equal(calls.bgSave.length, 0);
  assert.equal(calls.confirms.length, 0);
});

test('removing a user reads as an account, and the echoed row wins', () => {
  const { sandbox, calls } = loadMasters();
  sandbox.users.push({ id: 4, email: 'vi@angeloyal.com', displayName: 'Vi Viewer', active: true });

  sandbox.toggleRecordActive('user', 4);

  assert.equal(calls.bgSave[0].rpcName, 'updateUser');
  assert.match(calls.confirms[0], /remove the Vi Viewer account\?/);
  calls.bgSave[0].opts.onOk({ user: { id: 4, email: 'vi@angeloyal.com', displayName: 'Vi Viewer', active: false } });
  assert.equal(sandbox.users[0].active, false);
});

// ---------------- Add ----------------

test('adding pushes the created record onto its own list and closes its modal', async () => {
  const { sandbox, calls } = loadMasters();
  sandbox.__reply = {
    success: true,
    truck: { id: 9, plate: 'ZZZ-999', active: true },
    defaultAssignment: { id: 4, truckId: 9 },
  };

  sandbox.submitAddRecord('truck', { plate: 'ZZZ-999' });
  await tick();

  assert.equal(calls.rpc[0].fn, 'createTruck');
  assert.deepEqual(plain(calls.rpc[0].args), [{ plate: 'ZZZ-999' }]);
  assert.deepEqual(sandbox.trucks, [{ id: 9, plate: 'ZZZ-999', active: true }]);
  // createTruck also seeds a roster row — the truck spec adopts it
  assert.deepEqual(sandbox.defaultAssignments, [{ id: 4, truckId: 9 }]);
  assert.deepEqual(plain(calls.closed), ['modal-add-truck']);
  assert.match(calls.toasts[0].msg, /ZZZ-999 added\./);
});

test('a failed add toasts the error and leaves the list untouched', async () => {
  const { sandbox, calls } = loadMasters();
  sandbox.__reply = { success: false, error: 'A truck with plate "ZZZ-999" already exists.' };

  sandbox.submitAddRecord('truck', { plate: 'ZZZ-999' });
  await tick();

  assert.deepEqual(sandbox.trucks, []);
  assert.deepEqual(plain(calls.closed), []);
  assert.match(calls.toasts[0].msg, /Add failed: .*already exists/);
});

test('the route type map toast names both sides of the mapping', async () => {
  const { sandbox, calls } = loadMasters();
  sandbox.__reply = { success: true, mapping: { id: 3, fileTypeCode: '4WC', billingCategory: '6W' } };

  sandbox.submitAddRecord('routeTypeMap', { fileTypeCode: '4WC', billingCategory: '6W' });
  await tick();

  assert.equal(calls.rpc[0].fn, 'createRouteTypeMapping');
  assert.match(calls.toasts[0].msg, /4WC → 6W added\./);
});

test('every admin spec points at a distinct rpc pair and modal', () => {
  const { sandbox } = loadMasters();
  const specs = Object.values(sandbox.__specs);
  const seen = new Set();
  for (const s of specs) {
    for (const v of [s.create, s.update, s.modal]) {
      assert.ok(v, 'spec field must be set');
      assert.equal(seen.has(v), false, `duplicated across specs: ${v}`);
      seen.add(v);
    }
    assert.equal(typeof s.list(), 'object');
    assert.equal(typeof s.name, 'function');
    assert.equal(typeof s.after, 'function');
  }
  assert.equal(specs.length, 6);
});

// ---------------- Users panel ----------------

// The Users table is the one admin table with a per-row branch: an admin must
// not be offered a control that would lock them out of the panel. The server
// refuses it either way, so what is tested here is that the UI agrees.
test('the signed-in admin gets no role dropdown and no Remove on their own row', () => {
  const els = {};
  const el = (id) => (els[id] = els[id] || { value: '', checked: true, innerHTML: '', textContent: '' });
  const { sandbox } = loadMasters({
    document: { getElementById: el, createElement: () => el('tmp'), querySelectorAll: () => [] },
  });
  sandbox.users.push(
    { id: 1, email: 'admin@angeloyal.com', displayName: 'Ada Admin', role: 'Admin', active: true },
    { id: 2, email: 'vi@angeloyal.com', displayName: 'Vi Viewer', role: 'Viewer', active: true },
  );

  sandbox.renderUsersAdmin();
  const html = els['users-tbody'].innerHTML;

  assert.equal(els['users-count'].textContent, '2 users');
  // own row: role is plain text, no Remove button
  assert.equal(/updateUserField\(1,'role'/.test(html), false);
  assert.equal(/toggleUserActive\(1\)/.test(html), false);
  // somebody else's row: full controls
  assert.match(html, /updateUserField\(2,'role'/);
  assert.match(html, /toggleUserActive\(2\)/);
  assert.match(html, /<option value="Viewer" selected>/);
});
