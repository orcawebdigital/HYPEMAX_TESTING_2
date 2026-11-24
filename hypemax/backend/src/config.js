// All configuration comes from environment variables (Hostinger hPanel, or backend/.env locally).
// Secrets are only ever read here; nothing in this file is sent to the browser.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const isProd = env("NODE_ENV", "development") === "production";
const siteUrl = env("SITE_URL", "http://localhost:4000").replace(/\/$/, "");

/**
 * Origins allowed to make state-changing API calls. SITE_URL is always allowed, plus its www/apex twin
 * (https://hypemax.in <-> https://www.hypemax.in) and anything in ALLOWED_ORIGINS (comma-separated, e.g. a
 * Vercel domain that proxies /api to this server). Root cause of BUG-008 and the account-switching bug: a
 * browser on the "other" host had every POST, including logout, rejected with 403 and the UI ignored it.
 */
function buildAllowedOrigins() {
  const set = new Set();
  const add = (u) => { try { set.add(new URL(u).origin); } catch { /* ignore malformed entries */ } };
  add(siteUrl);
  try {
    const u = new URL(siteUrl);
    if (!/^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(u.hostname)) {
      const twin = u.hostname.startsWith("www.") ? u.hostname.slice(4) : "www." + u.hostname;
      add(`${u.protocol}//${twin}${u.port ? ":" + u.port : ""}`);
    }
  } catch { /* invalid SITE_URL is reported by the integrations check */ }
  String(env("ALLOWED_ORIGINS", "")).split(",").map((s) => s.trim()).filter(Boolean).forEach(add);
  return [...set];
}

const config = {
  isProd,
  port: +env("PORT", 4000),
  siteUrl,
  allowedOrigins: buildAllowedOrigins(),
  db: {
    host: env("DB_HOST", "127.0.0.1"),
    port: +env("DB_PORT", 3306),
    user: env("DB_USER", "root"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_NAME", "hypemax"),
    ssl: env("DB_SSL", "false") === "true" ? { rejectUnauthorized: true } : undefined,
    connectionLimit: +env("DB_POOL", 10),
  },
  sessionDays: +env("SESSION_DAYS", 14),
  adminSessionHours: +env("ADMIN_SESSION_HOURS", 12),
  cookieSecure: env("COOKIE_SECURE", isProd ? "true" : "false") === "true",
  razorpay: {
    keyId: env("RAZORPAY_KEY_ID", ""),
    keySecret: env("RAZORPAY_KEY_SECRET", ""),
    webhookSecret: env("RAZORPAY_WEBHOOK_SECRET", ""),
  },
  // Either the three separate values or a single CLOUDINARY_URL (cloudinary://KEY:SECRET@CLOUD) may be used.
  cloudinary: {
    cloudName: env("CLOUDINARY_CLOUD_NAME", ""),
    apiKey: env("CLOUDINARY_API_KEY", ""),
    apiSecret: env("CLOUDINARY_API_SECRET", ""),
    url: env("CLOUDINARY_URL", ""),
  },
  cloudinaryFolder: env("CLOUDINARY_FOLDER", "hypemax"),
  google: {
    clientId: env("GOOGLE_CLIENT_ID", ""),
    clientSecret: env("GOOGLE_CLIENT_SECRET", ""),
    callbackUrl: env("GOOGLE_CALLBACK_URL", siteUrl + "/api/auth/google/callback"),
  },
  smtp: {
    host: env("SMTP_HOST", ""),
    port: +env("SMTP_PORT", 465),
    secure: env("SMTP_SECURE", String(+env("SMTP_PORT", 465) === 465)) === "true",
    user: env("SMTP_USER", ""),
    pass: env("SMTP_PASS", ""),
    from: env("EMAIL_FROM", env("MAIL_FROM", "")),
  },
  // Where "new order / new message" alerts go (comma-separated). Falls back to the store email in Site settings.
  adminNotifyEmail: env("ADMIN_NOTIFY_EMAIL", ""),
  requireEmailVerification: env("REQUIRE_EMAIL_VERIFICATION", "false") === "true",
  // HYPEMAX SSO (OpenID Connect provider for HYPEMAX-owned apps). See docs/SSO.md.
  sso: {
    issuer: env("SSO_ISSUER", siteUrl),
    // JSON array: [{"client_id":"...","name":"...","redirect_uris":["https://app/callback"],"post_logout_redirect_uris":["https://app/"],"client_secret_hash":"<sha256 hex, omit for public PKCE clients>"}]
    clients: (() => { try { return JSON.parse(env("SSO_CLIENTS", "[]")); } catch { console.error("SSO_CLIENTS is not valid JSON; SSO clients disabled"); return []; } })(),
    privateKeyPem: env("SSO_PRIVATE_KEY", "").replace(/\\n/g, "\n"), // allow a one-line PEM with literal \n
    accessTokenMinutes: +env("SSO_ACCESS_TOKEN_MINUTES", 15),
    refreshTokenDays: +env("SSO_REFRESH_TOKEN_DAYS", 30),
  },
  orderReservationMinutes: +env("ORDER_RESERVATION_MINUTES", 30),
  bootstrapAdmin: {
    email: env("ADMIN_EMAIL", ""),
    password: env("ADMIN_PASSWORD", ""),
    name: env("ADMIN_NAME", "Super Admin"),
  },
};
config.googleClientId = config.google.clientId; // backwards compatible alias
const c = config.cloudinary;

config.features = {
  razorpay: !!(config.razorpay.keyId && config.razorpay.keySecret),
  razorpayWebhook: !!config.razorpay.webhookSecret,
  razorpayMode: /^rzp_live_/.test(config.razorpay.keyId) ? "live" : config.razorpay.keyId ? "test" : null,
  cloudinary: !!(c.url || (c.cloudName && c.apiKey && c.apiSecret)),
  google: !!config.google.clientId,
  googleRedirect: !!(config.google.clientId && config.google.clientSecret),
  email: !!(config.smtp.host && config.smtp.user && config.smtp.pass),
};

module.exports = config;
