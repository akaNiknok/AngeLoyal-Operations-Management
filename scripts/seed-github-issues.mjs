#!/usr/bin/env node
// ============================================================
//  AngeLoyal OMS — seed-github-issues.mjs
//  Parses BACKLOG.md and creates one GitHub issue per item via
//  the `gh` CLI. Idempotent: skips items whose title already
//  exists as an issue. Skips Done items unless --all is passed.
//
//  Usage:
//    node scripts/seed-github-issues.mjs            # dry run (prints plan)
//    node scripts/seed-github-issues.mjs --apply    # create labels + issues
//    node scripts/seed-github-issues.mjs --apply --all   # include Done items
//
//  Requires: the GitHub CLI (`gh`) installed and authenticated
//  (`gh auth login`), run from inside the repo's git remote.
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKLOG_PATH = join(__dirname, '..', 'BACKLOG.md');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_DONE = args.includes('--all');

// ── Phase label colors (GitHub hex, no leading #) ──
const PHASE_LABELS = {
  1: { name: 'phase-1', color: '0e8a16', desc: 'Phase 1 — Records, Dispatch & Waybills' },
  2: { name: 'phase-2', color: 'fbca04', desc: 'Phase 2 — Billing & Payroll' },
  3: { name: 'phase-3', color: '1d76db', desc: 'Phase 3 — Visibility & Alerts' },
};
const PRIORITY_LABELS = {
  P0: { name: 'P0', color: 'b60205', desc: 'Must have' },
  P1: { name: 'P1', color: 'd93f0b', desc: 'Should have' },
  P2: { name: 'P2', color: 'fef2c0', desc: 'Nice to have' },
};
const TOPIC_COLOR = 'c5def5';

// ── Parse BACKLOG.md ──
function parseBacklog(md) {
  const lines = md.split(/\r?\n/);
  const items = [];
  let phase = null;
  let cur = null;

  const push = () => { if (cur) { items.push(cur); cur = null; } };

  for (const line of lines) {
    const phaseMatch = line.match(/^##\s+Phase\s+(\d)/);
    if (phaseMatch) { push(); phase = Number(phaseMatch[1]); continue; }

    const itemMatch = line.match(/^###\s+\[([A-Z]\d+-\d+)\]\s+(.+?)\s*$/);
    if (itemMatch) {
      push();
      cur = { id: itemMatch[1], title: itemMatch[2], phase, status: 'Todo',
              priority: 'P1', labels: [], body: [] };
      continue;
    }
    if (!cur) continue;

    const meta = line.match(/^- \*\*(Status|Priority|Labels|Description):\*\*\s*(.*)$/);
    if (meta) {
      const [, key, val] = meta;
      if (key === 'Status') cur.status = val.trim();
      else if (key === 'Priority') cur.priority = val.trim();
      else if (key === 'Labels') cur.labels = val.split(',').map(s => s.trim()).filter(Boolean);
      else if (key === 'Description') cur.body.push(val.trim());
      continue;
    }
    // Everything else (acceptance criteria etc.) becomes body
    cur.body.push(line);
  }
  push();
  return items.filter(i => i.phase);
}

// ── gh helpers ──
function gh(argv, opts = {}) {
  return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function ensureLabel({ name, color, desc }) {
  if (!APPLY) { console.log(`  would ensure label: ${name}`); return; }
  try {
    gh(['label', 'create', name, '--color', color, '--description', desc || '']);
    console.log(`  + label ${name}`);
  } catch (e) {
    // Label likely exists — try to update color/description, ignore failures.
    try { gh(['label', 'edit', name, '--color', color, '--description', desc || '']); } catch {}
  }
}

function existingTitles() {
  // Pull all issue titles (open + closed) so we stay idempotent.
  const out = gh(['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'title']);
  return new Set(JSON.parse(out).map(i => i.title));
}

function issueTitle(item) { return `[${item.id}] ${item.title}`; }

function issueBody(item) {
  const acceptance = item.body.join('\n').trim();
  return [
    item.body.length ? '' : '',
    acceptance,
    '',
    '---',
    `*Phase ${item.phase} · Priority ${item.priority} · seeded from \`BACKLOG.md\` (${item.id})*`,
  ].join('\n').trim();
}

// ── Main ──
function main() {
  const md = readFileSync(BACKLOG_PATH, 'utf8');
  const all = parseBacklog(md);
  const items = all.filter(i => INCLUDE_DONE || i.status !== 'Done');

  console.log(`Parsed ${all.length} items from BACKLOG.md ` +
    `(${items.length} to consider${INCLUDE_DONE ? '' : ', Done items skipped'}).`);
  console.log(APPLY ? 'Mode: APPLY (will call gh)\n' : 'Mode: DRY RUN (use --apply to create)\n');

  // 1. Labels
  console.log('Labels:');
  Object.values(PHASE_LABELS).forEach(ensureLabel);
  Object.values(PRIORITY_LABELS).forEach(ensureLabel);
  const topics = [...new Set(items.flatMap(i => i.labels))];
  topics.forEach(t => ensureLabel({ name: t, color: TOPIC_COLOR, desc: '' }));

  // 2. Issues
  const existing = APPLY ? existingTitles() : new Set();
  let created = 0, skipped = 0;
  console.log('\nIssues:');
  for (const item of items) {
    const title = issueTitle(item);
    if (existing.has(title)) { console.log(`  = skip (exists): ${title}`); skipped++; continue; }

    const labels = [PHASE_LABELS[item.phase].name, item.priority, ...item.labels];
    if (!APPLY) { console.log(`  would create: ${title}  [${labels.join(', ')}]`); continue; }

    gh(['issue', 'create', '--title', title, '--body', issueBody(item),
        '--label', labels.join(',')]);
    console.log(`  + created: ${title}`);
    created++;
  }

  console.log(`\nDone. ${APPLY ? `${created} created, ${skipped} skipped.` : 'Dry run — nothing changed.'}`);
  if (APPLY) {
    console.log('\nNext: add these issues to a GitHub Project (board) for a ' +
      'drag-and-drop Todo/In Progress/Done view:\n  gh project list   # find or create one');
  }
}

main();
