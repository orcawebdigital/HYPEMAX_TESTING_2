const config = require("../config");
const { q, one, tx } = require("../db");
const { randomToken, sha256 } = require("../util");

const CART_COOKIE = "hm_cart";

/** Find (or create) the cart for this request: user cart if logged in, else guest cart via cookie token. */
async function getCartId(req, res, { create = false } = {}) {
  if (req.user) {
    const c = await one("SELECT id FROM carts WHERE user_id=?", [req.user.id]);
    if (c) return c.id;
    if (!create) return null;
    const r = await q("INSERT INTO carts (user_id) VALUES (?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)", [req.user.id]);
    return r.insertId;
  }
  const t = req.cookies[CART_COOKIE];
  if (t && /^[a-f0-9]{64}$/.test(t)) {
    const c = await one("SELECT id FROM carts WHERE token_hash=? AND user_id IS NULL", [sha256(t)]);
    if (c) return c.id;
  }
  if (!create) return null;
  const token = randomToken(32);
  const r = await q("INSERT INTO carts (token_hash) VALUES (?)", [sha256(token)]);
  res.cookie(CART_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/", maxAge: 30 * 864e5 });
  req.cookies[CART_COOKIE] = token; // visible to the rest of this request
  return r.insertId;
}

async function cartLines(cartId) {
  if (!cartId) return [];
  return q("SELECT product_id, flavour, quantity FROM cart_items WHERE cart_id=? ORDER BY id", [cartId]);
}

/** After login/registration: move guest cart lines into the user's cart. */
async function mergeGuestCart(req, res, userId) {
  const t = req.cookies[CART_COOKIE];
  if (!t || !/^[a-f0-9]{64}$/.test(t)) return;
  await tx(async (conn) => {
    const [guest] = await q("SELECT id FROM carts WHERE token_hash=? AND user_id IS NULL FOR UPDATE", [sha256(t)], conn);
    if (!guest) return;
    await q("INSERT INTO carts (user_id) VALUES (?) ON DUPLICATE KEY UPDATE id=id", [userId], conn);
    const [uc] = await q("SELECT id FROM carts WHERE user_id=?", [userId], conn);
    await q(`INSERT INTO cart_items (cart_id, product_id, flavour, quantity)
             SELECT ?, g.product_id, g.flavour, g.quantity FROM cart_items g WHERE g.cart_id=?
             ON DUPLICATE KEY UPDATE quantity = LEAST(10, cart_items.quantity + VALUES(quantity))`, [uc.id, guest.id], conn);
    await q("DELETE FROM carts WHERE id=?", [guest.id], conn);
  });
  res.clearCookie(CART_COOKIE, { path: "/" });
}

module.exports = { getCartId, cartLines, mergeGuestCart, CART_COOKIE };
