#!/usr/bin/env node
// Claude Code hooks. Wired in .claude/settings.json; one file, three modes.
//   handoff        SessionStart  — feed HANDOFF.md back into a fresh session
//   guard-release  PreToolUse    — refuse a PROD deploy from a branch that is not main
//   test           Stop          — run npm test when source files changed this turn
// ponytail: one dispatch script instead of three; split it when a mode grows past ~20 lines.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const repo = dirname(import.meta.dirname);
const mode = process.argv[2];
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin */ }

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

if (mode === 'handoff') {
  const file = join(repo, 'HANDOFF.md');
  if (existsSync(file)) {
    process.stdout.write('HANDOFF.md is present. Resume from it, then delete it once resolved:\n\n');
    process.stdout.write(readFileSync(file, 'utf8'));
  }
  process.exit(0);
}

if (mode === 'guard-release') {
  const cmd = input?.tool_input?.command || '';
  // Command position only, so the words inside a heredoc or an echo do not trip the guard.
  if (/(^|[;&|]\s*)(npm run release|npm run deploy:web\b|clasp push --force)/.test(cmd)) {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== 'main') {
      process.stderr.write(`Blocked: this command touches PROD and the branch is "${branch}". Release only from main, after the tag. See DEPLOY.md.\n`);
      process.exit(2);
    }
  }
  process.exit(0);
}

if (mode === 'test') {
  if (input?.stop_hook_active) process.exit(0);            // already re-entered once; do not loop
  const dirty = git('status', '--porcelain')
    .split('\n')
    .some((line) => /\.(gs|js|mjs)$/.test(line));
  if (!dirty) process.exit(0);
  const run = spawnSync('npm', ['test'], { cwd: repo, encoding: 'utf8', shell: true });
  if (run.status !== 0) {
    const out = `${run.stdout || ''}${run.stderr || ''}`.split('\n').slice(-40).join('\n');
    process.stderr.write(`npm test failed after your edits. Fix it before you stop.\n\n${out}\n`);
    process.exit(2);
  }
  process.exit(0);
}

process.exit(0);
