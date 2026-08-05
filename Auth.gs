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
 * The OAuth client secret, used only server-side to exchange the auth code.
 * Stored in Script Properties (OAUTH_CLIENT_SECRET) — never sent to the client.
 * @returns {string}
 */
function _getOAuthClientSecret() {
  try {
    return PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_SECRET') || '';
  } catch (_) {
    return '';
  }
}

/**
 * The web app URL Google redirects back to after sign-in. This lives on the
 * stable script.google.com host (unlike the sandbox iframe origin), so it can
 * be registered as an Authorized redirect URI on the OAuth client.
 * @returns {string}
 */
function _getRedirectUri() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (_) {
    return '';
  }
}

/**
 * Client-callable: builds the Google sign-in URL the UI links to (top-level).
 * A one-time state token is cached for CSRF protection on the callback.
 * @returns {{ url: string }}
 */
function getLoginUrl() {
  const clientId = _getOAuthClientId();
  if (!clientId) return { url: '' };

  // Cache the exact redirect_uri with the state. OAuth requires the token
  // exchange to use the *same* redirect_uri as the auth request — and for
  // Google Workspace users the browser is rewritten to a domain-scoped URL
  // (…/a/macros/<domain>/…), so doGet can't safely recompute it later.
  const state = Utilities.getUuid();
  const redirectUri = _getRedirectUri();
  CacheService.getScriptCache().put('oms_state_' + state, redirectUri, 600); // 10 min

  const url = 'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('openid email profile') +
    '&include_granted_scopes=true' +
    '&prompt=select_account' +
    '&state=' + encodeURIComponent(state);
  return { url: url };
}

/**
 * Decodes the identity claims from an ID token returned by Google's token
 * endpoint. The token arrives directly from Google over TLS (it was just
 * exchanged), so we read its payload and still verify the audience.
 * @param {string} idToken
 * @returns {{ email: string, displayName: string } | null}
 */
function _identityFromIdToken(idToken) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length < 2) return null;
    const json = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString();
    const claims = JSON.parse(json);

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
 * Handles the OAuth redirect back from Google (called by doGet when ?code is
 * present). Validates the CSRF state, exchanges the auth code for tokens,
 * derives the identity, and opens a session. Returns the new session token to
 * inject into the served page, or null on any failure (e.g. a reused code on
 * refresh — the client then falls back to its stored session).
 * @param {string} code   Authorization code from Google.
 * @param {string} state  CSRF state echoed back by Google.
 * @returns {string|null} a session token, or null
 */
function _handleOAuthCallback(code, state) {
  if (!code || !state) return null;

  const cache = CacheService.getScriptCache();
  const redirectUri = cache.get('oms_state_' + state);
  if (!redirectUri) return null; // unknown/expired/replayed state
  cache.remove('oms_state_' + state);

  const clientId = _getOAuthClientId();
  const secret   = _getOAuthClientSecret();
  if (!clientId || !secret) return null;

  try {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        code: code,
        client_id: clientId,
        client_secret: secret,
        // Must equal the redirect_uri from the auth request (cached with state).
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
    });
    if (res.getResponseCode() !== 200) return null;

    const data = JSON.parse(res.getContentText());
    const identity = _identityFromIdToken(data.id_token);
    if (!identity) return null;

    return _createSession(identity.email, identity.displayName);
  } catch (_) {
    return null;
  }
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
const RPC_ALLOWED = {
  // readers
  getBootData: true,
  getDispatchBoardData: true,
  getWaybillPrefixes: true,
  // writers
  createTrip: true,
  saveTripChanges: true,
  bulkSetTripStatus: true,
  reorderTrips: true,
  confirmWaybill: true,
  importRouteFile: true,
  deleteImportedTrip: true,
  markDayScheduled: true,
  setTripConvoyGroup: true,
  updateDefaultAssignment: true,
  createOutlet: true,
  updateOutlet: true,
  createTruck: true,
  updateTruck: true,
  createBillingCategory: true,
  updateBillingCategory: true,
  createRouteTypeMapping: true,
  updateRouteTypeMapping: true,
  createWaybillPrefix: true,
  updateWaybillPrefix: true,
  createEmployee: true,
  updateEmployee: true,
};

/**
 * Single entry point for all authenticated client calls. Resolves the session
 * token to an identity, scopes it to this request, and dispatches to the named
 * allow-listed function. Throws 'AUTH_REQUIRED' if the session is missing or
 * expired so the client can re-prompt sign-in.
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
    return fn.apply(null, args || []);
  } finally {
    _REQUEST_EMAIL = null;
  }
}
