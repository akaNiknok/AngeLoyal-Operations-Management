// ============================================================
//  web/functions/api.js — the JSON envelope the frontend talks to.
//  Same origin now, so no CORS, but two things still matter: the
//  ID token arrives from the browser and must be verified with
//  Google, and the function must never throw — a 500 has no body
//  the client can act on, so failures ride in { ok:false, error }.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet, emptySheet } = require('./fixtures');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function tokeninfoFetch(tokens) {
  return async (url) => {
    const m = /tokeninfo\?id_token=([^&]*)/.exec(String(url));
    const claims = m && tokens[decodeURIComponent(m[1])];
    if (!claims) return { status: 400, json: async () => ({ error: 'invalid_token' }) };
    return { status: 200, json: async () => ({ aud: CLIENT_ID, email_verified: true, ...claims }) };
  };
}

function apiEnv(tokens) {
  return makeEnv({
    sheets: { Users: usersSheet(), Employees: emptySheet('Employees') },
    oauthClientId: CLIENT_ID,
    fetch: tokeninfoFetch(tokens),
    userEmail: 'unknown',
  });
}

test('login verifies the ID token with Google and opens a session that works for a call', async () => {
  const { api } = apiEnv({ 'tok-admin': { email: 'admin@angeloyal.com', name: 'Ada Admin' } });

  const res = await api.post({ fn: 'login', idToken: 'tok-admin' });
  assert.equal(res.ok, true);
  assert.equal(res.data.success, true);
  assert.ok(res.data.sessionToken);

  const boot = await api.post({ token: res.data.sessionToken, fn: 'getBootData', args: [] });
  assert.equal(boot.ok, true);
  assert.equal(boot.data.session.email, 'admin@angeloyal.com');
  assert.equal(boot.data.session.role, 'Admin');
});

test('a forged token gets AUTH_FAILED inside an ok envelope, and no session', async () => {
  const { api } = apiEnv({});
  const res = await api.post({ fn: 'login', idToken: 'never-issued' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { success: false, error: 'AUTH_FAILED' });
});

test('a missing/expired session is reported as AUTH_REQUIRED instead of throwing', async () => {
  const { api } = apiEnv({});
  const res = await api.post({ token: 'not-a-real-token', fn: 'getBootData', args: [] });
  assert.deepEqual(res, { ok: false, error: 'AUTH_REQUIRED' });
});

test('functions outside the allow-list are refused', async () => {
  const { api } = apiEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = (await api.post({ fn: 'login', idToken: 'tok-admin' })).data.sessionToken;
  for (const fn of ['_resolveSession', 'getEmployees', 'rpc']) {
    const res = await api.post({ token, fn, args: [{}] });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown action/);
  }
});

test('a malformed or empty body is BAD_REQUEST, never a crash', async () => {
  const { api } = apiEnv({});
  assert.deepEqual(await api.post('not json at all'), { ok: false, error: 'BAD_REQUEST' });
  assert.deepEqual(await api.post('null'), { ok: false, error: 'BAD_REQUEST' });
  assert.equal((await api.post({})).ok, false);
});
