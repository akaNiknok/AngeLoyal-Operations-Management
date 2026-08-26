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
| `Code.gs` | Entry point. Sheet-name constants, RBAC (`ROLES`, `PERMISSIONS`, `_requirePermission`), request-scoped identity (`_REQUEST_EMAIL`, `_getCurrentUserEmail`), the **`doPost` JSON API** the frontend calls (`_jsonOut`), and `doGet`, which now only keeps the dev endpoints and redirects to the frontend (`_frontendUrl`). |
| `Auth.gs` | Google sign-in + session layer. `login(idToken)` is the one pre-session action: `_verifyIdToken` checks the browser-supplied GIS token against Google's tokeninfo endpoint (**never a local decode**) before `_createSession` mints a token in `CacheService`; and the **`rpc(sessionToken, fnName, args)` gateway** (allow-list `RPC_ALLOWED`) that every other client call funnels through. `OAUTH_CLIENT_ID` lives in Script Properties — there is no client secret. |
| `Utils.gs` | Generic sheet/row helpers: `_getSheet`, `_val`, `_numOrNull`, date parsing/formatting, `_nextRowId`, `_findRowById`, `_writeRowFields`, `_indexById`. Also the master-record writer envelope every CRUD endpoint is built on — `_openSheet`, `_openRow`, `_readFields`, `_writerResult`, `_requireUnique`. **Reuse these — don't hand-roll sheet access.** |
| `DataReaders.gs` | Read-only accessors. `getBootData()` returns all master data in one round trip. `getDispatchBoardData()`, `getTrips()`, `getWaybillsForTrip()`, etc. |
| `DataWriters.gs` | All sheet-mutating endpoints (`createTrip`, `saveTripChanges`, `confirmWaybill`, `importRouteFile`, `createOutlet/Truck/Employee/BillingCategory`, roster `updateDefaultAssignment`, …). Largest file. |
| `Internals.gs` | Private helpers for writers: `_auditLog`, waybill suggestion logic, carry-over trip creation, outlet resolve-or-create, route-frequency append, billing-category rename cascade. |
| `DevTools.gs` | Token-gated `_devDump` JSON export for local data snapshots. Not in the UI. |

### Frontend (`web/`, a static site on Cloudflare Pages)

The frontend is **not** served by Apps Script. It is plain static files deployed
to Cloudflare Pages; `.gs` stays on Apps Script and is reached over HTTP. No
bundler, no framework, no build step — `web/index.html` loads the scripts in
dependency order and that is the whole "build".

- `web/index.html` — the shell (markup + nav) and the script/style tags.
- `web/config.js` — `location.hostname` → `/exec` URL map, plus `OAUTH_CLIENT_ID`. An unknown host falls back to DEV, never prod.
- `web/styles.css` — all CSS (DM Sans/DM Mono, design tokens).
- `web/core.js` — global JS state (`employees`, `trucks`, `dispatchData`, …), `bootApp()` boot sequence, the `call()`/`callBackend()` transport, GIS sign-in, RBAC UI gating, panel switching, shared utilities.
- `web/dispatch.js` — dispatch board (the primary screen).
- `web/export.js` — client-only exports of a dispatch day: FINAL-ROUTE print/xlsx (mirrors the dispatcher-worked route-file layout) and "Share to Drivers" per-truck .jpg cards (modal markup lives in `web/index.html`).
- `web/crewboard.js` — crew rail: toggled panel of draggable crew cards (truck + default driver/helpers) dropped onto dispatch rows to assign a whole crew at once.
- `web/import.js` — Rebisco `.xlsx` route-file parsing + import.
- `web/roster.js` — truck roster (driver/helper ↔ truck assignment; edits Default Assignments) + Outlets admin.
- `web/masters.js` — admin master-detail panels (outlets, trucks, employees, billing categories, route type map, default assignments) plus the Waybill Prefixes panel (Admin **and** Dispatcher — gated by `EDIT_WAYBILL_PREFIXES` / the `dispatcher-only` nav class). Also holds the **Admin** panel's danger zone — an Admin-only "clear all data" that wipes *this environment's* transactional sheets via `clearAllData()` behind a typed confirmation phrase.
- `web/whatsnew.js` + `web/changelog.json` — the "What's new?" dialog and its content. The JSON is generated from the GitHub Releases by `npm run changelog:sync -- --apply` at release time (the repo is private, so the browser can't read the API itself). Release notes are written for dispatchers, not developers — see [DEPLOY.md](DEPLOY.md#releases-tags--github-releases).
- `web/vendor/` — SheetJS, ExcelJS, html2canvas, pinned and served from our own origin so the CSP can refuse every third-party script.
- `web/_headers` — Cloudflare Pages response headers: CSP, `X-Frame-Options: DENY`, nosniff.

The client calls the backend with `call('fnName', ...args)`, which returns a
promise (see `web/core.js`); `toastError` is the shared rejection handler and
`bgSave()` wraps the optimistic-save pattern.
There is **no router/framework** — `switchPanel()` toggles `.panel` visibility,
state lives in module-level `let` globals in `web/core.js`.

The public launcher page (a redirect to the frontend, nothing else) is **not in
this repo** — it lives in the separate `angeloyal-oms-launcher` repo, which is
its only copy. It stays the link handed to operators through the Cloudflare
account handover, so the pages.dev URL underneath can change without re-teaching
anyone. See [DEPLOY.md](DEPLOY.md#the-account-launcher-page) before touching it.

### Data flow

1. Sign-in is **Google Identity Services (GIS)**. The page is served from our own origin now, so the GIS button renders inline; its callback POSTs the Google ID token to `login()`, which **verifies it against Google's tokeninfo endpoint** (never a local decode — the token comes from the browser) and returns an app session token. `core.js` stores it in `localStorage` and reuses it on reload.
2. Every authenticated client call goes through **`call(fnName, ...args)`**, which POSTs `{token, fn, args}` to `doPost` → **`rpc(sessionToken, fnName, args)`** and returns a promise. It absorbs `AUTH_REQUIRED` centrally (re-prompts sign-in, settles neither handler), so call sites only handle real failures. `rpc` resolves the session → sets `_REQUEST_EMAIL` → dispatches. `login` is the only pre-session action; everything else, `logout` included, goes through `rpc`.
3. After sign-in, `getBootData()` returns session + all master data (or **just the session** if the verified user has no role) → cached in `core.js` globals.
4. Dispatch board calls `getDispatchBoardData(date)`; display fields (outlet/driver/truck names) are **derived client-side** from cached master data via `indexById()` — the server intentionally does not re-send them.
5. Writes go through `DataWriters.gs`, which enforce permissions, write to the sheet, and append to the Audit Log.

## Critical constraints & conventions

- **Sheets are the schema. Match `Docs/Schema.md` exactly** — sheet names are Title Case with spaces (mirrored in `Code.gs` `SHEET_*` constants), headers in row 1 are Title Case with spaces, and code resolves columns *by header name* (`_val(row, headers, 'Column Name')`), not by index. Renaming a header or reordering columns is safe in code but you must keep header strings in sync.
- **IDs** are auto-increment integers (`_nextRowId` = last ID + 1), column 1. **Foreign keys are numeric IDs**, never names.
- **Dates**: pure dates use `M/d/yyyy`; timestamps use `M/d/yyyy HH:mm:ss`. Sheets may auto-coerce cells to `Date` objects — read via `_readDateCell` / `_valDateTime` (raw `Date` objects can't serialize to JSON over the API).
- **Booleans** are native sheet `TRUE`/`FALSE`; compare with `=== true` / `=== 'TRUE'` defensively.
- **Billing Date vs Trip Date**: Trip Date is the calendar dispatch day; Billing Date is the original operational day and is *preserved across carry-overs* so fuel-price/rate indexing stays correct. Don't conflate them.
- **Snapshotting**: `Truck Billing Category` is stamped onto each trip at dispatch so later category renames don't re-price historical trips.
- **Helpers** are stored as a comma-separated string of employee IDs in one cell (0–3 helpers), parsed in code — not a relational sub-table.
- **Append-only logs**: Audit Log, Route Frequency Log. Don't mutate prior rows; derive current state by reducing to the latest row.
- **Waybills**: suggested (`Locked=FALSE`) → confirmed (`Locked=TRUE`, immutable). Suggestion *reserves* the number and bumps `Last Sequence Number` on the prefix; confirmation bumps it further only for a higher custom number. Suffixes: `-R` (redeliver), `-FT` (foul trip).
- **Waybill numbering never depends on cell formatting.** `Last Sequence Number` is a plain number and the zero-pad width lives in its own `Sequence Width` column. Minting takes the script lock, reserves the sequence *before* appending the waybill row, and issues past `max(counter, highest sequence already in the Waybills ledger)` — so a counter that fails to write can't re-issue a live number. Inferring the width from a padded text value is what silently froze the `AY` and `GL` booklets in production.
- **RBAC**: roles are Admin / Dispatcher / Payroll / Viewer. Every sensitive writer must call `_requirePermission(...)`. The UI also hides controls, but **the server is the real gate** — never trust client-side gating alone.
- **Identity**: the visitor's email comes from a **verified Google sign-in (GIS ID token, checked server-side)**, not `Session.getActiveUser()` (which is blank for anyone outside the deployer's Workspace domain under `executeAs: me` + anonymous access). `rpc()` sets `_REQUEST_EMAIL` from the session; `_getCurrentUserEmail()` prefers it and falls back to `Session` only for the editor/owner. New client-callable backend functions must be added to `RPC_ALLOWED` in `Auth.gs` or they're unreachable from the browser. **Never trust an ID token without verifying it** — `_verifyIdToken` exists because a browser-supplied token that is merely decoded is an auth bypass.
- **Audit everything that mutates**: call `_auditLog(action, table, rowId, old, new)` with a vocabulary token from `Docs/Schema.md`. It's best-effort and never throws.
- **Performance**: minimize `getDataRange().getValues()` round trips; batch writes with `setValues`/`_writeRowFields`/`_appendRows` rather than per-cell.
- **Timezone**: `appsscript.json` is `Asia/Shanghai` (UTC+8 = PH time). Web app runs `executeAs: USER_DEPLOYING`, access `ANYONE_ANONYMOUS` — so the Sheet stays private (runs as the owner) while identity is established by Google sign-in (see **Identity** above) and matched against the Users sheet. Requires Script Property `OAUTH_CLIENT_ID` (an OAuth Web client) with the frontend's origins — the pages.dev hosts and `http://localhost:8788` — registered as **Authorized JavaScript origins**. There is no client secret any more.
- **CORS is the constraint on the transport**: Apps Script cannot serve `OPTIONS`, so `callBackend()` must stay a *simple* request — POST, plain string body, **no headers**. Adding a `Content-Type: application/json` header triggers a preflight and kills every call. `doPost` likewise can never throw: a thrown error becomes an HTML page, not a status code, so failures come back as `{ok:false, error}`.

## Deploy & local workflow

Full details in [`DEPLOY.md`](DEPLOY.md). Two halves: the `.gs` backend goes to Apps Script via [`clasp`](https://github.com/google/clasp), and `web/` goes to Cloudflare Pages via [`wrangler`](https://developers.cloudflare.com/workers/wrangler/). Both are pushed by `deploy:dev` / `release`.

There are **two environments** — two Sheets, each with its own bound Apps Script project (see [Environments in DEPLOY.md](DEPLOY.md#environments-prod-vs-dev)). Day-to-day commands target **DEV**; only `npm run release` touches **PROD**.

```sh
npm run push        # push to the DEV script's editor/HEAD (never touches prod)
npm run deploy:dev  # push + update the DEV /exec deployment (for clear-data/fetch-data --dev)
npm run release     # push --force + redeploy the LIVE (PROD) web app  ← ONLY from main
npm run open        # open the DEV script editor (open:prod for PROD)
npm test            # run local test suite (no clasp, no live Sheet, no npm install)
npm run fetch-data          # snapshot live PROD sheets → data/ (gitignored, real data); -- --dev for DEV
npm run clear-data          # DEV: wipe transactional sheets (Trips, Outlets, waybills, logs)
npm run clear-data:prod     # PROD: same, but requires typing "PRODUCTION" to confirm (post-release only)
```

> The live app is served from a **versioned deployment** on the PROD script. `npm run push` only updates DEV. Going live = a tagged release from `main` followed by `npm run release` — never run it from `develop` or a feature branch (see the gitflow section in [`DEPLOY.md`](DEPLOY.md#git-workflow-gitflow)).

- `.clasp.prod.json` / `.clasp.dev.json` hold the (non-secret) Script IDs; `.clasp.json` is a gitignored generated pointer (each npm command selects its env first via `use:dev`/`use:prod`). `.claspignore` keeps `Docs/` and sample files out of Apps Script.
- `data/`, `.env`, `*.xlsx`, `*.pdf` are gitignored — they contain real operational data. `DEV_DUMP_TOKEN` (in `.env`) is a password-equivalent.
- **Automated tests** live in `test/` and run with `npm test` (Node's built-in `node:test` + a `vm` shim — no clasp, no live Sheet, no `npm install`). The harness loads the `.gs` bundle with in-memory fakes for `SpreadsheetApp`/`Session`/`Utilities`; see [`test/README.md`](test/README.md). Phase 1 (records, dispatch, waybills) is broadly covered — Utils helpers, RBAC matrix, waybill numbering/confirmation, carry-over trips, `createTrip`/`saveTripChanges`, `importRouteFile`, master-record CRUD + roster, and the dispatch/read path. **Phase 2 (billing/payroll) is not built yet — write its tests alongside the code.** For anything not covered, still verify by snapshotting live data (`npm run fetch-data`) and/or testing in a deployed copy. When you add backend logic, add a test next to it.
- **Frontend logic is testable too**, via [`test/webharness.js`](test/webharness.js) — it runs `web/*.js` in the same `vm` style with a stub DOM (`loadWeb(['core.js', 'dispatch.js'], overrides, expose)`). Covered so far: the `call()` transport, the admin-record plumbing, the trip-status vocabulary, and the row-reorder transition. It is deliberately a *logic* harness — the stub DOM has no layout, so anything that depends on real rendering has to be checked in a browser.

## Working agreements

- Keep the schema doc and code in lockstep. A new feature usually means: a new sheet/columns in `Docs/Schema.md` → constants in `Code.gs` → reader in `DataReaders.gs` → writer (+ `_requirePermission` + `_auditLog`) in `DataWriters.gs` → the relevant `web/*.js` panel + `web/core.js` state/boot wiring.
- Match the surrounding style: the `_`-prefixed helpers are private; reader functions return plain objects with camelCase keys; writers return `{ success, ... } | { success:false, error }`.
- Only commit/push when asked.
- PR descriptions must not include a "🤖 Generated with Claude Code" line or Claude Code attribution.
- **Branching (solo dev)**: routine work commits straight to `develop` with Conventional Commit messages — no feature branch or PR needed. Reach for a `feat/<task>` / `fix/<task>` branch only when a change is big or risky enough to want it isolated (then merge-commit it back into `develop`). `main` stays production-only: release by merging `develop` (or a `hotfix/*` branch) into `main`, tag `vX.Y.Z` + GitHub Release, then `npm run release`. Versioning: major = phase, minor = feature release, patch = hotfix. Full steps in [`DEPLOY.md`](DEPLOY.md#git-workflow-gitflow).
- **Release notes are user-facing.** The GitHub Release body is pulled into `web/changelog.json` (`npm run changelog:sync -- --apply`) and shown verbatim to dispatchers in the app's "What's new?" dialog. Write it for them — what changed in their day, no commit lists, no file names, no jargon — then commit the regenerated JSON before `npm run release`. Write the notes in **ASD-STE100 Simplified Technical English**: active voice, present tense, one meaning per word, ≤20-word sentences, one idea per bullet, on-screen labels for names, no idioms. The readers are ESL dispatchers on a phone. Full rules in [DEPLOY.md](DEPLOY.md#releases-tags--github-releases).
- Money, payroll, and billing logic are contractually sensitive and Phase 2's hardest part — favor correctness, date-locking, and an audit trail over cleverness.

## Session handoff (HANDOFF.md)

Long conversations burn uncached tokens; the user may clear context and start a fresh session at any point where you're waiting on them. So: **whenever you end a turn needing human input** — a question, an approval, a review of finished work, or acting on subagent results — **write `HANDOFF.md` at the repo root first** (gitignored, overwrite freely). It must let a zero-context session resume without this conversation:

- **Task & goal** — what was asked, in one or two sentences.
- **State** — what's done and verified (branch, commits, files touched, test results), what's in flight.
- **Blocked on** — the exact question/decision the human owes, with the options and your recommendation.
- **Next steps** — the precise actions to take once unblocked, with file paths.
- **Gotchas** — anything non-obvious learned this session that a fresh session would re-derive.

At session start, if `HANDOFF.md` exists, read it and treat it as the resume point; delete it once its contents are absorbed or resolved.
