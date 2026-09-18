# AngeLoyal OMS — D1 Schema Specification

The database is **Cloudflare D1** (SQLite). The DDL in [`migrations/`](../migrations/) is the source of truth for types and constraints; this document explains what each table means and how the system uses it. Keep the two in lockstep: a schema change is a new numbered migration file plus an edit here.

v1 kept the same data in Google Sheets. [`Docs/D1 Migration.md`](D1%20Migration.md) §3.1 lists how each sheet maps to a table.

## Conventions

- **Table and column names** are `snake_case`. Readers return `camelCase` keys to the client, in the shape the v1 readers returned.
- **IDs** are `INTEGER PRIMARY KEY`. SQLite assigns them, so two concurrent inserts never share one. The import from Sheets keeps the v1 ID values, so `audit_log.row_id` still points at the right row.
- **Foreign keys** are numeric IDs, never names. D1 enforces them.
- **Booleans** are `INTEGER` `0/1`.
- **Pure dates** are `TEXT` `YYYY-MM-DD`. **Timestamps** are `TEXT` `YYYY-MM-DD HH:MM:SS` in Asia/Manila time. Readers send dates to the client as `M/d/yyyy`. "Today" always comes from `todayPH()`, because Workers run in UTC.
- **Names that must be unique** (email, plate, outlet name, prefix, category) use `UNIQUE COLLATE NOCASE`. The constraint is the guard; a writer turns the violation into a readable error.
- **Multi-row writes** go in one `db.batch()`, which is atomic.
- **Append-only tables**: `audit_log` and `route_frequency_log`. Never update or delete a prior row, except through the Admin wipe.

## Table registry

| # | Table | Group | Kind |
| :-- | :-- | :-- | :-- |
| 1 | `users` | Config | Access list |
| 2 | `sessions` | Config | Sign-in sessions |
| 3 | `billing_categories` | Config | Master (seeded) |
| 4 | `route_type_map` | Config | Master (seeded) |
| 5 | `customer_group_colors` | Config | Master (seeded) |
| 6 | `waybill_prefixes` | Config | Master |
| 7 | `employees` | People & Trucks | Master |
| 8 | `trucks` | People & Trucks | Master + the truck roster |
| 9 | `truck_default_helpers` | People & Trucks | Roster helpers |
| 10 | `outlets` | People & Trucks | Master (filled by import) |
| 11 | `trips` | Dispatch | Core ledger |
| 12 | `trip_helpers` | Dispatch | Trip helpers |
| 13 | `route_frequency_log` | Dispatch | Append-only |
| 14 | `waybills` | Waybills | Ledger, one row per load |
| 15 | `freight_rates` | Billing | DOE rate matrix, long format |
| 16 | `fuel_prices` | Billing | Weekly price history |
| 17 | `billing_charge_types` | Billing | Master (seeded) |
| 18 | `billing_lines` | Billing | Billing ledger |
| 19 | `billing_line_charges` | Billing | Manual charges per line |
| 20 | `audit_log` | Audit | Append-only |

`0002_seed.sql` holds the defaults for the seeded tables as `INSERT OR IGNORE`. A database that already has rows keeps them.

## Group 1: Config

### users

Maps a Google account email to a role.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| email | TEXT, unique (nocase) | The verified Google sign-in email |
| display_name | TEXT | Name shown in the UI |
| role | TEXT | `Admin`, `Dispatcher`, `Payroll` or `Viewer` (CHECK) |
| active | INTEGER 0/1 | `0` blocks access |

#### Role permissions matrix

| Feature | Admin | Dispatcher | Payroll | Viewer |
| :-- | :-- | :-- | :-- | :-- |
| View dispatch board | ✓ | ✓ | ✓ | ✓ |
| Assign drivers to trips | ✓ | ✓ | — | — |
| Add manual trips | ✓ | ✓ | — | — |
| Flag trip status | ✓ | ✓ | — | — |
| Confirm waybill numbers | ✓ | ✓ | — | — |
| Edit the truck roster | ✓ | ✓ | — | — |
| Edit outlets | ✓ | — | — | — |
| Edit billing categories | ✓ | — | — | — |
| Edit waybill prefixes | ✓ | ✓ | — | — |
| Edit users | ✓ | — | — | — |
| View the Audit Log | ✓ | — | — | — |
| Clear all transactional data | ✓ | — | — | — |

`server/rbac.js` holds the matrix. The server is the real gate; the UI only hides controls.

### sessions

One row per signed-in browser. `login()` verifies the Google ID token with Google, then inserts a random token here.

| Column | Type | Notes |
| :-- | :-- | :-- |
| token | TEXT PK | Random session token the client keeps in `localStorage` |
| email | TEXT | The verified email |
| display_name | TEXT | From the Google token |
| expires_at | TEXT timestamp | 12 hours after sign-in. A sign-in deletes expired rows |

### billing_categories

The billing classes an Admin assigns to trucks (10W, 6W, L300).

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| name | TEXT, unique (nocase) | e.g. `6W` |
| active | INTEGER 0/1 | Inactive categories leave the truck dropdown but stay valid for trucks that use them |

**Seed:** `10W`, `6W`, `L300`.

Trucks and the route type map point at a category by ID, so a rename needs no cascade. Trips keep a text snapshot (`trips.truck_billing_category`), so a rename does not re-price history.

### route_type_map

Maps a truck-type column code in the Rebisco route file (6WF, 6WC, 4WC…) to a billing category. The route file gives the truck count for each type in its own column, separate from the client's Restrictions field. The import reads which column holds the count, looks up the category here, and assigns a truck of that category.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| file_type_code | TEXT, unique (nocase) | Column header in the route file |
| billing_category_id | INTEGER FK → billing_categories | |
| active | INTEGER 0/1 | The import ignores inactive rows |

**Seed:** `10W`→10W, `6WF`→6W, `6WC`→6W, `4WC`→6W, `L300`→L300.

A code with no row falls back to a category with the same name. When no truck of the category is free, the trip keeps a blank truck but still records the category, so the dispatcher sees the type it needs.

### customer_group_colors

The color chip for each customer group on the dispatch board and exports. A customer group is the free-text `outlets.customer_group` code (PG, SM, WM); this table only assigns a color.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| customer_group | TEXT, unique (nocase) | |
| color | TEXT | `#rrggbb`; null clears it |
| active | INTEGER 0/1 | `0` or a null color falls back to a color hashed from the group name |

**Seed:** PG `#92d050`, SM `#00b0f0`, WM `#ffe94d`, RO `#e5b8b7`, SW `#e5b8b7`, PS `#ffc000`, ALFA `#ffc000`.

`saveCustomerGroupColor(group, color)` upserts by group code and needs `EDIT_MASTER_RECORDS`.

### waybill_prefixes

One row per waybill booklet.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| prefix | TEXT, unique (nocase) | e.g. `AY`. Empty string means no prefix: the number prints as the bare sequence (`10761`) |
| company_name | TEXT | e.g. AngeLoyal Logistics |
| last_sequence_number | INTEGER | The last sequence issued. A plain number, never padded text |
| sequence_width | INTEGER | The booklet's digit width. `4` prints `0358`. Padding never truncates a longer number |
| active | INTEGER 0/1 | Inactive prefixes leave the pickers but stay valid for issued waybills |

> **Why the width has its own column.** v1 once inferred the width from the text format of the counter (`0358`). The write that kept the text format silently failed, so every zero-padded booklet froze and re-issued the same numbers (`AY-0359` on four FOs). The counter is now a number and the width is data. A re-base to a number the booklet already issued is refused.

## Group 2: People & Trucks

### employees

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| nickname | TEXT | The name in dispatch dropdowns |
| first_name, middle_name, last_name | TEXT | Legal name |
| role | TEXT | e.g. `Driver`, `Helper` |
| active | INTEGER 0/1 | Inactive employees leave the dispatch options |

### trucks

The fleet and the **truck roster** in one table. v1 kept the roster in a separate 1:1 Default Assignments sheet; it folded in here.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | Also the ID `getDefaultAssignments()` returns for a roster row |
| plate_number | TEXT, unique (nocase) | |
| brand | TEXT | e.g. Isuzu |
| type | TEXT | Model or body |
| active | INTEGER 0/1 | Inactive trucks leave the dispatch options |
| billing_category_id | INTEGER FK → billing_categories | Set by an Admin |
| default_driver_id | INTEGER FK → employees | Roster driver; nullable |
| roster_notes | TEXT | e.g. "Driver available Mon–Wed only" |

### truck_default_helpers

The roster helpers of a truck, 0–3 rows.

| Column | Type | Notes |
| :-- | :-- | :-- |
| truck_id | INTEGER FK → trucks | Cascades on truck delete |
| employee_id | INTEGER FK → employees | |
| slot | INTEGER 1–3 | Order on the crew card. PK is `(truck_id, slot)` |

`updateDefaultAssignment` edits the roster and needs `ASSIGN_CREW` (Admin, Dispatcher). A roster change applies to new trips only. A one-day crew change goes on the trip, not here.

### outlets

Empty at first. The route-file import inserts every outlet name it does not know. An Admin then adds the address, group and notes.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| outlet_name | TEXT, unique (nocase) | Exact name from the route file |
| area | TEXT | e.g. `Tanza`. Trips read the area through this join |
| address | TEXT | |
| customer_group | TEXT | e.g. `PG` |
| notes | TEXT | Dock hours, restrictions |
| created_at | TEXT timestamp | |

## Group 3: Dispatch

### trips

One row per delivery drop. Several rows share an FO number on a multi-drop route. A split load uses a suffix (A, B, C).

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| trip_date | TEXT date | The calendar dispatch day |
| billing_date | TEXT date | The original operational day. It stays the same through carry-overs |
| fo_number | TEXT | Rebisco Freight Order |
| fo_split_suffix | TEXT | A, B, C for a split load; null for one truck |
| outlet_id | INTEGER FK → outlets | |
| quantity | INTEGER | Cartons |
| cbm | REAL | Cubic meters |
| restrictions | TEXT | Truck constraint the client asks for (e.g. 6W) |
| truck_id | INTEGER FK → trucks | |
| driver_id | INTEGER FK → employees | |
| truck_billing_category | TEXT | Snapshot of the truck's category at dispatch |
| trip_status | TEXT | CHECK: `Prepping`, `Backlog`, `Scheduled`, `Preload`, `Delivered`, `Undelivered`, `Foul Trip - No Redeliver`, `Foul Trip - For Redeliver`, `Redeliver`, `Two-Day Trip` |
| parent_trip_id | INTEGER FK → trips | The trip a carry-over came from |
| source | TEXT | CHECK: `Import`, `Manual`, `Carry-over` |
| tier | INTEGER | Client priority 1–3; null for manual trips |
| remarks | TEXT | |
| status_changed_by, status_changed_at | TEXT | Email and timestamp of the last status change |
| added_by, added_at | TEXT | Email and timestamp of creation |
| convoy_group | TEXT | Token for trucks that travel together; unique within a trip date; null when not in a convoy |
| sort_order | INTEGER | Manual order within a trip date (drag on the board); null sorts last |
| origin | TEXT | Rebisco warehouse (`TANZA`, `LINGUNAN`…), chosen once per route file. Selects the rate matrix |
| waybill_id | INTEGER FK → waybills | The load's waybill; null before one is suggested |

### trip_helpers

The helpers of a trip, 0–3 rows. Same shape as `truck_default_helpers`, keyed `(trip_id, slot)`, cascading on trip delete. Readers rebuild the client's `helperIds` string from these rows.

#### Status and carry-over workflow

```
Prepping (imported, no waybill — the dispatcher merges, splits and reassigns freely)
  → Scheduled (markDayScheduled promotes the day; waybills are suggested)
  → Backlog (promoted with no crew — no waybill; carries over to the
             next business day as a new Prepping trip)
Scheduled
  → Preload (loaded, not yet delivered)
      → Delivered
  → Delivered
  → Undelivered
      → Foul Trip - No Redeliver (billed as foul, no next-day attempt)
      → Foul Trip - For Redeliver (carries over, gets a -FT waybill)
      → Redeliver (carries over, gets a -R waybill)
      → Two-Day Trip (two days, one billing)
```

When a trip changes to `Foul Trip - For Redeliver`, `Redeliver` or `Backlog`, the server inserts a new trip and its helpers in one batch:

- `trip_date` = the next business day
- `billing_date` = the parent's billing date
- `parent_trip_id` = the parent's ID
- `source` = `Carry-over`
- `trip_status` = `Scheduled`, or `Prepping` for a `Backlog` carry-over (it still needs a crew and gets no waybill)
- waybill = the parent's number with `-R` or `-FT`, not a new number (see the waybills section)

### route_frequency_log

Append-only. One row each time a driver is scheduled to an outlet. It feeds the driver-frequency warning.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| trip_id | INTEGER FK → trips | The date comes from this join |
| driver_id | INTEGER FK → employees | |
| outlet_id | INTEGER FK → outlets | |

A trip is logged when it **leaves Prepping**: through `markDayScheduled`, a manual status change, or creation at another status (manual trips and carry-overs). The import logs nothing, because the crew during Prepping is only the roster default and the dispatcher still changes it. A driver change on a scheduled trip appends another row.

**Warning rule:** more than **5** rows for one driver and outlet in the **last 21 days** shows a warning in the UI.

## Group 4: Waybills

### waybills

One row per **load**: the trips that share one number on one FO. The trips point at it through `trips.waybill_id`.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| waybill_number | TEXT (nocase, indexed) | e.g. `AY-10761`, `AY-10761-R`. **Not unique**: a hand-typed number can land on two loads, and each load bills on its own |
| prefix_id | INTEGER FK → waybill_prefixes | |
| sequence_number | INTEGER | The numeric part |
| waybill_type | TEXT | CHECK: `Regular`, `Redeliver`, `Foul Trip` |
| parent_waybill_id | INTEGER FK → waybills | A `-R`/`-FT` waybill points at the original |
| status | TEXT | CHECK: `Suggested`, `Confirmed`. `Confirmed` is locked: the server refuses to change it |
| confirmed_by, confirmed_at | TEXT | Email and timestamp of confirmation |

The FO number comes from the trips join. v1's `Locked` column is gone: locked means `status = 'Confirmed'`.

#### Number generation

1. A manual trip gets a waybill at creation. An imported trip gets one when the day leaves Prepping (`markDayScheduled`), or when the dispatcher schedules one trip from the board. Trips that share a trip date, FO number and truck share one waybill. A stop scheduled after its load joins the load's existing Suggested waybill.
2. **Suggestion reserves the number.** `_reserveWaybillSequence` runs one `UPDATE … RETURNING` that sets `last_sequence_number` to `max(counter, highest sequence_number in waybills) + n`. D1 runs writes one at a time, so two requests can never get the same number. The number is spent before the waybill row exists.
3. The dispatcher can type a different number.
4. A typed number that matches another Confirmed waybill is refused.
5. Confirmation sets `status = 'Confirmed'` and moves the counter forward only when the typed number is higher.

#### Redeliver and foul-trip numbering

A carry-over waybill does **not** take a new number. Rebisco wants the redelivered load to keep the original: AY-10761 becomes AY-10761-R, or AY-10761-FT for a foul trip. The new row copies the parent's prefix and sequence number, adds the suffix, and leaves the counter alone.

So two rows can hold sequence 10761 for one prefix. That is correct: the highest sequence is still 10761, and the next Regular waybill is 10762.

A carry-over of a carry-over keeps one suffix. The server strips a trailing `-R` or `-FT` before it adds the new one, so the number never grows to `AY-10761-R-R`.

## Group 5: Billing

### freight_rates

The DOE rate matrix in long format: **one row per band**. A rate revision inserts a new block with a later `effective_date`. The lookup takes the newest block on or before the trip's billing date, so a past billing never re-prices.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | The client sees the lowest ID of a block; any band row's ID resolves the block |
| origin | TEXT | Rebisco warehouse, e.g. `TANZA` |
| area | TEXT | Destination as the workbook spells it |
| area_key | TEXT (indexed) | `_normArea(area)`: case- and punctuation-free, for matching |
| truck_type | TEXT | `6W`, `4W`, `L300` |
| effective_date | TEXT date | First day the block applies |
| band | INTEGER 1–25 | Diesel price band |
| rate | REAL | Pesos. A band with no rate has no row |

`UNIQUE (origin, area, truck_type, effective_date, band)`. The key is the raw area, because the DOE workbook names different towns the same ("San Juan" and "SAN JUAN"). The lookup matches on `area_key`, so the first block wins, as in v1. `getFreightRates()` rebuilds the wide grid for the Billing Matrix panel.

#### Band indexing

Band = `clamp(ceil((price − 30) / 5), 1, 25)`. Band 1 is `30.01-35`, band 25 is `150.01-155`. A price at or below ₱30 uses band 1 and a price above ₱155 uses band 25, so a lookup never falls off the matrix. `_fuelBandLabel()` in `server/internals.js` and `FUEL_BANDS` in `web/billing-matrix.js` must name the bands the same way.

### fuel_prices

The Quezon City diesel "Common Price" the DOE posts weekly for NCR. The DOE posts a PDF only, so a person types the price.

A posting runs Tuesday to the next Monday, so an effective date is normally a Tuesday. A non-Tuesday date is accepted after a confirmation, for a mid-week adjustment. The Billing Matrix panel can correct or remove a row; the Audit Log keeps the trail.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| effective_date | TEXT date, unique | |
| diesel_price | REAL | Pesos per liter |
| added_by, added_at | TEXT | |

### billing_charge_types

The manual money columns on the billing. A new row adds a column to the Billing panel. Deactivating a row removes the column and keeps history.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| label | TEXT, unique (nocase) | Column heading as it prints |
| sort_order | INTEGER | Left-to-right order; null sorts last |
| active | INTEGER 0/1 | |

**Seed:** Parking Fee/Toll Fees, Packing Tape, Bad Orders @5.00 / Bx.

### billing_lines

One row per billable waybill. The server creates it the first time a billing range includes the waybill. It holds every value the printed billing shows, so the output stays the same after rates, fees or trips change.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| waybill_id | INTEGER FK → waybills, unique | The billable unit. The number comes from this join |
| trip_date | TEXT date | The day the load was delivered; the DATE the billing prints |
| billing_date | TEXT date | Selects the fuel price and the rate block |
| origin | TEXT | Snapshot of `trips.origin` |
| plate_number | TEXT | Snapshot of the truck plate |
| fo_number | TEXT | |
| truck_type | TEXT | Snapshot of `trips.truck_billing_category` |
| area | TEXT | The area that priced the load: the highest-rate drop, not the first |
| drops | INTEGER | Trips under the waybill |
| cartons | INTEGER | Sum of `quantity` |
| diesel_price | REAL | Snapshot of the price that selected the band |
| rate_band | INTEGER | Band index; the client gets the label |
| hauling_rate | REAL | Matrix rate for origin, area, truck type and band |
| mano | REAL | One `MANO_FEE` for each full 100 cartons at one store, summed over drops |
| drop_fee | REAL | `DROP_FEE` when the load has 3 or more drops, else 0 |
| total | REAL | Hauling rate + mano + drop fee + every manual charge. The server computes it; the client cannot write it |
| billing_number | TEXT | The Rebisco billing document; null until billed |
| status | TEXT | CHECK: `Not Billed`, `Billed`, `Deferred` |
| overrides | TEXT | JSON array of the computed fields a user typed over, e.g. `["haulingRate"]`. A recompute skips them |
| notes | TEXT | |
| added_by, added_at, updated_by, updated_at | TEXT | |

A unique `waybill_id` plus `ON CONFLICT` means two users opening the same range at once create one line, not two. A line save writes the line and its charges in one batch.

### billing_line_charges

The manual charges of a line. Readers rebuild the client's `manualCharges` object (`{"1":250,"3":75}`) from these rows.

| Column | Type | Notes |
| :-- | :-- | :-- |
| billing_line_id | INTEGER FK → billing_lines | Cascades on line delete |
| charge_type_id | INTEGER FK → billing_charge_types | |
| amount | REAL | PK is `(billing_line_id, charge_type_id)` |

#### Line eligibility

A waybill becomes a billing line when it is Confirmed and its trips are Delivered. A Deferred line leaves the current billing and stays eligible for a later one.

#### Split-load area rule

A load with drops in more than one area bills at the **highest** rate among those drops and prints that drop's area. Rebisco pays for the farthest point, not the first.

#### Billing totals

The footer comes from the sum of `total`, which includes VAT:

```
totalVatInc = sum of total
lessVat     = totalVatInc / 1.12 × 12%
netOfVat    = totalVatInc − lessVat
addVat      = netOfVat × 12%
withholding = netOfVat × 2%
amountDue   = totalVatInc − withholding
```

## Group 6: Audit

### audit_log

Append-only record of every change. `_auditLog` (one row) and `_auditLogBatch` (many rows, one round trip) run after the change, are best-effort, and never throw.

| Column | Type | Notes |
| :-- | :-- | :-- |
| id | INTEGER PK | |
| ts | TEXT timestamp (indexed) | |
| user_email | TEXT | The request's verified email |
| action | TEXT | A token from the vocabulary below |
| detail | TEXT | Readable description |
| table_name | TEXT | SQL table name (`trips`, `waybills`). v1 rows imported from Sheets keep the sheet name (`Trips`) |
| row_id | INTEGER | Row ID in that table |
| old_value, new_value | TEXT | Previous and new value; JSON for multi-column changes |

#### Action vocabulary

- `TRIP_CREATE` — a trip was created (manual, import or carry-over)
- `TRIP_STATUS_CHANGE` — a trip status changed
- `TRIP_REASSIGN` — a trip's driver or truck changed
- `TRIP_CONVOY_CHANGE` — trips were grouped or ungrouped as a convoy (values = the convoy token)
- `TRIP_DELETE` — an imported trip was deleted
- `WAYBILL_SUGGEST` — a waybill number was reserved as Suggested
- `WAYBILL_CONFIRM` — a waybill was confirmed and locked
- `WAYBILL_OVERRIDE` — a user changed a suggested number
- `OUTLET_CREATE` — an outlet was added (import or Admin)
- `OUTLET_EDIT` — an outlet was edited
- `DEFAULT_ASSIGN_CHANGE` — a truck's roster crew changed (table `trucks`)
- `TRUCK_CREATE`, `TRUCK_EDIT` — a truck was added or edited (including active and category)
- `EMPLOYEE_CREATE`, `EMPLOYEE_EDIT` — an employee was added or edited
- `BILLING_CATEGORY_CREATE`, `BILLING_CATEGORY_EDIT` — a billing category was added, renamed or toggled
- `ROUTE_TYPE_MAP_CREATE`, `ROUTE_TYPE_MAP_EDIT` — a route type mapping was added or edited
- `CG_COLOR_EDIT` — a customer group color was set or cleared (new value = `GROUP → #hex` or `GROUP → (cleared)`)
- `WAYBILL_PREFIX_CREATE`, `WAYBILL_PREFIX_EDIT` — a prefix was added or edited (code, company, re-base, active)
- `USER_CREATE`, `USER_EDIT` — a user was added or edited
- `LOGIN` — a verified Google sign-in opened a session (table `users`, new value = the email)
- `FREIGHT_RATE_IMPORT` — a rate block was loaded from a workbook (new value = `ORIGIN → n rows effective M/d/yyyy`)
- `FREIGHT_RATE_EDIT` — one rate cell changed in the Billing Matrix panel
- `FUEL_PRICE_ADD` — a weekly diesel price was entered (new value = `price effective M/d/yyyy`)
- `FUEL_PRICE_EDIT` — a diesel price or its date was corrected
- `FUEL_PRICE_DELETE` — a diesel price was removed (old value = `price effective M/d/yyyy`)
- `BILLING_CHARGE_TYPE_CREATE`, `BILLING_CHARGE_TYPE_EDIT` — a manual money column was added or edited
- `BILLING_LINE_CREATE` — a billable waybill entered the ledger
- `BILLING_LINE_EDIT` — manual charges, an override or notes changed on a line
- `BILLING_LINE_STATUS_CHANGE` — a line was deferred or brought back
- `BILLING_NUMBER_SET` — a Rebisco billing number was stamped on lines (new value = `BILLING# → n lines`)
- `DATA_CLEAR` — an Admin wiped every transactional table from the Settings panel (table blank, new value = the cleared tables). It is written *after* the wipe, so it is the first row of the new log

## Design rationale

### Billing date is separate from trip date

A carry-over gets the real calendar day as its trip date and keeps the original day as its billing date. Billing then uses the original day for the fuel price, the rate block and the billing period.

### Helpers and charges are rows

v1 stored helpers as a comma-separated ID string and manual charges as a JSON cell, because a sheet has no cheap sub-table. D1 has foreign keys, so helpers and charges are rows: an employee or charge type cannot be deleted while a row uses it, and a query can count them. The API contract did not change — readers rebuild `helperIds` and `manualCharges` in the v1 shape.

### Billing classes are snapshots

Dispatch stamps the truck's billing category onto the trip as text. A later category rename or truck edit then cannot change a past billing.

### One waybill row per load

v1 wrote one waybill row per trip and grouped rows by number. D1 keeps one row per load and points the trips at it. The load is then one thing that is confirmed, billed and carried over, and a stop added later joins it by reference.

### No global lock

v1 serialized every writer behind the Apps Script lock, because two executions could read the same last row ID. D1 removes the cause: `INTEGER PRIMARY KEY` assigns IDs, `UPDATE … RETURNING` reserves waybill numbers atomically, `UNIQUE` constraints refuse duplicates, `db.batch()` makes multi-row writes atomic, and D1 runs writes one at a time per database.

### Route-file FO grouping, waybills and truck allocation

A Rebisco route file has one drop per row. One Freight Order (FO) can span several rows (one truck, several stops) and can ask for several trucks (a split load, through counts in the type columns). The import groups rows by FO:

- **Truck type** comes from the type count columns (10W/6WF/6WC/4WC/L300), **not** the Restrictions column. A continuation row with no count rides the FO's truck and takes its type.
- **One waybill per truck.** The FO's first truck visits every outlet row of the FO, and those trips share one waybill. Each extra truck gets its own waybill.
- **No double-booking.** Trucks come from the pool of the resolved category, in ID order, skipping trucks already used on that date. When the pool runs out, the trip stays unassigned with its category recorded.
- **Convoys from fill colors.** Rebisco highlights the type count columns in alternating yellow and blue runs. Each run is one truck batch and can span several FOs. The importer reads only those columns' fills, starts a batch at each color change, folds uncolored rows into the batch of a colored row with the same FO, and stores batches that need 2 or more trucks in `trips.convoy_group`. Tokens are numbers, unique within a trip date (a re-import starts past the date's highest token). If the fills are missing, the import runs with no groups.

### Route frequency is its own table

The driver-frequency warning needs a count over 21 days. An append-only table with an index on `(driver_id, outlet_id)` answers that with one small query, and a later trip edit cannot rewrite the history of who drove where.
