/**
 * HYPEMAX SSO: a minimal OpenID Connect provider for HYPEMAX-owned applications.
 *
 * The storefront (this app) is the identity provider. Customers sign in here once, with email/password or
 * Google (Google is just one *upstream* login method); other HYPEMAX apps (e.g. app.hypemax.in, a mobile
 * app, a partner portal) then sign in through this server without asking again.
 *
 *  - Authorization Code flow with PKCE (S256), required for every client, public or confidential.
 *  - ID tokens and access tokens are RS256 JWTs; keys published at /oauth/jwks. Clients validate
 *    iss, aud, signature, exp and nonce.
 *  - Refresh tokens are opaque, single-use and rotated. Presenting a used one revokes the whole family
 *    (stolen-token reuse detection). They are bound to the HYPEMAX browser session that issued them, so a
 *    central logout immediately stops every connected app from refreshing.
 *  - Clients are first-party only and configured in SSO_CLIENTS (no dynamic registration, no consent screen).
 *
 * Full documentation: docs/SSO.md.
 */
const crypto = require("crypto");
const router = require("express").Router();
const config = require("./config");
const { q, one, tx } = require("./db");
const { wrap, randomToken, sha256, safeEqual, HttpError } = require("./util");
const { rateLimit } = require("./security");
const { COOKIE, destroySession } = require("./auth");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const SCOPES = ["openid", "email", "profile", "offline_access"];
const CODE_SECONDS = 60;

// ---------- clients ----------
function getClient(id) {
  const c = config.sso.clients.find((x) => x && x.client_id === id);
  if (!c || !Array.isArray(c.redirect_uris)) return null;
  return c;
}
/** Confidential clients prove themselves with client_secret (we store only its SHA-256). Public clients rely on PKCE. */
function authenticateClient(req) {
  let id = req.body.client_id, secret = req.body.client_secret;
  const h = req.get("authorization");
  if (h && /^Basic /i.test(h)) {
    const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
    id = decodeURIComponent(u || ""); secret = decodeURIComponent(p || "");
  }
  const c = getClient(String(id || ""));
  if (!c) throw oauthErr(401, "invalid_client", "Unknown client");
  if (c.client_secret_hash) {
    if (!secret || !safeEqual(sha256(secret), String(c.client_secret_hash).toLowerCase())) throw oauthErr(401, "invalid_client", "Client authentication failed");
  }
  return c;
}
const oauthErr = (status, error, description) => Object.assign(new HttpError(status, description, error), { oauth: true });

// ---------- signing keys ----------
let keyCache = null;
async function signingKey() {
  if (keyCache) return keyCache;
  let pem = config.sso.privateKeyPem;
  if (!pem) {
    // No key configured: generate one once and keep it in the database so tokens survive restarts.
    const row = await one("SELECT kid, private_pem FROM sso_keys ORDER BY created_at DESC LIMIT 1");
    if (row) pem = row.private_pem;
    else {
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      pem = privateKey.export({ type: "pkcs8", format: "pem" });
      if (config.isProd) console.warn("[sso] SSO_PRIVATE_KEY not set; generated a signing key and stored it in the database.");
      await q("INSERT INTO sso_keys (kid, private_pem) VALUES (?,?)", [kidOf(pem), pem]);
    }
  }
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  keyCache = { privateKey, kid: kidOf(pem), jwk };
  return keyCache;
}
function kidOf(pem) {
  const jwk = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ format: "jwk" });
  return sha256(jwk.n).slice(0, 16);
}
async function signJwt(payload, typ = "JWT") {
  const { privateKey, kid } = await signingKey();
  const head = b64url(JSON.stringify({ alg: "RS256", typ, kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}
/** Verify one of our own JWTs (signature, issuer, expiry; audience if given). Returns the payload or null. */
async function verifyJwt(token, { audience, allowExpired = false } = {}) {
  try {
    const [h, p, s] = String(token).split(".");
    const head = JSON.parse(Buffer.from(h, "base64url").toString());
    if (head.alg !== "RS256") return null;
    const { privateKey } = await signingKey();
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), crypto.createPublicKey(privateKey), Buffer.from(s, "base64url"));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    if (payload.iss !== config.sso.issuer) return null;
    if (!allowExpired && !(payload.exp > Date.now() / 1000)) return null;
    if (audience && payload.aud !== audience) return null;
    return payload;
  } catch { return null; }
}

// ---------- discovery ----------
router.get("/.well-known/openid-configuration", (req, res) => {
  const i = config.sso.issuer;
  res.set("Cache-Control", "public, max-age=3600").json({
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    userinfo_endpoint: `${i}/oauth/userinfo`,
    jwks_uri: `${i}/oauth/jwks`,
    revocation_endpoint: `${i}/oauth/revoke`,
    end_session_endpoint: `${i}/oauth/logout`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: SCOPES,
    claims_supported: ["sub", "email", "email_verified", "name", "auth_time", "nonce", "sid"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  });
});
router.get("/oauth/jwks", wrap(async (req, res) => {
  const { jwk, kid } = await signingKey();
  res.set("Cache-Control", "public, max-age=3600").json({ keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" }] });
}));

// ---------- authorize ----------
const authorizeLimit = rateLimit({ windowMs: 60e3, max: 60 });
router.get("/oauth/authorize", authorizeLimit, wrap(async (req, res) => {
  const p = req.query;
  const client = getClient(String(p.client_id || ""));
  const redirectUri = String(p.redirect_uri || "");
  // Until client and redirect_uri are proven valid we must NOT redirect anywhere (open-redirect protection).
  if (!client) return res.status(400).type("text/plain").send("Unknown client_id");
  if (!client.redirect_uris.includes(redirectUri)) return res.status(400).type("text/plain").send("redirect_uri is not registered for this client");
  const back = (params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, state: p.state, iss: config.sso.issuer })) if (v != null && v !== "") u.searchParams.set(k, String(v));
    res.redirect(u.toString());
  };
  if (p.response_type !== "code") return back({ error: "unsupported_response_type" });
  const scopes = String(p.scope || "").split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid") || scopes.some((s) => !SCOPES.includes(s))) return back({ error: "invalid_scope", error_description: "scope must include openid" });
  if (!p.state || String(p.state).length > 500) return back({ error: "invalid_request", error_description: "state is required" });
  if (!p.code_challenge || p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(String(p.code_challenge)))
    return back({ error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required" });
  if (p.nonce && String(p.nonce).length > 255) return back({ error: "invalid_request", error_description: "nonce too long" });

  const sessionToken = req.cookies[COOKIE.user];
  if (!req.user || !sessionToken) {
    if (p.prompt === "none") return back({ error: "login_required" });
    // Sign in on HYPEMAX (password or Google), then come straight back here.
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  }
  if (p.prompt === "login" || p.prompt === "select_account") {
    // Let the customer confirm or switch account. The login page offers "Continue as X" / "Use another account".
    if (!req.query._confirmed) return res.redirect("/login?switch=1&next=" + encodeURIComponent(req.originalUrl.replace(/([?&])prompt=[^&]*/, "$1") + "&_confirmed=1"));
  }
  const sess = await one("SELECT created_at FROM sessions WHERE id=?", [sha256(sessionToken)]);
  const code = randomToken(32);
  await q(`INSERT INTO sso_codes (code_hash, client_id, user_id, session_hash, redirect_uri, code_challenge, nonce, scope, auth_time, expires_at, family_id)
           VALUES (?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP() + INTERVAL ${CODE_SECONDS} SECOND, ?)`,
  [sha256(code), client.client_id, req.user.id, sha256(sessionToken), redirectUri, String(p.code_challenge), p.nonce ? String(p.nonce) : null,
    scopes.join(" "), sess ? sess.created_at : new Date(), randomToken(16)]);
  back({ code });
}));

// ---------- token ----------
async function issueTokens(conn, { client, userId, sessionHash, scope, authTime, nonce, familyId }) {
  const u = await one("SELECT id, name, email, email_verified_at, is_active FROM users WHERE id=?", [userId], conn);
  if (!u || !u.is_active) throw oauthErr(400, "invalid_grant", "Account is disabled");
  const now = Math.floor(Date.now() / 1000);
  const sub = String(u.id);
  const sid = sessionHash.slice(0, 32); // opaque session id, never the cookie value
  const scopes = scope.split(" ");
  const idToken = await signJwt({
    iss: config.sso.issuer, sub, aud: client.client_id, iat: now, exp: now + 3600, auth_time: Math.floor(new Date(authTime).getTime() / 1000), sid,
    ...(nonce ? { nonce } : {}),
    ...(scopes.includes("email") ? { email: u.email, email_verified: !!u.email_verified_at } : {}),
    ...(scopes.includes("profile") ? { name: u.name } : {}),
  });
  const accessToken = await signJwt({
    iss: config.sso.issuer, sub, aud: client.client_id, client_id: client.client_id, iat: now, exp: now + config.sso.accessTokenMinutes * 60,
    scope, sid, jti: randomToken(12),
  }, "at+jwt");
  const out = { token_type: "Bearer", access_token: accessToken, expires_in: config.sso.accessTokenMinutes * 60, id_token: idToken, scope };
  if (scopes.includes("offline_access") || client.refresh_tokens !== false) {
    const rt = randomToken(32);
    await q(`INSERT INTO sso_refresh_tokens (token_hash, family_id, client_id, user_id, session_hash, scope, auth_time, expires_at)
             VALUES (?,?,?,?,?,?,?, UTC_TIMESTAMP() + INTERVAL ? DAY)`,
    [sha256(rt), familyId, client.client_id, userId, sessionHash, scope, new Date(authTime), config.sso.refreshTokenDays], conn);
    out.refresh_token = rt;
  }
  return out;
}

/** Revocations triggered by a failed grant must survive the rollback of that grant's transaction. */
const revokeAfterFailure = async (e) => {
  if (e && e.revokeFamily) await q("UPDATE sso_refresh_tokens SET revoked_at=COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE family_id=?", [e.revokeFamily]);
  throw e;
};
router.post("/oauth/token", rateLimit({ windowMs: 60e3, max: 60 }), wrap(async (req, res) => {
  res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
  req.body = req.body || {};
  const client = authenticateClient(req);
  const grant = req.body.grant_type;

  if (grant === "authorization_code") {
    const out = await tx(async (conn) => {
      const [c] = await q("SELECT * FROM sso_codes WHERE code_hash=? FOR UPDATE", [sha256(String(req.body.code || ""))], conn);
      if (!c || c.client_id !== client.client_id) throw oauthErr(400, "invalid_grant", "Invalid authorization code");
      if (c.used_at) {
        // Code replay: someone intercepted it. Kill everything issued from it (after this transaction rolls back).
        throw Object.assign(oauthErr(400, "invalid_grant", "Authorization code already used"), { revokeFamily: c.family_id });
      }
      if (new Date(c.expires_at) < new Date()) throw oauthErr(400, "invalid_grant", "Authorization code expired");
      if (String(req.body.redirect_uri || "") !== c.redirect_uri) throw oauthErr(400, "invalid_grant", "redirect_uri mismatch");
      const verifier = String(req.body.code_verifier || "");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(b64url(crypto.createHash("sha256").update(verifier).digest()), c.code_challenge))
        throw oauthErr(400, "invalid_grant", "PKCE verification failed");
      await q("UPDATE sso_codes SET used_at=UTC_TIMESTAMP() WHERE code_hash=?", [c.code_hash], conn);
      // The HYPEMAX session that approved this must still be alive (customer may have logged out in between).
      const [s] = await q("SELECT id FROM sessions WHERE id=? AND kind='user' AND expires_at > UTC_TIMESTAMP()", [c.session_hash], conn);
      if (!s) throw oauthErr(400, "invalid_grant", "Session has ended");
      return issueTokens(conn, { client, userId: c.user_id, sessionHash: c.session_hash, scope: c.scope, authTime: c.auth_time, nonce: c.nonce, familyId: c.family_id });
    }).catch(revokeAfterFailure);
    return res.json(out);
  }

  if (grant === "refresh_token") {
    const out = await tx(async (conn) => {
      const [t] = await q("SELECT * FROM sso_refresh_tokens WHERE token_hash=? FOR UPDATE", [sha256(String(req.body.refresh_token || ""))], conn);
      if (!t || t.client_id !== client.client_id) throw oauthErr(400, "invalid_grant", "Invalid refresh token");
      if (t.rotated_at || t.revoked_at) {
        // Reuse of a rotated token = likely theft. Revoke the whole family (attacker and victim must sign in again).
        throw Object.assign(oauthErr(400, "invalid_grant", "Refresh token is no longer valid"), { revokeFamily: t.family_id });
      }
      if (new Date(t.expires_at) < new Date()) throw oauthErr(400, "invalid_grant", "Refresh token expired");
      const [s] = await q("SELECT id FROM sessions WHERE id=? AND kind='user' AND expires_at > UTC_TIMESTAMP()", [t.session_hash], conn);
      if (!s) throw Object.assign(oauthErr(400, "invalid_grant", "Signed out of HYPEMAX"), { revokeFamily: t.family_id });
      await q("UPDATE sso_refresh_tokens SET rotated_at=UTC_TIMESTAMP() WHERE id=?", [t.id], conn);
      return issueTokens(conn, { client, userId: t.user_id, sessionHash: t.session_hash, scope: t.scope, authTime: t.auth_time, nonce: null, familyId: t.family_id });
    }).catch(revokeAfterFailure);
    return res.json(out);
  }
  throw oauthErr(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}));

// ---------- userinfo ----------
router.all("/oauth/userinfo", rateLimit({ windowMs: 60e3, max: 120 }), wrap(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const m = /^Bearer (.+)$/i.exec(req.get("authorization") || "");
  const at = m && (await verifyJwt(m[1]));
  if (!at || !at.client_id) return res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
  // Access tokens die with the HYPEMAX session they came from.
  const live = await one("SELECT 1 x FROM sso_refresh_tokens WHERE client_id=? AND user_id=? AND LEFT(session_hash,32)=? AND revoked_at IS NULL LIMIT 1", [at.client_id, +at.sub, at.sid]);
  const sess = await one("SELECT 1 x FROM sessions WHERE LEFT(id,32)=? AND kind='user' AND expires_at > UTC_TIMESTAMP()", [at.sid]);
  if (!live || !sess) return res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
  const u = await one("SELECT id, name, email, email_verified_at FROM users WHERE id=? AND is_active=1", [+at.sub]);
  if (!u) return res.status(401).json({ error: "invalid_token" });
  const scopes = String(at.scope || "").split(" ");
  res.json({ sub: String(u.id), ...(scopes.includes("email") ? { email: u.email, email_verified: !!u.email_verified_at } : {}), ...(scopes.includes("profile") ? { name: u.name } : {}) });
}));

// ---------- revocation (RFC 7009) ----------
router.post("/oauth/revoke", rateLimit({ windowMs: 60e3, max: 60 }), wrap(async (req, res) => {
  req.body = req.body || {};
  const client = authenticateClient(req);
  const t = await one("SELECT family_id FROM sso_refresh_tokens WHERE token_hash=? AND client_id=?", [sha256(String(req.body.token || "")), client.client_id]);
  if (t) await q("UPDATE sso_refresh_tokens SET revoked_at=COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE family_id=?", [t.family_id]);
  res.json({}); // always 200, per spec
}));

// ---------- RP-initiated logout (central logout) ----------
router.get("/oauth/logout", rateLimit({ windowMs: 60e3, max: 30 }), wrap(async (req, res) => {
  const hint = req.query.id_token_hint && (await verifyJwt(String(req.query.id_token_hint), { allowExpired: true }));
  const client = hint ? getClient(hint.aud) : getClient(String(req.query.client_id || ""));
  const target = String(req.query.post_logout_redirect_uri || "");
  const okTarget = client && Array.isArray(client.post_logout_redirect_uris) && client.post_logout_redirect_uris.includes(target);
  const t = req.cookies[COOKIE.user];
  // Only log out when the request is provably from a connected app for *this* browser's session
  // (a signed id_token_hint whose sid matches), so a third-party link can't sign customers out.
  if (t && hint && hint.sid === sha256(t).slice(0, 32)) {
    await revokeForSession(sha256(t));
    await destroySession(req, res, "user");
    res.set("Clear-Site-Data", '"cache"');
  } else if (t && !hint) {
    return res.redirect("/account"); // no proof: don't log out
  }
  if (okTarget) {
    const u = new URL(target);
    if (req.query.state) u.searchParams.set("state", String(req.query.state));
    return res.redirect(u.toString());
  }
  res.redirect("/login?logged_out=1");
}));

/** Called by /api/auth/logout: every connected app's grants from this browser session end with it. */
async function revokeForSession(sessionHash) {
  await q("UPDATE sso_refresh_tokens SET revoked_at=UTC_TIMESTAMP() WHERE session_hash=? AND revoked_at IS NULL", [sessionHash]);
}

// OAuth errors use the RFC 6749 JSON shape.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (!err.oauth) return next(err);
  res.status(err.status).json({ error: err.code, error_description: err.message });
});

module.exports = { router, revokeForSession, verifyJwt, signingKey };
