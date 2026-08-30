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
- Lead with anything that changes their routine. Say plainly when nothing else moved.

The app's own nouns - trip, waybill, outlet, truck, dispatch board, route file, POD - are approved technical names.

Supported formatting: `###` headings, `-` bullets, `**bold**`, `` `code` ``, and plain paragraphs. Anything else renders as literal text (`renderNotes` in [web/whatsnew.js](../../../web/whatsnew.js)). The changelog starts at v1.3.0.
