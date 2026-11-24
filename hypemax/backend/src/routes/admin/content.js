const router = require("express").Router();
const { q, one, tx } = require("../../db");
const { wrap, bad, notFound, str, optStr, int, bool, slugify, date, oneOf, pageParams, toCsv, HttpError } = require("../../util");
const { can, audit } = require("../../auth");
const { getContent, setContent } = require("../../services/content");
const cloud = require("../../services/cloudinary");

// ---------- site settings & page content (CMS) ----------
// Each key has an allow-list of fields so the CMS can't be used to store arbitrary blobs.
const SCHEMAS = {
  settings: { brandName: 120, legalName: 160, email: 190, phone: 30, whatsapp: 20, address: 400, gstin: 20, instagram: 300, facebook: 300, youtube: 300, twitter: 300, linkedin: 300,
    footerText: 600, announcement: 200, seoTitle: 160, seoDescription: 300, shippingFee: 10, freeShippingAbove: 10, deliveryEstimate: 120, businessHours: 160 },
  homepage: { heroEyebrow: 80, heroTitle: 160, heroText: 400, heroCtaLabel: 40, introTitle: 200, introText: 2000, productsTitle: 160, productsSubtitle: 300, comingSoonTitle: 160,
    whyTitle: 160, why: "list", stats: "list", ctaTitle: 200, ctaText: 300, testimonialsTitle: 160, newsletterTitle: 160, newsletterText: 300 },
  about: { title: 160, intro: 1000, body: 20000, values: "list", mission: 2000 },
  contact: { title: 160, intro: 1000, hours: 200, mapUrl: 500 },
  policy_privacy: { title: 160, body: 50000 },
  policy_terms: { title: 160, body: 50000 },
  policy_shipping: { title: 160, body: 50000 },
  policy_refund: { title: 160, body: 50000 },
};

function clean(key, body) {
  const schema = SCHEMAS[key];
  const out = {};
  for (const [f, rule] of Object.entries(schema)) {
    const v = body[f];
    if (v === undefined) continue;
    if (rule === "list") {
      if (!Array.isArray(v)) throw bad(`${f} must be a list`);
      out[f] = v.slice(0, 20).map((it) => ({ title: String((it && it.title) || "").slice(0, 160), text: String((it && it.text) || "").slice(0, 600) })).filter((x) => x.title || x.text);
    } else {
      out[f] = str(v, { max: rule, name: f, trim: true });
    }
  }
  if (key === "settings") {
    for (const k of ["shippingFee", "freeShippingAbove"]) if (out[k] !== undefined && out[k] !== "" && !(Number(out[k]) >= 0)) throw bad(`${k} must be a positive number`);
    for (const k of ["instagram", "facebook", "youtube", "twitter", "linkedin"]) if (out[k] && !/^https:\/\//i.test(out[k])) throw bad(`${k} link must start with https://`);
    if (out.whatsapp && !/^\d{10,15}$/.test(out.whatsapp)) throw bad("WhatsApp number must be digits only, with country code (e.g. 919984472222)");
  }
  return out;
}

router.get("/content/:key", can("content.manage"), wrap(async (req, res) => {
  if (!Object.hasOwn(SCHEMAS, req.params.key)) throw notFound();
  res.json(await getContent(req.params.key, {}));
}));
router.put("/content/:key", wrap(async (req, res, next) => {
  const key = req.params.key;
  if (!Object.hasOwn(SCHEMAS, key)) throw notFound();
  // Shipping fees affect order totals, so only managers/super admins may change them.
  const perms = req.admin.role === "super_admin" ? ["*"] : req.admin.permissions;
  if (!perms.includes("*") && !perms.includes("content.manage")) throw new HttpError(403, "You do not have permission to do that");
  const value = clean(key, req.body || {});
  const before = await getContent(key, {});
  const changed = (f) => value[f] !== undefined && String(value[f]) !== String(before[f] ?? "");
  if (key === "settings" && (changed("shippingFee") || changed("freeShippingAbove")) && !perms.includes("*") && !perms.includes("products.manage"))
    throw new HttpError(403, "Only managers can change shipping charges");
  const merged = { ...before, ...value };
  await setContent(key, merged, req.admin.id);
  await audit(req, "content.update", "content", key, { fields: Object.keys(value) });
  res.json(merged);
}));

// ---------- banners ----------
const bannerInput = (b) => {
  const link = optStr(b.link_url, { max: 500, name: "Link" });
  if (link && !/^(\/|https:\/\/)/.test(link)) throw bad("Link must be a site path like /products or a https:// URL");
  return {
    placement: oneOf(b.placement || "promo", ["hero", "promo", "strip"], "Placement"),
    title: optStr(b.title, { max: 160, name: "Title" }),
    subtitle: optStr(b.subtitle, { max: 300, name: "Subtitle" }),
    link_url: link,
    link_label: optStr(b.link_label, { max: 60, name: "Button label" }),
    sort_order: int(b.sort_order, { min: -999, max: 999 }) || 0,
    is_active: b.is_active === undefined ? 1 : bool(b.is_active) ? 1 : 0,
    starts_at: date(b.starts_at, "Start"),
    ends_at: date(b.ends_at, "End"),
  };
};
router.get("/banners", can("content.manage"), wrap(async (req, res) => res.json(await q("SELECT * FROM banners ORDER BY placement, sort_order, id"))));
router.post("/banners", can("content.manage"), wrap(async (req, res) => {
  const r = await q("INSERT INTO banners SET ?", [bannerInput(req.body || {})]);
  await audit(req, "banner.create", "banner", r.insertId);
  res.status(201).json({ id: r.insertId });
}));
router.put("/banners/:id", can("content.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const r = await q("UPDATE banners SET ? WHERE id=?", [bannerInput(req.body || {}), id]);
  if (!r.affectedRows) throw notFound();
  await audit(req, "banner.update", "banner", id);
  res.json({ ok: true });
}));
router.delete("/banners/:id", can("content.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const b = await one("SELECT image_public_id, mobile_image_public_id FROM banners WHERE id=?", [id]);
  if (!b) throw notFound();
  await q("DELETE FROM banners WHERE id=?", [id]);
  await cloud.destroy(b.image_public_id); await cloud.destroy(b.mobile_image_public_id);
  await audit(req, "banner.delete", "banner", id);
  res.json({ ok: true });
}));

// ---------- FAQs ----------
const faqInput = (b) => ({ question: str(b.question, { max: 300, name: "Question", required: true }), answer: str(b.answer, { max: 5000, name: "Answer", required: true }), is_published: b.is_published === undefined ? 1 : bool(b.is_published) ? 1 : 0 });
router.get("/faqs", can("content.manage"), wrap(async (req, res) => res.json(await q("SELECT * FROM faqs ORDER BY sort_order, id"))));
router.post("/faqs", can("content.manage"), wrap(async (req, res) => {
  const [{ m }] = await q("SELECT COALESCE(MAX(sort_order),0)+1 m FROM faqs");
  const r = await q("INSERT INTO faqs SET ?", [{ ...faqInput(req.body || {}), sort_order: m }]);
  await audit(req, "faq.create", "faq", r.insertId);
  res.status(201).json({ id: r.insertId });
}));
router.put("/faqs/:id", can("content.manage"), wrap(async (req, res) => {
  const r = await q("UPDATE faqs SET ? WHERE id=?", [faqInput(req.body || {}), int(req.params.id, { min: 1 })]);
  if (!r.affectedRows) throw notFound("FAQ not found");
  await audit(req, "faq.update", "faq", req.params.id);
  res.json({ ok: true });
}));
router.delete("/faqs/:id", can("content.manage"), wrap(async (req, res) => {
  await q("DELETE FROM faqs WHERE id=?", [int(req.params.id, { min: 1 })]);
  await audit(req, "faq.delete", "faq", req.params.id);
  res.json({ ok: true });
}));
router.put("/faqs-order", can("content.manage"), wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map((x) => int(x, { min: 1 })) : [];
  await tx(async (conn) => { for (const [i, id] of ids.entries()) await q("UPDATE faqs SET sort_order=? WHERE id=?", [i, id], conn); });
  res.json({ ok: true });
}));

// ---------- categories ----------
const catInput = (b) => ({
  name: str(b.name, { max: 120, name: "Name", required: true }),
  slug: slugify(b.slug || b.name),
  description: optStr(b.description, { max: 2000, name: "Description" }),
  sort_order: int(b.sort_order, { min: -999, max: 999 }) || 0,
  is_active: b.is_active === undefined ? 1 : bool(b.is_active) ? 1 : 0,
});
router.get("/categories", can("products.manage", "products.content", "content.manage", "coupons.manage"), wrap(async (req, res) =>
  res.json(await q("SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) products FROM categories c ORDER BY sort_order, name"))));
router.post("/categories", can("products.manage"), wrap(async (req, res) => {
  const c = catInput(req.body || {});
  if (await one("SELECT id FROM categories WHERE slug=?", [c.slug])) throw new HttpError(409, "A category with this URL already exists");
  const r = await q("INSERT INTO categories SET ?", [c]);
  await audit(req, "category.create", "category", r.insertId, c);
  res.status(201).json({ id: r.insertId });
}));
router.put("/categories/:id", can("products.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const c = catInput(req.body || {});
  if (await one("SELECT id FROM categories WHERE slug=? AND id<>?", [c.slug, id])) throw new HttpError(409, "A category with this URL already exists");
  await q("UPDATE categories SET ? WHERE id=?", [c, id]);
  await audit(req, "category.update", "category", id, c);
  res.json({ ok: true });
}));
router.delete("/categories/:id", can("products.manage"), wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const c = await one("SELECT image_public_id FROM categories WHERE id=?", [id]);
  if (!c) throw notFound();
  await q("DELETE FROM categories WHERE id=?", [id]);
  await cloud.destroy(c.image_public_id);
  await audit(req, "category.delete", "category", id);
  res.json({ ok: true });
}));

// ---------- reviews / testimonials ----------
router.get("/reviews", can("reviews.manage"), wrap(async (req, res) => {
  const where = req.query.status === "pending" ? "WHERE r.is_published=0" : req.query.status === "published" ? "WHERE r.is_published=1" : "";
  res.json(await q(`SELECT r.*, p.name product_name, u.email user_email FROM reviews r LEFT JOIN products p ON p.id=r.product_id LEFT JOIN users u ON u.id=r.user_id ${where} ORDER BY r.created_at DESC LIMIT 500`));
}));
router.post("/reviews", can("reviews.manage"), wrap(async (req, res) => {
  // Admin-entered testimonial (e.g. from WhatsApp/Instagram feedback). Never marked as a verified purchase.
  const b = req.body || {};
  const r = await q("INSERT INTO reviews (product_id, name, rating, title, body, is_published, is_testimonial, verified_purchase) VALUES (?,?,?,?,?,?,?,0)",
    [int(b.product_id, { min: 1 }) || null, str(b.name, { max: 120, required: true, name: "Name" }), int(b.rating, { min: 1, max: 5, required: true, name: "Rating" }),
      optStr(b.title, { max: 160 }), str(b.body, { max: 3000, required: true, name: "Text" }), bool(b.is_published) ? 1 : 0, bool(b.is_testimonial) ? 1 : 0]);
  await audit(req, "review.create", "review", r.insertId);
  res.status(201).json({ id: r.insertId });
}));
router.put("/reviews/:id", can("reviews.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  const set = {};
  if (b.is_published !== undefined) set.is_published = bool(b.is_published) ? 1 : 0;
  if (b.is_testimonial !== undefined) set.is_testimonial = bool(b.is_testimonial) ? 1 : 0;
  if (!Object.keys(set).length) throw bad("Nothing to update");
  const r = await q("UPDATE reviews SET ? WHERE id=?", [set, int(req.params.id, { min: 1 })]);
  if (!r.affectedRows) throw notFound("Review not found");
  await audit(req, "review.update", "review", req.params.id, set);
  res.json({ ok: true });
}));
router.delete("/reviews/:id", can("reviews.manage"), wrap(async (req, res) => {
  await q("DELETE FROM reviews WHERE id=?", [int(req.params.id, { min: 1 })]);
  await audit(req, "review.delete", "review", req.params.id);
  res.json({ ok: true });
}));

// ---------- contact messages & newsletter ----------
router.get("/messages", can("messages.manage"), wrap(async (req, res) => {
  const { limit, offset } = pageParams(req.query, { def: 50 });
  const where = req.query.status ? "WHERE status=?" : "";
  const params = req.query.status ? [String(req.query.status)] : [];
  const rows = await q(`SELECT * FROM contact_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [{ n }] = await q(`SELECT COUNT(*) n FROM contact_messages ${where}`, params);
  res.set("X-Total-Count", String(n));
  res.json(rows); // bare array kept for compatibility; total is in the X-Total-Count header
}));
router.put("/messages/:id", can("messages.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  await q("UPDATE contact_messages SET status=?, admin_note=? WHERE id=?", [oneOf(b.status, ["new", "in_progress", "closed"], "Status"), optStr(b.admin_note, { max: 500 }), int(req.params.id, { min: 1 })]);
  res.json({ ok: true });
}));
router.get("/newsletter", can("messages.manage"), wrap(async (req, res) => res.json(await q("SELECT * FROM newsletter_subscribers ORDER BY created_at DESC LIMIT 5000"))));
router.get("/newsletter.csv", can("customers.export"), wrap(async (req, res) => {
  const rows = await q("SELECT email, is_active, created_at FROM newsletter_subscribers ORDER BY created_at DESC");
  await audit(req, "newsletter.export", "newsletter", null, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="hypemax-newsletter.csv"');
  res.send("﻿" + toCsv(rows, [["email", "Email"], [(r) => (r.is_active ? "yes" : "no"), "Subscribed"], ["created_at", "Joined (UTC)"]]));
}));

module.exports = router;
