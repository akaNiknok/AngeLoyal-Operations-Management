// ============================================================
//  Auth.gs — Google sign-in (OAuth redirect), sessions, RPC gateway
//  The web app can't identify cross-domain visitors via Session, so
//  identity comes from a server-side OAuth code exchange, is held in
//  a server session, and is threaded through rpc(). These tests lock
//  that flow: login-URL construction, the callback/token exchange,
//  the identity-scoping that makes RBAC work, and the gateway allowlist.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet, emptySheet } = require('./fixtures');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

// Builds a JWT-shaped ID token (header.payload.sig) with base64url claims —
// the shape Google's token endpoint returns and _identityFromIdToken decodes.
function makeIdToken(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(claims) + '.' + 'sig';
}

// Fakes Google's token endpoint: maps an auth code -> identity claims.
function codeFetch(codes) {
  return (url, params) => {
    if (String(url).indexOf('oauth2.googleapis.com/token') === -1) {
      return { code: 404, body: '' };
    }
    const code = params && params.payload && params.payload.code;
    const claims = codes[code];
    if (!claims) return { code: 400, body: JSON.stringify({ error: 'invalid_grant' }) };
    const full = Object.assign({ aud: CLIENT_ID, email_verified: true }, claims);
    return { code: 200, body: JSON.stringify({ id_token: makeIdToken(full) }) };
  };
}

function authEnv(codes, extra = {}) {
  return makeEnv({
    // All master sheets getBootData reads, so an authorized boot succeeds.
    sheets: {
      Users: usersSheet(),
      Employees: emptySheet('Employees'),
      Trucks: emptySheet('Trucks'),
      'Employee-Truck Assignment': emptySheet('Employee-Truck Assignment'),
      'Waybill Prefixes': emptySheet('Waybill Prefixes'),
      Outlets: emptySheet('Outlets'),
      'Default Assignments': emptySheet('Default Assignments'),
      'Billing Categories': emptySheet('Billing Categories'),
      'Audit Log': emptySheet('Audit Log'),
    },
    scriptProperties: { OAUTH_CLIENT_ID: CLIENT_ID, OAUTH_CLIENT_SECRET: 'shh-secret' },
    fetch: codeFetch(codes),
    // Deliberately NOT in the Users domain — proves identity comes from the
    // OAuth sign-in, not Session.getActiveUser().
    userEmail: 'unknown',
    ...extra,
  });
}

// Drives a full sign-in: build the login URL (which caches the CSRF state),
// then run the callback with that state + a chosen auth code.
function signIn(api, authCode) {
  const url = api.getLoginUrl().url;
  const state = decodeURIComponent(/[?&]state=([^&]+)/.exec(url)[1]);
  return api._handleOAuthCallback(authCode, state);
}

test('getLoginUrl builds a Google consent URL with our client and a CSRF state', () => {
  const { api } = authEnv({});
  const url = api.getLoginUrl().url;
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(url.includes('client_id=' + encodeURIComponent(CLIENT_ID)));
  assert.ok(url.includes('response_type=code'));
  assert.ok(/[?&]state=/.test(url));
});

test('getLoginUrl returns an empty url when sign-in is not configured', () => {
  const { api } = makeEnv({ scriptProperties: {} });
  assert.equal(api.getLoginUrl().url, '');
});

test('the OAuth callback exchanges the code and opens a session for an OMS user', () => {
  const { api } = authEnv({ 'code-admin': { email: 'admin@angeloyal.com', name: 'Ada Admin' } });
  const token = signIn(api, 'code-admin');
  assert.ok(token, 'a session token is issued');

  const boot = api.rpc(token, 'getBootData', []);
  assert.equal(boot.session.email, 'admin@angeloyal.com');
  assert.equal(boot.session.role, 'Admin');
  assert.ok(Array.isArray(boot.employees), 'an authorized user gets master data');
});

test('a verified account not in Users gets a session but no role/data', () => {
  const { api } = authEnv({ 'code-stranger': { email: 'stranger@gmail.com' } });
  const token = signIn(api, 'code-stranger');
  assert.ok(token);
  const boot = api.rpc(token, 'getBootData', []);
  assert.equal(boot.session.role, null);
  assert.equal(boot.employees, undefined, 'no master data leaks to an unauthorized account');
});

test('the callback rejects an unknown / replayed state', () => {
  const { api } = authEnv({ 'code-admin': { email: 'admin@angeloyal.com' } });
  // No getLoginUrl() call → the state was never cached.
  assert.equal(api._handleOAuthCallback('code-admin', 'never-issued'), null);

  // A state is single-use: the second callback with the same state fails.
  const url = api.getLoginUrl().url;
  const state = decodeURIComponent(/[?&]state=([^&]+)/.exec(url)[1]);
  assert.ok(api._handleOAuthCallback('code-admin', state));
  assert.equal(api._handleOAuthCallback('code-admin', state), null);
});

test('the callback rejects a token minted for a different client (aud mismatch)', () => {
  const { api } = authEnv({ 'code-evil': { email: 'admin@angeloyal.com', aud: 'someone-else.apps.googleusercontent.com' } });
  assert.equal(signIn(api, 'code-evil'), null);
});

test('the callback rejects an unverified email and a failed code exchange', () => {
  const { api } = authEnv({ 'code-unverified': { email: 'admin@angeloyal.com', email_verified: false } });
  assert.equal(signIn(api, 'code-unverified'), null);
  assert.equal(signIn(api, 'never-issued-code'), null);
});

test('rpc requires a valid session', () => {
  const { api } = authEnv({});
  assert.throws(() => api.rpc('not-a-real-token', 'getBootData', []), /AUTH_REQUIRED/);
});

test('rpc only dispatches allow-listed functions', () => {
  const { api } = authEnv({ 'code-admin': { email: 'admin@angeloyal.com' } });
  const token = signIn(api, 'code-admin');
  // Private helpers and unexposed readers must be unreachable from the client.
  assert.throws(() => api.rpc(token, '_devDump', [{}]), /Unknown action/);
  assert.throws(() => api.rpc(token, 'getEmployees', []), /Unknown action/);
});

test('logout invalidates the session', () => {
  const { api } = authEnv({ 'code-admin': { email: 'admin@angeloyal.com' } });
  const token = signIn(api, 'code-admin');
  assert.equal(api.logout(token).success, true);
  assert.throws(() => api.rpc(token, 'getBootData', []), /AUTH_REQUIRED/);
});

test('rpc clears the request identity after dispatch (no leakage between calls)', () => {
  const { api } = authEnv({ 'code-admin': { email: 'admin@angeloyal.com' } });
  const token = signIn(api, 'code-admin');
  api.rpc(token, 'getBootData', []);
  // With no rpc in flight, identity falls back to Session (here: 'unknown').
  assert.equal(api._getCurrentUserEmail(), 'unknown');
});
