# AngeLoyal OMS — Google Sheets Schema Specification
## Phase 1 (Pre-Phase + Dispatch)

---

## Overview: Sheet List

| # | Sheet Name | Group | Type | Status |
|---|---|---|---|---|
| 1 | Users | Config | Editable by Admin | New |
| 2 | Truck Type Map | Config | Editable by Admin | New |
| 3 | Waybill Prefixes | Config | Editable by Admin | New |
| 4 | Employees | People & Trucks | Master records | Existing (keep as-is) |
| 5 | Trucks | People & Trucks | Master records | Existing — add 2 columns |
| 6 | Default Assignments | People & Trucks | Editable by Admin/Dispatcher | New |
| 7 | Employee-Truck Assignment | People & Trucks | Append-only log | Existing (keep as-is) |
| 8 | Outlets | People & Trucks | Auto-seeded + editable | New |
| 9 | Trips | Dispatch | Core operational table | New |
| 10 | Route Frequency Log | Dispatch | Append-only, written by backend | New |
| 11 | Waybills | Waybills | Append-only once confirmed | New |
| 12 | Audit Log | Audit | Append-only | Existing — extended |

---

## Group 1: Config Sheets

### Sheet 1: `Users`
Maps Google account emails to system roles.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Email | String | Google account email — used by `Session.getActiveUser().getEmail()` |
| Display Name | String | Friendly name shown in UI |
| Role | String | One of: `Admin`, `Dispatcher`, `Payroll`, `Viewer` |
| Active | Boolean | `TRUE`/`FALSE` — inactive users are blocked |

**Role permissions matrix (Phase 1):**

| Feature | Admin | Dispatcher | Payroll | Viewer |
|---|---|---|---|---|
| View dispatch board | ✓ | ✓ | ✓ | ✓ |
| Assign drivers to trips | ✓ | ✓ | — | — |
| Add manual trips | ✓ | ✓ | — | — |
| Flag trip status | ✓ | ✓ | — | — |
| Confirm waybill numbers | ✓ | ✓ | — | — |
| Edit Outlets, Default Assignments | ✓ | — | — | — |
| Edit Truck Type Map, Waybill Prefixes | ✓ | — | — | — |
| Edit Users sheet | ✓ | — | — | — |
| View Audit Log | ✓ | — | — | — |

---

### Sheet 2: `Truck Type Map`
Maps the verbose truck model names to billing categories. Admin-editable so new models can be added without code changes.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Full Model Name | String | Exact string from the `Trucks` sheet Brand+Type, e.g. `NMR 85 H 6W CLOSED VAN` |
| Billing Category | String | One of: `10W`, `6W`, `4W`, `L300` |

**Initial seed data (based on current truck roster):**

| Full Model Name | Billing Category |
|---|---|
| 12W WING VAN | 10W |
| NMR 85 H 6W CLOSED VAN | 6W |
| ELF 6W CLOSED VAN | 6W |
| ELF 6 HEELER CLOSED VAN | 6W |
| TRAVIZ CLOSED VAN | 6W |
| CANTER FE 73 CLOSE VAN | 6W |
| 6W | 6W |
| L300 FB BODY | L300 |

> **Note on lookup:** The `Trucks` sheet's `Type` column is matched against this table. If no match is found, the trip is flagged for manual review during billing.

---

### Sheet 3: `Waybill Prefixes`
One row per company/subcontractor that issues waybills through this system.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Prefix | String | Short code, e.g. `AY`. Prepended to the sequence number. |
| Company Name | String | e.g. `AngeLoyal Logistics` |
| Last Sequence Number | Number | The last waybill number issued under this prefix. **Updated by backend on each confirmation.** At deployment, set this to the last manually issued waybill number so the system continues the sequence. |

**Initial seed:**

| Prefix | Company Name | Last Sequence Number |
|---|---|---|
| AY | AngeLoyal Logistics | (set at deployment, e.g. 10760) |

---

## Group 2: People & Trucks

### Sheet 4: `Employees` — **Existing, no changes**
Keep exactly as-is. Current columns: `ID`, `Nickname`, `First Name`, `Middle Name`, `Last Name`, `Role`.

One optional addition: `Status` column (`Active` / `Inactive`) — inactive employees are excluded from the dispatch dropdowns.

---

### Sheet 5: `Trucks` — **Existing, add 2 columns**
Keep all existing columns. Add:

| New Column | Type | Notes |
|---|---|---|
| Status | String | `Active` / `Inactive` — inactive trucks hidden from dispatch dropdowns |
| Billing Category | String | Computed by backend using `Truck Type Map` lookup. Stored here for speed. Updated whenever `Truck Type Map` changes. |

Existing columns: `ID`, `Plate Number`, `Brand`, `Type`

---

### Sheet 6: `Default Assignments` — **New**
One row per truck. Defines the "standing" crew for each truck. Used to pre-fill the daily dispatch board.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Truck ID | Number | FK → `Trucks.ID` |
| Default Driver ID | Number | FK → `Employees.ID`. Nullable if truck is currently uncrewed. |
| Default Helper IDs | String | Comma-separated Employee IDs. e.g. `30,52`. Nullable. |
| Notes | String | e.g. "Jaymart only available Mon–Wed" |

**Behaviour:** The UI shows this table in a simple editable grid. Changing a default here does NOT retroactively affect existing Trips. It only affects new trips created after the change.

---

### Sheet 7: `Employee-Truck Assignment` — **Existing, no changes**
Append-only log. Used by the existing Truck Roster web app. Keep intact.

---

### Sheet 8: `Outlets` — **New, auto-seeded**
Created empty. On first import of a Rebisco route file, the backend scans all outlet names in the file and inserts any that don't already exist as new rows. Admin can then enrich the records (add address, notes, etc.).

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Outlet Name | String | Exact name from Rebisco file, e.g. `PUREGOLD PRICE CLUB TANZA CAVI` |
| Area | String | e.g. `Tanza`, `Las Pinas`, `Paranaque` |
| Address | String | Full delivery address (from Rebisco file on seed, editable) |
| Customer Group | String | e.g. `PG` (Puregold), `SM`, manually editable |
| Notes | String | Any special delivery notes (restricted times, dock info, etc.) |
| Created At | DateTime | Timestamp of first import |

---

## Group 3: Dispatch

### Sheet 9: `Trips` — **New, core operational table**
One row per delivery trip. Multiple trips can share an FO Number (combined drops on one truck), and one FO can have suffix A/B/C for split trucks.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Trip Date | Date | The date the trip is scheduled / was dispatched |
| Billing Date | Date | The original trip date — preserved when a trip is carried over. Equals `Trip Date` on first creation. |
| FO Number | String | Rebisco Freight Order number, e.g. `6100044620`. Required; can be filled in later for manual trips. |
| FO Split Suffix | String | `A`, `B`, `C`, etc. Null for single-truck FOs. |
| Outlet ID | Number | FK → `Outlets.ID` |
| Area | String | Copied from Outlet, for display convenience |
| Quantity | Number | Cartons/packs |
| CBM | Number | Cubic meters |
| Restrictions | String | Truck type hint from Rebisco, e.g. `6W` |
| Truck ID | Number | FK → `Trucks.ID`. The actual assigned truck for this trip. |
| Driver ID | Number | FK → `Employees.ID`. The actual assigned driver. |
| Helper IDs | String | Comma-separated Employee IDs. Nullable. |
| Truck Billing Category | String | Snapshot of billing category at time of dispatch. Stored so it can't change retroactively. |
| Trip Status | String | One of: `Scheduled`, `Delivered`, `Undelivered`, `Foul Trip - No Redeliver`, `Foul Trip - For Redeliver`, `Redeliver`, `Two-Day Trip` |
| Parent Trip ID | Number | FK → `Trips.ID`. For redeliver/foul trip rows, points to the original trip. Null for originals. |
| Source | String | `Import` or `Manual` |
| Tier | Number | From Rebisco file (1, 2, 3). Nullable for manual trips. |
| Remarks | String | Free text notes by dispatcher |
| Status Changed By | String | Email of user who last changed Trip Status |
| Status Changed At | DateTime | Timestamp of last status change |
| Added By | String | Email of user who created this row |
| Added At | DateTime | Timestamp of creation |

**Trip Status flow:**
```
Scheduled
  → Delivered (normal completion)
  → Undelivered
      → Foul Trip - No Redeliver (billed as foul, no next-day attempt)
      → Foul Trip - For Redeliver (carries over to next day, generates -FT waybill)
      → Redeliver (carries over to next day, generates -R waybill)
      → Two-Day Trip (spans 2 days, single billing, marks both days)
```

**Carry-over logic:** When a trip is flagged as `Foul Trip - For Redeliver` or `Redeliver`, the backend creates a NEW row in `Trips` for the next day with:
- `Trip Date` = next business day
- `Billing Date` = original trip's `Billing Date` (preserved)
- `Parent Trip ID` = original trip's `ID`
- `Source` = `Carry-over`

---

### Sheet 10: `Route Frequency Log` — **New, append-only**
Written by the backend every time a trip is saved. Used to surface the "driver assigned to same outlet too often" warning.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Trip ID | Number | FK → `Trips.ID` |
| Trip Date | Date | Denormalized for fast querying |
| Driver ID | Number | FK → `Employees.ID` |
| Outlet ID | Number | FK → `Outlets.ID` |

**Warning threshold:** Configurable in the `Users` sheet as a global config row, or as a dedicated single-cell named range. Default: if a driver-outlet pair appears more than **5 times in the last 21 days**, surface a warning. This threshold is checked at assignment time, not after.

---

## Group 4: Waybills

### Sheet 11: `Waybills` — **New, append-only once locked**
Waybill numbers are suggested by the system and confirmed by the dispatcher. Once confirmed (`Locked = TRUE`), the row cannot be changed via the UI — only the Audit Log can record any discrepancy.

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment |
| Waybill Number | String | Full waybill string, e.g. `AY-10761` or `AY-10761-R` or `AY-10761-FT` |
| Prefix ID | Number | FK → `Waybill Prefixes.ID` |
| Sequence Number | Number | Numeric part only, e.g. `10761`. For sorting and duplicate detection. |
| Trip ID | Number | FK → `Trips.ID` |
| FO Number | String | Denormalized from Trip for quick billing reference |
| Waybill Type | String | `Regular`, `Redeliver` (-R), `Foul Trip` (-FT) |
| Parent Waybill ID | Number | FK → `Waybills.ID`. For -R and -FT types, points to the original waybill. Null for Regular. |
| Status | String | `Suggested` or `Confirmed` |
| Locked | Boolean | `FALSE` when suggested. Set to `TRUE` on confirmation. Once `TRUE`, backend rejects any write attempts to this row and logs to Audit Log instead. |
| Confirmed By | String | Email of user who confirmed |
| Confirmed At | DateTime | Timestamp of confirmation |

**Auto-generation logic:**
1. When a trip is created, backend reads `Last Sequence Number` from `Waybill Prefixes` for the selected prefix.
2. Increments by 1, writes a new `Waybills` row with `Status = Suggested`, `Locked = FALSE`.
3. Dispatcher sees the suggested number in the UI, can change it to any number.
4. If changed, backend checks `Waybills` sheet — if the entered number already exists with `Status = Confirmed`, it rejects with a "Duplicate waybill" error.
5. On dispatcher confirmation, sets `Status = Confirmed`, `Locked = TRUE`, updates `Last Sequence Number` in `Waybill Prefixes`.

---

## Group 5: Audit

### Sheet 12: `Audit Log` — **Existing, extended**
Keep existing columns. Add two new columns to support Phase 1's richer logging:

| Column | Type | Notes |
|---|---|---|
| ID | Number | Auto-increment (new — add to existing sheet) |
| Timestamp | DateTime | Existing |
| User | String | Email — Existing |
| Action | String | Existing — extend vocabulary (see below) |
| Detail | String | Existing — free text summary |
| Table | String | **New** — which sheet was affected, e.g. `Trips`, `Waybills` |
| Row ID | Number | **New** — the ID of the affected row |
| Old Value | String | **New** — previous value (JSON string for multi-field changes) |
| New Value | String | **New** — new value |

**Action vocabulary for Phase 1:**
- `ASSIGN` (existing — Truck Roster)
- `REMOVE` (existing — Truck Roster)
- `TRIP_CREATE`
- `TRIP_STATUS_CHANGE`
- `TRIP_REASSIGN` (driver or truck changed)
- `WAYBILL_SUGGEST`
- `WAYBILL_CONFIRM`
- `WAYBILL_OVERRIDE` (dispatcher changed the suggested number)
- `OUTLET_CREATE` (auto-seed from import)
- `OUTLET_EDIT`
- `DEFAULT_ASSIGN_CHANGE`

---

## Sheet Setup Instructions (Manual steps in Google Sheets before code runs)

These sheets must be created manually in the Google Spreadsheet before deploying the Apps Script:

1. **`Users`** — create with exact headers; add at least one Admin row (your email).
2. **`Truck Type Map`** — create with exact headers; seed with the initial data above.
3. **`Waybill Prefixes`** — create with exact headers; add the `AY` row with the correct last sequence number.
4. **`Default Assignments`** — create with exact headers; fill in the standing crew for each truck.
5. **`Outlets`** — create with exact headers; leave empty (seeded by first import).
6. **`Trips`** — create with exact headers; leave empty.
7. **`Route Frequency Log`** — create with exact headers; leave empty.
8. **`Waybills`** — create with exact headers; leave empty.
9. **`Trucks`** — add `Status` and `Billing Category` columns to the existing sheet.
10. **`Audit Log`** — add `ID`, `Table`, `Row ID`, `Old Value`, `New Value` columns to the existing sheet.

**Existing sheets to leave untouched:** `Employees`, `Employee-Truck Assignment`.

---

## Naming Conventions

- All sheet names: **Title Case with spaces** (as listed above).
- All header row values: **Title Case with spaces**, exactly as listed in the column tables.
- Boolean columns: stored as `TRUE`/`FALSE` strings (Google Sheets native boolean format).
- DateTime columns: stored as formatted strings `"M/d/yyyy HH:mm:ss"` (consistent with existing Code.gs pattern).
- Date columns (no time): stored as `"M/d/yyyy"`.
- ID columns: always row 1 = 1, auto-increment (last row ID + 1).
- FK columns: store the numeric ID only (not the name). The backend does lookups; the sheet stores IDs.

---

## Key Design Decisions

**Why `Billing Date` is separate from `Trip Date`:**
When a trip carries over to the next day (redeliver/foul trip), the new row gets tomorrow's date as `Trip Date`. But `Billing Date` stays as the original day. This means billing always uses `Billing Date` — so a trip dispatched May 15 that needed a redeliver on May 16 still bills at May 15's DOE rate (Phase 2) and counts toward May 15's waybill sequence.

**Why Helper IDs are comma-separated in one column:**
Variable helper counts (0–3 per truck) make a relational sub-table overcomplicated for a Sheets-based system. Comma-separated IDs in one column, parsed by the backend, is the practical tradeoff. If helper counts grow beyond 3 consistently, this can be refactored in Phase 2.

**Why `Truck Billing Category` is snapshotted in `Trips`:**
The DOE rate in Phase 2 depends on both area and truck type at trip time. If the `Truck Type Map` is ever updated, past trips must not be re-priced. Snapshotting at dispatch time prevents this entirely.

**Why `Route Frequency Log` is a separate sheet and not a formula:**
FILTER+SORT patterns on large date ranges get slow in Sheets. The backend writes one row per trip and the warning check is a simple count query over a rolling 21-day window — fast and reliable.
