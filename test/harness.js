// ============================================================
//  AngeLoyal OMS — Test harness
//  Runs the ESM backend in server/ against an in-memory SQLite
//  (node:sqlite, built into Node 24) behind a shim with the D1
//  shape (prepare / bind / all / first / run / batch / exec). Same
//  SQL, same constraints, no wrangler, no install.
//
//  makeEnv({ sheets, tables, userEmail, fetch, oauthClientId })
//    sheets   legacy sheet-shaped fixtures { 'Sheet': [[headers], [row]…] },
//             converted through server/migrate/transform.js (lenient).
//    tables   native rows { table: [{ snake_case: value }] }, inserted as-is.
//    Fixtures load with foreign keys OFF (they are partial on purpose);
//    the test body runs with foreign keys ON, as D1 does.
//    A self-seeding table (see migrations/0002_seed.sql) is seeded only
//    when the test provides no rows for it.
//  Returns { api, db, raw }: `api` is every server function, each run
//  inside the request context; `db` is the D1 shim; `raw` the
//  DatabaseSync. `api.post(body)` drives web/functions/api.js.
//  dump(db, 'trips') returns the rows as plain objects.
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

// Node 24 loads ESM through require() when the module has no top-level await.
const ctx = require('../server/ctx.js');
const dbmod = require('../server/db.js');
const rbac = require('../server/rbac.js');
const internals = require('../server/internals.js');
const readers = require('../server/readers.js');
const auth = require('../server/auth.js');
const writers = ['trips', 'waybills', 'import', 'masters', 'billing'].map((m) => require(`../server/writers/${m}.js`));
const { transform } = require('../server/migrate/transform.js');
const { onRequestPost } = require('../functions/api.js');

// ------------------------------------------------------------
//  D1 shim
// ------------------------------------------------------------

/** node:sqlite rows have a null prototype; tests compare against plain objects. */
const plain = (r) => ({ ...r });

/** What D1 does with a bound value: booleans become integers, undefined is an error. */
function coerce(v) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined not supported for value undefined');
  if (v === true) return 1;
  if (v === false) return 0;
  if (v instanceof Date) throw new TypeError('D1_TYPE_ERROR: Type Date not supported');
  return v;
}

class D1Statement {
  constructor(raw, sql) { this.raw = raw; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map(coerce); return this; }
  async all() {
    const results = this.raw.prepare(this.sql).all(...this.args).map(plain);
    return { results, success: true, meta: {} };
  }
  async first(col) {
    const r = this.raw.prepare(this.sql).get(...this.args);
    if (!r) return null;
    return col === undefined ? plain(r) : r[col];
  }
  async run() {
    const m = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: m.changes, last_row_id: Number(m.lastInsertRowid) } };
  }
}

class D1Database {
  constructor(raw) { this.raw = raw; }
  prepare(sql) { return new D1Statement(this.raw, sql); }
  async batch(stmts) {
    this.raw.exec('BEGIN');
    try {
      const out = [];
      // Synchronous on purpose: an await here would let a concurrent batch
      // interleave and open a nested transaction, which real D1 never does.
      for (const s of stmts) out.push({ results: this.raw.prepare(s.sql).all(...s.args).map(plain), success: true, meta: {} });
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) { this.raw.exec(sql); return { count: 0, duration: 0 }; }
}

// ------------------------------------------------------------
//  Schema, fixtures, seed
// ------------------------------------------------------------

const SCHEMA = fs.readFileSync(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8');
const SEED = fs.readFileSync(path.join(ROOT, 'migrations', '0002_seed.sql'), 'utf8');

/** { table: sql } from the `-- @seed <table>` sections of 0002_seed.sql. */
function seedSections() {
  const out = {};
  let cur = null;
  SEED.split('\n').forEach((line) => {
    const m = /^--\s*@seed\s+(\w+)/.exec(line);
    if (m) { cur = m[1]; out[cur] = ''; return; }
    if (cur && !/^\s*--/.test(line)) out[cur] += line + '\n';
  });
  return out;
}

const SEED_SHEET = {
  billing_categories: 'Billing Categories',
  route_type_map: 'Route Type Map',
  customer_group_colors: 'Customer Group Colors',
  billing_charge_types: 'Billing Charge Types',
};

function insertRows(raw, table, rows) {
  const cache = {};
  rows.forEach((row) => {
    const cols = Object.keys(row);
    const key = cols.join(',');
    if (!cache[key]) {
      cache[key] = raw.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    }
    cache[key].run(...cols.map((c) => coerce(row[c] === undefined ? null : row[c])));
  });
}

// ------------------------------------------------------------
//  Public entry point
// ------------------------------------------------------------

/**
 * @param {Object}   [opts]
 * @param {Object}   [opts.sheets]         Sheet-shaped fixtures (legacy).
 * @param {Object}   [opts.tables]         Native table rows.
 * @param {string}   [opts.userEmail]      The request identity ('unknown' = not signed in).
 * @param {Function} [opts.fetch]          Stub for the tokeninfo call: (url) => Response-like.
 * @param {string}   [opts.oauthClientId]  The `aud` a token must carry.
 * @returns {{ api: Object, db: D1Database, raw: DatabaseSync, store: Object }}
 */
function makeEnv(opts = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec('PRAGMA foreign_keys = OFF');

  const { tables } = transform(opts.sheets || {}, { strict: false });
  Object.entries(opts.tables || {}).forEach(([t, rows]) => { tables[t] = (tables[t] || []).concat(rows); });
  Object.entries(tables).forEach(([t, rows]) => insertRows(raw, t, rows));

  const sections = seedSections();
  Object.entries(SEED_SHEET).forEach(([table, sheet]) => {
    const given = (opts.sheets && sheet in opts.sheets) || (opts.tables && table in opts.tables);
    if (!given && sections[table]) raw.exec(sections[table]);
  });

  raw.exec('PRAGMA foreign_keys = ON');

  const db = new D1Database(raw);
  const store = {
    db,
    email: opts.userEmail || 'unknown',
    clientId: opts.oauthClientId || '',
    fetch: opts.fetch || (() => Promise.resolve({ status: 404, json: async () => ({}) })),
  };

  const api = {};
  [ctx, dbmod, internals, rbac, readers, auth, ...writers].forEach((mod) => {
    Object.entries(mod).forEach(([name, fn]) => {
      if (typeof fn === 'function') api[name] = (...args) => ctx.runWith(store, () => fn(...args));
    });
  });

  /** Drives the Pages Function the way the browser does: a JSON string body. */
  api.post = (body) => ctx.runWith(store, () => onRequestPost({
    request: new Request('http://oms.test/api', {
      method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env: { DB: db, OAUTH_CLIENT_ID: store.clientId },
  }).then((res) => res.json()));

  return { api, db, raw, store };
}

/** All rows of a table as plain objects, in rowid order. */
function dump(db, table) {
  return db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(plain);
}

module.exports = { makeEnv, dump, D1Database };
