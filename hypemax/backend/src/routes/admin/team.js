const router = require("express").Router();
const { q, one } = require("../../db");
const { wrap, bad, notFound, str, email, password, int, bool, pageParams, HttpError } = require("../../util");
const { can, audit, hashPassword, checkPassword, destroyAllSessions, COOKIE } = require("../../auth");
const { PERMISSIONS } = require("../../rbac");
const { rateLimit } = require("../../security");

// Any admin can change their own password.
router.post("/me/password", rateLimit({ windowMs: 3600e3, max: 10, key: (req) => "admin-pw|" + req.admin.id }), wrap(async (req, res) => {
  const b = req.body || {};
  const a = await one("SELECT password_hash FROM admins WHERE id=?", [req.admin.id]);
  if (!(await checkPassword(str(b.current_password, { max: 128, name: "Current password", required: true, trim: false }), a.password_hash))) throw bad("Current password is incorrect");
  await q("UPDATE admins SET password_hash=? WHERE id=?", [await hashPassword(password(b.new_password)), req.admin.id]);
  await destroyAllSessions("admin", req.admin.id, req.cookies[COOKIE.admin]);
  await audit(req, "admin.password_change", "admin", req.admin.id);
  res.json({ ok: true });
}));

// Only the Super Admin can manage admins and roles.
const superOnly = can("admins.manage");

router.get("/roles", superOnly, wrap(async (req, res) => {
  const roles = await q("SELECT id, slug, name FROM roles ORDER BY id");
  const rp = await q("SELECT rp.role_id, p.slug FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id");
  res.json({ roles: roles.map((r) => ({ ...r, permissions: rp.filter((x) => x.role_id === r.id).map((x) => x.slug) })), permissions: PERMISSIONS });
}));

router.get("/admins", superOnly, wrap(async (req, res) => {
  res.json(await q("SELECT a.id, a.name, a.email, a.is_active, a.last_login_at, a.created_at, r.slug role, r.name role_name FROM admins a JOIN roles r ON r.id=a.role_id ORDER BY a.id"));
}));

router.post("/admins", superOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const em = email(b.email);
  const role = await one("SELECT id, slug FROM roles WHERE slug=?", [String(b.role || "")]);
  if (!role) throw bad("Choose a role");
  if (await one("SELECT id FROM admins WHERE email=?", [em])) throw new HttpError(409, "An admin with this email already exists");
  const r = await q("INSERT INTO admins (name, email, password_hash, role_id) VALUES (?,?,?,?)",
    [str(b.name, { max: 120, required: true, name: "Name" }), em, await hashPassword(password(b.password)), role.id]);
  await audit(req, "admin.create", "admin", r.insertId, { email: em, role: role.slug });
  res.status(201).json({ id: r.insertId });
}));

router.put("/admins/:id", superOnly, wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  const b = req.body || {};
  const a = await one("SELECT a.*, r.slug role FROM admins a JOIN roles r ON r.id=a.role_id WHERE a.id=?", [id]);
  if (!a) throw notFound("Admin not found");
  const set = {};
  if (b.name !== undefined) set.name = str(b.name, { max: 120, required: true, name: "Name" });
  if (b.role !== undefined) {
    const role = await one("SELECT id, slug FROM roles WHERE slug=?", [String(b.role)]);
    if (!role) throw bad("Unknown role");
    set.role_id = role.id;
  }
  if (b.is_active !== undefined) set.is_active = bool(b.is_active) ? 1 : 0;
  if (b.password) set.password_hash = await hashPassword(password(b.password));
  // Never lock the shop out: keep at least one active super admin.
  const demoting = a.role === "super_admin" && ((set.role_id && set.role_id !== a.role_id) || set.is_active === 0);
  if (demoting) {
    const [{ n }] = await q("SELECT COUNT(*) n FROM admins a JOIN roles r ON r.id=a.role_id WHERE r.slug='super_admin' AND a.is_active=1 AND a.id<>?", [id]);
    if (!n) throw bad("There must be at least one active Super Admin");
  }
  if (!Object.keys(set).length) throw bad("Nothing to update");
  await q("UPDATE admins SET ? WHERE id=?", [set, id]);
  if (set.is_active === 0 || set.password_hash || set.role_id) await destroyAllSessions("admin", id, id === req.admin.id ? req.cookies[COOKIE.admin] : null);
  await audit(req, "admin.update", "admin", id, { ...set, password_hash: set.password_hash ? "changed" : undefined });
  res.json({ ok: true });
}));

router.delete("/admins/:id", superOnly, wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1 });
  if (id === req.admin.id) throw bad("You can't delete your own account");
  const a = await one("SELECT a.id, a.email, r.slug role FROM admins a JOIN roles r ON r.id=a.role_id WHERE a.id=?", [id]);
  if (!a) throw notFound("Admin not found");
  if (a.role === "super_admin") {
    const [{ n }] = await q("SELECT COUNT(*) n FROM admins a JOIN roles r ON r.id=a.role_id WHERE r.slug='super_admin' AND a.is_active=1 AND a.id<>?", [id]);
    if (!n) throw bad("There must be at least one active Super Admin");
  }
  await destroyAllSessions("admin", id);
  await q("DELETE FROM admins WHERE id=?", [id]); // audit log rows keep admin_id for history
  await audit(req, "admin.delete", "admin", id, { email: a.email });
  res.json({ ok: true });
}));

// ---------- integrations (Super Admin): live credential checks, never returns secrets ----------
router.get("/integrations", superOnly, wrap(async (req, res) => {
  res.json(await require("../../services/integrations").checkAll());
}));
router.post("/integrations/test-email", superOnly, wrap(async (req, res) => {
  const mail = require("../../services/mail");
  const to = req.admin.email; // only to the logged-in admin, so this can't be abused to send mail elsewhere
  const v = await mail.verify();
  if (!v.ok) throw bad("SMTP check failed: " + v.error);
  const sent = await mail.sendTemplate(to, "test");
  await audit(req, "integrations.test_email", "admin", req.admin.id, { sent });
  res.json({ ok: sent, to });
}));

router.get("/audit-logs", can("audit.view"), wrap(async (req, res) => {
  const { limit, offset, page } = pageParams(req.query, { def: 50, max: 200 });
  const where = [], params = [];
  if (req.query.admin_id) { where.push("l.admin_id=?"); params.push(int(req.query.admin_id, { min: 1 })); }
  if (req.query.entity_type) { where.push("l.entity_type=?"); params.push(String(req.query.entity_type)); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await q(`SELECT l.*, a.name admin_name, a.email admin_email FROM admin_audit_logs l LEFT JOIN admins a ON a.id=l.admin_id ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [{ n }] = await q(`SELECT COUNT(*) n FROM admin_audit_logs l ${w}`, params);
  res.json({ rows, total: n, page, limit });
}));

module.exports = router;
