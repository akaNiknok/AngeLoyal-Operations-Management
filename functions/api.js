// ============================================================
//  AngeLoyal OMS — functions/api.js  (a Pages Function, served at /api)
//  The JSON API the frontend talks to, same origin, no CORS.
//  POST { token, fn, args }  ->  { ok: true, data } | { ok: false, error }
//  `fn: 'login'` is the sole pre-session action and carries a Google
//  ID token instead of a session token.
//
//  Never throws: a thrown error would become a 500 with no body the
//  client can read, so failures are reported in the envelope. The
//  client re-prompts sign-in on the exact string 'AUTH_REQUIRED'.
// ============================================================

import { runWith } from '../server/ctx.js';
import { login, rpc } from '../server/auth.js';

const json = (obj) => new Response(JSON.stringify(obj), {
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'BAD_REQUEST' });
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'BAD_REQUEST' });

  try {
    const data = await runWith(
      { db: env.DB, email: null, clientId: env.OAUTH_CLIENT_ID || '' },
      () => (body.fn === 'login' ? login(body.idToken) : rpc(body.token, body.fn, body.args)),
    );
    return json({ ok: true, data });
  } catch (err) {
    return json({ ok: false, error: (err && err.message) || String(err) });
  }
}
