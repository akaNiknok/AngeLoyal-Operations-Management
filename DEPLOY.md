# Deploying to Apps Script

This repo is wired up with [`clasp`](https://github.com/google/clasp) (Google's Command Line Apps Script Projects tool) so that `Code.gs` and `Index.html` here are the source of truth, and changes get pushed to the Apps Script project bound to the AngeLoyal Google Sheet.

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

   Open the Sheet -> Extensions -> Apps Script -> Project Settings (gear icon) -> copy the **Script ID**, then paste it into [`.clasp.json`](.clasp.json):

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
3. **OAuth consent screen** — scopes `openid email profile`. While in "Testing", every sign-in account must be listed under **Audience → Test users** (including non-owner / external-domain accounts). For an org rollout, either publish to **Production** or, if AngeLoyal uses Google Workspace, set the app to **Internal** so all domain users are allowed without test-user listing.
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
| The app's own *"Account not authorized"* card, signed in as some email | `getUserSession()` returned `role: null` | The page loaded fine; that account just has **no usable row** in the `Users` sheet — see the note after the fixes. |

**The routing bug is a Google problem, not an app bug.** The "unable to open the file" page is served by Google Drive *before* the script runs, so `doGet` / `Auth.gs` / the `Users` sheet are not involved — there's nothing to fix in `doGet`. The `/exec` link carries no account index, so when a browser has several accounts signed in, Google rewrites the URL to `…/u/N/macros/s/<id>/exec` and sometimes picks an `N` whose session can't resolve the deployment. It correlates with the number of signed-in accounts and is intermittent.

**Fixes, in order:**

1. **Give everyone the launcher link, not the raw `/exec` URL.** The launcher (see [The account launcher page](#the-account-launcher-page) below) remembers each person's OMS account and always opens the app as `…/exec?authuser=<their-email>`. The `authuser` parameter selects the account **by email**, so Google routes straight to it instead of guessing a `/u/N/` index — which is the whole cause of the bug. This is the fix to distribute; the manual steps in (4) become unnecessary once people bookmark it.
2. **Verify the live deployment's access is "Anyone" (anonymous).** `appsscript.json` declares `ANYONE_ANONYMOUS`, but the *active deployment's* actual setting can drift if it was edited in the UI. Apps Script editor → **Deploy → Manage deployments → (active) → Edit → Who has access** → set to **"Anyone"** (not "Anyone with a Google account", which forces account resolution and makes the bad `/u/N/` pick far more likely) → redeploy. Highest-leverage server-side fix.
3. **Make sure everyone has the `/exec` URL (or the launcher), never `/dev`.** The `/dev` URL only opens for script editors and shows the same page for everyone else.
4. **Manual per-user fallback** (only if someone hits the raw `/exec` link and it fails — any one forces a single, unambiguous account):
   - Append **`?authuser=<your-email>`** to the `/exec` URL, or
   - Open the link in an **Incognito / private window**, or
   - **Sign out** of the other Google accounts (keep only the OMS account), or
   - Make the OMS account the **default** (sign into it *first*), or
   - When it fails, change the `/u/1/` (or `/u/2/`) segment in the address bar to **`/u/0/`** and reload.

> **If instead the app's own "Account not authorized" card appears**, the routing worked and the problem is data, not accounts. That account reached the app but `getUserSession()` found no usable `Users` row. Check the `Users` sheet for that exact email: the row must have a non-blank **`Role`** *and* **`Active` = TRUE** (`_getCurrentUserRecord` in [`Code.gs`](Code.gs) requires both). Watch for a trailing/invisible character in the email cell (a zero-width space survives `trim()`), a blank `Role`, or `Active` left empty. Fix the row — no redeploy needed, it's read live on each sign-in.

> Long term, moving AngeLoyal to a Workspace domain with the consent screen set to **Internal** and the script owned in-domain makes account routing predictable (see *Transferring ownership* below). Tracked in [#53](https://github.com/akaNiknok/AngeLoyal-Operations-Management/issues/53).

### The account launcher page
[`pages/index.html`](pages/index.html) is a tiny static page that sidesteps the `/u/N/` routing bug. On first visit it asks for the person's OMS Google account, remembers it in `localStorage`, and thereafter redirects straight to `…/exec?authuser=<that-email>`. Because the account is named by email, Google never mis-picks a `/u/N/` index, so multi-account browsers stop getting "unable to open the file." A **"Use a different account"** link (or visiting the launcher with `?switch=1`) clears the stored email.

It is **not** an Apps Script partial — `.claspignore` excludes `pages/**` so `npm run push` never uploads it. It's hosted on **GitHub Pages** off a `gh-pages` branch:

```sh
npm run pages:publish   # git subtree push --prefix pages origin gh-pages
```

One-time setup: after the first publish, go to the repo's **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, **Branch: `gh-pages` / `(root)`**, and save. The launcher is then served at `https://akaniknok.github.io/AngeLoyal-Operations-Management/` — that's the link to hand out. If the deployment ID ever changes, update `EXEC_URL` in [`pages/index.html`](pages/index.html) (and `package.json` / the URLs in this doc) and re-run `npm run pages:publish`.

## Transferring ownership to AngeLoyal
When the Apps Script project + bound Sheet move to an AngeLoyal-owned Google account, the OAuth sign-in needs attention — most breakage on handoff is here:

- **The OAuth client lives in the original owner's GCP project, not the script.** Transferring the script does **not** transfer the OAuth client. Either move the GCP project to AngeLoyal, or create a **new** OAuth Web client under AngeLoyal's GCP and update the `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` Script Properties.
- **Script Properties travel with the script** (they're stored on it), so the existing values persist through an ownership transfer — but they point at the old GCP project's client. Decide per the bullet above whether to keep or replace them.
- **Redirect URIs** — if the script keeps the same Script/Deployment ID, the `/exec` URL is unchanged and the registered redirect URI still works. If you create a fresh deployment (new ID), register its new `/exec` URL on the OAuth client and update the `deploy -i <id>` in [`package.json`](package.json) and the URL in this doc.
- **Consent screen** — if AngeLoyal has a Workspace domain, set the consent screen to **Internal** so any `@angeloyal` account is allowed automatically (no test-user list, no Google verification). Otherwise publish to Production or keep the operators' accounts as test users.
- **Re-point the tooling** — update `.clasp.json` (Script ID) and re-run `npm run login` as the AngeLoyal owner; confirm the deployment ID in `package.json`.
- **Users sheet** — populate it with AngeLoyal staff emails + roles so they get access instead of the unauthorized gate.

> Optional simplification once AngeLoyal owns it: if **all** users are in a single Google Workspace domain and the script is owned within that domain, `Session.getActiveUser().getEmail()` would work for everyone and OAuth could be retired. It's not necessary — the OAuth flow keeps working regardless — but it's an option if you'd rather not maintain an OAuth client.

## Day-to-day workflow
```sh
git pull                # get latest code
# ... make changes to Code.gs / Index.html ...
git add -A && git commit -m "..."
git push                # back up to GitHub
npm run release         # push + redeploy the live web app
```

- `npm run push` — pushes local files to the **Apps Script editor** (updates the "head" / dev version, what you see when you open the script editor). This alone does **not** update the live web app.
- `npm run deploy` — creates a new version and updates the **live web app deployment** to point at it. The deployment ID is the one used by the AngeLoyal OMS web app: `AKfycby8gSa29N58Ny3mJjkDgdbnaIWUfQocPQwJ0QochAh_mLDsmYslJaO0ANDCbuXYNYV0` (`https://script.google.com/macros/s/AKfycby8.../exec`).
- `npm run release` — runs both: `clasp push --force` then `npm run deploy`. **Use this when you want your changes to go live.**
- `npm run open` — opens the project in the Apps Script editor in your browser.
- `npm run watch` — watches for local file changes and auto-pushes (editor only, does not redeploy the live web app).

> The live AngeLoyal OMS web app is served from a **versioned deployment**, not `HEAD`. `npm run push` updates the editor/dev copy only — always run `npm run release` (or `npm run deploy` after pushing) to make changes visible to actual users.

## Git & PR workflow
This is a solo project developed mostly through Claude Code, with **one feature branch per task** (e.g. `claude/<task>`). The merge convention is:

- **Merge commit** every PR. This preserves the branch as a named grouping in `main`'s history — useful when multiple sessions run in parallel on different branches, since the merge commit brackets which commits belong together.
- Commit messages on the branch should follow Conventional Commits (`test:`, `feat:`, `fix:`, …) so `main` stays changelog-friendly.
- **Delete the head branch after merge** (GitHub can do this automatically). Web/remote Claude branches are ephemeral anyway.
- **Always start a new task from a fresh branch off the updated `main`.**

Recommended GitHub repo settings (**Settings → General → Pull Requests**): allow **only** merge commits (disable squash merging and rebase merging), and enable "Automatically delete head branches".

## Notes
- `.claspignore` restricts what gets pushed to `Code.gs`, `Index.html`, and `appsscript.json` — the `Docs/` and `Sample Files/` folders stay local/Git only and are never sent to Apps Script.
- `.clasp.json` contains the Script ID (not secret, just an identifier) and is committed so the whole team points at the same project.
- Auth tokens (`~/.clasprc.json`) are per-user and never committed.

## Reading live sheet data locally (for testing/verification)
`Code.gs` has a token-gated `devDump` endpoint (`doGet` with `?action=devDump`) that returns raw sheet data as JSON. It's used by `scripts/fetch-sheet-data.js` to snapshot the live data for local inspection — never exposed in the UI.

**One-time setup:**

1. In the Apps Script editor, open `Code.gs`, select the `setupDevDumpToken` function in the function dropdown, and click **Run**. Authorize if prompted, then check the execution log (View -> Logs / Ctrl+Enter) for the generated token.
2. Copy `.env.example` to `.env` and paste the token as `DEV_DUMP_TOKEN`. `.env` is gitignored and never committed.
3. Run `npm run release` so the deployed web app has the `devDump` endpoint (only needed once after adding it).

**Usage:**

```sh
npm run fetch-data            # dumps every sheet to data/sheets-snapshot.json
npm run fetch-data -- Trips   # dumps just the "Trips" sheet to data/Trips.json
```

`data/` is gitignored — these snapshots contain real operational data (driver names, routes, etc.) and stay local only.

> Security note: the `devDump` endpoint is reachable by anyone with the web app URL **and** the token — treat `DEV_DUMP_TOKEN` like a password. To revoke it, run `setupDevDumpToken()` again to generate a new one (and redeploy).
