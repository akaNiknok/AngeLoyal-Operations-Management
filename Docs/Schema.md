# **AngeLoyal OMS — Google Sheets Schema Specification**

## **Overview: Sheet Registry**

The AngeLoyal Order Management System (OMS) relies on a structured collection of Google Sheets, categorized into functional groups. All sheets listed below are active components of the current operational system.

| \# | Sheet Name | Group | Access / Type |
| :---- | :---- | :---- | :---- |
| 1 | Users | Config | Administrative Setup |
| 2 | Truck Type Map | Config | Administrative Setup |
| 3 | Waybill Prefixes | Config | Administrative Setup |
| 4 | Employees | People & Trucks | Master Records |
| 5 | Trucks | People & Trucks | Master Records |
| 6 | Default Assignments | People & Trucks | Operations Config |
| 7 | Employee-Truck Assignment | People & Trucks | Append-Only Log |
| 8 | Outlets | People & Trucks | Master Records (Auto-Populating) |
| 9 | Trips | Dispatch | Core Operational Ledger |
| 10 | Route Frequency Log | Dispatch | Append-Only Performance Log |
| 11 | Waybills | Waybills | Append-Only Transaction Ledger |
| 12 | Audit Log | Audit | System-Wide Activity Journal |

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
| Edit Outlets, Default Assignments | ✓ | — | — | — |
| Edit Truck Type Map, Waybill Prefixes | ✓ | — | — | — |
| Edit Users sheet | ✓ | — | — | — |
| View Audit Log | ✓ | — | — | — |

### **Sheet 2: Truck Type Map**

Maps verbose truck model designations to unified billing categories. This allows administrators to introduce new vehicle models without modifying system code.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Full Model Name | String | Exact string matching the Brand \+ Type from the Trucks sheet (e.g., NMR 85 H 6W CLOSED VAN) |
| Billing Category | String | Standardization values: 10W, 6W, 4W, L300 |

#### **Active Reference Data**

| Full Model Name | Billing Category |
| :---- | :---- |
| 12W WING VAN | 10W |
| NMR 85 H 6W CLOSED VAN | 6W |
| ELF 6W CLOSED VAN | 6W |
| ELF 6 HEELER CLOSED VAN | 6W |
| TRAVIZ CLOSED VAN | 6W |
| CANTER FE 73 CLOSE VAN | 6W |
| 6W | 6W |
| L300 FB BODY | L300 |

**System Behavior:** The application matches the Trucks sheet's vehicle properties against this table. If no matching model name is found, the associated trip is automatically flagged for manual review during billing cycles.

### **Sheet 3: Waybill Prefixes**

Tracks the alphanumeric code sequences allocated to each company or subcontractor generating waybills within the platform.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Prefix | String | Unique short code (e.g., AY) prepended to the numeric sequence |
| Company Name | String | Corporate identity associated with the prefix (e.g., AngeLoyal Logistics) |
| Last Sequence Number | Number | The most recent sequence number issued. **Updated by the backend on every waybill confirmation.** |

**Initial seed:**

| Prefix | Company Name | Last Sequence Number |
|---|---|---|
| AY | AngeLoyal Logistics | (set at deployment, e.g. 10760) |

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
| Billing Category | String | Computed by the backend via Truck Type Map lookup. Saved directly here for query performance. |

### **Sheet 6: Default Assignments**

Establishes the permanent, baseline crew configuration for each vehicle. These records are used to auto-populate the daily dispatch board.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Truck ID | Number | Foreign Key → Trucks.ID |
| Default Driver ID | Number | Foreign Key → Employees.ID (Nullable if unassigned) |
| Default Helper IDs | String | Comma-separated list of Employee IDs (e.g., 30,52, Nullable) |
| Notes | String | Special scheduling constraints (e.g., "Driver available Mon–Wed only") |

**System Behavior:** Updates made to default assignments apply strictly to newly generated trips. Historical trip logs remain unchanged.

### **Sheet 7: Employee-Truck Assignment**

An append-only transaction ledger utilized by the internal fleet management applications to track real-time personnel movements.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Employee ID | Number | Foreign Key → Employee.ID |
| Truck ID | Number | Foreign Key → Truck.ID |
| Type | String | Driver or Helper |

### **Sheet 8: Outlets**

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

### **Sheet 9: Trips**

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
| Trip Status | String | Current execution state: Scheduled, Delivered, Undelivered, Foul Trip \- No Redeliver, Foul Trip \- For Redeliver, Redeliver, Two-Day Trip |
| Parent Trip ID | Number | Foreign Key → Trips.ID. Points to the initiating record for all redeliveries or foul trip tracking |
| Source | String | Generation origin: Import, Manual, or Carry-over |
| Tier | Number | Client priority ranking (1, 2, 3); Nullable for manual entries |
| Remarks | String | Free-form operational commentary from dispatchers |
| Status Changed By | String | Email address of the user who performed the latest status update |
| Status Changed At | DateTime | Timestamp of the latest status modification |
| Added By | String | Email address of the user who generated the record |
| Added At | DateTime | Creation timestamp |

#### **Status & Carry-Over Workflow**

```
Scheduled
  → Delivered (normal completion)
  → Undelivered
      → Foul Trip - No Redeliver (billed as foul, no next-day attempt)
      → Foul Trip - For Redeliver (carries over to next day, generates -FT waybill)
      → Redeliver (carries over to next day, generates -R waybill)
      → Two-Day Trip (spans 2 days, single billing, covers both days)
```

When a trip status transitions to `Foul Trip - For Redeliver` or `Redeliver`, the system automatically inserts a new row into the Trips log for the following business day using these parameters:

* Trip Date \= Next business day
* Billing Date \= Preserves the original initiating trip's Billing Date
* Parent Trip ID \= Links back to the original trip's ID
* Source \= Carry-over

### **Sheet 10: Route Frequency Log**

An append-only table compiled automatically upon saving any trip. It acts as the data source for real-time compliance alerts regarding driver delivery frequencies.

| Column | Type | Notes |
| :---- | :---- | :---- |
| ID | Number | Auto-incrementing primary key |
| Trip ID | Number | Foreign Key → Trips.ID |
| Trip Date | Date | Denormalized date field to support high-speed query indexing |
| Driver ID | Number | Foreign Key → Employees.ID |
| Outlet ID | Number | Foreign Key → Outlets.ID |

**Validation Logic:** At the moment of assignment, the system counts entries within this ledger. If a specific Driver-Outlet combination occurs more than **5 times within a rolling 21-day window**, the user interface generates a compliance warning.

## **Group 4: Waybills**

### **Sheet 11: Waybills**

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

1. Upon trip registration, the application evaluates the Last Sequence Number for the active prefix within Waybill Prefixes.  
2. The index increments by 1, rendering a new entry in Waybills marked as Status \= Suggested and Locked \= FALSE.  
3. Dispatch staff review the layout inside the UI and retain the option to manually alter the number string.  
4. If changed, the application verifies the registry; if the manually entered string matches an existing record marked Confirmed, the system rejects the input with a validation error.  
5. Upon confirmation, the parameters shift to Status \= Confirmed and Locked \= TRUE, while updating the master index tracking entry inside Waybill Prefixes.

## **Group 5: Audit**

### **Sheet 12: Audit Log**

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

* ASSIGN / REMOVE — Personnel adjustments on the vehicle roster  
* TRIP\_CREATE — Registration of a new delivery record  
* TRIP\_STATUS\_CHANGE — Modifications to an active trip's state  
* TRIP\_REASSIGN — Changes made to a trip's driver or vehicle allocation  
* WAYBILL\_SUGGEST — Draft creation of a billing document sequence  
* WAYBILL\_CONFIRM — Locking and finalizing a waybill sequence  
* WAYBILL\_OVERRIDE — Manual adjustment of a system-suggested waybill number  
* OUTLET\_CREATE — Auto-populating a new destination via route file import  
* OUTLET\_EDIT — Administrative updates to existing outlet records  
* DEFAULT\_ASSIGN\_CHANGE — Adjustments to a vehicle's standard crew configuration

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

Vehicle billing classifications are stamped directly onto individual trip lines when they are dispatched. This historical snapshot protects past financial summaries from altering if an administrator subsequently changes entries within the master Truck Type Map.

### **Independent Route Frequency Tracking**

Relying on live spreadsheet formulas (FILTER or SORT) across large date boundaries degrades sheet responsiveness over time. Offloading these interactions to an append-only transaction sheet allows the system to evaluate driver assignment thresholds using simple count queries over a rolling 21-day timeline.
