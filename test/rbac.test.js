// ============================================================
//  Code.gs — RBAC unit tests
//  The server is the real permission gate (the UI only hides
//  controls). These tests lock the role x permission matrix and
//  the unauthenticated / inactive-user paths.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet } = require('./fixtures');

function envAs(email) {
  return makeEnv({ sheets: { Users: usersSheet() }, userEmail: email });
}

const EMAIL = {
  Admin: 'admin@angeloyal.com',
  Dispatcher: 'dispatch@angeloyal.com',
  Payroll: 'payroll@angeloyal.com',
  Viewer: 'viewer@angeloyal.com',
  Inactive: 'former@angeloyal.com',
  Unknown: 'nobody@angeloyal.com',
};

// Expected permission matrix, mirrored from Code.gs PERMISSIONS.
// If this drifts from the source, that is exactly the regression we want to catch.
const MATRIX = {
  VIEW_DISPATCH: ['Admin', 'Dispatcher', 'Payroll', 'Viewer'],
  ASSIGN_CREW: ['Admin', 'Dispatcher'],
  ADD_MANUAL_TRIP: ['Admin', 'Dispatcher'],
  FLAG_TRIP_STATUS: ['Admin', 'Dispatcher'],
  CONFIRM_WAYBILL: ['Admin', 'Dispatcher'],
  EDIT_MASTER_RECORDS: ['Admin'],
  VIEW_AUDIT: ['Admin'],
};

const ROLES = ['Admin', 'Dispatcher', 'Payroll', 'Viewer'];

test('_hasPermission matches the documented role x permission matrix', () => {
  for (const role of ROLES) {
    const { api } = envAs(EMAIL[role]);
    for (const [perm, allowedRoles] of Object.entries(MATRIX)) {
      const expected = allowedRoles.includes(role);
      assert.equal(
        api._hasPermission(perm),
        expected,
        `${role} ${expected ? 'should' : 'should NOT'} have ${perm}`
      );
    }
  }
});

test('_requirePermission throws for a role that lacks the permission', () => {
  const { api } = envAs(EMAIL.Viewer);
  assert.throws(() => api._requirePermission('ASSIGN_CREW'), /Access denied/);
  // and does not throw when allowed
  assert.doesNotThrow(() => api._requirePermission('VIEW_DISPATCH'));
});

test('inactive users are treated as having no role', () => {
  const { api } = envAs(EMAIL.Inactive);
  assert.equal(api._getCurrentUserRecord(), null);
  assert.equal(api._hasPermission('VIEW_DISPATCH'), false);
  assert.throws(() => api._requirePermission('VIEW_DISPATCH'), /Access denied/);
});

test('unknown / unauthenticated users get no permissions', () => {
  const { api: unknownApi } = envAs(EMAIL.Unknown);
  assert.equal(unknownApi._getCurrentUserRecord(), null);
  assert.equal(unknownApi._hasPermission('VIEW_DISPATCH'), false);

  const { api: anonApi } = makeEnv({ sheets: { Users: usersSheet() }, userEmail: 'unknown' });
  assert.equal(anonApi._hasPermission('EDIT_MASTER_RECORDS'), false);
});

test('email matching is case-insensitive', () => {
  const { api } = envAs('ADMIN@ANGELOYAL.COM');
  const rec = api._getCurrentUserRecord();
  assert.ok(rec);
  assert.equal(rec.role, 'Admin');
});

test('Active is honored whether stored as a boolean or the string "TRUE"', () => {
  // Live sheets often hold the string 'TRUE'/'FALSE' rather than native
  // booleans (manual entry / CSV import). Both must resolve correctly, and
  // stray whitespace around the email must not break the match.
  const sheets = {
    Users: [
      ['ID', 'Email', 'Display Name', 'Role', 'Active'],
      [1, '  string.admin@angeloyal.com ', 'Stringy Admin', 'Admin', 'TRUE'],
      [2, 'string.former@angeloyal.com', 'Stringy Former', 'Admin', 'FALSE'],
    ],
  };

  const active = makeEnv({ sheets, userEmail: 'string.admin@angeloyal.com' });
  const rec = active.api._getCurrentUserRecord();
  assert.ok(rec, 'string "TRUE" should count as active');
  assert.equal(rec.role, 'Admin');
  assert.equal(active.api.getUserSession().role, 'Admin');

  const inactive = makeEnv({ sheets, userEmail: 'string.former@angeloyal.com' });
  assert.equal(inactive.api._getCurrentUserRecord(), null, 'string "FALSE" is inactive');
});

test('getUserSession exposes the role for the client, and null for outsiders', () => {
  const { api: adminApi } = envAs(EMAIL.Admin);
  // Field-by-field (the session object is built inside the vm realm, so its
  // prototype differs from the host's — deepStrictEqual would reject it).
  const session = adminApi.getUserSession();
  assert.equal(session.email, 'admin@angeloyal.com');
  assert.equal(session.displayName, 'Ada Admin');
  assert.equal(session.role, 'Admin');

  const { api: outsiderApi } = envAs(EMAIL.Unknown);
  assert.equal(outsiderApi.getUserSession().role, null);
});

test('unknown permission keys deny by default', () => {
  const { api } = envAs(EMAIL.Admin);
  assert.equal(api._hasPermission('NOT_A_REAL_PERMISSION'), false);
});
