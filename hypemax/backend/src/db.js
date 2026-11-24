const mysql = require("mysql2/promise");
const config = require("./config");

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  charset: "utf8mb4",
  timezone: "Z",
  dateStrings: false,
  decimalNumbers: true,
  supportBigNumbers: true,
});

pool.on("connection", (c) => c.query("SET time_zone = '+00:00'"));

/** Run a query on the pool (or on a given connection). Returns rows. */
async function q(sql, params = [], conn = pool) {
  const [rows] = await conn.query(sql, params);
  return rows;
}
async function one(sql, params = [], conn = pool) {
  const rows = await q(sql, params, conn);
  return rows[0] || null;
}

/** Run fn inside a transaction. fn receives the connection. */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, q, one, tx };
