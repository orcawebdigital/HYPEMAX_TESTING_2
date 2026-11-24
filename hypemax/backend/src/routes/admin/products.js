const router = require("express").Router();
const { q, one, tx } = require("../../db");
const { wrap, bad, notFound, forbidden, str, optStr, int, bool, slugify, toPaise, jsonArr, oneOf, HttpError } = require("../../util");
const { can, audit } = require("../../auth");
const cloud = require("../../services/cloudinary");

const STATUSES = ["draft", "upcoming", "coming_soon", "active", "out_of_stock", "discontinued"];
const has = (req, p) => req.admin.role === "super_admin" || req.admin.permissions.includes(p);
const anyProductPerm = can("products.manage", "products.content");

router.get("/", anyProductPerm, wrap(async (req, res) => {
  const rows = await q(`SELECT p.id, p.name, p.slug, p.sku, p.status, p.mrp, p.price, p.featured, p.sort_order, p.updated_at, p.category_id, c.name category,
      COALESCE(i.stock,0) stock, COALESCE(i.reserved,0) reserved, COALESCE(i.low_stock_threshold,10) low_stock_threshold,
      (SELECT url FROM images im WHERE im.owner_type='product' AND im.owner_id=p.id ORDER BY sort_order, id LIMIT 1) image,
      (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.paid_at IS NOT NULL) units_sold
    FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN inventory i ON i.product_id=p.id ORDER BY p.sort_order, p.id`);
  res.json(rows);
}));

router.get("/:id", anyProductPerm, wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const p = await one(`SELECT p.*, COALESCE(i.stock,0) stock, COALESCE(i.reserved,0) reserved, COALESCE(i.low_stock_threshold,10) low_stock_threshold
    FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=?`, [id]);
  if (!p) throw notFound("Product not found");
  const [images, sections, movements] = await Promise.all([
    q("SELECT id, url, public_id, alt_text, width, height, sort_order FROM images WHERE owner_type='product' AND owner_id=? ORDER BY sort_order, id", [id]),
    q("SELECT id, title, content, sort_order, is_enabled FROM product_sections WHERE product_id=? ORDER BY sort_order, id", [id]),
    q("SELECT change_qty, reason, order_id, created_at FROM inventory_movements WHERE product_id=? ORDER BY id DESC LIMIT 30", [id]),
  ]);
  res.json({ ...p, images, sections, movements });
}));

const CONTENT_FIELDS = ["name", "short_description", "description", "highlights", "flavours", "net_weight", "servings", "meta_title", "meta_description"];
const COMMERCIAL_FIELDS = ["slug", "sku", "status", "mrp", "price", "category_id", "featured", "sort_order"];

function productInput(b, partial) {
  const o = {};
  const set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set("name", (v) => str(v, { max: 160, name: "Name", required: true }));
  set("slug", (v) => { const s = slugify(v || b.name); if (!s) throw bad("URL slug is required"); return s; });
  set("sku", (v) => optStr(v, { max: 60, name: "SKU" }));
  set("status", (v) => oneOf(v || "draft", STATUSES, "Status"));
  set("short_description", (v) => optStr(v, { max: 500, name: "Short description" }));
  set("description", (v) => optStr(v, { max: 20000, name: "Description" }));
  set("highlights", (v) => JSON.stringify(jsonArr(v, "Highlights", /\n/))); // one per line; commas allowed inside
  set("flavours", (v) => JSON.stringify(jsonArr(v, "Flavours")));
  set("net_weight", (v) => optStr(v, { max: 40, name: "Net weight" }));
  set("servings", (v) => optStr(v, { max: 40, name: "Servings" }));
  set("mrp", (v) => toPaise(v) ?? 0);
  set("price", (v) => toPaise(v) ?? 0);
  set("category_id", (v) => int(v, { min: 1, name: "Category" }));
  set("featured", (v) => (bool(v) ? 1 : 0));
  set("sort_order", (v) => int(v, { min: -9999, max: 9999, name: "Sort order" }) || 0);
  set("meta_title", (v) => optStr(v, { max: 160, name: "Meta title" }));
  set("meta_description", (v) => optStr(v, { max: 300, name: "Meta description" }));
  if (o.mrp != null && o.price != null && o.price > o.mrp && o.mrp > 0) throw bad("Selling price cannot be higher than MRP");
  if (o.status === "active" && o.price === 0) throw bad("Set a selling price before making the product active");
  return o;
}

router.post("/", can("products.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  const p = productInput(b, false);
  if (await one("SELECT id FROM products WHERE slug=?", [p.slug])) throw new HttpError(409, "Another product already uses this URL slug");
  const id = await tx(async (conn) => {
    const r = await q("INSERT INTO products SET ?", [p], conn);
    await q("INSERT INTO inventory (product_id, stock, low_stock_threshold) VALUES (?,?,?)",
      [r.insertId, int(b.stock, { min: 0, max: 1e6, name: "Stock" }) || 0, int(b.low_stock_threshold, { min: 0, max: 1e6 }) ?? 10], conn);
    if (b.stock) await q("INSERT INTO inventory_movements (product_id, change_qty, reason, admin_id) VALUES (?,?, 'initial', ?)", [r.insertId, int(b.stock), req.admin.id], conn);
    // Default accordion sections so the admin has a structure to fill in
    const defaults = ["Ingredients", "Benefits", "How to Use", "Product Specifications", "Nutritional Information", "Storage Instructions", "Frequently Asked Questions"];
    for (const [i, t] of defaults.entries()) await q("INSERT INTO product_sections (product_id, title, content, sort_order, is_enabled) VALUES (?,?,'',?,0)", [r.insertId, t, i], conn);
    return r.insertId;
  });
  await audit(req, "product.create", "product", id, { name: p.name });
  res.status(201).json({ id });
}));

router.put("/:id", anyProductPerm, wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const before = await one("SELECT * FROM products WHERE id=?", [id]);
  if (!before) throw notFound("Product not found");
  const b = req.body || {};
  const p = productInput(b, true);
  // Content managers can edit product content but not commercial fields.
  for (const k of Object.keys(p)) {
    if (COMMERCIAL_FIELDS.includes(k) && !has(req, "products.manage") && String(p[k]) !== String(before[k])) throw forbidden(`You don't have permission to change ${k.replace("_", " ")}`);
    if (CONTENT_FIELDS.includes(k) && !has(req, "products.content") && !has(req, "products.manage")) throw forbidden();
  }
  const merged = { ...before, ...p };
  if (merged.price > merged.mrp && merged.mrp > 0) throw bad("Selling price cannot be higher than MRP");
  if (p.slug && p.slug !== before.slug && (await one("SELECT id FROM products WHERE slug=? AND id<>?", [p.slug, id]))) throw new HttpError(409, "Another product already uses this URL slug");
  if (Object.keys(p).length) await q("UPDATE products SET ? WHERE id=?", [p, id]);
  const changes = Object.fromEntries(Object.keys(p).filter((k) => String(p[k]) !== String(before[k])).map((k) => [k, { from: before[k], to: p[k] }]));
  if (Object.keys(changes).length) await audit(req, "product.update", "product", id, changes);
  res.json({ ok: true });
}));

router.delete("/:id", can("products.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const p = await one("SELECT id, name FROM products WHERE id=?", [id]);
  if (!p) throw notFound();
  const sold = await one("SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1", [id]);
  if (sold) throw bad("This product has orders. Set it to Discontinued instead of deleting, so order history stays intact.");
  const imgs = await q("SELECT public_id FROM images WHERE owner_type='product' AND owner_id=?", [id]);
  await tx(async (conn) => {
    await q("DELETE FROM images WHERE owner_type='product' AND owner_id=?", [id], conn);
    await q("DELETE FROM products WHERE id=?", [id], conn);
  });
  for (const i of imgs) await cloud.destroy(i.public_id);
  await audit(req, "product.delete", "product", id, { name: p.name });
  res.json({ ok: true });
}));

// ---------- inventory ----------
router.post("/:id/inventory", can("products.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const b = req.body || {};
  const mode = oneOf(b.mode || "set", ["set", "adjust"], "Mode");
  const threshold = int(b.low_stock_threshold, { min: 0, max: 1e6, name: "Low stock alert" });
  await tx(async (conn) => {
    const [inv] = await q("SELECT * FROM inventory WHERE product_id=? FOR UPDATE", [id], conn);
    if (!inv) throw notFound("Product not found");
    let change = 0;
    if (b.quantity !== undefined && b.quantity !== "") {
      const n = int(b.quantity, { min: mode === "set" ? 0 : -1e6, max: 1e6, name: "Quantity" });
      change = mode === "set" ? n - inv.stock : n;
      if (inv.stock + change < 0) throw bad("Stock cannot go below zero");
    }
    await q("UPDATE inventory SET stock=stock+?, low_stock_threshold=COALESCE(?, low_stock_threshold) WHERE product_id=?", [change, threshold, id], conn);
    if (change) await q("INSERT INTO inventory_movements (product_id, change_qty, reason, admin_id) VALUES (?,?,?,?)",
      [id, change, String(b.reason || "manual adjustment").slice(0, 60), req.admin.id], conn);
  });
  await audit(req, "inventory.update", "product", id, { mode, quantity: b.quantity, low_stock_threshold: threshold });
  res.json(await one("SELECT stock, reserved, low_stock_threshold FROM inventory WHERE product_id=?", [id]));
}));

// ---------- accordion sections ----------
const contentPerm = can("products.content", "products.manage");
const sectionInput = (b) => ({
  title: str(b.title, { max: 120, name: "Section title", required: true }),
  content: str(b.content, { max: 20000, name: "Content", trim: false }).replace(/\s+$/, ""),
  is_enabled: b.is_enabled === undefined ? 1 : bool(b.is_enabled) ? 1 : 0,
});
router.post("/:id/sections", contentPerm, wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  if (!(await one("SELECT id FROM products WHERE id=?", [id]))) throw notFound();
  const s = sectionInput(req.body || {});
  const [{ m }] = await q("SELECT COALESCE(MAX(sort_order),-1)+1 m FROM product_sections WHERE product_id=?", [id]);
  const r = await q("INSERT INTO product_sections SET ?", [{ ...s, product_id: id, sort_order: m }]);
  await audit(req, "product.section.create", "product", id, { title: s.title });
  res.status(201).json({ id: r.insertId });
}));
router.put("/:id/sections/:sid", contentPerm, wrap(async (req, res) => {
  const s = sectionInput(req.body || {});
  const r = await q("UPDATE product_sections SET ? WHERE id=? AND product_id=?", [s, int(req.params.sid, { min: 1 }), int(req.params.id, { min: 1 })]);
  if (!r.affectedRows) throw notFound("Section not found");
  await audit(req, "product.section.update", "product", req.params.id, { section: req.params.sid, title: s.title });
  res.json({ ok: true });
}));
router.delete("/:id/sections/:sid", contentPerm, wrap(async (req, res) => {
  await q("DELETE FROM product_sections WHERE id=? AND product_id=?", [int(req.params.sid, { min: 1 }), int(req.params.id, { min: 1 })]);
  await audit(req, "product.section.delete", "product", req.params.id, { section: req.params.sid });
  res.json({ ok: true });
}));
router.put("/:id/sections-order", contentPerm, wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map((x) => int(x, { min: 1 })) : [];
  await tx(async (conn) => { for (const [i, sid] of ids.entries()) await q("UPDATE product_sections SET sort_order=? WHERE id=? AND product_id=?", [i, sid, id], conn); });
  res.json({ ok: true });
}));

module.exports = router;
