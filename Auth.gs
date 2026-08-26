// ============================================================
//  AngeLoyal OMS — Auth.gs
//  Google Identity Services (GIS) sign-in + app session layer.
//
//  Why this exists: the web app runs `executeAs: USER_DEPLOYING`, so the
//  platform can't tell the backend who the visitor is unless they share the
//  owner's Workspace domain (see CLAUDE.md). Instead, the client signs in with
//  Google (GIS), receives an ID token, and sends it to `login()`. We verify the
//  token, mint a random session token, and cache it. Every subsequent call goes
//  through `rpc()` carrying that session token, which sets the request's user.
//
//  Identity precedence (see _getCurrentUserEmail in Code.gs): the rpc-scoped
//  email wins; otherwise we fall back to Session.getActiveUser() so the Apps
//  Script editor and same-domain owner still work for manual testing.
// ============================================================

// Session tokens live in the script cache; the key is unguessable so a shared
// (non-per-user) cache is fine. CacheService caps TTL at 6 hours.
const _SESSION_PREFIX  = 'oms_sess_';
const _SESSION_TTL_SEC = 21600; // 6h (CacheService maximum)

/**
 * The OAuth 2.0 Web client ID used by both the GIS button (client side) and
 * token verification (server side). Stored in Script Properties so it never
 * lives in source. Set it once:
 *   Project Settings → Script Properties → OAUTH_CLIENT_ID = <client id>
 * @returns {string}
 */
function _getOAuthClientId() {
  try {
    return PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_ID') || '';
  } catch (_) {
    return '';
  }
}


/**
 * Verifies an ID token that arrived **from the browser** (GIS sign-in on the
 * Cloudflare Pages frontend) and returns its identity, or null.
 *
 * The token is fully attacker-controlled, so its signature must be checked
 * before any claim in it is believed. Decoding it locally would be an auth
 * bypass: anyone could mint `{email: <an admin>}` and sign in as them.
 *
 * ponytail: Google's tokeninfo endpoint does the signature + expiry check for
 * us (one UrlFetch, no key handling). Swap in local RS256 verification against
 * Google's JWKs only if the extra round trip per sign-in ever shows up.
 * @param {string} idToken
 * @returns {{ email: string, displayName: string } | null}
 */
function _verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    // Non-200 = bad signature, expired, or malformed. Google already rejected it.
    if (res.getResponseCode() !== 200) return null;

    const claims = JSON.parse(res.getContentText());
    // `aud` is what stops a token minted for some other app being replayed here.
    if (claims.aud !== _getOAuthClientId()) return null;
    if (!(claims.email_verified === true || claims.email_verified === 'true')) return null;
    if (!claims.email) return null;

    return {
      email:       String(claims.email).trim().toLowerCase(),
      displayName: claims.name || claims.email,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Client-callable sign-in — the one action doPost accepts without a session.
 * Takes the ID token from the GIS button, verifies it, and opens a session.
 * @param {string} idToken
 * @returns {{ success: true, sessionToken: string } | { success: false, error: string }}
 */
function login(idToken) {
  const identity = _verifyIdToken(idToken);
  if (!identity) return { success: false, error: 'AUTH_FAILED' };

  const token = _createSession(identity.email, identity.displayName);

  // Scope the request to the new identity so the audit row is attributed to
  // them rather than 'unknown'. Payroll (Phase 2) needs a sign-in trail.
  _REQUEST_EMAIL = identity.email;
  try {
    _auditLog('LOGIN', SHEET_USERS, '', '', identity.email);
  } finally {
    _REQUEST_EMAIL = null;
  }

  return { success: true, sessionToken: token };
}

/**
 * Creates a server-side session for a verified identity and returns its token.
 * @param {string} email
 * @param {string} displayName
 * @returns {string} the opaque session token
 */
function _createSession(email, displayName) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const payload = JSON.stringify({ email: email, displayName: displayName });
  CacheService.getScriptCache().put(_SESSION_PREFIX + token, payload, _SESSION_TTL_SEC);
  return token;
}

/**
 * Resolves a session token back to its identity, or null if missing/expired.
 * @param {string} token
 * @returns {{ email: string, displayName: string } | null}
 */
function _resolveSession(token) {
  if (!token) return null;
  try {
    const raw = CacheService.getScriptCache().get(_SESSION_PREFIX + token);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/** Invalidates a session token (sign-out). */
function _destroySession(token) {
  if (!token) return;
  try {
    CacheService.getScriptCache().remove(_SESSION_PREFIX + token);
  } catch (_) {}
}

/**
 * Client-callable sign-out. Drops the server session.
 * @param {string} sessionToken
 * @returns {{ success: true }}
 */
function logout(sessionToken) {
  _destroySession(sessionToken);
  return { success: true };
}

// ============================================================
//  RPC GATEWAY
// ============================================================

// Functions the client is allowed to invoke through rpc(). Anything not listed
// (private helpers, _devDump, etc.) is unreachable from the browser.
//
// 'w' marks a writer: rpc() runs those one at a time under the script lock,
// because every one of them reads the sheet, decides, then appends. Readers
// ('r') stay parallel — they would otherwise queue behind a slow import.
const RPC_ALLOWED = {
  // readers
  getBootData: 'r',
  getDispatchBoardData: 'r',
  getWaybillPrefixes: 'r',
  // session
  logout: 'r',
  // writers
  createTrip: 'w',
  saveTripChanges: 'w',
  bulkSetTripStatus: 'w',
  reorderTrips: 'w',
  confirmWaybill: 'w',
  updateSuggestedWaybill: 'w',
  importRouteFile: 'w',
  deleteImportedTrip: 'w',
  markDayScheduled: 'w',
  setTripConvoyGroup: 'w',
  updateDefaultAssignment: 'w',
  createOutlet: 'w',
  updateOutlet: 'w',
  createTruck: 'w',
  updateTruck: 'w',
  createBillingCategory: 'w',
  updateBillingCategory: 'w',
  createRouteTypeMapping: 'w',
  updateRouteTypeMapping: 'w',
  saveCustomerGroupColor: 'w',
  createWaybillPrefix: 'w',
  updateWaybillPrefix: 'w',
  createEmployee: 'w',
  updateEmployee: 'w',
  clearAllData: 'w',
};

/**
 * Single entry point for all authenticated client calls. Resolves the session
 * token to an identity, scopes it to this request, and dispatches to the named
 * allow-listed function. Throws 'AUTH_REQUIRED' if the session is missing or
 * expired so the client can re-prompt sign-in.
 *
 * Writers ('w' in RPC_ALLOWED) run one at a time under the script lock — see
 * _withLock. Readers run in parallel.
 *
 * @param {string} sessionToken  Token from login(), stored client-side.
 * @param {string} fnName        Allow-listed backend function name.
 * @param {Array}  args          Positional arguments for that function.
 * @returns {*} the target function's return value
 */
function rpc(sessionToken, fnName, args) {
  const session = _resolveSession(sessionToken);
  if (!session) throw new Error('AUTH_REQUIRED');

  if (!RPC_ALLOWED[fnName]) throw new Error('Unknown action: ' + fnName);
  const fn = globalThis[fnName];
  if (typeof fn !== 'function') throw new Error('Unknown action: ' + fnName);

  _REQUEST_EMAIL = session.email;
  try {
    return RPC_ALLOWED[fnName] === 'w'
      ? _withLock(() => fn.apply(null, args || []))
      : fn.apply(null, args || []);
  } finally {
    _REQUEST_EMAIL = null;
  }
}
