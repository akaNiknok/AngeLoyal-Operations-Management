-- One row per rate line (origin, area, truck type, effective date) with its
-- 25 band rates in a JSON array, instead of one row per band. A block drops
-- from about 36,750 rows to about 1,470. A Billing open reads about 430 rows,
-- not 10,800, and a Lingunan import is about 624 inserts, not 15,600.
--
-- rates[0] is band 1 (30.01-35) and rates[24] is band 25 (150.01-155). A
-- blank band is JSON null. A line with no rate at all has no row, as before.
--
-- area_key goes: no query reads it (see 0003). The id of a line is the lowest
-- band id of its group, which is the id the client and the audit rows used.
CREATE TABLE freight_rates_lines (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  area TEXT NOT NULL,
  truck_type TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  rates TEXT NOT NULL CHECK (json_array_length(rates) = 25),
  UNIQUE (origin, area, truck_type, effective_date));

INSERT INTO freight_rates_lines (id, origin, area, truck_type, effective_date, rates)
  SELECT MIN(id), origin, area, truck_type, effective_date, json_array(
    MAX(CASE band WHEN 1 THEN rate END),
    MAX(CASE band WHEN 2 THEN rate END),
    MAX(CASE band WHEN 3 THEN rate END),
    MAX(CASE band WHEN 4 THEN rate END),
    MAX(CASE band WHEN 5 THEN rate END),
    MAX(CASE band WHEN 6 THEN rate END),
    MAX(CASE band WHEN 7 THEN rate END),
    MAX(CASE band WHEN 8 THEN rate END),
    MAX(CASE band WHEN 9 THEN rate END),
    MAX(CASE band WHEN 10 THEN rate END),
    MAX(CASE band WHEN 11 THEN rate END),
    MAX(CASE band WHEN 12 THEN rate END),
    MAX(CASE band WHEN 13 THEN rate END),
    MAX(CASE band WHEN 14 THEN rate END),
    MAX(CASE band WHEN 15 THEN rate END),
    MAX(CASE band WHEN 16 THEN rate END),
    MAX(CASE band WHEN 17 THEN rate END),
    MAX(CASE band WHEN 18 THEN rate END),
    MAX(CASE band WHEN 19 THEN rate END),
    MAX(CASE band WHEN 20 THEN rate END),
    MAX(CASE band WHEN 21 THEN rate END),
    MAX(CASE band WHEN 22 THEN rate END),
    MAX(CASE band WHEN 23 THEN rate END),
    MAX(CASE band WHEN 24 THEN rate END),
    MAX(CASE band WHEN 25 THEN rate END))
  FROM freight_rates
  GROUP BY origin, area, truck_type, effective_date;

DROP TABLE freight_rates;
ALTER TABLE freight_rates_lines RENAME TO freight_rates;

-- An import deletes its block and the re-price warning finds the next block,
-- both by origin and date.
CREATE INDEX freight_rates_origin_date ON freight_rates(origin, effective_date);
