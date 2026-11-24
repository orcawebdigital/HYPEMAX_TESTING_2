const { q, one } = require("../db");

// Short in-memory cache so CMS reads are cheap; writes invalidate immediately.
const cache = new Map();
const TTL = 30e3;

async function getContent(key, fallback = {}) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL) return c.v;
  const row = await one("SELECT value FROM site_content WHERE content_key=?", [key]);
  const v = row ? (typeof row.value === "string" ? JSON.parse(row.value) : row.value) : fallback;
  cache.set(key, { v, t: Date.now() });
  return v;
}

async function setContent(key, value, adminId = null) {
  await q(
    "INSERT INTO site_content (content_key, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value=VALUES(value), updated_by=VALUES(updated_by)",
    [key, JSON.stringify(value), adminId]
  );
  cache.delete(key);
}

const getSettings = () => getContent("settings", {});

module.exports = { getContent, setContent, getSettings };
