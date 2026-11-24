const bcrypt = require("bcryptjs");
const config = require("./config");
const { q, one } = require("./db");
const { randomToken, sha256, HttpError, forbidden } = require("./util");

const COOKIE = { user: "hm_sid", admin: "hm_asid" };
const BCRYPT_ROUNDS = 12;

const hashPassword = (p) => bcrypt.hash(p, BCRYPT_ROUNDS);
// Compare against a dummy hash when the account does not exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser-not-a-password", BCRYPT_ROUNDS);
const checkPassword = async (p, h) => {
  const ok = await bcrypt.compare(String(p || ""), h || DUMMY_HASH);
  return !!h && ok;
};

const cookieOpts = (maxAgeMs) => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: "lax",
  path: "/",
  maxAge: maxAgeMs,
});

async function createSession(res, req, kind, subjectId) {
  // Rotate: whatever session this browser had before (another account, or a planted token) is ended first,
  // so signing in as B can never leave A's session alive behind the new cookie.
  const old = req.cookies[COOKIE[kind]];
  if (old) await q("DELETE FROM sessions WHERE id = ?", [sha256(old)]);
  const token = randomToken(32);
  req.cookies[COOKIE[kind]] = token;
  const hours = kind === "admin" ? config.adminSessionHours : config.sessionDays * 24;
  const expires = new Date(Date.now() + hours * 3600e3);
  await q(
    "INSERT INTO sessions (id, kind, subject_id, csrf_token, ip, user_agent, expires_at) VALUES (?,?,?,?,?,?,?)",
    [sha256(token), kind, subjectId, randomToken(32), req.ip, String(req.get("user-agent") || "").slice(0, 255), expires]
  );
  res.cookie(COOKIE[kind], token, cookieOpts(hours * 3600e3));
}

async function destroySession(req, res, kind) {
  const t = req.cookies[COOKIE[kind]];
  if (t) await q("DELETE FROM sessions WHERE id = ?", [sha256(t)]);
  res.clearCookie(COOKIE[kind], { path: "/" });
}

async function destroyAllSessions(kind, subjectId, exceptToken) {
  if (exceptToken) await q("DELETE FROM sessions WHERE kind=? AND subject_id=? AND id<>?", [kind, subjectId, sha256(exceptToken)]);
  else await q("DELETE FROM sessions WHERE kind=? AND subject_id=?", [kind, subjectId]);
}

/** Attach req.user and req.admin (if valid sessions exist). */
async function loadSessions(req, res, next) {
  try {
    const ut = req.cookies[COOKIE.user];
    if (ut) {
      const u = await one(
        `SELECT u.id, u.name, u.email, u.phone, u.email_verified_at, u.google_sub, (u.password_hash IS NOT NULL) AS has_password
         FROM sessions s JOIN users u ON u.id = s.subject_id
         WHERE s.id = ? AND s.kind = 'user' AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = 1`, [sha256(ut)]);
      if (u) req.user = u; else res.clearCookie(COOKIE.user, { path: "/" });
    }
    const at = req.cookies[COOKIE.admin];
    if (at && req.path.startsWith("/api/admin")) {
      const a = await one(
        `SELECT a.id, a.name, a.email, a.role_id, r.slug AS role, r.name AS role_name
         FROM sessions s JOIN admins a ON a.id = s.subject_id JOIN roles r ON r.id = a.role_id
         WHERE s.id = ? AND s.kind = 'admin' AND s.expires_at > UTC_TIMESTAMP() AND a.is_active = 1`, [sha256(at)]);
      if (a) {
        const perms = await q(
          "SELECT p.slug FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?", [a.role_id]);
        a.permissions = perms.map((p) => p.slug);
        req.admin = a;
      } else res.clearCookie(COOKIE.admin, { path: "/" });
    }
    next();
  } catch (e) { next(e); }
}

const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, "Please log in to continue", "AUTH_REQUIRED")));
const requireAdmin = (req, res, next) => (req.admin ? next() : next(new HttpError(401, "Admin login required", "ADMIN_AUTH_REQUIRED")));
/** Require one of the given permissions (super_admin always passes). */
const can = (...perms) => (req, res, next) => {
  if (!req.admin) return next(new HttpError(401, "Admin login required", "ADMIN_AUTH_REQUIRED"));
  if (req.admin.role === "super_admin" || perms.some((p) => req.admin.permissions.includes(p))) return next();
  next(forbidden());
};

async function audit(req, action, entityType, entityId, details) {
  try {
    await q("INSERT INTO admin_audit_logs (admin_id, action, entity_type, entity_id, details, ip) VALUES (?,?,?,?,?,?)",
      [req.admin ? req.admin.id : null, action, entityType || null, entityId != null ? String(entityId) : null,
        details ? JSON.stringify(details) : null, req.ip]);
  } catch (e) { console.error("audit log failed", e.message); }
}

module.exports = {
  COOKIE, hashPassword, checkPassword, createSession, destroySession, destroyAllSessions,
  loadSessions, requireUser, requireAdmin, can, audit,
};
