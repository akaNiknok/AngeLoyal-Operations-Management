---
name: project-clasp-deploy
description: This repo is connected to a Google Apps Script project via clasp; how to deploy changes and pull live sheet data
metadata: 
  node_type: memory
  type: project
  originSessionId: 0d3e447c-e484-4693-aadb-c8491304d05a
---

This repo (AngeLoyal-Operations-Management) is connected to an existing Apps Script project bound to a Google Sheet, using `clasp` (`@google/clasp`, configured 2026-06-11).

- `.clasp.json` holds the real Script ID and is committed (not secret).
- `.claspignore` restricts pushes to only `Code.gs`, `Index.html`, and `appsscript.json` — `Docs/` and `Sample Files/` never get pushed to Apps Script.
- `appsscript.json` mirrors the live manifest (`Asia/Shanghai` timezone, web app access `ANYONE_ANONYMOUS`, `executeAs USER_DEPLOYING`) — don't change these casually since they were pulled from the deployed project.
- Full setup/workflow is documented in `DEPLOY.md` at the repo root.

**Why:** user wants local Git to be the source of truth, with deploys to the Apps Script project.

**How to apply:** day-to-day workflow is `git commit` + `git push` for backup, then `npm run release` to actually go live. Important: the live AngeLoyal OMS web app (`.../macros/s/AKfycby8gSa29N58.../exec`) is served from a **versioned deployment (`@6` at setup time, now `@7`)**, not `@HEAD`. Plain `npm run push` only updates the editor/dev copy and does NOT update what users see — `npm run release` (push + `clasp deploy -i <that deploymentId>`) is required to ship changes. Auth lives in `~/.clasprc.json` (per-user, not in repo).

## Reading live sheet data for testing/verification

`Code.gs` has a token-gated `devDump` endpoint (`doGet?action=devDump`, added 2026-06-11) that returns raw sheet rows as JSON, used by `scripts/fetch-sheet-data.js`.

- `npm run fetch-data` -> dumps all 12 sheets to `data/sheets-snapshot.json`
- `npm run fetch-data -- <SheetName>` -> dumps one sheet to `data/<SheetName>.json`
- Token lives in local `.env` as `DEV_DUMP_TOKEN` (gitignored, set up via running `setupDevDumpToken()` once in the Apps Script editor)
- `data/` and `.env` are gitignored — snapshots contain real operational data (driver names, routes, etc.) and must stay local
- Sheet tabs as of 2026-06-11: Users, Truck Type Map, Waybill Prefixes, Employees (55 rows), Trucks (30), Default Assignments (30), Employee-Truck Assignment (55), Outlets, Trips, Route Frequency Log, Waybills, Audit Log (most non-Employee/Truck sheets had only header rows at this point — early-stage data)

**How to apply:** if `.env` already has `DEV_DUMP_TOKEN` and `npm install` has been run, just call `npm run fetch-data` to get a fresh snapshot before writing tests/verifications against real data shapes.
