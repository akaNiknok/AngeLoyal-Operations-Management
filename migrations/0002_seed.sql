-- AngeLoyal OMS — defaults the .gs readers used to self-seed with
-- _getOrCreateSheet. INSERT OR IGNORE, so a database that already carries
-- imported rows is left alone. The `-- @seed <table>` markers let the test
-- harness apply one section when a test provides no rows for that table
-- (the equivalent of "the sheet did not exist yet"). The route map rows
-- SELECT their category, so a map row is only added when its category exists.

-- @seed billing_categories
INSERT OR IGNORE INTO billing_categories (name) VALUES ('10W'), ('6W'), ('L300');

-- @seed route_type_map
INSERT OR IGNORE INTO route_type_map (file_type_code, billing_category_id) SELECT '10W',  id FROM billing_categories WHERE name = '10W';
INSERT OR IGNORE INTO route_type_map (file_type_code, billing_category_id) SELECT '6WF',  id FROM billing_categories WHERE name = '6W';
INSERT OR IGNORE INTO route_type_map (file_type_code, billing_category_id) SELECT '6WC',  id FROM billing_categories WHERE name = '6W';
INSERT OR IGNORE INTO route_type_map (file_type_code, billing_category_id) SELECT '4WC',  id FROM billing_categories WHERE name = '6W';
INSERT OR IGNORE INTO route_type_map (file_type_code, billing_category_id) SELECT 'L300', id FROM billing_categories WHERE name = 'L300';

-- @seed customer_group_colors
INSERT OR IGNORE INTO customer_group_colors (customer_group, color) VALUES
  ('PG',   '#92d050'),
  ('SM',   '#00b0f0'),
  ('WM',   '#ffe94d'),
  ('RO',   '#e5b8b7'),
  ('SW',   '#e5b8b7'),
  ('PS',   '#ffc000'),
  ('ALFA', '#ffc000');

-- @seed billing_charge_types
INSERT OR IGNORE INTO billing_charge_types (label, sort_order) VALUES
  ('Parking Fee/Toll Fees', 10),
  ('Packing Tape', 20),
  ('Bad Orders @5.00 / Bx', 30);
