/**
 * Server-side pricing. The ONLY place order amounts are computed.
 * Nothing price-related from the browser is ever trusted: we take product ids,
 * flavours and quantities, then load prices, stock and coupon rules from MySQL.
 *
 * When `lock` is true (order creation), product inventory rows and the coupon row
 * are locked with SELECT ... FOR UPDATE inside the caller's transaction, so two
 * simultaneous orders cannot both consume the last unit of stock or the last coupon use.
 */
const { q } = require("../db");
const { getSettings } = require("./content");
const { HttpError } = require("../util");

const MAX_QTY = 10;

class CouponError extends HttpError {
  constructor(message, code = "COUPON_INVALID") { super(400, message, code); }
}

const normCode = (c) => String(c || "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 40);

async function shippingFor(amountAfterDiscount) {
  const s = await getSettings();
  const fee = Math.round((Number(s.shippingFee) || 0) * 100);
  const freeAbove = Math.round((Number(s.freeShippingAbove) || 0) * 100);
  if (!fee) return 0;
  if (freeAbove && amountAfterDiscount >= freeAbove) return 0;
  return fee;
}

/**
 * Validate a coupon against priced lines. Returns { coupon, discount, allocations }.
 * Throws CouponError with a customer-friendly message when not applicable.
 */
async function evaluateCoupon(conn, code, lines, subtotal, userId, { lock = false, excludeOrderId = null } = {}) {
  const c = normCode(code);
  if (!c || !/^[A-Z0-9_-]{2,40}$/.test(c)) throw new CouponError("Enter a valid coupon code");
  const [coupon] = await q(`SELECT * FROM coupons WHERE code = ? ${lock ? "FOR UPDATE" : ""}`, [c], conn);
  if (!coupon || !coupon.is_active) throw new CouponError("This coupon code is not valid");
  const now = new Date();
  if (coupon.starts_at && new Date(coupon.starts_at) > now) throw new CouponError("This coupon is not active yet", "COUPON_NOT_STARTED");
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) throw new CouponError("This coupon has expired", "COUPON_EXPIRED");
  if (subtotal < coupon.min_order_value)
    throw new CouponError(`Add items worth ₹${((coupon.min_order_value - subtotal) / 100).toLocaleString("en-IN")} more to use this coupon (minimum order ₹${(coupon.min_order_value / 100).toLocaleString("en-IN")})`, "COUPON_MIN_ORDER");

  // Usage limits count both completed uses and uses reserved by orders awaiting payment.
  // With lock=true these are locking reads: they see rows committed by a concurrent order that held
  // the coupon lock before us (a plain read would use this transaction's older REPEATABLE READ snapshot).
  const ex = excludeOrderId ? " AND order_id <> " + Number(excludeOrderId) : "";
  if (coupon.usage_limit != null) {
    const [{ n }] = await q(`SELECT COUNT(*) n FROM coupon_usages WHERE coupon_id=? AND status IN ('reserved','used')${ex} ${lock ? "FOR UPDATE" : ""}`, [coupon.id], conn);
    if (n >= coupon.usage_limit) throw new CouponError("This coupon has reached its usage limit", "COUPON_EXHAUSTED");
  }
  if (coupon.per_customer_limit != null) {
    if (!userId) throw new CouponError("Log in to use this coupon", "COUPON_LOGIN");
    const [{ n }] = await q(`SELECT COUNT(*) n FROM coupon_usages WHERE coupon_id=? AND user_id=? AND status IN ('reserved','used')${ex} ${lock ? "FOR UPDATE" : ""}`, [coupon.id, userId], conn);
    if (n >= coupon.per_customer_limit) throw new CouponError("You have already used this coupon the maximum number of times", "COUPON_USER_LIMIT");
  }

  // Product / category restrictions
  const prodR = (await q("SELECT product_id FROM coupon_products WHERE coupon_id=?", [coupon.id], conn)).map((r) => r.product_id);
  const catR = (await q("SELECT category_id FROM coupon_categories WHERE coupon_id=?", [coupon.id], conn)).map((r) => r.category_id);
  const restricted = prodR.length || catR.length;
  const eligible = lines.filter((l) => !restricted || prodR.includes(l.product_id) || (l.category_id && catR.includes(l.category_id)));
  if (!eligible.length) throw new CouponError("This coupon does not apply to the items in your cart", "COUPON_NOT_ELIGIBLE");
  const eligibleSubtotal = eligible.reduce((s, l) => s + l.line_total, 0);

  let discount = coupon.discount_type === "percent"
    ? Math.floor((eligibleSubtotal * Math.min(100, coupon.discount_value)) / 100)
    : coupon.discount_value;
  if (coupon.max_discount != null) discount = Math.min(discount, coupon.max_discount);
  discount = Math.max(0, Math.min(discount, eligibleSubtotal));
  if (!discount) throw new CouponError("This coupon does not reduce your order total", "COUPON_ZERO");

  // Spread the discount across eligible lines (for invoices). Remainder goes to the last line.
  const allocations = new Map();
  let left = discount;
  eligible.forEach((l, i) => {
    const share = i === eligible.length - 1 ? left : Math.floor((discount * l.line_total) / eligibleSubtotal);
    allocations.set(l.key, share);
    left -= share;
  });
  return { coupon, discount, allocations };
}

/**
 * Price a list of { product_id, flavour, quantity }.
 * mode "preview": unavailable lines are flagged, coupon problems returned as coupon_error.
 * mode "order":   anything wrong throws (used inside the order transaction with lock=true).
 */
async function priceLines(conn, rawLines, { couponCode = null, userId = null, lock = false, mode = "preview", excludeOrderId = null } = {}) {
  const ids = [...new Set(rawLines.map((l) => l.product_id))];
  const products = ids.length
    ? await q(
      `SELECT p.id, p.name, p.slug, p.status, p.mrp, p.price, p.category_id, p.flavours,
              COALESCE(i.stock,0) stock, COALESCE(i.reserved,0) reserved,
              (SELECT url FROM images im WHERE im.owner_type='product' AND im.owner_id=p.id ORDER BY sort_order, id LIMIT 1) image
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.id IN (?) ORDER BY p.id ${lock ? "FOR UPDATE" : ""}`, [ids], conn)
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = [], problems = [];
  // Stock and the per-order limit apply to a product as a whole, across all of its flavour lines
  // (otherwise splitting one product into several lines could oversell it).
  const totalQty = new Map();
  for (const r of rawLines) totalQty.set(r.product_id, (totalQty.get(r.product_id) || 0) + (Number(r.quantity) || 0));

  for (const raw of rawLines) {
    const p = byId.get(raw.product_id);
    const qty = Number(raw.quantity);
    const flavour = String(raw.flavour || "");
    if (!p) { problems.push({ product_id: raw.product_id, message: "This product is no longer available" }); continue; }
    const available = p.stock - p.reserved;
    const flavours = Array.isArray(p.flavours) ? p.flavours : (p.flavours ? JSON.parse(p.flavours) : []);
    let issue = null;
    if (p.status !== "active") issue = p.status === "upcoming" || p.status === "coming_soon" ? `${p.name} is not available for purchase yet` : `${p.name} is currently unavailable`;
    else if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) issue = `Quantity for ${p.name} must be between 1 and ${MAX_QTY}`;
    else if (flavours.length && !flavours.includes(flavour)) issue = `Please choose a valid flavour for ${p.name}`;
    else if (!flavours.length && flavour) issue = `${p.name} has no flavour options. Remove it and add it again`;
    else if (totalQty.get(p.id) > MAX_QTY) issue = `You can order at most ${MAX_QTY} units of ${p.name} in total`;
    else if (available < totalQty.get(p.id)) issue = available > 0 ? `Only ${available} unit(s) of ${p.name} left in stock` : `${p.name} is out of stock`;
    if (issue) {
      if (mode === "order") throw new HttpError(409, issue, "CART_INVALID");
      problems.push({ product_id: p.id, flavour, message: issue });
    }
    lines.push({
      key: `${p.id}|${flavour}`, product_id: p.id, category_id: p.category_id, name: p.name, slug: p.slug, image: p.image,
      flavour, quantity: qty, unit_mrp: p.mrp, unit_price: p.price, line_total: p.price * qty, line_mrp: p.mrp * qty,
      available, purchasable: !issue,
    });
  }

  const priced = lines.filter((l) => l.purchasable);
  const subtotal = priced.reduce((s, l) => s + l.line_total, 0);
  const mrpTotal = priced.reduce((s, l) => s + l.line_mrp, 0);

  let coupon = null, discount = 0, couponError = null, allocations = new Map();
  if (couponCode && priced.length) {
    try {
      const r = await evaluateCoupon(conn, couponCode, priced, subtotal, userId, { lock, excludeOrderId });
      coupon = r.coupon; discount = r.discount; allocations = r.allocations;
    } catch (e) {
      if (mode === "order" || !(e instanceof CouponError)) throw e;
      couponError = { message: e.message, code: e.code };
    }
  }
  for (const l of lines) l.line_discount = allocations.get(l.key) || 0;

  const shipping = priced.length ? await shippingFor(subtotal - discount) : 0;
  const total = subtotal - discount + shipping;
  if (mode === "order") {
    if (!priced.length) throw new HttpError(400, "Your cart is empty", "CART_EMPTY");
    if (total < 100) throw new HttpError(400, "Order total must be at least ₹1", "TOTAL_TOO_LOW");
  }
  return {
    lines, problems, subtotal, mrp_total: mrpTotal, savings_on_mrp: mrpTotal - subtotal,
    discount, shipping, total,
    coupon: coupon ? { id: coupon.id, code: coupon.code, description: coupon.description } : null,
    coupon_error: couponError,
  };
}

module.exports = { priceLines, evaluateCoupon, normCode, CouponError, MAX_QTY };
