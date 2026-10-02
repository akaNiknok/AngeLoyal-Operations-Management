-- The History button reads audit_log for one row: a trip, a waybill or a
-- billing line. Without this index each read visits the whole log, and the
-- log only grows.
CREATE INDEX audit_row ON audit_log(table_name, row_id);
