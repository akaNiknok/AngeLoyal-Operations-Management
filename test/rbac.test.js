// ============================================================
//  server/rbac.js — the role x permission matrix.
//  The server is the real permission gate (the UI only hides
//  controls). These tests lock the matrix and the unauthenticated /
//  inactive-user paths.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet, EMAIL } = require('./fixtures');

function envAs(email) {
  return makeEnv({ sheets: { Users: usersSheet() }, userEmail: email });
}

// Expected matrix, mirrored from server/rbac.js PERMISSIONS. A drift here is
// exactly the regression to catch.
const MATRIX = {
  VIEW_DISPATCH: ['Admin', 'Dispatcher', 'Payroll', 'Viewer'],
  ASSIGN_CREW: ['Admin', 'Dispatcher'],
  ADD_MANUAL_TRIP: ['Admin', 'Dispatcher'],
  FLAG_TRIP_STATUS: ['Admin', 'Dispatcher'],
  CONFIRM_WAYBILL: ['Admin', 'Dispatcher'],
  EDIT_MASTER_RECORDS: ['Admin'],
  EDIT_WAYBILL_PREFIXES: ['Admin', 'Dispatcher'],
  EDIT_USERS: ['Admin'],
  VIEW_AUDIT: ['Admin'],
  CLEAR_ALL_DATA: ['Admin'],
  VIEW_BILLING: ['Admin', 'Payroll'],
  EDIT_BILLING: ['Admin', 'Payroll'],
  EDIT_FREIGHT_RATES: ['Admin'],
};

const ROLES = ['Admin', 'Dispatcher', 'Payroll', 'Viewer'];

test('hasPermission matches the documented role x permission matrix', async () => {
  for (const role of ROLES) {
    const { api } = envAs(EMAIL[role]);
    for (const [perm, allowedRoles] of Object.entries(MATRIX)) {
      const expected = allowedRoles.includes(role);
      assert.equal(await api.hasPermission(perm), expected,
        `${role} ${expected ? 'should' : 'should NOT'} have ${perm}`);
    }
  }
  // Every key in the source matrix is covered above.
  const { PERMISSIONS } = require('../server/rbac.js');
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), Object.keys(MATRIX).sort());
});

test('requirePermission rejects for a role that lacks the permission', async () => {
  const { api } = envAs(EMAIL.Viewer);
  await assert.rejects(() => api.requirePermission('ASSIGN_CREW'), /Access denied\. Your role \(Viewer\)/);
  await api.requirePermission('VIEW_DISPATCH');
});

test('inactive users are treated as having no role', async () => {
  const { api } = envAs(EMAIL.Inactive);
  assert.equal(await api.currentUser(), null);
  assert.equal(await api.hasPermission('VIEW_DISPATCH'), false);
  await assert.rejects(() => api.requirePermission('VIEW_DISPATCH'), /Access denied\. Your role \(unauthenticated\)/);
});

test('unknown / unauthenticated users get no permissions', async () => {
  const { api: unknownApi } = envAs(EMAIL.Unknown);
  assert.equal(await unknownApi.currentUser(), null);
  assert.equal(await unknownApi.hasPermission('VIEW_DISPATCH'), false);

  const { api: anonApi } = envAs('unknown');
  assert.equal(await anonApi.hasPermission('EDIT_MASTER_RECORDS'), false);
});

test('email matching is case-insensitive and tolerates whitespace in the sheet', async () => {
  const { api } = envAs('ADMIN@ANGELOYAL.COM');
  const rec = await api.currentUser();
  assert.ok(rec);
  assert.equal(rec.role, 'Admin');
  assert.equal(rec.email, 'admin@angeloyal.com');

  // Live sheets held '  email ' and the string 'TRUE'; the transform trims
  // and normalizes, so the same rows still resolve.
  const sheets = {
    Users: [
      ['ID', 'Email', 'Display Name', 'Role', 'Active'],
      [1, '  string.admin@angeloyal.com ', 'Stringy Admin', 'Admin', 'TRUE'],
      [2, 'string.former@angeloyal.com', 'Stringy Former', 'Admin', 'FALSE'],
    ],
  };
  const active = makeEnv({ sheets, userEmail: 'string.admin@angeloyal.com' });
  assert.equal((await active.api.currentUser()).role, 'Admin');
  assert.equal((await active.api.getUserSession()).role, 'Admin');
  const inactive = makeEnv({ sheets, userEmail: 'string.former@angeloyal.com' });
  assert.equal(await inactive.api.currentUser(), null);
});

test('getUserSession exposes the role for the client, and null for outsiders', async () => {
  const { api: adminApi } = envAs(EMAIL.Admin);
  assert.deepEqual(await adminApi.getUserSession(),
    { email: 'admin@angeloyal.com', displayName: 'Ada Admin', role: 'Admin' });

  const { api: outsiderApi } = envAs(EMAIL.Unknown);
  assert.deepEqual(await outsiderApi.getUserSession(),
    { email: EMAIL.Unknown, displayName: EMAIL.Unknown, role: null });

  const { api: anonApi } = envAs('unknown');
  assert.deepEqual(await anonApi.getUserSession(), { email: '', displayName: 'Not signed in', role: null });
});

test('unknown permission keys deny by default', async () => {
  const { api } = envAs(EMAIL.Admin);
  assert.equal(await api.hasPermission('NOT_A_REAL_PERMISSION'), false);
});
