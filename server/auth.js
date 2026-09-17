// ============================================================
//  AngeLoyal OMS — server/auth.js
//  Google Identity Services sign-in, the sessions table, and the
//  rpc() gateway with its allow-list (Auth.gs).
//
//  The client signs in with Google, receives an ID token and posts it
//  to login(). The server verifies it with Google, mints a random
//  session token and stores it in `sessions`. Every other call goes
//  through rpc(sessionToken, fnName, args), which resolves the token
//  to an email and scopes the request to it (ctx.js).
// ============================================================

import { runWith, clientId, fetchImpl } from './ctx.js';
import { one, run, nowPH, toPHTimestamp } from './db.js';
import { _auditLog } from './internals.js';
import * as readers from './readers.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Verifies an ID token that arrived FROM THE BROWSER and returns its identity,
 * or null. The token is attacker-controlled, so its signature must be checked
 * before any claim in it is believed: decoding it locally would let anyone
 * mint { email: <an admin> } and sign in as them.
 *
 * ponytail: Google's tokeninfo endpoint does the signature + expiry check
 * (one fetch, no key handling). Swap in local RS256 verification against
 * Google's JWKs only if the round trip per sign-in ever shows up.
 * @param {string} idToken
 * @returns {Promise<{ email: string, displayName: string } | null>}
 */
export async function _verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetchImpl()(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    // Non-200 = bad signature, expired, or malformed. Google already rejected it.
    if (res.status !== 200) return null;
    const claims = await res.json();
    // `aud` is what stops a token minted for some other app being replayed here.
    if (claims.aud !== clientId()) return null;
    if (!(claims.email_verified === true || claims.email_verified === 'true')) return null;
    if (!claims.email) return null;
    return {
      email: String(claims.email).trim().toLowerCase(),
      displayName: claims.name || claims.email,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Client-callable sign-in — the one action the API accepts without a session.
 * @param {string} idToken
 * @returns {Promise<{ success: true, sessionToken: string } | { success: false, error: string }>}
 */
export async function login(idToken) {
  const identity = await _verifyIdToken(idToken);
  if (!identity) return { success: false, error: 'AUTH_FAILED' };

  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await run(
    `INSERT INTO sessions (token, email, display_name, expires_at) VALUES (?, ?, ?, ?)`,
    token, identity.email, identity.displayName, toPHTimestamp(Date.now() + SESSION_TTL_MS));
  // ponytail: expired rows are swept here, on sign-in, instead of by a cron.
  await run(`DELETE FROM sessions WHERE expires_at < ?`, nowPH());

  // Attribute the LOGIN row to the new identity, not 'unknown'.
  await runWith({ email: identity.email }, () => _auditLog('LOGIN', 'users', null, '', identity.email));

  return { success: true, sessionToken: token };
}

/** Resolves a session token to its identity, or null if missing/expired. */
export async function _resolveSession(token) {
  if (!token) return null;
  const row = await one(
    `SELECT email, display_name FROM sessions WHERE token = ? AND expires_at > ?`, String(token), nowPH());
  return row ? { email: row.email, displayName: row.display_name } : null;
}

/** Client-callable sign-out. */
export async function logout(sessionToken) {
  if (sessionToken) await run(`DELETE FROM sessions WHERE token = ?`, String(sessionToken));
  return { success: true };
}

// ============================================================
//  RPC GATEWAY
// ============================================================

// Functions the client may invoke through rpc(). Anything not listed (private
// helpers, unexposed readers) is unreachable from the browser. A Phase 1
// writer module adds its functions to FNS below; the names are already here.
export const RPC_ALLOWED = [
  // readers
  'getBootData', 'getDispatchBoardData', 'getWaybillPrefixes', 'getUsers', 'getFreightRates',
  'getFuelPrices',
  // session
  'logout',
  // writers (Phase 1)
  'createTrip', 'saveTripChanges', 'bulkSetTripStatus', 'reorderTrips', 'confirmWaybill',
  'updateSuggestedWaybill', 'updateSuggestedWaybills', 'importRouteFile', 'deleteImportedTrip',
  'bulkDeleteTrips', 'markDayScheduled', 'setTripConvoyGroup', 'updateDefaultAssignment',
  'createOutlet', 'updateOutlet', 'createTruck', 'updateTruck', 'createBillingCategory',
  'updateBillingCategory', 'createRouteTypeMapping', 'updateRouteTypeMapping',
  'saveCustomerGroupColor', 'createWaybillPrefix', 'updateWaybillPrefix', 'createUser',
  'updateUser', 'createEmployee', 'updateEmployee', 'createBillingChargeType',
  'updateBillingChargeType', 'getBillingLines', 'saveBillingLine', 'setBillingLineStatus',
  'setBillingNumber', 'importFreightRates', 'updateFreightRate', 'addFuelPrice',
  'updateFuelPrice', 'deleteFuelPrice', 'clearAllData',
];

// Every server function the gateway can dispatch. Phase 1: spread each
// writers/*.js module here.
const FNS = { ...readers, logout };

/**
 * Single entry point for all authenticated client calls. Throws
 * 'AUTH_REQUIRED' when the session is missing or expired so the client can
 * re-prompt sign-in. No lock: D1 serializes writes, and the writers rely on
 * INTEGER PRIMARY KEY, UNIQUE constraints and batch() instead.
 * @param {string} sessionToken
 * @param {string} fnName
 * @param {Array}  args
 */
export async function rpc(sessionToken, fnName, args) {
  const session = await _resolveSession(sessionToken);
  if (!session) throw new Error('AUTH_REQUIRED');

  if (!RPC_ALLOWED.includes(fnName)) throw new Error('Unknown action: ' + fnName);
  const fn = FNS[fnName];
  if (typeof fn !== 'function') throw new Error('Unknown action: ' + fnName);

  return await runWith({ email: session.email }, () => fn(...(args || [])));
}
