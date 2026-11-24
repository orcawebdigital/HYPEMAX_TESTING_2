const router = require("express").Router();
const { q, one } = require("../../db");
const { wrap, bad, notFound, str, optStr, int, toPaise, date, pageParams, toCsv } = require("../../util");
const { can, audit } = require("../../auth");
const orders = require("../../services/orders");
const { streamInvoice } = require("../../services/invoice");
const { resolveRange } = require("./range");

function filters(query) {
  const where = [], params = [];
  if (!query.include_unpaid) where.push("NOT (o.status='cancelled' AND o.paid_at IS NULL)");
  if (query.status) { where.push("o.status=?"); params.push(String(query.status)); }
  if (query.payment_status) { where.push("o.payment_status=?"); params.push(String(query.payment_status)); }
  if (query.q) {
    const s = `%${String(query.q).replace(/[%_\\]/g, "\\$&").slice(0, 80)}%`;
    where.push("(o.order_number LIKE ? OR o.ship_name LIKE ? OR o.customer_email LIKE ? OR o.ship_phone LIKE ? OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.razorpay_payment_id LIKE ?))");
    params.push(s, s, s, s, s);
  }
  if (query.range) { const r = resolveRange(query); where.push("o.created_at >= ? AND o.created_at < ?"); params.push(r.from, r.to); }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

router.get("/", can("orders.view"), wrap(async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, { def: 25 });
  const f = filters(req.query);
  const [rows, [{ n }]] = await Promise.all([
    q(`SELECT o.id, o.order_number, o.status, o.payment_status, o.total, o.discount, o.coupon_code, o.ship_name, o.customer_email, o.ship_phone,
         o.ship_city, o.created_at, o.paid_at, (SELECT SUM(quantity) FROM order_items oi WHERE oi.order_id=o.id) units
       FROM orders o ${f.sql} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...f.params, limit, offset]),
    q(`SELECT COUNT(*) n FROM orders o ${f.sql}`, f.params),
  ]);
  res.json({ rows: rows.map((o) => ({ ...o, status_label: orders.STATUS_LABEL[o.status] })), total: n, page, limit });
}));

router.get("/export.csv", can("customers.export"), wrap(async (req, res) => {
  const f = filters(req.query);
  const rows = await q(`SELECT o.*, (SELECT GROUP_CONCAT(CONCAT(oi.product_name, IF(oi.flavour<>'', CONCAT(' (',oi.flavour,')'), ''), ' x', oi.quantity) SEPARATOR '; ') FROM order_items oi WHERE oi.order_id=o.id) items,
      (SELECT razorpay_payment_id FROM payments p WHERE p.order_id=o.id AND p.razorpay_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1) payment_id,
      s.courier, s.tracking_id
    FROM orders o LEFT JOIN shipments s ON s.order_id=o.id ${f.sql} ORDER BY o.created_at DESC LIMIT 20000`, f.params);
  const r = (k) => (x) => (x[k] / 100).toFixed(2);
  const csv = toCsv(rows, [["order_number", "Order"], ["created_at", "Created (UTC)"], ["paid_at", "Paid (UTC)"], ["status", "Status"], ["payment_status", "Payment"],
    ["payment_id", "Razorpay payment ID"], ["ship_name", "Customer"], ["customer_email", "Email"], ["ship_phone", "Phone"], ["items", "Items"],
    [r("subtotal"), "Subtotal"], ["coupon_code", "Coupon"], [r("discount"), "Discount"], [r("shipping_fee"), "Shipping"], [r("total"), "Total"], [r("refunded_amount"), "Refunded"],
    [(x) => [x.ship_line1, x.ship_line2, x.ship_city, x.ship_state, x.ship_pincode].filter(Boolean).join(", "), "Address"], ["courier", "Courier"], ["tracking_id", "Tracking ID"]]);
  await audit(req, "orders.export", "order", null, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="hypemax-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + csv);
}));

async function load(req) {
  const o = await orders.orderDetail("order_number=?", [String(req.params.number)]);
  if (!o) throw notFound("Order not found");
  return o;
}

router.get("/:number", can("orders.view"), wrap(async (req, res) => {
  const o = await load(req);
  const customer = await one(`SELECT u.id, u.name, u.email, u.phone, u.created_at,
      (SELECT COUNT(*) FROM orders x WHERE x.user_id=u.id AND x.paid_at IS NOT NULL) orders,
      (SELECT COALESCE(SUM(total - refunded_amount),0) FROM orders x WHERE x.user_id=u.id AND x.paid_at IS NOT NULL) spent
    FROM users u WHERE u.id=?`, [o.user_id]);
  res.json({ ...o, customer, fulfilment_statuses: orders.FULFILMENT.map((s) => ({ value: s, label: orders.STATUS_LABEL[s] })) });
}));

router.post("/:number/status", can("orders.manage"), wrap(async (req, res) => {
  const o = await load(req);
  const status = str(req.body && req.body.status, { max: 30, required: true, name: "Status" });
  const note = optStr(req.body.note, { max: 500, name: "Note" });
  await orders.updateStatus(o.id, status, note, req.admin.id);
  await audit(req, "order.status", "order", o.order_number, { from: o.status, to: status, note });
  res.json({ ok: true });
}));

router.put("/:number/shipment", can("orders.manage"), wrap(async (req, res) => {
  const o = await load(req);
  const b = req.body || {};
  const url = optStr(b.tracking_url, { max: 500, name: "Tracking URL" });
  if (url && !/^https:\/\//i.test(url)) throw bad("Tracking URL must start with https://");
  const eta = date(b.estimated_delivery, "Estimated delivery");
  const s = {
    courier: optStr(b.courier, { max: 80, name: "Courier" }),
    tracking_id: optStr(b.tracking_id, { max: 120, name: "Tracking ID" }),
    tracking_url: url,
    status: optStr(b.status, { max: 40, name: "Shipment status" }),
    estimated_delivery: eta ? eta.toISOString().slice(0, 10) : null,
    notes: optStr(b.notes, { max: 500, name: "Notes" }),
  };
  await q("INSERT INTO shipments SET ? ON DUPLICATE KEY UPDATE courier=VALUES(courier), tracking_id=VALUES(tracking_id), tracking_url=VALUES(tracking_url), status=VALUES(status), estimated_delivery=VALUES(estimated_delivery), notes=VALUES(notes)",
    [{ ...s, order_id: o.id }]);
  if (s.tracking_id && (!o.shipment || o.shipment.tracking_id !== s.tracking_id)) {
    await orders.history(require("../../db").pool, o.id, "shipment", `Shipped with ${s.courier || "courier"}, tracking ID ${s.tracking_id}`, "admin", req.admin.id);
    await orders.notify(require("../../db").pool, o.user_id, `Tracking added for ${o.order_number}`, `${s.courier || "Courier"}: ${s.tracking_id}`, `/account/orders/${o.order_number}`);
  }
  await audit(req, "order.shipment", "order", o.order_number, s);
  res.json({ ok: true });
}));

router.post("/:number/cancel", can("orders.refund"), wrap(async (req, res) => {
  const o = await load(req);
  const reason = str(req.body && req.body.reason, { max: 200, name: "Reason", required: true });
  let result;
  if (o.status === "pending_payment") { await orders.releaseOrder(o.id, reason, "admin", req.admin.id); result = {}; }
  else result = await orders.cancelPaidOrder(o.id, reason, { type: "admin", adminId: req.admin.id });
  await audit(req, "order.cancel", "order", o.order_number, { reason, refund: result.refund, refund_error: result.refund_error });
  res.json({ ok: true, ...result });
}));

router.post("/:number/refund", can("orders.refund"), wrap(async (req, res) => {
  const o = await load(req);
  const amount = req.body && req.body.amount !== undefined && req.body.amount !== "" ? toPaise(req.body.amount) : null;
  const reason = str(req.body && req.body.reason, { max: 200, name: "Reason", required: true });
  const r = await orders.refundOrder(o.id, amount, reason, { type: "admin", adminId: req.admin.id });
  await audit(req, "order.refund", "order", o.order_number, { amount: r.amount, refund_id: r.refund_id, reason });
  res.json({ ok: true, ...r });
}));

router.post("/:number/return", can("orders.manage"), wrap(async (req, res) => {
  const o = await load(req);
  const note = optStr(req.body && req.body.note, { max: 500, name: "Note" });
  await orders.markReturned(o.id, note, req.admin.id);
  await audit(req, "order.return", "order", o.order_number, { note });
  res.json({ ok: true });
}));

// Ask Razorpay for the latest state of an unpaid order (fixes "customer paid but closed the tab").
router.post("/:number/reconcile", can("orders.manage"), wrap(async (req, res) => {
  const o = await load(req);
  if (o.status !== "pending_payment" && o.payment_status !== "failed") return res.json({ ok: true, changed: false });
  const changed = await orders.reconcile(o.id);
  await audit(req, "order.reconcile", "order", o.order_number, { changed });
  res.json({ ok: true, changed });
}));

router.get("/:number/invoice", can("orders.view"), wrap(async (req, res) => {
  const o = await load(req);
  if (!o.paid_at) throw bad("Invoices are available for paid orders only");
  await streamInvoice(o, res);
}));

module.exports = router;
