#!/usr/bin/env node
// ============================================================
//  AngeLoyal OMS — sync-changelog.mjs
//  Regenerates web/changelog.json from the repo's GitHub Releases,
//  which the "What's new?" dialog reads at runtime.
//
//  GitHub is where release notes are authored (gitflow already
//  requires a Release per tag); this pulls them into the frontend
//  at deploy time so the browser never needs a token — the repo is
//  private, so it could not read the API directly — and so the notes
//  can never describe a version the user isn't actually running.
//
//  Usage:
//    node scripts/sync-changelog.mjs            # dry run: print what would change
//    node scripts/sync-changelog.mjs --apply    # write web/changelog.json
//
//  Requires the `gh` CLI installed + authenticated (`gh auth login`).
//
//  Write the Release body for dispatchers, not developers: what they
//  can now do, in their words. See DEPLOY.md → Releases.
// ============================================================

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'web', 'changelog.json');

// The in-app changelog starts here: releases before this predate the
// feature and describe an app the users never saw notes for.
const FIRST_VERSION = 'v1.3.0';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function gh(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** [1,3,0] for "v1.3.0" — anything unparseable sorts last. */
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function main() {
  let raw;
  try {
    raw = gh(['release', 'list', '--limit', '100', '--json', 'tagName,name,publishedAt,isDraft']);
  } catch (err) {
    console.error('Could not list releases. Is `gh` installed and authenticated?');
    console.error(String(err.stderr || err.message).trim());
    process.exit(1);
  }

  const releases = JSON.parse(raw)
    .filter((r) => !r.isDraft && compareVersions(r.tagName, FIRST_VERSION) >= 0)
    .sort((a, b) => compareVersions(b.tagName, a.tagName)); // newest first

  if (!releases.length) {
    console.error(`No published releases at or after ${FIRST_VERSION}. Nothing to sync.`);
    process.exit(1);
  }

  const entries = releases.map((r) => {
    const body = JSON.parse(gh(['release', 'view', r.tagName, '--json', 'body'])).body || '';
    return {
      version: r.tagName,
      // Date only — the dialog shows "23 Aug 2026", never a time.
      date: (r.publishedAt || '').slice(0, 10),
      title: (r.name || '').replace(new RegExp('^' + r.tagName + '\\s*[-—:]?\\s*'), '').trim(),
      body: body.replace(/\r\n/g, '\n').trim(),
    };
  });

  const json = JSON.stringify({ releases: entries }, null, 2) + '\n';

  const before = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : '';
  if (before === json) {
    console.log(`web/changelog.json already up to date (${entries.length} releases).`);
    return;
  }

  if (!APPLY) {
    console.log(`Would write ${entries.length} releases to web/changelog.json:`);
    entries.forEach((e) => console.log(`  ${e.version}  ${e.date}  ${e.title}`));
    console.log('\nRe-run with --apply to write it.');
    return;
  }

  writeFileSync(OUT_PATH, json, 'utf8');
  console.log(`Wrote web/changelog.json (${entries.length} releases, newest ${entries[0].version}).`);
}

main();
