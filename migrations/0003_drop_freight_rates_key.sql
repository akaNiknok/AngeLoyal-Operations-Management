-- Drop freight_rates_key. It cuts the cost of a rate write from 3 rows to 2,
-- which is what brings a full data load under the free plan's 100,000 rows
-- written per day. No query used it:
--   getFreightRates and the origin list read the whole table (the rate lookup
--   runs in JS); the rate seed filters on effective_date; every other rate
--   read goes by id or by the raw (origin, area, truck_type, effective_date,
--   band) key, which the UNIQUE constraint already serves.
-- The area_key column stays: the seed and the writers still fill it.
DROP INDEX IF EXISTS freight_rates_key;
