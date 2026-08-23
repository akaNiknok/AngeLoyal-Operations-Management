# **AngeLoyal OMS — Google Sheets Schema Specification**

## **Overview: Sheet Registry**

The AngeLoyal Order Management System (OMS) relies on a structured collection of Google Sheets, categorized into functional groups. All sheets listed below are active components of the current operational system.

| \# | Sheet Name | Group | Access / Type |
| :---- | :---- | :---- | :---- |
| 1 | Users | Config | Administrative Setup |
| 2 | Billing Categories | Config | Administrative Setup |
| 3 | Waybill Prefixes | Config | Administrative Setup |
| 4 | Employees | People & Trucks | Master Records |
| 5 | Trucks | People & Trucks | Master Records |
| 6 | Default Assignments | People & Trucks | Operations Config (the truck roster) |
| 7 | Outlets | People & Trucks | Master Records (Auto-Populating) |
| 8 | Trips | Dispatch | Core Operational Ledger |
| 9 | Route Frequency Log | Dispatch | Append-Only Performance Log |
| 10 | Waybills | Waybills | Append-Only Transaction Ledger |
| 11 | Audit Log | Audit | System-Wide Activity Journal |
| 12 | Route Type Map | Config | Administrative Setup (Self-Seeding) |

## **Group 1: Config Sheets**

### **Sheet 1: Users**

Maps Google account emails to specific system roles to manage access control.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Email | String | Google account email—validated via Session.getActiveUser().getEmail() |
| Display Name | String | User's name displayed within the user interface |
| Role | String | Authorized roles: Admin, Dispatcher, Payroll, Viewer |
| Active | Boolean | TRUE/FALSE—inactive users are blocked from system access |

#### **Role Permissions Matrix**

| Feature | Admin | Dispatcher | Payroll | Viewer |
| :---- | :---- | :---- | :---- | :---- |
| View dispatch board | ✓ | ✓ | ✓ | ✓ |
| Assign drivers to trips | ✓ | ✓ | — | — |
| Add manual trips | ✓ | ✓ | — | — |
| Flag trip status | ✓ | ✓ | — | — |
| Confirm waybill numbers | ✓ | ✓ | — | — |
| Edit the truck roster (Default Assignments) | ✓ | ✓ | — | — |
| Edit Outlets | ✓ | — | — | — |
| Edit Billing Categories | ✓ | — | — | — |
| Edit Waybill Prefixes | ✓ | ✓ | — | — |
| Edit Users sheet | ✓ | — | — | — |
| View Audit Log | ✓ | — | — | — |
| Clear all transactional data (Admin panel) | ✓ | — | — | — |

### **Sheet 2: Billing Categories**

Maintains the list of valid billing classifications that Admins can assign to trucks (e.g., 10W, 6W, 4W, L300). Admins can add new categories or rename/deactivate existing ones as the fleet's billing structure evolves.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Name | String | Billing category code, e.g. 10W, 6W, 4W, L300 |
| Active | Boolean | Inactive categories are hidden from the "Add/Edit Truck" dropdown but remain valid for trucks still using them |

#### **Initial seed:**

| Name | Active |
| :---- | :---- |
| 10W | TRUE |
| 6W | TRUE |
| 4W | TRUE |
| L300 | TRUE |

**System Behavior:** Admins select a truck's Billing Category directly when creating or editing a truck record (Sheet 5). Renaming a category here cascades to every Trucks row currently set to the old name, so existing trucks stay matched to the renamed category.

### **Sheet 12: Route Type Map**

Maps the truck-type column codes that appear in a Rebisco route file (e.g. 6WF, 6WC, 4WC) to a truck **Billing Category** (Sheet 2). A route file lists how many trucks of each type an FO needs in dedicated per-type columns (10W, 6WF, 6WC, 4WC, L300…), separate from the client's "Restrictions" constraint. During import the system reads which type column carries the count, looks up its billing category here, and assigns a truck of that category. This sheet **self-seeds** with sensible defaults the first time it is read, so no manual setup is required; Admins can add/edit mappings via the Route Type Map admin panel as the route-file format evolves.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| File Type Code | String | Truck-type column header from the route file, e.g. 6WF, 6WC, 4WC |
| Billing Category | String | Target billing category (Sheet 2) the code resolves to during import |
| Active | Boolean | Inactive mappings are ignored during import and hidden from the admin list |

#### **Initial seed:**

| File Type Code | Billing Category | Active |
| :---- | :---- | :---- |
| 10W | 10W | TRUE |
| 6WF | 6W | TRUE |
| 6WC | 6W | TRUE |
| 4WC | 6W | TRUE |
| L300 | L300 | TRUE |

**System Behavior:** Codes not found in the map fall back to using the code itself as the category name (so an unmapped code still attempts a match). A code that resolves to a category with no free truck leaves the trip's truck blank for the dispatcher, but the required category is still stamped onto the trip so the needed type stays visible.

### **Sheet 3: Waybill Prefixes**

Tracks the alphanumeric code sequences allocated to each company or subcontractor generating waybills within the platform.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Prefix | String | Unique short code (e.g., AY) prepended to the numeric sequence. May be left blank for "no prefix" — the waybill number is then just the bare sequence (e.g., `10761` instead of `AY-10761`). |
| Company Name | String | Corporate identity associated with the prefix (e.g., AngeLoyal Logistics) |
| Last Sequence Number | Number | The most recent sequence number issued, stored as a **plain number** (e.g. `357`, `10760`) — never zero-padded text. **Suggestion reserves the number** (advances this counter) and confirmation advances it further only if a higher custom number is entered. The counter is only a cache: the backend also reads the highest Sequence Number already in the Waybills ledger for the prefix and issues past whichever is higher, so a counter that fails to write can never re-issue a live number. |
| Sequence Width | Number | The booklet's fixed digit width — how many digits the generated waybill number is zero-padded to (`4` prints `0358`). Padding never truncates: a sequence longer than the width prints in full. Set from the length of the value typed into the admin panel, so entering `0000` records width 4. **A row with no width falls back to the length of the Last Sequence Number**, which keeps pre-migration sheets printing correctly until their next issue rewrites both fields; the column is appended automatically when a sheet lacks it. |
| Active | Boolean | Inactive prefixes are hidden from the waybill-prefix pickers but stay valid for waybills already issued under them. A blank cell reads as active, and the column is appended automatically on the first edit if a pre-existing sheet lacks it. |

> **Why the width is its own column.** It used to be inferred from the *formatting* of Last Sequence Number — the counter was stored as text (`0358`) and its length was the width. Persisting that took a `setNumberFormat('@').setValue(…)` write which silently did nothing, so **every zero-padded booklet froze**: `AY` stayed at `0358` and re-issued `AY-0359` across four different FOs, `GL` stayed at `039` and re-issued `GL-040` across two, while every prefix stored without a leading zero advanced normally. Re-basing this counter to a number the booklet has already issued is now refused.

**Initial seed:**

| Prefix | Company Name | Last Sequence Number | Active | Sequence Width |
|---|---|---|---|---|
| AY | AngeLoyal Logistics | (set at deployment, e.g. 10760) | TRUE | (booklet digits, e.g. 5) |

## **Group 2: People & Trucks**

### **Sheet 4: Employees**

Maintains the authoritative roster of personnel.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Nickname | String | Preferred name used throughout operational dropdowns |
| First Name | String | Legal first name |
| Middle Name | String | Legal middle name |
| Last Name | String | Legal last name |
| Role | String | Employee job function (e.g., Driver, Helper) |
| Status | String | Active / Inactive—inactive employees are excluded from dispatch options |

### **Sheet 5: Trucks**

Maintains the authoritative fleet registry, combining physical specifications with system billing metrics.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Plate Number | String | Unique vehicle license plate |
| Brand | String | Vehicle manufacturer (e.g., Isuzu, Mitsubishi) |
| Type | String | Detailed model/body designation |
| Status | String | Active / Inactive—inactive trucks are hidden from dispatch options |
| Billing Category | String | Selected manually by Admins from the Billing Categories list (Sheet 2) at truck creation; editable afterward via the Trucks admin panel |

### **Sheet 6: Default Assignments**

The **truck roster**: the permanent, baseline crew configuration for each vehicle. It is the single source of crew truth — the dispatch board's Crew Rail stamps a truck's default crew onto trips (`assignCrew`), and the Truck Roster panel edits it directly. One row per truck (seeded blank at truck creation).

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Truck ID | Number | Foreign Key → Trucks.ID |
| Default Driver ID | Number | Foreign Key → Employees.ID (Nullable if unassigned) |
| Default Helper IDs | String | Comma-separated list of Employee IDs (0–3, e.g., 30,52, Nullable) |
| Notes | String | Special scheduling constraints (e.g., "Driver available Mon–Wed only") |

**System Behavior:** Edited via `updateDefaultAssignment` (gated by `ASSIGN_CREW` — Admin + Dispatcher). Updates apply strictly to newly generated trips; historical trip logs remain unchanged. One-off per-day crew substitutions are made directly on the trip's Crew column, not here.

### **Sheet 7: Outlets**

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

## **Group 3: Dispatch**

### **Sheet 8: Trips**

The core transactional table of the system. Each row tracks an individual delivery assignment. Multiple rows may share an FO Number for multi-drop routes, or contain distinct alphabetical suffixes for split-load allocations.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Trip Date | Date | Calendar date the delivery is scheduled for dispatch |
| Billing Date | Date | The original operational date. This date remains constant even if a trip carries over to subsequent days |
| FO Number | String | Client Freight Order identifier (e.g., 6100044620\) |
| FO Split Suffix | String | Suffix identifier (A, B, C) for split shipments; Null for single-truck loads |
| Outlet ID | Number | Foreign Key → Outlets.ID |
| Area | String | Denormalized location name copied from the Outlet profile for UI sorting |
| Quantity | Number | Total volume in cartons or packages |
| CBM | Number | Volume measurement in cubic meters |
| Restrictions | String | Vehicle configuration constraints requested by the client (e.g., 6W) |
| Truck ID | Number | Foreign Key → Trucks.ID pointing to the physical vehicle dispatched |
| Driver ID | Number | Foreign Key → Employees.ID pointing to the operating driver |
| Helper IDs | String | Comma-separated Employee IDs for assigned crew; Nullable |
| Truck Billing Category | String | Historical snapshot of the vehicle's billing class at the exact moment of dispatch |
| Trip Status | String | Current execution state: Prepping, Backlog, Scheduled, Preload, Delivered, Undelivered, Foul Trip \- No Redeliver, Foul Trip \- For Redeliver, Redeliver, Two-Day Trip |
| Parent Trip ID | Number | Foreign Key → Trips.ID. Points to the initiating record for all redeliveries or foul trip tracking |
| Source | String | Generation origin: Import, Manual, or Carry-over |
| Tier | Number | Client priority ranking (1, 2, 3); Nullable for manual entries |
| Remarks | String | Free-form operational commentary from dispatchers |
| Status Changed By | String | Email address of the user who performed the latest status update |
| Status Changed At | DateTime | Timestamp of the latest status modification |
| Added By | String | Email address of the user who generated the record |
| Added At | DateTime | Creation timestamp |
| Convoy Group | String | Token grouping trips whose trucks must travel together (convoys / split loads); unique within a Trip Date; Nullable (blank = not in a convoy) |
| Sort Order | Number | Manual display/route order within a Trip Date, set by dragging rows on the dispatch board; Nullable (blank sorts last) |

#### **Status & Carry-Over Workflow**

```
Prepping (imported, pre-waybill — dispatcher merges/splits/reassigns freely)
  → Scheduled (day promoted via markDayScheduled; waybills suggested)
  → Backlog (day promoted but still no crew — no waybill; carries over to the
             next business day as a fresh Prepping trip)
Scheduled
  → Preload (goods loaded onto the truck, not yet delivered)
      → Delivered
  → Delivered (normal completion)
  → Undelivered
      → Foul Trip - No Redeliver (billed as foul, no next-day attempt)
      → Foul Trip - For Redeliver (carries over to next day, generates -FT waybill)
      → Redeliver (carries over to next day, generates -R waybill)
      → Two-Day Trip (spans 2 days, single billing, covers both days)
```

When a trip status transitions to `Foul Trip - For Redeliver`, `Redeliver`, or `Backlog`, the system automatically inserts a new row into the Trips log for the following business day using these parameters:

* Trip Date \= Next business day
* Billing Date \= Preserves the original initiating trip's Billing Date
* Parent Trip ID \= Links back to the original trip's ID
* Source \= Carry-over
* Trip Status \= Scheduled, or Prepping for a `Backlog` carry-over (it still needs a crew, and gets no suggested waybill)

### **Sheet 9: Route Frequency Log**

An append-only table recording the driver-outlet assignments that were actually scheduled. It acts as the data source for real-time compliance alerts regarding driver delivery frequencies.

A trip is logged when it **leaves Prepping** — via `markDayScheduled`, a manual status change, or creation at a status other than Prepping (manual trips and carry-overs, which are born Scheduled). Imported trips log nothing at import: their crew comes from the truck's default assignment and the dispatcher reshuffles it freely during Prepping, so logging then would credit drivers for trips they never took. Reassigning the driver of an already-scheduled trip appends another row.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Trip ID | Number | Foreign Key → Trips.ID |
| Trip Date | Date | Denormalized date field to support high-speed query indexing |
| Driver ID | Number | Foreign Key → Employees.ID |
| Outlet ID | Number | Foreign Key → Outlets.ID |

**Validation Logic:** At the moment of assignment, the system counts entries within this ledger. If a specific Driver-Outlet combination occurs more than **5 times within a rolling 21-day window**, the user interface generates a compliance warning.

## **Group 4: Waybills**

### **Sheet 10: Waybills**

Tracks system-generated billing numbers. Once a record is finalized by operational staff (Locked \= TRUE), it becomes immutable within the workspace UI; any subsequent amendments can only be executed via structural audit overrides.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Waybill Number | String | Formatted serial number string (e.g., AY-10761, AY-10761-R, AY-10761-FT) |
| Prefix ID | Number | Foreign Key → Waybill Prefixes.ID |
| Sequence Number | Number | Raw numeric element used for sorting and ensuring uniqueness |
| Trip ID | Number | Foreign Key → Trips.ID |
| FO Number | String | Denormalized freight number for accelerated lookups |
| Waybill Type | String | Categories: Regular, Redeliver (-R), Foul Trip (-FT) |
| Parent Waybill ID | Number | Foreign Key → Waybills.ID. Links alternative types back to the initial regular waybill |
| Status | String | Lifecycle stage: Suggested or Confirmed |
| Locked | Boolean | TRUE blocks standard interface modifications. The backend rejects direct writes to locked rows |
| Confirmed By | String | Email address of the user finalizing the transaction |
| Confirmed At | DateTime | Finalization timestamp |

#### **Document Generation Logic**

1. Upon trip registration, the application evaluates the Last Sequence Number for the active prefix within Waybill Prefixes. For manual trips this happens at creation; for imported trips it happens when the dispatcher promotes the day out of Prepping (markDayScheduled) or promotes an individual trip to Scheduled from the dispatch board (which prompts for the prefix) — one waybill per truck load, so trips sharing a Trip Date, FO Number and Truck ID share a number, and a stop promoted after its load joins the load's existing Suggested number.  
2. The index increments by 1, rendering a new entry in Waybills marked as Status \= Suggested and Locked \= FALSE, and the prefix's Last Sequence Number advances — **the suggestion reserves the number**, so the next suggestion cannot collide with it.  
3. Dispatch staff review the layout inside the UI and retain the option to manually alter the number string.  
4. If changed, the application verifies the registry; if the manually entered string matches an existing record marked Confirmed, the system rejects the input with a validation error.  
5. Upon confirmation, the parameters shift to Status \= Confirmed and Locked \= TRUE, while updating the master index tracking entry inside Waybill Prefixes.

## **Group 5: Audit**

### **Sheet 11: Audit Log**

The global ledger recording all administrative, operational, and data state modifications across the entire environment.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Timestamp | DateTime | Precise moment the change occurred |
| User | String | Email address of the account executing the change |
| Action | String | Standardized action vocabulary token |
| Detail | String | Human-readable explanation of the operational event |
| Table | String | Target worksheet affected by the transaction (e.g., Trips, Waybills) |
| Row ID | Number | Unique row identifier inside the target sheet |
| Old Value | String | Previous data state, stored as a JSON string for multi-column changes |
| New Value | String | Revised data state, stored as a JSON string for multi-column changes |

#### **System Action Vocabulary**

* TRIP\_CREATE — Registration of a new delivery record  
* TRIP\_STATUS\_CHANGE — Modifications to an active trip's state  
* TRIP\_REASSIGN — Changes made to a trip's driver or vehicle allocation  
* TRIP\_CONVOY\_CHANGE — Grouping or ungrouping trips as a convoy (Old\New Value = the Convoy Group token)  
* WAYBILL\_SUGGEST — Draft creation of a billing document sequence  
* WAYBILL\_CONFIRM — Locking and finalizing a waybill sequence  
* WAYBILL\_OVERRIDE — Manual adjustment of a system-suggested waybill number  
* OUTLET\_CREATE — Auto-populating a new destination via route file import  
* OUTLET\_EDIT — Administrative updates to existing outlet records  
* DEFAULT\_ASSIGN\_CHANGE — Adjustments to a vehicle's standard crew configuration  
* TRUCK\_CREATE — New vehicle added to the Trucks master record  
* TRUCK\_EDIT — Administrative updates to an existing truck record (including Active/Inactive toggling and Billing Category changes)  
* EMPLOYEE\_CREATE — New personnel added to the Employees master record  
* EMPLOYEE\_EDIT — Administrative updates to an existing employee record (including Active/Inactive toggling)  
* BILLING\_CATEGORY\_CREATE — New entry added to the Billing Categories list  
* BILLING\_CATEGORY\_EDIT — Administrative updates to a billing category (rename, Active/Inactive toggling)  
* ROUTE\_TYPE\_MAP\_CREATE — New route-file truck-type → billing-category mapping added  
* ROUTE\_TYPE\_MAP\_EDIT — Administrative updates to a route type mapping (code, category, Active/Inactive toggling)  
* WAYBILL\_PREFIX\_CREATE — New prefix added to the Waybill Prefixes list  
* WAYBILL\_PREFIX\_EDIT — Updates to a waybill prefix (prefix code, company name, re-basing the Last Sequence Number, Active/Inactive toggling)
* LOGIN — A verified Google sign-in opened a session (Table = Users, New Value = the account's email)
* DATA\_CLEAR — An Admin wiped every transactional row of this environment from the Admin panel (Table blank, New Value = the list of cleared sheets). Written *after* the wipe, so it is the first row of the fresh Audit Log.

## **Structural Implementation Conventions**

* **Sheet Names:** Title Case formatting incorporating spaces exactly as designated in the registry.  
* **Header Configurations:** Row 1 contains headers using Title Case formatting with spaces, matching this document explicitly.  
* **Boolean Formatting:** Evaluated natively inside cells as standard TRUE/FALSE parameters.  
* **Temporal Records:** Complete date/time strings utilize "M/d/yyyy HH:mm:ss" formatting. Pure date records omit timestamps, using "M/d/yyyy".  
* **Primary Identifiers (IDs):** Calculated dynamically using an auto-incrementing method ($Last\\ Row\\ ID \+ 1$), starting at row value 1\.  
* **Relational Mappings (FKs):** Relational keys map strictly via numeric database ID values, rather than text string names.

## **Technical Design Rationale**

### **Separation of Billing Date and Trip Date**

When delayed delivery statuses necessitate next-day carry-overs, the newly generated record uses the actual calendar date for its Trip Date. However, it preserves the original day's value as its Billing Date. This ensures that billing calculations consistently reference the original transaction date—maintaining correct fuel price indexing, operational periods, and sequential tracking.

### **Delimited Helper Records**

To handle fluid crew sizes (ranging from 0 to 3 helpers per vehicle) without adding the structural weight of relational sub-tables, helper identities are maintained as a comma-separated string of IDs. The application code handles parsing this string during operations.

### **Snapshotting Vehicle Billing Classes**

Vehicle billing classifications are stamped directly onto individual trip lines when they are dispatched. This historical snapshot protects past financial summaries from altering if an administrator subsequently changes a truck's Billing Category or renames an entry in the Billing Categories list.

### **Route-File FO Grouping, Waybills & Truck Allocation**

A Rebisco route file lists one delivery drop per row, but a single Freight Order (FO) can span several rows (one truck, multiple stops) and/or request several trucks (split load, via counts in the per-type columns). On import the rows are grouped by FO:

* **Truck type** comes from the per-type count column (10W/6WF/6WC/4WC/L300), **not** the Restrictions column — those are distinct fields. A continuation row with no type count rides the FO's truck and inherits its type.
* **One waybill per truck.** The FO's primary truck visits every outlet row of the FO, and those trips share one waybill number ("same FO = same waybill", surfaced on the dispatch board as an alternating row shade). Each additional truck on the FO gets its own waybill number. Shared waybill rows carry the same Sequence Number, reserved once for the whole load: suggestion advances the prefix's Last Sequence Number, and a stop of the load suggested later (e.g. manually scheduled after the rest) joins the load's existing Suggested number instead of reserving a new one.
* **Distribution without double-booking.** Trucks are drawn from the pool matching the resolved billing category, ordered by ID, skipping any already committed on that date. When the pool is exhausted the trip is left unassigned (with the required category recorded) rather than overloading one truck.
* **Convoy detection from fill colors.** Rebisco highlights the truck-type count columns in alternating yellow/blue runs; each contiguous same-color run is one truck batch, and a run can span multiple FOs (trucks that must travel together because quantities are summed onto one FO's row). The importer reads only those columns' fills (the Customer column reuses the same palette for chain codes), treats a color change as a batch boundary, folds uncolored rows into the batch of a colored row sharing their FO, and persists batches needing ≥ 2 truck slots into `Trips.Convoy Group`. Tokens are numeric, unique within a Trip Date (re-imports offset by the date's existing maximum). Fill parsing is best-effort: if the library or colors are absent, the import proceeds with no groups.

### **Independent Route Frequency Tracking**

Relying on live spreadsheet formulas (FILTER or SORT) across large date boundaries degrades sheet responsiveness over time. Offloading these interactions to an append-only transaction sheet allows the system to evaluate driver assignment thresholds using simple count queries over a rolling 21-day timeline.
