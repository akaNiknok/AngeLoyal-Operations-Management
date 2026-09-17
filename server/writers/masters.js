// ============================================================
//  AngeLoyal OMS — server/writers/masters.js
//  Master-record writers (DataWriters.gs): outlets, trucks, billing
//  categories, route type map, customer group colors, employees,
//  users, billing charge types, the truck roster (Default
//  Assignments, folded into trucks) and clearAllData.
//
//  Same read-modify-write shape everywhere, so the mechanical half
//  lives in the two local helpers below (writerResult, assertUnique)
//  — the D1 equivalents of Utils.gs's _writerResult / _requireUnique.
//  Uniqueness relies on each column's UNIQUE COLLATE NOCASE, checked
//  up front for a clean message instead of parsing the D1 constraint
//  error.
// ============================================================

import { q, one, run, batch, stmt, numOrNull, nowPH } from '../db.js';
import { requirePermission, ROLES } from '../rbac.js';
import { currentEmail } from '../ctx.js';
import { _auditLog, helperSlots } from '../internals.js';

/** Runs a writer body inside the shared result envelope (Utils.gs _writerResult). */
async function writerResult(fn) {
  try {
    return Object.assign({ success: true }, (await fn()) || {});
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Throws `message` when another row already holds `value` in `col` (Utils.gs _requireUnique). */
async function assertUnique(table, col, value, message, skipId) {
  const row = skipId
    ? await one(`SELECT id FROM ${table} WHERE ${col} = ? AND id != ?`, value, skipId)
    : await one(`SELECT id FROM ${table} WHERE ${col} = ?`, value);
  if (row) throw new Error(message);
}

/** Sets `sets` (a { column: value } map) on one row, when there is anything to set. */
async function applyUpdate(table, id, sets) {
  const cols = Object.keys(sets);
  if (!cols.length) return;
  await run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    ...cols.map((c) => sets[c]), id);
}

/**
 * Resolves a billing category NAME (as the Admin picks it in the UI) to its
 * row. Route Type Map and Trucks store the FK now, so an unknown name is a
 * real error instead of a silently mismatched free-text column.
 * @returns {Promise<{ id: number|null, name: string }>}
 */
async function resolveBillingCategory(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { id: null, name: '' };
  const row = await one(`SELECT id, name FROM billing_categories WHERE name = ?`, trimmed);
  if (!row) throw new Error(`Unknown billing category "${trimmed}".`);
  return { id: row.id, name: row.name };
}

// ============================================================
//  Default Assignments (the truck roster; Admin + Dispatcher)
//  Folded into trucks: `id` IS the truck id (server/readers.js getDefaultAssignments).
// ============================================================

/**
 * Updates the default driver and/or helpers for a truck. Future dispatch
 * pre-fills only — it never touches existing trips.
 * @param {number} truckId
 * @param {Object} changes  { defaultDriverId?, defaultHelperIds?, notes? }
 */
export async function updateDefaultAssignment(truckId, changes) {
  await requirePermission('ASSIGN_CREW');
  return writerResult(async () => {
    const truck = await one(`SELECT id, default_driver_id, roster_notes FROM trucks WHERE id = ?`, Number(truckId));
    if (!truck) throw new Error(`Truck ID ${truckId} not found.`);
    const oldHelpers = (await q(
      `SELECT employee_id FROM truck_default_helpers WHERE truck_id = ? ORDER BY slot`, truck.id))
      .map((h) => h.employee_id);

    const sets = {};
    if (changes.defaultDriverId !== undefined) sets.default_driver_id = numOrNull(changes.defaultDriverId);
    if (changes.notes !== undefined) sets.roster_notes = changes.notes;

    const stmts = [];
    if (Object.keys(sets).length) {
      const cols = Object.keys(sets);
      stmts.push(stmt(`UPDATE trucks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...cols.map((c) => sets[c]), truck.id));
    }
    if (changes.defaultHelperIds !== undefined) {
      stmts.push(stmt(`DELETE FROM truck_default_helpers WHERE truck_id = ?`, truck.id));
      const ids = Array.isArray(changes.defaultHelperIds)
        ? changes.defaultHelperIds
        : String(changes.defaultHelperIds || '').split(',');
      helperSlots(ids).forEach((h) => stmts.push(
        stmt(`INSERT INTO truck_default_helpers (truck_id, employee_id, slot) VALUES (?, ?, ?)`,
          truck.id, h.employee_id, h.slot)));
    }
    if (stmts.length) await batch(stmts);

    await _auditLog('DEFAULT_ASSIGN_CHANGE', 'trucks', truck.id,
      JSON.stringify({ driverId: truck.default_driver_id, helperIds: oldHelpers }),
      JSON.stringify(changes));
  });
}

// ============================================================
//  Outlets (Admin only)
// ============================================================

const OUTLET_COLS = { outletName: 'outlet_name', area: 'area', address: 'address', customerGroup: 'customer_group', notes: 'notes' };

/** @param {Object} data  { outletName, area, address, customerGroup, notes } */
export async function createOutlet(data) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const outletName = String(data.outletName || '').trim();
    if (!outletName) throw new Error('Outlet name is required.');
    await assertUnique('outlets', 'outlet_name', outletName, `An outlet named "${outletName}" already exists.`);

    const area = String(data.area || '').trim();
    const address = String(data.address || '').trim();
    const customerGroup = String(data.customerGroup || '').trim();
    const notes = String(data.notes || '').trim();

    const res = await run(
      `INSERT INTO outlets (outlet_name, area, address, customer_group, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      outletName, area, address, customerGroup, notes, nowPH());

    await _auditLog('OUTLET_CREATE', 'outlets', res.last_row_id, '', outletName);
    return { outlet: { id: res.last_row_id, outletName, area, address, customerGroup, notes } };
  });
}

/** @param {Object} changes  Any of { outletName, area, address, customerGroup, notes } */
export async function updateOutlet(outletId, changes) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const row = await one(`SELECT * FROM outlets WHERE id = ?`, Number(outletId));
    if (!row) throw new Error(`Outlet ID ${outletId} not found.`);
    const oldVal = { outletName: row.outlet_name, area: row.area, address: row.address, customerGroup: row.customer_group, notes: row.notes };

    const sets = {};
    if (changes.outletName !== undefined) {
      const outletName = String(changes.outletName).trim();
      if (!outletName) throw new Error('Outlet name is required.');
      await assertUnique('outlets', 'outlet_name', outletName, `An outlet named "${outletName}" already exists.`, row.id);
      sets.outlet_name = outletName;
    }
    ['area', 'address', 'customerGroup', 'notes'].forEach((k) => {
      if (changes[k] !== undefined) sets[OUTLET_COLS[k]] = changes[k];
    });
    await applyUpdate('outlets', row.id, sets);
    await _auditLog('OUTLET_EDIT', 'outlets', outletId, JSON.stringify(oldVal), JSON.stringify(changes));
  });
}

// ============================================================
//  Trucks (Admin only)
// ============================================================

const TRUCK_SELECT = `SELECT t.*, c.name AS category_name FROM trucks t
  LEFT JOIN billing_categories c ON c.id = t.billing_category_id WHERE t.id = ?`;

function truckFromRow(r) {
  return {
    id: r.id, plate: r.plate_number, brand: r.brand || '', type: r.type || '',
    billingCategory: r.category_name || '', active: !!r.active,
  };
}

/**
 * Creates a truck. Billing category is picked directly from the Billing
 * Categories list. Default Assignments is folded into trucks, so the new
 * row is already a blank roster entry — no separate seed row needed.
 * @param {Object} data  { plate, brand, type, billingCategory }
 */
export async function createTruck(data) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const plate = String(data.plate || '').trim();
    if (!plate) throw new Error('Plate number is required.');
    await assertUnique('trucks', 'plate_number', plate, `A truck with plate "${plate}" already exists.`);

    const brand = String(data.brand || '').trim();
    const type = String(data.type || '').trim();
    const category = await resolveBillingCategory(data.billingCategory);

    const res = await run(
      `INSERT INTO trucks (plate_number, brand, type, active, billing_category_id) VALUES (?, ?, ?, 1, ?)`,
      plate, brand, type, category.id);

    await _auditLog('TRUCK_CREATE', 'trucks', res.last_row_id, '',
      JSON.stringify({ plate, brand, type, billingCategory: category.name }));

    return {
      truck: { id: res.last_row_id, plate, brand, type, billingCategory: category.name, active: true },
      defaultAssignment: { id: res.last_row_id, truckId: res.last_row_id, defaultDriverId: null, defaultHelperIds: [], notes: '' },
    };
  });
}

/** @param {Object} changes  Any of { plate, brand, type, billingCategory, active } */
export async function updateTruck(truckId, changes) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const before = await one(TRUCK_SELECT, Number(truckId));
    if (!before) throw new Error(`Truck ID ${truckId} not found.`);
    const oldVal = truckFromRow(before);

    const sets = {};
    if (changes.plate !== undefined) {
      const plate = String(changes.plate).trim();
      if (!plate) throw new Error('Plate number is required.');
      await assertUnique('trucks', 'plate_number', plate, `A truck with plate "${plate}" already exists.`, before.id);
      sets.plate_number = plate;
    }
    if (changes.brand !== undefined) sets.brand = String(changes.brand).trim();
    if (changes.type !== undefined) sets.type = String(changes.type).trim();
    if (changes.billingCategory !== undefined) sets.billing_category_id = (await resolveBillingCategory(changes.billingCategory)).id;
    if (changes.active !== undefined) sets.active = changes.active ? 1 : 0;

    await applyUpdate('trucks', before.id, sets);
    await _auditLog('TRUCK_EDIT', 'trucks', truckId, JSON.stringify(oldVal), JSON.stringify(changes));

    const after = await one(TRUCK_SELECT, before.id);
    return { truck: truckFromRow(after) };
  });
}

// ============================================================
//  Billing Categories (Admin only)
// ============================================================

/** @param {Object} data  { name } */
export async function createBillingCategory(data) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('Name is required.');
    await assertUnique('billing_categories', 'name', name, `A billing category named "${name}" already exists.`);

    const res = await run(`INSERT INTO billing_categories (name, active) VALUES (?, 1)`, name);
    await _auditLog('BILLING_CATEGORY_CREATE', 'billing_categories', res.last_row_id, '', name);
    return { billingCategory: { id: res.last_row_id, name, active: true } };
  });
}

/**
 * Updates a billing category. Route Type Map and Trucks reference it by FK
 * now, so a rename needs no cascade — every row that pointed at the old name
 * already points at this id.
 * @param {Object} changes  Any of { name, active }
 */
export async function updateBillingCategory(categoryId, changes) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const row = await one(`SELECT * FROM billing_categories WHERE id = ?`, Number(categoryId));
    if (!row) throw new Error(`Billing category ID ${categoryId} not found.`);
    const oldVal = { name: row.name, active: !!row.active };

    const sets = {};
    if (changes.name !== undefined) {
      const name = String(changes.name).trim();
      if (!name) throw new Error('Name is required.');
      await assertUnique('billing_categories', 'name', name, `A billing category named "${name}" already exists.`, row.id);
      sets.name = name;
    }
    if (changes.active !== undefined) sets.active = changes.active ? 1 : 0;
    await applyUpdate('billing_categories', row.id, sets);
    await _auditLog('BILLING_CATEGORY_EDIT', 'billing_categories', categoryId, JSON.stringify(oldVal), JSON.stringify(changes));

    const after = await one(`SELECT * FROM billing_categories WHERE id = ?`, row.id);
    return { billingCategory: { id: after.id, name: after.name, active: !!after.active } };
  });
}

// ============================================================
//  Route Type Map (Admin only)
// ============================================================

const ROUTE_TYPE_MAP_SELECT = `SELECT m.*, c.name AS category_name FROM route_type_map m
  LEFT JOIN billing_categories c ON c.id = m.billing_category_id WHERE m.id = ?`;

function mappingFromRow(r) {
  return { id: r.id, fileTypeCode: r.file_type_code, billingCategory: r.category_name || '', active: !!r.active };
}

/** @param {Object} data  { fileTypeCode, billingCategory } */
export async function createRouteTypeMapping(data) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const code = String(data.fileTypeCode || '').trim();
    if (!code) throw new Error('File type code is required.');
    if (!String(data.billingCategory || '').trim()) throw new Error('Billing category is required.');
    await assertUnique('route_type_map', 'file_type_code', code, `A mapping for "${code}" already exists.`);

    const category = await resolveBillingCategory(data.billingCategory);
    const res = await run(
      `INSERT INTO route_type_map (file_type_code, billing_category_id, active) VALUES (?, ?, 1)`,
      code, category.id);

    await _auditLog('ROUTE_TYPE_MAP_CREATE', 'route_type_map', res.last_row_id, '', `${code} → ${category.name}`);
    return { mapping: { id: res.last_row_id, fileTypeCode: code, billingCategory: category.name, active: true } };
  });
}

/** @param {Object} changes  { fileTypeCode?, billingCategory?, active? } */
export async function updateRouteTypeMapping(mappingId, changes) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const before = await one(ROUTE_TYPE_MAP_SELECT, Number(mappingId));
    if (!before) throw new Error(`Route type mapping ID ${mappingId} not found.`);
    const oldVal = mappingFromRow(before);

    const sets = {};
    if (changes.fileTypeCode !== undefined) {
      const code = String(changes.fileTypeCode).trim();
      if (!code) throw new Error('File type code is required.');
      await assertUnique('route_type_map', 'file_type_code', code, `A mapping for "${code}" already exists.`, before.id);
      sets.file_type_code = code;
    }
    if (changes.billingCategory !== undefined) {
      const category = String(changes.billingCategory).trim();
      if (!category) throw new Error('Billing category is required.');
      sets.billing_category_id = (await resolveBillingCategory(category)).id;
    }
    if (changes.active !== undefined) sets.active = changes.active ? 1 : 0;

    await applyUpdate('route_type_map', before.id, sets);
    await _auditLog('ROUTE_TYPE_MAP_EDIT', 'route_type_map', mappingId, JSON.stringify(oldVal), JSON.stringify(changes));

    const after = await one(ROUTE_TYPE_MAP_SELECT, before.id);
    return { mapping: mappingFromRow(after) };
  });
}

// ============================================================
//  Customer Group Colors (Admin only)
// ============================================================

/**
 * Upserts the color for a customer group, case-insensitive by group code. A
 * blank color deactivates the row rather than deleting it, so a re-add later
 * still lands on the same row.
 * @param {string} group
 * @param {string} color  Hex like "#92d050", or "" to clear.
 */
export async function saveCustomerGroupColor(group, color) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const code = String(group || '').trim();
    if (!code) throw new Error('Customer group is required.');
    const hex = String(color || '').trim();
    if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('Color must be a hex value like #92d050.');
    const active = hex !== '' ? 1 : 0;

    const existing = await one(`SELECT id FROM customer_group_colors WHERE customer_group = ?`, code);
    let id;
    if (existing) {
      id = existing.id;
      await run(`UPDATE customer_group_colors SET color = ?, active = ? WHERE id = ?`, hex, active, id);
    } else {
      const res = await run(
        `INSERT INTO customer_group_colors (customer_group, color, active) VALUES (?, ?, ?)`, code, hex, active);
      id = res.last_row_id;
    }

    await _auditLog('CG_COLOR_EDIT', 'customer_group_colors', id, '', `${code} → ${hex || '(cleared)'}`);
    return { customerGroupColor: { id, customerGroup: code, color: hex, active: !!active } };
  });
}

// ============================================================
//  Employees (Admin only)
// ============================================================

/** @param {Object} data  { nick, firstName, middleName, lastName, role } */
export async function createEmployee(data) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const nick = String(data.nick || '').trim();
    if (!nick) throw new Error('Nickname is required.');
    const role = String(data.role || '').trim();
    if (!role) throw new Error('Role is required.');
    const firstName = String(data.firstName || '').trim();
    const middleName = String(data.middleName || '').trim();
    const lastName = String(data.lastName || '').trim();

    const res = await run(
      `INSERT INTO employees (nickname, first_name, middle_name, last_name, role, active) VALUES (?, ?, ?, ?, ?, 1)`,
      nick, firstName, middleName, lastName, role);

    await _auditLog('EMPLOYEE_CREATE', 'employees', res.last_row_id, '', JSON.stringify({ nick, role }));
    return { employee: { id: res.last_row_id, nick, firstName, middleName, lastName, role, active: true } };
  });
}

/** @param {Object} changes  Any of { nick, firstName, middleName, lastName, role, active } */
export async function updateEmployee(employeeId, changes) {
  await requirePermission('EDIT_MASTER_RECORDS');
  return writerResult(async () => {
    const row = await one(`SELECT * FROM employees WHERE id = ?`, Number(employeeId));
    if (!row) throw new Error(`Employee ID ${employeeId} not found.`);
    const oldVal = { nick: row.nickname, role: row.role, active: !!row.active };

    const sets = {};
    if (changes.nick !== undefined) {
      const v = String(changes.nick).trim();
      if (!v) throw new Error('Nickname is required.');
      sets.nickname = v;
    }
    if (changes.role !== undefined) {
      const v = String(changes.role).trim();
      if (!v) throw new Error('Role is required.');
      sets.role = v;
    }
    ['firstName', 'middleName', 'lastName'].forEach((k) => {
      if (changes[k] !== undefined) sets[{ firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name' }[k]] = String(changes[k]).trim();
    });
    if (changes.active !== undefined) sets.active = changes.active ? 1 : 0;

    await applyUpdate('employees', row.id, sets);
    await _auditLog('EMPLOYEE_EDIT', 'employees', employeeId, JSON.stringify(oldVal), JSON.stringify(changes));
  });
}

// ============================================================
//  Users (Admin only)
// ============================================================

/**
 * Validates one user field set into `sets` (column map). Shared by create
 * and update so a bad role or email cannot reach the table from either path.
 */
function applyUserFields(data, sets) {
  if (data.email !== undefined) {
    const email = String(data.email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required.');
    sets.email = email;
  }
  if (data.displayName !== undefined) {
    const name = String(data.displayName).trim();
    if (!name) throw new Error('Display name is required.');
    sets.display_name = name;
  }
  if (data.role !== undefined) {
    const role = String(data.role).trim();
    const valid = Object.values(ROLES);
    if (!valid.includes(role)) throw new Error(`Role must be one of: ${valid.join(', ')}.`);
    sets.role = role;
  }
}

/** @param {Object} data  { email, displayName, role } */
export async function createUser(data) {
  await requirePermission('EDIT_USERS');
  return writerResult(async () => {
    const sets = {};
    applyUserFields(data, sets);
    if (!sets.email) throw new Error('A valid email is required.');
    if (!sets.display_name) throw new Error('Display name is required.');
    if (!sets.role) throw new Error('Role is required.');
    await assertUnique('users', 'email', sets.email, `A user with the email "${sets.email}" already exists.`);

    const res = await run(
      `INSERT INTO users (email, display_name, role, active) VALUES (?, ?, ?, 1)`,
      sets.email, sets.display_name, sets.role);

    await _auditLog('USER_CREATE', 'users', res.last_row_id, '', JSON.stringify({ email: sets.email, role: sets.role }));
    return { user: { id: res.last_row_id, email: sets.email, displayName: sets.display_name, role: sets.role, active: true } };
  });
}

/**
 * Updates a user. An Admin cannot change their own Role or Active flag — the
 * one edit nobody can undo from inside the app, since it removes the panel
 * that would undo it.
 * @param {Object} changes  Any of { email, displayName, role, active }
 */
export async function updateUser(userId, changes) {
  await requirePermission('EDIT_USERS');
  return writerResult(async () => {
    const row = await one(`SELECT * FROM users WHERE id = ?`, Number(userId));
    if (!row) throw new Error(`User ID ${userId} not found.`);
    const oldVal = { email: row.email, displayName: row.display_name, role: row.role, active: !!row.active };

    const isSelf = String(oldVal.email).trim().toLowerCase() === String(currentEmail() || '').trim().toLowerCase();
    const dropsSelfRole = changes.role !== undefined && String(changes.role).trim() !== String(oldVal.role);
    if (isSelf && (changes.active === false || dropsSelfRole)) {
      throw new Error('You cannot change your own role or remove your own access.');
    }

    const sets = {};
    applyUserFields(changes, sets);
    if (sets.email) await assertUnique('users', 'email', sets.email, `A user with the email "${sets.email}" already exists.`, row.id);
    if (changes.active !== undefined) sets.active = changes.active ? 1 : 0;

    await applyUpdate('users', row.id, sets);
    await _auditLog('USER_EDIT', 'users', userId, JSON.stringify(oldVal), JSON.stringify(changes));

    const after = await one(`SELECT * FROM users WHERE id = ?`, row.id);
    return { user: { id: after.id, email: after.email, displayName: after.display_name, role: after.role, active: !!after.active } };
  });
}

// ============================================================
//  Billing Charge Types (Admin + Payroll, via EDIT_BILLING)
// ============================================================

/** @param {{ label: string, sortOrder: number }} data */
export async function createBillingChargeType(data) {
  await requirePermission('EDIT_BILLING');
  return writerResult(async () => {
    const label = String((data && data.label) || '').trim();
    if (!label) throw new Error('Label is required.');
    await assertUnique('billing_charge_types', 'label', label, `A billing column named "${label}" already exists.`);

    // sort_order defaults to id * 10 when not given — that needs the new id,
    // so insert with a placeholder and fill it in right after.
    const sortOrder = numOrNull(data && data.sortOrder);
    const res = await run(
      `INSERT INTO billing_charge_types (label, sort_order, active) VALUES (?, ?, 1)`,
      label, sortOrder === null ? 0 : sortOrder);
    const finalSortOrder = sortOrder === null ? res.last_row_id * 10 : sortOrder;
    if (sortOrder === null) await run(`UPDATE billing_charge_types SET sort_order = ? WHERE id = ?`, finalSortOrder, res.last_row_id);

    await _auditLog('BILLING_CHARGE_TYPE_CREATE', 'billing_charge_types', res.last_row_id, '', label);
    return { billingChargeType: { id: res.last_row_id, label, sortOrder: finalSortOrder, active: true } };
  });
}

/** @param {{ label?: string, sortOrder?: number, active?: boolean }} changes */
export async function updateBillingChargeType(chargeTypeId, changes) {
  await requirePermission('EDIT_BILLING');
  return writerResult(async () => {
    const row = await one(`SELECT * FROM billing_charge_types WHERE id = ?`, Number(chargeTypeId));
    if (!row) throw new Error(`Billing column ID ${chargeTypeId} not found.`);
    const oldVal = { label: row.label, sortOrder: numOrNull(row.sort_order), active: !!row.active };

    const sets = {};
    if (changes && changes.label !== undefined) {
      const label = String(changes.label).trim();
      if (!label) throw new Error('Label is required.');
      await assertUnique('billing_charge_types', 'label', label, `A billing column named "${label}" already exists.`, row.id);
      sets.label = label;
    }
    if (changes && changes.sortOrder !== undefined) sets.sort_order = numOrNull(changes.sortOrder);
    if (changes && changes.active !== undefined) sets.active = changes.active ? 1 : 0;

    await applyUpdate('billing_charge_types', row.id, sets);
    await _auditLog('BILLING_CHARGE_TYPE_EDIT', 'billing_charge_types', chargeTypeId, JSON.stringify(oldVal), JSON.stringify(changes));

    const after = await one(`SELECT * FROM billing_charge_types WHERE id = ?`, row.id);
    return { billingChargeType: { id: after.id, label: after.label, sortOrder: numOrNull(after.sort_order), active: !!after.active } };
  });
}

// ============================================================
//  Maintenance
// ============================================================

// The exact phrase an Admin has to type to wipe the environment (Code.gs/DataWriters.gs).
const CLEAR_DATA_PHRASE = 'PERMANENTLY DELETE ALL DATA';

/**
 * Wipes every transactional row from this environment's database (trips,
 * outlets, route frequency log, waybills, billing lines and their child
 * rows, audit log), keeping every master table. Admin-only, and only with
 * the confirmation phrase typed exactly.
 *
 * Deletes run in FK-safe order (children before the parents they reference)
 * inside one batch; the audit row is written AFTER the wipe, on purpose — the
 * audit log is one of the tables being cleared, so this row is the surviving
 * record of who did it.
 * @param {string} confirmPhrase  Must equal CLEAR_DATA_PHRASE.
 */
export async function clearAllData(confirmPhrase) {
  await requirePermission('CLEAR_ALL_DATA');
  try {
    if (String(confirmPhrase == null ? '' : confirmPhrase).trim() !== CLEAR_DATA_PHRASE) {
      throw new Error('Confirmation phrase did not match. Nothing was deleted.');
    }

    await batch([
      stmt(`DELETE FROM billing_line_charges`),
      stmt(`DELETE FROM route_frequency_log`),
      stmt(`DELETE FROM trip_helpers`),
      stmt(`DELETE FROM billing_lines`),
      stmt(`DELETE FROM trips`),
      stmt(`DELETE FROM waybills`),
      stmt(`DELETE FROM outlets`),
      stmt(`DELETE FROM audit_log`),
    ]);

    const cleared = ['Trips', 'Outlets', 'Route Frequency Log', 'Waybills', 'Billing Lines', 'Audit Log'];
    await _auditLog('DATA_CLEAR', '', null, '', JSON.stringify(cleared));

    return { success: true, cleared };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
