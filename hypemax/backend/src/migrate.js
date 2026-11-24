const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

/** Split a .sql file into statements (no procedures/triggers in our migrations). */
function splitSql(sql) {
  return sql
    .split(/\n/).filter((l) => !/^\s*--/.test(l)).join("\n")
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate({ log = console.log } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(190) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
  const [done] = await pool.query("SELECT name FROM schema_migrations");
  const applied = new Set(done.map((r) => r.name));
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    log(`Applying migration ${f}`);
    const conn = await pool.getConnection();
    try {
      for (const stmt of splitSql(fs.readFileSync(path.join(dir, f), "utf8"))) await conn.query(stmt);
      await conn.query("INSERT INTO schema_migrations (name) VALUES (?)", [f]);
    } finally {
      conn.release();
    }
  }
}

module.exports = { migrate };
