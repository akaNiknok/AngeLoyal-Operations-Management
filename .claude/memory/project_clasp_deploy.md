---
name: project-clasp-deploy
description: Deploy setup — v2 is one Cloudflare Pages project + D1 (clasp is gone on develop); v1 on main still runs Apps Script until v2.0.0 ships
metadata:
  type: project
---

Since the D1 migration (Phase 2, 2026-09-17) `develop` has no `.gs` files and no clasp. The backend is `functions/api.js` + `server/`, the database is D1, and one Pages project `angeloyal-oms` serves both environments (`develop` → preview + DEV D1, `main` → production + PROD D1). DEPLOY.md is the full workflow.

`main` stays v1 (Apps Script + Sheets) until the v2.0.0 release. `npm run fetch-data` still works on `develop`: it calls the *deployed* v1 Apps Script `devDump` endpoint with `DEV_DUMP_TOKEN` from `.env`, not local `.gs` files.

**Why:** a Worker cannot reach Sheets cheaply and D1 is reachable only from Cloudflare code, so the backend moved with the database.

**How to apply:** never suggest `clasp` on `develop`. A v1 hotfix happens on `main` and is re-applied by hand on `develop`. Delete `fetch-data` and the tokens only after the Phase 4 cutover. See [[solo-git-workflow]].
