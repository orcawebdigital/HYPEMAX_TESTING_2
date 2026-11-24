const router = require("express").Router();
const { q, one } = require("../../db");
const { wrap, notFound, int, bool, pageParams, toCsv } = require("../../util");
const { can, audit, destroyAllSessions } = require("../../auth");
const { STATUS_LABEL } = require("../../services/orders");

const SORTS = { newest: "u.created_at DESC", oldest: "u.created_at ASC", spent: "spent DESC", orders: "orders DESC", name: "u.name ASC" };

function filters(query) {
  const where = [], params = [];
  if (query.q) {
    const s = `%${String(query.q).replace(/[%_\\]/g, "\\$&").slice(0, 80)}%`;
    where.push("(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)"); params.push(s, s, s);
  }
  if (query.has_orders === "1") where.push("EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.paid_at IS NOT NULL)");
  if (query.has_orders === "0") where.push("NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.paid_at IS NOT NULL)");
  if (query.login === "google") where.push("u.google_sub IS NOT NULL");
  if (query.from) { where.push("u.created_at >= ?"); params.push(new Date(query.from)); }
  if (query.to) { where.push("u.created_at < ? + INTERVAL 1 DAY"); params.push(new Date(query.to)); }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", params };
}
const SELECT = `SELECT u.id, u.name, u.email, u.phone, u.created_at, u.last_login_at, u.is_active, u.email_verified_at IS NOT NULL email_verified, u.google_sub IS NOT NULL google,
  (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.paid_at IS NOT NULL) orders,
  (SELECT COALESCE(SUM(o.total - o.refunded_amount),0) FROM orders o WHERE o.user_id=u.id AND o.paid_at IS NOT NULL) spent,
  (SELECT MAX(o.paid_at) FROM orders o WHERE o.user_id=u.id) last_order_at
  FROM users u`;

router.get("/", can("customers.view"), wrap(async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, { def: 25 });
  const f = filters(req.query);
  const [rows, [{ n }]] = await Promise.all([
    q(`${SELECT} ${f.sql} ORDER BY ${SORTS[req.query.sort] || SORTS.newest} LIMIT ? OFFSET ?`, [...f.params, limit, offset]),
    q(`SELECT COUNT(*) n FROM users u ${f.sql}`, f.params),
  ]);
  res.json({ rows, total: n, page, limit });
}));

router.get("/export.csv", can("customers.export"), wrap(async (req, res) => {
  const f = filters(req.query);
  const rows = await q(`${SELECT} ${f.sql} ORDER BY u.created_at DESC LIMIT 50000`, f.params);
  const csv = toCsv(rows, [["id", "ID"], ["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["created_at", "Registered (UTC)"],
    ["orders", "Paid orders"], [(r) => (r.spent / 100).toFixed(2), "Total spent (INR)"], ["last_order_at", "Last order (UTC)"], [(r) => (r.google ? "yes" : "no"), "Google login"]]);
  await audit(req, "customers.export", "customer", null, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="hypemax-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + csv);
}));

router.get("/:id", can("customers.view"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const u = await one(`${SELECT} WHERE u.id=?`, [id]);
  if (!u) throw notFound("Customer not found");
  const full = req.admin.role === "super_admin" || req.admin.permissions.includes("analytics.view");
  const [orders, addresses, payments, coupons, activity] = await Promise.all([
    q(`SELECT order_number, status, payment_status, total, discount, coupon_code, created_at, paid_at FROM orders WHERE user_id=? AND NOT (status='cancelled' AND paid_at IS NULL) ORDER BY created_at DESC`, [id]),
    q("SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC", [id]),
    q(`SELECT p.razorpay_payment_id, p.amount, p.status, p.method, p.paid_at, o.order_number FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.user_id=? AND p.status<>'pending' ORDER BY p.created_at DESC`, [id]),
    q(`SELECT c.code, cu.discount_amount, cu.status, cu.created_at, o.order_number FROM coupon_usages cu JOIN coupons c ON c.id=cu.coupon_id JOIN orders o ON o.id=cu.order_id WHERE cu.user_id=? ORDER BY cu.created_at DESC`, [id]),
    full ? q(`SELECT event_type, path, product_id, created_at FROM analytics_events WHERE user_id=? ORDER BY id DESC LIMIT 50`, [id]) : Promise.resolve(null),
  ]);
  res.json({ ...u, orders: orders.map((o) => ({ ...o, status_label: STATUS_LABEL[o.status] })), addresses, payments, coupons, activity });
}));

// Suspend / reactivate an account (super admin and managers with customers.export).
router.post("/:id/active", can("customers.export"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const active = bool(req.body && req.body.is_active);
  await q("UPDATE users SET is_active=? WHERE id=?", [active ? 1 : 0, id]);
  if (!active) await destroyAllSessions("user", id);
  await audit(req, active ? "customer.activate" : "customer.suspend", "customer", id);
  res.json({ ok: true });
}));

module.exports = router;
