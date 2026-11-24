const { q } = require("../db");
const config = require("../config");
const { randomToken } = require("../util");

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|headless|lighthouse|curl|wget|python-requests|axios|node-fetch/i;
const SESSION_MIN = 30;

function device(ua) {
  if (!ua) return "other";
  if (BOT_RE.test(ua)) return "bot";
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobi)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return "mobile";
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return "desktop";
  return "other";
}

function source(referrer, utm) {
  if (utm) return String(utm).toLowerCase().slice(0, 80);
  if (!referrer) return "direct";
  try {
    const h = new URL(referrer).hostname.replace(/^www\./, "");
    if (h === new URL(config.siteUrl).hostname.replace(/^www\./, "")) return null;
    if (/google\./.test(h)) return "google";
    if (/bing\./.test(h)) return "bing";
    if (/instagram\./.test(h)) return "instagram";
    if (/facebook\.|fb\./.test(h)) return "facebook";
    if (/whatsapp|wa\.me/.test(h)) return "whatsapp";
    if (/youtube\./.test(h)) return "youtube";
    if (/t\.co$|twitter\.|x\.com/.test(h)) return "twitter";
    return h.slice(0, 80);
  } catch { return "direct"; }
}

/** Respect Do-Not-Track / Global Privacy Control, and ignore bots. */
const optedOut = (req) => req.get("dnt") === "1" || req.get("sec-gpc") === "1" || device(req.get("user-agent")) === "bot";

/** Ensure anonymous visitor + rolling session cookies. Returns ids (or null if opted out). */
function ids(req, res) {
  if (optedOut(req)) return null;
  let vid = req.cookies.hm_vid, sid = req.cookies.hm_vs, isNew = false;
  if (!vid || !/^[a-f0-9]{32}$/.test(vid)) { vid = randomToken(16); }
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) { sid = randomToken(16); isNew = true; }
  const base = { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" };
  res.cookie("hm_vid", vid, { ...base, maxAge: 365 * 864e5 });
  res.cookie("hm_vs", sid, { ...base, maxAge: SESSION_MIN * 60e3 });
  req.cookies.hm_vid = vid; req.cookies.hm_vs = sid;
  return { vid, sid, isNew };
}

const EVENTS = new Set(["page_view", "product_view", "add_to_cart", "remove_from_cart", "checkout_start", "purchase", "wishlist_add", "search"]);

/** Record an event. Never throws (analytics must not break shopping). */
async function track(req, res, type, { path = null, productId = null, orderId = null, value = null, referrer = null, utm = null } = {}) {
  try {
    if (!EVENTS.has(type)) return;
    const i = ids(req, res);
    if (!i) return;
    const userId = req.user ? req.user.id : null;
    await q(
      `INSERT INTO visitor_sessions (id, visitor_id, user_id, device, source, landing_path, page_views)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE last_seen_at=UTC_TIMESTAMP(), page_views=page_views+VALUES(page_views), user_id=COALESCE(user_id, VALUES(user_id))`,
      [i.sid, i.vid, userId, device(req.get("user-agent")), source(referrer, utm) || "direct", path ? String(path).slice(0, 255) : null, type === "page_view" ? 1 : 0]
    );
    await q(
      "INSERT INTO analytics_events (session_id, visitor_id, user_id, event_type, path, product_id, order_id, value) VALUES (?,?,?,?,?,?,?,?)",
      [i.sid, i.vid, userId, type, path ? String(path).slice(0, 255) : null, productId, orderId, value]
    );
  } catch (e) {
    console.error("analytics", e.message);
  }
}

module.exports = { track, device, source };
