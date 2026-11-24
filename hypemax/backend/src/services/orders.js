const config = require("../config");
const { q, one, tx } = require("../db");
const { priceLines } = require("./pricing");
const rzp = require("./razorpay");
const mail = require("./mail");
const { HttpError, bad, notFound, rupees } = require("../util");

const STATUS_LABEL = {
  pending_payment: "Awaiting payment", order_placed: "Order placed", payment_confirmed: "Payment confirmed",
  processing: "Processing", packed: "Packed", shipped: "Shipped", out_for_delivery: "Out for delivery",
  delivered: "Delivered", cancelled: "Cancelled", returned: "Returned",
};
// Statuses an admin can move a paid order to (cancel / return go through their own flows).
const FULFILMENT = ["payment_confirmed", "processing", "packed", "shipped", "out_for_delivery", "delivered"];

const newOrderNumber = () => {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, "");
  return `HM${ymd}${Math.floor(Math.random() * 1e6).toString().padStart(6, "0")}`;
};

async function history(conn, orderId, status, note, actorType = "system", actorId = null) {
  await q("INSERT INTO order_status_history (order_id, status, note, actor_type, actor_id) VALUES (?,?,?,?,?)",
    [orderId, status, note || null, actorType, actorId], conn);
}
/**
 * BUG-006: order emails used the address captured when the order was placed, so a customer who later changed
 * their email kept receiving mail at the old one. Send to the account's current email; fall back to the stored copy.
 */
async function emailFor(order) {
  if (order && order.user_id) {
    const u = await one("SELECT email FROM users WHERE id=?", [order.user_id]).catch(() => null);
    if (u && u.email) return u.email;
  }
  return order && order.customer_email;
}
async function notify(conn, userId, title, body, link) {
  await q("INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)", [userId, title, body || null, link || null], conn);
}

async function cartLines(conn, userId) {
  return q(`SELECT ci.product_id, ci.flavour, ci.quantity FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.user_id = ? ORDER BY ci.id`, [userId], conn);
}

/**
 * Create a pending order from the user's server-side cart, reserve stock and coupon,
 * then create the matching Razorpay order. Amounts are computed here, never accepted from the client.
 */
async function createOrder(user, { address, couponCode, notes }) {
  if (!rzp.enabled()) throw new HttpError(503, "Online payments are not configured yet. Please contact us on WhatsApp to order.", "RAZORPAY_MISSING");
  const order = await tx(async (conn) => {
    const lines = await cartLines(conn, user.id);
    if (!lines.length) throw bad("Your cart is empty", "CART_EMPTY");
    const pr = await priceLines(conn, lines, { couponCode, userId: user.id, lock: true, mode: "order" });

    let number;
    for (let i = 0; i < 5; i++) { number = newOrderNumber(); if (!(await one("SELECT id FROM orders WHERE order_number=?", [number], conn))) break; }
    const expires = new Date(Date.now() + config.orderReservationMinutes * 60e3);
    const r = await q(
      `INSERT INTO orders (order_number, user_id, status, payment_status, subtotal, mrp_total, discount, shipping_fee, total,
        coupon_id, coupon_code, ship_name, ship_phone, ship_line1, ship_line2, ship_city, ship_state, ship_pincode, customer_email, notes, reservation_expires_at)
       VALUES (?,?,'pending_payment','pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [number, user.id, pr.subtotal, pr.mrp_total, pr.discount, pr.shipping, pr.total,
        pr.coupon ? pr.coupon.id : null, pr.coupon ? pr.coupon.code : null,
        address.name, address.phone, address.line1, address.line2 || null, address.city, address.state, address.pincode,
        user.email, notes || null, expires], conn);
    const orderId = r.insertId;
    for (const l of pr.lines) {
      await q(`INSERT INTO order_items (order_id, product_id, product_name, product_slug, image_url, flavour, unit_mrp, unit_price, quantity, line_total, line_discount)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [orderId, l.product_id, l.name, l.slug, l.image, l.flavour, l.unit_mrp, l.unit_price, l.quantity, l.line_total, l.line_discount], conn);
      await q("UPDATE inventory SET reserved = reserved + ? WHERE product_id = ?", [l.quantity, l.product_id], conn);
    }
    if (pr.coupon) await q("INSERT INTO coupon_usages (coupon_id, user_id, order_id, discount_amount, status) VALUES (?,?,?,?, 'reserved')",
      [pr.coupon.id, user.id, orderId, pr.discount], conn);
    await history(conn, orderId, "pending_payment", "Order created, awaiting payment", "customer", user.id);
    return { id: orderId, order_number: number, total: pr.total };
  });

  try {
    const ro = await rzp.createOrder(order.total, order.order_number, { order_number: order.order_number, user_id: String(user.id) });
    if (ro.amount !== order.total) throw new HttpError(502, "Payment gateway amount mismatch");
    await q("INSERT INTO payments (order_id, razorpay_order_id, amount, currency, status) VALUES (?,?,?,?, 'pending')",
      [order.id, ro.id, order.total, "INR"]);
    return { ...order, razorpay_order_id: ro.id };
  } catch (e) {
    await releaseOrder(order.id, "Could not start payment: " + e.message, "system");
    throw e;
  }
}

/**
 * Mark a payment successful. Idempotent: safe to call from both the checkout callback and
 * the webhook. Returns { order, alreadyProcessed }.
 */
async function markPaid(razorpayOrderId, paymentEntity, via) {
  return tx(async (conn) => {
    const [pay] = await q("SELECT * FROM payments WHERE razorpay_order_id=? FOR UPDATE", [razorpayOrderId], conn);
    if (!pay) throw notFound("Payment record not found");
    const [order] = await q("SELECT * FROM orders WHERE id=? FOR UPDATE", [pay.order_id], conn);
    if (pay.status !== "pending" && pay.status !== "failed") return { order, alreadyProcessed: true };
    if (Number(paymentEntity.amount) !== pay.amount || (paymentEntity.currency && paymentEntity.currency !== "INR"))
      throw new HttpError(400, "Payment amount does not match the order", "AMOUNT_MISMATCH");

    await q(`UPDATE payments SET status='successful', razorpay_payment_id=?, method=?, verified_via=?, paid_at=UTC_TIMESTAMP(), error_code=NULL, error_description=NULL WHERE id=?`,
      [paymentEntity.id, paymentEntity.method || null, via, pay.id], conn);

    const items = await q("SELECT product_id, quantity FROM order_items WHERE order_id=?", [order.id], conn);
    // A payment can land after the order was cancelled/expired (the Razorpay popup stayed open). By then its
    // stock and coupon were given back and may have been used by someone else, so re-check both under lock.
    // If either is gone, the order is confirmed and then immediately cancelled with a full refund (below).
    let lateConflict = null;
    if (order.stock_released) {
      for (const it of items) {
        if (!it.product_id) continue;
        const [inv] = await q("SELECT stock - reserved avail FROM inventory WHERE product_id=? FOR UPDATE", [it.product_id], conn);
        if (!inv || inv.avail < it.quantity) { lateConflict = "Payment arrived after the order had expired and the item is no longer in stock"; break; }
      }
      if (!lateConflict && order.coupon_id) {
        const [c] = await q("SELECT usage_limit, per_customer_limit FROM coupons WHERE id=? FOR UPDATE", [order.coupon_id], conn);
        const [{ n }] = await q("SELECT COUNT(*) n FROM coupon_usages WHERE coupon_id=? AND status IN ('reserved','used') AND order_id<>?", [order.coupon_id, order.id], conn);
        const [{ m }] = await q("SELECT COUNT(*) m FROM coupon_usages WHERE coupon_id=? AND user_id=? AND status IN ('reserved','used') AND order_id<>?", [order.coupon_id, order.user_id, order.id], conn);
        if (c && ((c.usage_limit != null && n >= c.usage_limit) || (c.per_customer_limit != null && m >= c.per_customer_limit)))
          lateConflict = "Payment arrived after the order had expired and its coupon had already been used";
      }
    }
    const lateNote = order.stock_released ? " (payment arrived after the reservation had been released)" : "";
    for (const it of items) {
      if (!it.product_id) continue;
      if (order.stock_released) await q("UPDATE inventory SET stock = stock - ? WHERE product_id=?", [it.quantity, it.product_id], conn);
      else await q("UPDATE inventory SET stock = stock - ?, reserved = GREATEST(reserved - ?, 0) WHERE product_id=?", [it.quantity, it.quantity, it.product_id], conn);
      await q("INSERT INTO inventory_movements (product_id, change_qty, reason, order_id) VALUES (?,?, 'sale', ?)", [it.product_id, -it.quantity, order.id], conn);
    }
    await q("UPDATE coupon_usages SET status='used' WHERE order_id=?", [order.id], conn);
    await q(`UPDATE orders SET status='payment_confirmed', payment_status='successful', paid_at=UTC_TIMESTAMP(), stock_released=0,
             cancelled_at=NULL, cancel_reason=NULL, reservation_expires_at=NULL WHERE id=?`, [order.id], conn);
    await history(conn, order.id, "order_placed", "Order placed", "system");
    await history(conn, order.id, "payment_confirmed", `Payment ${paymentEntity.id} verified via ${via}${lateNote}`, "system");
    // Remove purchased lines from the customer's cart
    await q(`DELETE ci FROM cart_items ci JOIN carts c ON c.id=ci.cart_id JOIN order_items oi ON oi.order_id=? AND oi.product_id=ci.product_id AND oi.flavour=ci.flavour WHERE c.user_id=?`,
      [order.id, order.user_id], conn);
    await notify(conn, order.user_id, `Order ${order.order_number} confirmed`, `We received your payment of ${rupees(order.total)}.`, `/account/orders/${order.order_number}`);
    await q("INSERT INTO analytics_events (session_id, visitor_id, user_id, event_type, order_id, value) VALUES ('server','server',?, 'purchase', ?, ?)",
      [order.user_id, order.id, order.total], conn);
    return { order: { ...order, status: "payment_confirmed", payment_status: "successful" }, alreadyProcessed: false, lateConflict };
  }).then(async (r) => {
    if (r.lateConflict) {
      // Restocks, releases the coupon and refunds the full amount through Razorpay.
      const c = await cancelPaidOrder(r.order.id, r.lateConflict + ". Your payment has been refunded in full.", { type: "system" }).catch((e) => ({ refund_error: e.message }));
      return { ...r, order: { ...r.order, status: "cancelled" }, refunded: !!c.refund, refund_error: c.refund_error || null };
    }
    if (!r.alreadyProcessed) {
      orderDetail("id=?", [r.order.id]).then(async (full) => {
        await mail.sendTemplate(await emailFor(full), "orderConfirmed", full);
        await mail.sendTemplate(await mail.adminRecipients(), "adminNewOrder", full);
      }).catch(() => {});
    }
    return r;
  });
}

/** Record a failed attempt (order stays payable until the reservation expires). */
async function markAttemptFailed(razorpayOrderId, paymentEntity) {
  await q(`UPDATE payments SET error_code=?, error_description=?, razorpay_payment_id=COALESCE(razorpay_payment_id, NULL)
           WHERE razorpay_order_id=? AND status='pending'`,
    [paymentEntity.error_code || "PAYMENT_FAILED", String(paymentEntity.error_description || "Payment failed").slice(0, 255), razorpayOrderId]);
}

/** Cancel an unpaid order and give back reserved stock + coupon. Idempotent. */
async function releaseOrder(orderId, reason, actorType = "system", actorId = null, paymentStatus = "failed") {
  return tx(async (conn) => {
    const [order] = await q("SELECT * FROM orders WHERE id=? FOR UPDATE", [orderId], conn);
    if (!order || order.status !== "pending_payment" || order.stock_released) return false;
    const items = await q("SELECT product_id, quantity FROM order_items WHERE order_id=?", [orderId], conn);
    for (const it of items) if (it.product_id) await q("UPDATE inventory SET reserved = GREATEST(reserved - ?, 0) WHERE product_id=?", [it.quantity, it.product_id], conn);
    await q("UPDATE coupon_usages SET status='released' WHERE order_id=? AND status='reserved'", [orderId], conn);
    await q("UPDATE orders SET status='cancelled', payment_status=?, stock_released=1, cancelled_at=UTC_TIMESTAMP(), cancel_reason=? WHERE id=?",
      [paymentStatus, String(reason).slice(0, 255), orderId], conn);
    await q("UPDATE payments SET status='failed', error_description=COALESCE(error_description, ?) WHERE order_id=? AND status='pending'", [String(reason).slice(0, 255), orderId], conn);
    await history(conn, orderId, "cancelled", reason, actorType, actorId);
    return true;
  });
}

/**
 * Before giving up on an unpaid order, ask Razorpay whether a payment actually went through
 * (customer closed the tab after paying, webhook delayed, etc.).
 */
async function reconcile(orderId) {
  const pay = await one("SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1", [orderId]);
  if (!pay || !rzp.enabled()) return false;
  const list = await rzp.fetchOrderPayments(pay.razorpay_order_id);
  const captured = list.find((p) => p.status === "captured");
  if (captured) { await markPaid(pay.razorpay_order_id, captured, "reconcile"); return true; }
  const authorized = list.find((p) => p.status === "authorized");
  if (authorized) {
    const c = await rzp.capture(authorized.id, authorized.amount);
    await markPaid(pay.razorpay_order_id, c, "reconcile");
    return true;
  }
  return false;
}

/** Periodic job: expire unpaid orders whose reservation window has passed. */
async function expireStaleOrders() {
  const rows = await q("SELECT id FROM orders WHERE status='pending_payment' AND stock_released=0 AND reservation_expires_at < UTC_TIMESTAMP() LIMIT 50");
  for (const r of rows) {
    try {
      if (await reconcile(r.id)) continue;
      await releaseOrder(r.id, "Payment not completed in time", "system");
    } catch (e) { console.error("expire order", r.id, e.message); }
  }
}

/** Issue a Razorpay refund (full or partial) for a paid order. */
async function refundOrder(orderId, amountPaise, reason, actor = {}) {
  const order = await one("SELECT * FROM orders WHERE id=?", [orderId]);
  if (!order) throw notFound("Order not found");
  const pay = await one("SELECT * FROM payments WHERE order_id=? AND status IN ('successful','partially_refunded') ORDER BY id DESC LIMIT 1", [orderId]);
  if (!pay || !pay.razorpay_payment_id) throw bad("This order has no successful payment to refund");
  const refundable = order.total - order.refunded_amount;
  const amount = amountPaise == null ? refundable : amountPaise;
  if (!Number.isInteger(amount) || amount < 100 || amount > refundable) throw bad(`Refund amount must be between ₹1 and ${rupees(refundable)}`);

  // Reserve the amount first so two admins can't double-refund.
  const refundRow = await tx(async (conn) => {
    const [o] = await q("SELECT total, refunded_amount FROM orders WHERE id=? FOR UPDATE", [orderId], conn);
    if (amount > o.total - o.refunded_amount) throw bad("Refund exceeds the remaining refundable amount");
    await q("UPDATE orders SET refunded_amount = refunded_amount + ? WHERE id=?", [amount, orderId], conn);
    const r = await q("INSERT INTO refunds (order_id, payment_id, amount, reason, status, admin_id) VALUES (?,?,?,?, 'pending', ?)",
      [orderId, pay.id, amount, reason || null, actor.adminId || null], conn);
    return r.insertId;
  });

  let rf;
  try {
    rf = await rzp.refund(pay.razorpay_payment_id, amount, { order_number: order.order_number, reason: String(reason || "").slice(0, 200) });
  } catch (e) {
    await tx(async (conn) => {
      await q("UPDATE orders SET refunded_amount = refunded_amount - ? WHERE id=?", [amount, orderId], conn);
      await q("UPDATE refunds SET status='failed' WHERE id=?", [refundRow], conn);
    });
    throw e;
  }
  await tx(async (conn) => {
    await q("UPDATE refunds SET razorpay_refund_id=?, status=? WHERE id=?", [rf.id, rf.status === "processed" ? "processed" : "pending", refundRow], conn);
    const [o] = await q("SELECT total, refunded_amount FROM orders WHERE id=? FOR UPDATE", [orderId], conn);
    const ps = o.refunded_amount >= o.total ? "refunded" : "partially_refunded";
    await q("UPDATE orders SET payment_status=? WHERE id=?", [ps, orderId], conn);
    await q("UPDATE payments SET status=? WHERE id=?", [ps, pay.id], conn);
    await history(conn, orderId, "refund", `Refund of ${rupees(amount)} initiated (${rf.id})${reason ? ": " + reason : ""}`, actor.type || "admin", actor.adminId || null);
    await notify(conn, order.user_id, `Refund initiated for ${order.order_number}`, `${rupees(amount)} will be credited to your original payment method in 5-7 working days.`, `/account/orders/${order.order_number}`);
  });
  emailFor(order).then((to) => mail.sendTemplate(to, "refund", order, amount, rf.status === "processed" ? "processed" : "initiated").catch(() => {}));
  return { refund_id: rf.id, amount };
}

/**
 * Cancel a paid order (customer before packing, or admin anytime before delivery):
 * restock, release coupon, refund the remaining amount.
 */
async function cancelPaidOrder(orderId, reason, actor) {
  const order = await tx(async (conn) => {
    const [o] = await q("SELECT * FROM orders WHERE id=? FOR UPDATE", [orderId], conn);
    if (!o) throw notFound("Order not found");
    const allowed = actor.type === "admin" ? ["order_placed", "payment_confirmed", "processing", "packed", "shipped", "out_for_delivery"] : ["order_placed", "payment_confirmed", "processing"];
    if (!allowed.includes(o.status)) throw bad(actor.type === "admin" ? "This order can no longer be cancelled" : "This order can no longer be cancelled online. Please contact support.");
    const items = await q("SELECT product_id, quantity FROM order_items WHERE order_id=?", [orderId], conn);
    for (const it of items) if (it.product_id) {
      await q("UPDATE inventory SET stock = stock + ? WHERE product_id=?", [it.quantity, it.product_id], conn);
      await q("INSERT INTO inventory_movements (product_id, change_qty, reason, order_id, admin_id) VALUES (?,?, 'cancel_restock', ?, ?)", [it.product_id, it.quantity, orderId, actor.adminId || null], conn);
    }
    await q("UPDATE coupon_usages SET status='released' WHERE order_id=?", [orderId], conn);
    await q("UPDATE orders SET status='cancelled', cancelled_at=UTC_TIMESTAMP(), cancel_reason=? WHERE id=?", [String(reason || "").slice(0, 255), orderId], conn);
    await history(conn, orderId, "cancelled", reason || "Order cancelled", actor.type, actor.adminId || actor.userId || null);
    await notify(conn, o.user_id, `Order ${o.order_number} cancelled`, reason || null, `/account/orders/${o.order_number}`);
    return o;
  });
  emailFor(order).then((to) => mail.sendTemplate(to, "cancelled", order, reason).catch(() => {}));
  let refund = null, refundError = null;
  if (order.payment_status === "successful" || order.payment_status === "partially_refunded") {
    try { refund = await refundOrder(orderId, null, "Order cancelled" + (reason ? ": " + reason : ""), actor); }
    catch (e) { refundError = e.message; }
  }
  return { refund, refund_error: refundError };
}

/** Admin fulfilment status change (with optional shipment details). */
async function updateStatus(orderId, status, note, adminId) {
  if (!FULFILMENT.includes(status)) throw bad("Use the cancel or return actions for that status");
  return tx(async (conn) => {
    const [o] = await q("SELECT * FROM orders WHERE id=? FOR UPDATE", [orderId], conn);
    if (!o) throw notFound("Order not found");
    if (!["successful", "partially_refunded"].includes(o.payment_status)) throw bad("Only paid orders can be fulfilled");
    if (["cancelled", "returned"].includes(o.status)) throw bad(`This order is ${STATUS_LABEL[o.status].toLowerCase()}`);
    if (o.status === status) return o;
    await q("UPDATE orders SET status=? WHERE id=?", [status, orderId], conn);
    if (status === "shipped") await q("UPDATE shipments SET shipped_at=COALESCE(shipped_at, UTC_TIMESTAMP()) WHERE order_id=?", [orderId], conn);
    if (status === "delivered") await q("UPDATE shipments SET delivered_at=COALESCE(delivered_at, UTC_TIMESTAMP()) WHERE order_id=?", [orderId], conn);
    await history(conn, orderId, status, note, "admin", adminId);
    await notify(conn, o.user_id, `Order ${o.order_number}: ${STATUS_LABEL[status]}`, note || null, `/account/orders/${o.order_number}`);
    return { ...o, status };
  }).then((o) => {
    one("SELECT * FROM shipments WHERE order_id=?", [o.id]).then((sh) => emailFor(o).then((to) => mail.sendTemplate(to, "statusUpdate", o, STATUS_LABEL[status], note, sh)).catch(() => {}));
    return o;
  });
}

async function markReturned(orderId, note, adminId) {
  return tx(async (conn) => {
    const [o] = await q("SELECT * FROM orders WHERE id=? FOR UPDATE", [orderId], conn);
    if (!o) throw notFound("Order not found");
    if (!["delivered", "out_for_delivery", "shipped"].includes(o.status)) throw bad("Only shipped or delivered orders can be marked returned");
    await q("UPDATE orders SET status='returned' WHERE id=?", [orderId], conn);
    await history(conn, orderId, "returned", note, "admin", adminId);
    await notify(conn, o.user_id, `Order ${o.order_number} returned`, note || "Your return has been recorded. Refunds are processed separately.", `/account/orders/${o.order_number}`);
  });
}

/** Full order detail (items, payments, refunds, shipment, history). */
async function orderDetail(where, params) {
  const o = await one(`SELECT * FROM orders WHERE ${where}`, params);
  if (!o) return null;
  const [items, payments, refunds, shipment, hist] = await Promise.all([
    q("SELECT * FROM order_items WHERE order_id=? ORDER BY id", [o.id]),
    q("SELECT id, razorpay_order_id, razorpay_payment_id, amount, status, method, error_code, error_description, verified_via, paid_at, created_at FROM payments WHERE order_id=? ORDER BY id", [o.id]),
    q("SELECT id, razorpay_refund_id, amount, reason, status, created_at FROM refunds WHERE order_id=? ORDER BY id", [o.id]),
    one("SELECT * FROM shipments WHERE order_id=?", [o.id]),
    q("SELECT status, note, actor_type, created_at FROM order_status_history WHERE order_id=? ORDER BY id", [o.id]),
  ]);
  return { ...o, status_label: STATUS_LABEL[o.status], items, payments, refunds, shipment, history: hist };
}

module.exports = {
  STATUS_LABEL, FULFILMENT, createOrder, markPaid, markAttemptFailed, releaseOrder, reconcile, expireStaleOrders,
  refundOrder, cancelPaidOrder, updateStatus, markReturned, orderDetail, history, notify,
};
