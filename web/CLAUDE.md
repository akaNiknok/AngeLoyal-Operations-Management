# web/ — frontend notes

Loads when you work in `web/`. The root `CLAUDE.md` holds the constraints that apply everywhere.

`index.html` loads the scripts in dependency order — that is the whole build. No bundler, no framework, no router. `switchPanel()` toggles `.panel` visibility and state lives in module-level globals in `core.js`.

- **Reading .xlsx cells** goes through `cellValue()` in `import.js`. Read a formula cell as `cell.result`, **not** `cell.value.result`: ExcelJS drops `result` when the cached number is 0, and the route file's TOTAL is a shared `SUM` that is 0 for every FO in a convoy. Lost zeros give each of those FOs its own truck.

| File | Gotcha |
| :--- | :--- |
| `config.js` | Environment label by hostname (prod / dev / local), `API_URL = "/api"`, `OAUTH_CLIENT_ID`. An unknown host is "local", never prod. |
| `core.js` | Global state (`employees`, `trucks`, `dispatchData`), `bootApp()`, the `call()`/`callBackend()` transport, GIS sign-in, RBAC UI gating, panel switching, shared utilities. `toastError` handles rejections; `bgSave()` wraps optimistic saves. Format a local date with `isoDate()` — `toISOString()` is UTC and names yesterday before 8 AM Manila. A sign-in reloads the page, because RBAC gating only ever unhides. |
| `export.js` | Client-only exports of a dispatch day: FINAL-ROUTE print/xlsx and per-truck `.jpg` driver cards. |
| `masters.js` | Admin master-detail panels, the Waybill Prefixes panel (Admin **and** Dispatcher, gated by `EDIT_WAYBILL_PREFIXES`), and the Settings danger zone — an Admin-only `clearAllData()` behind a typed confirmation phrase, scoped to the current environment. |
| `billing.js` | The Billing panel: one row per billable waybill over a date range, filtered by status, origin and subcon (the waybill prefix). Mano, the drop fee and the hauling rate compute but can be typed over; totals never can. Prints the Rebisco billing format through `export.js`'s `printHtmlDocument`. |
| `billing-matrix.js` | The Billing Matrix panel: the rate grid for one origin across the 25 diesel bands, the weekly diesel price entry, and the `.xlsx` seed that loads a rates workbook one sheet per origin. `FUEL_BANDS` here must name the bands exactly as `_fuelBandLabel()` does in `server/internals.js`, and the default "In force today" view (`ratesInForce()`) must pick rows as `_indexRates()` does. |
| `audit.js` | The Audit Log panel: one page of `audit_log`, Admin-only. Every read sends a date range and pages through the rest — the log only grows. |
| `whatsnew.js` + `changelog.json` | The "What's new?" dialog. `npm run changelog:sync -- --apply` generates the JSON from GitHub Releases, because the repo is private. |
| `vendor/` | ExcelJS and html2canvas, pinned and self-hosted so the CSP can refuse every third-party script. ExcelJS is the only spreadsheet library. |
