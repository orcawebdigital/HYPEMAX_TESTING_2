// Test harness: isolated MySQL database, real Express app, fake Razorpay API (network only; signatures are real HMACs).
process.env.DB_NAME = process.env.TEST_DB_NAME || "hypemax_test";
process.env.NODE_ENV = "test";
process.env.SITE_URL = "http://localhost";
process.env.RAZORPAY_KEY_ID = "rzp_test_dummy";
process.env.RAZORPAY_KEY_SECRET = "test_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
process.env.ADMIN_EMAIL = "root@test.local";
process.env.ADMIN_PASSWORD = "RootPass123";
process.env.CLOUDINARY_URL = "";
// Fake placeholder credentials so every integration code path is "configured". The network clients are replaced
// by in-memory fakes below, so these values never leave the process.
process.env.CLOUDINARY_CLOUD_NAME = "testcloud";
process.env.CLOUDINARY_API_KEY = "test_cloud_key";
process.env.CLOUDINARY_API_SECRET = "test_cloud_secret";
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test_google_secret";
process.env.SMTP_HOST = "smtp.test.local";
process.env.SMTP_USER = "mailer@test.local";
process.env.SMTP_PASS = "test_smtp_pass";
process.env.EMAIL_FROM = "HYPEMAX Nutrition <mailer@test.local>";
process.env.ADMIN_NOTIFY_EMAIL = "ops@test.local";
const SECRETS = ["test_key_secret", "test_webhook_secret", "test_cloud_secret", "test_google_secret", "test_smtp_pass"];

const crypto = require("crypto");
const { pool, q } = require("../src/db");
const { migrate } = require("../src/migrate");
const { seed } = require("../src/seed");
const { createApp } = require("../src/app");
const rzp = require("../src/services/razorpay");

// ---- fake Razorpay API ----
const fake = { orders: new Map(), payments: new Map(), refunds: [] };
let seq = 0;
rzp._setTestClient({
  orders: {
    create: async (o) => { const id = "order_T" + ++seq; fake.orders.set(id, { id, ...o }); return { id, amount: o.amount, currency: o.currency }; },
    fetchPayments: async (oid) => ({ items: [...fake.payments.values()].filter((p) => p.order_id === oid) }),
    all: async () => ({ items: [...fake.orders.values()].slice(0, 1) }),
  },
  payments: {
    fetch: async (id) => { const p = fake.payments.get(id); if (!p) throw { error: { description: "not found" } }; return p; },
    capture: async (id) => { const p = fake.payments.get(id); p.status = "captured"; return p; },
    refund: async (id, { amount }) => { const r = { id: "rfnd_T" + ++seq, payment_id: id, amount, status: "processed" }; fake.refunds.push(r); return r; },
  },
});
/** Simulate the customer paying in the Razorpay popup. */
function pay(orderId, { amount, status = "captured" } = {}) {
  const o = fake.orders.get(orderId);
  const id = "pay_T" + ++seq;
  const p = { id, order_id: orderId, amount: amount ?? o.amount, currency: "INR", status, method: "upi" };
  fake.payments.set(id, p);
  const signature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${id}`).digest("hex");
  return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: signature, payment: p };
}
// ---- fake Razorpay ping for the integrations check ----
// (orders.all is added to the same fake client)

// ---- fake Cloudinary ----
const cloudLog = []; // ordered log of operations, to verify "upload new before deleting old"
let cseq = 0;
const cloudResult = () => { const id = "hypemax/test/img" + ++cseq; return { public_id: id, secure_url: `https://res.cloudinary.com/testcloud/image/upload/v1/${id}.jpg`, width: 800, height: 600 }; };
require("../src/services/cloudinary")._setTestClient({
  uploader: {
    upload_stream: (opts, cb) => ({ end: (buf) => { const r = cloudResult(); cloudLog.push(["upload", r.public_id]); cb(null, r); } }),
    upload: async () => { const r = cloudResult(); cloudLog.push(["upload", r.public_id]); return r; },
    destroy: async (pid) => { cloudLog.push(["destroy", pid]); return { result: "ok" }; },
  },
  api: { ping: async () => ({ status: "ok" }) },
  config: () => ({ cloud_name: "testcloud" }),
});

// ---- capturing mail transport ----
const outbox = [];
require("../src/services/mail")._setTestTransport({ sendMail: async (m) => { outbox.push(m); return { messageId: "t" + outbox.length }; }, verify: async () => true });
const waitForMail = async (pred, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = outbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); } return null; };

// ---- fake Google OAuth client ----
const google = { idTokens: new Map(), codes: new Map() };
require("../src/routes/auth")._setGoogleClient({
  verifyIdToken: async ({ idToken, audience }) => {
    const p = google.idTokens.get(idToken);
    if (!p || audience !== process.env.GOOGLE_CLIENT_ID) throw new Error("invalid token");
    return { getPayload: () => p };
  },
  generateCodeVerifierAsync: async () => ({ codeVerifier: "verifier-" + crypto.randomBytes(4).toString("hex"), codeChallenge: "challenge" }),
  generateAuthUrl: (o) => { google.lastAuthNonce = o.nonce; return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ state: o.state, nonce: o.nonce, code_challenge: o.code_challenge, redirect_uri: o.redirect_uri }); },
  getToken: async ({ code, codeVerifier }) => {
    const c = google.codes.get(code);
    if (!c || !codeVerifier) throw new Error("invalid_grant");
    // Google puts the nonce from the authorization request into the ID token.
    const p = google.idTokens.get(c);
    if (p && google.lastAuthNonce) google.idTokens.set(c, { ...p, nonce: google.lastAuthNonce });
    return { tokens: { id_token: c } };
  },
});

const webhookSig = (raw) => crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");

// ---- database reset ----
async function resetDb() {
  const tables = await q("SELECT table_name t FROM information_schema.tables WHERE table_schema = DATABASE()");
  await q("SET FOREIGN_KEY_CHECKS=0");
  for (const { t } of tables) await q("DROP TABLE `" + t + "`");
  await q("SET FOREIGN_KEY_CHECKS=1");
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
}

// ---- app server + cookie-aware client ----
let server, base;
async function start() {
  require("../src/security").bypassRateLimits = true; // tests fire many requests from one IP
  await resetDb();
  await new Promise((r) => { server = createApp().listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() { await new Promise((r) => server.close(r)); await pool.end(); }

function client() {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function req(method, path, body, { csrf = true, headers = {}, raw = false } = {}) {
    if (!jar.has("hm_csrf")) await doFetch("GET", "/api/config");
    return doFetch(method, path, body, { csrf, headers, raw });
  }
  async function doFetch(method, path, body, { csrf = true, headers = {}, raw = false } = {}) {
    const h = { ...headers, cookie: cookieHeader() };
    if (body !== undefined && !raw) h["content-type"] = "application/json";
    if (csrf && method !== "GET" && jar.has("hm_csrf")) h["x-csrf-token"] = jar.get("hm_csrf");
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";"); const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  }
  return {
    jar,
    get: (p, o) => req("GET", p, undefined, o),
    post: (p, b, o) => req("POST", p, b ?? {}, o),
    put: (p, b, o) => req("PUT", p, b ?? {}, o),
    patch: (p, b, o) => req("PATCH", p, b ?? {}, o),
    del: (p, b, o) => req("DELETE", p, b ?? {}, o),
    raw: (m, p, b, o) => req(m, p, b, { ...o, raw: true }),
  };
}

async function customer(email, name = "Test Customer") {
  const c = client();
  const r = await c.post("/api/auth/register", { name, email, password: "Passw0rd!", phone: "9876543210" });
  if (r.status !== 201) throw new Error("register failed " + JSON.stringify(r.data));
  const a = await c.post("/api/account/addresses", { name, phone: "9876543210", line1: "12 Test Street", city: "Lucknow", state: "Uttar Pradesh", pincode: "226010" });
  c.addressId = a.data.id;
  return c;
}
async function admin(email = "root@test.local", password = "RootPass123") {
  const c = client();
  const r = await c.post("/api/admin/login", { email, password });
  if (r.status !== 200) throw new Error("admin login failed " + JSON.stringify(r.data));
  return c;
}

/** Popup flow as the browser does it: get a one-time nonce, then post a Google ID token that carries it. */
async function googlePopup(c, tokenKey) {
  const { nonce } = (await c.get("/api/auth/google/nonce")).data;
  const p = google.idTokens.get(tokenKey);
  if (p) google.idTokens.set(tokenKey, { iss: "https://accounts.google.com", ...p, nonce });
  return c.post("/api/auth/google", { credential: tokenKey });
}

module.exports = { googlePopup, start, stop, client, customer, admin, pay, webhookSig, fake, q, base: () => base, outbox, waitForMail, google, cloudLog, SECRETS };
