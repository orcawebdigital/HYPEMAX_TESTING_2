/**
 * Image management. Flow: admin -> this backend (validate type/size by magic bytes) -> Cloudinary
 * -> store secure_url + public_id in MySQL. On replace, the new image is uploaded and saved first;
 * the old Cloudinary asset is deleted only after the DB points at the new one (no broken images).
 */
const router = require("express").Router();
const multer = require("multer");
const { q, one, tx } = require("../../db");
const { wrap, bad, notFound, forbidden, int, optStr, str, oneOf } = require("../../util");
const { can, audit } = require("../../auth");
const cloud = require("../../services/cloudinary");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cloud.MAX_BYTES, files: 10 } });
const has = (req, p) => req.admin.role === "super_admin" || req.admin.permissions.includes(p);
const ownerPerm = (req, type) => {
  const ok = type === "product" ? has(req, "products.content") || has(req, "products.manage") : has(req, "content.manage");
  if (!ok) throw forbidden();
};
const handleMulter = (mw) => (req, res, next) => mw(req, res, (e) => {
  if (!e) return next();
  next(bad(e.code === "LIMIT_FILE_SIZE" ? "Image must be 8 MB or smaller" : e.code === "LIMIT_FILE_COUNT" ? "Upload at most 10 images at once" : e.message));
});

const CONTENT_KEYS = ["logo", "hero", "hero_mobile", "about", "about_2", "promo", "og_image", "contact"];

/**
 * POST /api/admin/images  (multipart: files[], owner_type=product|content, owner_id (product), owner_key (content), alt_text)
 * Products: appends to gallery. Content: single slot per key (replaces the existing one safely).
 */
router.post("/images", can("products.content", "products.manage", "content.manage"), handleMulter(upload.array("files", 10)), wrap(async (req, res) => {
  const type = oneOf(req.body.owner_type, ["product", "content"], "Image owner");
  ownerPerm(req, type);
  const files = req.files || [];
  if (!files.length) throw bad("Choose at least one image");
  files.forEach(cloud.validateImage);
  const alt = optStr(req.body.alt_text, { max: 255, name: "Alt text" });

  if (type === "product") {
    const pid = int(req.body.owner_id, { min: 1, required: true, name: "Product" });
    const p = await one("SELECT id, slug, name FROM products WHERE id=?", [pid]);
    if (!p) throw notFound("Product not found");
    const out = [];
    for (const f of files) {
      const up = await cloud.uploadBuffer(f.buffer, `products/${p.slug}`);
      const [{ m }] = await q("SELECT COALESCE(MAX(sort_order),-1)+1 m FROM images WHERE owner_type='product' AND owner_id=?", [pid]);
      const r = await q("INSERT INTO images (owner_type, owner_id, public_id, url, width, height, category, alt_text, sort_order) VALUES ('product',?,?,?,?,?, 'gallery', ?, ?)",
        [pid, up.public_id, up.url, up.width, up.height, alt || p.name, m]);
      out.push({ id: r.insertId, ...up });
    }
    await audit(req, "image.upload", "product", pid, { count: out.length });
    return res.status(201).json(out);
  }

  const key = oneOf(req.body.owner_key, CONTENT_KEYS, "Image slot");
  const up = await cloud.uploadBuffer(files[0].buffer, "content");
  const old = await one("SELECT id, public_id FROM images WHERE owner_type='content' AND owner_key=?", [key]);
  if (old) await q("UPDATE images SET public_id=?, url=?, width=?, height=?, alt_text=COALESCE(?, alt_text) WHERE id=?", [up.public_id, up.url, up.width, up.height, alt, old.id]);
  else await q("INSERT INTO images (owner_type, owner_key, public_id, url, width, height, category, alt_text) VALUES ('content',?,?,?,?,?, 'content', ?)", [key, up.public_id, up.url, up.width, up.height, alt]);
  if (old && old.public_id) await cloud.destroy(old.public_id);
  await audit(req, "image.upload", "content", key);
  res.status(201).json(up);
}));

router.get("/images/content", can("content.manage"), wrap(async (req, res) => {
  res.json({ slots: CONTENT_KEYS, images: await q("SELECT id, owner_key, url, alt_text, width, height FROM images WHERE owner_type='content'") });
}));

async function loadImage(req) {
  const img = await one("SELECT * FROM images WHERE id=?", [int(req.params.id, { min: 1 })]);
  if (!img) throw notFound("Image not found");
  ownerPerm(req, img.owner_type === "product" ? "product" : "content");
  return img;
}

// Replace an image file in place (keeps its position and alt text).
router.post("/images/:id/replace", can("products.content", "products.manage", "content.manage"), handleMulter(upload.single("file")), wrap(async (req, res) => {
  const img = await loadImage(req);
  cloud.validateImage(req.file);
  const up = await cloud.uploadBuffer(req.file.buffer, img.owner_type === "product" ? "products" : "content");
  await q("UPDATE images SET public_id=?, url=?, width=?, height=? WHERE id=?", [up.public_id, up.url, up.width, up.height, img.id]);
  await cloud.destroy(img.public_id);
  await audit(req, "image.replace", img.owner_type, img.owner_id || img.owner_key, { image: img.id });
  res.json({ id: img.id, ...up });
}));

router.put("/images/:id", wrap(async (req, res) => {
  const img = await loadImage(req);
  await q("UPDATE images SET alt_text=? WHERE id=?", [optStr(req.body.alt_text, { max: 255, name: "Alt text" }), img.id]);
  res.json({ ok: true });
}));

router.delete("/images/:id", wrap(async (req, res) => {
  const img = await loadImage(req);
  await q("DELETE FROM images WHERE id=?", [img.id]);
  const removed = await cloud.destroy(img.public_id);
  await audit(req, "image.delete", img.owner_type, img.owner_id || img.owner_key, { image: img.id, cloudinary_removed: removed });
  res.json({ ok: true, cloudinary_removed: removed });
}));

// Reorder a product gallery: { product_id, ids: [imageId, ...] } (first = main image)
router.put("/images-order", can("products.content", "products.manage"), wrap(async (req, res) => {
  const pid = int(req.body && req.body.product_id, { min: 1, required: true, name: "Product" });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => int(x, { min: 1 })) : [];
  await tx(async (conn) => { for (const [i, id] of ids.entries()) await q("UPDATE images SET sort_order=? WHERE id=? AND owner_type='product' AND owner_id=?", [i, id, pid], conn); });
  await audit(req, "image.reorder", "product", pid);
  res.json({ ok: true });
}));

// Banner and category images live on their own rows: POST /api/admin/banners/:id/image?variant=desktop|mobile
async function replaceColumnImage(req, table, id, urlCol, pidCol, folder) {
  cloud.validateImage(req.file);
  const row = await one(`SELECT ${urlCol} url, ${pidCol} pid FROM ${table} WHERE id=?`, [id]);
  if (!row) throw notFound();
  const up = await cloud.uploadBuffer(req.file.buffer, folder);
  await q(`UPDATE ${table} SET ${urlCol}=?, ${pidCol}=? WHERE id=?`, [up.url, up.public_id, id]);
  if (row.pid) await cloud.destroy(row.pid);
  return up;
}
router.post("/banners/:id/image", can("content.manage"), handleMulter(upload.single("file")), wrap(async (req, res) => {
  const mobile = req.query.variant === "mobile";
  const id = int(req.params.id, { min: 1 });
  const up = await replaceColumnImage(req, "banners", id, mobile ? "mobile_image_url" : "image_url", mobile ? "mobile_image_public_id" : "image_public_id", "banners");
  await audit(req, "banner.image", "banner", id, { variant: mobile ? "mobile" : "desktop" });
  res.json(up);
}));
router.delete("/banners/:id/image", can("content.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const mobile = req.query.variant === "mobile";
  const [u, p] = mobile ? ["mobile_image_url", "mobile_image_public_id"] : ["image_url", "image_public_id"];
  const row = await one(`SELECT ${p} pid FROM banners WHERE id=?`, [id]);
  if (!row) throw notFound();
  await q(`UPDATE banners SET ${u}=NULL, ${p}=NULL WHERE id=?`, [id]);
  await cloud.destroy(row.pid);
  await audit(req, "banner.image_remove", "banner", id, { variant: mobile ? "mobile" : "desktop" });
  res.json({ ok: true });
}));
router.post("/categories/:id/image", can("products.manage", "content.manage"), handleMulter(upload.single("file")), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const up = await replaceColumnImage(req, "categories", id, "image_url", "image_public_id", "categories");
  await audit(req, "category.image", "category", id);
  res.json(up);
}));

module.exports = router;
