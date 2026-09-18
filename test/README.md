# Tests

Unit tests for the v2 backend (`server/`, `functions/api.js`) and the frontend
logic (`web/*.js`), runnable on a plain machine — **no wrangler, no live
database, no npm install**. `node:sqlite` (built into Node 24) runs the same
SQL as D1 in memory.

```sh
npm test                        # every test/*.test.js
node --test test/readers.test.js
```

## How the backend harness works

`harness.js` opens an in-memory `DatabaseSync`, applies `migrations/0001_init.sql`,
loads the fixtures, and wraps the database in a shim with the D1 shape
(`prepare / bind / all / first / run / batch / exec`). The shim binds values as
D1 does: booleans become integers, `undefined` throws, foreign keys are on.

```js
const { makeEnv, dump } = require('./harness');
const { api, db } = makeEnv({ sheets: { Users: [...], Trips: [...] }, userEmail: 'admin@angeloyal.com' });
await api.confirmWaybill(7, null);         // every server function, run in a request context
dump(db, 'waybills');                       // rows as plain objects, snake_case keys
```

- `sheets` are the legacy sheet-shaped fixtures (`[[headers], [row], …]`,
  headers in `fixtures.js`). They go through `server/migrate/transform.js` in
  lenient mode, so the old fixtures keep working. `tables` are native rows
  (`{ trips: [{ id, trip_date, … }] }`) inserted as-is.
- Fixtures load with foreign keys **off** (they are partial on purpose); the
  test body runs with them **on**, as D1 does. A writer that inserts a child
  of a row the fixture lacks fails — add the parent row.
- A self-seeding table (route map, colors, charge types, categories) gets its
  `0002_seed.sql` defaults only when the test provides no rows for it — the
  equivalent of "the sheet did not exist yet".
- `userEmail` is the request identity. `fetch` and `oauthClientId` stub the
  Google tokeninfo call for sign-in tests. `api.post(body)` drives
  `functions/api.js` the way the browser does.
- Every DB-touching function is `async`: `await` it, and `assert.rejects` a
  denied permission.

## What's covered

| Suite | Area |
| :-- | :-- |
| `db.test.js` | date vocabulary (Manila "today", client ↔ storage formats), batch atomicity, the shim's binding rules |
| `rbac.test.js` | the role × permission matrix, inactive / unknown users |
| `auth.test.js` | sign-in verification, sessions, the rpc allow-list, identity scoping across concurrent calls |
| `api.test.js` | the `/api` envelope: AUTH_REQUIRED, BAD_REQUEST, unknown actions |
| `readers.test.js` | every reader's return shape, rebuilt from the normalized tables |
| `transform.test.js` | the snapshot → tables rules (dates, helpers, waybill loads, orphans, rates) |
| `trips`, `edits`, `prepping`, `reorder`, `convoy`, `carryover`, `delete-trips` | trip writers: create, edit, status, order, convoy groups, carry-over spawn, delete |
| `waybills`, `prefixes` | waybill suggestion, atomic sequence reservation, confirmation, prefixes |
| `import` | the route-file import: grouping, outlet resolve-or-create, re-import |
| `masters`, `clear-data` | master-record writers, the Admin wipe |
| `billing-lines`, `billing-rates` | billing ledger pricing and overrides, the rate matrix and fuel prices |
| `transport.test.js`, `admin-records`, `billing-web`, `fliprender`, `route-file`, `trip-statuses`, `whatsnew` | frontend logic through `webharness.js` (stub DOM, no layout — check anything visual in a browser) |
