-- AngeLoyal OMS — schema v2 (Docs/D1 Migration.md §3).
-- Booleans are INTEGER 0/1. Pure dates 'YYYY-MM-DD'; timestamps
-- 'YYYY-MM-DD HH:MM:SS' in Asia/Manila. IDs keep their Sheets values on
-- import so audit_log.row_id still points at the right row.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Admin','Dispatcher','Payroll','Viewer')),
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  expires_at TEXT NOT NULL);

CREATE TABLE billing_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1);

-- Route Type Map: FK instead of a category name, so the rename cascade disappears.
CREATE TABLE route_type_map (
  id INTEGER PRIMARY KEY,
  file_type_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  billing_category_id INTEGER NOT NULL REFERENCES billing_categories(id),
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE customer_group_colors (
  id INTEGER PRIMARY KEY,
  customer_group TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE waybill_prefixes (
  id INTEGER PRIMARY KEY,
  prefix TEXT NOT NULL DEFAULT '' UNIQUE COLLATE NOCASE,
  company_name TEXT NOT NULL,
  last_sequence_number INTEGER NOT NULL DEFAULT 0,
  sequence_width INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1);

-- Default Assignments folds into trucks (it was 1:1). Helpers become rows.
CREATE TABLE trucks (
  id INTEGER PRIMARY KEY,
  plate_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  brand TEXT,
  type TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  billing_category_id INTEGER REFERENCES billing_categories(id),
  default_driver_id INTEGER REFERENCES employees(id),
  roster_notes TEXT);

CREATE TABLE truck_default_helpers (
  truck_id INTEGER NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  PRIMARY KEY (truck_id, slot));

CREATE TABLE outlets (
  id INTEGER PRIMARY KEY,
  outlet_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  area TEXT,
  address TEXT,
  customer_group TEXT,
  notes TEXT,
  created_at TEXT NOT NULL);

-- One waybill row per LOAD: the trips that share one number on one FO.
-- trips.waybill_id replaces waybills.trip_id. fo_number and locked are gone:
-- join trips for the FO, and locked <=> status = 'Confirmed'.
-- waybill_number is NOT unique: a hand-typed number can land on two loads
-- (PROD holds 19 such numbers), and each load bills on its own.
CREATE TABLE waybills (
  id INTEGER PRIMARY KEY,
  waybill_number TEXT NOT NULL COLLATE NOCASE,
  prefix_id INTEGER NOT NULL REFERENCES waybill_prefixes(id),
  sequence_number INTEGER NOT NULL,
  waybill_type TEXT NOT NULL CHECK (waybill_type IN ('Regular','Redeliver','Foul Trip')),
  parent_waybill_id INTEGER REFERENCES waybills(id),
  status TEXT NOT NULL CHECK (status IN ('Suggested','Confirmed')),
  confirmed_by TEXT,
  confirmed_at TEXT);

-- area is gone (join outlets); helpers are rows; snapshots stay.
CREATE TABLE trips (
  id INTEGER PRIMARY KEY,
  trip_date TEXT NOT NULL,
  billing_date TEXT NOT NULL,
  fo_number TEXT,
  fo_split_suffix TEXT,
  outlet_id INTEGER REFERENCES outlets(id),
  quantity INTEGER,
  cbm REAL,
  restrictions TEXT,
  truck_id INTEGER REFERENCES trucks(id),
  driver_id INTEGER REFERENCES employees(id),
  truck_billing_category TEXT,
  trip_status TEXT NOT NULL CHECK (trip_status IN ('Prepping','Backlog','Scheduled','Preload',
    'Delivered','Undelivered','Foul Trip - No Redeliver','Foul Trip - For Redeliver',
    'Redeliver','Two-Day Trip')),
  parent_trip_id INTEGER REFERENCES trips(id),
  source TEXT NOT NULL CHECK (source IN ('Import','Manual','Carry-over')),
  tier INTEGER,
  remarks TEXT,
  status_changed_by TEXT,
  status_changed_at TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  convoy_group TEXT,
  sort_order INTEGER,
  origin TEXT,
  waybill_id INTEGER REFERENCES waybills(id));

CREATE TABLE trip_helpers (
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  PRIMARY KEY (trip_id, slot));

-- trip_date is gone: the 21-day window joins trips(trip_date), which is indexed.
CREATE TABLE route_frequency_log (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  driver_id INTEGER NOT NULL REFERENCES employees(id),
  outlet_id INTEGER NOT NULL REFERENCES outlets(id));

-- Long format: one row per band. area_key = _normArea(area) for matching; the
-- uniqueness key is the raw area, because the DOE matrix names two different
-- towns "San Juan" and "SAN JUAN" (v1 stored both and billed the first).
-- A band with no rate has no row.
CREATE TABLE freight_rates (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  area TEXT NOT NULL,
  area_key TEXT NOT NULL,
  truck_type TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  band INTEGER NOT NULL CHECK (band BETWEEN 1 AND 25),
  rate REAL NOT NULL,
  UNIQUE (origin, area, truck_type, effective_date, band));

CREATE TABLE fuel_prices (
  id INTEGER PRIMARY KEY,
  effective_date TEXT NOT NULL UNIQUE,
  diesel_price REAL NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL);

CREATE TABLE billing_charge_types (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER,
  active INTEGER NOT NULL DEFAULT 1);

-- waybill_number is gone (join). rate_band is the band index; the label comes
-- from _fuelBandLabel. overrides stays a JSON array (a set of flags, not a relation).
CREATE TABLE billing_lines (
  id INTEGER PRIMARY KEY,
  waybill_id INTEGER NOT NULL UNIQUE REFERENCES waybills(id),
  trip_date TEXT NOT NULL,
  billing_date TEXT NOT NULL,
  origin TEXT,
  plate_number TEXT,
  fo_number TEXT,
  truck_type TEXT,
  area TEXT,
  drops INTEGER NOT NULL,
  cartons INTEGER NOT NULL,
  diesel_price REAL,
  rate_band INTEGER,
  hauling_rate REAL NOT NULL DEFAULT 0,
  mano REAL NOT NULL DEFAULT 0,
  drop_fee REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  billing_number TEXT,
  status TEXT NOT NULL DEFAULT 'Not Billed' CHECK (status IN ('Not Billed','Billed','Deferred')),
  overrides TEXT,
  notes TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT);

CREATE TABLE billing_line_charges (
  billing_line_id INTEGER NOT NULL REFERENCES billing_lines(id) ON DELETE CASCADE,
  charge_type_id INTEGER NOT NULL REFERENCES billing_charge_types(id),
  amount REAL NOT NULL,
  PRIMARY KEY (billing_line_id, charge_type_id));

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  user_email TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  table_name TEXT,
  row_id INTEGER,
  old_value TEXT,
  new_value TEXT);

CREATE INDEX trips_trip_date    ON trips(trip_date);
CREATE INDEX trips_billing_date ON trips(billing_date);
CREATE INDEX trips_fo           ON trips(trip_date, fo_number);
CREATE INDEX trips_waybill      ON trips(waybill_id);
CREATE INDEX waybills_number    ON waybills(waybill_number);
CREATE INDEX freight_rates_key  ON freight_rates(origin, area_key, truck_type, effective_date);
CREATE INDEX rfl_driver_outlet  ON route_frequency_log(driver_id, outlet_id);
CREATE INDEX audit_ts           ON audit_log(ts);
CREATE INDEX sessions_expires   ON sessions(expires_at);
