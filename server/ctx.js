// ============================================================
//  AngeLoyal OMS — server/ctx.js
//  Per-request context. A Worker isolate serves many requests at
//  once, so "the current user" and "the database" cannot be module
//  globals (the .gs backend used _REQUEST_EMAIL; here that would
//  mis-attribute audit rows and RBAC across interleaved requests).
//  AsyncLocalStorage carries { db, email, clientId, fetch } down every
//  await chain that starts inside runWith().
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/**
 * Runs `fn` with `store` merged over the enclosing context (if any), so a
 * nested runWith({ email }) keeps the outer db/clientId/fetch.
 * @param {{ db?: object, email?: string|null, clientId?: string, fetch?: Function }} store
 * @param {Function} fn
 */
export function runWith(store, fn) {
  return als.run({ ...(als.getStore() || {}), ...store }, fn);
}

function store() {
  const s = als.getStore();
  if (!s || !s.db) throw new Error('No request context. Call runWith({ db, email }, fn).');
  return s;
}

/** The D1 binding (or the test shim) for this request. */
export const db = () => store().db;

/** The verified sign-in email for this request, or null before/without one. */
export const currentEmail = () => store().email || null;

/** The OAuth Web client ID (wrangler.toml [vars] OAUTH_CLIENT_ID). */
export const clientId = () => store().clientId || '';

/** fetch() for this request — the global one, or a test stub. */
export const fetchImpl = () => store().fetch || globalThis.fetch;
