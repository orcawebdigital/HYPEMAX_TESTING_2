const helmet = require("helmet");
const config = require("./config");
const { randomToken, safeEqual, HttpError } = require("./util");
const { q, one } = require("./db");

/** Helmet with a CSP that allows Razorpay Checkout, Google Sign-In, Cloudinary and Google Fonts. */
const helmetHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://checkout.razorpay.com", "https://accounts.google.com/gsi/client"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com/gsi/style"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:", "https://res.cloudinary.com", "https://*.razorpay.com", "https://lh3.googleusercontent.com"],
      "connect-src": ["'self'", "https://*.razorpay.com", "https://accounts.google.com/gsi/"],
      "frame-src": ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com", "https://accounts.google.com"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'self'"],
      "upgrade-insecure-requests": config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }, // Razorpay/Google need the origin
  hsts: config.isProd ? undefined : false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
});
/** Helmet + Permissions-Policy (helmet doesn't set it). Payment stays allowed for Razorpay's iframe. */
function securityHeaders(req, res, next) {
  res.set("Permissions-Policy", 'camera=(), microphone=(), geolocation=(), usb=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com")');
  helmetHeaders(req, res, next);
}

/**
 * CSRF: double-submit cookie. A random token is set in a readable cookie; every
 * state-changing /api request must echo it in the X-CSRF-Token header. Combined with
 * SameSite=Lax session cookies and an Origin check.
 */
const CSRF_COOKIE = "hm_csrf";
const originAllowed = (o) => config.allowedOrigins.includes(o) || (!config.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
function csrf(req, res, next) {
  let t = req.cookies[CSRF_COOKIE];
  if (!t || !/^[a-f0-9]{48}$/.test(t)) {
    t = randomToken(24);
    res.cookie(CSRF_COOKIE, t, { httpOnly: false, secure: config.cookieSecure, sameSite: "strict", path: "/" });
    req.cookies[CSRF_COOKIE] = t;
  }
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/payments/webhook") return next(); // verified by HMAC signature instead
  // Logout must always work: it only removes access. Session cookies are SameSite=Lax, so a cross-site page
  // cannot attach them to a POST, which means exempting logout cannot be used to act as the user.
  if (req.path === "/api/auth/logout") return next();
  const origin = req.get("origin");
  if (origin && !originAllowed(origin)) return next(new HttpError(403, "Cross-site request blocked", "CSRF"));
  const h = req.get("x-csrf-token");
  if (!h || !safeEqual(h, t)) return next(new HttpError(403, "Security token missing or expired. Refresh the page and try again.", "CSRF"));
  next();
}

/** Simple in-memory sliding-window limiter (single Node process on Hostinger). */
const buckets = new Map();
function rateLimit({ windowMs, max, key = (req) => req.ip, message = "Too many requests. Please slow down." }) {
  return (req, res, next) => {
    if (module.exports.bypassRateLimits) return next(); // set only by the automated test harness
    const k = (req.route ? req.route.path : req.path) + "|" + key(req);
    const now = Date.now();
    const arr = (buckets.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set("Retry-After", Math.ceil(windowMs / 1000));
      return next(new HttpError(429, message, "RATE_LIMIT"));
    }
    arr.push(now);
    buckets.set(k, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3600e3) buckets.delete(k);
}, 600e3).unref();

/**
 * Brute-force protection on top of IP rate limits: per-account lockout
 * (5 failures -> 15 minutes) plus a per-IP failure ceiling recorded in MySQL.
 */
const MAX_FAILS = 5, LOCK_MIN = 15;
async function checkLoginAllowed(scope, ip, account) {
  const r = await one(`SELECT COUNT(*) n FROM login_attempts WHERE scope=? AND ip=? AND success=0 AND created_at > UTC_TIMESTAMP() - INTERVAL 15 MINUTE`, [scope, ip]);
  if (r.n >= 20) throw new HttpError(429, "Too many failed attempts from your network. Try again in 15 minutes.", "RATE_LIMIT");
  if (account && account.locked_until && new Date(account.locked_until) > new Date())
    throw new HttpError(429, `Account temporarily locked after repeated failed logins. Try again in ${LOCK_MIN} minutes.`, "LOCKED");
}
async function recordLogin(scope, table, ip, identifier, account, success) {
  await q("INSERT INTO login_attempts (scope, ip, identifier, success) VALUES (?,?,?,?)", [scope, ip, identifier, success ? 1 : 0]);
  if (!account) return;
  if (success) await q(`UPDATE ${table} SET failed_logins=0, locked_until=NULL, last_login_at=UTC_TIMESTAMP() WHERE id=?`, [account.id]);
  else await q(`UPDATE ${table} SET locked_until=IF(failed_logins+1>=?, UTC_TIMESTAMP() + INTERVAL ? MINUTE, locked_until), failed_logins=failed_logins+1 WHERE id=?`, [MAX_FAILS, LOCK_MIN, account.id]);
}

module.exports = { securityHeaders, csrf, rateLimit, originAllowed, checkLoginAllowed, recordLogin };
