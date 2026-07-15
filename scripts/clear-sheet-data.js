#!/usr/bin/env node
// Clears all rows (keeps headers) from Trips, Outlets, Route Frequency Log,
// Waybills, and Audit Log via the Apps Script `devClear` endpoint (see
// DevTools.gs).
//
// Targets the DEV spreadsheet by default. Pass --prod to clear PRODUCTION,
// which requires typing a confirmation phrase first.
//
// Requires a .env file (gitignored) at the repo root with:
//   DEV_DUMP_TOKEN_DEV=<token from setupDevDumpToken() in the DEV Apps Script editor>
//   DEV_DUMP_TOKEN=<same, from the PROD editor — only needed with --prod>
//
// NOTE: --prod hits the live versioned deployment, so it only works once the
// `devClear` endpoint has been released to prod (npm run release).
//
// Usage:
//   node scripts/clear-sheet-data.js           # clear DEV
//   node scripts/clear-sheet-data.js --prod     # clear PRODUCTION (asks to confirm)

const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');

const ROOT = path.resolve(__dirname, '..');
// /exec URLs of the two deployments (see DEPLOY.md "Environments").
const DEV_URL = 'https://script.google.com/macros/s/AKfycbziNYgamxGPl7B8OVB1YYb1bZ2VZEdb9RC59pTEtUzSOeVNxAZCVtMc-6jJrqmdk26XgQ/exec';
const PROD_URL = 'https://script.google.com/macros/s/AKfycby8gSa29N58Ny3mJjkDgdbnaIWUfQocPQwJ0QochAh_mLDsmYslJaO0ANDCbuXYNYV0/exec';

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

async function confirmProd() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('This PERMANENTLY clears LIVE PRODUCTION data. Type "PRODUCTION" to proceed: ');
  rl.close();
  return answer.trim() === 'PRODUCTION';
}

async function main() {
  const env = { ...loadEnv(), ...process.env };
  const isProd = process.argv.includes('--prod');
  const target = isProd
    ? { url: PROD_URL, tokenKey: 'DEV_DUMP_TOKEN', label: 'PRODUCTION' }
    : { url: DEV_URL, tokenKey: 'DEV_DUMP_TOKEN_DEV', label: 'dev' };

  const token = env[target.tokenKey];
  if (!token) {
    console.error(`Missing ${target.tokenKey}. Add it to a .env file at the repo root.`);
    console.error(`Get it by running setupDevDumpToken() once in the ${isProd ? 'PROD' : 'DEV'} Apps Script editor.`);
    process.exit(1);
  }

  if (isProd && !(await confirmProd())) {
    console.log('Aborted.');
    process.exit(1);
  }

  const url = new URL(target.url);
  url.searchParams.set('action', 'devClear');
  url.searchParams.set('token', token);

  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();

  if (data.error) {
    console.error('Server returned error:', data.error);
    process.exit(1);
  }

  console.log(`Cleared (${target.label}):`, data.cleared.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
