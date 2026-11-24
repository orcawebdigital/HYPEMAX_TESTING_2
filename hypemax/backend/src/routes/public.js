const router = require("express").Router();
const config = require("../config");
const { q, one } = require("../db");
const { wrap, notFound, str, optStr, email, int, bad } = require("../util");
const { rateLimit } = require("../security");
const { getContent, getSettings } = require("../services/content");
const catalog = require("../services/catalog");
const analytics = require("../services/analytics");
const mail = require("../services/mail");

const PUBLIC_CONTENT = ["homepage", "about", "contact", "policy_privacy", "policy_terms", "policy_shipping", "policy_refund"];

// Client bootstrap: public keys and which integrations are live.
router.get("/config", wrap(async (req, res) => {
  res.json({
    razorpay_key_id: config.features.razorpay ? config.razorpay.keyId : null,
    google_client_id: config.google.clientId || null, // public identifier, safe to expose (the secret never is)
    features: { payments: config.features.razorpay, google: config.features.google, google_redirect: config.features.googleRedirect, email: config.features.email, uploads: config.features.cloudinary },
    user: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email, phone: req.user.phone || null } : null,
  });
}));

// Everything the page shell needs in one call (settings, homepage content, banners, categories).
router.get("/site", wrap(async (req, res) => {
  const [settings, homepage, banners, categories, imgs] = await Promise.all([
    getSettings(),
    getContent("homepage", {}),
    q(`SELECT id, placement, title, subtitle, link_url, link_label, image_url, mobile_image_url FROM banners
       WHERE is_active=1 AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP()) AND (ends_at IS NULL OR ends_at > UTC_TIMESTAMP())
       ORDER BY placement, sort_order, id`),
    q("SELECT id, name, slug, description, image_url FROM categories WHERE is_active=1 ORDER BY sort_order, name"),
    q("SELECT owner_key, url FROM images WHERE owner_type='content'"),
  ]);
  res.set("Cache-Control", "no-cache");
  // Never expose internal-only settings keys
  const { legalName, gstin, ...publicSettings } = settings;
  res.json({ settings: publicSettings, homepage, banners, categories, images: Object.fromEntries(imgs.map((i) => [i.owner_key, i.url])) });
}));

router.get("/content/:key", wrap(async (req, res) => {
  if (!PUBLIC_CONTENT.includes(req.params.key)) throw notFound();
  res.json(await getContent(req.params.key, {}));
}));

router.get("/categories", wrap(async (req, res) => {
  res.json(await q("SELECT id, name, slug, description, image_url FROM categories WHERE is_active=1 ORDER BY sort_order, name"));
}));

router.get("/products", wrap(async (req, res) => {
  const toP = (v) => (v === undefined || v === "" ? null : Math.round(Number(v) * 100) || null);
  res.json(await catalog.listProducts({
    search: req.query.q ? String(req.query.q) : null,
    category: req.query.category ? String(req.query.category) : null,
    status: req.query.availability ? String(req.query.availability) : null,
    sort: req.query.sort ? String(req.query.sort) : null,
    minPrice: toP(req.query.min), maxPrice: toP(req.query.max),
  }));
}));

router.get("/products/:slug", wrap(async (req, res) => {
  const p = await catalog.getProductBySlug(String(req.params.slug));
  if (!p) throw notFound("Product not found");
  const related = (await catalog.listProducts({ limit: 8 })).filter((x) => x.id !== p.id)
    .sort((a, b) => (b.category && p.category && b.category.id === p.category.id) - (a.category && p.category && a.category.id === p.category.id)).slice(0, 4);
  let wishlisted = false;
  if (req.user) {
    wishlisted = !!(await one("SELECT 1 x FROM wishlists WHERE user_id=? AND product_id=?", [req.user.id, p.id]));
    q("INSERT INTO recently_viewed (user_id, product_id) VALUES (?,?) ON DUPLICATE KEY UPDATE viewed_at=UTC_TIMESTAMP()", [req.user.id, p.id]).catch(() => {});
  }
  res.json({ ...p, related, wishlisted });
}));

router.get("/products/:slug/reviews", wrap(async (req, res) => {
  const p = await one("SELECT id FROM products WHERE slug=?", [String(req.params.slug)]);
  if (!p) throw notFound();
  res.json(await q(`SELECT id, name, rating, title, body, verified_purchase, created_at FROM reviews WHERE product_id=? AND is_published=1 ORDER BY created_at DESC LIMIT 50`, [p.id]));
}));

// Lightweight list for "recently viewed" on the client (ids from localStorage for guests).
router.get("/products-by-ids", wrap(async (req, res) => {
  const ids = String(req.query.ids || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 12);
  if (!ids.length) return res.json([]);
  const list = await catalog.listProducts({ ids });
  res.json(ids.map((id) => list.find((p) => p.id === id)).filter(Boolean));
}));

router.get("/faqs", wrap(async (req, res) => {
  res.json(await q("SELECT id, question, answer FROM faqs WHERE is_published=1 ORDER BY sort_order, id"));
}));

router.get("/testimonials", wrap(async (req, res) => {
  res.json(await q(`SELECT r.id, r.name, r.rating, r.title, r.body, r.verified_purchase, p.name product_name FROM reviews r
    LEFT JOIN products p ON p.id=r.product_id WHERE r.is_published=1 AND r.is_testimonial=1 ORDER BY r.created_at DESC LIMIT 12`));
}));

router.post("/contact", rateLimit({ windowMs: 3600e3, max: 8 }), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot
  const name = str(b.name, { max: 120, name: "Name", required: true });
  const em = email(b.email, { required: false });
  const ph = optStr(b.phone, { max: 20, name: "Phone" });
  if (!em && !ph) throw bad("Enter an email or phone number so we can reply");
  const m = { name, email: em || null, phone: ph, subject: optStr(b.subject, { max: 200, name: "Subject" }), message: str(b.message, { max: 4000, name: "Message", required: true, min: 5 }) };
  await q("INSERT INTO contact_messages SET ?", [m]);
  mail.adminRecipients().then((to) => mail.sendTemplate(to, "adminNewMessage", m)).catch(() => {});
  res.json({ ok: true });
}));

router.post("/newsletter", rateLimit({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
  const em = email(req.body && req.body.email);
  await q("INSERT INTO newsletter_subscribers (email) VALUES (?) ON DUPLICATE KEY UPDATE is_active=1", [em]);
  res.json({ ok: true });
}));

// First-party analytics beacon.
router.post("/t", rateLimit({ windowMs: 60e3, max: 120 }), wrap(async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || "");
  if (!["page_view", "product_view", "checkout_start", "search"].includes(type)) return res.status(204).end();
  const productId = int(b.product_id, { min: 1 }) || null;
  await analytics.track(req, res, type, {
    path: b.path ? String(b.path).slice(0, 255) : null, productId,
    referrer: b.referrer ? String(b.referrer).slice(0, 500) : null, utm: b.utm ? String(b.utm).slice(0, 80) : null,
  });
  res.status(204).end();
}));

module.exports = router;
