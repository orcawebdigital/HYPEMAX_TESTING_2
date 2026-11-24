// Security behaviour checks (verifies actual behaviour, not just that middleware exists).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

let root;
before(async () => { await H.start(); root = await H.admin(); });
after(H.stop);

test("SQL injection payloads in search, sort, filters and ids are inert", async () => {
  const c = H.client();
  const before = (await H.q("SELECT COUNT(*) n FROM products"))[0].n;
  for (const qs of [
    "q=' OR 1=1 -- ", "q=%27%3BDROP%20TABLE%20products%3B--", "sort=price_asc;DROP TABLE users", "category=x' UNION SELECT password_hash FROM admins -- ",
    "min=1 OR 1=1", "availability=available' OR '1'='1",
  ]) {
    const r = await c.get("/api/products?" + qs);
    assert.ok([200, 400].includes(r.status), qs + " -> " + r.status);
    assert.ok(!JSON.stringify(r.data).includes("$2"), "no hashes leaked for " + qs);
  }
  assert.equal((await c.get("/api/products/x' OR '1'='1")).status, 404);
  assert.equal((await c.get("/api/products-by-ids?ids=1) OR (1=1")).status, 200);
  assert.equal((await H.q("SELECT COUNT(*) n FROM products"))[0].n, before);
  const adminSearch = await root.get("/api/admin/customers?q=%27%20OR%201%3D1%20--%20&sort=name;DROP");
  assert.equal(adminSearch.status, 200);
  assert.equal(adminSearch.data.total, 0);
});

test("session cookies are HttpOnly + SameSite and never readable by scripts; CSRF cookie is SameSite=Strict", async () => {
  const c = H.client();
  await c.get("/api/config");
  const r = await c.post("/api/auth/register", { name: "Cookie Test", email: "cookie@example.test", password: "Passw0rd!", phone: "9876543210" });
  const set = r.headers.getSetCookie().join("\n");
  assert.match(set, /hm_sid=[a-f0-9]{64};[^\n]*HttpOnly/i);
  assert.match(set, /hm_sid=[^\n]*SameSite=Lax/i);
  const csrf = (await fetch(H.base() + "/api/config")).headers.getSetCookie().join("\n"); // fresh visitor, no cookies
  assert.match(csrf, /hm_csrf=[^\n]*SameSite=Strict/i);
  // session token is stored hashed: the raw cookie value is not in the DB
  const tok = c.jar.get("hm_sid");
  assert.equal((await H.q("SELECT COUNT(*) n FROM sessions WHERE id=?", [tok]))[0].n, 0);
});

test("cross-site requests are refused even with a valid CSRF token (Origin check)", async () => {
  const c = H.client();
  await c.get("/api/config");
  const r = await c.post("/api/newsletter", { email: "x@example.test" }, { headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

test("rate limiting actually throttles (limiter enabled for this test)", async () => {
  const sec = require("../src/security");
  sec.bypassRateLimits = false;
  try {
    const c = H.client();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await c.post("/api/auth/forgot-password", { email: `rl${i}@example.test` })).status);
    assert.ok(codes.includes(429), "expected a 429 among " + codes.join(","));
    assert.equal(codes.filter((x) => x === 200).length, 5, "limit is 5/hour for password resets");
  } finally { sec.bypassRateLimits = true; }
});

test("admin brute force: lockout after 5 failures, even with the right password", async () => {
  await root.post("/api/admin/admins", { name: "Target", email: "target@test.local", password: "TargetPass123", role: "manager" });
  const c = H.client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/admin/login", { email: "target@test.local", password: "wrong-" + i })).status, 401);
  assert.equal((await c.post("/api/admin/login", { email: "target@test.local", password: "TargetPass123" })).status, 429);
});

test("privilege escalation attempts are blocked", async () => {
  await root.post("/api/admin/admins", { name: "Mgr", email: "mgr@test.local", password: "Manager1234", role: "manager" });
  await root.post("/api/admin/admins", { name: "CM", email: "cm@test.local", password: "Content123", role: "content_manager" });
  const mgr = await H.admin("mgr@test.local", "Manager1234");
  const cm = await H.admin("cm@test.local", "Content123");
  const me = (await mgr.get("/api/admin/me")).data.admin;
  // manager can't promote themselves or create admins, see audit logs or integrations
  assert.equal((await mgr.put(`/api/admin/admins/${me.id}`, { role: "super_admin" })).status, 403);
  assert.equal((await mgr.post("/api/admin/admins", { name: "x", email: "x2@test.local", password: "Xxxxxxx123", role: "super_admin" })).status, 403);
  assert.equal((await mgr.get("/api/admin/audit-logs")).status, 403);
  assert.equal((await mgr.get("/api/admin/integrations")).status, 403);
  // content manager can't touch shipping charges, orders, refunds, coupons or exports
  assert.equal((await cm.put("/api/admin/content/settings", { shippingFee: "0", freeShippingAbove: "1" })).status, 403);
  assert.equal((await cm.get("/api/admin/orders/export.csv")).status, 403);
  assert.equal((await cm.post("/api/admin/coupons", { code: "FREE100", discount_type: "percent", discount_value: 100 })).status, 403);
  // mass-assignment: unknown fields are ignored, not written
  const r = await root.put("/api/admin/content/homepage", { heroTitle: "OK", __proto__: { admin: true }, evil: "<x>" });
  assert.equal(r.status, 200);
  assert.ok(!("evil" in (await H.client().get("/api/content/homepage")).data));
  // customer sessions mean nothing to admin APIs
  const cust = await H.customer("esc@example.test");
  assert.equal((await cust.get("/api/admin/me")).status, 401);
});

test("customers can only see their own data (IDOR)", async () => {
  const a = await H.customer("idor-a@example.test");
  const b = await H.customer("idor-b@example.test");
  assert.equal((await b.put(`/api/account/addresses/${a.addressId}`, { name: "x", phone: "9876543210", line1: "hack st", city: "x", state: "x", pincode: "110001" })).status, 404);
  await b.del(`/api/account/addresses/${a.addressId}`);
  assert.equal((await H.q("SELECT COUNT(*) n FROM addresses WHERE id=?", [a.addressId]))[0].n, 1);
  // checkout with someone else's address id
  const PID = (await H.q("SELECT id FROM products WHERE slug='hypemax-pre-workout'"))[0].id;
  await b.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  assert.equal((await b.post("/api/checkout", { address_id: a.addressId })).status, 404);
});

test("verify endpoint refuses another customer's payment", async () => {
  const PID = (await H.q("SELECT id FROM products WHERE slug='hypemax-pre-workout'"))[0].id;
  const a = await H.customer("pay-a@example.test");
  const b = await H.customer("pay-b@example.test");
  await a.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  const o = (await a.post("/api/checkout", { address_id: a.addressId })).data;
  const { payment, ...body } = H.pay(o.razorpay.order_id);
  assert.equal((await b.post("/api/checkout/verify", body)).status, 404);
});

test("webhook stores only identifiers, not customer contact or card data", async () => {
  const raw = JSON.stringify({ event: "payment.failed", created_at: 7, payload: { payment: { entity: { id: "pay_X", order_id: "order_none", amount: 100, status: "failed", email: "secret@example.test", contact: "+919999999999", vpa: "someone@upi", card: { last4: "4242" } } } } });
  const r = await H.client().raw("POST", "/api/payments/webhook", raw, { csrf: false, headers: { "content-type": "application/json", "x-razorpay-signature": H.webhookSig(raw), "x-razorpay-event-id": "evt_pii" } });
  assert.equal(r.status, 200);
  const row = (await H.q("SELECT payload FROM webhook_events WHERE id='evt_pii'"))[0];
  const s = JSON.stringify(row.payload);
  for (const pii of ["secret@example.test", "+919999999999", "someone@upi", "4242"]) assert.ok(!s.includes(pii), "stored " + pii);
});

test("security headers are present", async () => {
  const r = await H.client().get("/");
  assert.match(r.headers.get("content-security-policy") || "", /script-src 'self'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok(r.headers.get("x-frame-options"));
  assert.equal(r.headers.get("x-powered-by"), null);
});

test("server errors return a generic message (no stack traces or SQL)", async () => {
  const r = await H.client().raw("POST", "/api/contact", "{bad json", { headers: { "content-type": "application/json" } });
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(r.data).match(/at \w+ \(|SELECT|node_modules/));
});
