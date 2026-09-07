# CLAUDE.md — AngeLoyal Operations Management System (OMS)

## Communication style (how to talk to the owner)
Owner holds a **BS in Management Information Systems**. Bridge IT and strategy: frame a technical trade-off as system integration, scalability, data flow or value. Do not over-explain foundational tech and do not walk through low-level syntax.
**Write in Simplified Technical English (ASD-STE100 spirit, not the strict standard) — chat prose, commit messages, docs. README.md keeps the strict version (see its own rule).**
1. Use active voice. Write "The system sends the file", not "The file is sent by the system". 2. Put one idea in each sentence; split a sentence that has two. 3. Keep sentences short — no word count, but cut every word that adds nothing. 4. Use a maximum of three words in a noun cluster: "the log of failed jobs", not "the failed job log record". 5. Use one term for one thing — if it is a "data pipeline", it is never later a "data flow" or an "ingestion path". 6. Use one meaning for each word; do not use "run" for both execute and manage. 7. Start an instruction with the verb: "Open the panel", not "The panel must be opened". 8. Expand an acronym at first use only. 9. Use lists for steps and comparisons; use prose for reasoning.

## What this is

A web-based Operations Management System for **AngeLoyal Logistics**, a Philippine trucking subcontractor that hauls for Rebisco. It replaces Excel and group chats for dispatch scheduling, waybill tracking, billing, driver payroll, and proof-of-delivery (POD) tracking.

It is a **Google Apps Script web app**: the `.gs` backend runs on Apps Script, the frontend is a static site on Cloudflare Pages, and **Google Sheets is the database**. No server, no SQL, no build step.

- [`Docs/Schema.md`](Docs/Schema.md) — the authoritative data model. Reconcile every change against it.
- [`Docs/Project Proposal.md`](Docs/Project%20Proposal.md) — feature set, pricing, contractual scope.
- Interview notes in `Docs/` are rough transcriptions. Confirm a detail before you build on it.

## Phases

1. **Records, Dispatch, Waybills** — largely BUILT. Employee/truck/outlet records, dispatch board, Rebisco route-file import, waybills, truck roster, RBAC, admin panels.
2. **Billing & Payroll** — BILLING BUILT, PAYROLL NOT STARTED. Built: origin warehouse on import, the DOE freight-rate matrix with date-locked rates and effective-dated blocks, the weekly diesel price history, the Mano fee, the flat 3-drop fee, the split-load highest-rate rule, the Billing panel with overrides and deferrals, and print/PDF in the Rebisco format. Not built: the `RTVS BILLING` second tab for bad-order returns. Payroll is untouched — trips/night differential/absences, SSS/PhilHealth/Pag-IBIG, 13th month, payslips.
3. **Visibility & Alerts** — NOT STARTED. POD status logging with business-day aging, management dashboard, billing/payroll report exports, driver route history.

The GitHub Project board is the backlog source of truth: `gh issue list --json number,title,state,labels`, `gh issue view <n>`. `BACKLOG.md` is a gitignored snapshot — regenerate with `npm run backlog:sync -- --apply --project 2 --owner akaNiknok`. Update this section when a phase moves.

## Architecture

### Backend (`.gs`, Apps Script, V8)

| File | Responsibility |
| :--- | :--- |
| `Code.gs` | Entry point. Sheet-name constants, RBAC (`ROLES`, `PERMISSIONS`, `_requirePermission`), request identity (`_REQUEST_EMAIL`, `_getCurrentUserEmail`), the **`doPost` JSON API** (`_jsonOut`), and `doGet`, which keeps the dev endpoints and redirects to `_frontendUrl`. |
| `Auth.gs` | Google sign-in and sessions. `login(idToken)` is the one pre-session action: `_verifyIdToken` checks the browser token against Google's tokeninfo endpoint (**never a local decode**), then `_createSession` mints a token in `CacheService`. Every other client call goes through the **`rpc(sessionToken, fnName, args)` gateway** and its `RPC_ALLOWED` allow-list. `OAUTH_CLIENT_ID` lives in Script Properties; there is no client secret. |
| `Utils.gs` | Sheet and row helpers: `_getSheet`, `_val`, `_numOrNull`, date parse/format, `_nextRowId`, `_findRowById`, `_writeRowFields`, `_indexById`. Also the master-record writer envelope: `_openSheet`, `_openRow`, `_readFields`, `_writerResult`, `_requireUnique`. **Reuse these. Do not hand-roll sheet access.** |
| `DataReaders.gs` | Read-only accessors. `getBootData()` returns all master data in one round trip; also `getDispatchBoardData()`, `getTrips()`, `getWaybillsForTrip()`. |
| `DataWriters.gs` | Every sheet mutation: `createTrip`, `saveTripChanges`, `confirmWaybill`, `importRouteFile`, `createOutlet/Truck/Employee/BillingCategory`, `updateDefaultAssignment`. Largest file. |
| `Internals.gs` | Private writer helpers: `_auditLog`, waybill suggestion, carry-over trips, outlet resolve-or-create, route-frequency append, billing-category rename cascade. |
| `DevTools.gs` | Token-gated `_devDump` JSON export for local snapshots. Not in the UI. |

### Frontend (`web/`, static site on Cloudflare Pages)

Apps Script does not serve the frontend. `web/index.html` loads the scripts in dependency order — that is the whole build. No bundler, no framework, no router. `switchPanel()` toggles `.panel` visibility and state lives in module-level globals in `web/core.js`.

| File | Responsibility |
| :--- | :--- |
| `index.html` | Shell: markup, nav, script and style tags. |
| `config.js` | `location.hostname` → `/exec` URL map, plus `OAUTH_CLIENT_ID`. An unknown host falls back to DEV, never PROD. |
| `styles.css` | All CSS (DM Sans/DM Mono, design tokens). |
| `core.js` | Global state (`employees`, `trucks`, `dispatchData`), `bootApp()`, the `call()`/`callBackend()` transport, GIS sign-in, RBAC UI gating, panel switching, shared utilities. `toastError` handles rejections; `bgSave()` wraps optimistic saves. |
| `dispatch.js` | The dispatch board — the primary screen. |
| `export.js` | Client-only exports of a dispatch day: FINAL-ROUTE print/xlsx and per-truck `.jpg` driver cards. |
| `crewboard.js` | Crew rail: draggable crew cards dropped onto dispatch rows. |
| `import.js` | Rebisco `.xlsx` route-file parsing and import. |
| `roster.js` | Truck roster (driver/helper ↔ truck, edits Default Assignments) and the Outlets admin. |
| `masters.js` | Admin master-detail panels, the Waybill Prefixes panel (Admin **and** Dispatcher, gated by `EDIT_WAYBILL_PREFIXES`), and the Settings danger zone — an Admin-only `clearAllData()` behind a typed confirmation phrase, scoped to the current environment. |
| `billing.js` | The Billing panel: one row per billable waybill over a date range, filtered by status, origin and subcon (the waybill prefix). Mano, the drop fee and the hauling rate compute but can be typed over; totals never can. Prints the Rebisco billing format through `export.js`'s `printHtmlDocument`. |
| `billing-matrix.js` | The Billing Matrix panel: the rate grid for one origin across the 25 diesel bands, the weekly diesel price entry, and the `.xlsx` seed that loads a rates workbook one sheet per origin. `FUEL_BANDS` here must name the bands exactly as `_fuelBandLabel()` does in `Internals.gs`. |
| `whatsnew.js` + `changelog.json` | The "What's new?" dialog. `npm run changelog:sync -- --apply` generates the JSON from GitHub Releases, because the repo is private. |
| `vendor/` | ExcelJS and html2canvas, pinned and self-hosted so the CSP can refuse every third-party script. ExcelJS is the only spreadsheet library. |
| `_headers` | Cloudflare Pages response headers: CSP, `X-Frame-Options: DENY`, nosniff. |

The public launcher page is a plain redirect and lives in the separate `angeloyal-oms-launcher` repo, which is its only copy. It is the link the operators keep after the Cloudflare handover. Read [DEPLOY.md](DEPLOY.md#the-account-launcher-page) before you touch it.

### Data flow

1. The GIS button posts a Google ID token to `login()`. The server verifies it, returns an app session token, and `core.js` keeps it in `localStorage`.
2. `call(fnName, ...args)` POSTs `{token, fn, args}` to `doPost` → `rpc()`, and returns a promise. It absorbs `AUTH_REQUIRED` centrally, so call sites handle only real failures. `rpc` resolves the session, sets `_REQUEST_EMAIL`, then dispatches.
3. `getBootData()` returns the session and all master data — or the session alone when the verified user has no role.
4. The board calls `getDispatchBoardData(date)`. Display names come from cached master data through `indexById()`; the server does not re-send them.
5. Writes go through `DataWriters.gs`, which check permissions, write, and append to the Audit Log.

## Critical constraints

- **Sheets are the schema. Match `Docs/Schema.md` exactly.** Sheet names are Title Case with spaces (mirrored in `Code.gs` `SHEET_*` constants). Headers sit in row 1, and code resolves columns by header name (`_val(row, headers, 'Column Name')`), never by index. You can rename a header or reorder columns, but keep the header strings in sync.
- **IDs** are auto-increment integers (`_nextRowId` = last ID + 1) in column 1. Foreign keys are numeric IDs, never names.
- **Dates**: pure dates use `M/d/yyyy`, timestamps use `M/d/yyyy HH:mm:ss`. Sheets coerce cells to `Date` objects, so read through `_readDateCell` / `_valDateTime` — a raw `Date` cannot serialize to JSON.
- **Booleans** are native sheet `TRUE`/`FALSE`. Compare with `=== true` / `=== 'TRUE'` defensively.
- **Billing Date is not Trip Date.** Trip Date is the calendar dispatch day. Billing Date is the original operational day and survives carry-overs, so fuel-price and rate indexing stay correct.
- **Snapshotting**: dispatch stamps `Truck Billing Category` onto the trip, so a later category rename does not re-price history.
- **Helpers** live as a comma-separated string of employee IDs in one cell (0–3 helpers). There is no sub-table.
- **Append-only logs**: Audit Log and Route Frequency Log. Do not mutate a prior row. Derive current state from the latest row.
- **Reading .xlsx cells** goes through `cellValue()` in `web/import.js`. Read a formula cell as `cell.result`, **not** `cell.value.result`: ExcelJS drops `result` when the cached number is 0, and the route file's TOTAL is a shared `SUM` that is 0 for every FO in a convoy. Lost zeros give each of those FOs its own truck.
- **Waybills** go from suggested (`Locked=FALSE`) to confirmed (`Locked=TRUE`, immutable). Suggestion reserves the number and bumps `Last Sequence Number`; confirmation bumps it again only for a higher custom number. Suffixes: `-R` redeliver, `-FT` foul trip.
- **Waybill numbering never depends on cell formatting.** `Last Sequence Number` is a plain number and the zero-pad width has its own `Sequence Width` column. Minting takes the script lock, reserves the sequence *before* it appends the row, and issues past `max(counter, highest sequence in the ledger)` — a counter that fails to write cannot re-issue a live number. Inferring the width from a padded text value is what froze the `AY` and `GL` booklets in production.
- **RBAC**: Admin / Dispatcher / Payroll / Viewer. Every sensitive writer calls `_requirePermission(...)`. The UI hides controls too, but **the server is the real gate**.
- **Identity** comes from a verified Google sign-in, not `Session.getActiveUser()`, which is blank outside the deployer's Workspace domain. `rpc()` sets `_REQUEST_EMAIL`; `_getCurrentUserEmail()` prefers it and falls back to `Session` only for the editor. A new client-callable function must join `RPC_ALLOWED` in `Auth.gs` or the browser cannot reach it. **Never trust an unverified ID token** — that is an auth bypass.
- **Audit every mutation**: `_auditLog(action, table, rowId, old, new)` with a vocabulary token from `Docs/Schema.md`. It is best-effort and never throws.
- **Writers run one at a time.** `rpc()` wraps every `'w'` function in `RPC_ALLOWED` in `_withLock`, which holds the script lock and calls `SpreadsheetApp.flush()` before release. The board fires saves in parallel (`bgSave`), so without this two executions read the same last row ID and overwrite each other — PROD grew two trips with ID 91 and one load split across three `-R` numbers. Mark a new writer `'w'`; leave a reader `'r'` so it does not queue behind an import. `_withLock` is re-entrant by depth guard.
- **Performance**: minimize `getDataRange().getValues()` round trips. Batch writes with `setValues` / `_writeRowFields` / `_appendRows`.
- **Timezone and access**: `appsscript.json` is `Asia/Shanghai` (UTC+8 = PH time). The web app runs `executeAs: USER_DEPLOYING` with `ANYONE_ANONYMOUS` access, so the Sheet stays private while sign-in establishes identity. Script Property `OAUTH_CLIENT_ID` needs the pages.dev hosts and `http://localhost:8788` as Authorized JavaScript origins.
- **CORS constrains the transport.** Apps Script cannot serve `OPTIONS`, so `callBackend()` must stay a *simple* request: POST, plain string body, **no headers**. A `Content-Type: application/json` header triggers a preflight and kills every call. `doPost` can never throw either — a thrown error returns an HTML page, not a status code, so failures come back as `{ok:false, error}`.

## Deploy, test, and local workflow

Full details in [`DEPLOY.md`](DEPLOY.md). The `.gs` backend goes to Apps Script through `clasp`; `web/` goes to Cloudflare Pages through `wrangler`.

- **Two environments**, each a Sheet plus its bound script. Day-to-day commands target **DEV**. Only the release command touches **PROD**, only from `main`, after the tag — a hook blocks it elsewhere.
- `npm run help` prints every script with its purpose. The usual ones: `npm test`, `npm run push`, `npm run deploy:dev`, `npm run fetch-data`, `npm run clear-data`.
- `.clasp.prod.json` / `.clasp.dev.json` hold the non-secret Script IDs. `.clasp.json` is a generated, gitignored pointer. `.claspignore` keeps `Docs/` out of Apps Script.
- `data/`, `.env`, `*.xlsx`, `*.pdf` are gitignored — they hold real operational data. `DEV_DUMP_TOKEN` in `.env` is password-equivalent.
- **Tests** live in `test/` and run on `node:test` with a `vm` shim — no clasp, no live Sheet, no install. See [`test/README.md`](test/README.md). Phase 1 is broadly covered. **Phase 2 has no code and no tests yet; write them together.** Frontend logic is testable through [`test/webharness.js`](test/webharness.js), which runs `web/*.js` against a stub DOM. The stub has no layout, so check anything visual in a browser.
- Add a test next to any backend logic you add. For anything the harness cannot cover, verify against a snapshot (`npm run fetch-data`) or a deployed copy.

## Working agreements

- A new feature usually walks this path: sheet or columns in `Docs/Schema.md` → constants in `Code.gs` → reader in `DataReaders.gs` → writer with `_requirePermission` and `_auditLog` in `DataWriters.gs` → the `web/*.js` panel and the `core.js` state and boot wiring. Keep the schema doc and the code in lockstep.
- Match the surrounding style: `_`-prefixed helpers are private, readers return camelCase objects, writers return `{ success, ... } | { success:false, error }`.
- Commit or push only when the owner asks.
- **Branching (solo dev)**: routine work commits straight to `develop` with Conventional Commit messages. Use a `feat/` or `fix/` branch only when a change is big or risky, then merge-commit it back. `main` stays production-only.
- Money, payroll, and billing logic are contractually sensitive. Favor correctness, date-locking, and an audit trail over cleverness.

## Automation (do not repeat this work by hand)

`.claude/settings.json` wires three hooks in [`scripts/claude-hooks.mjs`](scripts/claude-hooks.mjs):

- **SessionStart** prints `HANDOFF.md` when it exists, so a fresh session resumes without being told.
- **Stop** runs `npm test` when a `.gs`/`.js`/`.mjs` file changed in the turn, and blocks on a failure.
- **PreToolUse** blocks a PROD deploy from any branch except `main`.

The `/release` skill (`.claude/skills/release/`) holds the release runbook and the dispatcher release-note rules. Commit and PR attribution lines are already off in the user settings — never add one by hand.

## Session handoff (HANDOFF.md)

Long conversations burn uncached tokens, so the owner may clear context whenever you wait on them. **Before you end a turn that needs human input** — a question, an approval, a review — write `HANDOFF.md` at the repo root (gitignored, overwrite freely). The SessionStart hook reads it back. Delete it once it is resolved. It must carry:

- **Task & goal** — the ask, in one or two sentences.
- **State** — what is done and verified (branch, commits, files, test results), and what is in flight.
- **Blocked on** — the exact decision the human owes, with the options and your recommendation.
- **Next steps** — the precise actions, with file paths.
- **Gotchas** — what a fresh session would otherwise re-derive.
