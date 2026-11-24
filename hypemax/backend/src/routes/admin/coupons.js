const router = require("express").Router();
const { q, one, tx } = require("../../db");
const { wrap, bad, notFound, optStr, int, bool, toPaise, date, oneOf, HttpError } = require("../../util");
const { can, audit } = require("../../auth");
const { normCode } = require("../../services/pricing");

router.use(can("coupons.manage"));

router.get("/", wrap(async (req, res) => {
  res.json(await q(`SELECT c.*,
      (SELECT COUNT(*) FROM coupon_usages u WHERE u.coupon_id=c.id AND u.status='used') used,
      (SELECT COUNT(*) FROM coupon_usages u WHERE u.coupon_id=c.id AND u.status='reserved') reserved,
      (SELECT COALESCE(SUM(discount_amount),0) FROM coupon_usages u WHERE u.coupon_id=c.id AND u.status='used') total_discount,
      (SELECT COUNT(DISTINCT user_id) FROM coupon_usages u WHERE u.coupon_id=c.id AND u.status='used') customers
    FROM coupons c ORDER BY c.created_at DESC`));
}));

router.get("/:id", wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const c = await one("SELECT * FROM coupons WHERE id=?", [id]);
  if (!c) throw notFound("Coupon not found");
  const [products, categories, usages, [stats]] = await Promise.all([
    q("SELECT product_id FROM coupon_products WHERE coupon_id=?", [id]),
    q("SELECT category_id FROM coupon_categories WHERE coupon_id=?", [id]),
    q(`SELECT cu.id, cu.discount_amount, cu.status, cu.created_at, o.order_number, o.total, u.id user_id, u.name, u.email
       FROM coupon_usages cu JOIN orders o ON o.id=cu.order_id JOIN users u ON u.id=cu.user_id WHERE cu.coupon_id=? ORDER BY cu.created_at DESC LIMIT 500`, [id]),
    q(`SELECT COUNT(*) uses, COALESCE(SUM(discount_amount),0) discount, COUNT(DISTINCT user_id) customers FROM coupon_usages WHERE coupon_id=? AND status='used'`, [id]),
  ]);
  res.json({ ...c, product_ids: products.map((x) => x.product_id), category_ids: categories.map((x) => x.category_id), usages, stats });
}));

function input(b) {
  const type = oneOf(b.discount_type, ["percent", "fixed"], "Discount type");
  const code = normCode(b.code);
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw bad("Coupon code must be 3-40 letters, numbers, dashes or underscores");
  const value = type === "percent" ? int(b.discount_value, { min: 1, max: 100, required: true, name: "Discount %" }) : toPaise(b.discount_value);
  if (!value) throw bad("Discount value is required");
  const starts = date(b.starts_at, "Start date"), expires = date(b.expires_at, "Expiry date");
  if (starts && expires && expires <= starts) throw bad("Expiry must be after the start date");
  return {
    code, discount_type: type, discount_value: value,
    description: optStr(b.description, { max: 255, name: "Description" }),
    min_order_value: toPaise(b.min_order_value) || 0,
    max_discount: b.max_discount === "" || b.max_discount == null ? null : toPaise(b.max_discount),
    starts_at: starts, expires_at: expires,
    usage_limit: int(b.usage_limit, { min: 1, max: 1e7, name: "Total usage limit" }),
    per_customer_limit: int(b.per_customer_limit, { min: 1, max: 1000, name: "Per customer limit" }),
    is_active: b.is_active === undefined ? 1 : bool(b.is_active) ? 1 : 0,
  };
}
const idList = (v) => (Array.isArray(v) ? v : []).map((x) => int(x, { min: 1 })).filter(Boolean);

async function saveRestrictions(conn, id, b) {
  await q("DELETE FROM coupon_products WHERE coupon_id=?", [id], conn);
  await q("DELETE FROM coupon_categories WHERE coupon_id=?", [id], conn);
  const p = idList(b.product_ids), c = idList(b.category_ids);
  if (p.length) await q("INSERT INTO coupon_products (coupon_id, product_id) SELECT ?, id FROM products WHERE id IN (?)", [id, p], conn);
  if (c.length) await q("INSERT INTO coupon_categories (coupon_id, category_id) SELECT ?, id FROM categories WHERE id IN (?)", [id, c], conn);
}

router.post("/", wrap(async (req, res) => {
  const c = input(req.body || {});
  if (await one("SELECT id FROM coupons WHERE code=?", [c.code])) throw new HttpError(409, "A coupon with this code already exists");
  const id = await tx(async (conn) => {
    const r = await q("INSERT INTO coupons SET ?", [c], conn);
    await saveRestrictions(conn, r.insertId, req.body);
    return r.insertId;
  });
  await audit(req, "coupon.create", "coupon", id, { ...c, product_ids: req.body.product_ids, category_ids: req.body.category_ids });
  res.status(201).json({ id });
}));

router.put("/:id", wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const before = await one("SELECT * FROM coupons WHERE id=?", [id]);
  if (!before) throw notFound("Coupon not found");
  const c = input(req.body || {});
  if (c.code !== before.code && (await one("SELECT id FROM coupons WHERE code=? AND id<>?", [c.code, id]))) throw new HttpError(409, "A coupon with this code already exists");
  await tx(async (conn) => {
    await q("UPDATE coupons SET ? WHERE id=?", [c, id], conn);
    await saveRestrictions(conn, id, req.body);
  });
  await audit(req, "coupon.update", "coupon", id, { before: { code: before.code, value: before.discount_value, active: before.is_active }, after: c });
  res.json({ ok: true });
}));

router.post("/:id/active", wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const active = bool(req.body && req.body.is_active);
  await q("UPDATE coupons SET is_active=? WHERE id=?", [active ? 1 : 0, id]);
  await audit(req, active ? "coupon.activate" : "coupon.deactivate", "coupon", id);
  res.json({ ok: true });
}));

router.delete("/:id", wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const c = await one("SELECT code FROM coupons WHERE id=?", [id]);
  if (!c) throw notFound();
  const used = await one("SELECT 1 x FROM coupon_usages WHERE coupon_id=? LIMIT 1", [id]);
  if (used) throw bad("This coupon has been used on orders. Deactivate it instead so usage history is kept.");
  await q("DELETE FROM coupons WHERE id=?", [id]);
  await audit(req, "coupon.delete", "coupon", id, { code: c.code });
  res.json({ ok: true });
}));

module.exports = router;
