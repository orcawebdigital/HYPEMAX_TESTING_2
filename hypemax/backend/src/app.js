const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const config = require("./config");
const { q, one } = require("./db");
const compression = require("compression");
const { securityHeaders, csrf, rateLimit } = require("./security");
const { loadSessions } = require("./auth");
const { HttpError } = require("./util");
const { getSettings } = require("./services/content");

const FRONTEND = path.join(__dirname, "..", "..", "frontend");
/** Changes whenever any JS/CSS file changes, so long-cached assets are refetched after a deploy. */
const ASSET_VERSION = (() => {
  const h = require("crypto").createHash("sha1");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|css)$/.test(e.name)) h.update(e.name + fs.statSync(p).size + fs.statSync(p).mtimeMs);
  });
  try { walk(path.join(FRONTEND, "js")); walk(path.join(FRONTEND, "css")); } catch { h.update(String(Date.now())); }
  return h.digest("hex").slice(0, 10);
})();
const PRIVATE_PAGES = /^\/(account|checkout|cart|login|register|forgot-password|admin)(\/|$)/;

function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Hostinger / any reverse proxy in front of Node
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(compression({ threshold: 1024 })); // gzip HTML/CSS/JS/JSON
  app.use(cookieParser());

  // Webhook must see the raw body for signature verification, so mount before express.json.
  app.use("/api/payments/webhook", require("./routes/checkout").webhook);

  app.use(express.json({ limit: "300kb" }));
  app.use(express.urlencoded({ extended: false, limit: "20kb", parameterLimit: 50 })); // SSO token endpoint (form-encoded per OAuth spec)
  app.use(csrf);
  // Coarse per-IP ceiling for the whole API, on top of the per-endpoint limits (login, register, reset, cart...).
  app.use("/api", rateLimit({ windowMs: 60e3, max: 300, key: (req) => "api|" + req.ip, message: "Too many requests from your network. Please wait a minute." }));
  app.use(loadSessions);

  // ---------- HYPEMAX SSO (OpenID Connect provider for HYPEMAX apps) ----------
  app.use(require("./sso").router);

  app.get("/health", async (req, res) => {
    try { await q("SELECT 1"); res.json({ ok: true, db: true }); } catch { res.status(503).json({ ok: false, db: false }); }
  });

  // ---------- API ----------
  app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use("/api", require("./routes/public"));
  app.use("/api/auth", require("./routes/auth").router);
  app.use("/api/cart", require("./routes/cart"));
  app.use("/api/account", require("./routes/account"));
  app.use("/api/checkout", require("./routes/checkout").router);
  app.use("/api/admin", require("./routes/admin"));
  app.use("/api", (req, res, next) => next(new HttpError(404, "API route not found")));

  // ---------- SEO helpers ----------
  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /account\nDisallow: /checkout\nDisallow: /cart\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
  });
  app.get("/sitemap.xml", async (req, res, next) => {
    try {
      const products = await q("SELECT slug, updated_at FROM products WHERE status IN ('upcoming','coming_soon','active','out_of_stock')");
      const cats = await q("SELECT slug FROM categories WHERE is_active=1");
      const urls = [["/", "1.0"], ["/products", "0.9"], ["/about", "0.5"], ["/faq", "0.5"], ["/contact", "0.5"],
        ["/policies/privacy", "0.2"], ["/policies/terms", "0.2"], ["/policies/shipping", "0.3"], ["/policies/refund", "0.3"]]
        .map(([u, p]) => `<url><loc>${config.siteUrl}${u}</loc><priority>${p}</priority></url>`)
        .concat(cats.map((c) => `<url><loc>${config.siteUrl}/products?category=${encodeURIComponent(c.slug)}</loc><priority>0.6</priority></url>`))
        .concat(products.map((p) => `<url><loc>${config.siteUrl}/products/${encodeURIComponent(p.slug)}</loc><lastmod>${new Date(p.updated_at).toISOString().slice(0, 10)}</lastmod><priority>0.8</priority></url>`));
      res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`);
    } catch (e) { next(e); }
  });

  // ---------- pages ----------
  const cache = new Map();
  const readPage = (file) => {
    if (config.isProd && cache.has(file)) return cache.get(file);
    const html = fs.readFileSync(path.join(FRONTEND, file), "utf8");
    cache.set(file, html);
    return html;
  };
  const escAttr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  /** Server-side <title>/meta so search engines and link previews get real content. */
  const sendPage = (file, metaFn) => async (req, res, next) => {
    try {
      let html = readPage(file);
      const s = await getSettings().catch(() => ({}));
      const m = metaFn ? await metaFn(req, s) : null;
      if (m === false) { res.status(404); html = readPage("404.html"); }
      else if (m) {
        if (m.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${escAttr(m.title)}</title>`).replace(/(<meta property="og:title" content=")[^"]*/, `$1${escAttr(m.title)}`);
        if (m.description) html = html.replace(/(<meta name="description" content=")[^"]*/, `$1${escAttr(m.description)}`).replace(/(<meta property="og:description" content=")[^"]*/, `$1${escAttr(m.description)}`);
        if (m.image) html = html.replace(/(<meta property="og:image" content=")[^"]*/, `$1${escAttr(m.image)}`);
        // Largest-contentful-paint image: let the browser start downloading it before any JS runs.
        if (m.preload) html = html.replace("</head>", `<link rel="preload" as="image" href="${escAttr(m.preload)}" fetchpriority="high">\n</head>`);
      }
      html = html.replace(/((?:src|href)="\/(?:js|css)\/[^"?]+\.(?:js|css))"/g, `$1?v=${ASSET_VERSION}"`); // cache-bust on every deploy
      // Fonts: preconnect + a <link> in <head> (was a render-blocking @import inside style.css), and preload the logo.
      if (!html.includes("fonts.googleapis.com")) html = html.replace(/<link rel="stylesheet" href="\/css\/style\.css/, `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap"><link rel="preload" as="image" href="/img/logo.png">\n$&`);
      html = html.replace(/(<link rel="canonical" href=")[^"]*/, `$1${config.siteUrl}${req.path === "/" ? "/" : req.path.replace(/\/$/, "")}`);
      // Pages that show a signed-in customer's data are never stored, so Back after logout (bfcache / disk
      // cache) can't redisplay the previous account. Public pages only revalidate.
      res.set("Cache-Control", PRIVATE_PAGES.test(req.path) ? "no-store, private" : "no-cache").type("html").send(html);
    } catch (e) { next(e); }
  };

  const absImg = (u) => (!u ? `${config.siteUrl}/img/products/pre-workout-front.jpg` : /^https?:/.test(u) ? u : config.siteUrl + u);
  app.get("/", sendPage("index.html", async (req, s) => {
    const hero = await one("SELECT url FROM images WHERE owner_type='content' AND owner_key='hero' LIMIT 1").catch(() => null);
    return { title: s.seoTitle, description: s.seoDescription, preload: (hero && hero.url) || "/img/product.png" };
  }));
  app.get("/products", sendPage("products.html"));
  app.get("/products/:slug", sendPage("product.html", async (req) => {
    const p = await one(`SELECT p.name, p.short_description, p.meta_title, p.meta_description,
      (SELECT url FROM images i WHERE i.owner_type='product' AND i.owner_id=p.id ORDER BY sort_order, id LIMIT 1) image
      FROM products p WHERE p.slug=? AND p.status <> 'draft'`, [req.params.slug]);
    if (!p) return false;
    return { title: p.meta_title || `${p.name} | HYPEMAX Nutrition`, description: p.meta_description || p.short_description, image: absImg(p.image) };
  }));
  app.get("/product.html", (req, res) => res.redirect(301, req.query.p ? `/products/${encodeURIComponent(req.query.p)}` : "/products"));
  for (const [route, file] of [["/about", "about.html"], ["/faq", "faq.html"], ["/contact", "contact.html"], ["/cart", "cart.html"], ["/checkout", "checkout.html"],
    ["/login", "login.html"], ["/register", "login.html"], ["/forgot-password", "login.html"]]) {
    app.get(route, sendPage(file));
    app.get(`/${file}`, (req, res) => res.redirect(301, route)); // old .html URLs
  }
  app.get(["/policies", "/policies/:slug"], sendPage("policies.html"));
  app.get(["/account", "/account/*"], sendPage("account.html"));
  app.get(["/admin", "/admin/*", "/admin.html"], (req, res, next) => { res.set("X-Robots-Tag", "noindex"); next(); }, sendPage("admin.html"));
  app.get("/index.html", (req, res) => res.redirect(301, "/"));

  // Serve the pre-built .webp sibling of a local image when the browser accepts WebP (all current browsers);
  // the original stays as the fallback. Cuts the homepage hero from 753 KiB to 52 KiB and the logo from 146 to 21.
  // (Product images uploaded through the admin are on Cloudinary and already get f_auto/q_auto.)
  app.get(/^\/img\/.+\.(png|jpe?g)$/i, (req, res, next) => {
    res.vary("Accept");
    if (!/image\/webp/.test(req.get("accept") || "")) return next();
    const webp = path.join(FRONTEND, decodeURIComponent(req.path).replace(/\.(png|jpe?g)$/i, ".webp"));
    if (!webp.startsWith(path.join(FRONTEND, "img") + path.sep) || !fs.existsSync(webp)) return next(); // no traversal
    res.sendFile(webp, { maxAge: config.isProd ? "30d" : 0, headers: { "Content-Type": "image/webp", Vary: "Accept" } });
  });
  app.use(express.static(FRONTEND, { index: false, maxAge: config.isProd ? "7d" : 0, setHeaders: (res, p) => { if (/\.html$/.test(p)) res.set("Cache-Control", "no-cache"); } }));
  app.use((req, res) => res.status(404).type("html").send(readPage("404.html")));

  // ---------- errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500, message = err.message, code = err.code;
    if (err.type === "entity.parse.failed") { status = 400; message = "Invalid JSON"; }
    else if (err.type === "entity.too.large") { status = 413; message = "Request too large"; }
    else if (err.code === "ER_DUP_ENTRY") { status = 409; message = "That value already exists"; }
    else if (status >= 500 && !(err instanceof HttpError)) {
      // Log enough to debug, but never request bodies, query values or SQL text (mysql2 errors embed the
      // full statement with parameters, which can include emails, hashes or tokens).
      const where = (err.stack || "").split("\n").slice(1, 4).map((s) => s.trim()).join(" | ");
      console.error(`${new Date().toISOString()} ${req.method} ${req.path} -> ${err.code || err.name}: ${err.sqlMessage ? "database error" : err.message} @ ${where}`);
      message = "Something went wrong on our side. Please try again.";
      code = "SERVER_ERROR";
    }
    if (req.path.startsWith("/api/") || req.xhr) return res.status(status).json({ error: message, code, ...(err.field ? { field: err.field } : {}) });
    res.status(status).type("text/plain").send(message);
  });

  return app;
}

module.exports = { createApp };
