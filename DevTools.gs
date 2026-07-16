// ============================================================
//  AngeLoyal OMS — DevTools.gs
//  Read-only export for local testing. Not linked from the UI.
// ============================================================

/**
 * Read-only JSON dump of one or all sheets, gated by a shared-secret token
 * stored in Script Properties (DEV_DUMP_TOKEN). Used by local tooling
 * (scripts/fetch-sheet-data.js) to pull a snapshot of the live data for
 * tests/verification. Not linked from the UI.
 *
 * Usage: ?action=devDump&token=...           -> all sheets
 *        ?action=devDump&token=...&sheet=Trips -> single sheet
 *
 * @param {Object} params  e.parameter from doGet
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _devDump(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('DEV_DUMP_TOKEN');
  const out = (body) => ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);

  if (!expected || params.token !== expected) {
    return out({ error: 'forbidden' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetNames = params.sheet ? [params.sheet] : ss.getSheets().map(s => s.getName());

  const result = {};
  sheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    result[name] = sheet ? sheet.getDataRange().getValues() : null;
  });

  return out(result);
}

/**
 * Deletes all data rows (keeps header row) from the transactional sheets:
 * Trips, Outlets, Route Frequency Log, Waybills, Audit Log. Gated by the same
 * DEV_DUMP_TOKEN as _devDump. Used by local tooling
 * (scripts/clear-sheet-data.js) to reset a dev/test spreadsheet.
 *
 * Usage: ?action=devClear&token=...
 *
 * @param {Object} params  e.parameter from doGet
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _devClear(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('DEV_DUMP_TOKEN');
  const out = (body) => ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);

  if (!expected || params.token !== expected) {
    return out({ error: 'forbidden' });
  }

  const sheetNames = [SHEET_TRIPS, SHEET_OUTLETS, SHEET_ROUTE_FREQ, SHEET_WAYBILLS, SHEET_AUDIT];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cleared = [];
  sheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
    cleared.push(name);
  });

  return out({ cleared });
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
