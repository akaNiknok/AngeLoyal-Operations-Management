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
| `Code.gs` | Entry point. Sheet-name constants, RBAC (`ROLES`, `PERMISSIONS`, `_requirePermission`), `doGet` web-app router, `include()` template helper. |
| `Utils.gs` | Generic sheet/row helpers: `_getSheet`, `_val`, `_numOrNull`, date parsing/formatting, `_nextRowId`, `_findRowById`, `_writeRowFields`, `_indexById`. **Reuse these — don't hand-roll sheet access.** |
| `DataReaders.gs` | Read-only accessors. `getBootData()` returns all master data in one round trip. `getDispatchBoardData()`, `getTrips()`, `getWaybillsForTrip()`, etc. |
| `DataWriters.gs` | All sheet-mutating endpoints (`createTrip`, `saveTripChanges`, `confirmWaybill`, `importRouteFile`, `createOutlet/Truck/Employee/BillingCategory`, roster `saveAssignment`/`removeAssignment`, …). Largest file. |
| `Internals.gs` | Private helpers for writers: `_auditLog`, waybill suggestion logic, carry-over trip creation, outlet resolve-or-create, route-frequency append, billing-category rename cascade. |
| `DevTools.gs` | Token-gated `_devDump` JSON export for local data snapshots. Not in the UI. |

### Frontend (`.html` files, concatenated into one page)

`Index.html` is the shell (markup + nav). At render time Apps Script inlines the partials via `<?!= include('Name'); ?>`:

- `Styles.html` — all CSS (DM Sans/DM Mono, design tokens).
- `Core.html` — global JS state (`employees`, `trucks`, `dispatchData`, …), `bootApp()` boot sequence, RBAC UI gating, panel switching, shared utilities, SheetJS (XLSX) CDN loader.
- `Dispatch.html` — dispatch board (the primary screen).
- `Import.html` — Rebisco `.xlsx` route-file parsing + import.
- `Roster.html` — truck roster (driver/helper ↔ truck assignment).
- `Masters.html` — admin master-detail panels (outlets, trucks, employees, billing categories, default assignments).

The client calls the backend with `google.script.run.withSuccessHandler(...).fnName(args)`. There is **no router/framework** — `switchPanel()` toggles `.panel` visibility, state lives in module-level `let` globals in `Core.html`.

### Data flow

1. Page load → `doGet` serves `Index` → `bootApp()` calls `getBootData()` once for session + all master data → cached in `Core.html` globals.
2. Dispatch board calls `getDispatchBoardData(date)`; display fields (outlet/driver/truck names) are **derived client-side** from cached master data via `indexById()` — the server intentionally does not re-send them.
3. Writes go through `DataWriters.gs`, which enforce permissions, write to the sheet, and append to the Audit Log.

## Critical constraints & conventions

- **Sheets are the schema. Match `Docs/Schema.md` exactly** — sheet names are Title Case with spaces (mirrored in `Code.gs` `SHEET_*` constants), headers in row 1 are Title Case with spaces, and code resolves columns *by header name* (`_val(row, headers, 'Column Name')`), not by index. Renaming a header or reordering columns is safe in code but you must keep header strings in sync.
- **IDs** are auto-increment integers (`_nextRowId` = last ID + 1), column 1. **Foreign keys are numeric IDs**, never names.
- **Dates**: pure dates use `M/d/yyyy`; timestamps use `M/d/yyyy HH:mm:ss`. Sheets may auto-coerce cells to `Date` objects — read via `_readDateCell` / `_valDateTime` (raw `Date` objects can't serialize over `google.script.run`).
- **Booleans** are native sheet `TRUE`/`FALSE`; compare with `=== true` / `=== 'TRUE'` defensively.
- **Billing Date vs Trip Date**: Trip Date is the calendar dispatch day; Billing Date is the original operational day and is *preserved across carry-overs* so fuel-price/rate indexing stays correct. Don't conflate them.
- **Snapshotting**: `Truck Billing Category` is stamped onto each trip at dispatch so later category renames don't re-price historical trips.
- **Helpers** are stored as a comma-separated string of employee IDs in one cell (0–3 helpers), parsed in code — not a relational sub-table.
- **Append-only logs**: Audit Log, Route Frequency Log, Employee-Truck Assignment. Don't mutate prior rows; derive current state by reducing to the latest row (e.g. `getCurrentAssignments()`).
- **Waybills**: suggested (`Locked=FALSE`) → confirmed (`Locked=TRUE`, immutable). Confirmation bumps `Last Sequence Number` on the prefix. Suffixes: `-R` (redeliver), `-FT` (foul trip).
- **RBAC**: roles are Admin / Dispatcher / Payroll / Viewer. Every sensitive writer must call `_requirePermission(...)`. The UI also hides controls, but **the server is the real gate** — never trust client-side gating alone.
- **Audit everything that mutates**: call `_auditLog(action, table, rowId, old, new)` with a vocabulary token from `Docs/Schema.md`. It's best-effort and never throws.
- **Performance**: minimize `getDataRange().getValues()` round trips; batch writes with `setValues`/`_writeRowFields`/`_appendRows` rather than per-cell.
- **Timezone**: `appsscript.json` is `Asia/Shanghai` (UTC+8 = PH time). Web app runs `executeAs: USER_DEPLOYING`, access `ANYONE_ANONYMOUS` (RBAC is enforced in-app against the Users sheet via the active user's email).

## Deploy & local workflow

Full details in [`DEPLOY.md`](DEPLOY.md). The repo is wired to Apps Script via [`clasp`](https://github.com/google/clasp); `.gs`/`.html`/`appsscript.json` are the source of truth.

```sh
npm run push      # push to the Apps Script editor (dev/HEAD only)
npm run release   # push --force + redeploy the LIVE web app  ← use to go live
npm run open      # open the script editor
npm run fetch-data         # snapshot live sheets → data/ (gitignored, real data)
```

> The live app is served from a **versioned deployment**, not HEAD. `npm run push` alone does NOT update what users see — run `npm run release`.

- `.clasp.json` holds the (non-secret) Script ID. `.claspignore` keeps `Docs/` and sample files out of Apps Script.
- `data/`, `.env`, `*.xlsx`, `*.pdf` are gitignored — they contain real operational data. `DEV_DUMP_TOKEN` (in `.env`) is a password-equivalent.
- **There are no automated tests.** Verify by snapshotting live data (`npm run fetch-data`) and/or testing in a deployed copy. Don't assume; check.

## Working agreements

- Keep the schema doc and code in lockstep. A new feature usually means: a new sheet/columns in `Docs/Schema.md` → constants in `Code.gs` → reader in `DataReaders.gs` → writer (+ `_requirePermission` + `_auditLog`) in `DataWriters.gs` → UI partial + `Core.html` state/boot wiring.
- Match the surrounding style: the `_`-prefixed helpers are private; reader functions return plain objects with camelCase keys; writers return `{ success, ... } | { success:false, error }`.
- Only commit/push when asked.
- Money, payroll, and billing logic are contractually sensitive and Phase 2's hardest part — favor correctness, date-locking, and an audit trail over cleverness.
