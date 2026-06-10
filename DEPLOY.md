# Deploying to Apps Script

This repo is wired up with [`clasp`](https://github.com/google/clasp) (Google's
Command Line Apps Script Projects tool) so that `Code.gs` and `Index.html`
here are the source of truth, and changes get pushed to the Apps Script
project bound to the AngeLoyal Google Sheet.

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

   This stores credentials in `~/.clasprc.json` (outside the repo, never
   committed).

4. **Connect to the existing Apps Script project**

   Open the Sheet -> Extensions -> Apps Script -> Project Settings (gear
   icon) -> copy the **Script ID**, then paste it into [`.clasp.json`](.clasp.json):

   ```json
   {
     "scriptId": "YOUR_SCRIPT_ID",
     "rootDir": "."
   }
   ```

5. **Reconcile the manifest** (`appsscript.json`)

   The repo has a placeholder `appsscript.json`. Before the first push, pull
   down the real one from Apps Script into a temp folder so we don't clobber
   any existing OAuth scopes / settings:

   ```sh
   npx clasp clone YOUR_SCRIPT_ID --rootDir ./.clasp-tmp
   ```

   Compare `.clasp-tmp/appsscript.json` with `appsscript.json`, merge any
   differences (scopes, sheet bindings, etc.) into the repo's copy, then
   delete `.clasp-tmp`.

## Day-to-day workflow

```sh
git pull                # get latest code
# ... make changes to Code.gs / Index.html ...
git add -A && git commit -m "..."
git push                # back up to GitHub
npm run push            # deploy to the Apps Script project (clasp push)
```

- `npm run push` — pushes local files to the **Apps Script editor** (updates
  the "head" / dev version, what you see when you open the script editor).
- `npm run open` — opens the project in the Apps Script editor in your browser.
- `npm run watch` — watches for local file changes and auto-pushes.
- `npm run deploy` — creates a new versioned **deployment** (needed if the
  Sheet/web app is served from a specific deployment rather than `HEAD`).

> Pushing does **not** automatically update an existing deployment's pinned
> version. If users access the tool via a deployed web app URL, run
> `npm run deploy` (or update the deployment via the Apps Script editor)
> after pushing changes you want live.

## Notes

- `.claspignore` restricts what gets pushed to `Code.gs`, `Index.html`, and
  `appsscript.json` — the `Docs/` and `Sample Files/` folders stay local/Git
  only and are never sent to Apps Script.
- `.clasp.json` contains the Script ID (not secret, just an identifier) and
  is committed so the whole team points at the same project.
- Auth tokens (`~/.clasprc.json`) are per-user and never committed.
