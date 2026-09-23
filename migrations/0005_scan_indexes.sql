-- Indexes for four lookups that read a whole table today. D1 bills every
-- row a query visits, and trips, waybills and route_frequency_log grow
-- every day, so each scan costs more each week.
--
-- waybills_prefix_seq: the waybill counter reads MAX(sequence_number) for
--   one prefix on every suggestion. The index answers it with one row.
-- rfl_trip: a trip delete clears its log rows, and the FK check on
--   route_frequency_log.trip_id looks them up again.
-- trips_parent / waybills_parent: a trip delete or a waybill unlink clears
--   the children, and the FK checks look them up too. Only carry-overs,
--   redelivers and foul trips have a parent, so a partial index holds few
--   rows and adds almost no write cost.
CREATE INDEX waybills_prefix_seq ON waybills(prefix_id, sequence_number);
CREATE INDEX rfl_trip            ON route_frequency_log(trip_id);
CREATE INDEX trips_parent        ON trips(parent_trip_id) WHERE parent_trip_id IS NOT NULL;
CREATE INDEX waybills_parent     ON waybills(parent_waybill_id) WHERE parent_waybill_id IS NOT NULL;
