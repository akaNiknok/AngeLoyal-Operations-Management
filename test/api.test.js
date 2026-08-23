// ============================================================
//  Code.gs doPost + Auth.gs login() — the JSON API the Cloudflare
//  Pages frontend talks to. Two things matter here and both are
//  security-shaped: the ID token now arrives from the *browser*, so
//  it must be verified with Google rather than merely decoded; and
//  doPost must never throw, because Apps Script would answer with an
//  HTML error page instead of a status code the client can read.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, dump, rowObject } = require('./harness');
const { usersSheet, emptySheet } = require('./fixtures');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

// Fakes Google's tokeninfo endpoint: it only answers 200 for tokens it
// recognises, which is exactly the signature check we're relying on.
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

function apiEnv(tokens) {
  return makeEnv({
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
    scriptProperties: { OAUTH_CLIENT_ID: CLIENT_ID, OAUTH_CLIENT_SECRET: 'shh-secret' },
    fetch: tokeninfoFetch(tokens),
    userEmail: 'unknown', // identity must come from the token, not Session
  });
}

// Drives doPost the way the browser does: a JSON string body.
function post(api, body) {
  return JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
}

test('login verifies the ID token with Google and opens a session', () => {
  const { api } = apiEnv({ 'tok-admin': { email: 'admin@angeloyal.com', name: 'Ada Admin' } });

  const res = post(api, { fn: 'login', idToken: 'tok-admin' });
  assert.equal(res.ok, true);
  assert.equal(res.data.success, true);
  assert.ok(res.data.sessionToken);

  // The session works for a real call, and carries the signed-in identity.
  const boot = post(api, { token: res.data.sessionToken, fn: 'getBootData', args: [] });
  assert.equal(boot.ok, true);
  assert.equal(boot.data.session.email, 'admin@angeloyal.com');
  assert.equal(boot.data.session.role, 'Admin');
});

test('login REJECTS a forged token that Google did not sign', () => {
  // The attacker's token decodes to a real admin — but tokeninfo never saw it.
  // If this test ever fails, anyone can sign in as anyone: the whole point of
  // verifying server-side rather than base64-decoding the payload.
  const { api } = apiEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const forged = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' +
    Buffer.from(JSON.stringify({
      email: 'admin@angeloyal.com', email_verified: true, aud: CLIENT_ID,
    })).toString('base64url') + '.';

  const res = post(api, { fn: 'login', idToken: forged });
  assert.equal(res.data.success, false);
  assert.equal(res.data.error, 'AUTH_FAILED');
  assert.equal(res.data.sessionToken, undefined, 'no session is minted for a forged token');
});

test('login rejects a token minted for another client, and an unverified email', () => {
  const { api } = apiEnv({
    'tok-evil': { email: 'admin@angeloyal.com', aud: 'someone-else.apps.googleusercontent.com' },
    'tok-unverified': { email: 'admin@angeloyal.com', email_verified: false },
  });
  assert.equal(post(api, { fn: 'login', idToken: 'tok-evil' }).data.success, false);
  assert.equal(post(api, { fn: 'login', idToken: 'tok-unverified' }).data.success, false);
  assert.equal(post(api, { fn: 'login', idToken: '' }).data.success, false);
});

test('login records a LOGIN audit row attributed to the signing-in account', () => {
  const { api, ss } = apiEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  post(api, { fn: 'login', idToken: 'tok-admin' });

  const { headers, rows } = dump(ss, 'Audit Log');
  const row = rowObject(headers, rows[rows.length - 1]);
  assert.equal(row.Action, 'LOGIN');
  assert.equal(row.User, 'admin@angeloyal.com');
});

test('doPost reports a missing/expired session as AUTH_REQUIRED instead of throwing', () => {
  const { api } = apiEnv({});
  const res = post(api, { token: 'not-a-real-token', fn: 'getBootData', args: [] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'AUTH_REQUIRED', 'the client re-prompts sign-in on this exact string');
});

test('doPost refuses functions outside the rpc allow-list', () => {
  const { api } = apiEnv({ 'tok-admin': { email: 'admin@angeloyal.com' } });
  const token = post(api, { fn: 'login', idToken: 'tok-admin' }).data.sessionToken;

  for (const fn of ['_devDump', 'getEmployees', '_createSession']) {
    const res = post(api, { token, fn, args: [{}] });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown action/);
  }
});

test('doPost survives a malformed body', () => {
  const { api } = apiEnv({});
  const raw = api.doPost({ postData: { contents: 'not json at all' } });
  assert.deepEqual(JSON.parse(raw.getContent()), { ok: false, error: 'BAD_REQUEST' });
  // An empty POST is a bad action, not a crash.
  assert.equal(JSON.parse(api.doPost({}).getContent()).ok, false);
});
