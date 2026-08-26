// ============================================================
//  AngeLoyal OMS — DevTools.gs
//  Read-only export for local testing. Not linked from the UI.
// ============================================================

/** Serializes a body as a JSON TextOutput. */
function _devOut(body) {
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * True if the request carries the shared secret in Script Properties
 * (DEV_DUMP_TOKEN). Both dev endpoints are gated by the same token.
 * @param {Object} params  e.parameter from doGet
 * @returns {boolean}
 */
function _devAuthorized(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('DEV_DUMP_TOKEN');
  return !!expected && params.token === expected;
}

/**
 * Read-only JSON dump of one or all sheets, gated by DEV_DUMP_TOKEN. Used by
 * local tooling (scripts/fetch-sheet-data.js) to pull a snapshot of the live
 * data for tests/verification. Not linked from the UI.
 *
 * Usage: ?action=devDump&token=...           -> all sheets
 *        ?action=devDump&token=...&sheet=Trips -> single sheet
 *
 * @param {Object} params  e.parameter from doGet
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _devDump(params) {
  if (!_devAuthorized(params)) return _devOut({ error: 'forbidden' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetNames = params.sheet ? [params.sheet] : ss.getSheets().map(s => s.getName());

  const result = {};
  sheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    result[name] = sheet ? sheet.getDataRange().getValues() : null;
  });

  return _devOut(result);
}

/**
 * Token-gated wrapper around _clearTransactionalSheets() (Internals.gs) —
 * deletes all data rows (keeps header row) from Trips, Outlets, Route
 * Frequency Log, Waybills and Audit Log. Used by local tooling
 * (scripts/clear-sheet-data.js) to reset a dev/test spreadsheet; the in-app
 * equivalent is clearAllData().
 *
 * Usage: ?action=devClear&token=...
 *
 * @param {Object} params  e.parameter from doGet
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _devClear(params) {
  if (!_devAuthorized(params)) return _devOut({ error: 'forbidden' });
  return _devOut({ cleared: _clearTransactionalSheets() });
}

/**
 * One-time setup: generates and stores a random token in Script Properties
 * for the devDump endpoint. Run this once from the Apps Script editor
 * (select this function, click Run), then copy the token from the
 * execution log into your local .env as DEV_DUMP_TOKEN.
 * @returns {string} the generated token (also logged)
 */
function setupDevDumpToken() {
  const token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('DEV_DUMP_TOKEN', token);
  Logger.log('DEV_DUMP_TOKEN = %s', token);
  return token;
}
