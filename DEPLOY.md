# Deploying

The app ships in **two halves**, and a full deploy pushes both:

- **Backend** — the `.gs` files, pushed to the Apps Script project bound to the AngeLoyal Google Sheet with [`clasp`](https://github.com/google/clasp). Serves the JSON API (`doPost`) and owns the Sheet.
- **Frontend** — `web/`, a static site deployed to **Cloudflare Pages** with [`wrangler`](https://developers.cloudflare.com/workers/wrangler/). No build step: the files in `web/` are the files served.

The files in this repo are the source of truth for both. `npm run deploy:dev` and `npm run release` each push both halves in one command.

## Environments (PROD vs DEV)

There are **two Google Sheets, each with its own container-bound Apps Script project** — hard isolation, so dev code and destructive tooling physically cannot touch production data:

| | PROD | DEV |
| :--- | :--- | :--- |
| Sheet | AngeLoyal OMS (live data) | "AngeLoyal OMS (DEV)" — a File → Make a copy of prod |
| Script ID | in [`.clasp.prod.json`](.clasp.prod.json) | in [`.clasp.dev.json`](.clasp.dev.json) |
| Deployment | `AKfycby8...NYV0` (the live API) | its own deployment (`deploy:dev`) |
| Frontend | [angeloyal-oms.pages.dev](https://angeloyal-oms.pages.dev) | [angeloyal-oms-dev.pages.dev](https://angeloyal-oms-dev.pages.dev) |
| Updated by | `npm run release` (from `main` only) | `npm run push` / `watch` / `deploy:dev` |
| Data scripts | `npm run fetch-data` | `npm run fetch-data -- --dev`, `npm run clear-data` (dev-only) |

Both Pages projects currently live in the **developer's** Cloudflare account and move to AngeLoyal's at handover — see [Transferring ownership](#transferring-ownership-to-angeloyal). Which backend a page talks to is decided by its own hostname, in [`web/config.js`](web/config.js); an unrecognised host falls back to DEV, never prod.

`.clasp.json` is **gitignored and generated**: every env-touching npm script first copies the right source file over it (`use:dev` / `use:prod`), so nothing depends on which env was used last. The committed sources are `.clasp.prod.json` and `.clasp.dev.json`.

### One-time DEV environment setup

1. **Copy the Sheet**: open the prod Sheet → File → Make a copy → name it "AngeLoyal OMS (DEV)". This copies the data *and* the bound script code — but **not** Script Properties or deployments.
2. **Wire up clasp**: open the copy → Extensions → Apps Script → Project Settings → copy the Script ID into `.clasp.dev.json`.
3. **Script Properties on the DEV script** (Project Settings → Script Properties): set `OAUTH_CLIENT_ID` (same OAuth client as prod) and `FRONTEND_URL` = `https://angeloyal-oms-dev.pages.dev` (so a stray GET on the DEV `/exec` redirects to the DEV frontend, not prod). Then run `setupDevDumpToken()` once from the DEV editor and put the logged token in `.env` as `DEV_DUMP_TOKEN_DEV`.
4. **Create the DEV deployment**: `npm run push`, then `npx clasp deploy` (first time). Put the deployment ID into the `deploy:dev` script in [`package.json`](package.json) and its `/exec` URL into `scripts/clear-sheet-data.js` + the `DEV_URL` in `scripts/fetch-sheet-data.js`.
5. **OAuth JavaScript origins**: in Google Cloud Console, add `https://angeloyal-oms-dev.pages.dev` to the OAuth client's **Authorized JavaScript origins** — sign-in on DEV fails without this. See [Google Sign-In setup](#google-sign-in-gis-setup).

> The DEV `/exec` serves a **versioned** deployment, so backend changes are only visible to the frontend after `npm run deploy:dev` — the DEV script's `/dev` URL is no longer a shortcut, because the browser talks to `/exec`. The copied Users sheet means the same accounts can sign in to DEV immediately; sessions/cache are per-script, so prod sessions won't carry over.

## One-time setup
1. **Enable the Apps Script API** for your Google account:
   https://script.google.com/home/usersettings (toggle it ON).

2. **Install dependencies**

   ```sh
   npm install
   ```

3. **Log in to clasp** (opens a browser window for Google OAuth):

   ```sh
   npm run login
   ```

   This stores credentials in `~/.clasprc.json` (outside the repo, never committed).

4. **Connect to the existing Apps Script project**

   Open the Sheet -> Extensions -> Apps Script -> Project Settings (gear icon) -> copy the **Script ID**, then paste it into [`.clasp.prod.json`](.clasp.prod.json) (or `.clasp.dev.json` for the DEV copy):

   ```json
   {
     "scriptId": "YOUR_SCRIPT_ID",
     "rootDir": "."
   }
   ```

5. **Reconcile the manifest** (`appsscript.json`)

   The repo has a placeholder `appsscript.json`. Before the first push, pull down the real one from Apps Script into a temp folder so we don't clobber any existing OAuth scopes / settings:

   ```sh
   npx clasp clone YOUR_SCRIPT_ID --rootDir ./.clasp-tmp
   ```

   Compare `.clasp-tmp/appsscript.json` with `appsscript.json`, merge any differences (scopes, sheet bindings, etc.) into the repo's copy, then delete `.clasp-tmp`.

## Google Sign-In (GIS) setup
The web app runs `executeAs: USER_DEPLOYING` + `access: ANYONE_ANONYMOUS`, so the Google Sheet stays private (the script runs as the owner) but the platform can't tell the backend who a visitor is — `Session.getActiveUser()` is blank for anyone outside the owner's Workspace domain. Identity comes from **Google Identity Services**: the frontend renders the Google button, and its ID token is POSTed to `login()`, which verifies it with Google before opening a session (see `Auth.gs` + the data-flow section in [`CLAUDE.md`](CLAUDE.md)).

One-time configuration (in the **GCP project** linked to the Apps Script project — Apps Script editor → Project Settings → Google Cloud Platform):

1. **APIs & Services → Credentials → Create OAuth client ID → Web application.** (Don't reuse the auto-created "Apps Script" client.)
2. **Authorized JavaScript origins** — every origin the frontend is served from. Not redirect URIs: this flow has no redirect, and putting them in the wrong box gives `Error 401: invalid_client — no registered origin`.
   - `https://angeloyal-oms.pages.dev`
   - `https://angeloyal-oms-dev.pages.dev`
   - `http://localhost:8788` (for `npm run dev:web`)

   Origins are scheme + host + port, no path and no trailing slash. `localhost` and `127.0.0.1` are **different origins**. Changes can take a few minutes to propagate — a first-load 403 on the button that clears on reload is propagation, not misconfiguration. Per-deployment preview URLs (`<hash>.angeloyal-oms-dev.pages.dev`) can't be registered — Google allows no wildcards — so QA on the project's production URL.
3. **OAuth consent screen** — scopes `openid email profile`. While in "Testing", every sign-in account must be listed under **Audience → Test users**; anyone else is blocked by Google itself. Switch **Publishing status to Production** once you have real users; or, if AngeLoyal uses Google Workspace, set **User type** to **Internal**. Scopes here are non-sensitive, so Production doesn't require Google's app-verification review — but until you optionally complete that review, each account sees a one-time "Google hasn't verified this app" interstitial on first sign-in.
4. **Client ID in two places** — it is public, so it lives in source as well as on the script:
   - Script Property `OAUTH_CLIENT_ID` (Apps Script → Project Settings), read by `_verifyIdToken` to check the token's `aud`.
   - `OAUTH_CLIENT_ID` in [`web/config.js`](web/config.js), used by the GIS button.

   **They must match**, on both PROD and DEV. A mismatch fails every sign-in with "or ask an administrator". There is no client *secret* any more — the old code flow needed one; GIS does not.
5. **Users sheet** — RBAC matches the signed-in email against the `Users` sheet (`Email` + `Active` true → `Role`). A verified Google account not listed there signs in but sees the "Account not authorized" gate.

## Troubleshooting sign-in

The old `/u/N/` account-routing bug is **gone** — it was a Google Drive quirk in serving the Apps Script page, and the page is no longer served by Apps Script. What's left is a short list, and the symptom names the cause:

| What you see | Cause | Fix |
| :--- | :--- | :--- |
| Google: *"Access blocked… no registered origin"* (`Error 401: invalid_client`) | The client has **no** JavaScript origins registered — usually they went into the redirect-URIs box, or onto a different client | Step 2 above; confirm the client ID matches the one in `web/config.js` |
| Google: *`origin_mismatch` (400)* | Origins exist but this one isn't among them (wrong port, `127.0.0.1` vs `localhost`, trailing slash) | Add the exact origin |
| Google: *"Access blocked" / `403: access_denied`* | Consent screen still in **Testing** and this account isn't a test user | Publish to Production, or add the account |
| App: *"Sign-in failed. Please try again."* (short) | The request itself failed — check the browser console | Usually the backend isn't deployed (a missing `doPost` surfaces as a **CORS** error, not a 404) — run `npm run deploy:dev` |
| App: *"…or ask an administrator."* (long) | `login()` rejected the token — almost always an `aud` mismatch | Make the Script Property and `web/config.js` client IDs match |
| App: *"Account not authorized"* card | Sign-in worked; the email has no usable `Users` row | Give the row a non-blank **Role** and **Active** = TRUE. Watch for a zero-width space in the email cell — it survives `trim()`. Read live on each sign-in, no redeploy needed |

> If the `Users` row looks right and sign-in still fails, check whether the script owner has an outstanding Apps Script authorization prompt. Apps Script re-asks the **owner** to review permissions whenever the project starts using a scope it hadn't consented to yet; until that one-time consent is granted the deployed app runs with a stale authorization for *every* visitor, since it always executes as the owner. Clear it by opening the editor, running any function once, and clicking through the dialog.

### The account launcher page
[`pages/index.html`](pages/index.html) is a tiny static page that was built to sidestep the `/u/N/` routing bug. **That bug no longer exists** — but the page is deliberately kept as the link handed to operators, because it is one redirect they never have to re-bookmark: the pages.dev URL underneath it changes when the Cloudflare projects move to AngeLoyal's account, and a Pages project cannot be transferred between accounts. Retire it only after that handover has settled.

It is **not** an Apps Script partial — `.claspignore` excludes `pages/**` so `npm run push` never uploads it. GitHub Pages requires a *public* repo on the free plan, and this repo stays private, so the page is published from a separate, standalone public repo: **[akaNiknok/angeloyal-oms-launcher](https://github.com/akaNiknok/angeloyal-oms-launcher)**. That repo contains nothing but this page — the frontend URL it points to is meant to be public (identity is still gated server-side by Google sign-in), so there's nothing confidential in it.

GitHub Pages is enabled there (Settings → Pages, Source: `master` / root), served at **`https://akaniknok.github.io/angeloyal-oms-launcher/`** — that's the link to hand out.

[`pages/index.html`](pages/index.html) in *this* repo is the source of truth. If the frontend URL ever changes, update it here first, then copy the file into a local checkout of `angeloyal-oms-launcher` and commit/push it there — there's no automated sync between the two repos:

```sh
cp pages/index.html ../angeloyal-oms-launcher/index.html
cd ../angeloyal-oms-launcher
git add index.html && git commit -m "sync EXEC_URL" && git push
```

## Transferring ownership to AngeLoyal
When the Apps Script project + bound Sheet move to an AngeLoyal-owned Google account, the OAuth sign-in needs attention — most breakage on handoff is here:

- **The OAuth client lives in the original owner's GCP project, not the script.** Transferring the script does **not** transfer the OAuth client. Either move the GCP project to AngeLoyal, or create a **new** OAuth Web client under AngeLoyal's GCP and update the `OAUTH_CLIENT_ID` Script Property **and** [`web/config.js`](web/config.js) — both, or every sign-in fails on the `aud` check.
- **Script Properties travel with the script** (they're stored on it), so the existing values persist through an ownership transfer — but they point at the old GCP project's client. Decide per the bullet above whether to keep or replace them.
- **JavaScript origins** — carry the three origins over to whichever client ends up in use. If a fresh Apps Script deployment is created (new ID), update the `/exec` URLs in [`web/config.js`](web/config.js), the `deploy -i <id>` in [`package.json`](package.json), and this doc.
- **The Cloudflare Pages projects cannot be transferred between accounts.** Handover is: AngeLoyal creates a Cloudflare account → delete the developer-owned `angeloyal-oms` project to free the name → `wrangler login` as them → `npm run deploy:web` recreates it under their account. Keep the launcher page pointed at whatever URL results, so nobody has to re-bookmark. Do the DEV project the same way, or simply leave it with the developer.
- **Consent screen** — if AngeLoyal has a Workspace domain, set the consent screen to **Internal** so any `@angeloyal` account is allowed automatically (no test-user list, no Google verification). Otherwise publish to Production or keep the operators' accounts as test users.
- **Re-point the tooling** — update `.clasp.prod.json` (Script ID) and re-run `npm run login` as the AngeLoyal owner; confirm the deployment ID in `package.json`.
- **Users sheet** — populate it with AngeLoyal staff emails + roles so they get access instead of the unauthorized gate.

> Optional simplification once AngeLoyal owns it: if **all** users are in a single Google Workspace domain and the script is owned within that domain, `Session.getActiveUser().getEmail()` would work for everyone and OAuth could be retired. It's not necessary — the OAuth flow keeps working regardless — but it's an option if you'd rather not maintain an OAuth client.

## Day-to-day workflow
```sh
git checkout develop && git pull   # stay current on develop
# ... make changes ...
git add -A && git commit -m "feat: ..."   # Conventional Commit, straight to develop
git push origin develop
npm run push                       # backend -> DEV script
npm run dev:web                    # frontend -> http://localhost:8788
```

For a big or risky change you'd rather isolate, use a branch instead: `git checkout -b feat/<task>`, then PR it back into `develop`.

Going live is a separate step — see [Git workflow (gitflow)](#git-workflow-gitflow) below. Only `main` gets `npm run release`.

- `npm run dev:web` — serves `web/` at `http://localhost:8788` with `_headers` (CSP) applied, talking to the **DEV** backend. This is the main development loop; only backend changes need a push.
- `npm run push` — pushes the `.gs` files to the **DEV** Apps Script project's HEAD. Never touches prod. Note the browser talks to `/exec`, so a bare push isn't visible to the frontend — use `deploy:dev` for that.
- `npm run deploy:dev` — pushes the backend to DEV, updates the **DEV deployment**, *and* deploys `web/` to `angeloyal-oms-dev.pages.dev`. Don't run it on every push (Apps Script has a ~200-version cap).
- `npm run deploy:web` / `deploy:web:dev` — deploys the frontend alone. A CSS or markup fix doesn't need a backend push.
- `npm run release` — pushes the backend to **PROD** (`clasp push --force`), updates the live deployment, and deploys `web/` to `angeloyal-oms.pages.dev`. **This is the only command that touches production. Only run it from `main`.**
- `npm run open` / `npm run open:prod` — opens the DEV / PROD project in the Apps Script editor.
- `npm run watch` — watches for local file changes and auto-pushes to DEV.

> The live AngeLoyal OMS web app is served from a **versioned deployment** on the PROD script. Day-to-day work never touches it — going live is always a release from `main` via `npm run release`.

## Git workflow (gitflow)
This is a solo project developed mostly through Claude Code, on a simplified gitflow:

- **`main` = production.** It mirrors what the live web app deployment serves. Nothing lands here except release merges from `develop` and hotfixes. **`npm run release` is only ever run from `main`** — never from `develop` or a feature branch.
- **`develop` = integration.** All day-to-day work commits straight here with Conventional Commit messages — no feature branch or PR needed for routine changes. Use `npm run push` from here to test in the Apps Script editor/`/dev` URL; never `npm run release`.
- **Feature branches** (`feat/<task>`, `fix/<task>`) are optional — reach for one only when a change is big or risky enough to isolate, then merge it back into `develop`.
- **Hotfix branches** (`hotfix/<task>`) branch off `main` for urgent production fixes: merge into `main`, tag + release (below), then merge `main` back into `develop`.

### Releases (tags + GitHub Releases)
Every deploy to the live web app gets a tag and a GitHub Release, so the deployed state is always identifiable:

1. Merge `develop` → `main` (a merge commit, titled `release: vX.Y.Z`; a PR is optional).
2. On `main`: `git tag vX.Y.Z && git push --tags`
3. `gh release create vX.Y.Z` — **write the notes for dispatchers** (see below). `--generate-notes` produces a commit list, which is the wrong thing to show them; use it as raw material at most.
4. `npm run changelog:sync -- --apply`, then commit `web/changelog.json`. This is what the in-app **"What's new?"** dialog reads.
5. `npm run release` — the live app now matches the tag.

**Writing the release notes.** The Release body is shown verbatim to dispatchers inside the app, so write it for them: what they can now do, what looks different, what to stop worrying about. No commit messages, no file names, no internal jargon (`doPost`, `RBAC`, `CSP` mean nothing to them). Lead with anything that changes their routine; say plainly when nothing else moved. Keep it to a handful of bullets — the dialog is read once, standing at a desk, before the day's dispatch.

**Write them in ASD-STE100 Simplified Technical English.** The readers are Filipino dispatchers reading English as a second language on a phone; STE is what keeps the notes unambiguous. Apply the core rules:

- **One word, one meaning.** Pick a plain word and reuse it everywhere — the trip is always a *trip*, the button is always the *button*. Don't vary wording for style.
- **Active voice, present tense.** "The board shows the new trip", not "the new trip will be displayed".
- **Short sentences.** Max ~20 words for an instruction, ~25 for a description. One idea per sentence, one instruction per bullet.
- **Keep the articles and short words** — "the", "a", "you". Don't write telegram-style ("Fixed bug carryover date").
- **No noun stacks over three words.** "waybill sequence number reset problem" → "the app no longer resets the waybill number".
- **Name the thing the way the screen names it.** Use the on-screen label, not the internal name.
- **No jargon, idioms, slang, or humour.** Not "under the hood", not "squashed a bug".
- **Say what changed for them, not what we changed.** "You can now print the final route" beats "added the export module".

Approved technical names (the app's own nouns — *trip*, *waybill*, *outlet*, *truck*, *dispatch board*, *route file*, *POD*) are allowed even where STE would restrict them; that is what STE's technical-name provision is for. STE governs the *wording*, not the vocabulary of the business.

Supported formatting: `###` headings, `-` bullets, `**bold**`, `` `code` ``, and plain paragraphs. Anything else renders as literal text (see `renderNotes` in [`web/whatsnew.js`](web/whatsnew.js)). The dialog opens by itself once per release and on demand from the account menu; the in-app changelog starts at **v1.3.0** and older tags are ignored.

Versioning: **major** = project phase milestone (v1 = Phase 1, v2 = Billing & Payroll, v3 = Visibility & Alerts), **minor** = feature release, **patch** = hotfix. The latest tag on `main` is what's live; if it isn't, run `npm run release` from that tag's commit.

### Commit / PR conventions
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, …) so `--generate-notes` stays changelog-friendly.
- When you *do* use a branch + PR, **merge-commit** it (preserves the branch as a named grouping in history). Repo settings: allow merge commits, enable "Automatically delete head branches".
- Pull `develop` before starting so you commit on top of the latest.

## Notes
- `.claspignore` restricts what gets pushed to the `.gs` files and `appsscript.json` — `web/`, `pages/`, `Docs/` and `Sample Files/` stay local/Git only and are never sent to Apps Script.
- `.clasp.prod.json` / `.clasp.dev.json` contain the Script IDs (not secret, just identifiers) and are committed; `.clasp.json` is the gitignored, generated pointer (see [Environments](#environments-prod-vs-dev)).
- Auth tokens (`~/.clasprc.json`) are per-user and never committed.

## Reading live sheet data locally (for testing/verification)
`Code.gs` has a token-gated `devDump` endpoint (`doGet` with `?action=devDump`) that returns raw sheet data as JSON. It's used by `scripts/fetch-sheet-data.js` to snapshot the live data for local inspection — never exposed in the UI.

**One-time setup:**

1. In the Apps Script editor, open `Code.gs`, select the `setupDevDumpToken` function in the function dropdown, and click **Run**. Authorize if prompted, then check the execution log (View -> Logs / Ctrl+Enter) for the generated token.
2. Copy `.env.example` to `.env` and paste the token as `DEV_DUMP_TOKEN`. `.env` is gitignored and never committed.
3. Run `npm run release` so the deployed web app has the `devDump` endpoint (only needed once after adding it).

**Usage:**

```sh
npm run fetch-data            # dumps every PROD sheet to data/sheets-snapshot.json
npm run fetch-data -- Trips   # dumps just the "Trips" sheet to data/Trips.json
npm run fetch-data -- --dev   # dumps from the DEV spreadsheet instead (needs DEV_DUMP_TOKEN_DEV)
npm run clear-data            # DEV: clears Trips/Outlets/Route Frequency Log/Waybills/Audit Log rows
npm run clear-data:prod       # PRODUCTION: same, but prompts to type "PRODUCTION" first (needs DEV_DUMP_TOKEN)
```

> `clear-data:prod` hits the **live versioned deployment**, so it only works once the `devClear` endpoint has shipped to prod via `npm run release`. It reads the prod script's `DEV_DUMP_TOKEN` from `.env` and refuses to run unless you type `PRODUCTION` at the prompt.

`data/` is gitignored — these snapshots contain real operational data (driver names, routes, etc.) and stay local only.

> Security note: the `devDump` endpoint is reachable by anyone with the web app URL **and** the token — treat `DEV_DUMP_TOKEN` like a password. To revoke it, run `setupDevDumpToken()` again to generate a new one (and redeploy).
