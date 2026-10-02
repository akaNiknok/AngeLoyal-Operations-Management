// ============================================================
//  The URL hash (web/core.js): it names the open panel and its
//  filters, so a reload or a shared link opens the same view.
//  Pins the round trip and the role check on a hand-made link.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb, fakeEl } = require('./webharness');

function load(hash, navClass = 'nav-btn') {
  const els = {};
  const get = (id) => (id.startsWith('nav-') && id !== 'nav-billing' ? null
    : (els[id] = els[id] || fakeEl(id.startsWith('bl-o') ? 'select' : 'input')));
  get('nav-billing').className = navClass;
  // A select has no options until its panel opens.
  const origin = get('bl-origin');
  origin.options = [];
  origin.add = (o) => origin.options.push(o);

  let active = null;
  const urls = [];
  const document = {
    createElement: (t) => fakeEl(t),
    getElementById: get,
    querySelector: (sel) => (sel === '.panel.active' && active ? { id: 'panel-' + active } : null),
    querySelectorAll: () => [],
    addEventListener() {},
    head: { appendChild() {} },
    body: fakeEl('body'),
  };
  const { sandbox } = loadWeb(['config.js', 'core.js', 'billing.js'], {
    document,
    location: { hostname: 'localhost', hash },
    history: { replaceState: (_s, _t, url) => urls.push(url) },
    URLSearchParams,
    Option: function (text, value) { this.text = text; this.value = value; },
  });
  sandbox.switchPanel = (name) => { active = name; sandbox.syncHash(); };
  return { ui: sandbox, els, urls, active: () => active };
}

test('a link opens its panel with its filters and writes the same hash back', () => {
  const hash = '#billing?bl-from=2026-09-28&bl-to=2026-10-03&bl-origin=TANZA&status=deferred';
  const { ui, els, urls, active } = load(hash);

  assert.equal(ui.applyHash(), true);
  assert.equal(active(), 'billing');
  assert.equal(els['bl-from'].value, '2026-09-28');
  assert.equal(els['bl-origin'].value, 'TANZA');
  assert.equal(els['bl-origin'].options.length, 1, 'a placeholder option holds the value');
  assert.deepEqual(urls, [hash]);
});

test('a panel the role cannot open falls back to the board', () => {
  const { ui, active } = load('#billing?bl-from=2026-09-28', 'nav-btn payroll-only');
  assert.equal(ui.applyHash(), false);
  assert.equal(active(), null);
});

test('an unknown panel or an empty hash opens nothing', () => {
  assert.equal(load('#nope').ui.applyHash(), false);
  assert.equal(load('').ui.applyHash(), false);
});
