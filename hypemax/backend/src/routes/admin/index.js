const router = require("express").Router();
const config = require("../../config");
const { q, one } = require("../../db");
const { wrap, email, str, HttpError } = require("../../util");
const { rateLimit, checkLoginAllowed, recordLogin } = require("../../security");
const { checkPassword, createSession, destroySession, requireAdmin, audit } = require("../../auth");

// Every admin request is marked no-store so admin data never sits in shared caches.
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.post("/login", rateLimit({ windowMs: 15 * 60e3, max: 10, message: "Too many login attempts. Try again in 15 minutes." }), wrap(async (req, res) => {
  const b = req.body || {};
  const em = email(b.email);
  const pw = str(b.password, { max: 128, name: "Password", required: true, trim: false });
  const a = await one("SELECT * FROM admins WHERE email=?", [em]);
  await checkLoginAllowed("admin", req.ip, a);
  const ok = a && a.is_active && (await checkPassword(pw, a.password_hash));
  await recordLogin("admin", "admins", req.ip, em, a, !!ok);
  if (!ok) throw new HttpError(401, "Incorrect email or password", "BAD_CREDENTIALS");
  await createSession(res, req, "admin", a.id);
  req.admin = { id: a.id };
  await audit(req, "admin.login", "admin", a.id);
  res.json({ ok: true });
}));

router.post("/logout", wrap(async (req, res) => {
  if (req.admin) await audit(req, "admin.logout", "admin", req.admin.id);
  await destroySession(req, res, "admin");
  res.json({ ok: true });
}));

router.use(requireAdmin);

router.get("/me", wrap(async (req, res) => {
  res.json({
    admin: { id: req.admin.id, name: req.admin.name, email: req.admin.email, role: req.admin.role, role_name: req.admin.role_name, permissions: req.admin.role === "super_admin" ? ["*"] : req.admin.permissions },
    features: config.features,
  });
}));

router.use("/", require("./dashboard"));
router.use("/products", require("./products"));
router.use("/", require("./media"));
router.use("/orders", require("./orders"));
router.use("/customers", require("./customers"));
router.use("/coupons", require("./coupons"));
router.use("/", require("./content"));
router.use("/", require("./team"));

module.exports = router;
