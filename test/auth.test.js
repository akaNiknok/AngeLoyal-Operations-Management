// ============================================================
//  server/auth.js — sessions and the rpc gateway.
//  Identity comes from a verified Google ID token, is held in the
//  sessions table, and is threaded through rpc() via ctx.js. These
//  tests lock the session lifecycle, the identity scoping that
//  makes RBAC work (including two requests in flight at once), and
//  the gateway allow-list. The HTTP envelope lives in api.test.js.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump } = require('./harness');
const { usersSheet, emptySheet } = require('./fixtures');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

// Fakes Google's tokeninfo endpoint: maps an ID token -> identity claims.
// Anything not in the map is a token Google won't vouch for.
function tokeninfoFetch(tokens) {
  return async (url) => {
    const m = /tokeninfo\?id_token=([^&]*)/.exec(String(url));
    const claims = m && tokens[decodeURIComponent(m[1])];
    if (!claims) return { status: 400, json: async () => ({ error: 'invalid_token' }) };
    return { status: 200, json: async () => ({ aud: CLIENT_ID, email_verified: true, ...claims }) };
  };
}

function authEnv(tokens, extra = {}) {
  return makeEnv({
    sheets: { Users: usersSheet(), Employees: emptySheet('Employees'), 'Audit Log': emptySheet('Audit Log') },
    oauthClientId: CLIENT_ID,
    fetch: tokeninfoFetch(tokens),
    // Deliberately NOT a Users email — identity has to come from the token.
    userEmail: 'unknown',
    ...extra,
  });
}

async function signIn(api, idToken) {
  return (await api.login(idToken)).sessionToken;
}

test('a signed-in OMS user gets a session that carries their identity into rpc', async () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com', name: 'Ada Admin' } });
  const token = await signIn(api, 'tok-admin');
  assert.ok(token, 'a session token is issued');

  const boot = await api.rpc(token, 'getBootData', []);
  assert.equal(boot.session.email, 'admin@angeloyal.com');
  assert.equal(boot.session.role, 'Admin');
  assert.ok(Array.isArray(boot.employees), 'an authorized user gets master data');
});

test('a verified account not in Users gets a session but no role/data', async () => {
  const { api } = authEnv({ 'tok-stranger': { email: 'stranger@gmail.com' } });
  const token = await signIn(api, 'tok-stranger');
  assert.ok(token);
  const boot = await api.rpc(token, 'getBootData', []);
  assert.equal(boot.session.role, null);
  assert.equal(boot.employees, undefined, 'no master data leaks to an unauthorized account');
});

test('login REJECTS a forged token, a foreign audience, an unverified email, and a blank', async () => {
  const { api } = authEnv({
    'tok-evil': { email: 'admin@angeloyal.com', aud: 'someone-else.apps.googleusercontent.com' },
    'tok-unverified': { email: 'admin@angeloyal.com', email_verified: false },
  });
  // Decodes to a real admin — but tokeninfo never saw it. If this ever
  // passes, anyone can sign in as anyone.
  const forged = Buffer.from('{"alg":"none"}').toString('base64url') + '.' +
    Buffer.from(JSON.stringify({ email: 'admin@angeloyal.com', email_verified: true, aud: CLIENT_ID })).toString('base64url') + '.';
  for (const t of [forged, 'tok-evil', 'tok-unverified', '']) {
    const res = await api.login(t);
    assert.equal(res.success, false, `token ${t.slice(0, 12)} must be refused`);
    assert.equal(res.error, 'AUTH_FAILED');
    assert.equal(res.sessionToken, undefined);
  }
});

test('login records a LOGIN audit row attributed to the signing-in account', async () => {
  const { api, db } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  await api.login('tok-admin');
  const rows = dump(db, 'audit_log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'LOGIN');
  assert.equal(rows[0].user_email, 'admin@angeloyal.com');
  assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('rpc requires a valid, unexpired session', async () => {
  const { api, raw } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  await assert.rejects(() => api.rpc('not-a-real-token', 'getBootData', []), /AUTH_REQUIRED/);

  const token = await signIn(api, 'tok-admin');
  raw.prepare(`UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE token = ?`).run(token);
  await assert.rejects(() => api.rpc(token, 'getBootData', []), /AUTH_REQUIRED/);
});

test('rpc only dispatches allow-listed functions', async () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = await signIn(api, 'tok-admin');
  // Private helpers and unexposed readers must be unreachable from the client.
  for (const fn of ['_resolveSession', 'getEmployees', 'currentUser', 'rowById', 'constructor']) {
    await assert.rejects(() => api.rpc(token, fn, []), /Unknown action/, fn);
  }
  // Allow-listed but not yet ported (Phase 1) is still "unknown", never a crash.
  await assert.rejects(() => api.rpc(token, 'createTrip', [{}]), /Unknown action/);
});

test('logout invalidates the session', async () => {
  const { api } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = await signIn(api, 'tok-admin');
  assert.equal((await api.rpc(token, 'logout', [token])).success, true);
  await assert.rejects(() => api.rpc(token, 'getBootData', []), /AUTH_REQUIRED/);
});

test('rpc scopes identity to the call: nothing leaks after it, nor between concurrent calls', async () => {
  const { api } = authEnv({
    'tok-admin': { email: 'admin@angeloyal.com' },
    'tok-viewer': { email: 'viewer@angeloyal.com' },
  });
  const admin = await signIn(api, 'tok-admin');
  const viewer = await signIn(api, 'tok-viewer');

  // Two requests in flight at once, interleaving on every await, must each
  // see their own user — a module-level "current email" would cross them.
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    api.rpc(i % 2 ? admin : viewer, 'getBootData', []).then((b) => b.session.role)));
  assert.deepEqual(results, ['Viewer', 'Admin', 'Viewer', 'Admin', 'Viewer', 'Admin', 'Viewer', 'Admin', 'Viewer', 'Admin']);

  // With no rpc in flight, the identity is the context's own (here: none).
  assert.equal(api.currentEmail(), 'unknown');
});

test('sessions live 12 hours and expired rows are swept on the next sign-in', async () => {
  const { api, raw } = authEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const t1 = await signIn(api, 'tok-admin');
  const row = raw.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(t1);
  const hours = (Date.parse(row.expires_at.replace(' ', 'T') + '+08:00') - Date.now()) / 3600000;
  assert.ok(hours > 11.9 && hours <= 12, `TTL is ~12h, got ${hours}`);

  raw.prepare(`UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE token = ?`).run(t1);
  await signIn(api, 'tok-admin');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1, 'the dead session is gone');
});
