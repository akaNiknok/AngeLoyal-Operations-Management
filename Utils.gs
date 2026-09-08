// ============================================================
//  AngeLoyal OMS — Utils.gs
//  Generic sheet/row helpers shared by all backend modules.
// ============================================================

/**
 * Returns the sheet by name, throwing a clear error if not found.
 * @param {string} name
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _getSheet(name) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error(`Sheet "${name}" not found. Check that the sheet name matches exactly.`);
  return sheet;
}

/**
 * Returns the sheet by name, creating and seeding it if it doesn't exist yet.
 * Used for config sheets that ship with sensible defaults so a fresh deployment
 * (or a Sheet that predates the feature) self-bootstraps instead of erroring.
 *
 * @param {string}   name      Sheet name.
 * @param {string[]} headers   Header row (row 1) written when the sheet is new.
 * @param {Array[]}  [seedRows] Optional data rows written under the header when new.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _getOrCreateSheet(name, headers, seedRows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (seedRows && seedRows.length) {
    sheet.getRange(2, 1, seedRows.length, headers.length).setValues(seedRows);
  }
  return sheet;
}

/**
 * Appends a column header to row 1 if the sheet doesn't have it yet, so a
 * Sheet that predates the feature self-migrates instead of erroring. Mutates
 * (and returns) the passed headers array so callers can keep using it.
 *
 * Existing rows are left blank — readers treat a blank Active cell as active
 * (`_val(...) !== false`), so no backfill is needed.
 *
 * @param {Sheet}    sheet
 * @param {string[]} headers  Header row already read from the sheet.
 * @param {string}   colName
 * @returns {string[]} The headers array, including colName.
 */
function _ensureColumn(sheet, headers, colName) {
  if (headers.indexOf(colName) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(colName);
    headers.push(colName);
  }
  return headers;
}

/**
 * Gets the value at a named column header position in a row.
 * Returns '' if the column doesn't exist or the value is null/undefined.
 *
 * @param {Array}  row
 * @param {Array}  headers
 * @param {string} colName
 * @returns {*}
 */
function _val(row, headers, colName) {
  const idx = headers.indexOf(colName);
  if (idx === -1) return '';
  const v = row[idx];
  return (v === null || v === undefined) ? '' : v;
}

/**
 * Reads a cell that should be a timestamp string. If Sheets has auto-converted
 * the cell to a Date object (e.g. because the column is date-formatted),
 * formats it back to 'M/d/yyyy HH:mm:ss' so it serializes safely over
 * google.script.run (which can't handle raw Date objects nested in arrays).
 *
 * @param {Array} row
 * @param {string[]} headers
 * @param {string} colName
 * @returns {string}
 */
function _valDateTime(row, headers, colName) {
  const v = _val(row, headers, colName);
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'M/d/yyyy HH:mm:ss');
  return v || '';
}

/**
 * Coerces a sheet cell to a boolean. Google Sheets may return a native boolean
 * (TRUE/FALSE checkbox) or the string 'TRUE'/'FALSE' depending on how the cell
 * was entered, so compare both defensively (see CLAUDE.md boolean convention).
 *
 * @param {*} v
 * @returns {boolean}
 */
function _isTrue(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

/**
 * Converts a value to a number or returns null if not numeric.
 * Guards against Google Sheets returning empty strings for blank numeric cells.
 *
 * @param {*} v
 * @returns {number|null}
 */
function _numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/**
 * Rounds to 3 decimal places, undoing binary float drift (e.g. 10.568999999999999)
 * that creeps into cells computed by formulas upstream in the route file.
 */
function _round3(n) {
  return n === null ? null : Math.round(n * 1000) / 1000;
}

/**
 * Reads a date cell value safely.
 * Google Sheets returns Date objects for formatted date cells and numeric serial numbers
 * for unformatted ones. Returns a JS Date or null.
 *
 * @param {*} val
 * @returns {Date|null}
 */
function _readDateCell(val) {
  if (!val || val === '') return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') return new Date((val - 25569) * 86400000); // Excel serial → JS Date
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parses a date string in 'M/d/yyyy' format into a JS Date at midnight.
 * @param {string} str
 * @returns {Date}
 */
function _parseDate(str) {
  if (!str) return new Date();
  const parts = str.split('/');
  if (parts.length < 3) return new Date(str);
  return new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]));
}

/**
 * Returns a Date set to midnight (start of day) in the script timezone.
 * @param {Date} d
 * @returns {Date}
 */
function _startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * Formats a Date as 'M/d/yyyy'.
 * @param {Date|null} d
 * @returns {string}
 */
function _formatDate(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/**
 * Returns the next business day (Monday-Saturday schedule; skips Sundays).
 * Adjust the logic here if the warehouse has different rest days.
 *
 * @param {Date} from
 * @returns {Date}
 */
function _nextBusinessDay(from) {
  const next = new Date(from);
  next.setDate(next.getDate() + 1);
  // Skip Sundays (0 = Sunday)
  if (next.getDay() === 0) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Computes the next available ID for a sheet by reading the last row's ID column.
 * Assumes column 1 is the ID column.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {number}
 */
function _nextRowId(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  // A blank ID cell reads as 0, not NaN — falling through to `+ 1` would
  // restart the sequence at 1 and hand out IDs that are already in use.
  const lastId = Number(sheet.getRange(lastRow, 1).getValue());
  return lastId ? lastId + 1 : lastRow;
}

/**
 * Same as `_nextRowId`, but from a values array the caller has already read.
 * Saves a round trip when the whole sheet is in hand anyway.
 *
 * @param {Array[]} rows  Sheet rows, header included.
 * @returns {number}
 */
function _nextRowIdFromRows(rows) {
  if (!rows || rows.length < 2) return 1;
  const lastId = Number(rows[rows.length - 1][0]);   // blank reads as 0 — see _nextRowId
  return lastId ? lastId + 1 : rows.length;
}

/**
 * Appends multiple rows to a sheet in a single Sheets API call.
 * No-op if `rows2D` is empty.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array[]} rows2D  Array of row arrays, all the same length.
 */
function _appendRows(sheet, rows2D) {
  if (!rows2D || rows2D.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows2D.length, rows2D[0].length).setValues(rows2D);
}

/**
 * Writes back a set of already-mutated rows, one setValues() per contiguous
 * run instead of one per row. A day's waybills are appended together, so the
 * rows a batch touches are normally one run — 1 API call, not N.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array[]} rows      The full sheet values, rows already updated in place.
 * @param {number[]} rowIdxs  0-based indexes into `rows` to write.
 */
function _writeRowRuns(sheet, rows, rowIdxs) {
  const sorted = rowIdxs.slice().sort((a, b) => a - b);
  const width  = rows[0].length;
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    const run = sorted.slice(start, end + 1).map(i => {
      const row = rows[i];
      // setValues rejects undefined — a row from a freshly-migrated sheet can
      // be short of the header width (see _writeRowFields).
      for (let c = 0; c < width; c++) if (row[c] === undefined) row[c] = '';
      return row.slice(0, width);
    });
    sheet.getRange(sorted[start] + 1, 1, run.length, width).setValues(run);
    start = end + 1;
  }
}

/**
 * Finds the (1-based) row index of a row with a matching ID value.
 * Returns -1 if not found.
 * rowIdx returned is 0-based into the rows array; add 1 for sheet row number.
 *
 * @param {Array[]}  rows
 * @param {Array}    headers
 * @param {number}   id
 * @returns {number}  0-based index into rows array (rows[0] = header, rows[1] = first data row)
 */
function _findRowById(rows, headers, id) {
  const idIdx = headers.indexOf('ID');
  if (idIdx === -1) return -1;
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i][idIdx]) === Number(id)) return i;
  }
  return -1;
}

/**
 * Applies a set of { colName: value } updates to an in-memory row array,
 * then writes the entire row back to the sheet in a single setValues() call.
 * Replaces per-field _setCellByHeader() calls (one Range write per field).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array}  row      The row's current values (will be mutated in place).
 * @param {number} rowIdx   0-based index into the sheet's getDataRange() rows array.
 * @param {Array}  headers
 * @param {Object} updates  Map of { colName: newValue }
 */
function _writeRowFields(sheet, row, rowIdx, headers, updates) {
  Object.keys(updates).forEach(colName => {
    const colIdx = headers.indexOf(colName);
    if (colIdx === -1) throw new Error(`Column "${colName}" not found in sheet "${sheet.getName()}".`);
    row[colIdx] = updates[colName];
  });
  // Writing a column a freshly-migrated row doesn't reach yet (a sheet that
  // just gained one via _ensureColumn) leaves holes behind it; setValues
  // rejects undefined, so fill them.
  for (let i = 0; i < row.length; i++) {
    if (row[i] === undefined) row[i] = '';
  }
  sheet.getRange(rowIdx + 1, 1, 1, row.length).setValues([row]);
}

/**
 * Builds a waybill number string from a prefix, sequence number, and optional
 * suffix. A blank prefix (Waybill Prefixes.Prefix = "") omits the leading
 * "prefix-" segment entirely, so the number is just the bare sequence.
 * The sequence is zero-padded to `width` so it matches the physical booklet's
 * fixed-width numbering (e.g. width 4 → 0358). width 0/blank means no padding.
 * padStart never truncates, so a sequence longer than width prints in full.
 * @param {string} prefix
 * @param {number} seq
 * @param {number} [width]
 * @param {string} [suffix]
 * @returns {string}
 */
function _waybillNumberString(prefix, seq, width, suffix) {
  const s = String(seq).padStart(width || 0, '0');
  return (prefix ? `${prefix}-${s}` : `${s}`) + (suffix || '');
}

/**
 * Strips a trailing -R / -FT off a waybill number, leaving the number the
 * booklet actually carries. Redelivering a redeliver must stay 1001-R, not
 * grow into 1001-R-R.
 * @param {string} waybillNumber
 * @returns {string}
 */
function _baseWaybillNumber(waybillNumber) {
  return String(waybillNumber || '').replace(/-(R|FT)$/, '');
}

/**
 * Builds a { id → object } index from an array of objects that have an `id` field.
 * @param {Object[]} arr
 * @returns {Object}
 */
function _indexById(arr) {
  const map = {};
  (arr || []).forEach(item => { if (item.id !== null) map[item.id] = item; });
  return map;
}

/**
 * Opens a sheet and reads it in one go: the sheet handle, all its rows
 * (header included) and the trimmed header row. `ensureCols` names columns
 * that must exist, self-migrating a Sheet that predates them (_ensureColumn).
 *
 * @param {string}   name
 * @param {string[]} [ensureCols]
 * @returns {{ sheet: Sheet, rows: Array[], headers: string[] }}
 */
function _openSheet(name, ensureCols) {
  const sheet   = _getSheet(name);
  const rows    = sheet.getDataRange().getValues();
  let   headers = rows[0].map(h => h.toString().trim());
  (ensureCols || []).forEach(col => { headers = _ensureColumn(sheet, headers, col); });
  return { sheet: sheet, rows: rows, headers: headers };
}

/**
 * `_openSheet` plus the row lookup every record editor starts with. Throws the
 * same "<Label> ID <id> not found." the hand-written versions did.
 *
 * @param {string}   name
 * @param {number}   id
 * @param {string}   label       Human name for the error message, e.g. 'Truck'.
 * @param {string[]} [ensureCols]
 * @returns {{ sheet, rows, headers, row: Array, rowIdx: number }}
 */
function _openRow(name, id, label, ensureCols) {
  const ctx = _openSheet(name, ensureCols);
  ctx.rowIdx = _findRowById(ctx.rows, ctx.headers, id);
  if (ctx.rowIdx === -1) throw new Error(`${label} ID ${id} not found.`);
  ctx.row = ctx.rows[ctx.rowIdx];
  return ctx;
}

/**
 * Reads a row into a plain object using a { jsKey: 'Column Name' } map — the
 * audit snapshot and the read-back both need this and always needed the same
 * shape. Values are raw `_val` reads; callers normalize (e.g. `active`).
 *
 * @param {Array}  row
 * @param {string[]} headers
 * @param {Object} fieldMap  { jsKey: 'Column Name' }
 * @returns {Object}
 */
function _readFields(row, headers, fieldMap) {
  const out = {};
  Object.keys(fieldMap).forEach(key => { out[key] = _val(row, headers, fieldMap[key]); });
  return out;
}

/**
 * Runs a writer body inside the result envelope every client-callable writer
 * shares: whatever the body returns is merged onto `{ success: true }`, and a
 * throw anywhere inside becomes `{ success: false, error }` — the client never
 * sees an exception, only a flag (see the writers' contract in CLAUDE.md).
 *
 * @param {Function} fn
 * @returns {{ success: true }|{ success: false, error: string }}
 */
function _writerResult(fn) {
  try {
    return Object.assign({ success: true }, fn() || {});
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Throws `message` if another row already holds `value` in `colName`
 * (case-insensitive, trimmed). `skipRowIdx` is the row being edited — pass it
 * from an update so a record doesn't collide with itself.
 *
 * @param {Array[]}  rows
 * @param {string[]} headers
 * @param {string}   colName
 * @param {string}   value
 * @param {string}   message
 * @param {number}   [skipRowIdx]  Index into `rows` (not into rows.slice(1)).
 */
function _requireUnique(rows, headers, colName, value, message, skipRowIdx) {
  const want = String(value).trim().toUpperCase();
  const dup  = rows.slice(1).some((r, i) => (i + 1) !== skipRowIdx
    && String(_val(r, headers, colName)).trim().toUpperCase() === want);
  if (dup) throw new Error(message);
}
