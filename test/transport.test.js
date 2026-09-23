// ============================================================
//  web/core.js — the client transport (call / callBackend).
//
//  Three things here are load-bearing and easy to break silently:
//   1. Every call is one POST of { token, fn, args } to /api on the
//      page's own origin (a Pages Function), as a plain string body.
//   2. The function never throws, so failures arrive as { ok:false,
//      error } in the body and have to become promise rejections here.
//   3. An expired session must re-prompt sign-in and run neither the
//      success nor the failure handler.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadWeb } = require('./webharness');

const API = '/api';

/** Loads core.js with fetch stubbed to reply with `payload`. */
function loadTransport(payload, { reject } = {}) {
  const seen = { requests: [], expired: 0 };
  const stubs = {
    API_URL: API,
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

test('a call posts token, fn and args as a plain-string body to /api', async () => {
  const { ui, seen } = loadTransport({ ok: true, data: { trips: [] } });
  ui.__setToken('sess-123');

  const data = await ui.call('getDispatchBoardData', '6/17/2026');

  assert.equal(seen.requests.length, 1);
  const { url, init } = seen.requests[0];
  assert.equal(url, API);
  assert.equal(init.method, 'POST');

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
  const { sandbox } = loadWeb(['core.js'], { API_URL: API });

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

// ── Sign-in and a lost connection ─────────────────────────────

/** Lets pending promise callbacks run — call() settles on a microtask. */
const tick = () => new Promise((r) => setImmediate(r));

// A sign-in can follow another account's sign-out in the same page. That
// account's unhidden menus and loaded tables live in the page, so the only
// reset that cannot miss one is a fresh page.
test('a sign-in stores the session and reloads the page', async () => {
  const store = {};
  let reloads = 0;
  const { sandbox: ui } = loadWeb(['core.js'], {
    API_URL: API,
    location: { hostname: 'localhost', reload: () => { reloads++; } },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: () => Promise.resolve({
      json: () => Promise.resolve({ ok: true, data: { success: true, sessionToken: 'sess-new' } }),
    }),
  });
  store.oms_boot = '{"session":{"role":"Admin"}}'; // the last account's cache

  ui.handleCredentialResponse({ credential: 'google-id-token' });
  await tick();

  assert.equal(reloads, 1);
  assert.equal(store.oms_session, 'sess-new');
  assert.equal('oms_boot' in store, false, 'the last account\'s boot cache must go');
});

// A dropped connection says nothing about whether the write landed, so the
// open panel re-reads the truth — whichever panel it is, not only the board.
test('a save lost to the network re-reads the open panel, not just the board', async () => {
  let ui;
  const seen = [];
  ({ sandbox: ui } = loadWeb(['core.js'], {
    API_URL: API,
    document: {
      createElement: () => ({}),
      getElementById: () => ({ classList: { toggle() {}, add() {}, remove() {} }, style: {} }),
      querySelector: (sel) => (sel === '.panel.active' ? { id: 'panel-billing' } : null),
      querySelectorAll: () => [],
      addEventListener() {},
      head: { appendChild() {} },
    },
    fetch: (url, init) => {
      const { fn } = JSON.parse(init.body);
      seen.push(fn);
      // A real fetch rejects with the page's own TypeError on a dropped line.
      if (fn === 'saveBillingLine') {
        const PageTypeError = vm.runInContext('TypeError', ui);
        return Promise.reject(new PageTypeError('Failed to fetch'));
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { session: { role: 'Admin' } } }) });
    },
  }));
  const applied = [];
  const opened = [];
  let reverted = 0;
  ui.applyBootData = (boot) => applied.push(boot);
  ui.switchPanel = (name) => opened.push(name);
  ui.loadDispatch = () => opened.push('dispatch-only');
  ui.showToast = () => {};

  ui.bgSave('saveBillingLine', [7, { mano: 100 }], { revert: () => { reverted++; } });
  await tick();
  await tick();

  assert.equal(reverted, 1);
  assert.deepEqual(seen, ['saveBillingLine', 'getBootData']);
  assert.equal(applied.length, 1);
  assert.deepEqual(opened, ['billing']);
});
