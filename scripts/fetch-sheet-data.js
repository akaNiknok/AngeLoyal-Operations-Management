#!/usr/bin/env node
// Pulls a JSON snapshot of the live Google Sheet via the Apps Script
// `devDump` endpoint (see Code.gs) and writes it to data/sheets-snapshot.json
// for local inspection / test fixtures.
//
// Requires a .env file (gitignored) at the repo root with:
//   DEV_DUMP_TOKEN=<token from running setupDevDumpToken() in the Apps Script editor>
//   DEV_DUMP_TOKEN_DEV=<same, from the DEV script — only needed with --dev>
//
// Usage:
//   node scripts/fetch-sheet-data.js            # dump all sheets (production)
//   node scripts/fetch-sheet-data.js Trips       # dump a single sheet
//   node scripts/fetch-sheet-data.js --dev       # dump from the DEV spreadsheet

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROD_URL = 'https://script.google.com/macros/s/AKfycby8gSa29N58Ny3mJjkDgdbnaIWUfQocPQwJ0QochAh_mLDsmYslJaO0ANDCbuXYNYV0/exec';
const DEV_URL = 'https://script.google.com/macros/s/AKfycbziNYgamxGPl7B8OVB1YYb1bZ2VZEdb9RC59pTEtUzSOeVNxAZCVtMc-6jJrqmdk26XgQ/exec';

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

async function main() {
  const env = { ...loadEnv(), ...process.env };
  const args = process.argv.slice(2);
  const isDev = args.includes('--dev');
  const tokenKey = isDev ? 'DEV_DUMP_TOKEN_DEV' : 'DEV_DUMP_TOKEN';
  const token = env[tokenKey];
  if (!token) {
    console.error(`Missing ${tokenKey}. Add it to a .env file at the repo root.`);
    console.error(`Get it by running setupDevDumpToken() once in the ${isDev ? 'DEV ' : ''}Apps Script editor.`);
    process.exit(1);
  }

  const sheetArg = args.find(a => a !== '--dev');
  const url = new URL(isDev ? DEV_URL : PROD_URL);
  url.searchParams.set('action', 'devDump');
  url.searchParams.set('token', token);
  if (sheetArg) url.searchParams.set('sheet', sheetArg);

  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();

  if (data.error) {
    console.error('Server returned error:', data.error);
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = sheetArg
    ? path.join(outDir, `${sheetArg.replace(/[^a-z0-9_-]+/gi, '_')}.json`)
    : path.join(outDir, 'sheets-snapshot.json');

  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
