const router = require("express").Router();
const { q } = require("../../db");
const { wrap, toCsv } = require("../../util");
const { can, audit } = require("../../auth");
const { resolveRange } = require("./range");

const PAID = "('successful','partially_refunded','refunded')";
const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : 0);

/** All dashboard numbers come straight from MySQL for the selected range. */
router.get("/dashboard", can("dashboard.view"), wrap(async (req, res) => {
  const r = resolveRange(req.query);
  const P = [r.from, r.to];
  const [[cust], [ord], [pay], [prod], [coup], [traffic], [funnel]] = await Promise.all([
    q(`SELECT COUNT(*) total, SUM(created_at >= ? AND created_at < ?) new_in_range FROM users`, P),
    q(`SELECT
         SUM(paid_at >= ? AND paid_at < ?) orders,
         COALESCE(SUM(CASE WHEN paid_at >= ? AND paid_at < ? THEN total - refunded_amount END),0) revenue,
         COALESCE(SUM(CASE WHEN paid_at >= ? AND paid_at < ? THEN total END),0) gross_revenue,
         SUM(status='cancelled' AND paid_at IS NOT NULL AND cancelled_at >= ? AND cancelled_at < ?) cancelled,
         SUM(status IN ('order_placed','payment_confirmed','processing','packed')) awaiting_fulfilment
       FROM orders`, [...P, ...P, ...P, ...P]),
    q(`SELECT SUM(status IN ${PAID}) successful, SUM(status='pending') pending, SUM(status='failed') failed,
         SUM(status IN ('refunded','partially_refunded')) refunded FROM payments WHERE created_at >= ? AND created_at < ?`, P),
    q(`SELECT COUNT(*) total, SUM(p.status='active') active,
         SUM(p.status='active' AND COALESCE(i.stock,0)-COALESCE(i.reserved,0) > 0 AND COALESCE(i.stock,0)-COALESCE(i.reserved,0) <= COALESCE(i.low_stock_threshold,10)) low_stock,
         SUM(p.status='out_of_stock' OR (p.status='active' AND COALESCE(i.stock,0)-COALESCE(i.reserved,0) <= 0)) out_of_stock,
         SUM(p.status IN ('upcoming','coming_soon')) upcoming
       FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.status <> 'discontinued'`),
    q(`SELECT COUNT(*) uses, COALESCE(SUM(discount_amount),0) discount FROM coupon_usages WHERE status='used' AND created_at >= ? AND created_at < ?`, P),
    q(`SELECT COUNT(*) sessions, COUNT(DISTINCT visitor_id) unique_visitors, COUNT(DISTINCT CASE WHEN user_id IS NULL THEN visitor_id END) anonymous_visitors,
         COUNT(DISTINCT user_id) logged_in_customers FROM visitor_sessions WHERE started_at >= ? AND started_at < ?`, P),
    q(`SELECT SUM(event_type='page_view') page_views,
         SUM(event_type='page_view' AND path='/') home_views,
         SUM(event_type='product_view') product_views,
         SUM(event_type='add_to_cart') add_to_cart,
         SUM(event_type='remove_from_cart') remove_from_cart,
         SUM(event_type='checkout_start') checkout_start,
         COUNT(DISTINCT CASE WHEN event_type='add_to_cart' THEN session_id END) cart_sessions,
         COUNT(DISTINCT CASE WHEN event_type='checkout_start' THEN session_id END) checkout_sessions
       FROM analytics_events WHERE created_at >= ? AND created_at < ?`, P),
  ]);
  const purchases = Number(ord.orders || 0);
  res.json({
    range: { label: r.label, from: r.from, to: r.to },
    customers: { total: cust.total, new: Number(cust.new_in_range || 0) },
    orders: { total: purchases, cancelled: Number(ord.cancelled || 0), awaiting_fulfilment: Number(ord.awaiting_fulfilment || 0) },
    revenue: { net: Number(ord.revenue), gross: Number(ord.gross_revenue), average_order: purchases ? Math.round(Number(ord.gross_revenue) / purchases) : 0 },
    payments: { successful: Number(pay.successful || 0), pending: Number(pay.pending || 0), failed: Number(pay.failed || 0), refunded: Number(pay.refunded || 0) },
    products: { total: prod.total, active: Number(prod.active || 0), low_stock: Number(prod.low_stock || 0), out_of_stock: Number(prod.out_of_stock || 0), upcoming: Number(prod.upcoming || 0) },
    coupons: { uses: coup.uses, discount: Number(coup.discount) },
    traffic: {
      visits: traffic.sessions, unique_visitors: traffic.unique_visitors, anonymous_visitors: traffic.anonymous_visitors, logged_in_customers: traffic.logged_in_customers,
      page_views: Number(funnel.page_views || 0), home_views: Number(funnel.home_views || 0), product_views: Number(funnel.product_views || 0),
      add_to_cart: Number(funnel.add_to_cart || 0), remove_from_cart: Number(funnel.remove_from_cart || 0), checkout_start: Number(funnel.checkout_start || 0),
      purchases,
      conversion_rate: pct(purchases, traffic.sessions),
      cart_abandonment_rate: funnel.cart_sessions ? Math.max(0, pct(funnel.cart_sessions - purchases, funnel.cart_sessions)) : 0,
    },
  });
}));

/** Time series + breakdowns for the analytics page. */
router.get("/analytics", can("analytics.view"), wrap(async (req, res) => {
  const r = resolveRange(req.query);
  const P = [r.from, r.to];
  // Group by IST date
  const D = (col) => `DATE(CONVERT_TZ(${col}, '+00:00', '+05:30'))`;
  const [sales, traffic, top, viewed, sources, devices, pages] = await Promise.all([
    q(`SELECT ${D("paid_at")} d, COUNT(*) orders, SUM(total) revenue FROM orders WHERE paid_at >= ? AND paid_at < ? GROUP BY d ORDER BY d`, P),
    q(`SELECT ${D("started_at")} d, COUNT(*) visits, COUNT(DISTINCT visitor_id) visitors FROM visitor_sessions WHERE started_at >= ? AND started_at < ? GROUP BY d ORDER BY d`, P),
    q(`SELECT oi.product_id, oi.product_name name, SUM(oi.quantity) units, SUM(oi.line_total - oi.line_discount) revenue
       FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.paid_at >= ? AND o.paid_at < ? GROUP BY oi.product_id, oi.product_name ORDER BY units DESC LIMIT 10`, P),
    q(`SELECT e.product_id, p.name, COUNT(*) views FROM analytics_events e JOIN products p ON p.id=e.product_id
       WHERE e.event_type='product_view' AND e.created_at >= ? AND e.created_at < ? GROUP BY e.product_id, p.name ORDER BY views DESC LIMIT 10`, P),
    q(`SELECT COALESCE(source,'direct') source, COUNT(*) visits FROM visitor_sessions WHERE started_at >= ? AND started_at < ? GROUP BY source ORDER BY visits DESC LIMIT 12`, P),
    q(`SELECT device, COUNT(*) visits FROM visitor_sessions WHERE started_at >= ? AND started_at < ? GROUP BY device ORDER BY visits DESC`, P),
    q(`SELECT path, COUNT(*) views FROM analytics_events WHERE event_type='page_view' AND created_at >= ? AND created_at < ? GROUP BY path ORDER BY views DESC LIMIT 15`, P),
  ]);
  const fmt = (rows) => rows.map((x) => ({ ...x, d: x.d instanceof Date ? x.d.toISOString().slice(0, 10) : String(x.d) }));
  res.json({ range: { label: r.label, from: r.from, to: r.to }, sales: fmt(sales), traffic: fmt(traffic), top_products: top, most_viewed: viewed, sources, devices, pages });
}));

/** Daily sales report (IST dates) as CSV for accounting. */
router.get("/reports/sales.csv", can("analytics.view"), wrap(async (req, res) => {
  const r = resolveRange(req.query);
  const D = (col) => `DATE(CONVERT_TZ(${col}, '+00:00', '+05:30'))`;
  const rows = await q(`SELECT ${D("paid_at")} d, COUNT(*) orders, SUM(subtotal) subtotal, SUM(discount) discount, SUM(shipping_fee) shipping,
      SUM(total) gross, SUM(refunded_amount) refunded, SUM(total - refunded_amount) net, SUM(u.units) units
    FROM orders o JOIN (SELECT order_id, SUM(quantity) units FROM order_items GROUP BY order_id) u ON u.order_id=o.id
    WHERE paid_at >= ? AND paid_at < ? GROUP BY d ORDER BY d`, [r.from, r.to]);
  const rs = (k) => (x) => (Number(x[k] || 0) / 100).toFixed(2);
  const csv = toCsv(rows.map((x) => ({ ...x, d: x.d instanceof Date ? x.d.toISOString().slice(0, 10) : x.d })),
    [["d", "Date (IST)"], ["orders", "Paid orders"], ["units", "Units"], [rs("subtotal"), "Subtotal (INR)"], [rs("discount"), "Coupon discounts"], [rs("shipping"), "Shipping"], [rs("gross"), "Gross"], [rs("refunded"), "Refunded"], [rs("net"), "Net"]]);
  await audit(req, "reports.sales_export", "report", null, { range: r.label });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="hypemax-sales-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + csv);
}));

/** Recent activity (orders + low stock) for the overview. */
router.get("/activity", can("dashboard.view"), wrap(async (req, res) => {
  const [orders, lowStock] = await Promise.all([
    q(`SELECT order_number, status, payment_status, total, ship_name, created_at FROM orders WHERE status<>'pending_payment' ORDER BY created_at DESC LIMIT 8`),
    q(`SELECT p.id, p.name, p.status, i.stock, i.reserved, i.low_stock_threshold FROM products p JOIN inventory i ON i.product_id=p.id
       WHERE p.status='active' AND i.stock - i.reserved <= i.low_stock_threshold ORDER BY i.stock - i.reserved LIMIT 10`),
  ]);
  res.json({ orders, low_stock: lowStock });
}));

module.exports = router;
