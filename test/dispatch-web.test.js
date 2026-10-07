// ============================================================
//  The dispatch day on the page (web/dispatch.js, web/export.js).
//  Two seams a stub DOM can still pin: the date an export prints
//  comes from the board it prints, and the waybill ✓ button does
//  not blur the number box (a blur fires a rename that races the
//  confirm).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb, fakeEl } = require('./webharness');

/** The board scripts, with the date picker set to `picked`. */
function loadDay(picked) {
  const els = {};
  const document = {
    createElement: (t) => fakeEl(t),
    getElementById: (id) => {
      if (!els[id]) {
        els[id] = fakeEl();
        if (id === 'dispatch-date') els[id].value = picked;
      }
      return els[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    head: { appendChild() {} },
    body: fakeEl('body'),
  };
  const { sandbox } = loadWeb(['core.js', 'dispatch.js', 'export.js'], { document },
    'globalThis.__setBoard = (b) => { dispatchData = b; };');
  const printed = [];
  sandbox.printHtmlDocument = (html) => printed.push(html);
  sandbox.exportHtmlAsJpg = (html, name) => printed.push(name + '\n' + html);
  return { ui: sandbox, printed };
}

const TRIP = { id: 1, foNumber: 'FO-1', tripStatus: 'Scheduled', helperIds: [] };

// The dispatcher picks the 24th; the board still holds the 23rd until that
// load lands. Whatever prints is the 23rd's trips, so it must say the 23rd.
test('the route printout is dated by the board it prints, not the date picker', () => {
  const { ui, printed } = loadDay('2026-09-24');
  ui.__setBoard({ date: '9/23/2026', trips: [TRIP] });

  ui.printDispatchDay();
  ui.printDispatchDay('jpg');

  assert.equal(printed.length, 2);
  assert.match(printed[0], /FINAL ROUTE 2026-09-23/);
  assert.match(printed[1], /^FINAL ROUTE 2026-09-23 \(ANGELOYAL\)\.jpg/);
  printed.forEach((p) => assert.doesNotMatch(p, /2026-09-24/));
});

test('the driver cards are dated by the board they were built from', () => {
  const { ui, printed } = loadDay('2026-09-24');
  ui.__setBoard({ date: '9/23/2026', trips: [TRIP] });

  ui.openDriverShareView();
  ui.printDriverShare();
  ui.printDriverShare('jpg');

  assert.match(printed[0], /TRIPS 2026-09-23/);
  assert.match(printed[1], /^TRIPS 2026-09-23 \(ANGELOYAL\)\.jpg/);
  printed.forEach((p) => assert.doesNotMatch(p, /2026-09-24/));
});

test('the waybill ✓ button keeps focus in the number box', () => {
  const { ui } = loadDay('2026-09-23');
  const html = ui.waybillCellHtml(
    { id: 5, suggestedWaybillId: 9, waybillSuggested: 'AY-0101', waybillConfirmed: '' },
    true,
  );

  assert.match(html, /<button class="row-confirm" onmousedown="event\.preventDefault\(\)" onclick="confirmWaybillInline\(5\)">/);
});

// A filter chip shows a count and, when clicked, the rows; both come from
// one predicate, so the two can never disagree. Undelivered takes the foul
// trips too, as the old Undelivered tile did.
test('each filter chip counts exactly the trips it shows', () => {
  const { sandbox } = loadWeb(['core.js', 'dispatch.js'], {},
    'globalThis.__count = (f, trips) => trips.filter(DISPATCH_FILTERS[f]).length;');
  const trips = [
    { tripStatus: 'Prepping', truckId: null },
    { tripStatus: 'Delivered', truckId: 3, waybillConfirmed: 'AY-1' },
    { tripStatus: 'Foul Trip - For Redeliver', truckId: 3, waybillSuggested: 'AY-2' },
    { tripStatus: 'Undelivered', truckId: 4, source: 'Carry-over' },
  ];
  const n = (f) => sandbox.__count(f, trips);
  assert.equal(n('all'), 4);
  assert.equal(n('Prepping'), 1);
  assert.equal(n('Undelivered'), 2);
  assert.equal(n('carry'), 1);
  assert.equal(n('nowb'), 2);
  assert.equal(n('nocrew'), 1);
});
