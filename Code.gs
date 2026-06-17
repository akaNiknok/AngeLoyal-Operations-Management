// ============================================================
//  AngeLoyal Logistics — Operations Management System
//  Code.gs  |  Entry point: constants, RBAC, web app routing
// ============================================================


// ============================================================
//  SHEET NAME CONSTANTS
// ============================================================

const SHEET_EMPLOYEES       = 'Employees';
const SHEET_TRUCKS          = 'Trucks';
const SHEET_ASSIGNMENTS     = 'Employee-Truck Assignment';
const SHEET_AUDIT           = 'Audit Log';
const SHEET_USERS           = 'Users';
const SHEET_BILLING_CATEGORIES = 'Billing Categories';
const SHEET_WB_PREFIXES     = 'Waybill Prefixes';
const SHEET_DEFAULT_ASSIGN  = 'Default Assignments';
const SHEET_OUTLETS         = 'Outlets';
const SHEET_TRIPS           = 'Trips';
const SHEET_ROUTE_FREQ      = 'Route Frequency Log';
const SHEET_WAYBILLS        = 'Waybills';


// ============================================================
//  ROLE-BASED ACCESS CONTROL (RBAC)
// ============================================================

const ROLES = {
  ADMIN:      'Admin',
  DISPATCHER: 'Dispatcher',
  PAYROLL:    'Payroll',
  VIEWER:     'Viewer',
};

// Permissions: which roles can perform which actions.
// Each key maps to the minimum set of roles that have access.
const PERMISSIONS = {
  VIEW_DISPATCH:          [ROLES.ADMIN, ROLES.DISPATCHER, ROLES.PAYROLL, ROLES.VIEWER],
  ASSIGN_CREW:            [ROLES.ADMIN, ROLES.DISPATCHER],
  ADD_MANUAL_TRIP:        [ROLES.ADMIN, ROLES.DISPATCHER],
  FLAG_TRIP_STATUS:       [ROLES.ADMIN, ROLES.DISPATCHER],
  CONFIRM_WAYBILL:        [ROLES.ADMIN, ROLES.DISPATCHER],
  EDIT_MASTER_RECORDS:    [ROLES.ADMIN],
  VIEW_AUDIT:             [ROLES.ADMIN],
};

// Identity for the current request, set by rpc()/login() (see Auth.gs) from a
// verified Google sign-in. When set, it takes precedence over Session — that's
// how RBAC identifies visitors who aren't in the owner's Workspace domain.
var _REQUEST_EMAIL = null;

/**
 * Returns the current user's email. Prefers the rpc-scoped identity from a
 * verified Google sign-in; otherwise falls back to Session.getActiveUser()
 * (covers the Apps Script editor and the same-domain owner). Returns 'unknown'
 * when no identity is available.
 * @returns {string}
 */
function _getCurrentUserEmail() {
  if (_REQUEST_EMAIL) return _REQUEST_EMAIL;
  try {
    return Session.getActiveUser().getEmail() || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Looks up the current user in the Users sheet and returns their role object.
 * Returns null if the user is not found or is inactive.
 * @returns {{ id, email, displayName, role, active } | null}
 */
function _getCurrentUserRecord() {
  try {
    const email = _getCurrentUserEmail();
    if (!email || email === 'unknown') return null;

    const sheet = _getSheet(SHEET_USERS);
    const rows  = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => h.toString().trim());

    const wantEmail = email.trim().toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowEmail = String(_val(row, headers, 'Email')).trim().toLowerCase();
      // Active may come back as a native boolean or the string 'TRUE'.
      if (rowEmail === wantEmail && _isTrue(_val(row, headers, 'Active'))) {
        return {
          id:          _val(row, headers, 'ID'),
          email:       rowEmail,
          displayName: _val(row, headers, 'Display Name'),
          role:        _val(row, headers, 'Role'),
          active:      true,
        };
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Checks whether the current user has a given permission.
 * @param {string} permission  Key from PERMISSIONS object.
 * @returns {boolean}
 */
function _hasPermission(permission) {
  const user = _getCurrentUserRecord();
  if (!user) return false;
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(user.role);
}

/**
 * Throws an error if the current user lacks the required permission.
 * Use at the top of any sensitive writer function.
 * @param {string} permission
 */
function _requirePermission(permission) {
  if (!_hasPermission(permission)) {
    const user = _getCurrentUserRecord();
    const role = user ? user.role : 'unauthenticated';
    throw new Error(`Access denied. Your role (${role}) does not have permission to perform this action.`);
  }
}

/**
 * Returns the current user's session info for the client UI.
 * Called after sign-in so the UI can show/hide features based on role.
 * A verified visitor who isn't in the Users sheet gets role null.
 * @returns {{ email, displayName, role }}
 */
function getUserSession() {
  const user = _getCurrentUserRecord();
  if (user) {
    return { email: user.email, displayName: user.displayName, role: user.role };
  }
  const email = _getCurrentUserEmail();
  const known = email && email !== 'unknown';
  return { email: known ? email : '', displayName: known ? email : 'Not signed in', role: null };
}


// ============================================================
//  WEB APP ENTRY POINT
// ============================================================

/**
 * Serves the web app HTML page. Also handles the Google OAuth redirect: when
 * Google sends the user back with ?code=&state=, we exchange it for a session
 * here and inject the session token into the page so the client can adopt it.
 * Deploy as: Execute as ME, access Anyone (with a Google account).
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === 'devDump') {
    return _devDump(params);
  }

  // OAuth callback → mint a session and hand its token to the client. On any
  // failure (e.g. a reused code on refresh) bootToken stays '' and the client
  // falls back to its stored session or the sign-in screen.
  const bootToken = params.code ? (_handleOAuthCallback(params.code, params.state) || '') : '';

  const template = HtmlService.createTemplateFromFile('Index');
  template.bootToken = bootToken;
  return template
    .evaluate()
    .setTitle('AngeLoyal OMS')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Includes another HTML file's content inline. Used by Index.html to
 * assemble the page from Styles.html + script partials via
 * `<?!= include('Name'); ?>` template tags.
 * @param {string} filename
 * @returns {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
