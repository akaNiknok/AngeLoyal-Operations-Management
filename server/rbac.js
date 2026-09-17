// ============================================================
//  AngeLoyal OMS — server/rbac.js
//  Roles, the permission matrix and the request's user (Code.gs).
//  The UI hides controls too, but the server is the real gate:
//  every sensitive writer starts with `await requirePermission()`.
// ============================================================

import { currentEmail } from './ctx.js';
import { one } from './db.js';

export const ROLES = {
  ADMIN:      'Admin',
  DISPATCHER: 'Dispatcher',
  PAYROLL:    'Payroll',
  VIEWER:     'Viewer',
};

// Each key maps to the roles that have the permission.
export const PERMISSIONS = {
  VIEW_DISPATCH:          [ROLES.ADMIN, ROLES.DISPATCHER, ROLES.PAYROLL, ROLES.VIEWER],
  ASSIGN_CREW:            [ROLES.ADMIN, ROLES.DISPATCHER],
  ADD_MANUAL_TRIP:        [ROLES.ADMIN, ROLES.DISPATCHER],
  FLAG_TRIP_STATUS:       [ROLES.ADMIN, ROLES.DISPATCHER],
  CONFIRM_WAYBILL:        [ROLES.ADMIN, ROLES.DISPATCHER],
  EDIT_MASTER_RECORDS:    [ROLES.ADMIN],
  EDIT_WAYBILL_PREFIXES:  [ROLES.ADMIN, ROLES.DISPATCHER],
  EDIT_USERS:             [ROLES.ADMIN],
  VIEW_AUDIT:             [ROLES.ADMIN],
  CLEAR_ALL_DATA:         [ROLES.ADMIN],
  VIEW_BILLING:           [ROLES.ADMIN, ROLES.PAYROLL],
  EDIT_BILLING:           [ROLES.ADMIN, ROLES.PAYROLL],
  EDIT_FREIGHT_RATES:     [ROLES.ADMIN],
};

/**
 * The active users row for the request's verified email, or null.
 * @returns {Promise<{ id, email, displayName, role, active } | null>}
 */
export async function currentUser() {
  const email = currentEmail();
  if (!email || email === 'unknown') return null;
  const row = await one(
    `SELECT id, email, display_name, role FROM users WHERE email = ? AND active = 1`,
    email.trim().toLowerCase(),
  );
  if (!row) return null;
  return { id: row.id, email: String(row.email).trim().toLowerCase(), displayName: row.display_name, role: row.role, active: true };
}

/** @param {string} permission  Key of PERMISSIONS. */
export async function hasPermission(permission) {
  const user = await currentUser();
  if (!user) return false;
  return (PERMISSIONS[permission] || []).includes(user.role);
}

/** Throws when the request's user lacks the permission. */
export async function requirePermission(permission) {
  if (!(await hasPermission(permission))) {
    const user = await currentUser();
    const role = user ? user.role : 'unauthenticated';
    throw new Error(`Access denied. Your role (${role}) does not have permission to perform this action.`);
  }
}

/**
 * The session block the client boots from. A verified visitor who is not in
 * users gets role null.
 * @returns {Promise<{ email, displayName, role }>}
 */
export async function getUserSession() {
  const user = await currentUser();
  if (user) return { email: user.email, displayName: user.displayName, role: user.role };
  const email = currentEmail();
  const known = email && email !== 'unknown';
  return { email: known ? email : '', displayName: known ? email : 'Not signed in', role: null };
}
