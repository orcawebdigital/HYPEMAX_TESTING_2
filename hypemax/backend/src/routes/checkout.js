const express = require("express");
const router = express.Router();
const config = require("../config");
const { q, one, pool } = require("../db");
const { wrap, bad, notFound, str, optStr, int, addressInput, HttpError } = require("../util");
const { requireUser } = require("../auth");
const { rateLimit } = require("../security");
const orders = require("../services/orders");
const rzp = require("../services/razorpay");
const { getSettings } = require("../services/content");
const analytics = require("../services/analytics");
const mail = require("../services/mail");

/**
 * POST /api/checkout
 * body: { address_id } or { address: {...} }, coupon_code?, notes?
 * Creates a pending order with server-computed totals and a Razorpay order for exactly that amount.
 */
router.post("/", requireUser, rateLimit({ windowMs: 10 * 60e3, max: 15, message: "Too many checkout attempts. Please wait a few minutes." }), wrap(async (req, res) => {
  const b = req.body || {};
  let address;
  if (b.address_id) {
    const saved = await one("SELECT * FROM addresses WHERE id=? AND user_id=?", [int(b.address_id, { min: 1 }), req.user.id]);
    if (!saved) throw notFound("Address not found");
    // Addresses saved before validation was tightened are re-checked, so an incomplete one can't reach an order.
    try { address = addressInput(saved); } catch (e) { e.message = `Your saved address needs fixing: ${e.message}. Edit it under My account > Addresses.`; e.code = "ADDRESS_INVALID"; throw e; }
  } else {
    const a = b.address || {};
    const { label, is_default, ...valid } = addressInput(a); // eslint-disable-line no-unused-vars
    address = valid;
    if (a.save) {
      const [{ n }] = await q("SELECT COUNT(*) n FROM addresses WHERE user_id=?", [req.user.id]);
      await q("INSERT INTO addresses SET ?", [{ ...address, user_id: req.user.id, is_default: n ? 0 : 1 }]);
    }
  }
  const couponCode = optStr(b.coupon_code, { max: 40, name: "Coupon" });
  const notes = optStr(b.notes, { max: 500, name: "Notes" });

  const order = await orders.createOrder(req.user, { address, couponCode, notes });
  const s = await getSettings();
  res.status(201).json({
    order_number: order.order_number,
    amount: order.total,
    razorpay: {
      key: rzp.keyId(),
      order_id: order.razorpay_order_id,
      amount: order.total,
      currency: "INR",
      name: s.brandName || "HYPEMAX Nutrition",
      description: `Order ${order.order_number}`,
      prefill: { name: address.name, email: req.user.email, contact: address.phone },
    },
  });
}));

/** Resume payment for an existing unpaid order (e.g. after closing the Razorpay popup). */
router.get("/:number/pay", requireUser, wrap(async (req, res) => {
  const o = await one("SELECT * FROM orders WHERE order_number=? AND user_id=?", [String(req.params.number), req.user.id]);
  if (!o) throw notFound("Order not found");
  if (o.status !== "pending_payment") throw bad(o.payment_status === "successful" ? "This order is already paid" : "This order can no longer be paid. Please place a new order.");
  if (new Date(o.reservation_expires_at) < new Date()) {
    await orders.expireStaleOrders();
    throw bad("The payment window for this order has expired. Please place a new order.");
  }
  const p = await one("SELECT razorpay_order_id FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1", [o.id]);
  if (!p) throw bad("This order can't be paid online. Please place a new order.");
  const s = await getSettings();
  res.json({
    order_number: o.order_number, amount: o.total,
    // BUG-006: prefill the customer's *current* email, not the one captured when the order was created.
    razorpay: { key: rzp.keyId(), order_id: p.razorpay_order_id, amount: o.total, currency: "INR", name: s.brandName || "HYPEMAX Nutrition",
      description: `Order ${o.order_number}`, prefill: { name: o.ship_name, email: req.user.email, contact: o.ship_phone } },
  });
}));

/**
 * POST /api/checkout/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * 1) verify the HMAC signature with our key secret
 * 2) fetch the payment from Razorpay and confirm it's captured/authorized for the exact amount
 * 3) mark the order paid (idempotent; the webhook may get there first)
 */
router.post("/verify", requireUser, rateLimit({ windowMs: 10 * 60e3, max: 30 }), wrap(async (req, res) => {
  const b = req.body || {};
  const oid = str(b.razorpay_order_id, { max: 64, required: true, name: "Order" });
  const pid = str(b.razorpay_payment_id, { max: 64, required: true, name: "Payment" });
  const sig = str(b.razorpay_signature, { max: 128, required: true, name: "Signature" });
  const pay = await one("SELECT p.*, o.user_id, o.order_number FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.razorpay_order_id=?", [oid]);
  if (!pay || pay.user_id !== req.user.id) throw notFound("Payment not found");
  if (!rzp.verifyPaymentSignature(oid, pid, sig)) throw new HttpError(400, "Payment signature verification failed", "BAD_SIGNATURE");

  let entity = await rzp.fetchPayment(pid);
  if (entity.order_id !== oid) throw new HttpError(400, "Payment does not belong to this order", "ORDER_MISMATCH");
  // Check the amount before capturing, so a mismatched payment is never captured (it stays authorized and auto-voids).
  if (Number(entity.amount) !== Number(pay.amount)) throw new HttpError(400, "Payment amount does not match the order", "AMOUNT_MISMATCH");
  if (entity.status === "authorized") entity = await rzp.capture(pid, entity.amount);
  if (entity.status !== "captured") throw new HttpError(402, "Payment has not been completed", "NOT_CAPTURED");
  const r = await orders.markPaid(oid, entity, "checkout");
  res.json({ ok: true, order_number: pay.order_number, already_processed: r.alreadyProcessed });
}));

/** Client reports a failed attempt (for display/analytics only; status still comes from Razorpay). */
router.post("/:number/failed", requireUser, rateLimit({ windowMs: 10 * 60e3, max: 30 }), wrap(async (req, res) => {
  const o = await one("SELECT id FROM orders WHERE order_number=? AND user_id=? AND status='pending_payment'", [String(req.params.number), req.user.id]);
  if (!o) return res.json({ ok: true });
  const e = (req.body && req.body.error) || {};
  const p = await one("SELECT razorpay_order_id FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1", [o.id]);
  if (p) await orders.markAttemptFailed(p.razorpay_order_id, { error_code: String(e.code || "").slice(0, 80), error_description: String(e.description || "Payment failed").slice(0, 255) });
  res.json({ ok: true });
}));

/** Customer abandons an unpaid order: check with Razorpay first, then release stock/coupon. */
router.post("/:number/cancel", requireUser, wrap(async (req, res) => {
  const o = await one("SELECT id, status FROM orders WHERE order_number=? AND user_id=?", [String(req.params.number), req.user.id]);
  if (!o) throw notFound("Order not found");
  if (o.status !== "pending_payment") return res.json({ ok: true, status: o.status });
  if (await orders.reconcile(o.id).catch(() => false)) return res.json({ ok: true, status: "payment_confirmed" });
  await orders.releaseOrder(o.id, "Payment cancelled by customer", "customer", req.user.id, "failed");
  res.json({ ok: true, status: "cancelled" });
}));

/**
 * Razorpay webhook. Mounted with express.raw() so we can verify the HMAC over the exact bytes.
 * Configure in Razorpay Dashboard -> Webhooks: URL https://YOUR-DOMAIN/api/payments/webhook,
 * events: payment.captured, payment.failed, order.paid, refund.processed, refund.failed.
 */
const webhook = express.Router();
webhook.post("/", express.raw({ type: "*/*", limit: "1mb" }), wrap(async (req, res) => {
  const raw = req.body && Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!rzp.verifyWebhookSignature(raw, req.get("x-razorpay-signature"))) return res.status(400).json({ error: "Invalid signature" });
  const evt = JSON.parse(raw);
  const eventId = req.get("x-razorpay-event-id") || `${evt.event}:${evt.created_at}:${JSON.stringify(evt.payload).length}`;
  try {
    // Store only identifiers and amounts; Razorpay payloads also carry customer contact, VPA and card details.
    const pe = (evt.payload && evt.payload.payment && evt.payload.payment.entity) || {};
    const re = (evt.payload && evt.payload.refund && evt.payload.refund.entity) || {};
    const summary = { payment_id: pe.id, order_id: pe.order_id, amount: pe.amount, status: pe.status, method: pe.method, error_code: pe.error_code, refund_id: re.id, refund_amount: re.amount, refund_status: re.status };
    await q("INSERT INTO webhook_events (id, event, payload) VALUES (?,?,?)", [eventId.slice(0, 80), evt.event, JSON.stringify(summary)]);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.json({ ok: true, duplicate: true });
    throw e;
  }
  try {
    const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
    const refund = evt.payload && evt.payload.refund && evt.payload.refund.entity;
    if ((evt.event === "payment.captured" || evt.event === "order.paid") && pay && pay.order_id) {
      if (pay.status === "captured" && (await one("SELECT id FROM payments WHERE razorpay_order_id=?", [pay.order_id]))) await orders.markPaid(pay.order_id, pay, "webhook");
    } else if (evt.event === "payment.failed" && pay && pay.order_id) {
      await orders.markAttemptFailed(pay.order_id, pay);
    } else if ((evt.event === "refund.processed" || evt.event === "refund.failed") && refund) {
      const r = await q("UPDATE refunds SET status=? WHERE razorpay_refund_id=? AND status<>?", [evt.event === "refund.processed" ? "processed" : "failed", refund.id, evt.event === "refund.processed" ? "processed" : "failed"]);
      if (r.affectedRows && evt.event === "refund.processed") {
        const o = await one("SELECT o.* FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.razorpay_refund_id=?", [refund.id]);
        if (o) mail.sendTemplate(o.customer_email, "refund", o, refund.amount, "processed").catch(() => {});
      }
    }
  } catch (e) {
    // Let Razorpay retry: remove the dedupe marker and return 500.
    await q("DELETE FROM webhook_events WHERE id=?", [eventId.slice(0, 80)]);
    throw e;
  }
  res.json({ ok: true });
}));

module.exports = { router, webhook };
