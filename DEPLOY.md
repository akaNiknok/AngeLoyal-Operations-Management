# Deploying to Apps Script

This repo is wired up with [`clasp`](https://github.com/google/clasp) (Google's Command Line Apps Script Projects tool) so that `Code.gs` and `Index.html` here are the source of truth, and changes get pushed to the Apps Script project bound to the AngeLoyal Google Sheet.

## Environments (PROD vs DEV)

There are **two Google Sheets, each with its own container-bound Apps Script project** — hard isolation, so dev code and destructive tooling physically cannot touch production data:

| | PROD | DEV |
| :--- | :--- | :--- |
| Sheet | AngeLoyal OMS (live data) | "AngeLoyal OMS (DEV)" — a File → Make a copy of prod |
| Script ID | in [`.clasp.prod.json`](.clasp.prod.json) | in [`.clasp.dev.json`](.clasp.dev.json) |
| Deployment | `AKfycby8...NYV0` (the live web app) | its own deployment (`deploy:dev`) |
| Updated by | `npm run release` (from `main` only) | `npm run push` / `watch` / `deploy:dev` |
| Data scripts | `npm run fetch-data` | `npm run fetch-data -- --dev`, `npm run clear-data` (dev-only) |

`.clasp.json` is **gitignored and generated**: every env-touching npm script first copies the right source file over it (`use:dev` / `use:prod`), so nothing depends on which env was used last. The committed sources are `.clasp.prod.json` and `.clasp.dev.json`.

### One-time DEV environment setup

1. **Copy the Sheet**: open the prod Sheet → File → Make a copy → name it "AngeLoyal OMS (DEV)". This copies the data *and* the bound script code — but **not** Script Properties or deployments.
2. **Wire up clasp**: open the copy → Extensions → Apps Script → Project Settings → copy the Script ID into `.clasp.dev.json`.
3. **Script Properties on the DEV script** (Project Settings → Script Properties): set `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` (same OAuth client as prod). Then run `setupDevDumpToken()` once from the DEV editor and put the logged token in `.env` as `DEV_DUMP_TOKEN_DEV`.
4. **Create the DEV deployment**: `npm run push`, then `npx clasp deploy` (first time). Put the deployment ID into the `deploy:dev` script in [`package.json`](package.json) and its `/exec` URL into `scripts/clear-sheet-data.js` + the `DEV_URL` in `scripts/fetch-sheet-data.js`.
5. **OAuth redirect URIs**: in Google Cloud Console, add the DEV `/exec` URL (and optionally the DEV script's `/dev` URL) to the OAuth client's Authorized redirect URIs — sign-in on DEV fails without this.

> The DEV `/exec` serves a **versioned** deployment: after changing `DevTools.gs` (or anything the local data scripts hit), rerun `npm run deploy:dev`. Browser testing of HEAD uses the DEV script's `/dev` URL as before. The copied Users sheet means the same accounts can sign in to DEV immediately; sessions/cache are per-script, so prod sessions won't carry over.

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

## Google Sign-In (OAuth) setup
The web app runs `executeAs: USER_DEPLOYING` + `access: ANYONE_ANONYMOUS`, so the Google Sheet stays private (the script runs as the owner) but the platform can't tell the backend who a visitor is. Identity instead comes from a **server-side OAuth 2.0 sign-in** (see `Auth.gs` + the data-flow section in [`CLAUDE.md`](CLAUDE.md)). This is required because `Session.getActiveUser()` returns blank for anyone outside the owner's Workspace domain, and the in-iframe "Sign in with Google" (GIS) button is blocked by the sandbox's per-session `*.googleusercontent.com` origin.

One-time configuration (in the **GCP project** linked to the Apps Script project — Apps Script editor → Project Settings → Google Cloud Platform):

1. **APIs & Services → Credentials → Create OAuth client ID → Web application.** (Don't reuse the auto-created "Apps Script" client — it usually won't accept custom redirect URIs.)
2. **Authorized redirect URIs** — add the web app URLs the flow redirects back to. Use the live `/exec` URL; add `/dev` only for owner/editor testing:
   - `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`
   - `https://script.google.com/macros/s/<SCRIPT_ID>/dev`
   (JavaScript origins are **not** used by this flow — leave them empty.)
3. **OAuth consent screen** — scopes `openid email profile`. While in "Testing", every sign-in account must be listed under **Audience → Test users** (including non-owner / external-domain accounts) — anyone else is blocked by Google itself, and this has been a **confirmed cause** of accounts being unable to sign in (see the multi-account troubleshooting section below). Switch **Publishing status to Production** once you have real (non-test) users; or, if AngeLoyal uses Google Workspace, set **User type** to **Internal** so all domain users are allowed without test-user listing. Scopes here are non-sensitive, so Production doesn't require Google's app-verification review — but until you optionally complete that review, each account sees a one-time "Google hasn't verified this app" interstitial (**Advanced → Go to [app name] (unsafe)**) on first sign-in.
4. **Script Properties** (Apps Script editor → Project Settings → Script Properties) — these are read by `Auth.gs`; never put them in source:
   - `OAUTH_CLIENT_ID` = the Web client's ID
   - `OAUTH_CLIENT_SECRET` = the Web client's secret (used only server-side to exchange the auth code)
5. **Users sheet** — RBAC matches the signed-in email against the `Users` sheet (`Email` + `Active` true → `Role`). A verified Google account not listed there can sign in but sees the "Account not authorized" gate.

> Workspace accounts get redirected through a domain-scoped URL (`…/a/macros/<domain>/…/exec`). The code handles this by caching the exact `redirect_uri` with the CSRF `state` and reusing it in the token exchange — so the rewrite doesn't cause a `redirect_uri` mismatch. The **`/dev` URL only works for script editors**; test non-owner accounts on the **`/exec`** URL.

## Troubleshooting: multiple Google accounts

First, tell the two failures apart — they look similar but have different causes:

| What the user sees | Where it comes from | Meaning |
| :--- | :--- | :--- |
| Google page: *"Sorry, unable to open the file at this time"* (`Paumanhin, hindi mabuksan ang file sa oras na ito`), **before** any sign-in screen | Google Drive, *before* `doGet` runs | The `/u/N/` account-routing bug (below). |
| Google's own *"Access blocked"* / *"Error 403: access_denied"* page, **before** any app content | Google's OAuth consent screen, *before* `doGet` runs | The consent screen is still in **Testing** and this account isn't listed under **Audience → Test users**. Fix: publish the consent screen to **Production** (see *Google Sign-In (OAuth) setup* above). |
| The app's own *"Account not authorized"* card, signed in as some email | `getUserSession()` returned `role: null` | The page loaded fine; that account just has **no usable row** in the `Users` sheet — see the note after the fixes. |

**The routing bug is a Google problem, not an app bug.** The "unable to open the file" page is served by Google Drive *before* the script runs, so `doGet` / `Auth.gs` / the `Users` sheet are not involved — there's nothing to fix in `doGet`. The `/exec` link carries no account index, so when a browser has several accounts signed in, Google rewrites the URL to `…/u/N/macros/s/<id>/exec` and sometimes picks an `N` whose session can't resolve the deployment. It correlates with the number of signed-in accounts and is intermittent.

**Fixes, in order:**

1. **Give everyone the launcher link (`https://akaniknok.github.io/angeloyal-oms-launcher/`), not the raw `/exec` URL.** The launcher (see [The account launcher page](#the-account-launcher-page) below) remembers each person's OMS account and always opens the app as `…/exec?authuser=<their-email>`. The `authuser` parameter selects the account **by email**, so Google routes straight to it instead of guessing a `/u/N/` index — which is the whole cause of the bug. This is the fix to distribute; the manual steps in (4) become unnecessary once people bookmark it.
2. **Verify the live deployment's access is "Anyone" (anonymous).** `appsscript.json` declares `ANYONE_ANONYMOUS`, but the *active deployment's* actual setting can drift if it was edited in the UI. Apps Script editor → **Deploy → Manage deployments → (active) → Edit → Who has access** → set to **"Anyone"** (not "Anyone with a Google account", which forces account resolution and makes the bad `/u/N/` pick far more likely) → redeploy. Highest-leverage server-side fix.
3. **Make sure everyone has the `/exec` URL (or the launcher), never `/dev`.** The `/dev` URL only opens for script editors and shows the same page for everyone else.
4. **Manual per-user fallback** (only if someone hits the raw `/exec` link and it fails — any one forces a single, unambiguous account):
   - Append **`?authuser=<your-email>`** to the `/exec` URL, or
   - Open the link in an **Incognito / private window**, or
   - **Sign out** of the other Google accounts (keep only the OMS account), or
   - Make the OMS account the **default** (sign into it *first*), or
   - When it fails, change the `/u/1/` (or `/u/2/`) segment in the address bar to **`/u/0/`** and reload.

> **If instead the app's own "Account not authorized" card appears**, the routing worked and the problem is data, not accounts. That account reached the app but `getUserSession()` found no usable `Users` row. Check the `Users` sheet for that exact email: the row must have a non-blank **`Role`** *and* **`Active` = TRUE** (`_getCurrentUserRecord` in [`Code.gs`](Code.gs) requires both). Watch for a trailing/invisible character in the email cell (a zero-width space survives `trim()`), a blank `Role`, or `Active` left empty. Fix the row — no redeploy needed, it's read live on each sign-in.
>
> If the `Users` row looks correct and the account still can't get past sign-in, also check: (a) the consent screen's **Publishing status** — see the *Access blocked* row above; and (b) whether the script owner has an outstanding Apps Script authorization prompt. Apps Script re-asks the **owner** to review permissions whenever the project starts using a scope it hadn't consented to yet (e.g. after code changes touching `UrlFetchApp` in the OAuth token exchange); until that one-time consent is granted, the deployed app runs with a stale authorization for *every* visitor, since it always executes as the owner (`executeAs: USER_DEPLOYING`). Clear it by opening the Apps Script editor, running any function once, and clicking through the permissions dialog.

> Long term, moving AngeLoyal to a Workspace domain with the consent screen set to **Internal** and the script owned in-domain makes account routing predictable (see *Transferring ownership* below). Confirmed and closed via the launcher page + publishing the consent screen to Production; tracked in [#53](https://github.com/akaNiknok/AngeLoyal-Operations-Management/issues/53).

### The account launcher page
[`pages/index.html`](pages/index.html) is a tiny static page that sidesteps the `/u/N/` routing bug. On first visit it asks for the person's OMS Google account, remembers it in `localStorage`, and thereafter redirects straight to `…/exec?authuser=<that-email>`. Because the account is named by email, Google never mis-picks a `/u/N/` index, so multi-account browsers stop getting "unable to open the file." A **"Use a different account"** link (or visiting the launcher with `?switch=1`) clears the stored email.

It is **not** an Apps Script partial — `.claspignore` excludes `pages/**` so `npm run push` never uploads it. GitHub Pages requires a *public* repo on the free plan, and this repo stays private, so the page is published from a separate, standalone public repo: **[akaNiknok/angeloyal-oms-launcher](https://github.com/akaNiknok/angeloyal-oms-launcher)**. That repo contains nothing but this page — the `EXEC_URL` it points to is meant to be public (identity is still gated server-side by Google sign-in), so there's nothing confidential in it.

GitHub Pages is enabled there (Settings → Pages, Source: `master` / root), served at **`https://akaniknok.github.io/angeloyal-oms-launcher/`** — that's the link to hand out.

[`pages/index.html`](pages/index.html) in *this* repo is the source of truth. If the deployment ID ever changes, update `EXEC_URL` here first, then copy the file into a local checkout of `angeloyal-oms-launcher` and commit/push it there — there's no automated sync between the two repos:

```sh
cp pages/index.html ../angeloyal-oms-launcher/index.html
cd ../angeloyal-oms-launcher
git add index.html && git commit -m "sync EXEC_URL" && git push
```

## Transferring ownership to AngeLoyal
When the Apps Script project + bound Sheet move to an AngeLoyal-owned Google account, the OAuth sign-in needs attention — most breakage on handoff is here:

- **The OAuth client lives in the original owner's GCP project, not the script.** Transferring the script does **not** transfer the OAuth client. Either move the GCP project to AngeLoyal, or create a **new** OAuth Web client under AngeLoyal's GCP and update the `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` Script Properties.
- **Script Properties travel with the script** (they're stored on it), so the existing values persist through an ownership transfer — but they point at the old GCP project's client. Decide per the bullet above whether to keep or replace them.
- **Redirect URIs** — if the script keeps the same Script/Deployment ID, the `/exec` URL is unchanged and the registered redirect URI still works. If you create a fresh deployment (new ID), register its new `/exec` URL on the OAuth client and update the `deploy -i <id>` in [`package.json`](package.json) and the URL in this doc.
- **Consent screen** — if AngeLoyal has a Workspace domain, set the consent screen to **Internal** so any `@angeloyal` account is allowed automatically (no test-user list, no Google verification). Otherwise publish to Production or keep the operators' accounts as test users.
- **Re-point the tooling** — update `.clasp.prod.json` (Script ID) and re-run `npm run login` as the AngeLoyal owner; confirm the deployment ID in `package.json`.
- **Users sheet** — populate it with AngeLoyal staff emails + roles so they get access instead of the unauthorized gate.

> Optional simplification once AngeLoyal owns it: if **all** users are in a single Google Workspace domain and the script is owned within that domain, `Session.getActiveUser().getEmail()` would work for everyone and OAuth could be retired. It's not necessary — the OAuth flow keeps working regardless — but it's an option if you'd rather not maintain an OAuth client.

## Day-to-day workflow
```sh
git checkout develop && git pull   # branch off updated develop
git checkout -b feat/<task>
# ... make changes ...
git add -A && git commit -m "feat: ..."
git push -u origin feat/<task>     # open a PR into develop
npm run push                       # test in the Apps Script editor / dev URL
```

Going live is a separate step — see [Git workflow (gitflow)](#git-workflow-gitflow) below. Only `main` gets `npm run release`.

- `npm run push` — pushes local files to the **DEV** Apps Script project (its editor/HEAD, served at the DEV `/dev` URL). Never touches prod.
- `npm run deploy:dev` — pushes to DEV and updates the **DEV deployment** (`/exec` URL used by `clear-data` / `fetch-data -- --dev`). Only needed when those endpoints must pick up new code — don't run it on every push (Apps Script has a ~200-version cap).
- `npm run release` — pushes to **PROD** (`clasp push --force`) and updates the **live web app deployment** (`AKfycby8gSa29N58Ny3mJjkDgdbnaIWUfQocPQwJ0QochAh_mLDsmYslJaO0ANDCbuXYNYV0`, `https://script.google.com/macros/s/AKfycby8.../exec`). **This is the only command that touches production. Only run it from `main`.**
- `npm run open` / `npm run open:prod` — opens the DEV / PROD project in the Apps Script editor.
- `npm run watch` — watches for local file changes and auto-pushes to DEV.

> The live AngeLoyal OMS web app is served from a **versioned deployment** on the PROD script. Day-to-day work never touches it — going live is always a release from `main` via `npm run release`.

## Git workflow (gitflow)
This is a solo project developed mostly through Claude Code, on a simplified gitflow:

- **`main` = production.** It mirrors what the live web app deployment serves. Nothing lands here except release merges from `develop` and hotfixes. **`npm run release` is only ever run from `main`** — never from `develop` or a feature branch.
- **`develop` = integration.** All day-to-day work targets it. Use `npm run push` from here to test in the Apps Script editor/`/dev` URL; never `npm run release`.
- **Feature branches** (`feat/<task>`, `fix/<task>`, one per task) branch off the updated `develop` and merge back via PR.
- **Hotfix branches** (`hotfix/<task>`) branch off `main` for urgent production fixes: PR into `main`, tag + release (below), then merge `main` back into `develop`.

### Releases (tags + GitHub Releases)
Every deploy to the live web app gets a tag and a GitHub Release, so the deployed state is always identifiable:

1. PR `develop` → `main` (merge commit), titled `release: vX.Y.Z`.
2. On `main`: `git tag vX.Y.Z && git push --tags`
3. `gh release create vX.Y.Z --generate-notes` (edit notes if the auto-generated ones are noisy).
4. `npm run release` — the live app now matches the tag.

Versioning: **major** = project phase milestone (v1 = Phase 1, v2 = Billing & Payroll, v3 = Visibility & Alerts), **minor** = feature release, **patch** = hotfix. The latest tag on `main` is what's live; if it isn't, run `npm run release` from that tag's commit.

### PR conventions
- **Merge commit** every PR (preserves the branch as a named grouping in history). Repo settings: allow **only** merge commits, enable "Automatically delete head branches".
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, …) so `--generate-notes` stays changelog-friendly.
- Always start a new task from a fresh branch off the updated `develop`.

## Notes
- `.claspignore` restricts what gets pushed to `Code.gs`, `Index.html`, and `appsscript.json` — the `Docs/` and `Sample Files/` folders stay local/Git only and are never sent to Apps Script.
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
