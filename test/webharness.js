// ============================================================
//  AngeLoyal OMS — Frontend test harness
//  Loads web/*.js into a Node `vm` sandbox with a stub DOM, the same
//  way test/harness.js loads the .gs backend with stub Apps Script
//  globals. The web/ files are plain classic scripts sharing one global
//  scope (no modules, no bundler — see CLAUDE.md), so we mirror that by
//  running them into one context in load order.
//
//  The DOM stub is deliberately dumb: it answers every property and
//  swallows every call. It is enough for logic that *reads* state and
//  decides what to do, which is what these tests are about — it is not
//  a rendering test and cannot become one. For anything that depends on
//  real layout (measured positions, animations actually playing), test
//  it in a browser; HANDOFF.md carries those steps.
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Strips vm-realm prototypes so assert/strict can compare by value. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A node that answers anything, so render code runs without a real document. */
function fakeEl(tag = 'div') {
  const self = {
    tagName: String(tag).toUpperCase(),
    value: '', checked: false, innerHTML: '', textContent: '', disabled: false,
    options: { length: 0 },
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    closest: () => null,
    focus() {}, blur() {}, click() {},
  };
  return new Proxy(self, {
    get(t, k) {
      if (k in t) return t[k];
      return () => undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/**
 * Runs the named web/ files into one sandbox, in the order given.
 *
 * @param {string[]} files      e.g. ['core.js', 'dispatch.js']
 * @param {Object}   [overrides] Sandbox globals to add or replace.
 * @param {string}   [expose]    Extra JS appended after the files, for lifting
 *                               `const` bindings onto globalThis (a top-level
 *                               const is a lexical binding, not a global).
 * @returns {{ sandbox: Object }}
 */
function loadWeb(files, overrides = {}, expose = '') {
  const sandbox = {
    console,
    document: {
      createElement: (t) => fakeEl(t),
      getElementById: () => fakeEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      head: { appendChild() {} },
      body: fakeEl('body'),
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hostname: 'localhost' },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: null }) }),
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
    EXEC_URL: '', OAUTH_CLIENT_ID: '',
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const f of files) {
    const p = path.join(ROOT, 'web', f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: `web/${f}` });
  }
  if (expose) vm.runInContext(expose, sandbox, { filename: 'expose' });
  return { sandbox };
}

module.exports = { loadWeb, fakeEl, plain };
