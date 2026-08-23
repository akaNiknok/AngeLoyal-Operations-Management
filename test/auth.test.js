// ============================================================
//  Auth.gs — sessions and the RPC gateway.
//  The web app can't identify cross-domain visitors via Session, so
//  identity comes from a verified Google ID token, is held in a
//  server session, and is threaded through rpc(). These tests lock
//  the session lifecycle, the identity-scoping that makes RBAC work,
//  and the gateway allowlist. Sign-in itself (token verification,
//  forged tokens, the doPost envelope) lives in api.test.js.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet, emptySheet } = require('./fixtures');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

// Fakes Google's tokeninfo endpoint: maps an ID token -> identity claims.
// Anything not in the map is a token Google won't vouch for.
function tokeninfoFetch(tokens) {
  return (url) => {
    const m = /tokeninfo\?id_token=([^&]*)/.exec(String(url));
    if (!m) return { code: 404, body: '' };
    const claims = tokens[decodeURIComponent(m[1])];
    if (!claims) return { code: 400, body: JSON.stringify({ error: 'invalid_token' }) };
    return {
      code: 200,
      body: JSON.stringify(Object.assign({ aud: CLIENT_ID, email_verified: true }, claims)),
    };
  };
}

function authEnv(tokens, extra = {}) {
  return makeEnv({
    // All master sheets getBootData reads, so an authorized boot succeeds.
    sheets: {
      Users: usersSheet(),
      Employees: emptySheet('Employees'),
      Trucks: emptySheet('Trucks'),
      'Waybill Prefixes': emptySheet('Waybill Prefixes'),
      Outlets: emptySheet('Outlets'),
      'Default Assignments': emptySheet('Default Assignments'),
      'Billing Categories': emptySheet('Billing Categories'),
      'Audit Log': emptySheet('Audit Log'),
    },
    scriptProperties: { OAUTH_CLIENT_ID: CLIENT_ID },
    fetch: tokeninfoFetch(tokens),
    // Deliberately NOT in the Users domain — proves identity comes from the
    // signed-in token, not Session.getActiveUser().
    userEmail: 'unknown',
    ...extra,
  });
}

// Signs in and returns the app session token.
function signIn(api, idToken) {
  return api.login(idToken).sessionToken;
}

test('a signed-in OMS user gets a session that carries their identity into rpc', () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com', name: 'Ada Admin' } });
  const token = signIn(api, 'tok-admin');
  assert.ok(token, 'a session token is issued');

  const boot = api.rpc(token, 'getBootData', []);
  assert.equal(boot.session.email, 'admin@angeloyal.com');
  assert.equal(boot.session.role, 'Admin');
  assert.ok(Array.isArray(boot.employees), 'an authorized user gets master data');
});

test('a verified account not in Users gets a session but no role/data', () => {
  const { api } = authEnv({ 'tok-stranger': { email: 'stranger@gmail.com' } });
  const token = signIn(api, 'tok-stranger');
  assert.ok(token);
  const boot = api.rpc(token, 'getBootData', []);
  assert.equal(boot.session.role, null);
  assert.equal(boot.employees, undefined, 'no master data leaks to an unauthorized account');
});

test('rpc requires a valid session', () => {
  const { api } = authEnv({});
  assert.throws(() => api.rpc('not-a-real-token', 'getBootData', []), /AUTH_REQUIRED/);
});

test('rpc only dispatches allow-listed functions', () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = signIn(api, 'tok-admin');
  // Private helpers and unexposed readers must be unreachable from the client.
  assert.throws(() => api.rpc(token, '_devDump', [{}]), /Unknown action/);
  assert.throws(() => api.rpc(token, 'getEmployees', []), /Unknown action/);
  assert.throws(() => api.rpc(token, '_createSession', ['x', 'y']), /Unknown action/);
});

test('logout invalidates the session', () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = signIn(api, 'tok-admin');
  // The client reaches logout through the same gateway as everything else.
  assert.equal(api.rpc(token, 'logout', [token]).success, true);
  assert.throws(() => api.rpc(token, 'getBootData', []), /AUTH_REQUIRED/);
});

test('rpc clears the request identity after dispatch (no leakage between calls)', () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = signIn(api, 'tok-admin');
  api.rpc(token, 'getBootData', []);
  // With no rpc in flight, identity falls back to Session (here: 'unknown').
  assert.equal(api._getCurrentUserEmail(), 'unknown');
});
