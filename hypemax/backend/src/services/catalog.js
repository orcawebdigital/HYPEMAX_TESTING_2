const { q, one } = require("../db");
const { searchTerms } = require("../util");

const PUBLIC_STATUSES = ["upcoming", "coming_soon", "active", "out_of_stock"];
const STATUS_LABEL = { draft: "Draft", upcoming: "Upcoming", coming_soon: "Coming soon", active: "In stock", out_of_stock: "Out of stock", discontinued: "Discontinued" };

const discountPercent = (mrp, price) => (mrp > 0 && price > 0 && price < mrp ? Math.round(((mrp - price) / mrp) * 100) : 0);
const arr = (v) => (Array.isArray(v) ? v : v ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);

/** Shape a product row for the storefront. Never leaks cost/stock internals beyond what's needed. */
function serialize(p, images = [], extra = {}) {
  const available = Math.max(0, (p.stock || 0) - (p.reserved || 0));
  const effectiveStatus = p.status === "active" && available <= 0 ? "out_of_stock" : p.status;
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    sku: p.sku,
    status: effectiveStatus,
    status_label: STATUS_LABEL[effectiveStatus],
    purchasable: effectiveStatus === "active",
    short_description: p.short_description,
    description: p.description,
    highlights: arr(p.highlights),
    flavours: arr(p.flavours),
    net_weight: p.net_weight,
    servings: p.servings,
    mrp: p.mrp,
    price: p.price,
    discount_percent: discountPercent(p.mrp, p.price),
    low_stock: effectiveStatus === "active" && available <= (p.low_stock_threshold ?? 10) ? available : null,
    category: p.category_id ? { id: p.category_id, name: p.category_name, slug: p.category_slug } : null,
    featured: !!p.featured,
    rating: p.rating_avg ? { average: Math.round(p.rating_avg * 10) / 10, count: p.rating_count } : null,
    image: images[0] ? images[0].url : p.image || null,
    images: images.map((i) => ({ id: i.id, url: i.url, alt: i.alt_text || p.name, width: i.width, height: i.height })),
    meta_title: p.meta_title,
    meta_description: p.meta_description,
    ...extra,
  };
}

const BASE_SELECT = `SELECT p.*, c.name category_name, c.slug category_slug,
  COALESCE(i.stock,0) stock, COALESCE(i.reserved,0) reserved, COALESCE(i.low_stock_threshold,10) low_stock_threshold,
  (SELECT url FROM images im WHERE im.owner_type='product' AND im.owner_id=p.id ORDER BY sort_order, id LIMIT 1) image,
  (SELECT AVG(rating) FROM reviews r WHERE r.product_id=p.id AND r.is_published=1) rating_avg,
  (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.is_published=1) rating_count
  FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN inventory i ON i.product_id=p.id`;

const SORTS = {
  featured: "p.featured DESC, p.sort_order, p.id",
  newest: "p.created_at DESC",
  price_asc: "p.price ASC",
  price_desc: "p.price DESC",
  name: "p.name ASC",
  discount: "(p.mrp - p.price) / GREATEST(p.mrp,1) DESC",
  rating: "rating_avg DESC",
};

async function listProducts({ search, category, status, sort, minPrice, maxPrice, ids, limit = 60 } = {}) {
  const where = ["p.status IN (?)"], params = [PUBLIC_STATUSES];
  // BUG-002: trim/collapse spaces, treat hyphens as spaces ("pre workout" finds "Pre-Workout"), and require every
  // word to appear somewhere (name, SKU, flavours, description or category), in any order. Case-insensitive
  // because the columns use a _ci collation. LIKE wildcards in the input are escaped.
  for (const t of searchTerms(search)) {
    const s = `%${t.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(`(REPLACE(p.name,'-',' ') LIKE ? OR p.sku LIKE ? OR CAST(p.flavours AS CHAR) LIKE ? OR REPLACE(p.short_description,'-',' ') LIKE ? OR c.name LIKE ?)`);
    params.push(s, s, s, s, s);
  }
  if (category) { where.push("c.slug = ?"); params.push(category); }
  if (status === "available") where.push("p.status='active' AND COALESCE(i.stock,0) - COALESCE(i.reserved,0) > 0");
  else if (status === "upcoming") where.push("p.status IN ('upcoming','coming_soon')");
  if (minPrice != null) { where.push("p.price >= ?"); params.push(minPrice); }
  if (maxPrice != null) { where.push("p.price <= ?"); params.push(maxPrice); }
  if (ids) { where.push("p.id IN (?)"); params.push(ids.length ? ids : [0]); }
  const order = SORTS[sort] || SORTS.featured;
  const rows = await q(`${BASE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${Number(limit) | 0}`, params);
  return rows.map((p) => serialize(p));
}

async function productImages(productId) {
  return q("SELECT id, url, alt_text, width, height FROM images WHERE owner_type='product' AND owner_id=? ORDER BY sort_order, id", [productId]);
}

async function getProductBySlug(slug, { includeHidden = false } = {}) {
  const p = await one(`${BASE_SELECT} WHERE p.slug = ? ${includeHidden ? "" : "AND p.status <> 'draft'"}`, [slug]);
  if (!p) return null;
  const [images, sections] = await Promise.all([
    productImages(p.id),
    q("SELECT id, title, content FROM product_sections WHERE product_id=? AND is_enabled=1 ORDER BY sort_order, id", [p.id]),
  ]);
  return serialize(p, images, { sections });
}

module.exports = { serialize, listProducts, getProductBySlug, productImages, discountPercent, PUBLIC_STATUSES, STATUS_LABEL, BASE_SELECT };
