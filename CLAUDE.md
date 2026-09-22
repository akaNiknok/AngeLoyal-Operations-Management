# CLAUDE.md — AngeLoyal Operations Management System (OMS)

## Communication style (how to talk to the owner)
Owner holds a **BS in Management Information Systems**. Bridge IT and strategy: frame a technical trade-off as system integration, scalability, data flow or value. Do not over-explain foundational tech and do not walk through low-level syntax.
**Write in Simplified Technical English (ASD-STE100 spirit, not the strict standard) — chat prose, commit messages, docs. README.md keeps the strict version (see its own rule).**
1. Use active voice. Write "The system sends the file", not "The file is sent by the system". 2. Put one idea in each sentence; split a sentence that has two. 3. Keep sentences short — no word count, but cut every word that adds nothing. 4. Use a maximum of three words in a noun cluster: "the log of failed jobs", not "the failed job log record". 5. Use one term for one thing — if it is a "data pipeline", it is never later a "data flow" or an "ingestion path". 6. Use one meaning for each word; do not use "run" for both execute and manage. 7. Start an instruction with the verb: "Open the panel", not "The panel must be opened". 8. Expand an acronym at first use only. 9. Use lists for steps and comparisons; use prose for reasoning.

## What this is

A web-based Operations Management System for **AngeLoyal Logistics**, a Philippine trucking subcontractor that hauls for Rebisco. It replaces Excel and group chats for dispatch scheduling, waybill tracking, billing, driver payroll, and proof-of-delivery (POD) tracking.

It is a **Cloudflare Pages app**: the frontend is a static site, the backend is one Pages Function (`/api`), and **Cloudflare D1 (SQLite) is the database**. No build step. v1 (tags `v1.x` on `main`) ran on Google Apps Script with Google Sheets as the database; [`Docs/D1 Migration.md`](Docs/D1%20Migration.md) tracks the move to v2.

- [`Docs/Schema.md`](Docs/Schema.md) — the data model; `migrations/` holds the DDL. Reconcile every change against it.
- [`Docs/Project Proposal.md`](Docs/Project%20Proposal.md) — feature set, pricing, contractual scope.
- Interview notes in `Docs/` are rough transcriptions. Confirm a detail before you build on it.

## Phases

1. **Records, Dispatch, Waybills** — largely BUILT. Employee/truck/outlet records, dispatch board, Rebisco route-file import, waybills, truck roster, RBAC, admin panels.
2. **Billing & Payroll** — BILLING BUILT, PAYROLL NOT STARTED. Built: origin warehouse on import, the DOE freight-rate matrix with date-locked rates and effective-dated blocks, the weekly diesel price history, the Mano fee, the flat 3-drop fee, the split-load highest-rate rule, the Billing panel with overrides and deferrals, and print/PDF in the Rebisco format. Not built: the `RTVS BILLING` second tab for bad-order returns. Payroll is untouched — trips/night differential/absences, SSS/PhilHealth/Pag-IBIG, 13th month, payslips.
3. **Visibility & Alerts** — NOT STARTED. POD status logging with business-day aging, management dashboard, billing/payroll report exports, driver route history.

The GitHub Project board is the backlog source of truth: `gh issue list --json number,title,state,labels`, `gh issue view <n>`. `BACKLOG.md` is a gitignored snapshot — regenerate with `npm run backlog:sync -- --apply --project 2 --owner akaNiknok`. Update this section when a phase moves.

## Architecture

The backend lives in `server/` and the frontend in `web/`. Each folder has its own `CLAUDE.md` with file-level gotchas; it loads when you work there.

ESM modules (`server/package.json` sets `"type": "module"`; the repo root stays CommonJS). [`functions/api.js`](functions/api.js) is the only route. Pages reads `functions/` at the repo root, next to the `web/` output directory.

The public launcher page is a plain redirect and lives in the separate `angeloyal-oms-launcher` repo, which is its only copy. It is the link the operators keep after the Cloudflare handover. Read [DEPLOY.md](DEPLOY.md#the-account-launcher-page) before you touch it.

### Data flow

1. The GIS button posts a Google ID token to `/api` as `{fn:"login", idToken}`. The server verifies it, returns an app session token, and `core.js` keeps it in `localStorage`.
2. `call(fnName, ...args)` POSTs `{token, fn, args}` to `/api` → `rpc()`, and returns a promise. It absorbs `AUTH_REQUIRED` centrally, so call sites handle only real failures. `rpc` resolves the session and runs the function with the session email in the request context.

## Critical constraints

- **The migrations are the schema. Match `Docs/Schema.md`.** A schema change is a new numbered file in `migrations/` — never edit an applied one — plus the doc, plus `server/migrate/transform.js` while the Sheets import still exists. Tables and columns are `snake_case`.
- **The API contract is frozen.** Function names, arguments and return shapes stay as v1 returned them, so `web/*.js` never learns about the tables. Readers return camelCase and dates as `M/d/yyyy`.
- **IDs** are `INTEGER PRIMARY KEY`; SQLite assigns them. Foreign keys are numeric IDs, never names, and D1 enforces them.
- **Dates**: pure dates are `YYYY-MM-DD`, timestamps `YYYY-MM-DD HH:MM:SS` in Manila time. **Workers run in UTC**, so "today" and "now" come only from `todayPH()` / `nowPH()`. Convert at the edge with `fromClientDate` / `toClientDate`.
- **Booleans** are `INTEGER 0/1`.
- **Every DB call is `await`ed**, and so is `requirePermission`. A missing `await` is a silent permission bypass or a lost write.
- **Billing Date is not Trip Date.** Trip Date is the calendar dispatch day. Billing Date is the original operational day and survives carry-overs, so fuel-price and rate indexing stay correct.
- **Snapshotting**: dispatch stamps `truck_billing_category` onto the trip, so a later category rename does not re-price history.
- **Helpers and manual charges are rows** (`trip_helpers`, `truck_default_helpers`, `billing_line_charges`). Readers rebuild the client's `helperIds` string and `manualCharges` object.
- **Append-only logs**: `audit_log` and `route_frequency_log`. Do not mutate a prior row. Derive current state from the latest row.
- **Waybills**: one row per load; trips point at it through `trips.waybill_id`. `Suggested` → `Confirmed` (immutable). Suggestion reserves the number; confirmation moves the counter again only for a higher custom number. Suffixes: `-R` redeliver, `-FT` foul trip. `waybill_number` is not unique.
- **Waybill numbering is atomic.** `_reserveWaybillSequence` is one `UPDATE … RETURNING` past `max(counter, highest sequence in waybills)`, run before the waybill row exists. `last_sequence_number` is a plain number and the pad width is `sequence_width`. Inferring the width from padded text is what froze the `AY` and `GL` booklets in v1.
- **Concurrency without a lock.** The board fires saves in parallel (`bgSave`). D1 runs writes one at a time per database, but a read-then-write across two statements can still race. Use a constraint (`UNIQUE`, `ON CONFLICT`), an `UPDATE … RETURNING`, or one `batch()` — never read a max and write max + 1. Multi-row writes go in one `batch()`, which is atomic.
- **RBAC**: Admin / Dispatcher / Payroll / Viewer. Every sensitive writer calls `await requirePermission(...)`. The UI hides controls too, but **the server is the real gate**.
- **Identity** comes from a verified Google sign-in. `rpc()` puts the session email in the request context; `currentEmail()` reads it. A new client-callable function must join `RPC_ALLOWED` and `FNS` in `server/auth.js` or the browser cannot reach it (a test checks every name resolves). **Never trust an unverified ID token** — that is an auth bypass.
- **Audit every mutation**: `_auditLog(action, table, rowId, old, new)` or `_auditLogBatch`, with an SQL table name and a vocabulary token from `Docs/Schema.md`. It is best-effort and never throws.
- **Performance**: the Workers free plan allows 10 ms CPU per request. Keep loops small, query only what you need, and batch writes. Parsing stays in the browser.
- **`/api` never throws.** A thrown error becomes a 500 with no readable body, so failures return `{ok:false, error}`. The client re-prompts sign-in on the exact string `AUTH_REQUIRED`.

## Deploy, test, and local workflow

Full details in [`DEPLOY.md`](DEPLOY.md). `web/` and `functions/` deploy together to one Cloudflare Pages project with `wrangler`.

- **Two environments** in one Pages project: `develop` → preview (`develop.angeloyal-oms.pages.dev`, DEV D1 `angeloyal-oms-dev`); `main` → production (`angeloyal-oms.pages.dev`, PROD D1 `angeloyal-oms`). Bindings live in [`wrangler.toml`](wrangler.toml). Only `npm run release` and `npm run db:migrate:prod` touch PROD, only from `main` — a hook blocks them elsewhere.
- `npm run help` prints every script with its purpose. The usual ones: `npm test`, `npm run dev:web`, `npm run db:migrate:local`, `npm run deploy:dev`.
- `data/`, `.env`, `*.xlsx`, `*.pdf` are gitignored — they hold real operational data. `DEV_DUMP_TOKEN` in `.env` is password-equivalent until the v1 Apps Script deployments are archived.
- **Tests** live in `test/` and run on `node:test` with `node:sqlite` (Node 24) behind a D1-shaped shim — no wrangler, no live database, no install. See [`test/README.md`](test/README.md). Frontend logic is testable through [`test/webharness.js`](test/webharness.js), which runs `web/*.js` against a stub DOM. The stub has no layout, so check anything visual in a browser.
- Add a test next to any backend logic you add. For anything the harness cannot cover, run `npm run dev:web` against the local D1.

## Working agreements

- A new feature usually walks this path: a migration file and `Docs/Schema.md` → reader in `server/readers.js` → writer with `requirePermission` and `_auditLog` in `server/writers/*.js` → `RPC_ALLOWED` and `FNS` in `server/auth.js` → the `web/*.js` panel and the `core.js` state and boot wiring. Keep the schema doc and the code in lockstep.
- Match the surrounding style: `_`-prefixed helpers are private, readers return camelCase objects, writers return `{ success, ... } | { success:false, error }`.
- Commit or push only when the owner asks.
- **Branching (solo dev)**: routine work commits straight to `develop` with Conventional Commit messages. Use a `feat/` or `fix/` branch only when a change is big or risky, then merge-commit it back. `main` stays production-only.
- Money, payroll, and billing logic are contractually sensitive. Favor correctness, date-locking, and an audit trail over cleverness.

## Automation (do not repeat this work by hand)

`.claude/settings.json` wires three hooks in [`scripts/claude-hooks.mjs`](scripts/claude-hooks.mjs):

- **SessionStart** prints `HANDOFF.md` when it exists, so a fresh session resumes without being told.
- **Stop** runs `npm test` when a `.js`/`.mjs`/`.sql` file changed in the turn, and blocks on a failure.
- **PreToolUse** blocks a PROD deploy or PROD migration from any branch except `main`.

The `/release` skill (`.claude/skills/release/`) holds the release runbook and the dispatcher release-note rules. Commit and PR attribution lines are already off in the user settings — never add one by hand.

## Session handoff (HANDOFF.md)

Long conversations burn uncached tokens, so the owner may clear context whenever you wait on them. **Before you end a turn that needs human input** — a question, an approval, a review — write `HANDOFF.md` at the repo root (gitignored, overwrite freely). The SessionStart hook reads it back. Delete it once it is resolved. It must carry:

- **Task & goal** — the ask, in one or two sentences.
- **State** — what is done and verified (branch, commits, files, test results), and what is in flight.
- **Blocked on** — the exact decision the human owes, with the options and your recommendation.
- **Next steps** — the precise actions, with file paths.
- **Gotchas** — what a fresh session would otherwise re-derive.
