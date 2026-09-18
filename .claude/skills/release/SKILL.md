---
name: release
description: Ship a tagged release of the OMS to PROD - merge develop into main, tag, write dispatcher-facing release notes in Simplified Technical English, sync the in-app changelog, then deploy. Use when the user says "release", "ship vX.Y.Z", "deploy to prod", "go live", or asks for release notes or What's new content.
---

# Release the OMS

Full reference: [DEPLOY.md](../../../DEPLOY.md#releases-tags--github-releases). This is the short runbook.

## Version number

- **major** = phase milestone (v1 Records/Dispatch, v2 Billing & Payroll, v3 Visibility & Alerts)
- **minor** = feature release
- **patch** = hotfix

## Steps

1. Merge `develop` into `main` with a merge commit titled `release: vX.Y.Z`. A hotfix comes from a `hotfix/*` branch.
2. On `main`: `git tag vX.Y.Z && git push --tags`
3. `gh release create vX.Y.Z` with notes written for dispatchers (see below). `--generate-notes` gives a commit list. Use it as raw material at most.
4. `npm run changelog:sync -- --apply`, then commit `web/changelog.json`. The in-app **What's new?** dialog reads this file.
5. Run the PROD deploy script (`release` in package.json). A hook blocks it outside `main`.
6. A release with a new file in `migrations/`: run `npm run db:export:prod` (backup), then `npm run db:migrate:prod`, **before** step 5. The hook blocks the migrate outside `main` too.

## v2.0.0 only: move PROD data from the Sheet to D1

Do this once, with the owner present. Rollback works only inside the freeze window. Full plan: [Docs/D1 Migration.md](../../../Docs/D1%20Migration.md) §4 Phase 4.

1. `npx wrangler d1 create angeloyal-oms`. Put its id in the top-level `[[d1_databases]]` of `wrangler.toml` (it points at DEV until now), and commit on `develop` before step 1 above.
2. Start the **freeze window** (about 30 minutes, agreed with the dispatchers). Nobody edits in the v1 app.
3. `npm run fetch-data` (PROD Sheet) → `npm run db:migrate-sheets`. Stop if the reconciliation report fails.
4. `npm run db:migrate:prod`, then `npx wrangler d1 execute angeloyal-oms --remote --file data/d1-import.sql`.
5. `npm run release`. Smoke on `angeloyal-oms.pages.dev`: sign in, import a route file, schedule the day, confirm a waybill, carry a trip over, open Billing, print. Check the Audit Log.
6. Rename the PROD Sheet `ARCHIVE pre-v2 — PROD`. Keep the Apps Script deployments 30 days, then archive them.
7. Rollback before the first D1 write only: redeploy the `v1.7.x` tag's `web/` and unfreeze the Sheet.

## Write the notes for dispatchers

The Release body appears verbatim in the app. The readers are Filipino dispatchers. They read English as a second language, on a phone, one time, before the day's dispatch. Write in ASD-STE100 Simplified Technical English:

- One word, one meaning. A trip is always a *trip*. A button is always the *button*.
- Active voice, present tense: "The board shows the new trip".
- Short sentences, maximum 20 words. One idea in each bullet.
- Keep the articles and the short words. Do not write in telegram style.
- Maximum three words in a noun cluster.
- Use the on-screen label, not the internal name.
- No jargon (`doPost`, RBAC, CSP), no idioms, no humour.
- Say what changed for them, not what we changed.
- Lead with anything that changes their routine.
- Write only what changed. Do not add a "What is the same" section or a closing line that says nothing else moved.

The app's own nouns - trip, waybill, outlet, truck, dispatch board, route file, POD - are approved technical names.

Supported formatting: `###` headings, `-` bullets, `**bold**`, `` `code` ``, and plain paragraphs. Anything else renders as literal text (`renderNotes` in [web/whatsnew.js](../../../web/whatsnew.js)). The changelog starts at v1.3.0.
