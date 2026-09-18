# Deploying

The app is **one Cloudflare Pages project**, `angeloyal-oms`. One `wrangler pages deploy` ships both parts:

- **Frontend** — `web/`, static files. No build step: the files in `web/` are the files served.
- **Backend** — `functions/api.js` (served at `/api`) and the `server/` modules it imports. Pages bundles them on deploy.
- **Database** — Cloudflare **D1**. Schema changes ship as numbered files in `migrations/`, applied with `wrangler d1 migrations apply`. A deploy does **not** apply them.

The repo is the source of truth for all three.

## Environments (PROD vs DEV)

| | PROD | DEV |
| :--- | :--- | :--- |
| Git branch | `main` | `develop` |
| Pages environment | production | preview |
| URL | [angeloyal-oms.pages.dev](https://angeloyal-oms.pages.dev) | [develop.angeloyal-oms.pages.dev](https://develop.angeloyal-oms.pages.dev) |
| D1 database | `angeloyal-oms` | `angeloyal-oms-dev` |
| `wrangler.toml` block | top level | `[env.preview]` |
| Deploy | `npm run release` (from `main` only) | `npm run deploy:dev` |
| Migrate | `npm run db:migrate:prod` (from `main` only) | `npm run db:migrate:dev` |
| Backup | `npm run db:export:prod` | `npm run db:export:dev` |

A Claude Code hook refuses the PROD commands outside `main`.

> **Until v2.0.0 ships**, the top-level D1 binding in `wrangler.toml` also points at `angeloyal-oms-dev`, and `main` still serves v1 (Apps Script + Sheets, under the old deploy scripts on the `v1.x` tags). The release creates the PROD database and swaps the binding. See [Docs/D1 Migration.md](Docs/D1%20Migration.md) §4 Phase 4 and the `/release` skill.

The page does not need to know its environment: it calls `/api` on its own origin, and the Pages environment picks the database. [`web/config.js`](web/config.js) only maps the hostname to a label for the Settings panel; an unknown host is "local", never prod.

Both environments live in the **developer's** Cloudflare account until handover — see [Transferring ownership](#transferring-ownership-to-angeloyal).

## One-time setup

1. **Install Node 24** (tests use the built-in `node:sqlite`) and the dependencies:

   ```sh
   npm install
   ```

2. **Log in to Cloudflare**: `npx wrangler login`. If the login sees more than one account, put `CLOUDFLARE_ACCOUNT_ID` in `.env` (`npx wrangler whoami` lists the IDs). Pages rejects `account_id` in `wrangler.toml`.

3. **Local database**: create the local D1 file and load data.

   ```sh
   npm run db:migrate:local          # schema + seed defaults
   npm run db:seed:local             # optional: data/d1-import.sql (see "Loading Sheets data")
   ```

4. **Your user row.** Sign-in works only for an email in `users`. On a fresh local database:

   ```sh
   npx wrangler d1 execute angeloyal-oms-dev --local --command "INSERT INTO users (email, display_name, role) VALUES ('you@example.com', 'You', 'Admin')"
   ```

   Use `--env preview --remote` instead of `--local` for the DEV database.

## Day-to-day workflow

```sh
git checkout develop && git pull
npm run dev:web                    # http://localhost:8788 — web/ + /api against the local D1
# ... make changes, npm test ...
git add -A && git commit -m "feat: ..."   # Conventional Commit, straight to develop
git push origin develop
npm run deploy:dev                 # develop.angeloyal-oms.pages.dev
```

- `npm run dev:web` serves `web/` with `_headers` (CSP) applied and runs `functions/api.js` locally against the local D1 in `.wrangler/`. This is the main development loop. It reloads on file changes.
- `npm run deploy:dev` uploads `web/` and the function to the preview environment on the `develop` alias. It uses the DEV database.
- A change with a new migration file: run `npm run db:migrate:local` for yourself, and `npm run db:migrate:dev` **before** `npm run deploy:dev`, so the code never runs against an old schema.
- Never edit a migration that any database already applied. Add a new numbered file.

For a big or risky change, use a branch: `git checkout -b feat/<task>`, then merge it back into `develop`.

## Google Sign-In (GIS) setup

Identity comes from **Google Identity Services**: the frontend renders the Google button, and posts its ID token to `/api` as `login`. `server/auth.js` verifies the token with Google's tokeninfo endpoint, checks its `aud` against `OAUTH_CLIENT_ID`, and opens a 12-hour session in the `sessions` table. There is no client secret.

One-time configuration in Google Cloud Console:

1. **APIs & Services → Credentials → Create OAuth client ID → Web application.**
2. **Authorized JavaScript origins** — every origin the frontend is served from. Not redirect URIs: this flow has no redirect, and putting them in the wrong box gives `Error 401: invalid_client — no registered origin`.
   - `https://angeloyal-oms.pages.dev`
   - `https://develop.angeloyal-oms.pages.dev`
   - `http://localhost:8788` (for `npm run dev:web`)

   Origins are scheme + host + port, no path and no trailing slash. `localhost` and `127.0.0.1` are **different origins**. A change can take a few minutes to apply — a first-load 403 on the button that clears on reload is that delay. Per-deployment preview URLs (`<hash>.angeloyal-oms.pages.dev`) cannot be registered — Google allows no wildcards — so test on the `develop` alias.
3. **OAuth consent screen** — scopes `openid email profile`. While in "Testing", every sign-in account must be a **Test user**. Switch **Publishing status to Production** for real users, or set **User type** to **Internal** if AngeLoyal uses Google Workspace. These scopes are non-sensitive, so Production needs no verification review; until one is done, each account sees a one-time "Google hasn't verified this app" screen.
4. **Client ID in two places** — it is public, so both are in source:
   - `OAUTH_CLIENT_ID` in [`wrangler.toml`](wrangler.toml) (`[vars]` and `[env.preview.vars]`), read by the server to check `aud`.
   - `OAUTH_CLIENT_ID` in [`web/config.js`](web/config.js), used by the GIS button.

   **They must match.** A mismatch fails every sign-in with "or ask an administrator".
5. **Users** — RBAC matches the signed-in email against `users` (`email` + `active = 1` → `role`). A verified Google account with no row signs in but sees the "Account not authorized" gate. Admins manage users in the app.

## Troubleshooting sign-in

| What you see | Cause | Fix |
| :--- | :--- | :--- |
| Google: *"Access blocked… no registered origin"* (`Error 401: invalid_client`) | The client has **no** JavaScript origins — usually they went into the redirect-URIs box, or onto another client | Step 2 above; check the client ID matches `web/config.js` |
| Google: *`origin_mismatch` (400)* | Origins exist but not this one (wrong port, `127.0.0.1` vs `localhost`, trailing slash) | Add the exact origin |
| Google: *"Access blocked" / `403: access_denied`* | Consent screen in **Testing** and the account is not a test user | Publish to Production, or add the account |
| App: *"Sign-in failed. Please try again."* (short) | The request failed — check the browser console and the `/api` response | Usually the function did not deploy or the D1 binding is missing; check `wrangler.toml` and redeploy |
| App: *"…or ask an administrator."* (long) | `login()` rejected the token — almost always an `aud` mismatch | Make the `wrangler.toml` and `web/config.js` client IDs match |
| App: *"Account not authorized"* card | Sign-in worked; the email has no active `users` row with a role | Add or activate the row. It is read on each sign-in, no redeploy needed |

## Loading Sheets data (v1 → v2, until the cutover)

v1 data lives in Google Sheets. `npm run fetch-data` reads it through the **still-deployed** v1 Apps Script (`devDump` endpoint), and `npm run db:migrate-sheets` turns the snapshot into SQL.

1. Copy `.env.example` to `.env` and set `DEV_DUMP_TOKEN` (PROD) and `DEV_DUMP_TOKEN_DEV` (DEV). Each token came from running `setupDevDumpToken()` once in that environment's Apps Script editor. Treat them like passwords.
2. Run:

   ```sh
   npm run fetch-data -- --dev     # DEV Sheet -> data/sheets-snapshot.json (omit --dev for PROD)
   npm run db:migrate-sheets       # -> data/d1-import.sql + reconciliation report
   npm run db:seed:local           # load it into the local D1
   ```

3. For a remote database: `npx wrangler d1 execute angeloyal-oms-dev --env preview --remote --file data/d1-import.sql`. The file starts with `DELETE FROM` every table, so it **replaces** the data. Export first (`npm run db:export:dev`).

Stop if the reconciliation report fails. `data/` is gitignored — snapshots hold real operational data. After v2.0.0 ships and the Apps Script deployments are archived, delete `fetch-data`, `scripts/fetch-sheet-data.js`, `scripts/sheets-to-d1.mjs` and the tokens.

## Git workflow (gitflow)

A solo project, developed mostly through Claude Code, on a simple gitflow:

- **`main` = production.** Only release merges and hotfixes land here. **`npm run release` and `npm run db:migrate:prod` run only from `main`.**
- **`develop` = integration.** Routine work commits straight here with Conventional Commit messages. `npm run deploy:dev` is the shared test copy.
- **Feature branches** (`feat/<task>`, `fix/<task>`) are optional — only for a big or risky change; merge back into `develop`.
- **Hotfix branches** (`hotfix/<task>`) branch off `main`: merge into `main`, tag and release, then merge `main` back into `develop`. Until v2.0.0 ships, `main` is v1 on Apps Script: re-apply a hotfix on `develop` by hand (frontend-only fixes cherry-pick).

### Releases (tags + GitHub Releases)

Every PROD deploy gets a tag and a GitHub Release. The `/release` skill has the runbook:

1. Merge `develop` → `main` (merge commit `release: vX.Y.Z`).
2. On `main`: `git tag vX.Y.Z && git push --tags`
3. `gh release create vX.Y.Z` — **write the notes for dispatchers** (below). `--generate-notes` gives a commit list; use it as raw material at most.
4. `npm run changelog:sync -- --apply`, then commit `web/changelog.json`. The in-app **"What's new?"** dialog reads it.
5. With a new migration: `npm run db:export:prod`, then `npm run db:migrate:prod`.
6. `npm run release` — the live app now matches the tag.

**Writing the release notes.** The Release body shows verbatim to dispatchers inside the app, so write it for them: what they can now do, what looks different. No commit messages, file names or jargon (`RBAC`, `CSP`, `D1`). Lead with anything that changes their routine. Keep it to a few bullets — they read it once, before the day's dispatch.

**Write them in ASD-STE100 Simplified Technical English.** The readers are Filipino dispatchers who read English as a second language, on a phone:

- **One word, one meaning.** The trip is always a *trip*, the button always the *button*.
- **Active voice, present tense.** "The board shows the new trip".
- **Short sentences.** Max ~20 words for an instruction, ~25 for a description. One idea per bullet.
- **Keep the articles and short words.** No telegram style.
- **No noun stacks over three words.**
- **Use the on-screen label**, not the internal name.
- **No jargon, idioms, slang or humour.**
- **Say what changed for them**, not what we changed.

The app's own nouns — *trip*, *waybill*, *outlet*, *truck*, *dispatch board*, *route file*, *POD* — are approved technical names.

Supported formatting: `###` headings, `-` bullets, `**bold**`, `` `code` ``, and plain paragraphs. Anything else renders as literal text (`renderNotes` in [`web/whatsnew.js`](web/whatsnew.js)). The in-app changelog starts at **v1.3.0**.

Versioning: **major** = project phase milestone (v1 = Phase 1, v2 = Billing & Payroll, v3 = Visibility & Alerts), **minor** = feature release, **patch** = hotfix. The latest tag on `main` is what is live.

### Commit / PR conventions

- Conventional Commits (`feat:`, `fix:`, `test:`, …) keep `--generate-notes` usable.
- A branch + PR is **merge-committed**, so the branch stays a named group in history.
- Pull `develop` before you start.

## The account launcher page

A tiny static page that redirects to the frontend. It is the link handed to operators, because the pages.dev URL underneath changes when the Cloudflare project moves to AngeLoyal's account (a Pages project cannot move between accounts). Retire it only after that handover has settled.

**It does not live in this repo.** GitHub Pages needs a *public* repo on the free plan and this repo is private, so the page lives in its own public repo, its only source of truth: **[akaNiknok/angeloyal-oms-launcher](https://github.com/akaNiknok/angeloyal-oms-launcher)**. It holds nothing confidential — identity is still gated by Google sign-in.

It is served at **`https://akaniknok.github.io/angeloyal-oms-launcher/`** — the link to hand out. If the frontend URL changes, edit it in a checkout of that repo and push:

```sh
cd ../angeloyal-oms-launcher
git add index.html && git commit -m "point at the new frontend URL" && git push
```

## Transferring ownership to AngeLoyal

- **Cloudflare Pages projects and D1 databases cannot move between accounts.** Handover: AngeLoyal creates a Cloudflare account → `npm run db:export:prod` from the developer account → `wrangler login` as AngeLoyal → `wrangler d1 create angeloyal-oms` and put the new id in `wrangler.toml` → `npm run db:migrate:prod` → load the export with `wrangler d1 execute angeloyal-oms --remote --file <export>` → `npm run release` (creates the Pages project) → delete the developer-owned project. Point the launcher page at the resulting URL. Do DEV the same way, or leave it with the developer.
- **The OAuth client lives in the developer's GCP project.** Move that GCP project to AngeLoyal, or create a new OAuth Web client under AngeLoyal and update `OAUTH_CLIENT_ID` in **both** `wrangler.toml` and `web/config.js`. Carry the JavaScript origins over, with any new pages.dev host.
- **Consent screen** — with a Workspace domain, set it to **Internal** so every AngeLoyal account is allowed. Otherwise publish to Production.
- **Users** — make sure AngeLoyal's staff have active `users` rows before the developer's Admin account is removed.

## Notes

- `.wrangler/` holds the local D1 file and dev caches. It is gitignored; delete it to start the local database from scratch.
- `data/`, `.env`, `*.xlsx` and `*.pdf` are gitignored — they hold real operational data.
- Preview deployments of any branch use the DEV database and are reachable by URL. Sign-in still gates every call.
