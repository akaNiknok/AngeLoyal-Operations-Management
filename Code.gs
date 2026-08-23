// ============================================================
//  AngeLoyal Logistics — Operations Management System
//  Code.gs  |  Entry point: constants, RBAC, web app routing
// ============================================================


// ============================================================
//  SHEET NAME CONSTANTS
// ============================================================

const SHEET_EMPLOYEES       = 'Employees';
const SHEET_TRUCKS          = 'Trucks';
const SHEET_AUDIT           = 'Audit Log';
const SHEET_USERS           = 'Users';
const SHEET_BILLING_CATEGORIES = 'Billing Categories';
const SHEET_WB_PREFIXES     = 'Waybill Prefixes';
const SHEET_DEFAULT_ASSIGN  = 'Default Assignments';
const SHEET_OUTLETS         = 'Outlets';
const SHEET_TRIPS           = 'Trips';
const SHEET_ROUTE_FREQ      = 'Route Frequency Log';
const SHEET_WAYBILLS        = 'Waybills';
const SHEET_ROUTE_TYPE_MAP  = 'Route Type Map';


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
  EDIT_WAYBILL_PREFIXES:  [ROLES.ADMIN, ROLES.DISPATCHER],
  VIEW_AUDIT:             [ROLES.ADMIN],
  CLEAR_ALL_DATA:         [ROLES.ADMIN],
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
 * GET on /exec. The UI now lives on Cloudflare Pages (see web/), so this only
 * keeps the token-gated dev endpoints alive and bounces everyone else to the
 * real frontend — old bookmarks of this URL still land somewhere useful.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === 'devDump') {
    return _devDump(params);
  }
  if (params.action === 'devClear') {
    return _devClear(params);
  }

  // This page is served inside Apps Script's sandbox iframe, so it has to
  // break out explicitly: a meta refresh would navigate the frame, and the
  // frontend refuses to be framed (X-Frame-Options: DENY). The link is the
  // fallback for when the script doesn't run.
  const url = _frontendUrl();
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8">' +
    '<title>AngeLoyal OMS</title>' +
    '<p style="font:15px/1.5 sans-serif;padding:24px">' +
    'AngeLoyal OMS has moved. <a href="' + url + '" target="_top">Open the app</a>.</p>' +
    '<script>try{(window.top||window).location.href=' + JSON.stringify(url) + '}catch(e){}<\/script>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Where the frontend for *this* script lives. The DEV script points at the DEV
 * Pages project via Script Properties; prod is the default.
 * @returns {string}
 */
function _frontendUrl() {
  try {
    return PropertiesService.getScriptProperties().getProperty('FRONTEND_URL') ||
      'https://angeloyal-oms.pages.dev';
  } catch (_) {
    return 'https://angeloyal-oms.pages.dev';
  }
}

/**
 * JSON API for the Cloudflare Pages frontend. Every authenticated call from
 * the browser is a POST of `{ token, fn, args }`; `fn: 'login'` is the sole
 * pre-session action and carries a Google ID token instead of a session token.
 *
 * Two constraints shape this, both from Apps Script:
 *  - **Never throw.** A thrown error becomes an HTML error page, not a status
 *    code, so failures are reported in the body as `{ ok: false, error }`.
 *  - **No response headers.** CORS works only because /exec 302-redirects to
 *    googleusercontent.com, which serves `Access-Control-Allow-Origin: *`.
 *    That also means the request must stay a *simple* request — the client
 *    sends a plain string body with no Content-Type, since any preflight
 *    would hit a doOptions that Apps Script cannot provide.
 *
 * @param {Object} e  Apps Script POST event; the JSON body is e.postData.contents.
 * @returns {TextOutput} `{ ok: true, data }` or `{ ok: false, error }`
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (_) {
    return _jsonOut({ ok: false, error: 'BAD_REQUEST' });
  }

  try {
    // Sign-in: no session yet, so it can't go through rpc()'s allow-list.
    if (body.fn === 'login') {
      return _jsonOut({ ok: true, data: login(body.idToken) });
    }
    return _jsonOut({ ok: true, data: rpc(body.token, body.fn, body.args) });
  } catch (err) {
    // rpc() throws AUTH_REQUIRED on an expired session — the client re-prompts
    // sign-in on that exact string, so pass the message through unchanged.
    return _jsonOut({ ok: false, error: (err && err.message) || String(err) });
  }
}

/** Serializes a response object as a JSON TextOutput. */
function _jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
