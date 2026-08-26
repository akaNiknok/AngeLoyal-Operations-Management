// ============================================================
//  web/import.js — reading a Rebisco route .xlsx with ExcelJS.
//
//  ExcelJS is now the only spreadsheet library (SheetJS is gone), so
//  it feeds the parser the grid *and* the fill colors from one load.
//  The grid it hands over must keep the shape parseRebiscoFile was
//  written against: 0-indexed rows, 0-indexed columns, "" for blanks.
//
//  The load-bearing trap this pins down: ExcelJS omits `result` from
//  a formula cell's `value` when the cached number is 0 (every shared
//  SUM in a real route file), while `cell.result` still returns it.
//  TOTAL = 0 is how Rebisco marks the FOs riding along in a convoy —
//  read the wrong one and those rows each grow their own truck.
//
//  The workbook here is built with ExcelJS and round-tripped through
//  a buffer, so it reproduces that quirk without a fixture file
//  (*.xlsx is gitignored — see .gitignore).
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWeb, fakeEl, plain } = require('./webharness');

const ExcelJS = require(path.join(__dirname, '..', 'web', 'vendor', 'exceljs.min.js'));

const YELLOW = 'FFFFFF00';
const BLUE = 'FF00B0F0';

// Column layout of a real Rebisco file (1-based): A blank, headers on row 2,
// truck-type counts in R–V, TOTAL in W, TIER in X.
const HEADER = [
  null, 'ORIGINAL RDD', 'REVISED RDD', 'STATUS', 'Sold-to party', 'AREA',
  'CUSTOMER', 'OUTLET', 'ADDRESS', 'UNLOADING LOCATION',
  'QTY in packs/ cartons', 'CBM', 'RESTRICTIONS', 'Scheduled Last Week',
  'ACTUAL BO PICKED UP LAST WEEK', 'Pick up BO', 'FREIGHT ORDER',
  '10W', '6WF', '6WC', '4WC', 'L300', 'TOTAL', 'TIER',
];

/**
 * One data row. `types` is { '6WC': 2, ... }; `total` is written as a SUM
 * formula carrying that cached result, which is what the real file has.
 */
function dataRow(ws, r, { fo, outlet, area = 'Boac', qty = 100, cbm = 4.5, types = {}, total, tier = 1, fill, customerFill }) {
  const row = ws.getRow(r);
  row.getCell(6).value = area;
  row.getCell(7).value = 'PG';
  row.getCell(8).value = outlet;
  row.getCell(11).value = qty;
  row.getCell(12).value = cbm;
  row.getCell(13).value = '6W';
  row.getCell(17).value = fo;
  ['10W', '6WF', '6WC', '4WC', 'L300'].forEach((code, i) => {
    if (types[code]) row.getCell(18 + i).value = types[code];
  });
  row.getCell(23).value = { formula: `SUM(R${r}:V${r})`, result: total };
  row.getCell(24).value = tier;
  // Chain-code color in the CUSTOMER column. Rebisco paints it from the same
  // palette as the batch delimiters (WM = yellow, SM = blue), which is why
  // the fill scan is scoped to the truck-type columns.
  if (customerFill) {
    row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: customerFill } };
  }
  if (fill) {
    for (let c = 18; c <= 22; c++) {
      row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    }
  }
}

/**
 * A route workbook written and re-read, so it carries ExcelJS's own quirks.
 * `extraSheets` mirrors the real files, which ship "Sheet5" and "Bo Return"
 * alongside the route sheet.
 */
async function routeSheet(build, extraSheets = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('MAY');
  HEADER.forEach((h, i) => {
    if (h) ws.getRow(2).getCell(i + 1).value = h;
  });
  build(ws);
  extraSheets.forEach(({ name, rows }) => {
    const extra = wb.addWorksheet(name);
    (rows || []).forEach((r, i) => extra.getRow(i + 1).values = r);
  });
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return { ws: back.worksheets[0], buf };
}

/** The convoy sample: a 3-truck anchor, two TOTAL=0 riders, then a loner. */
function convoyBuild(ws) {
  dataRow(ws, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 2, '4WC': 1 }, total: 3, fill: YELLOW });
  dataRow(ws, 4, { fo: 'FO-2', outlet: 'PG GASAN', total: 0, fill: YELLOW });
  dataRow(ws, 5, { fo: 'FO-3', outlet: 'PG TORRIJOS', total: 0, fill: YELLOW });
  dataRow(ws, 6, { fo: 'FO-4', outlet: 'WM LUCENA', types: { '6WF': 1 }, total: 1, fill: BLUE });
  // row 7 left entirely blank — real files have gaps
  dataRow(ws, 8, { fo: 'FO-5', outlet: 'SM TIAONG', types: { '4WC': 1 }, total: 1 });
}

/** import.js + core.js in one sandbox, with reachable `let` state. */
function loadImport(overrides = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, fakeEl());
    return els.get(id);
  };
  const toasts = [];
  const { sandbox } = loadWeb(
    ['core.js', 'import.js'],
    {
      ExcelJS,
      document: {
        createElement: (t) => fakeEl(t),
        getElementById: el, // memoized, so the test can read back what was set
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        head: { appendChild() {} },
        body: fakeEl('body'),
      },
      window: { addEventListener() {}, matchMedia: () => ({ matches: false }), ExcelJS },
      ...overrides,
    },
    'globalThis.__meta = () => importParseMeta;' +
      'globalThis.__rows = () => importRows;' +
      'globalThis.__setRows = (r) => { importRows = r; };' +
      'globalThis.__setExcelReady = (v) => { excelJsReady = v; };'
  );
  sandbox.showToast = (msg, kind) => toasts.push({ msg, kind });
  sandbox.__setExcelReady(true);
  return { ui: sandbox, el, toasts };
}

test("the grid keeps the parser's indexing: row r → grid[r-1], column c → [c-1]", async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet(convoyBuild);
  const grid = ui.sheetToGrid(ws);

  assert.deepEqual(plain(grid[0]), []); // row 1 has no cells at all
  assert.equal(grid[1][16], 'FREIGHT ORDER'); // header row 2, column Q
  assert.equal(grid[2][7], 'PG BOAC'); // row 3, column H
  assert.equal(grid[2][0], ''); // column A exists but is empty — never undefined
  assert.deepEqual(plain(grid[6]), []); // the blank row stays blank
  assert.equal(grid.length, 8); // one entry per sheet row
});

test('a TOTAL of 0 survives — ExcelJS drops it from value, cell.result keeps it', async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet(convoyBuild);

  // The quirk itself, so this test fails loudly if ExcelJS ever changes it.
  const cell = ws.getRow(4).getCell(23);
  assert.equal(cell.value.result, undefined);
  assert.equal(cell.result, 0);

  assert.equal(ui.sheetToGrid(ws)[3][22], 0);
});

test('rich text, hyperlinks and dates read as what the cell shows', async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 1 }, total: 1 });
    // Rebisco's header is sometimes styled mid-string; the parser matches on text.
    s.getRow(2).getCell(17).value = { richText: [{ text: 'FREIGHT ' }, { text: 'ORDER' }] };
    s.getRow(3).getCell(8).value = { text: 'PG BOAC', hyperlink: 'https://maps.example/boac' };
    s.getRow(3).getCell(2).value = new Date(Date.UTC(2026, 4, 12));
  });
  const grid = ui.sheetToGrid(ws);

  assert.equal(grid[1][16], 'FREIGHT ORDER');
  assert.equal(grid[2][7], 'PG BOAC');
  assert.ok(grid[2][1] && typeof grid[2][1].getUTCFullYear === 'function'); // a real Date, kept as-is

  // and the parser still finds its header row through the rich text
  const rows = ui.parseRebiscoFile(grid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outletName, 'PG BOAC');
});

test('parseRebiscoFile reads an ExcelJS grid the way it read a SheetJS one', async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet(convoyBuild);
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));

  assert.deepEqual(plain(rows.map((r) => r.foNumber)), ['FO-1', 'FO-2', 'FO-3', 'FO-4', 'FO-5']);
  assert.deepEqual(plain(rows.map((r) => r._rowIdx)), [2, 3, 4, 5, 7]); // 0-based, blank row skipped
  assert.equal(rows[0].tier, 1);
  assert.equal(rows[0].quantity, 100);
  assert.equal(rows[0].cbm, 4.5);
  assert.equal(rows[0].restrictions, '6W');
  assert.equal(rows[0].customer, 'PG');

  // TOTAL=0 rows: the anchor's surplus trucks are handed down instead of
  // being piled on FO-1 (this is the branch the dropped 0 used to break).
  assert.deepEqual(plain(rows[0].slots), [{ type: '6WC', count: 1 }]);
  assert.deepEqual(plain(rows[1].slots), [{ type: '6WC', count: 1 }]);
  assert.deepEqual(plain(rows[2].slots), [{ type: '4WC', count: 1 }]);
  assert.deepEqual(plain(rows[3].slots), [{ type: '6WF', count: 1 }]);
  assert.equal(rows[0].displayType, '6WC');

  // the type columns found between FREIGHT ORDER and TOTAL
  assert.deepEqual(plain(ui.__meta().typeCols.map((t) => t.code)), ['10W', '6WF', '6WC', '4WC', 'L300']);
  assert.equal(ui.__meta().headerIdx, 1);
});

test('fill colors group a contiguous run into one convoy', async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet(convoyBuild);
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  ui.__setRows(rows);

  const fills = ui.parseConvoyFills(ws, ui.__meta());
  assert.equal(ui.assignConvoyGroups(fills), 1); // the blue single-truck run is not a convoy

  assert.deepEqual(plain(rows.map((r) => r.convoyGroup || null)), ['1', '1', '1', null, null]);
});

test('a colorless file simply gets no convoy groups', async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 1 }, total: 1 });
    dataRow(s, 4, { fo: 'FO-2', outlet: 'PG GASAN', types: { '4WC': 1 }, total: 1 });
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  ui.__setRows(rows);

  assert.equal(ui.assignConvoyGroups(ui.parseConvoyFills(ws, ui.__meta())), 0);
  assert.deepEqual(plain(rows.map((r) => r.convoyGroup ?? null)), [null, null]);
});

test('processFile parses a dropped file end to end', async () => {
  const { ui, el, toasts } = loadImport();
  const { buf } = await routeSheet(convoyBuild);

  await ui.processFile({ name: 'ROUTE MAY 12.xlsx', arrayBuffer: () => Promise.resolve(buf) });

  assert.deepEqual(toasts, []);
  assert.equal(el('import-filename').textContent, 'ROUTE MAY 12.xlsx');
  assert.equal(el('btn-run-import').disabled, false);
  assert.equal(ui.__rows().length, 5);
  assert.equal(ui.__rows()[0].convoyGroup, '1'); // fills read from the same load
});

test('processFile refuses to parse before ExcelJS has loaded', async () => {
  const { ui, toasts } = loadImport();
  ui.__setExcelReady(false);

  await ui.processFile({ name: 'ROUTE.xlsx', arrayBuffer: () => Promise.reject(new Error('never read')) });

  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /still loading/);
  assert.equal(toasts[0].kind, 'warning');
});

test('a file that is not a workbook toasts instead of throwing', async () => {
  const { ui, toasts } = loadImport();

  await ui.processFile({ name: 'notes.txt', arrayBuffer: () => Promise.resolve(Buffer.from('not a zip')) });

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'error');
  assert.match(toasts[0].msg, /Could not read file/);
});

test('a sheet with no FREIGHT ORDER column parses to nothing and says so', async () => {
  const { ui, toasts } = loadImport();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getRow(1).getCell(1).value = 'SOMETHING ELSE';

  assert.deepEqual(plain(ui.parseRebiscoFile(ui.sheetToGrid(ws))), []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /FREIGHT ORDER/);
});

// ── Shapes taken from the five real ROUTE MAY 12–16 files ────────────
// (surveyed, not committed: `Sample Files/*.xlsx` is gitignored). Every
// one of them ships three worksheets, mixes numeric and text FO cells,
// paints the CUSTOMER column from the same yellow/blue palette as the
// batch delimiters, and MAY 13 carries a live #N/A cell.

test("only the first worksheet is read — the others are the file's own scratch", async () => {
  const { ui } = loadImport();
  const { ws } = await routeSheet(
    (s) => dataRow(s, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 1 }, total: 1 }),
    // The real files carry these two; here "Bo Return" even holds FO-shaped rows.
    [
      { name: 'Sheet5', rows: [['scratch']] },
      { name: 'Bo Return', rows: [['FREIGHT ORDER', 'OUTLET'], ['FO-99', 'NOT A DROP']] },
    ],
  );

  assert.equal(ws.name, 'MAY');
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  assert.deepEqual(plain(rows.map((r) => r.foNumber)), ['FO-1']);
});

test('an FO stored as a number parses to its digits, like a text one', async () => {
  const { ui } = loadImport();
  // Real MAY 12: the anchor FO is text, the riders behind it are numbers.
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: '6100043752', outlet: 'SW FESTIVAL', types: { L300: 2 }, total: 2 });
    dataRow(s, 4, { fo: 437462, outlet: 'SW FESTIVAL', total: 0 });
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));

  assert.deepEqual(plain(rows.map((r) => r.foNumber)), ['6100043752', '437462']);
  assert.equal(typeof rows[1].foNumber, 'string');
});

test('an #N/A cell reads as blank, not "[object Object]"', async () => {
  const { ui } = loadImport();
  // MAY 13 has one, in UNLOADING LOCATION. Put it in a column the parser
  // reads as well, so a leaked error object would show up in the preview.
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 1 }, total: 1 });
    s.getRow(3).getCell(9).value = { error: '#N/A' }; // ADDRESS
    s.getRow(3).getCell(10).value = { error: '#N/A' }; // UNLOADING LOCATION
  });
  const grid = ui.sheetToGrid(ws);

  assert.equal(grid[2][8], '');
  assert.equal(grid[2][9], '');
  assert.equal(ui.parseRebiscoFile(grid)[0].address, '');
});

test("the CUSTOMER column's yellow and blue never delimit a convoy", async () => {
  const { ui } = loadImport();
  // Chain colors only — WM yellow, SM blue — and no fill on the type columns.
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'WM LUCENA', types: { '6WC': 1 }, total: 1, customerFill: YELLOW });
    dataRow(s, 4, { fo: 'FO-2', outlet: 'WM CANDELARIA', types: { '6WC': 1 }, total: 1, customerFill: YELLOW });
    dataRow(s, 5, { fo: 'FO-3', outlet: 'SM TIAONG', types: { '4WC': 1 }, total: 1, customerFill: BLUE });
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  ui.__setRows(rows);

  assert.equal(ui.assignConvoyGroups(ui.parseConvoyFills(ws, ui.__meta())), 0);
});

test('a chain color on the same row does not disturb the batch colors', async () => {
  const { ui } = loadImport();
  // Both systems at once, which is every real row: the type columns say
  // "one batch", the customer column says "three different chains".
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 2 }, total: 2, fill: YELLOW, customerFill: BLUE });
    dataRow(s, 4, { fo: 'FO-2', outlet: 'WM LUCENA', total: 0, fill: YELLOW, customerFill: YELLOW });
    dataRow(s, 5, { fo: 'FO-3', outlet: 'SM TIAONG', types: { '4WC': 1 }, total: 1, fill: BLUE, customerFill: BLUE });
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  ui.__setRows(rows);

  assert.equal(ui.assignConvoyGroups(ui.parseConvoyFills(ws, ui.__meta())), 1);
  assert.deepEqual(plain(rows.map((r) => r.convoyGroup || null)), ['1', '1', null]);
});

test('an uncolored row joins the batch of a colored row sharing its FO', async () => {
  const { ui } = loadImport();
  // Rebisco leaves some rows of a batch unfilled — 8 of MAY 12's 35.
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'PG BOAC', types: { '6WC': 2 }, total: 2, fill: YELLOW });
    dataRow(s, 4, { fo: 'FO-2', outlet: 'PG GASAN', total: 0, fill: YELLOW });
    dataRow(s, 5, { fo: 'FO-1', outlet: 'PG TORRIJOS', total: 0 }); // same FO, no fill
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  ui.__setRows(rows);

  assert.equal(ui.assignConvoyGroups(ui.parseConvoyFills(ws, ui.__meta())), 1);
  assert.deepEqual(plain(rows.map((r) => r.convoyGroup || null)), ['1', '1', '1']);
});

test('a multi-stop run on one truck is not a convoy', async () => {
  const { ui } = loadImport();
  // Real shape: three colored rows, one FO, one truck (MAY 12 rows 16–18).
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: 'FO-1', outlet: 'SMCO BANLIC', types: { '4WC': 1 }, total: 1, fill: YELLOW });
    dataRow(s, 4, { fo: 'FO-1', outlet: 'SMCO CABUYAO', total: 0, fill: YELLOW });
    dataRow(s, 5, { fo: 'FO-1', outlet: 'DIVIMART BANLIC', total: 0, fill: YELLOW });
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));
  ui.__setRows(rows);

  assert.equal(ui.assignConvoyGroups(ui.parseConvoyFills(ws, ui.__meta())), 0);
  assert.equal(ui.dropCount(rows), 3); // three stops, still one truck
});

test('the MAY 12 L300 batch: 5 rows, 6 trucks, 6 drops, one convoy', async () => {
  const { ui } = loadImport();
  // FO 6100043752 asks for six L300s on its own line; four riders follow, so
  // the anchor keeps two and the preview promises one more drop than rows.
  const { ws } = await routeSheet((s) => {
    dataRow(s, 3, { fo: '6100043752', outlet: 'SW FESTIVAL MALL ALABANG', types: { L300: 6 }, total: 6, fill: YELLOW });
    dataRow(s, 4, { fo: '6100043765', outlet: 'SW FESTIVAL MALL ALABANG', total: 0, fill: YELLOW });
    dataRow(s, 5, { fo: '6100043766', outlet: 'SW FESTIVAL MALL ALABANG', total: 0, fill: YELLOW });
    dataRow(s, 6, { fo: 437462, outlet: 'SW FESTIVAL MALL ALABANG', total: 0, fill: YELLOW });
    dataRow(s, 7, { fo: 437463, outlet: 'SW FESTIVAL MALL ALABANG', total: 0, fill: YELLOW });
    dataRow(s, 8, { fo: '6100043753', outlet: 'SW SUCAT', types: { '6WC': 1 }, total: 1, fill: BLUE });
  });
  const rows = ui.parseRebiscoFile(ui.sheetToGrid(ws));

  assert.deepEqual(plain(rows[0].slots), [{ type: 'L300', count: 2 }]); // unplaced surplus stays
  assert.equal(rows[0].displayType, '2×L300');
  assert.equal(ui.dropCount(rows), 7); // 6 L300s + the 6WC
  assert.equal(ui.dropCount(rows.slice(0, 5)), 6); // the batch alone: 5 rows, 6 drops

  ui.__setRows(rows);
  assert.equal(ui.assignConvoyGroups(ui.parseConvoyFills(ws, ui.__meta())), 1);
  assert.deepEqual(plain(rows.map((r) => r.convoyGroup || null)), ['1', '1', '1', '1', '1', null]);
});

