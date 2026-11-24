/**
 * Live checks of every external service using the configured credentials.
 * Reports only pass/fail plus non-secret identifiers (cloud name, key mode, masked IDs). Never returns secrets.
 */
const config = require("../config");
const { q } = require("../db");

const mask = (s, keep = 4) => (!s ? "" : s.length <= keep * 2 ? "•".repeat(s.length) : s.slice(0, keep) + "•".repeat(6) + s.slice(-keep));
const timed = async (fn, ms = 10000) => Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);

async function checkAll() {
  const out = {};

  out.database = await timed(async () => {
    const [[v]] = await require("../db").pool.query("SELECT VERSION() v");
    const [{ n }] = await q("SELECT COUNT(*) n FROM schema_migrations");
    return { ok: true, detail: `MySQL ${v.v}, ${n} migration(s) applied`, vars: ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"] };
  }).catch((e) => ({ ok: false, detail: e.message }));

  out.razorpay = !config.features.razorpay
    ? { ok: false, configured: false, detail: "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set" }
    : await timed(async () => {
      await require("./razorpay").ping(); // authenticated, read-only call
      return { ok: true, configured: true, detail: `Authenticated. Mode: ${config.features.razorpayMode.toUpperCase()}. Key ID ${mask(config.razorpay.keyId, 8)}` };
    }).catch((e) => ({ ok: false, configured: true, detail: "Razorpay rejected the keys: " + ((e.error && e.error.description) || e.message) }));
  out.razorpay_webhook = config.features.razorpayWebhook
    ? { ok: true, configured: true, detail: `Secret is set. Webhook URL: ${config.siteUrl}/api/payments/webhook`, last_event: (await q("SELECT event, processed_at FROM webhook_events ORDER BY processed_at DESC LIMIT 1"))[0] || null }
    : { ok: false, configured: false, detail: "RAZORPAY_WEBHOOK_SECRET is not set" };

  out.cloudinary = !config.features.cloudinary
    ? { ok: false, configured: false, detail: "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not set" }
    : await timed(async () => { const r = await require("./cloudinary").ping(); return { ok: r.ok, configured: true, detail: `Authenticated to cloud "${r.cloud_name}"` }; })
      .catch((e) => ({ ok: false, configured: true, detail: "Cloudinary rejected the credentials: " + ((e.error && e.error.message) || e.message) }));
  if (out.cloudinary.ok) {
    const [{ n }] = await q("SELECT COUNT(*) n FROM images WHERE public_id IS NULL");
    if (n) out.cloudinary.detail += `. ${n} image(s) still served from the server; they move to Cloudinary on next restart.`;
  }

  out.google = !config.features.google
    ? { ok: false, configured: false, detail: "GOOGLE_CLIENT_ID is not set" }
    : {
      ok: /\.apps\.googleusercontent\.com$/.test(config.google.clientId), configured: true,
      detail: config.features.googleRedirect
        ? `Redirect flow enabled. Callback URL must be registered in Google Cloud exactly as: ${config.google.callbackUrl}`
        : "Popup flow only (GOOGLE_CLIENT_SECRET not set). Add the secret to enable the redirect flow.",
      note: "Google can only be fully verified by signing in once. Use the Test button on the login page.",
    };
  if (out.google.configured && !out.google.ok) out.google.detail = "GOOGLE_CLIENT_ID doesn't look like a Web client ID (should end in .apps.googleusercontent.com)";

  out.email = !config.features.email
    ? { ok: false, configured: false, detail: "SMTP_HOST, SMTP_USER and SMTP_PASS are not set" }
    : await (async () => { const r = await require("./mail").verify(); return { ok: r.ok, configured: true, detail: r.ok ? `SMTP login OK (${config.smtp.host}:${config.smtp.port}) as ${config.smtp.user}` : "SMTP login failed: " + r.error }; })();

  out.site = {
    ok: !config.isProd || (config.siteUrl.startsWith("https://") && config.cookieSecure),
    detail: `SITE_URL=${config.siteUrl}, NODE_ENV=${config.isProd ? "production" : "development"}, secure cookies ${config.cookieSecure ? "on" : "off"}`,
  };
  return out;
}

module.exports = { checkAll, mask };
