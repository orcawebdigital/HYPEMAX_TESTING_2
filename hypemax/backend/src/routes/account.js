const router = require("express").Router();
const { q, one } = require("../db");
const { wrap, bad, notFound, str, optStr, email, phone, password, int, HttpError, field, personName, addressInput } = require("../util");
const { requireUser, hashPassword, checkPassword, destroyAllSessions, COOKIE } = require("../auth");
const { rateLimit } = require("../security");
const { publicUser } = require("./auth");
const orders = require("../services/orders");
const { streamInvoice } = require("../services/invoice");
const catalog = require("../services/catalog");
const analytics = require("../services/analytics");
const mail = require("../services/mail");

router.use(requireUser);

// ---------- profile ----------
router.get("/profile", wrap(async (req, res) => {
  const u = await one("SELECT id, name, email, phone, email_verified_at, google_sub, password_hash IS NOT NULL has_password, created_at FROM users WHERE id=?", [req.user.id]);
  const [stats] = await q(`SELECT COUNT(*) orders,
      SUM(status NOT IN ('pending_payment','cancelled','returned','delivered')) current_orders,
      SUM(status='delivered') delivered, SUM(status='cancelled' AND paid_at IS NOT NULL) cancelled, SUM(status='returned') returned,
      COALESCE(SUM(CASE WHEN payment_status IN ('successful','partially_refunded','refunded') THEN total - refunded_amount END),0) spent
    FROM orders WHERE user_id=? AND status <> 'pending_payment'`, [req.user.id]);
  const [{ unread }] = await q("SELECT COUNT(*) unread FROM notifications WHERE user_id=? AND read_at IS NULL", [req.user.id]);
  res.json({ user: { ...publicUser(u), created_at: u.created_at }, stats: { ...stats, unread_notifications: unread } });
}));

router.put("/profile", wrap(async (req, res) => {
  const b = req.body || {};
  const name = field("name", () => personName(b.name, { name: "Full name" }));
  const ph = field("phone", () => phone(b.phone, { required: false })) || null;
  const newEmail = b.email !== undefined ? field("email", () => email(b.email)) : req.user.email;
  if (newEmail !== req.user.email) {
    // Changing email requires the current password (or is blocked for Google-only accounts) and resets verification.
    const u = await one("SELECT password_hash FROM users WHERE id=?", [req.user.id]);
    if (!u.password_hash) throw bad("Set a password first (via Forgot password) before changing your email");
    if (!(await checkPassword(b.current_password, u.password_hash))) throw bad("Enter your current password to change your email");
    if (await one("SELECT id FROM users WHERE email=? AND id<>?", [newEmail, req.user.id])) throw new HttpError(409, "That email is already in use");
    await q("UPDATE users SET email=?, email_verified_at=NULL, google_sub=NULL WHERE id=?", [newEmail, req.user.id]);
  }
  await q("UPDATE users SET name=?, phone=? WHERE id=?", [name, ph, req.user.id]);
  res.json({ ok: true });
}));

router.post("/password", rateLimit({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
  const b = req.body || {};
  const u = await one("SELECT password_hash FROM users WHERE id=?", [req.user.id]);
  if (u.password_hash && !(await checkPassword(b.current_password, u.password_hash))) throw bad("Current password is incorrect");
  const pw = password(b.new_password);
  await q("UPDATE users SET password_hash=? WHERE id=?", [await hashPassword(pw), req.user.id]);
  await destroyAllSessions("user", req.user.id, req.cookies[COOKIE.user]); // log out other devices
  mail.sendTemplate(req.user.email, "passwordChanged", req.user).catch(() => {});
  res.json({ ok: true });
}));

// ---------- addresses ----------
const addrInput = addressInput;
router.get("/addresses", wrap(async (req, res) => {
  res.json(await q("SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC", [req.user.id]));
}));
router.post("/addresses", wrap(async (req, res) => {
  const a = addrInput(req.body || {});
  const [{ n }] = await q("SELECT COUNT(*) n FROM addresses WHERE user_id=?", [req.user.id]);
  if (n >= 20) throw bad("You can save up to 20 addresses");
  if (!n) a.is_default = 1;
  if (a.is_default) await q("UPDATE addresses SET is_default=0 WHERE user_id=?", [req.user.id]);
  const r = await q("INSERT INTO addresses SET ?", [{ ...a, user_id: req.user.id }]);
  res.status(201).json(await one("SELECT * FROM addresses WHERE id=?", [r.insertId]));
}));
router.put("/addresses/:id", wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  if (!(await one("SELECT id FROM addresses WHERE id=? AND user_id=?", [id, req.user.id]))) throw notFound("Address not found");
  const a = addrInput(req.body || {});
  if (a.is_default) await q("UPDATE addresses SET is_default=0 WHERE user_id=?", [req.user.id]);
  await q("UPDATE addresses SET ? WHERE id=? AND user_id=?", [a, id, req.user.id]);
  res.json(await one("SELECT * FROM addresses WHERE id=?", [id]));
}));
router.delete("/addresses/:id", wrap(async (req, res) => {
  // Ownership is part of the WHERE clause, so another customer's id simply isn't found (no IDOR).
  const id = int(req.params.id, { min: 1, name: "Address" });
  const gone = await one("SELECT is_default FROM addresses WHERE id=? AND user_id=?", [id, req.user.id]);
  if (!gone) throw notFound("Address not found. It may already have been deleted.");
  await q("DELETE FROM addresses WHERE id=? AND user_id=?", [id, req.user.id]);
  // Keep exactly one default: promote the newest remaining address if the default was removed.
  if (gone.is_default) await q("UPDATE addresses SET is_default=1 WHERE user_id=? ORDER BY id DESC LIMIT 1", [req.user.id]);
  res.json({ ok: true });
}));

// ---------- orders ----------
const ORDER_FILTERS = {
  current: "status IN ('order_placed','payment_confirmed','processing','packed','shipped','out_for_delivery')",
  completed: "status='delivered'",
  cancelled: "status='cancelled'",
  returned: "status='returned'",
  pending: "status='pending_payment'",
};
router.get("/orders", wrap(async (req, res) => {
  const f = ORDER_FILTERS[req.query.filter];
  // Abandoned unpaid orders are hidden unless explicitly requested.
  const where = f ? f : "NOT (status='cancelled' AND paid_at IS NULL)";
  const rows = await q(`SELECT id, order_number, status, payment_status, total, discount, coupon_code, created_at, paid_at,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) item_count,
      (SELECT image_url FROM order_items oi WHERE oi.order_id=o.id ORDER BY id LIMIT 1) image
    FROM orders o WHERE user_id=? AND ${where} ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
  res.json(rows.map((o) => ({ ...o, status_label: orders.STATUS_LABEL[o.status] })));
}));

async function ownOrder(req) {
  const o = await orders.orderDetail("order_number=? AND user_id=?", [String(req.params.number), req.user.id]);
  if (!o) throw notFound("Order not found");
  return o;
}
router.get("/orders/:number", wrap(async (req, res) => {
  const o = await ownOrder(req);
  // Customers see courier tracking only when an admin has entered it; we never invent tracking events.
  for (const p of o.payments) delete p.verified_via;
  // Internal payment-verification notes are for admins; customers see a plain message.
  o.history = o.history.map((h) =>
    h.status === "payment_confirmed" ? { ...h, note: "Payment confirmed" } : h);
  res.json({ ...o, can_cancel: ["order_placed", "payment_confirmed", "processing"].includes(o.status) });
}));
router.post("/orders/:number/cancel", rateLimit({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
  const o = await ownOrder(req);
  const reason = optStr(req.body && req.body.reason, { max: 200, name: "Reason" }) || "Cancelled by customer";
  if (o.status === "pending_payment") {
    if (await orders.reconcile(o.id).catch(() => false)) throw bad("A payment was received for this order, so it has been confirmed. Refresh to see it.");
    await orders.releaseOrder(o.id, reason, "customer", req.user.id);
    return res.json({ ok: true });
  }
  res.json({ ok: true, ...(await orders.cancelPaidOrder(o.id, reason, { type: "customer", userId: req.user.id })) });
}));
router.get("/orders/:number/invoice", wrap(async (req, res) => {
  const o = await ownOrder(req);
  if (!o.paid_at) throw bad("An invoice is available once payment is confirmed");
  await streamInvoice(o, res);
}));

// ---------- payments / transactions ----------
router.get("/payments", wrap(async (req, res) => {
  const pays = await q(`SELECT p.id, p.razorpay_payment_id, p.razorpay_order_id, p.amount, p.status, p.method, p.paid_at, p.created_at,
      p.error_description, o.order_number, o.coupon_code, o.discount
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.user_id=? AND (p.status<>'pending' OR o.status='pending_payment')
    ORDER BY p.created_at DESC LIMIT 200`, [req.user.id]);
  const refunds = await q(`SELECT r.id, r.razorpay_refund_id, r.amount, r.status, r.reason, r.created_at, o.order_number
    FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.user_id=? AND r.status<>'failed' ORDER BY r.created_at DESC`, [req.user.id]);
  res.json({ payments: pays, refunds });
}));

// ---------- wishlist ----------
router.get("/wishlist", wrap(async (req, res) => {
  const ids = (await q("SELECT product_id FROM wishlists WHERE user_id=? ORDER BY created_at DESC", [req.user.id])).map((r) => r.product_id);
  const list = await catalog.listProducts({ ids });
  res.json(ids.map((id) => list.find((p) => p.id === id)).filter(Boolean));
}));
router.post("/wishlist", wrap(async (req, res) => {
  const pid = int(req.body && req.body.product_id, { min: 1, required: true, name: "Product" });
  if (!(await one("SELECT id FROM products WHERE id=? AND status<>'draft'", [pid]))) throw notFound("Product not found");
  await q("INSERT IGNORE INTO wishlists (user_id, product_id) VALUES (?,?)", [req.user.id, pid]);
  analytics.track(req, res, "wishlist_add", { productId: pid });
  res.json({ ok: true });
}));
router.delete("/wishlist/:productId", wrap(async (req, res) => {
  await q("DELETE FROM wishlists WHERE user_id=? AND product_id=?", [req.user.id, int(req.params.productId, { min: 1 })]);
  res.json({ ok: true });
}));

router.get("/recently-viewed", wrap(async (req, res) => {
  const ids = (await q("SELECT product_id FROM recently_viewed WHERE user_id=? ORDER BY viewed_at DESC LIMIT 12", [req.user.id])).map((r) => r.product_id);
  const list = await catalog.listProducts({ ids });
  res.json(ids.map((id) => list.find((p) => p.id === id)).filter(Boolean));
}));

// ---------- notifications ----------
router.get("/notifications", wrap(async (req, res) => {
  res.json(await q("SELECT id, title, body, link, read_at, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [req.user.id]));
}));
router.post("/notifications/read", wrap(async (req, res) => {
  await q("UPDATE notifications SET read_at=UTC_TIMESTAMP() WHERE user_id=? AND read_at IS NULL", [req.user.id]);
  res.json({ ok: true });
}));

// ---------- reviews (verified purchasers only) ----------
router.post("/reviews", rateLimit({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
  const b = req.body || {};
  const pid = int(b.product_id, { min: 1, required: true, name: "Product" });
  const rating = int(b.rating, { min: 1, max: 5, required: true, name: "Rating" });
  const bought = await one(`SELECT 1 x FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.user_id=? AND oi.product_id=? AND o.status='delivered' LIMIT 1`, [req.user.id, pid]);
  if (!bought) throw bad("You can review a product after it has been delivered to you");
  await q(`INSERT INTO reviews (product_id, user_id, name, rating, title, body, verified_purchase, is_published) VALUES (?,?,?,?,?,?,1,0)
           ON DUPLICATE KEY UPDATE rating=VALUES(rating), title=VALUES(title), body=VALUES(body), is_published=0`,
    [pid, req.user.id, req.user.name, rating, optStr(b.title, { max: 160, name: "Title" }), str(b.body, { max: 3000, name: "Review", required: true, min: 10 })]);
  res.json({ ok: true, message: "Thanks! Your review will appear once approved." });
}));

module.exports = router;
