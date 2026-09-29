// ============================================================
//  Billing panel logic (web/billing.js, web/billing-matrix.js).
//  The harness has no layout, so this covers the arithmetic and
//  the ordering — the parts that would be wrong on paper, not
//  the parts that would merely look wrong on screen.
// ============================================================

// The office runs on Manila time, 8 hours ahead of UTC. A UTC date slip only
// shows in a zone east of UTC, so pin the zone the operators actually use.
// node:test runs each file in its own process, so this reaches no other file.
process.env.TZ = 'Asia/Manila';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb, fakeEl } = require('./webharness');

/** Lets pending promise callbacks run — call() settles on a microtask. */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Loads the billing scripts with a stub document that answers real values for
 * the filter inputs, so visibleBillingLines() has something to filter on.
 */
function loadBilling(fields = {}) {
  const values = Object.assign(
    { 'bl-status': 'all', 'bl-origin': '', 'bl-prefix': '', 'bl-from': '', 'bl-to': '' },
    fields
  );
  const els = {};
  const document = {
    createElement: (t) => fakeEl(t),
    getElementById: (id) => {
      if (!els[id]) {
        els[id] = fakeEl();
        if (values[id] !== undefined) els[id].value = values[id];
      }
      return els[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    head: { appendChild() {} },
    body: fakeEl('body'),
  };

  const { sandbox } = loadWeb(
    ['config.js', 'core.js', 'dispatch.js', 'export.js', 'crewboard.js',
     'import.js', 'roster.js', 'masters.js', 'billing.js', 'billing-matrix.js'],
    // URL and a full location: the print document resolves the letterhead.
    // The host Date: ExcelJS checks `instanceof Date`, which a date built in
    // the sandbox's own realm fails. In the browser both share one realm.
    { document, URL, Date, location: { hostname: 'localhost', href: 'http://localhost:8788/' } },
    'globalThis.__setLines = (lines, cols) => {' +
      ' billingLines = lines;' +
      ' billingChargeCols = cols || [];' +
      ' billingOrder = lines.slice()' +
      '   .sort((a, b) => a.waybillNumber.localeCompare(b.waybillNumber, undefined, { numeric: true }))' +
      '   .map((l) => l.id);' +
      '};' +
      'globalThis.__order = () => billingOrder.slice();' +
      'globalThis.__bands = () => FUEL_BANDS.slice();' +
      'globalThis.__setRates = (rows) => { rateMatrix = rows; };' +
      'globalThis.__excelReady = () => { excelJsReady = true; };'
  );
  // The status filter is a chip now; 'bl-status' names the chip to start on.
  sandbox.setBillingStatus(values['bl-status']);
  return { ui: sandbox, els };
}

function line(o) {
  return Object.assign(
    {
      id: 1, waybillNumber: 'AY-11801', foNumber: 'FO-1', tripDate: '7/2/2026',
      plateNumber: 'NLC9957', truckType: '4W', area: 'Calamba', origin: 'TANZA',
      drops: 1, total: 17670, mano: 0, dropFee: 0, haulingRate: 17670,
      manualCharges: {}, overrides: [], status: 'Not Billed', billingNumber: '',
      warning: '',
    },
    o
  );
}

/**
 * Stubs the stamp flow's edges: every server call, the modal, and the print.
 * getBilling answers with `billed` as the lines of billing 77.
 */
function stubStampCalls(ui, billed = []) {
  const sent = [];
  const opened = [];
  const printed = [];
  ui.confirm = () => true;
  ui.loadBilling = () => {};
  ui.openModal = (id) => opened.push(id);
  ui.printHtmlDocument = (html) => printed.push(html);
  ui.call = (fn, ...args) => {
    sent.push({ fn, args });
    if (fn === 'setBillingNumber') return Promise.resolve({ success: true, updated: args[0].length, billingId: 77 });
    if (fn === 'getBilling') {
      return Promise.resolve({
        success: true,
        billing: { id: 77, billingNumber: 'B-0042', docDate: '7/8/2026', from: '6/29/2026', to: '7/4/2026' },
        lines: billed,
        chargeTypes: [],
      });
    }
    return Promise.resolve({ success: true });
  };
  return { sent, opened, printed };
}

// ── The footer ────────────────────────────────────────────────

test('the printed footer reproduces the sample billing to the centavo', () => {
  const { ui, els } = loadBilling();
  ui.__setLines([line({ total: 1677050 })]);
  ui.renderBilling();

  // 02 Billing Output Sample.xlsx: 1,677,050 gross -> 1,647,102.68 due.
  const html = els['billing-footer'].innerHTML;
  assert.match(html, /1,677,050\.00/);
  assert.match(html, /179,683\.93/); // less VAT
  assert.match(html, /1,497,366\.07/); // net of VAT
  assert.match(html, /29,947\.32/); // withholding
  assert.match(html, /1,647,102\.68/); // amount due
});

test('the footer follows the filter, not the whole range', () => {
  const { ui, els } = loadBilling({ 'bl-status': 'unbilled' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801', total: 10000 }),
    line({ id: 2, waybillNumber: 'AY-11802', total: 5000, status: 'Billed' }),
  ]);
  ui.renderBilling();

  assert.match(els['billing-footer'].innerHTML, /10,000\.00/);
  assert.doesNotMatch(els['billing-footer'].innerHTML, /15,000\.00/);
});

// ── Filtering ─────────────────────────────────────────────────

test('the status filter separates billed, deferred and not billed', () => {
  const rows = [
    line({ id: 1, waybillNumber: 'AY-11801', status: 'Not Billed' }),
    line({ id: 2, waybillNumber: 'AY-11802', status: 'Billed' }),
    line({ id: 3, waybillNumber: 'AY-11803', status: 'Deferred' }),
  ];

  [['unbilled', 1], ['billed', 2], ['deferred', 3], ['all', null]].forEach(
    ([filter, onlyId]) => {
      const { ui } = loadBilling({ 'bl-status': filter });
      ui.__setLines(rows);
      const visible = ui.visibleBillingLines();
      if (onlyId === null) assert.equal(visible.length, 3, filter);
      else {
        assert.equal(visible.length, 1, filter);
        assert.equal(visible[0].id, onlyId, filter);
      }
    }
  );
});

test('the chips count the lines in scope and show what they count', () => {
  const { ui, els } = loadBilling({ 'bl-status': 'attention', 'bl-origin': 'TANZA' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801', total: 300000, warning: 'No rate for Calamba' }),
    line({ id: 2, waybillNumber: 'AY-11802', total: 10000 }),
    line({ id: 3, waybillNumber: 'AY-11803', status: 'Deferred' }),
    // Stamped: its warning needs no action.
    line({ id: 4, waybillNumber: 'AY-11804', status: 'Billed', warning: 'No rate' }),
    // Out of the origin filter: in no count.
    line({ id: 5, waybillNumber: 'AY-11805', origin: 'LINGUNAN', warning: 'No rate' }),
  ]);
  ui.renderBilling();

  const chips = els['bl-chips'].innerHTML;
  assert.match(chips, /Not billed 2 · ₱310K/);
  assert.match(chips, /class="pill active bl-chip-warn"[^>]*>Needs attention 1</);
  assert.match(chips, />Deferred 1</);
  assert.match(chips, />Billed 1</);
  assert.match(chips, />All 4</);
  assert.deepEqual(Array.from(ui.visibleBillingLines().map((l) => l.id)), [1]);
  // The reason shows on the line, not in a list above the table.
  assert.match(els['billing-tbody'].innerHTML, /class="bl-warn">No rate for Calamba/);
});

test('the totals row sums each money column of the lines shown', () => {
  const { ui, els } = loadBilling();
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801', mano: 392, haulingRate: 17670, total: 18212, manualCharges: { 1: 150 } }),
    line({ id: 2, waybillNumber: 'AY-11802', dropFee: 560, haulingRate: 17670, total: 18230 }),
  ], [{ id: 1, label: 'Parking' }]);
  ui.renderBilling();

  const html = els['billing-tfoot'].innerHTML;
  assert.match(html, /Total waybills: 2/);
  assert.match(html, /150\.00[\s\S]*392\.00[\s\S]*560\.00[\s\S]*35,340\.00[\s\S]*36,442\.00/);
});

// ── Ticking ───────────────────────────────────────────────────

test('a shift-click ticks every visible line from the last tick', () => {
  const { ui } = loadBilling({ 'bl-status': 'unbilled' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801' }),
    line({ id: 2, waybillNumber: 'AY-11802', status: 'Billed' }), // hidden
    line({ id: 3, waybillNumber: 'AY-11803' }),
    line({ id: 4, waybillNumber: 'AY-11804' }),
    line({ id: 5, waybillNumber: 'AY-11805' }),
  ]);
  ui.tickBillingRow(4, true, false);
  ui.tickBillingRow(1, true, true); // upward
  assert.deepEqual(Array.from(ui.tickedBillingLines().map((l) => l.id)), [1, 3, 4]);

  // A shift-click that unticks clears the range the same way.
  ui.tickBillingRow(3, false, true);
  assert.deepEqual(Array.from(ui.tickedBillingLines().map((l) => l.id)), [4]);
});

test('a shift-click with no earlier tick ticks one line', () => {
  const { ui } = loadBilling();
  ui.__setLines([line({ id: 1 }), line({ id: 2, waybillNumber: 'AY-11802' })]);
  ui.tickBillingRow(2, true, true);
  assert.deepEqual(Array.from(ui.tickedBillingLines().map((l) => l.id)), [2]);
});

// ── Range presets ─────────────────────────────────────────────

test('the presets give this week, last week and the DOE week', () => {
  const { ui } = loadBilling();
  const wed = new Date(2026, 8, 30, 7, 0); // Wednesday 9/30, before 8 AM
  const range = (name, d = wed) => ({ ...ui.billingPresetRange(name, d) });

  assert.deepEqual(range('this'), { from: '2026-09-28', to: '2026-09-30' });
  assert.deepEqual(range('last'), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(range('doe'), { from: '2026-09-29', to: '2026-09-30' });
  // On a Monday the DOE week began the Tuesday before, in last week.
  assert.deepEqual(range('doe', new Date(2026, 8, 28, 7, 0)), { from: '2026-09-22', to: '2026-09-28' });
  assert.equal(ui.billingPresetRange('', wed), null);
});

test('a date typed by hand clears the preset', () => {
  const { ui, els } = loadBilling({ 'bl-preset': 'this' });
  ui.loadBilling = () => {};
  ui.billingRangeEdited();
  assert.equal(els['bl-preset'].value, '');
});

test('the subcon filter matches the waybill prefix', () => {
  const { ui } = loadBilling({ 'bl-prefix': 'GL' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801' }),
    line({ id: 2, waybillNumber: 'GL-0451' }),
  ]);

  const visible = ui.visibleBillingLines();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].waybillNumber, 'GL-0451');
});

test('a short prefix does not match a longer prefix that starts with it', () => {
  const { ui } = loadBilling({ 'bl-prefix': 'G' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'G-0100' }),
    line({ id: 2, waybillNumber: 'GL-0451' }),
  ]);

  assert.deepEqual(
    Array.from(ui.visibleBillingLines().map((l) => l.waybillNumber)),
    ['G-0100']
  );
});

// ── The default week ──────────────────────────────────────────

test('the default week is Monday to today in Manila time, also before 8 AM', () => {
  const { ui } = loadBilling();
  // Monday 7:00 AM in Manila is still Sunday in UTC.
  const mondayMorning = new Date(2026, 8, 21, 7, 0);
  assert.deepEqual(
    { ...ui.billingDefaultRange(mondayMorning) },
    { from: '2026-09-21', to: '2026-09-21' }
  );
  // Thursday 6:30 AM: the week still starts on Monday the 21st.
  assert.deepEqual(
    { ...ui.billingDefaultRange(new Date(2026, 8, 24, 6, 30)) },
    { from: '2026-09-21', to: '2026-09-24' }
  );
  // Sunday belongs to the week that started the Monday before.
  assert.deepEqual(
    { ...ui.billingDefaultRange(new Date(2026, 8, 27, 7, 0)) },
    { from: '2026-09-21', to: '2026-09-27' }
  );
});

// ── Stamping a billing number ─────────────────────────────────

test('stamping skips ticked lines that the filter now hides', async () => {
  const { ui } = loadBilling({ 'bl-number': 'B-0042' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801', origin: 'TANZA' }),
    line({ id: 2, waybillNumber: 'AY-11802', origin: 'LINGUNAN' }),
  ]);
  ui.toggleBillingRow(1, true);
  ui.toggleBillingRow(2, true);
  // The dispatcher narrows the view to one warehouse after ticking both.
  ui.document.getElementById('bl-origin').value = 'TANZA';

  const { sent } = stubStampCalls(ui);
  ui.openStampPreview();
  await ui.confirmStampAndPrint();
  await tick();

  assert.equal(sent[0].fn, 'setBillingNumber');
  assert.deepEqual(Array.from(sent[0].args[0]), [1]);
  assert.equal(sent[0].args[1], 'B-0042');
});

test('stamping with every ticked line filtered away opens nothing and sends nothing', () => {
  const { ui } = loadBilling({ 'bl-status': 'billed', 'bl-number': 'B-0042' });
  ui.__setLines([line({ id: 1, waybillNumber: 'AY-11801' })]);
  ui.toggleBillingRow(1, true);

  const { sent, opened } = stubStampCalls(ui);
  ui.openStampPreview();
  ui.confirmStampAndPrint();

  assert.deepEqual(opened, []);
  assert.equal(sent.length, 0);
});

test('stamping needs a billing number before it opens the preview', () => {
  const { ui } = loadBilling({ 'bl-number': '  ' });
  ui.__setLines([line({ id: 1 })]);
  ui.toggleBillingRow(1, true);

  const { opened } = stubStampCalls(ui);
  ui.openStampPreview();
  assert.deepEqual(opened, []);
});

// The printout after a stamp is the billing the server holds under that
// number — a number already in use may hold more lines than were ticked.
test('stamp & print sends the header, then prints the billing read back', async () => {
  const { ui } = loadBilling({
    'bl-number': 'B-0042', 'bl-doc-date': '2026-07-08', 'bl-from': '2026-06-29', 'bl-to': '2026-07-04',
  });
  ui.__setLines([line({ id: 1 })]);
  ui.toggleBillingRow(1, true);

  const { sent, printed } = stubStampCalls(ui, [
    line({ id: 9, waybillNumber: 'AY-11799', status: 'Billed', billingNumber: 'B-0042' }),
    line({ id: 1, status: 'Billed', billingNumber: 'B-0042' }),
  ]);
  ui.openStampPreview();
  assert.equal(printed.length, 0, 'the stamp preview must not print before the stamp');

  await ui.confirmStampAndPrint();
  await tick();

  assert.deepEqual({ ...sent[0].args[2] }, { docDate: '7/8/2026', from: '6/29/2026', to: '7/4/2026' });
  assert.equal(sent[1].fn, 'getBilling');
  assert.equal(sent[1].args[0], 77);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /AY-11799[\s\S]*AY-11801/);
  assert.match(printed[0], /BILLING #<\/span> B-0042/);
  assert.match(printed[0], /BILLING JUNE 29 - JULY 4, 2026/);
});

test('a draft prints the visible lines with no billing number', () => {
  const { ui } = loadBilling({ 'bl-number': 'B-0042' });
  ui.__setLines([line({ id: 1 })]);
  const { printed } = stubStampCalls(ui);

  ui.openDraftPreview();
  ui.printBillingDoc();

  assert.equal(printed.length, 1);
  assert.match(printed[0], /DRAFT, NOT STAMPED/);
  assert.ok(!printed[0].includes('B-0042'), 'a draft must not carry a number nobody stamped');
});

test('the tick-all box ticks exactly the lines the filter shows', () => {
  const { ui } = loadBilling({ 'bl-origin': 'TANZA' });
  ui.__setLines([
    line({ id: 1, origin: 'TANZA' }),
    line({ id: 2, waybillNumber: 'AY-11802', origin: 'LINGUNAN' }),
  ]);
  ui.toggleAllBilling(true);
  ui.document.getElementById('bl-origin').value = '';

  assert.deepEqual(Array.from(ui.tickedBillingLines().map((l) => l.id)), [1]);
});

test('the detail row marks the stop that set the rate and names a typed-over amount', () => {
  const { ui } = loadBilling();
  const html = ui.billingDetailHtml(line({
    id: 3, drops: 2, haulingRate: 20000, overrides: ['haulingRate'],
    billingDate: '7/1/2026', tripDate: '7/2/2026', dieselPrice: 67, rateBand: '65.01-70',
    stops: [
      { outlet: 'SM Cabuyao', area: 'Cabuyao', quantity: 250, rate: 17290, mano: 784 },
      { outlet: 'SM Calamba', area: 'Calamba', quantity: 20, rate: 17670, mano: 0 },
    ],
    computed: { haulingRate: 17670, mano: 784, dropFee: 0, area: 'Calamba' },
  }));

  assert.match(html, /<tr class="bl-top">[\s\S]*SM Calamba/);
  assert.match(html, /highest rate among the stops \(Calamba\)/);
  assert.match(html, /Typed over: ₱20,000\.00/);
  assert.match(html, /delivered 7\/2\/2026/);
  assert.match(html, /none for 2 drops/);
});

test('the .xlsx follows the company workbook: headers on row 5, live totals, the VAT block', async () => {
  const ExcelJS = require('../web/vendor/exceljs.min.js');
  const { ui } = loadBilling({ 'bl-doc-date': '2026-07-08', 'bl-from': '2026-07-02', 'bl-to': '2026-07-02' });
  ui.ExcelJS = ExcelJS;
  ui.__excelReady();
  let saved = null;
  ui.saveBuffer = (buf, name) => { saved = { buf, name }; };

  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801', total: 17670 + 150 + 392, mano: 392, manualCharges: { 1: 150 } }),
    line({ id: 2, waybillNumber: 'AY-11802', total: 17670 }),
  ], [{ id: 1, label: 'Parking Fee/Toll Fees' }]);
  ui.openDraftPreview();
  await ui.exportBillingXlsx();

  assert.equal(saved.name, 'BILLING DRAFT (2026-07-02 to 2026-07-02).xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(saved.buf);
  const ws = wb.getWorksheet('TRIPS BILLING');
  const v = (addr) => ws.getCell(addr).value;

  assert.deepEqual(ws.getRow(5).values.slice(1), [
    'DATE', 'PLATE #', 'WAYBILL #', 'FREIGHT ORDER #', 'TRUCK TYPE', 'AREA',
    'PARKING FEE/TOLL FEES', 'MANO', 'ADDITIONAL 500 PER 3 DROPS', 'HAULING RATE', 'TOTAL']);
  assert.equal(v('A6').toISOString(), '2026-07-02T00:00:00.000Z');
  assert.deepEqual([v('C6'), v('G6'), v('H6'), v('J6')], ['AY-11801', 150, 392, 17670]);
  assert.deepEqual({ ...v('K6') }, { formula: 'SUM(G6:J6)', result: 18212 });
  // Totals row, then the VAT block three rows down.
  assert.equal(v('B8'), 'TOTAL WAYBILLS: ');
  assert.deepEqual({ ...v('K8') }, { formula: 'SUM(K6:K7)', result: 35882 });
  assert.equal(v('I11'), 'TOTAL SALES VAT INC :');
  assert.equal(v('K16').formula, 'K11-K15');
  assert.ok(Math.abs(v('K16').result - (35882 - (35882 / 1.12) * 0.02)) < 1e-6);
  assert.deepEqual([v('G1'), v('I1'), v('H2'), v('E3')],
    ['BILLING #', 'DRAFT, NOT STAMPED', 'DATE:', 'BILLING JULY 2 - 2, 2026']);
});

test('an Excel date lands on the same calendar day in Manila', () => {
  const { ui } = loadBilling();
  const d = ui.excelDate('7/2/2026');
  assert.equal(d.toISOString(), '2026-07-02T00:00:00.000Z');
  assert.equal(ui.excelDate(''), null);
});

test('the origin filter keeps one warehouse', () => {
  const { ui } = loadBilling({ 'bl-origin': 'LINGUNAN' });
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11801', origin: 'TANZA' }),
    line({ id: 2, waybillNumber: 'AY-11802', origin: 'LINGUNAN' }),
  ]);

  assert.equal(ui.visibleBillingLines().length, 1);
});

// ── Row order ─────────────────────────────────────────────────

test('rows sort by waybill number, and numerically rather than as text', () => {
  const { ui } = loadBilling();
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11810' }),
    line({ id: 2, waybillNumber: 'AY-11809' }),
    line({ id: 3, waybillNumber: 'AY-11900' }),
  ]);

  assert.deepEqual(
    Array.from(ui.visibleBillingLines().map((l) => l.waybillNumber)),
    ['AY-11809', 'AY-11810', 'AY-11900']
  );
});

test('a re-render after an edit does not resort the rows', () => {
  const { ui } = loadBilling();
  ui.__setLines([
    line({ id: 1, waybillNumber: 'AY-11802' }),
    line({ id: 2, waybillNumber: 'AY-11801' }),
  ]);
  const before = Array.from(ui.__order());

  // An edit that would change the sort key if the order were derived.
  ui.visibleBillingLines()[0].waybillNumber = 'AY-99999';
  ui.renderBilling();

  assert.deepEqual(Array.from(ui.__order()), before);
});

// patchBillingRow finds a row and its cells by these hooks. If the markup
// drifts, the patch silently falls back to re-rendering the whole table and
// the panel gets slow again with nothing failing — so pin them here.
test('a rendered row carries the hooks a single-row patch needs', () => {
  const { ui } = loadBilling();
  const html = ui.billingRowHtml(
    line({ id: 7, mano: 120, overrides: ['mano'], manualCharges: { 3: 45 } })
  );

  assert.match(html, /<tr data-line="7"/);
  assert.match(html, /class="bl-total"/);
  assert.match(html, /data-field="mano"/);
  assert.match(html, /data-field="dropFee"/);
  assert.match(html, /data-field="haulingRate"/);
  // The override marker is a sibling span the patch rewrites, present either way.
  assert.match(html, /class="bl-ovr"[^>]*>✎</);
});

test('a billed row is text, so it exposes no editable hooks to patch', () => {
  const { ui } = loadBilling();
  const html = ui.billingRowHtml(line({ id: 8, status: 'Billed', billingNumber: 'B-1' }));

  assert.match(html, /<tr data-line="8"/);
  assert.match(html, /class="bl-total"/);
  assert.ok(!/data-field=/.test(html));
});

test('a second load does not read rows through the first load\'s index', () => {
  const { ui } = loadBilling();
  ui.__setLines([line({ id: 1, waybillNumber: 'AY-11801' })]);
  assert.equal(ui.visibleBillingLines().length, 1);

  ui.__setLines([
    line({ id: 4, waybillNumber: 'GL-2001' }),
    line({ id: 5, waybillNumber: 'GL-2002' }),
  ]);

  assert.deepEqual(
    Array.from(ui.visibleBillingLines().map((l) => l.waybillNumber)),
    ['GL-2001', 'GL-2002']
  );
});

// ── The rate matrix bands ─────────────────────────────────────

test('the client and the server name the price bands identically', () => {
  const { ui } = loadBilling();
  const bands = ui.__bands();

  assert.equal(bands.length, 25);
  assert.equal(bands[0], '30.01-35');
  assert.equal(bands[7], '65.01-70');
  assert.equal(bands[24], '150.01-155');
});

test('the client band index steps where the server one does', () => {
  const { ui } = loadBilling();

  assert.equal(ui.bandLabelForPrice(35.0), '30.01-35');
  assert.equal(ui.bandLabelForPrice(35.01), '35.01-40');
  assert.equal(ui.bandLabelForPrice(67.0), '65.01-70');
  assert.equal(ui.bandLabelForPrice(12), '30.01-35'); // clamps low
  assert.equal(ui.bandLabelForPrice(400), '150.01-155'); // clamps high
});

test('a workbook column midpoint maps onto its band', () => {
  const { ui } = loadBilling();
  // The rates workbook labels its columns 32.5, 37.5 … 152.5.
  assert.equal(ui.bandLabelForPrice(32.5), '30.01-35');
  assert.equal(ui.bandLabelForPrice(67.5), '65.01-70');
  assert.equal(ui.bandLabelForPrice(152.5), '150.01-155');
});

// ── The rates in force ────────────────────────────────────────
// The default matrix view shows the rate billing uses today: per origin, area
// and truck type, the newest block that has started — as _indexRates() does.

function rate(o) {
  return Object.assign(
    { id: 1, origin: 'TANZA', area: 'Calamba', truckType: '4W', effectiveDate: '1/6/2026', bands: {} },
    o
  );
}

test('the in-force view keeps every origin, each on its own newest block', () => {
  const { ui } = loadBilling();
  const rows = [
    rate({ id: 1, origin: 'TANZA', effectiveDate: '1/6/2026' }),
    rate({ id: 2, origin: 'TANZA', effectiveDate: '9/1/2026' }),
    // LINGUNAN was never re-seeded: its January block is still the one in force.
    rate({ id: 3, origin: 'LINGUNAN', effectiveDate: '1/6/2026' }),
  ];

  const ids = [...ui.ratesInForce(rows, '2026-09-23')].map((r) => r.id).sort();
  assert.deepEqual(ids, [2, 3]);
});

test('a block that has not started yet is not in force', () => {
  const { ui } = loadBilling();
  const rows = [
    rate({ id: 1, effectiveDate: '9/1/2026' }),
    rate({ id: 2, effectiveDate: '9/29/2026' }),
  ];

  const ids = [...ui.ratesInForce(rows, '2026-09-23')].map((r) => r.id);
  assert.deepEqual(ids, [1]);
});

test('areas match the way the server matches them, ignoring case and spacing', () => {
  const { ui } = loadBilling();
  const rows = [
    rate({ id: 1, area: 'San Juan', effectiveDate: '1/6/2026' }),
    rate({ id: 2, area: 'SAN JUAN', effectiveDate: '9/1/2026' }),
    rate({ id: 3, area: 'San Juan', truckType: '6W', effectiveDate: '1/6/2026' }),
  ];

  const ids = [...ui.ratesInForce(rows, '2026-09-23')].map((r) => r.id).sort();
  assert.deepEqual(ids, [2, 3]);
});

test('All origins with the default view renders every warehouse', () => {
  const { ui, els } = loadBilling({ 'bm-origin': '', 'bm-effective': '', 'bm-type': '', 'bm-search': '' });
  // Dates well in the past: this test renders against the real today.
  ui.__setRates([
    rate({ id: 1, origin: 'TANZA', effectiveDate: '6/3/2025' }),
    rate({ id: 2, origin: 'LINGUNAN', effectiveDate: '1/7/2025' }),
  ]);
  ui.populateEffectiveDates();
  ui.renderRateMatrix();

  const html = els['rate-matrix-tbody'].innerHTML;
  assert.match(html, /TANZA/);
  assert.match(html, /LINGUNAN/);
  assert.equal(els['bm-count'].textContent, '2 rates');
});

test('the effective-date list offers the in-force view first and defaults to it', () => {
  const { ui, els } = loadBilling({ 'bm-effective': '' });
  ui.__setRates([rate({ effectiveDate: '9/1/2026' }), rate({ id: 2, effectiveDate: '1/6/2026' })]);
  ui.populateEffectiveDates();

  assert.match(els['bm-effective'].innerHTML, /^<option value="">In force today<\/option>/);
  assert.equal(els['bm-effective'].value, '');
});

// ── The DOE price week ────────────────────────────────────────
// The DOE posts NCR pump prices on a Monday and each posting runs Tuesday to
// the following Monday, so an effective date is a Tuesday.

test('the latest Tuesday is today when today is a Tuesday, else the one before', () => {
  const { ui } = loadBilling();

  assert.equal(ui.latestTuesdayIso('2026-09-01'), '2026-09-01'); // a Tuesday
  assert.equal(ui.latestTuesdayIso('2026-09-02'), '2026-09-01'); // Wednesday
  assert.equal(ui.latestTuesdayIso('2026-09-07'), '2026-09-01'); // the Monday it ends on
  assert.equal(ui.latestTuesdayIso('2026-09-08'), '2026-09-08'); // the next Tuesday
});

test('isTuesdayIso agrees with the DOE posting titles', () => {
  const { ui } = loadBilling();

  // "September 1 to 7", "August 25 to 31" — every posting starts on a Tuesday.
  assert.equal(ui.isTuesdayIso('2026-09-01'), true);
  assert.equal(ui.isTuesdayIso('2026-08-25'), true);
  assert.equal(ui.isTuesdayIso('2026-09-07'), false); // the Monday it ends on
  assert.equal(ui.isTuesdayIso(''), false);
});

test('mdyToIso is the inverse of isoToMDY', () => {
  const { ui } = loadBilling();

  assert.equal(ui.mdyToIso('9/1/2026'), '2026-09-01');
  assert.equal(ui.mdyToIso('12/25/2026'), '2026-12-25');
  assert.equal(ui.mdyToIso(''), '');
  assert.equal(ui.isoToMDY(ui.mdyToIso('7/4/2026')), '7/4/2026');
});

// ── The printed billing header ────────────────────────────────

test('the printed range collapses a same-month week and spells out the rest', () => {
  const { ui } = loadBilling();

  assert.equal(
    ui.billingRangeLabel('2026-07-02', '2026-07-06'),
    'BILLING JULY 2 - 6, 2026'
  );
  assert.equal(
    ui.billingRangeLabel('2026-06-29', '2026-07-05'),
    'BILLING JUNE 29 - JULY 5, 2026'
  );
  assert.equal(
    ui.billingRangeLabel('2026-12-28', '2027-01-03'),
    'BILLING DECEMBER 28, 2026 - JANUARY 3, 2027'
  );
  assert.equal(ui.billingRangeLabel('', '2026-07-06'), '');
});
