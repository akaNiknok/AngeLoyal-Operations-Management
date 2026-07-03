# CLAUDE.md — AngeLoyal Operations Management System (OMS)

Context for future Claude sessions. Read this first; it should save you from re-deriving the architecture every time.

## What this is

A web-based Operations Management System for **AngeLoyal Logistics**, a Philippine trucking/logistics subcontractor that hauls for Rebisco. It replaces manual Excel + group-chat workflows for dispatch scheduling, waybill tracking, billing, driver payroll, and proof-of-delivery (POD) tracking.

It is a **Google Apps Script web app**: the backend (`.gs`) runs on Apps Script, the frontend is a single-page app assembled from `.html` partials, and **Google Sheets is the database**. There is no server, no SQL, no build step.

The full feature set, pricing, and contractual scope live in [`Docs/Project Proposal.md`](Docs/Project%20Proposal.md). The authoritative data model is [`Docs/Schema.md`](Docs/Schema.md) — **always reconcile changes against it.** Background interviews are also available in `Docs/` — treat these as rough transcriptions, confirm if unsure of details.

## Project phases (this drives the backlog)

The project is contractually delivered in 3 phases. See [`BACKLOG.md`](BACKLOG.md) for the itemized, GitHub-issue-ready backlog.

- **Phase 1 — Records, Dispatch, Waybills** *(largely BUILT)*: digital records for employees/trucks/outlets, daily dispatch board, Rebisco route-file import, waybill auto-generation/confirmation, truck roster, RBAC, admin panels.
- **Phase 2 — Billing & Payroll** *(NOT STARTED)*: DOE freight-rate matrix with date-locked rates, semi-automated billing (Mano fee, split-load farthest-area rule, batch export in Rebisco format), driver payroll (trips, night diff, absences, SSS/PhilHealth/Pag-IBIG, 13th month, payslips).
- **Phase 3 — Visibility & Alerts** *(NOT STARTED)*: POD status tracking with status-change logging and business-day aging/highlighting, management dashboard, exportable billing/payroll reports, driver route history.

**Backlog source of truth is the GitHub Project board** (lead dev + QA work there). `BACKLOG.md` is a generated, gitignored snapshot — read it for a quick status overview, but for live status/detail use `gh` (`gh issue list --json number,title,state,labels`, `gh issue view <n>`) when available. If `BACKLOG.md` is missing (fresh clone), regenerate it with `npm run backlog:sync -- --apply --project 2 --owner akaNiknok`. When you finish or start work that shifts phase status, update this section.

## Architecture

### Backend (`.gs` files, run on Apps Script, V8 runtime)

| File | Responsibility |
| :--- | :--- |
| `Code.gs` | Entry point. Sheet-name constants, RBAC (`ROLES`, `PERMISSIONS`, `_requirePermission`), request-scoped identity (`_REQUEST_EMAIL`, `_getCurrentUserEmail`), `doGet` web-app router, `include()` template helper. |
| `Auth.gs` | Google sign-in + session layer. `getLoginUrl()` builds the OAuth consent URL; `_handleOAuthCallback()` (driven by `doGet`) exchanges the code and reads the identity from the ID token (`_identityFromIdToken`); session tokens are minted/looked up in `CacheService` (`_createSession`/`logout`); and the **`rpc(sessionToken, fnName, args)` gateway** (allow-list `RPC_ALLOWED`) that every authenticated client call funnels through. `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` live in Script Properties. |
| `Utils.gs` | Generic sheet/row helpers: `_getSheet`, `_val`, `_numOrNull`, date parsing/formatting, `_nextRowId`, `_findRowById`, `_writeRowFields`, `_indexById`. **Reuse these — don't hand-roll sheet access.** |
| `DataReaders.gs` | Read-only accessors. `getBootData()` returns all master data in one round trip. `getDispatchBoardData()`, `getTrips()`, `getWaybillsForTrip()`, etc. |
| `DataWriters.gs` | All sheet-mutating endpoints (`createTrip`, `saveTripChanges`, `confirmWaybill`, `importRouteFile`, `createOutlet/Truck/Employee/BillingCategory`, roster `updateDefaultAssignment`, …). Largest file. |
| `Internals.gs` | Private helpers for writers: `_auditLog`, waybill suggestion logic, carry-over trip creation, outlet resolve-or-create, route-frequency append, billing-category rename cascade. |
| `DevTools.gs` | Token-gated `_devDump` JSON export for local data snapshots. Not in the UI. |

### Frontend (`.html` files, concatenated into one page)

`Index.html` is the shell (markup + nav). At render time Apps Script inlines the partials via `<?!= include('Name'); ?>`:

- `Styles.html` — all CSS (DM Sans/DM Mono, design tokens).
- `Core.html` — global JS state (`employees`, `trucks`, `dispatchData`, …), `bootApp()` boot sequence, RBAC UI gating, panel switching, shared utilities, SheetJS (XLSX) CDN loader.
- `Dispatch.html` — dispatch board (the primary screen).
- `Import.html` — Rebisco `.xlsx` route-file parsing + import.
- `Roster.html` — truck roster (driver/helper ↔ truck assignment; edits Default Assignments) + Outlets admin.
- `Masters.html` — admin master-detail panels (outlets, trucks, employees, billing categories, default assignments).

The client calls the backend with `google.script.run.withSuccessHandler(...).fnName(args)`. There is **no router/framework** — `switchPanel()` toggles `.panel` visibility, state lives in module-level `let` globals in `Core.html`.

### Data flow

1. Sign-in is a **server-side OAuth redirect flow** (not GIS — the sandbox iframe origin can't be registered). The "Sign in with Google" link (`getLoginUrl()`) navigates the top window to Google; Google redirects back to the web app URL with `?code=`, which `doGet` exchanges (`_handleOAuthCallback`) for a session, injecting the session token into the served page (`window.__OMS_BOOT_TOKEN`). `bootApp()` adopts it and stores it in `localStorage`; a stored token is reused on reload.
2. Every authenticated client call goes through the client helper **`srv()`**, which mirrors the `google.script.run` builder but routes to the backend **`rpc(sessionToken, fnName, args)`** gateway. `rpc` resolves the session → sets `_REQUEST_EMAIL` → dispatches. `getLoginUrl`/`logout` are the only calls made with raw `google.script.run` (no session yet).
3. After sign-in, `getBootData()` returns session + all master data (or **just the session** if the verified user has no role) → cached in `Core.html` globals.
4. Dispatch board calls `getDispatchBoardData(date)`; display fields (outlet/driver/truck names) are **derived client-side** from cached master data via `indexById()` — the server intentionally does not re-send them.
5. Writes go through `DataWriters.gs`, which enforce permissions, write to the sheet, and append to the Audit Log.

## Critical constraints & conventions

- **Sheets are the schema. Match `Docs/Schema.md` exactly** — sheet names are Title Case with spaces (mirrored in `Code.gs` `SHEET_*` constants), headers in row 1 are Title Case with spaces, and code resolves columns *by header name* (`_val(row, headers, 'Column Name')`), not by index. Renaming a header or reordering columns is safe in code but you must keep header strings in sync.
- **IDs** are auto-increment integers (`_nextRowId` = last ID + 1), column 1. **Foreign keys are numeric IDs**, never names.
- **Dates**: pure dates use `M/d/yyyy`; timestamps use `M/d/yyyy HH:mm:ss`. Sheets may auto-coerce cells to `Date` objects — read via `_readDateCell` / `_valDateTime` (raw `Date` objects can't serialize over `google.script.run`).
- **Booleans** are native sheet `TRUE`/`FALSE`; compare with `=== true` / `=== 'TRUE'` defensively.
- **Billing Date vs Trip Date**: Trip Date is the calendar dispatch day; Billing Date is the original operational day and is *preserved across carry-overs* so fuel-price/rate indexing stays correct. Don't conflate them.
- **Snapshotting**: `Truck Billing Category` is stamped onto each trip at dispatch so later category renames don't re-price historical trips.
- **Helpers** are stored as a comma-separated string of employee IDs in one cell (0–3 helpers), parsed in code — not a relational sub-table.
- **Append-only logs**: Audit Log, Route Frequency Log. Don't mutate prior rows; derive current state by reducing to the latest row.
- **Waybills**: suggested (`Locked=FALSE`) → confirmed (`Locked=TRUE`, immutable). Confirmation bumps `Last Sequence Number` on the prefix. Suffixes: `-R` (redeliver), `-FT` (foul trip).
- **RBAC**: roles are Admin / Dispatcher / Payroll / Viewer. Every sensitive writer must call `_requirePermission(...)`. The UI also hides controls, but **the server is the real gate** — never trust client-side gating alone.
- **Identity**: the visitor's email comes from a **verified Google sign-in (server-side OAuth code flow)**, not `Session.getActiveUser()` (which is blank for anyone outside the deployer's Workspace domain under `executeAs: me` + anonymous access). `rpc()` sets `_REQUEST_EMAIL` from the session; `_getCurrentUserEmail()` prefers it and falls back to `Session` only for the editor/owner. New client-callable backend functions must be added to `RPC_ALLOWED` in `Auth.gs` or they're unreachable from the browser.
- **Audit everything that mutates**: call `_auditLog(action, table, rowId, old, new)` with a vocabulary token from `Docs/Schema.md`. It's best-effort and never throws.
- **Performance**: minimize `getDataRange().getValues()` round trips; batch writes with `setValues`/`_writeRowFields`/`_appendRows` rather than per-cell.
- **Timezone**: `appsscript.json` is `Asia/Shanghai` (UTC+8 = PH time). Web app runs `executeAs: USER_DEPLOYING`, access `ANYONE_ANONYMOUS` — so the Sheet stays private (runs as the owner) while identity is established by Google OAuth sign-in (see **Identity** above) and matched against the Users sheet. Requires Script Properties `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` (an OAuth Web client) with the web app's `/exec` (and `/dev`) URLs registered as **Authorized redirect URIs**.

## Deploy & local workflow

Full details in [`DEPLOY.md`](DEPLOY.md). The repo is wired to Apps Script via [`clasp`](https://github.com/google/clasp); `.gs`/`.html`/`appsscript.json` are the source of truth.

```sh
npm run push      # push to the Apps Script editor (dev/HEAD only)
npm run release   # push --force + redeploy the LIVE web app  ← ONLY from main
npm run open      # open the script editor
npm test          # run local test suite (no clasp, no live Sheet, no npm install)
npm run fetch-data         # snapshot live sheets → data/ (gitignored, real data)
```

> The live app is served from a **versioned deployment**, not HEAD. `npm run push` alone does NOT update what users see. Going live = a tagged release from `main` followed by `npm run release` — never run it from `develop` or a feature branch (see the gitflow section in [`DEPLOY.md`](DEPLOY.md#git-workflow-gitflow)).

- `.clasp.json` holds the (non-secret) Script ID. `.claspignore` keeps `Docs/` and sample files out of Apps Script.
- `data/`, `.env`, `*.xlsx`, `*.pdf` are gitignored — they contain real operational data. `DEV_DUMP_TOKEN` (in `.env`) is a password-equivalent.
- **Automated tests** live in `test/` and run with `npm test` (Node's built-in `node:test` + a `vm` shim — no clasp, no live Sheet, no `npm install`). The harness loads the `.gs` bundle with in-memory fakes for `SpreadsheetApp`/`Session`/`Utilities`; see [`test/README.md`](test/README.md). Phase 1 (records, dispatch, waybills) is broadly covered — Utils helpers, RBAC matrix, waybill numbering/confirmation, carry-over trips, `createTrip`/`saveTripChanges`, `importRouteFile`, master-record CRUD + roster, and the dispatch/read path. **Phase 2 (billing/payroll) is not built yet — write its tests alongside the code.** For anything not covered, still verify by snapshotting live data (`npm run fetch-data`) and/or testing in a deployed copy. When you add backend logic, add a test next to it.

## Working agreements

- Keep the schema doc and code in lockstep. A new feature usually means: a new sheet/columns in `Docs/Schema.md` → constants in `Code.gs` → reader in `DataReaders.gs` → writer (+ `_requirePermission` + `_auditLog`) in `DataWriters.gs` → UI partial + `Core.html` state/boot wiring.
- Match the surrounding style: the `_`-prefixed helpers are private; reader functions return plain objects with camelCase keys; writers return `{ success, ... } | { success:false, error }`.
- Only commit/push when asked.
- **Gitflow**: one feature branch per task (`feat/<task>`, `fix/<task>`) off updated `develop`, **merge commit** PRs back into `develop` (Conventional Commits on branch commits). `main` is production-only: release merges from `develop` and `hotfix/*` branches, each tagged `vX.Y.Z` + GitHub Release, then `npm run release`. Versioning: major = phase, minor = feature release, patch = hotfix. Full steps in [`DEPLOY.md`](DEPLOY.md#git-workflow-gitflow).
- Money, payroll, and billing logic are contractually sensitive and Phase 2's hardest part — favor correctness, date-locking, and an audit trail over cleverness.

## Session handoff (HANDOFF.md)

Long conversations burn uncached tokens; the user may clear context and start a fresh session at any point where you're waiting on them. So: **whenever you end a turn needing human input** — a question, an approval, a review of finished work, or acting on subagent results — **write `HANDOFF.md` at the repo root first** (gitignored, overwrite freely). It must let a zero-context session resume without this conversation:

- **Task & goal** — what was asked, in one or two sentences.
- **State** — what's done and verified (branch, commits, files touched, test results), what's in flight.
- **Blocked on** — the exact question/decision the human owes, with the options and your recommendation.
- **Next steps** — the precise actions to take once unblocked, with file paths.
- **Gotchas** — anything non-obvious learned this session that a fresh session would re-derive.

At session start, if `HANDOFF.md` exists, read it and treat it as the resume point; delete it once its contents are absorbed or resolved.
