// ============================================================
//  web/core.js — the client transport (call / callBackend).
//
//  Three things here are load-bearing and easy to break silently:
//   1. The POST must stay a *simple* CORS request — a plain string body
//      and NO headers. Adding a Content-Type triggers a preflight, and
//      Apps Script cannot serve OPTIONS, so every call in the app dies
//      before it is sent (see CLAUDE.md).
//   2. doPost never throws, so failures arrive as { ok:false, error }
//      in the body and have to become promise rejections here.
//   3. An expired session must re-prompt sign-in and run neither the
//      success nor the failure handler.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb } = require('./webharness');

const EXEC = 'https://script.google.com/macros/s/TEST/exec';

/** Loads core.js with fetch stubbed to reply with `payload`. */
function loadTransport(payload, { reject } = {}) {
  const seen = { requests: [], expired: 0 };
  const stubs = {
    EXEC_URL: EXEC,
    fetch: (url, init) => {
      seen.requests.push({ url, init });
      if (reject) return Promise.reject(reject);
      return Promise.resolve({ json: () => Promise.resolve(payload) });
    },
  };
  const { sandbox } = loadWeb(['core.js'], stubs,
    // sessionToken is a top-level `let`, so reach it through an exposed setter.
    'globalThis.__setToken = (t) => { sessionToken = t; };' +
    'globalThis.__origExpired = handleSessionExpired;');
  return { ui: sandbox, seen };
}

test('a call posts token, fn and args as a headerless plain-string body', async () => {
  const { ui, seen } = loadTransport({ ok: true, data: { trips: [] } });
  ui.__setToken('sess-123');

  const data = await ui.call('getDispatchBoardData', '6/17/2026');

  assert.equal(seen.requests.length, 1);
  const { url, init } = seen.requests[0];
  assert.equal(url, EXEC);
  assert.equal(init.method, 'POST');

  // The whole point: no headers at all, or the preflight kills the call.
  assert.equal(init.headers, undefined);
  assert.equal(typeof init.body, 'string');

  assert.deepEqual(JSON.parse(init.body), {
    token: 'sess-123',
    fn: 'getDispatchBoardData',
    args: ['6/17/2026'],
  });
  // resolves with payload.data, not the envelope
  assert.deepEqual(data, { trips: [] });
});

test('a call with no arguments still sends an empty args array', async () => {
  const { ui, seen } = loadTransport({ ok: true, data: null });
  await ui.call('getBootData');
  assert.deepEqual(JSON.parse(seen.requests[0].init.body).args, []);
});

test('an { ok:false } body becomes a rejection carrying the server error', async () => {
  const { ui } = loadTransport({ ok: false, error: 'Access denied. Your role (Viewer) ...' });
  await assert.rejects(
    () => ui.call('createTrip', {}),
    /Access denied/,
  );
});

test('a malformed body still rejects rather than resolving with junk', async () => {
  const { ui } = loadTransport({ nonsense: true });
  await assert.rejects(() => ui.call('getBootData'), /Request failed/);
});

test('a network failure rejects', async () => {
  const { ui } = loadTransport(null, { reject: new Error('Failed to fetch') });
  await assert.rejects(() => ui.call('getBootData'), /Failed to fetch/);
});

test('an expired session re-prompts sign-in and settles neither handler', async () => {
  const { ui } = loadTransport({ ok: false, error: 'AUTH_REQUIRED' });

  let expired = 0;
  ui.handleSessionExpired = () => { expired++; };

  let settled = 'no';
  ui.call('getBootData').then(
    () => { settled = 'resolved'; },
    () => { settled = 'rejected'; },
  );

  // give the promise chain every chance to settle
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(expired, 1, 'sign-in should be re-prompted exactly once');
  assert.equal(settled, 'no', 'a cancelled call must run neither handler');
});

test('toastError surfaces the message and stops the spinner', () => {
  const toasts = [];
  const sync = [];
  const { sandbox } = loadWeb(['core.js'], { EXEC_URL: EXEC });

  // core.js declares its own showToast/setSyncing, so the stubs have to land
  // after the script has run — the identifiers resolve at call time.
  sandbox.showToast = (msg, kind) => toasts.push({ msg, kind });
  sandbox.setSyncing = (on) => sync.push(on);

  sandbox.toastError(new Error('Boom'));
  assert.deepEqual(toasts, [{ msg: 'Boom', kind: 'error' }]);
  assert.deepEqual(sync, [false]);

  sandbox.toastError(undefined);
  assert.equal(toasts[1].msg, 'Something went wrong');
});
