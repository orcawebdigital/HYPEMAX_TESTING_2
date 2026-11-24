// HYPEMAX Nutrition: entry point (Hostinger Node.js app "startup file").
const config = require("./src/config");
const { createApp } = require("./src/app");
const { migrate } = require("./src/migrate");
const { seed } = require("./src/seed");
const { q } = require("./src/db");
const orders = require("./src/services/orders");

async function start() {
  await migrate();
  await seed();
  // Seed photos ship with the code for local development; once Cloudinary is configured they are moved there
  // automatically so no permanent image is served from Hostinger's disk.
  if (config.features.cloudinary) await require("./src/seed").uploadSeedImages({ log: (m) => console.log("[images]", m) }).catch((e) => console.error("[images] migration to Cloudinary failed:", e.message));
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`HYPEMAX Nutrition running on ${config.siteUrl} (port ${config.port})`);
    const missing = Object.entries(config.features).filter(([k, v]) => !v && k !== "razorpayMode").map(([k]) => k);
    if (missing.length) console.log("Integrations not configured yet:", missing.join(", "));
  });
  // Slow-client (Slowloris-style) protection: cap how long headers/bodies may take; keep-alive just above
  // typical proxy idle timeouts so the proxy closes first.
  server.headersTimeout = 20e3;
  server.requestTimeout = 30e3;
  server.keepAliveTimeout = 65e3;
  server.maxHeadersCount = 100;


  // Background jobs (single process): expire unpaid orders, clean up old sessions/tokens.
  setInterval(() => orders.expireStaleOrders().catch((e) => console.error("expire job", e.message)), 5 * 60e3).unref();
  setInterval(async () => {
    try {
      await q("DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()");
      await q("DELETE FROM user_tokens WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY");
      await q("DELETE FROM login_attempts WHERE created_at < UTC_TIMESTAMP() - INTERVAL 30 DAY");
      await q("DELETE FROM carts WHERE user_id IS NULL AND updated_at < UTC_TIMESTAMP() - INTERVAL 60 DAY");
    } catch (e) { console.error("cleanup job", e.message); }
  }, 6 * 3600e3).unref();
}

start().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
