#!/usr/bin/env node
// Usage: node src/cli.js migrate | seed | create-admin <email> <name> | upload-seed-images | check
const { pool } = require("./db");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "migrate") await require("./migrate").migrate();
  else if (cmd === "seed") { await require("./migrate").migrate(); await require("./seed").seed(); }
  else if (cmd === "upload-seed-images") await require("./seed").uploadSeedImages();
  else if (cmd === "check") {
    const r = await require("./services/integrations").checkAll();
    for (const [k, v] of Object.entries(r)) console.log(`${v.ok ? "PASS" : v.configured === false ? "SKIP" : "FAIL"}  ${k.padEnd(17)} ${v.detail}`);
  }
  else if (cmd === "create-admin") {
    const [email, ...nameParts] = args;
    if (!email) throw new Error("Usage: npm run create-admin -- you@example.com \"Your Name\"   (password is read from ADMIN_NEW_PASSWORD env var)");
    const pw = process.env.ADMIN_NEW_PASSWORD;
    if (!pw || pw.length < 10) throw new Error("Set ADMIN_NEW_PASSWORD (10+ characters) in the environment for this command");
    const { q, one } = require("./db");
    const { hashPassword } = require("./auth");
    await require("./migrate").migrate();
    await require("./seed").seed();
    const role = await one("SELECT id FROM roles WHERE slug='super_admin'");
    await q("INSERT INTO admins (name, email, password_hash, role_id) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role_id=VALUES(role_id), is_active=1",
      [nameParts.join(" ") || "Super Admin", email.toLowerCase(), await hashPassword(pw), role.id]);
    console.log(`Super Admin ${email} is ready.`);
  } else {
    console.log("Commands: migrate | seed | create-admin <email> <name> | upload-seed-images | check");
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
