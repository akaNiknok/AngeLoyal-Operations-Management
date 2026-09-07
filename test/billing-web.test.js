// ============================================================
//  Billing panel logic (web/billing.js, web/billing-matrix.js).
//  The harness has no layout, so this covers the arithmetic and
//  the ordering — the parts that would be wrong on paper, not
//  the parts that would merely look wrong on screen.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb, fakeEl } = require('./webharness');

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
    { document },
    'globalThis.__setLines = (lines, cols) => {' +
      ' billingLines = lines;' +
      ' billingChargeCols = cols || [];' +
      ' billingOrder = lines.slice()' +
      '   .sort((a, b) => a.waybillNumber.localeCompare(b.waybillNumber, undefined, { numeric: true }))' +
      '   .map((l) => l.id);' +
      '};' +
      'globalThis.__order = () => billingOrder.slice();' +
      'globalThis.__bands = () => FUEL_BANDS.slice();'
  );
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
