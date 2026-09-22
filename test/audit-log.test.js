// ============================================================
//  The Audit Log panel's reader. The log is append-only and only
//  grows, so every read is bounded by a date range and a row cap.
//  These tests pin the window, the paging and the Admin gate.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { usersSheet, EMAIL } = require('./fixtures');

/** n audit rows, one per day back from 2026-09-23. */
function rows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ts: `2026-09-${String(23 - i).padStart(2, '0')} 08:0${i % 10}:00`,
    user_email: i % 2 ? EMAIL.Dispatcher : EMAIL.Admin,
    action: i % 2 ? 'TRIP_CREATE' : 'OUTLET_EDIT',
    detail: `row ${i + 1}`,
    table_name: i % 2 ? 'trips' : 'outlets',
    row_id: i + 1,
    old_value: '',
    new_value: `v${i + 1}`,
  }));
}

function env(email = EMAIL.Admin, n = 10) {
  return makeEnv({ sheets: { Users: usersSheet() }, tables: { audit_log: rows(n) }, userEmail: email });
}

test('a page comes back newest first, in the client shape', async () => {
  const { api } = env();
  const r = await api.getAuditLog({ from: '9/1/2026', to: '9/23/2026' });

  assert.equal(r.entries.length, 10);
  assert.equal(r.hasMore, false);
  assert.equal(r.entries[0].timestamp, '9/23/2026 08:00:00');
  assert.equal(r.entries[0].action, 'OUTLET_EDIT');
  assert.equal(r.entries[9].timestamp, '9/14/2026 08:09:00');
});

test('both ends of the range are inclusive', async () => {
  const { api } = env();
  const r = await api.getAuditLog({ from: '9/22/2026', to: '9/23/2026' });

  assert.deepEqual(r.entries.map((e) => e.timestamp), ['9/23/2026 08:00:00', '9/22/2026 08:01:00']);
});

test('a page is capped and says whether another one follows', async () => {
  const { api } = env(EMAIL.Admin, 10);
  const first = await api.getAuditLog({ from: '9/1/2026', to: '9/23/2026', limit: 4 });
  assert.equal(first.entries.length, 4);
  assert.equal(first.hasMore, true);

  const last = await api.getAuditLog({ from: '9/1/2026', to: '9/23/2026', limit: 4, offset: 8 });
  assert.equal(last.entries.length, 2);
  assert.equal(last.hasMore, false);
  assert.equal(last.entries[0].detail, 'row 9');
});

test('the search box matches any readable column', async () => {
  const { api } = env();
  const range = { from: '9/1/2026', to: '9/23/2026' };

  assert.equal((await api.getAuditLog({ ...range, search: 'TRIP_CREATE' })).entries.length, 5);
  assert.equal((await api.getAuditLog({ ...range, search: 'outlets' })).entries.length, 5);
  assert.equal((await api.getAuditLog({ ...range, search: EMAIL.Dispatcher })).entries.length, 5);
  assert.equal((await api.getAuditLog({ ...range, search: 'row 7' })).entries.length, 1);
  assert.equal((await api.getAuditLog({ ...range, search: 'nothing here' })).entries.length, 0);
});

test('only an Admin can read the log', async () => {
  for (const who of [EMAIL.Dispatcher, EMAIL.Payroll, EMAIL.Viewer, EMAIL.Unknown]) {
    await assert.rejects(() => env(who).api.getAuditLog({}), /Access denied/, who);
  }
});

// ── The panel (web/audit.js) ──────────────────────────────────
// The harness has no layout, so this covers the escaping and the
// paging state — what would be wrong, not what would look wrong.

const { loadWeb, fakeEl } = require('./webharness');

function loadPanel() {
  const els = {};
  const document = {
    createElement: (t) => fakeEl(t),
    getElementById: (id) => (els[id] = els[id] || fakeEl()),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    head: { appendChild() {} },
    body: fakeEl('body'),
  };
  const { sandbox } = loadWeb(
    ['config.js', 'core.js', 'dispatch.js', 'export.js', 'crewboard.js',
     'import.js', 'roster.js', 'masters.js', 'billing.js', 'billing-matrix.js', 'audit.js'],
    { document },
    'globalThis.__setPage = (offset, hasMore) => { auditOffset = offset; auditHasMore = hasMore; };'
  );
  return { ui: sandbox, els };
}

const entry = (o) => Object.assign({
  id: 1, timestamp: '9/23/2026 08:00:00', userEmail: 'admin@angeloyal.com',
  action: 'OUTLET_EDIT', detail: 'renamed', tableName: 'outlets', rowId: 4,
  oldValue: 'Old', newValue: 'New',
}, o);

test('a detail that carries HTML is escaped, not rendered', () => {
  const { ui, els } = loadPanel();
  ui.__setPage(0, false);
  ui.renderAudit([entry({ detail: '<img src=x onerror=alert(1)>' })]);

  assert.ok(!/<img/.test(els['au-tbody'].innerHTML));
  assert.ok(els['au-tbody'].innerHTML.includes('&lt;img'));
});

test('a long value is cut in the cell and kept whole in the tooltip', () => {
  const { ui, els } = loadPanel();
  ui.__setPage(0, false);
  const long = 'x'.repeat(200);
  ui.renderAudit([entry({ newValue: long })]);

  assert.ok(els['au-tbody'].innerHTML.includes(`title="${long}"`));
  assert.ok(els['au-tbody'].innerHTML.includes('x'.repeat(60) + '…'));
});

test('the paging buttons follow the page the server answered', () => {
  const { ui, els } = loadPanel();

  ui.__setPage(0, true);
  ui.renderAudit([entry({})]);
  assert.equal(els['au-prev'].disabled, true);
  assert.equal(els['au-next'].disabled, false);

  ui.__setPage(200, false);
  ui.renderAudit([entry({})]);
  assert.equal(els['au-prev'].disabled, false);
  assert.equal(els['au-next'].disabled, true);
  assert.equal(els['au-count'].textContent, '201–201 of 201');
});

test('an empty page says so instead of showing a range', () => {
  const { ui, els } = loadPanel();
  ui.__setPage(0, false);
  ui.renderAudit([]);

  assert.equal(els['au-count'].textContent, 'No entries');
  assert.equal(els['au-tbody'].innerHTML, '');
});
