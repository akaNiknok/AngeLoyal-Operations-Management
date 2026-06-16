// ============================================================
//  AngeLoyal OMS — Test harness
//  Loads the .gs backend into a Node `vm` sandbox with in-memory
//  fakes for the Apps Script globals (SpreadsheetApp / Session /
//  Utilities), so the same code that runs on Apps Script can be
//  unit-tested under `node --test` with no Apps Script account and
//  no live Google Sheet.
//
//  Why a vm bundle instead of `require()`:
//  Apps Script shares one global scope across every .gs file and has
//  no module system. We mirror that by concatenating the .gs files
//  and running them as a single script, so top-level `const`s (sheet
//  names, ROLES, PERMISSIONS) and `function` declarations all see one
//  another exactly as they do in production.
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// Order matters only for top-level `const` evaluation (Code.gs defines
// the SHEET_* / ROLES / PERMISSIONS constants the others close over).
const GS_FILES = [
  'Code.gs',
  'Utils.gs',
  'DataReaders.gs',
  'DataWriters.gs',
  'Internals.gs',
  'DevTools.gs',
];

// ------------------------------------------------------------
//  Apps Script global fakes
// ------------------------------------------------------------

/** Deep-ish clone so reads return copies (Sheets returns copies of cell values). */
function cloneCell(v) {
  return v instanceof Date ? new Date(v.getTime()) : v;
}

/** Minimal Utilities.formatDate supporting the M/d/yyyy [HH:mm:ss] patterns the code uses. */
function formatDate(date, _tz, fmt) {
  const pad = (n) => String(n).padStart(2, '0');
  // Tokens listed longest-first so greedy matching picks MM over M, dd over d, etc.
  const tokens = [
    ['yyyy', () => date.getFullYear()],
    ['MM', () => pad(date.getMonth() + 1)],
    ['M', () => date.getMonth() + 1],
    ['dd', () => pad(date.getDate())],
    ['d', () => date.getDate()],
    ['HH', () => pad(date.getHours())],
    ['mm', () => pad(date.getMinutes())],
    ['ss', () => pad(date.getSeconds())],
  ];
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const hit = tokens.find(([tok]) => fmt.startsWith(tok, i));
    if (hit) {
      out += hit[1]();
      i += hit[0].length;
    } else {
      out += fmt[i];
      i += 1;
    }
  }
  return out;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValue() {
    const r = this.sheet.data[this.row - 1] || [];
    return cloneCell(r[this.col - 1] === undefined ? '' : r[this.col - 1]);
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      const srcRow = this.sheet.data[this.row - 1 + r] || [];
      for (let c = 0; c < this.numCols; c++) {
        const cell = srcRow[this.col - 1 + c];
        rowArr.push(cloneCell(cell === undefined ? '' : cell));
      }
      out.push(rowArr);
    }
    return out;
  }

  setValue(v) {
    if (!this.sheet.data[this.row - 1]) this.sheet.data[this.row - 1] = [];
    this.sheet.data[this.row - 1][this.col - 1] = cloneCell(v);
    return this;
  }

  setValues(vals) {
    for (let r = 0; r < vals.length; r++) {
      const tr = this.row - 1 + r;
      if (!this.sheet.data[tr]) this.sheet.data[tr] = [];
      for (let c = 0; c < vals[r].length; c++) {
        this.sheet.data[tr][this.col - 1 + c] = cloneCell(vals[r][c]);
      }
    }
    return this;
  }
}

class FakeSheet {
  constructor(name, data) {
    this.name = name;
    this.data = data; // 2D array including the header row
  }

  getName() {
    return this.name;
  }

  _width() {
    return this.data.reduce((m, r) => Math.max(m, r.length), 0);
  }

  getLastRow() {
    return this.data.length;
  }

  getDataRange() {
    return new FakeRange(this, 1, 1, this.data.length, this._width());
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  appendRow(arr) {
    this.data.push(arr.map(cloneCell));
  }

  deleteRow(rowNum) {
    this.data.splice(rowNum - 1, 1);
  }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = {};
    Object.keys(sheets || {}).forEach((name) => {
      this.sheets[name] = new FakeSheet(name, sheets[name]);
    });
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }
}

// ------------------------------------------------------------
//  Bundle loader
// ------------------------------------------------------------

function loadBundle(sandbox) {
  let src = GS_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');

  // Collect every top-level function name so the test side can call them.
  const names = new Set();
  const re = /^\s*function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);

  src += `\n;globalThis.__api = { ${[...names].join(', ')} };\n`;

  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: 'gas-bundle.js' });
  return sandbox.__api;
}

// ------------------------------------------------------------
//  Public entry point
// ------------------------------------------------------------

/**
 * Builds a fresh sandboxed copy of the backend.
 *
 * @param {Object}  [opts]
 * @param {Object}  [opts.sheets]     Map of sheetName -> 2D array (incl. header row).
 * @param {string}  [opts.userEmail]  Email returned by Session.getActiveUser().
 * @param {string}  [opts.tz]         Script timezone (default Asia/Shanghai).
 * @returns {{ api: Object, ss: FakeSpreadsheet, sandbox: Object }}
 */
function makeEnv(opts = {}) {
  const ss = new FakeSpreadsheet(opts.sheets || {});
  const email = opts.userEmail || 'unknown';

  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Session: {
      getActiveUser: () => ({ getEmail: () => email }),
      getScriptTimeZone: () => opts.tz || 'Asia/Shanghai',
    },
    Utilities: { formatDate },
    // Share the host Date so `val instanceof Date` and `new Date()` inside the
    // bundle agree with Dates we seed into sheets from the test side (the vm
    // otherwise has its own Date realm, breaking instanceof across the boundary).
    Date,
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile: () => ({ evaluate: () => ({}) }),
      createHtmlOutputFromFile: () => ({ getContent: () => '' }),
    },
    console,
  };
  sandbox.globalThis = sandbox;

  const api = loadBundle(sandbox);
  return { api, ss, sandbox };
}

/** Reads a FakeSheet's data back out as { headers, rows } for assertions. */
function dump(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  return { headers: data[0], rows: data.slice(1) };
}

/** Builds a row-as-object using a headers array (handy for assertions). */
function rowObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[String(h).trim()] = row[i];
  });
  return obj;
}

module.exports = { makeEnv, dump, rowObject, formatDate, FakeSpreadsheet, FakeSheet };
