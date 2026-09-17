// ============================================================
//  AngeLoyal OMS — server/db.js
//  D1 helpers and the date vocabulary every module shares.
//
//  Storage formats (Docs/D1 Migration.md §1):
//    pure date   'YYYY-MM-DD'
//    timestamp   'YYYY-MM-DD HH:MM:SS'   Asia/Manila wall time
//  Client formats stay what the .gs readers returned:
//    pure date   'M/d/yyyy'
//    timestamp   'M/d/yyyy HH:mm:ss'
//  Workers run in UTC, so "today" only ever comes from todayPH().
// ============================================================

import { db } from './ctx.js';

// ------------------------------------------------------------
//  Queries. Every DB call is awaited — a missing await is the
//  most likely port bug (see the plan, §5 rule 8).
// ------------------------------------------------------------

/** A bound statement, for batch(). */
export function stmt(sql, ...args) {
  return db().prepare(sql).bind(...args);
}

/** All rows as objects. */
export async function q(sql, ...args) {
  const r = await stmt(sql, ...args).all();
  return r.results;
}

/** The first row as an object, or null. */
export async function one(sql, ...args) {
  return await stmt(sql, ...args).first();
}

/** Runs a write; returns { last_row_id, changes }. */
export async function run(sql, ...args) {
  const r = await stmt(sql, ...args).run();
  return r.meta;
}

/**
 * Runs bound statements atomically (all or nothing). Pass the result of
 * stmt(). Returns one result per statement, each { results, meta }.
 * @param {object[]} stmts
 */
export async function batch(stmts) {
  if (!stmts || !stmts.length) return [];
  return await db().batch(stmts);
}

// ------------------------------------------------------------
//  Values
// ------------------------------------------------------------

/** Number, or null for blank / non-numeric. Zero survives. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Rounds to 3 decimals, undoing float drift from upstream formulas. */
export function round3(n) {
  return n === null || n === undefined ? null : Math.round(n * 1000) / 1000;
}

// ------------------------------------------------------------
//  Dates
// ------------------------------------------------------------

const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

/** Formats an instant as Manila wall time: 'YYYY-MM-DD HH:MM:SS'. */
export function toPHTimestamp(instant) {
  const d = new Date(new Date(instant).getTime() + PH_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Now, as a storage timestamp in Manila time. */
export function nowPH() {
  return toPHTimestamp(Date.now());
}

/** Today's storage date in Manila time. The only source of "today". */
export function todayPH() {
  return nowPH().slice(0, 10);
}

/** 'YYYY-MM-DD' plus n days (n may be negative). */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday for a storage date. */
export function dayOfWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Client 'M/d/yyyy' (or an already-storage 'YYYY-MM-DD') → 'YYYY-MM-DD'.
 * Null on anything else, including a rolled-over date such as 2/30/2026:
 * a blank must not silently become today.
 */
export function fromClientDate(str) {
  const s = String(str == null ? '' : str).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealDate(s) ? s : null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const ymd = `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return isRealDate(ymd) ? ymd : null;
}

function isRealDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 'YYYY-MM-DD' → 'M/d/yyyy'; '' for null/blank. */
export function toClientDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return `${m}/${d}/${y}`;
}

/** 'YYYY-MM-DD HH:MM:SS' → 'M/d/yyyy HH:mm:ss'; '' for null/blank. */
export function toClientDateTime(ts) {
  if (!ts) return '';
  const s = String(ts);
  return `${toClientDate(s.slice(0, 10))} ${s.slice(11, 19)}`.trim();
}

/** Client 'M/d/yyyy HH:mm:ss' → storage timestamp; null on anything else. */
export function fromClientDateTime(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(str == null ? '' : str).trim());
  if (!m) return null;
  const ymd = fromClientDate(`${m[1]}/${m[2]}/${m[3]}`);
  return ymd ? `${ymd} ${pad(m[4])}:${m[5]}:${m[6] || '00'}` : null;
}
