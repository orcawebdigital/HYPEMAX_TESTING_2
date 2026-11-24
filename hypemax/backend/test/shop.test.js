const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

let root, PID; // pre-workout product id
const PRICE = 149900;

before(async () => {
  await H.start();
  root = await H.admin();
  PID = (await H.q("SELECT id FROM products WHERE slug='hypemax-pre-workout'"))[0].id;
});
after(H.stop);

const addToCart = (c, qty = 1) => c.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: qty });
async function checkout(c, extra = {}) { return c.post("/api/checkout", { address_id: c.addressId, ...extra }); }
async function payAndVerify(c, order) {
  const p = H.pay(order.razorpay.order_id);
  const { payment, ...body } = p;
  return { res: await c.post("/api/checkout/verify", body), p };
}
const stock = async () => (await H.q("SELECT stock, reserved FROM inventory WHERE product_id=?", [PID]))[0];
async function makeCoupon(body) {
  const r = await root.post("/api/admin/coupons", { discount_type: "percent", discount_value: 10, is_active: true, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

// ---------------- security basics ----------------
test("state-changing requests without the CSRF token are rejected", async () => {
  const c = H.client();
  await c.get("/api/config");
  const r = await c.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "CSRF");
});

test("admin APIs require an admin session (customer session is not enough)", async () => {
  const c = await H.customer("nosy@test.local");
  assert.equal((await c.get("/api/admin/dashboard")).status, 401);
  assert.equal((await c.get("/api/admin/coupons")).status, 401);
});

test("password login: wrong password fails, account locks after 5 failures", async () => {
  await H.customer("lock@test.local");
  const c = H.client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/auth/login", { email: "lock@test.local", password: "nope12345" })).status, 401);
  const r = await c.post("/api/auth/login", { email: "lock@test.local", password: "Passw0rd!" });
  assert.equal(r.status, 429, "correct password must still be refused while locked");
  assert.equal(r.data.code, "LOCKED");
});

test("password hashes and secrets never appear in API responses", async () => {
  const c = await H.customer("leak@test.local");
  const me = await c.get("/api/account/profile");
  assert.ok(!JSON.stringify(me.data).includes("$2"));
  const cfg = await c.get("/api/config");
  assert.ok(!JSON.stringify(cfg.data).includes("test_key_secret"));
  const cust = await root.get("/api/admin/customers?q=leak");
  assert.ok(!JSON.stringify(cust.data).includes("password"));
});

// ---------------- catalogue rules ----------------
test("upcoming products cannot be added to cart", async () => {
  const c = await H.customer("upcoming@test.local");
  const whey = (await H.q("SELECT id FROM products WHERE slug='hypemax-whey-protein'"))[0].id;
  const r = await c.post("/api/cart/items", { product_id: whey, quantity: 1 });
  assert.equal(r.status, 400);
});

test("cart rejects invalid quantities", async () => {
  const c = await H.customer("qty@test.local");
  assert.equal((await c.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: -3 })).status, 400);
  assert.equal((await c.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1.5 })).status, 400);
  assert.equal((await c.post("/api/cart/items", { product_id: PID, flavour: "Not A Flavour", quantity: 1 })).status, 400);
});

test("guests cannot add to, change or remove from a cart; the API (not just the UI) refuses", async () => {
  const g = H.client();
  for (const [m, body] of [["post", { product_id: PID, flavour: "Fruit Punch", quantity: 1 }], ["patch", { product_id: PID, flavour: "Fruit Punch", quantity: 2 }], ["del", { product_id: PID, flavour: "Fruit Punch" }]]) {
    const r = await g[m]("/api/cart/items", body);
    assert.equal(r.status, 401, m);
    assert.equal(r.data.code, "AUTH_REQUIRED");
  }
  const cart = await g.get("/api/cart");
  assert.equal(cart.status, 200);
  assert.equal(cart.data.count, 0);
  assert.equal(cart.data.login_required, true);
});

test("cart belongs to the account: same customer sees it on another device after login", async () => {
  const c = await H.customer("merge@test.local");
  const r = await addToCart(c, 2);
  assert.equal(r.data.count, 2);
  const other = H.client();
  await other.post("/api/auth/login", { email: "merge@test.local", password: "Passw0rd!" });
  assert.equal((await other.get("/api/cart")).data.count, 2);
});

// ---------------- coupons ----------------
test("coupon validation: invalid, inactive, expired, not started, min order, restricted", async () => {
  const c = await H.customer("coupons@test.local");
  await addToCart(c, 1);
  const preview = async (code) => (await c.get("/api/cart?coupon=" + code)).data;

  assert.match((await preview("DOESNOTEXIST")).coupon_error.message, /not valid/);
  await makeCoupon({ code: "OFFLINE", is_active: false });
  assert.match((await preview("OFFLINE")).coupon_error.message, /not valid/);
  await makeCoupon({ code: "OLD10", expires_at: "2020-01-01T00:00" });
  assert.equal((await preview("OLD10")).coupon_error.code, "COUPON_EXPIRED");
  await makeCoupon({ code: "FUTURE10", starts_at: "2099-01-01T00:00" });
  assert.equal((await preview("FUTURE10")).coupon_error.code, "COUPON_NOT_STARTED");
  await makeCoupon({ code: "BIG10", min_order_value: 5000 });
  assert.equal((await preview("BIG10")).coupon_error.code, "COUPON_MIN_ORDER");
  const prot = (await H.q("SELECT id FROM categories WHERE slug='protein'"))[0].id;
  await makeCoupon({ code: "PROTEINONLY", category_ids: [prot] });
  assert.equal((await preview("PROTEINONLY")).coupon_error.code, "COUPON_NOT_ELIGIBLE");

  // and the checkout endpoint refuses them too (not just the preview)
  const r = await checkout(c, { coupon_code: "OLD10" });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "COUPON_EXPIRED");
});

test("percent coupon with max cap is computed server-side", async () => {
  await makeCoupon({ code: "CAP20", discount_value: 20, max_discount: 150 }); // 20% of 1499 = 299.8 -> capped at 150
  const c = await H.customer("cap@test.local");
  await addToCart(c, 1);
  const cart = (await c.get("/api/cart?coupon=cap20")).data;
  assert.equal(cart.coupon.code, "CAP20");
  assert.equal(cart.discount, 15000);
  assert.equal(cart.total, PRICE - 15000);
});

test("tampered checkout fields (total, discount, price) are ignored; server recalculates", async () => {
  const c = await H.customer("tamper@test.local");
  await addToCart(c, 2);
  const r = await checkout(c, { total: 100, amount: 100, discount: 999999, price: 1, subtotal: 1, items: [{ product_id: PID, price: 1, quantity: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.amount, PRICE * 2);
  assert.equal(H.fake.orders.get(r.data.razorpay.order_id).amount, PRICE * 2, "Razorpay order must be for the server amount");
});

test("payment for a different amount than the order is refused", async () => {
  const c = await H.customer("amount@test.local");
  await addToCart(c, 1);
  const o = (await checkout(c)).data;
  const p = H.pay(o.razorpay.order_id, { amount: 100 }); // customer somehow paid ₹1
  const { payment, ...body } = p;
  const r = await c.post("/api/checkout/verify", body);
  assert.equal(r.status, 400);
  const ord = (await H.q("SELECT status, payment_status FROM orders WHERE order_number=?", [o.order_number]))[0];
  assert.equal(ord.payment_status, "pending");
});

test("forged payment signature is rejected and order stays unpaid", async () => {
  const c = await H.customer("forge@test.local");
  await addToCart(c, 1);
  const o = (await checkout(c)).data;
  const p = H.pay(o.razorpay.order_id);
  const r = await c.post("/api/checkout/verify", { razorpay_order_id: p.razorpay_order_id, razorpay_payment_id: p.razorpay_payment_id, razorpay_signature: "deadbeef".repeat(8) });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "BAD_SIGNATURE");
  const ord = (await H.q("SELECT payment_status FROM orders WHERE order_number=?", [o.order_number]))[0];
  assert.equal(ord.payment_status, "pending");
});

test("full purchase: reserve -> verified payment -> stock, coupon usage, cart, invoice; verify is idempotent", async () => {
  await makeCoupon({ code: "ONCE50", discount_type: "fixed", discount_value: 50, per_customer_limit: 1 });
  const c = await H.customer("buyer@test.local");
  await addToCart(c, 2);
  const s0 = await stock();
  const r = await checkout(c, { coupon_code: "once50" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.amount, PRICE * 2 - 5000);
  const s1 = await stock();
  assert.equal(s1.reserved, s0.reserved + 2);
  assert.equal(s1.stock, s0.stock);

  const { res } = await payAndVerify(c, r.data);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const s2 = await stock();
  assert.equal(s2.stock, s0.stock - 2);
  assert.equal(s2.reserved, s0.reserved);
  const ord = (await c.get("/api/account/orders/" + r.data.order_number)).data;
  assert.equal(ord.status, "payment_confirmed");
  assert.equal(ord.payment_status, "successful");
  assert.equal(ord.discount, 5000);
  assert.equal((await c.get("/api/cart")).data.count, 0, "cart cleared after purchase");
  const cu = await H.q("SELECT status FROM coupon_usages WHERE order_id=?", [ord.id]);
  assert.equal(cu[0].status, "used");

  // idempotency: replaying verify does not double-decrement stock
  const p = ord.payments[0];
  const crypto = require("crypto");
  const sig = crypto.createHmac("sha256", "test_key_secret").update(`${p.razorpay_order_id}|${p.razorpay_payment_id}`).digest("hex");
  const again = await c.post("/api/checkout/verify", { razorpay_order_id: p.razorpay_order_id, razorpay_payment_id: p.razorpay_payment_id, razorpay_signature: sig });
  assert.equal(again.data.already_processed, true);
  assert.equal((await stock()).stock, s0.stock - 2);

  // per-customer limit now blocks reuse
  await addToCart(c, 1);
  const second = await checkout(c, { coupon_code: "ONCE50" });
  assert.equal(second.status, 400);
  assert.equal(second.data.code, "COUPON_USER_LIMIT");

  // invoice is a PDF for the owner, 404 for someone else
  const inv = await c.get(`/api/account/orders/${r.data.order_number}/invoice`);
  assert.equal(inv.status, 200);
  assert.match(inv.headers.get("content-type"), /pdf/);
  const other = await H.customer("other@test.local");
  assert.equal((await other.get(`/api/account/orders/${r.data.order_number}`)).status, 404);
});

test("concurrent checkouts cannot exceed a coupon's total usage limit", async () => {
  await makeCoupon({ code: "ONLYONE", usage_limit: 1 });
  const buyers = await Promise.all([1, 2, 3, 4].map((i) => H.customer(`race${i}@test.local`)));
  for (const b of buyers) await addToCart(b, 1);
  const results = await Promise.all(buyers.map((b) => checkout(b, { coupon_code: "ONLYONE" })));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, "exactly one order may reserve the coupon: " + results.map((r) => r.status + ":" + (r.data.code || "")).join(","));
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.data.code === "COUPON_EXHAUSTED"));
});

test("concurrent checkouts cannot oversell the last unit", async () => {
  await root.post(`/api/admin/products/${PID}/inventory`, { mode: "set", quantity: (await stock()).reserved + 1 });
  const buyers = await Promise.all([1, 2, 3].map((i) => H.customer(`last${i}@test.local`)));
  for (const b of buyers) await addToCart(b, 1);
  const results = await Promise.all(buyers.map((b) => checkout(b)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  await root.post(`/api/admin/products/${PID}/inventory`, { mode: "set", quantity: 500 });
});

test("cancelling an unpaid order releases reserved stock and coupon", async () => {
  await makeCoupon({ code: "RELEASE", usage_limit: 1 });
  const c = await H.customer("release@test.local");
  await addToCart(c, 1);
  const s0 = await stock();
  const o = (await checkout(c, { coupon_code: "RELEASE" })).data;
  assert.equal((await stock()).reserved, s0.reserved + 1);
  const r = await c.post(`/api/checkout/${o.order_number}/cancel`);
  assert.equal(r.data.status, "cancelled");
  assert.equal((await stock()).reserved, s0.reserved);
  // the single-use coupon is available again
  const c2 = await H.customer("release2@test.local");
  await addToCart(c2, 1);
  assert.equal((await checkout(c2, { coupon_code: "RELEASE" })).status, 201);
});

test("webhook: rejects bad signature, confirms payment, ignores duplicate deliveries", async () => {
  const c = await H.customer("hook@test.local");
  await addToCart(c, 1);
  const o = (await checkout(c)).data;
  const { payment } = H.pay(o.razorpay.order_id);
  const raw = JSON.stringify({ event: "payment.captured", created_at: 1, payload: { payment: { entity: payment } } });
  const bad = await c.raw("POST", "/api/payments/webhook", raw, { csrf: false, headers: { "content-type": "application/json", "x-razorpay-signature": "bad" } });
  assert.equal(bad.status, 400);
  const hdr = { "content-type": "application/json", "x-razorpay-signature": H.webhookSig(raw), "x-razorpay-event-id": "evt_1" };
  const ok = await c.raw("POST", "/api/payments/webhook", raw, { csrf: false, headers: hdr });
  assert.equal(ok.status, 200);
  const ord = (await H.q("SELECT status, payment_status FROM orders WHERE order_number=?", [o.order_number]))[0];
  assert.equal(ord.payment_status, "successful");
  const dup = await c.raw("POST", "/api/payments/webhook", raw, { csrf: false, headers: hdr });
  assert.equal(dup.data.duplicate, true);
});

test("expired reservations are reconciled with Razorpay before being released", async () => {
  const orders = require("../src/services/orders");
  const c = await H.customer("expire@test.local");
  await addToCart(c, 1);
  const paid = (await checkout(c)).data;
  H.pay(paid.razorpay.order_id); // paid, but customer closed the tab before verify
  await addToCart(c, 1);
  const unpaid = (await checkout(c)).data;
  await H.q("UPDATE orders SET reservation_expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE order_number IN (?)", [[paid.order_number, unpaid.order_number]]);
  await orders.expireStaleOrders();
  const st = Object.fromEntries((await H.q("SELECT order_number, status FROM orders WHERE order_number IN (?)", [[paid.order_number, unpaid.order_number]])).map((r) => [r.order_number, r.status]));
  assert.equal(st[paid.order_number], "payment_confirmed");
  assert.equal(st[unpaid.order_number], "cancelled");
});

test("admin fulfilment, shipment, partial + full refund", async () => {
  const c = await H.customer("refund@test.local");
  await addToCart(c, 1);
  const o = (await checkout(c)).data;
  await payAndVerify(c, o);
  const n = o.order_number;
  assert.equal((await root.post(`/api/admin/orders/${n}/status`, { status: "packed" })).status, 200);
  assert.equal((await root.put(`/api/admin/orders/${n}/shipment`, { courier: "Delhivery", tracking_id: "DL123", tracking_url: "https://example.com/t/DL123" })).status, 200);
  assert.equal((await root.post(`/api/admin/orders/${n}/status`, { status: "shipped", note: "On the way" })).status, 200);
  const view = (await c.get("/api/account/orders/" + n)).data;
  assert.equal(view.shipment.tracking_id, "DL123");
  assert.equal(view.status, "shipped");

  assert.equal((await root.post(`/api/admin/orders/${n}/refund`, { amount: 500, reason: "Damaged seal" })).status, 200);
  let ord = (await H.q("SELECT payment_status, refunded_amount FROM orders WHERE order_number=?", [n]))[0];
  assert.equal(ord.payment_status, "partially_refunded");
  assert.equal(ord.refunded_amount, 50000);
  assert.equal((await root.post(`/api/admin/orders/${n}/refund`, { amount: 99999, reason: "too much" })).status, 400, "cannot refund more than paid");
  assert.equal((await root.post(`/api/admin/orders/${n}/refund`, { reason: "Full refund" })).status, 200);
  ord = (await H.q("SELECT payment_status, refunded_amount FROM orders WHERE order_number=?", [n]))[0];
  assert.equal(ord.payment_status, "refunded");
  assert.equal(ord.refunded_amount, PRICE);
});

test("customer cancel of a paid order restocks and refunds automatically", async () => {
  const c = await H.customer("cxl@test.local");
  await addToCart(c, 1);
  const o = (await checkout(c)).data;
  await payAndVerify(c, o);
  const s0 = await stock();
  const r = await c.post(`/api/account/orders/${o.order_number}/cancel`, { reason: "Changed my mind" });
  assert.equal(r.status, 200);
  assert.equal(r.data.refund.amount, PRICE);
  assert.equal((await stock()).stock, s0.stock + 1);
});

// ---------------- RBAC ----------------
test("role-based access: order manager and content manager limits are enforced server-side", async () => {
  await root.post("/api/admin/admins", { name: "OM", email: "om@test.local", password: "OrderMgr123", role: "order_manager" });
  await root.post("/api/admin/admins", { name: "CM", email: "cm@test.local", password: "Content123", role: "content_manager" });
  const om = await H.admin("om@test.local", "OrderMgr123");
  const cm = await H.admin("cm@test.local", "Content123");
  assert.equal((await om.get("/api/admin/orders")).status, 200);
  assert.equal((await om.get("/api/admin/coupons")).status, 403);
  assert.equal((await om.post("/api/admin/admins", { name: "x", email: "x@test.local", password: "Xxxxxxx123", role: "super_admin" })).status, 403);
  assert.equal((await cm.put("/api/admin/content/homepage", { heroTitle: "NEW TITLE" })).status, 200);
  assert.equal((await cm.put(`/api/admin/products/${PID}`, { price: 1 })).status, 403, "content manager cannot change price");
  assert.equal((await cm.put(`/api/admin/products/${PID}`, { short_description: "Updated copy" })).status, 200);
  assert.equal((await cm.get("/api/admin/orders")).status, 403);
  // CMS change is live immediately
  const site = await H.client().get("/api/site");
  assert.equal(site.data.homepage.heroTitle, "NEW TITLE");
  const audit = await root.get("/api/admin/audit-logs");
  assert.ok(audit.data.rows.some((r) => r.action === "content.update"));
});

test("dashboard numbers come from the database", async () => {
  const d = (await root.get("/api/admin/dashboard?range=today")).data;
  const [{ n }] = await H.q("SELECT COUNT(*) n FROM orders WHERE paid_at IS NOT NULL");
  assert.equal(d.orders.total, n);
  assert.ok(d.customers.total > 10);
  assert.equal((await root.get("/api/admin/dashboard?range=custom&from=2026-01-10&to=2026-01-01")).status, 400);
});

test("admin deletion: super admin can delete others but never themselves", async () => {
  const me = (await root.get("/api/admin/me")).data.admin;
  assert.equal((await root.del(`/api/admin/admins/${me.id}`)).status, 400);
  const r = await root.post("/api/admin/admins", { name: "Temp", email: "temp@test.local", password: "TempPass123", role: "manager" });
  assert.equal((await root.del(`/api/admin/admins/${r.data.id}`)).status, 200);
  const om = await H.admin("om@test.local", "OrderMgr123");
  assert.equal((await om.del(`/api/admin/admins/${me.id}`)).status, 403);
});

test("product highlights keep commas (one highlight per line)", async () => {
  assert.equal((await root.put(`/api/admin/products/${PID}`, { highlights: "Zero sugar, great taste\n30 servings" })).status, 200);
  const p = (await H.client().get("/api/products/hypemax-pre-workout")).data;
  assert.deepEqual(p.highlights, ["Zero sugar, great taste", "30 servings"]);
});
