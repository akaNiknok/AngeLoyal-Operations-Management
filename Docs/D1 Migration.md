# D1 Migration Plan — Google Sheets → Cloudflare D1 (v2.0.0)

Status: PLAN. Tick the boxes as work lands. A fresh session reads this file
and `HANDOFF.md`, not the codebase, to resume.

## 1. Decisions (settled, do not re-open)

| Topic | Decision |
| :--- | :--- |
| Runtime | The backend moves to **Cloudflare Pages Functions** (`web/functions/api.js`) in the Pages project. D1 is reachable only from Cloudflare code, so Apps Script and `clasp` go away. |
| Environments | **One Pages project** (`angeloyal-oms`). `main` = PROD (production env, PROD D1). `develop` = DEV (preview env, DEV D1, alias `develop.angeloyal-oms.pages.dev`). The `angeloyal-oms-dev` project is deleted after v2.0.0 ships. |
| Tables | **Normalized** (see §3). Helpers, default crews and manual charges become rows. One waybill row per load. Freight rates go long-format. Redundant columns go. |
| Sheet after cutover | Renamed `ARCHIVE pre-v2 — <env>`, shared read-only. Nobody reads it in daily work. |
| Tests | `npm test` stays zero-install. `node:sqlite` (built into Node 24) runs the same SQL as D1 behind a 40-line shim with the D1 `prepare/bind/all/first/run/batch` shape. |
| API contract | **Frozen.** Function names, argument shapes and return shapes stay as the `.gs` readers and writers return them today, so `web/*.js` changes only in `config.js` and `callBackend()`. Readers rebuild `helperIds`, `manualCharges`, `locked` and the rate grid from the normalized tables. |
| Concurrency | No global lock. `INTEGER PRIMARY KEY` removes the ID race, `UPDATE … RETURNING` reserves a waybill sequence atomically, `UNIQUE` constraints guard duplicates, `db.batch()` makes multi-row writes atomic. D1 serializes writes per database. |
| Request context | `AsyncLocalStorage` (Workers `nodejs_compat`) carries `{ db, email }` per request. Module-level globals are a cross-request race in a Worker isolate and would mis-attribute audit rows and RBAC. |
| Sessions | A `sessions` table replaces `CacheService`. TTL 12 h (the 6 h cap was CacheService's). |
| Dates | Pure dates `YYYY-MM-DD`. Timestamps `YYYY-MM-DD HH:MM:SS` in Asia/Manila. Readers still emit `M/d/yyyy` to the client. "Today" always goes through `todayPH()`, because Workers run in UTC. |
| Hotfixes during migration | `main` stays v1.7.x on Sheets. A hotfix lands on `main` and is re-applied by hand on `develop`. Frontend-only fixes cherry-pick cleanly. |
| Release | One tag `v2.0.0`: migration + RTVS tab + payroll. PROD data moves in a freeze window on release day. |

## 2. Target layout

```
server/                      ESM backend (was *.gs). Not served as static.
  db.js                      D1 helpers: q, one, run, batch, now(), todayPH(), date fmt
  ctx.js                     AsyncLocalStorage: db(), currentEmail(), runWith()
  rbac.js                    ROLES, PERMISSIONS, requirePermission   (from Code.gs)
  auth.js                    verifyIdToken (fetch), sessions, login/logout, rpc + RPC_ALLOWED
  readers.js                 getBootData, getDispatchBoardData, getTrips, … (DataReaders.gs)
  internals.js               audit, waybill suggestion, carry-over, outlet resolve, rates
  writers/trips.js           createTrip, saveTripChanges, bulkSetTripStatus, reorderTrips,
                             markDayScheduled, setTripConvoyGroup, deleteImportedTrip, bulkDeleteTrips
  writers/waybills.js        confirmWaybill, updateSuggestedWaybill(s), create/updateWaybillPrefix
  writers/import.js          importRouteFile
  writers/masters.js         outlets, trucks, employees, users, categories, route map, colors,
                             default assignment, charge types, clearAllData
  writers/billing.js         getBillingLines, saveBillingLine, setBillingLineStatus,
                             setBillingNumber, importFreightRates, updateFreightRate, fuel prices
  migrate/transform.js       sheet snapshot JSON → table rows (shared by the migration script
                             and the test harness)
migrations/0001_init.sql     the schema in §3 (wrangler d1 migrations)
web/functions/api.js         onRequestPost → login | rpc. Same origin, no CORS.
scripts/sheets-to-d1.mjs     snapshot → SQL file + reconciliation report
test/harness.js              node:sqlite shim + makeEnv({ sheets | tables, userEmail })
test/legacy/                 unported tests wait here (outside the npm test glob)
wrangler.toml                pages_build_output_dir="web", nodejs_compat, D1 bindings, vars
```

Removed at the end: `*.gs`, `appsscript.json`, `.clasp*.json`, `.claspignore`,
`scripts/fetch-sheet-data.js`, `scripts/clear-sheet-data.js`, `DEV_DUMP_TOKEN`,
`test/webharness.js` stays, `test/harness.js` vm code goes.

## 3. Schema (`migrations/0001_init.sql`)

Booleans are `INTEGER 0/1`. Every table keeps its Sheets `ID` values on import so
`audit_log.row_id` still points at the right row.

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Admin','Dispatcher','Payroll','Viewer')),
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL,
  expires_at TEXT NOT NULL);

CREATE TABLE billing_categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1);

-- Route Type Map: FK instead of a category name → the rename cascade disappears.
CREATE TABLE route_type_map (
  id INTEGER PRIMARY KEY, file_type_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  billing_category_id INTEGER NOT NULL REFERENCES billing_categories(id),
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE customer_group_colors (
  id INTEGER PRIMARY KEY, customer_group TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE waybill_prefixes (
  id INTEGER PRIMARY KEY, prefix TEXT NOT NULL DEFAULT '' UNIQUE COLLATE NOCASE,
  company_name TEXT NOT NULL,
  last_sequence_number INTEGER NOT NULL DEFAULT 0,
  sequence_width INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE employees (
  id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, first_name TEXT, middle_name TEXT,
  last_name TEXT, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);

-- Default Assignments folds into trucks (it was 1:1). Helpers become rows.
CREATE TABLE trucks (
  id INTEGER PRIMARY KEY, plate_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  brand TEXT, type TEXT, active INTEGER NOT NULL DEFAULT 1,
  billing_category_id INTEGER REFERENCES billing_categories(id),
  default_driver_id INTEGER REFERENCES employees(id),
  roster_notes TEXT);

CREATE TABLE truck_default_helpers (
  truck_id INTEGER NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  PRIMARY KEY (truck_id, slot));

CREATE TABLE outlets (
  id INTEGER PRIMARY KEY, outlet_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  area TEXT, address TEXT, customer_group TEXT, notes TEXT, created_at TEXT NOT NULL);

-- One waybill row per LOAD (trips sharing trip_date + fo_number + truck_id).
-- trips.waybill_id replaces waybills.trip_id. fo_number and locked are gone:
-- join trips for the FO, and locked ⇔ status = 'Confirmed'.
CREATE TABLE waybills (
  id INTEGER PRIMARY KEY, waybill_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  prefix_id INTEGER NOT NULL REFERENCES waybill_prefixes(id),
  sequence_number INTEGER NOT NULL,
  waybill_type TEXT NOT NULL CHECK (waybill_type IN ('Regular','Redeliver','Foul Trip')),
  parent_waybill_id INTEGER REFERENCES waybills(id),
  status TEXT NOT NULL CHECK (status IN ('Suggested','Confirmed')),
  confirmed_by TEXT, confirmed_at TEXT);

-- area is gone (join outlets); helpers are rows; snapshots stay.
CREATE TABLE trips (
  id INTEGER PRIMARY KEY, trip_date TEXT NOT NULL, billing_date TEXT NOT NULL,
  fo_number TEXT, fo_split_suffix TEXT,
  outlet_id INTEGER REFERENCES outlets(id),
  quantity INTEGER, cbm REAL, restrictions TEXT,
  truck_id INTEGER REFERENCES trucks(id), driver_id INTEGER REFERENCES employees(id),
  truck_billing_category TEXT,
  trip_status TEXT NOT NULL CHECK (trip_status IN ('Prepping','Backlog','Scheduled','Preload',
    'Delivered','Undelivered','Foul Trip - No Redeliver','Foul Trip - For Redeliver',
    'Redeliver','Two-Day Trip')),
  parent_trip_id INTEGER REFERENCES trips(id),
  source TEXT NOT NULL CHECK (source IN ('Import','Manual','Carry-over')),
  tier INTEGER, remarks TEXT,
  status_changed_by TEXT, status_changed_at TEXT,
  added_by TEXT NOT NULL, added_at TEXT NOT NULL,
  convoy_group TEXT, sort_order INTEGER, origin TEXT,
  waybill_id INTEGER REFERENCES waybills(id));

CREATE TABLE trip_helpers (
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  PRIMARY KEY (trip_id, slot));

-- trip_date is gone: the 21-day window joins trips(trip_date), which is indexed.
CREATE TABLE route_frequency_log (
  id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id),
  driver_id INTEGER NOT NULL REFERENCES employees(id),
  outlet_id INTEGER NOT NULL REFERENCES outlets(id));

-- Long format: one row per band. area_key = _normArea(area) so SQL matches directly.
CREATE TABLE freight_rates (
  id INTEGER PRIMARY KEY, origin TEXT NOT NULL, area TEXT NOT NULL, area_key TEXT NOT NULL,
  truck_type TEXT NOT NULL, effective_date TEXT NOT NULL,
  band INTEGER NOT NULL CHECK (band BETWEEN 1 AND 25), rate REAL NOT NULL,
  UNIQUE (origin, area_key, truck_type, effective_date, band));

CREATE TABLE fuel_prices (
  id INTEGER PRIMARY KEY, effective_date TEXT NOT NULL UNIQUE,
  diesel_price REAL NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL);

CREATE TABLE billing_charge_types (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER, active INTEGER NOT NULL DEFAULT 1);

-- waybill_number is gone (join). rate_band is the band index; the label comes
-- from FUEL_BANDS. overrides stays a JSON array (a set of flags, not a relation).
CREATE TABLE billing_lines (
  id INTEGER PRIMARY KEY, waybill_id INTEGER NOT NULL UNIQUE REFERENCES waybills(id),
  trip_date TEXT NOT NULL, billing_date TEXT NOT NULL,
  origin TEXT, plate_number TEXT, fo_number TEXT, truck_type TEXT, area TEXT,
  drops INTEGER NOT NULL, cartons INTEGER NOT NULL,
  diesel_price REAL, rate_band INTEGER, hauling_rate REAL NOT NULL DEFAULT 0,
  mano REAL NOT NULL DEFAULT 0, drop_fee REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  billing_number TEXT,
  status TEXT NOT NULL DEFAULT 'Not Billed' CHECK (status IN ('Not Billed','Billed','Deferred')),
  overrides TEXT, notes TEXT,
  added_by TEXT NOT NULL, added_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT);

CREATE TABLE billing_line_charges (
  billing_line_id INTEGER NOT NULL REFERENCES billing_lines(id) ON DELETE CASCADE,
  charge_type_id INTEGER NOT NULL REFERENCES billing_charge_types(id),
  amount REAL NOT NULL,
  PRIMARY KEY (billing_line_id, charge_type_id));

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user_email TEXT, action TEXT NOT NULL,
  detail TEXT, table_name TEXT, row_id INTEGER, old_value TEXT, new_value TEXT);

CREATE INDEX trips_trip_date    ON trips(trip_date);
CREATE INDEX trips_billing_date ON trips(billing_date);
CREATE INDEX trips_fo           ON trips(trip_date, fo_number);
CREATE INDEX trips_waybill      ON trips(waybill_id);
CREATE INDEX rfl_driver_outlet  ON route_frequency_log(driver_id, outlet_id);
CREATE INDEX audit_ts           ON audit_log(ts);
CREATE INDEX sessions_expires   ON sessions(expires_at);
```

Self-seeding sheets (Route Type Map, Customer Group Colors, Billing Charge
Types, Billing Categories) become `INSERT OR IGNORE` seed statements in
`0002_seed.sql`. Payroll tables come later as `0003_payroll.sql`.

### 3.1 Transform rules (`server/migrate/transform.js`)

Input: the JSON from `npm run fetch-data` (`data/sheets-snapshot.json`).
Output: `{ table: [rowObject, …] }` in insert order. Rules:

- `M/d/yyyy` → `YYYY-MM-DD`; `M/d/yyyy HH:mm:ss` → `YYYY-MM-DD HH:MM:SS`.
- `TRUE/FALSE` → `1/0`. Blank `Active` → `1`. Employee and truck `Status`
  `Active/Inactive` → `active 1/0`.
- Trucks `Billing Category` name → `billing_category_id`. Route Type Map
  `Billing Category` name → id. An unknown name **fails the run** with the row.
- Default Assignments → `trucks.default_driver_id`, `trucks.roster_notes`,
  `truck_default_helpers` (slot = position in the comma list).
- Trips `Helper IDs` → `trip_helpers`. `Area` dropped.
- Waybills: group rows by `Waybill Number`. Keep the lowest ID as the waybill
  row (a Confirmed row wins for `confirmed_by/at`). Every original `Trip ID`
  gets `trips.waybill_id`. Rows sharing a number with different `Status`
  values **fail the run** with the list.
- Freight Rates: 25 band columns → 25 rows; `band` = column position;
  `area_key` = `_normArea(area)`. Copy `_normArea` from `Internals.gs`.
- Billing Lines: `Manual Charges` JSON → `billing_line_charges`; `Waybill
  Number` → `waybill_id` through the dedup map; `Rate Band` label → index.
- Audit Log copies as-is.

Reconciliation report (printed, and the script exits non-zero on a mismatch):
row count per sheet vs table, `COUNT(DISTINCT Waybill Number)` =
`COUNT(waybills)`, `SUM(Total)` of Billing Lines = `SUM(total)`, helper counts,
zero unresolved FKs.

## 4. Phases and gates

### Phase 0 — Contract (Opus, one session, sequential)

The orchestrator builds everything a worker copies from. No worker starts
before the gate passes.

- [ ] `wrangler.toml`: `pages_build_output_dir = "web"`, `compatibility_flags = ["nodejs_compat"]`, `[vars] OAUTH_CLIENT_ID`, `[[d1_databases]]` PROD, `[env.preview]` DEV.
- [ ] `wrangler d1 create angeloyal-oms-dev` (PROD db is created in Phase 4).
- [ ] `migrations/0001_init.sql` (§3), `0002_seed.sql`.
- [ ] `server/db.js`, `server/ctx.js`.
- [ ] `server/migrate/transform.js` + `scripts/sheets-to-d1.mjs` + `test/transform.test.js` (run it on the DEV snapshot; the reconciliation must pass).
- [ ] `test/harness.js`: `node:sqlite` shim with the D1 shape; `makeEnv({ sheets, tables, userEmail })` — `sheets` go through `transform.js` (legacy fixtures keep working), `tables` are native rows; returns `{ api, db }`; `dump(db, 'trips')` returns row objects. Move every unported test file to `test/legacy/` so the Stop hook stays green; a worker moves its files back when they pass.
- [ ] `server/rbac.js`, `server/auth.js` (sessions table, `rpc`, `RPC_ALLOWED` without the `'r'/'w'` marks), `web/functions/api.js`.
- [ ] `server/readers.js` ported in full — **this is the exemplar**. It fixes the return shapes every writer test asserts on.
- [ ] `server/internals.js`: `_auditLog`, `_auditLogBatch`, `_normArea`, `_fuelBandLabel`, `_rateFor`, `nextBusinessDay`. Waybill suggestion and carry-over stay for the waybills worker.
- [ ] `web/config.js` → label by hostname + `OAUTH_CLIENT_ID` only; `callBackend()` posts to `/api`; `_headers` CSP `connect-src 'self' https://accounts.google.com`.
- [ ] Gate: `npm test` green (readers, auth, rbac, transform, web suites); `npm run dev:web` boots with a local D1 seeded from the DEV snapshot and the dispatch board renders a real day.

### Phase 1 — Port the writers (Opus orchestrates, 5 Sonnet workers in parallel)

Each worker gets one module, its tests, the exemplar, and nothing else (§5).
Worktree isolation; the orchestrator merges each branch and runs `npm test`.

| Worker | Module | Source functions | Tests to port |
| :--- | :--- | :--- | :--- |
| W1 | `writers/trips.js` + carry-over in `internals.js` | createTrip, saveTripChanges, bulkSetTripStatus, reorderTrips, markDayScheduled, setTripConvoyGroup, deleteImportedTrip, bulkDeleteTrips, `_carryOver*` | trips, carryover, trip-statuses, reorder, convoy, edits |
| W2 | `writers/waybills.js` + suggestion in `internals.js` | confirmWaybill, updateSuggestedWaybill(s), create/updateWaybillPrefix, `_suggestWaybills*`, `_normalizeSequenceInput` | waybills, prefixes |
| W3 | `writers/import.js` | importRouteFile, outlet resolve-or-create | import, route-file |
| W4 | `writers/masters.js` | outlets, trucks, employees, users, categories, route map, colors, updateDefaultAssignment, charge types, clearAllData | masters, admin-records, readers (roster part), devtools → delete |
| W5 | `writers/billing.js` | getBillingLines, saveBillingLine, setBillingLineStatus, setBillingNumber, importFreightRates, updateFreightRate, fuel prices, `_billableWaybillGroups`, `_priceWaybillGroup` | billing-lines, billing-rates, billing-web |

W1 and W2 share the waybill 1:N rule; W2 lands first, then W1 rebases. W3
depends on W2's suggestion helper: start W3 after W2 merges. W4 and W5 are
independent and start with W2.

- [ ] W2 waybills → merged, tests green
- [ ] W4 masters → merged
- [ ] W5 billing → merged
- [ ] W1 trips → merged
- [ ] W3 import → merged
- [ ] Gate: full `npm test` green; `test/legacy/` empty and deleted.

### Phase 2 — Integrate and clean up (Opus, sequential)

- [ ] Delete `*.gs`, `appsscript.json`, `.clasp*`, `.claspignore`, `scripts/fetch-sheet-data.js`, `scripts/clear-sheet-data.js`, the vm harness code, `DevTools` and `_devDump`.
- [ ] `package.json`: drop clasp scripts; add `db:migrate:dev|prod` (`wrangler d1 migrations apply`), `db:seed:local`, `db:export:dev|prod` (`wrangler d1 export`), `db:migrate-sheets` (`scripts/sheets-to-d1.mjs`); `deploy:dev` = `wrangler pages deploy web --branch develop`; `release` = `--branch main`; `help` text updated.
- [ ] `scripts/claude-hooks.mjs` guard: `--branch main`, `migrations apply angeloyal-oms ` (PROD db) and `release` are the PROD patterns.
- [ ] `.claude/skills/release/` runbook: add the data-migration steps (§4 Phase 4).
- [ ] `Docs/Schema.md` rewritten for tables (keep the rationale sections); `CLAUDE.md` architecture, constraints and workflow sections; `DEPLOY.md`; `test/README.md`.
- [ ] Smoke on `develop.angeloyal-oms.pages.dev` against DEV D1 seeded from the DEV snapshot: sign in, import a route file, schedule the day, confirm a waybill, carry a trip over, open Billing, print. Check the Audit Log rows.
- [ ] Gate: smoke passes; owner signs off on the DEV app.

### Phase 3 — DEV cutover, then Phase 2 features on D1

- [ ] Add `https://develop.angeloyal-oms.pages.dev` to the OAuth client's Authorized JavaScript origins.
- [ ] Final DEV snapshot → `sheets-to-d1` → apply to DEV D1. Rename the DEV Sheet `ARCHIVE pre-v2 — DEV`. Archive the DEV Apps Script deployment.
- [ ] Build the RTVS tab and payroll on D1 (`0003_payroll.sql`). Normal `develop` workflow.

### Phase 4 — Release v2.0.0 (Opus + owner present)

- [ ] `wrangler d1 create angeloyal-oms` (PROD); id into `wrangler.toml`; run `/release` prep (merge, tag, notes).
- [ ] **Freeze window** (about 30 minutes, agreed with the dispatchers): no edits in the v1 app.
- [ ] `npm run fetch-data` (PROD) → `sheets-to-d1` → reconciliation passes → `wrangler d1 migrations apply angeloyal-oms --remote` → import.
- [ ] `npm run release` (deploy `main`). Smoke the same list as Phase 2 on PROD. Send the "What's new" note.
- [ ] Rename the PROD Sheet `ARCHIVE pre-v2 — PROD`. Keep the Apps Script deployments 30 days, then archive.
- [ ] Rollback is possible only inside the freeze window: redeploy the `v1.7.x` web tag and unfreeze the Sheet. After the first D1 write, rollback loses data.

## 5. Agent structure and token rules

**Use multiple agents for Phase 1 only.** Phases 0, 2 and 4 are design and
integration work: one Opus session, sequential. Phase 1 is five independent,
mechanical ports of a fixed pattern, which is where Sonnet workers pay off.

Orchestrator: Opus 5, default effort. Workers: `Agent` tool with
`model: "sonnet"`, `isolation: "worktree"`, `run_in_background: true`.

Rules that keep the token bill down without losing quality:

1. **Read the plan, not the repo.** Every session starts from this file and `HANDOFF.md`. Do not re-derive the schema or the layout.
2. **Contract before workers.** Nothing in Phase 1 starts until the Phase 0 gate passes. Workers copy `readers.js` patterns; they do not design.
3. **Scoped briefs.** A worker reads only: its `.gs` source functions, its test files, `server/readers.js`, `server/db.js`, `server/ctx.js`, §1 and §3 of this file. It does not read `web/`, `Docs/`, other writers, or `CLAUDE.md`.
4. **Freeze the API.** A worker keeps every function name, argument and return shape. A shape change is a bug, not a refactor.
5. **Freeze the schema.** A worker that needs a column change stops and reports it. Only the orchestrator adds a migration file.
6. **Tests are the gate, run narrowly.** A worker runs `node --test test/<its files>` while it works and the full `npm test` once at the end. It moves its files from `test/legacy/` back to `test/` only when they pass.
7. **Report by diff.** A worker's final report is `git diff --stat`, the test summary line, and at most 200 words on decisions and open points. The orchestrator reviews `git diff` of money and waybill paths only (`confirmWaybill`, `_suggestWaybills*`, `_priceWaybillGroup`, `saveBillingLine`, carry-over), and trusts the tests for the rest.
8. **Async is the trap.** Every DB-touching function is `async`; a missing `await` is the most likely port bug. Workers grep their module for `db()` calls without `await` before they report.
9. **Handoff on every pause.** The orchestrator writes `HANDOFF.md` before it waits on the owner.

### 5.1 Worker brief template

```
Port <module> from <source .gs functions> to server/writers/<module>.js on D1.

Read only: Docs/D1 Migration.md §1 and §3, server/db.js, server/ctx.js,
server/readers.js (the pattern), the listed .gs functions, and your test files.

Rules: keep every function name, argument and return shape. Every DB call is
awaited. No schema changes; stop and report if you need one. Use db().batch()
for multi-row writes. Audit through _auditLog as before.

Tests: move <files> from test/legacy/ to test/, convert them (fixtures may
stay sheet-shaped through makeEnv({ sheets }); assertions read dump(db,
'<table>') row objects with snake_case keys), run `node --test <files>` until
green, then `npm test` once.

Report: `git diff --stat`, the test summary line, and ≤ 200 words on
decisions and anything you could not port.
```

## 6. Risks

| Risk | Mitigation |
| :--- | :--- |
| Workers free plan: 10 ms CPU per request | Parsing already runs in the browser; server work is queries plus small loops. If an import or a billing range trips the limit, Workers Paid ($5/month) gives 30 s. |
| Waybill 1:N is the one port with real logic change | W2 lands first; the orchestrator reviews its diff in full; `waybills` and `prefixes` suites must pass unchanged in intent. |
| Timezone drift (Workers run UTC) | `todayPH()` is the only source of "today"; a test pins a date near midnight PH. |
| Cross-request state | `ctx.js` is the only holder of `db` and `email`; a test runs two `rpc` calls concurrently and asserts attribution. |
| Data loss at cutover | Reconciliation report must pass; the archived Sheet stays; freeze window. |
| Hotfix drift on `main` | Each `main` hotfix gets a `develop` issue; frontend fixes cherry-pick. |
