// ============================================================
//  web/whatsnew.js — the "What's new?" release-notes dialog.
//  Two things need locking down: the once-per-release trigger
//  (it must not nag on every load, and must fire for someone who
//  has never seen it), and the Markdown renderer, which builds
//  HTML by hand and so must escape its input.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the module the same way the import tests load theirs. Its top-level
// code touches nothing outside itself, so no stubs are needed.
function loadWhatsNew() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'whatsnew.js'), 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${src}\n;globalThis.__api = { shouldShowWhatsNew, renderNotes, formatReleaseDate, escapeHtml };`,
    sandbox,
    { filename: 'web/whatsnew.js' },
  );
  return sandbox.__api;
}

test('the dialog opens for a first-time user and after a new release only', () => {
  const { shouldShowWhatsNew } = loadWhatsNew();
  // Never seen anything -> first sign-in.
  assert.equal(shouldShowWhatsNew('v1.3.0', null), true);
  assert.equal(shouldShowWhatsNew('v1.3.0', undefined), true);
  // Seen this exact release -> stay out of the way.
  assert.equal(shouldShowWhatsNew('v1.3.0', 'v1.3.0'), false);
  // A newer release shipped since.
  assert.equal(shouldShowWhatsNew('v1.4.0', 'v1.3.0'), true);
  // No changelog at all -> nothing to show.
  assert.equal(shouldShowWhatsNew('', 'v1.3.0'), false);
  assert.equal(shouldShowWhatsNew(null, null), false);
});

test('renderNotes escapes HTML in the release body', () => {
  const { renderNotes } = loadWhatsNew();
  const html = renderNotes('- <img src=x onerror="alert(1)"> & "quoted"');
  assert.ok(!html.includes('<img'), 'no raw tag survives');
  assert.ok(!html.includes('onerror="'), 'no raw attribute survives');
  assert.ok(html.includes('&lt;img'), 'it is shown as text instead');
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&quot;quoted&quot;'));
});

test('renderNotes handles the Markdown subset the notes are written in', () => {
  const { renderNotes } = loadWhatsNew();
  const html = renderNotes(
    ["### What's new", '', '- **Faster** loading', '- Uses `changelog.json`', '', 'Nothing else moved.'].join('\n'),
  );
  assert.ok(html.includes("<h4>What's new</h4>"), 'heading');
  assert.ok(html.includes('<ul><li><strong>Faster</strong> loading</li>'), 'bold inside a bullet');
  assert.ok(html.includes('<code>changelog.json</code>'), 'inline code');
  assert.ok(html.includes('</ul><p>Nothing else moved.</p>'), 'list closes before the paragraph');
});

test('renderNotes copes with an empty or list-only body', () => {
  const { renderNotes } = loadWhatsNew();
  assert.equal(renderNotes(''), '');
  // A list that runs to the end of the body still gets closed.
  assert.equal(renderNotes('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
});

test('release dates render for a reader, not a machine', () => {
  const { formatReleaseDate } = loadWhatsNew();
  assert.equal(formatReleaseDate('2026-08-23'), '23 Aug 2026');
  assert.equal(formatReleaseDate('2026-01-05'), '5 Jan 2026');
  // Anything unexpected passes through rather than rendering "NaN undefined".
  assert.equal(formatReleaseDate('sometime'), 'sometime');
});

test('the shipped changelog.json is valid and starts at v1.3.0', () => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'changelog.json'), 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.releases) && data.releases.length, 'has releases');
  const oldest = data.releases[data.releases.length - 1];
  assert.equal(oldest.version, 'v1.3.0');
  data.releases.forEach((r) => {
    assert.match(r.version, /^v\d+\.\d+\.\d+$/, `${r.version} is a version tag`);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} has a plain date`);
    assert.ok(r.body && r.body.trim(), `${r.version} has notes`);
  });
});
