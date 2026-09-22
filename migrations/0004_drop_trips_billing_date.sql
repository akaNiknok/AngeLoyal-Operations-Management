-- Drop trips_billing_date. Every index entry is a written row on the free
-- plan, so an index no query uses is a tax on every trip insert and update.
-- No query filters or orders by billing_date: the board and the billing range
-- both select on trip_date, and the billing ledger reads billing_date only
-- from rows it already has.
-- audit_ts stays: the Audit Log panel selects a ts range and reads it back in
-- ts order, so that index now serves a real query.
DROP INDEX IF EXISTS trips_billing_date;
