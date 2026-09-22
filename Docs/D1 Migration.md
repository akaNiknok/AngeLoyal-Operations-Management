# D1 Migration Plan — Google Sheets → Cloudflare D1 (v2.0.0)

Status: PHASE 3 IN PROGRESS (2026-09-22): the row-write cuts are done. The final DEV load and the RTVS/payroll build remain. Tick the boxes as work lands.
A fresh session reads this file and `HANDOFF.md`, not the codebase, to resume.

## 1. Decisions (settled, do not re-open)

| Topic | Decision |
| :--- | :--- |
| Runtime | The backend moves to **Cloudflare Pages Functions** (`functions/api.js` at the repo root — the Pages convention; `web/` holds only static files) in the Pages project. D1 is reachable only from Cloudflare code, so Apps Script and `clasp` go away. |
| Environments | **One Pages project** (`angeloyal-oms`). `main` = PROD (production env, PROD D1). `develop` = DEV (preview env, DEV D1, alias `develop.angeloyal-oms.pages.dev`). The `angeloyal-oms-dev` project is deleted after v2.0.0 ships. |
| Tables | **Normalized** (see §3). Helpers, default crews and manual charges become rows. One waybill row per load. Freight rates go long-format. Redundant columns go. |
| Sheet after cutover | Renamed `ARCHIVE pre-v2 — <env>`, shared read-only. Nobody reads it in daily work. |
| Tests | `npm test` stays zero-install. `node:sqlite` (built into Node 24) runs the same SQL as D1 behind a 40-line shim with the D1 `prepare/bind/all/first/run/batch` shape. |
| API contract | **Frozen.** Function names, argument shapes and return shapes stay as the `.gs` readers and writers return them today, so `web/*.js` changes only in `config.js` and `callBackend()`. Readers rebuild `helperIds`, `manualCharges`, `locked` and the rate grid from the normalized tables. |
| Concurrency | No global lock. `INTEGER PRIMARY KEY` removes the ID race, `UPDATE … RETURNING` reserves a waybill sequence atomically, `UNIQUE` constraints guard duplicates, `db.batch()` makes multi-row writes atomic. D1 serializes writes per database. |
| Sheet snapshots | The `fetch-data` JSON holds Sheets dates as ISO instants in UTC (`2026-08-28T16:00:00.000Z` = 8/29 Manila). The transform shifts them; a `M/d/yyyy` string is wall time. |
| Request context | `AsyncLocalStorage` (Workers `nodejs_compat`) carries `{ db, email, clientId, fetch }` per request; a nested `runWith` merges over the outer store, so `rpc()` only sets `email`. Module-level globals are a cross-request race in a Worker isolate and would mis-attribute audit rows and RBAC. |
| Sessions | A `sessions` table replaces `CacheService`. TTL 12 h (the 6 h cap was CacheService's). |
| Dates | Pure dates `YYYY-MM-DD`. Timestamps `YYYY-MM-DD HH:MM:SS` in Asia/Manila. Readers still emit `M/d/yyyy` to the client. "Today" always goes through `todayPH()`, because Workers run in UTC. |
| Hotfixes during migration | `main` stays v1.7.x on Sheets. A hotfix lands on `main` and is re-applied by hand on `develop`. Frontend-only fixes cherry-pick cleanly. |
| Release | One tag `v2.0.0`: migration + RTVS tab + payroll. PROD data moves in a freeze window on release day. |

## 2. Target layout

```
server/                      ESM backend (was *.gs). Not served as static.
  package.json               { "type": "module" } — the repo root stays CommonJS
  db.js                      D1 helpers: stmt, q, one, run, batch; nowPH(), todayPH(), date fmt
  ctx.js                     AsyncLocalStorage: db(), currentEmail(), clientId(), fetchImpl(), runWith()
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
migrations/0001_init.sql     the schema in §3 (wrangler d1 migrations); 0002_seed.sql the defaults
functions/api.js             onRequestPost → login | rpc. Same origin, no CORS. (Pages reads
                             functions/ at the repo root, next to the output dir, never inside it.)
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

-- One waybill row per LOAD (the trips sharing one number on one FO).
-- trips.waybill_id replaces waybills.trip_id. fo_number and locked are gone:
-- join trips for the FO, and locked ⇔ status = 'Confirmed'.
-- waybill_number is indexed, NOT unique (owner accepted): PROD holds 19 hand-typed numbers that
-- sit on two loads (e.g. 12985 on FO …620 and FO …689), and each load bills alone.
CREATE TABLE waybills (
  id INTEGER PRIMARY KEY, waybill_number TEXT NOT NULL COLLATE NOCASE,
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

-- Long format: one row per band. area_key = _normArea(area) for matching (indexed);
-- the uniqueness key is the RAW area: the DOE matrix names two different towns
-- "San Juan" and "SAN JUAN" (6W 6,760 vs 16,490). v1 stored both and billed
-- the first. A band with no rate has no row. See §6 for the open question.
CREATE TABLE freight_rates (
  id INTEGER PRIMARY KEY, origin TEXT NOT NULL, area TEXT NOT NULL, area_key TEXT NOT NULL,
  truck_type TEXT NOT NULL, effective_date TEXT NOT NULL,
  band INTEGER NOT NULL CHECK (band BETWEEN 1 AND 25), rate REAL NOT NULL,
  UNIQUE (origin, area, truck_type, effective_date, band));

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
CREATE INDEX waybills_number    ON waybills(waybill_number);
-- freight_rates_key was here; 0003 drops it (no query used it, and it cost a third
-- written row per rate). area_key stays as a column.
CREATE INDEX rfl_driver_outlet  ON route_frequency_log(driver_id, outlet_id);
CREATE INDEX audit_ts           ON audit_log(ts);
CREATE INDEX sessions_expires   ON sessions(expires_at);
```

Self-seeding sheets (Route Type Map, Customer Group Colors, Billing Charge
Types, Billing Categories) become `INSERT OR IGNORE` seed statements in
`0002_seed.sql`, in `-- @seed <table>` sections the test harness applies one at
a time. The import file starts with `DELETE FROM` every table, so the seed rows
never collide with imported ids. `0003_drop_freight_rates_key.sql` drops the unused rate index. Payroll tables come later as `0004_payroll.sql`.

### 3.1 Transform rules (`server/migrate/transform.js`)

Input: the JSON from `npm run fetch-data` (`data/sheets-snapshot.json`).
Output: `{ table: [rowObject, …] }` in insert order. Rules:

- `M/d/yyyy` → `YYYY-MM-DD`; `M/d/yyyy HH:mm:ss` → `YYYY-MM-DD HH:MM:SS`. An ISO
  instant (`…Z`, what the snapshot holds) shifts to Manila first.
- `transform(snapshot, { strict })`: strict (the migration) applies every rule
  below; lenient (the test harness) creates unknown categories and checks no FK.
- `TRUE/FALSE` → `1/0`. Blank `Active` → `1`. Employee and truck `Status`
  `Active/Inactive` → `active 1/0`.
- Trucks `Billing Category` name → `billing_category_id`. Route Type Map
  `Billing Category` name → id. An unknown name **fails the run** with the row.
- Default Assignments → `trucks.default_driver_id`, `trucks.roster_notes`,
  `truck_default_helpers` (slot = position in the comma list).
- Trips `Helper IDs` → `trip_helpers`. `Area` dropped.
- Waybills: group rows by `Waybill Number` **and `FO Number`** (a number alone
  is not a load — see the `waybills` note in §3). Keep the lowest ID as the
  waybill row (a Confirmed row wins for `confirmed_by/at`). Every original
  `Trip ID` gets `trips.waybill_id`; `Parent Waybill ID` is remapped through
  the same map. Rows sharing a group with different `Status` values **fail the
  run** with the list.
- Orphan FKs on Trips (`Outlet/Truck/Driver/Parent Trip ID` that no row
  carries — PROD has 3 trips on truck 98) are **cleared and reported**; an
  orphan helper id or Route Frequency Log row is **dropped and reported**. A
  Waybills row whose Trip ID or Prefix ID is missing fails the run.
- Freight Rates: 25 band columns → up to 25 rows (a blank band has no row);
  `band` from the column label; `area_key` = `_normArea(area)` from
  `server/internals.js`. A second block with the same raw
  `(Origin, Area, Truck Type, Effective Date)` is dropped and reported — the
  first wins, as `_indexRates` did (DEV holds 27 such rows).
- Waybill Prefixes: a blank `Sequence Width` takes the length of the stored
  `Last Sequence Number`, the rule the old reader applied at read time.
- Billing Lines: `Manual Charges` JSON → `billing_line_charges`; `Waybill
  Number` → `waybill_id` through the dedup map; `Rate Band` label → index.
- Audit Log copies as-is.

Reconciliation report (printed, and the script exits non-zero on a mismatch):
row count per sheet vs table (minus what the transform reported dropped),
`COUNT(DISTINCT number+FO)` = `COUNT(waybills)`, trips linked, `SUM(Total)` of
Billing Lines = `SUM(total)`, helper counts, rate band cells, and
`PRAGMA foreign_key_check` empty — all run against a fresh SQLite loaded from
the generated file, so the file itself is what is verified.

## 4. Phases and gates

### Phase 0 — Contract (one session, sequential) — BUILT 2026-09-17

The orchestrator builds everything a worker copies from. No worker starts
before the gate passes.

- [x] `wrangler.toml`: `pages_build_output_dir = "web"`, `compatibility_flags = ["nodejs_compat"]`, `[vars] OAUTH_CLIENT_ID`, `[[d1_databases]]`, `[env.preview]`. Until Phase 4 the top-level binding is the DEV db too, so `pages dev` and the `db:*` scripts share one local file.
- [x] `wrangler d1 create angeloyal-oms-dev` → `ed9b2438-baef-4edb-81c3-e0ef3c9fbf5d` (PROD db is created in Phase 4).
- [x] `migrations/0001_init.sql` (§3), `0002_seed.sql`.
- [x] `server/db.js`, `server/ctx.js`, `server/package.json`.
- [x] `server/migrate/transform.js` + `scripts/sheets-to-d1.mjs` + `test/transform.test.js`. Run on the DEV snapshot: all checks pass; 27 duplicate rate blocks reported.
- [x] `test/harness.js`: `node:sqlite` shim with the D1 shape; `makeEnv({ sheets, tables, userEmail, fetch, oauthClientId })` returns `{ api, db, raw }`; `api.post(body)` drives `functions/api.js`; `dump(db, 'trips')`. Fixtures load with FKs off, the test body runs with FKs on. 14 unported suites sit in `test/legacy/` with a copy of the old vm harness.
- [x] `server/rbac.js` (`currentUser`, `hasPermission`, `requirePermission`, `getUserSession`, all async), `server/auth.js` (sessions table, 12 h TTL, `rpc`, `RPC_ALLOWED` as a name list, `FNS` registry), `functions/api.js`.
- [x] `server/readers.js` ported in full — **this is the exemplar**. `getDefaultAssignments().id` is the truck id; `getFreightRates().id` is the lowest row id of the block, and any band row's id resolves the block; `getWaybillsForTrip` returns 0 or 1 rows.
- [x] `server/internals.js`: audit, `_normArea`, bands, `_rateFor`, `_computeBillingLine`, `nextBusinessDay`, `helperSlots`, the billing constants. Waybill suggestion and carry-over stay for the waybills worker.
- [x] `web/config.js` → label by hostname + `OAUTH_CLIENT_ID`; `callBackend()` posts to `API_URL` (`/api`); `_headers` CSP `connect-src 'self' https://accounts.google.com`.
- [x] Gate: `npm test` green (126 tests: readers, auth, api, rbac, db, transform, web suites); `npm run dev:web` boots with the local D1 seeded from the DEV snapshot and the dispatch board renders 9/17/2026 (44 drops) with no console errors.
- [x] Owner: sign in with Google on `http://localhost:8788` once (the origin is already authorized). The Phase 0 session was planted with `wrangler d1 execute --local`, because sign-in needs a real account.

### Phase 1 — Port the writers (Opus orchestrates, 5 Sonnet workers in parallel)

Each worker gets one module, its tests, the exemplar, and nothing else (§5).
Worktree isolation; the orchestrator merges each branch and runs `npm test`.

| Worker | Module | Source functions | Tests to port |
| :--- | :--- | :--- | :--- |
| W1 | `writers/trips.js` + carry-over in `internals.js` | createTrip, saveTripChanges, bulkSetTripStatus, reorderTrips, markDayScheduled, setTripConvoyGroup, deleteImportedTrip, bulkDeleteTrips, `_carryOver*` | trips, carryover, prepping, reorder, convoy, edits |
| W2 | `writers/waybills.js` + suggestion in `internals.js` | confirmWaybill, updateSuggestedWaybill(s), create/updateWaybillPrefix, `_suggestWaybills*`, `_normalizeSequenceInput` | waybills, prefixes |
| W3 | `writers/import.js` | importRouteFile, outlet resolve-or-create | import, route-file |
| W4 | `writers/masters.js` | outlets, trucks, employees, users, categories, route map, colors, updateDefaultAssignment, charge types, clearAllData | masters, devtools (port the `clearAllData` tests, delete the devDump/devClear/doGet ones) |
| W5 | `writers/billing.js` | getBillingLines, saveBillingLine, setBillingLineStatus, setBillingNumber, importFreightRates, updateFreightRate, fuel prices, `_billableWaybillGroups`, `_priceWaybillGroup` | billing-lines, billing-rates, billing-web |

The orchestrator pre-wires `server/writers/*.js` stubs into `FNS` and `test/harness.js`, and deletes `test/legacy/utils.test.js` (`test/db.test.js` covers it). W1 and W2 share the waybill 1:N rule; W2 lands first, then W1 rebases. W3
depends on W2's suggestion helper: start W3 after W2 merges. W4 and W5 are
independent and start with W2.

- [x] W2 waybills → merged, tests green (review fixed sequence allocation race and the FK-unsafe delete)
- [x] W4 masters → merged
- [x] W5 billing → merged (review fixed raw-area rate edits, atomic line save, concurrent line create)
- [x] W1 trips → merged (review made the carry-over trip + helpers one batch)
- [x] W3 import → merged (the delete tests moved to `test/legacy/delete-trips.test.js` for W1)
- [x] Gate: full `npm test` green; `test/legacy/` empty and deleted.

### Phase 2 — Integrate and clean up (Opus, sequential)

- [x] Delete `*.gs`, `appsscript.json`, `.clasp*`, `.claspignore`, `scripts/clear-sheet-data.js`. (The vm backend harness is already gone; `DevTools`/`_devDump` go with the `.gs` files.) **Keep `scripts/fetch-sheet-data.js`** until Phase 4: Phases 3 and 4 snapshot through the *deployed* v1 `devDump` endpoint, which does not need the local `.gs` files.
- [x] `package.json`: clasp scripts and `@google/clasp` gone; `db:migrate:local|dev|prod`, `db:seed:local`, `db:export:dev|prod`, `db:migrate-sheets`, `fetch-data` (v1 snapshot); `deploy:dev` = `--branch develop`, `release` = `--branch main`, both on project `angeloyal-oms`; help text updated.
- [x] `scripts/claude-hooks.mjs` guard: `npm run release|db:migrate:prod`, `wrangler pages deploy … --branch main`, `wrangler d1 migrations apply|execute angeloyal-oms` (not `-dev`). Stop hook watches `.js/.mjs/.sql`. CI on Node 24.
- [x] `.claude/skills/release/` runbook: migration step + the v2.0.0 data move.
- [x] `Docs/Schema.md` rewritten for tables (rationale kept); `CLAUDE.md` architecture, constraints and workflow; `DEPLOY.md`; `test/README.md`; `.env.example`; stale `.gs` comment references in `web/` and `test/`.
- [x] Smoke on `develop.angeloyal-oms.pages.dev` against DEV D1 seeded from the DEV snapshot: sign in, import a route file, schedule the day, confirm a waybill, carry a trip over, open Billing, print. Check the Audit Log rows.
- [x] Gate: smoke passes; owner signs off on the DEV app.

### Phase 3 — DEV cutover, then Phase 2 features on D1

- [x] Add `https://develop.angeloyal-oms.pages.dev` to the OAuth client's Authorized JavaScript origins. (Done for the Phase 2 smoke.)
- [x] Cut D1 row writes before the next full load. The free plan allows 100,000 rows written per day **per account**, shared by every database in it. D1 counts each index entry as a written row, and a `DELETE` writes too. `freight_rates` was 36,750 of the 37,059 rows in a load, with two indexes, so one load cost about 110,000 writes and a reload over existing data about 220,000.
  - [x] `migrations/0003_drop_freight_rates_key.sql` drops `freight_rates_key`. No query used it: the two readers scan the whole table, the rate seed filters on `effective_date`, and every other rate read goes by `id` or by the raw `(origin, area, truck_type, effective_date, band)` key the `UNIQUE` constraint already serves. A rate write now costs 2 rows, not 3, so a load on an empty database is about 74,000 writes. `area_key` stays as a column.
  - [x] `test/harness.js` and `scripts/sheets-to-d1.mjs` read the whole `migrations/` directory in name order, so a new numbered file needs no edit in either. A `*_seed.sql` file still goes to the harness's per-section seeder.
  - [x] `scripts/sheets-to-d1.mjs --skip-rates` leaves the `DELETE` and the `INSERT`s for `freight_rates` out of the SQL file, and skips the band-cell check that would then compare against zero. A reload drops to about 1,000 writes.
  - [x] `npm run db:export:prod:norates` dumps PROD with `--no-schema` and a `--table` per table except `freight_rates` and `sessions`, for a PROD → DEV copy that leaves the DEV rates in place. Empty the DEV tables it covers first, or the inserts hit the primary keys.
  - [x] Reads: `getFreightRates(origin)` now reads `SELECT DISTINCT origin`, matches the spellings with `_normArea`, then filters in SQL through the `UNIQUE` index. One origin reads about a third of the table instead of all of it.
- [ ] Final DEV snapshot → `sheets-to-d1 --skip-rates` → apply to DEV D1. Rename the DEV Sheet `ARCHIVE pre-v2 — DEV`. Archive the DEV Apps Script deployment. Runbook in §4.1.

#### 4.1 DEV load runbook

**The DEV rates did not change** since the Phase 2 load, so the rates already in
DEV D1 are the rates to keep. The load runs with `--skip-rates` and costs about
2,000 rows written, not 74,000. Nothing is recreated: deleting the database
would destroy the very rows this saves.

Every step runs from `develop`. The whole run takes about 15 minutes.

1. **Confirm the DEV rates are the ones to keep.** Write the number down; step 7
   compares against it.

   ```
   npx wrangler d1 execute angeloyal-oms-dev --env preview --remote --command "SELECT COUNT(*) rates, COUNT(DISTINCT origin) origins, MAX(effective_date) newest FROM freight_rates"
   ```

   Expect about **36,750** rates. A much smaller number means the Phase 2 load
   did not reach this database — stop, and run step 4 without `--skip-rates`.

2. **Back up DEV.** `npm run db:export:dev` writes `data/d1-dev-export.sql`.
   This is the only way back: step 6 deletes every row it then re-inserts.

3. **Apply the pending migration.** `npm run db:migrate:dev` applies
   `0003_drop_freight_rates_key.sql` and nothing else. Wrangler tracks what ran.

4. **Snapshot the v1 DEV Sheet.** `npm run fetch-data -- --dev` reads the
   *deployed* Apps Script `devDump` endpoint and needs `DEV_DUMP_TOKEN` in
   `.env`. It writes `data/sheets-snapshot.json`. Tell the DEV users to stop
   editing the Sheet first — anything typed after this point is lost.

5. **Generate and reconcile.**

   ```
   npm run db:migrate-sheets -- --skip-rates
   ```

   Every check must read `OK` and the script must exit zero. The 27 duplicate
   rate blocks it reports are the known DOE ambiguity (§6) and are expected.
   Confirm the file skipped the rates: `grep -c freight_rates data/d1-import.sql`
   must print `0`, and the file should be tens of KB, not the 2.8 MB a load with
   the rates in it produces.

6. **Load it.**

   ```
   npx wrangler d1 execute angeloyal-oms-dev --env preview --remote --file data/d1-import.sql
   ```

   This signs every DEV user out: the file clears `sessions`.

7. **Verify.** The rate count must be unchanged from step 1, and the other
   tables must match the reconciliation report.

   ```
   npx wrangler d1 execute angeloyal-oms-dev --env preview --remote --command "SELECT (SELECT COUNT(*) FROM freight_rates) rates, (SELECT COUNT(*) FROM trips) trips, (SELECT COUNT(*) FROM employees) employees, (SELECT COUNT(*) FROM outlets) outlets"
   ```

   Then sign in on `develop.angeloyal-oms.pages.dev` and walk the Phase 2 smoke
   list: open the dispatch board, open Billing, open the Billing Matrix and
   check a rate still prices.

8. **Archive the v1 DEV side** (owner, in the Google console). Rename the Sheet
   `ARCHIVE pre-v2 — DEV` and share it read-only. Archive the DEV Apps Script
   deployment. Keep `scripts/fetch-sheet-data.js` and `DEV_DUMP_TOKEN` — Phase 4
   runs the same path against PROD.

9. Tick this item, and delete `HANDOFF.md` if one is open.

**If step 6 fails halfway**, the database holds a partial load. Re-run step 6:
the file starts with `DELETE FROM` on every table it writes, so it is safe to
repeat. If the file itself is wrong, restore `data/d1-dev-export.sql` from
step 2.

- [ ] Build the RTVS tab and payroll on D1 (`0004_payroll.sql`). Normal `develop` workflow.

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
3. **Scoped briefs.** A worker reads only: its `.gs` source functions, its test files, `server/readers.js`, `server/db.js`, `server/ctx.js`, `server/internals.js`, §1 and §3 of this file. It does not read `web/`, `Docs/`, other writers, or `CLAUDE.md`.
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
awaited (`await requirePermission()` too). No schema changes; stop and report
if you need one. Use batch([stmt(...), ...]) for multi-row writes. Audit through
_auditLog / _auditLogBatch with SQL table names. Register your exports in the
FNS object in server/auth.js. Writers return the read-back through the
readers' row mappers (tripFromRow, waybillFromRow, billingLineFromRow).

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
| Rate matrix ambiguity (found in Phase 0; owner accepted v1 behaviour for now) | The DOE sheet names different towns identically ("Rosario" x3, "San Juan" x2) with no province column, so `_normArea` collapses them and the first row wins — v1 behaviour, kept. The owner decides whether the matrix gains a province column (then `area_key` includes it). Until then the transform report lists every dropped duplicate. |
| PROD truck 98 (owner accepted as-is) | Three PROD trips point at a truck id that no longer exists. The transform clears the link and reports it; the owner re-adds the truck before the Phase 4 run or accepts blank plates on those trips. |
