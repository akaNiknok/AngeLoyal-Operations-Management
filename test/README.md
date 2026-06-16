# Tests

Unit tests for the Apps Script backend (`.gs` files), runnable on a plain
machine — **no Apps Script account, no clasp, no live Google Sheet, and no npm
install** (the harness uses Node's built-in `node:test` and `vm`).

```sh
npm test
```

## How it works

Apps Script has no module system: every `.gs` file shares one global scope, and
the backend talks to Google via the `SpreadsheetApp` / `Session` / `Utilities`
globals. `harness.js` mirrors that:

- It concatenates the `.gs` files and runs them as **one script** inside a Node
  `vm` context, so top-level `const`s (`SHEET_*`, `ROLES`, `PERMISSIONS`) and
  `function`s see each other exactly as on Apps Script.
- It injects **in-memory fakes** for the Apps Script globals. A "sheet" is just
  a 2D array (header row + data rows); `FakeSheet`/`FakeRange` implement the
  slice of the Sheets API the code actually calls (`getDataRange`, `getRange`,
  `appendRow`, `deleteRow`, `setValues`, …).
- `makeEnv({ sheets, userEmail })` returns `{ api, ss }`: `api` is every backend
  function, `ss` is the fake spreadsheet you can read back to assert on writes.

```js
const { makeEnv, dump, rowObject } = require('./harness');
const { api, ss } = makeEnv({ sheets: { Users: [...], Trips: [...] }, userEmail: 'admin@angeloyal.com' });
api.confirmWaybill(7, null);
const { headers, rows } = dump(ss, 'Waybills'); // inspect the result
```

## What's covered (first slice)

| Suite | Area | Why it matters |
| :-- | :-- | :-- |
| `utils.test.js` | `Utils.gs` pure helpers | date parse/format, Excel-serial conversion, business-day skip, lookups |
| `rbac.test.js` | `Code.gs` permission matrix | the server is the real access gate |
| `waybills.test.js` | waybill numbering & confirmation | suffix rules, sequence guard, custom-number parsing, immutability |
| `carryover.test.js` | carry-over trips | Billing-Date preservation, crew copy, parent linkage, `-R`/`-FT` waybills |

## Fixtures & gotchas

- `fixtures.js` holds the sheet **header rows**, mirrored from `Docs/Schema.md`
  and the column order the writers append in. **Keep these in sync** if the
  schema changes — a drift here is a real bug the tests should surface.
- Objects returned *from* the bundle live in the vm realm, so their prototype
  differs from the host's: prefer field-by-field assertions over
  `deepStrictEqual` on returned objects. The host `Date` is shared into the vm
  so `instanceof Date` works across the boundary.

## Adding tests for a new area

1. Seed the sheets it reads/writes in `makeEnv({ sheets })` (add headers to
   `fixtures.js` if missing).
2. Set `userEmail` to a user whose role passes the writer's `_requirePermission`.
3. Call `api.yourFunction(...)`, then `dump(ss, 'Sheet')` to assert on the result.

Good next targets: import/outlet resolution (`importRouteFile`,
`_resolveOrCreateOutlet`), billing-category rename cascade, and — when Phase 2
lands — the billing and payroll math (write the tests alongside the code).
