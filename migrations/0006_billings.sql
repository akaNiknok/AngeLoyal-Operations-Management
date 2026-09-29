-- A billing is one submission to Rebisco: its number, the DATE: line and the
-- week it covers. The Billing panel lists them, and a reprint reads the exact
-- lines and header that went out. v1 kept only the number as text on each
-- line, so a reprint had to rebuild the header by hand and the set by filter.
--
-- billing_lines.billing_id replaces billing_lines.billing_number: a line is
-- Billed exactly when it points at a billing.
CREATE TABLE billings (
  id INTEGER PRIMARY KEY,
  billing_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  doc_date TEXT,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  stamped_by TEXT NOT NULL,
  stamped_at TEXT NOT NULL);

-- The existing stamps. v1 never stored the DATE: line or the typed range, so
-- doc_date stays blank and the period is the span of the billing's lines.
-- A stamp never set updated_at, so stamped_at is the line's last edit — the
-- nearest time the data holds.
INSERT INTO billings (billing_number, period_from, period_to, stamped_by, stamped_at)
  SELECT TRIM(billing_number), MIN(trip_date), MAX(trip_date),
         COALESCE(MAX(updated_by), MAX(added_by)), COALESCE(MAX(updated_at), MAX(added_at))
  FROM billing_lines
  WHERE TRIM(COALESCE(billing_number, '')) <> ''
  GROUP BY TRIM(billing_number) COLLATE NOCASE;

ALTER TABLE billing_lines ADD COLUMN billing_id INTEGER REFERENCES billings(id);

UPDATE billing_lines
  SET billing_id = (SELECT b.id FROM billings b WHERE b.billing_number = TRIM(billing_lines.billing_number))
  WHERE TRIM(COALESCE(billing_number, '')) <> '';

ALTER TABLE billing_lines DROP COLUMN billing_number;

-- Only stamped lines carry an id, and a reprint reads one billing's lines.
CREATE INDEX billing_lines_billing ON billing_lines(billing_id) WHERE billing_id IS NOT NULL;
