# server/ — backend notes

Loads when you work in `server/`. The root `CLAUDE.md` holds the constraints that apply everywhere.

| File | Gotcha |
| :--- | :--- |
| `ctx.js` | `AsyncLocalStorage` request context: `db()`, `currentEmail()`, `clientId()`, `fetchImpl()`, `runWith()`. **The only holder of per-request state** — a module-level global is shared across requests in a Worker isolate and would mis-attribute RBAC and audit rows. |
| `db.js` | D1 helpers: `stmt`, `q`, `one`, `run`, `batch`, plus the date vocabulary (`nowPH`, `todayPH`, `toClientDate`, `fromClientDate`…). **Reuse these. Do not call `db().prepare` by hand.** |
| `auth.js` | Google sign-in and sessions. `login(idToken)` is the one pre-session action: `_verifyIdToken` checks the token against Google's tokeninfo endpoint (**never a local decode**), then inserts a row in `sessions` (12 h). Every other call goes through **`rpc(sessionToken, fnName, args)`**, its `RPC_ALLOWED` list and the `FNS` registry. |
| `readers.js` | Read-only accessors, and the row mappers writers reuse for read-back (`tripFromRow`, `waybillFromRow`, `billingLineFromRow`). `getBootData()` returns all master data in one round trip. Readers rebuild the v1 shapes (`helperIds`, `manualCharges`, the rate grid) from the normalized tables. |
| `internals.js` | Shared private helpers: `_auditLog`/`_auditLogBatch`, areas and fuel bands (`_normArea`, `_fuelBandLabel`), `_rateFor`, `_computeBillingLine`, `nextBusinessDay`, billing constants. `_fuelBandLabel()` must name the bands exactly as `FUEL_BANDS` does in `web/billing-matrix.js`. |
| `migrate/transform.js` | Sheet snapshot JSON → table rows. Used by `scripts/sheets-to-d1.mjs` and the test harness. Remove the Sheets import path after the v2.0.0 cutover. |
