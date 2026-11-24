const crypto = require("crypto");

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg, code) => new HttpError(400, msg, code);
/** Run a validator and tag any error with the form field it belongs to, so the UI can show it next to that field. */
const field = (name, fn) => {
  try { return fn(); } catch (e) { if (e instanceof HttpError) { e.field = name; e.code = e.code || "VALIDATION"; } throw e; }
};
const notFound = (msg = "Not found") => new HttpError(404, msg);
const forbidden = (msg = "You do not have permission to do that") => new HttpError(403, msg);

/** Wrap async route handlers so rejected promises reach the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

const slugify = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 170);

/** Rupees (number/string) -> integer paise, or null. */
const toPaise = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad("Invalid amount");
  return Math.round(n * 100);
};
const rupees = (p) => "Rs. " + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });

// ---------- input validation helpers ----------
const str = (v, { max = 255, min = 0, name = "Field", required = false, trim = true } = {}) => {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string" && typeof v !== "number") throw bad(`${name} is invalid`);
  let s = String(v);
  if (trim) s = s.trim();
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  if (s && s.length < min) throw bad(`${name} is too short (min ${min} characters)`);
  return s;
};
const optStr = (v, opts) => { const s = str(v, opts); return s === "" ? null : s; };
const int = (v, { min = -2147483648, max = 2147483647, name = "Number", required = false } = {}) => {
  if (v === undefined || v === null || v === "") { if (required) throw bad(`${name} is required`); return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
};
const bool = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "on";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const email = (v, { required = true } = {}) => {
  const s = str(v, { max: 190, name: "Email", required }).toLowerCase();
  if (s && !EMAIL_RE.test(s)) throw bad("Enter a valid email address");
  return s;
};
/** Indian mobile: accepts "98765 43210", "+91-9876543210", "09876543210"; stores the 10 digits. */
const phone = (v, { required = true, name = "Mobile number" } = {}) => {
  const raw = str(v, { max: 20, name, required });
  if (!raw) return raw;
  if (/[^\d\s()+-]/.test(raw)) throw bad(`${name} can only contain digits`);
  const s = raw.replace(/[\s()-]/g, "").replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, "");
  if (!/^\d{10}$/.test(s)) throw bad(`${name} must be exactly 10 digits`);
  if (!/^[6-9]/.test(s)) throw bad(`${name} must start with 6, 7, 8 or 9`);
  return s;
};
/** Person's name: letters (any script), spaces, . ' - only; 2-120 chars. */
const personName = (v, { name = "Name" } = {}) => {
  const s = str(v, { max: 120, min: 2, name, required: true }).replace(/\s+/g, " ");
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(s)) throw bad(`${name} can only contain letters, spaces, dots, hyphens and apostrophes`);
  return s;
};
const COMMON_PASSWORDS = new Set(["password1", "password123", "12345678a", "qwerty123", "abc12345", "abcd1234", "iloveyou1", "welcome1", "admin123", "letmein1", "passw0rd", "hypemax123"]);
const password = (v) => {
  const s = str(v, { max: 128, name: "Password", required: true, trim: false });
  if (s.length < 8) throw bad("Password must be at least 8 characters");
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad("Password must contain letters and numbers");
  if (/^\s|\s$/.test(s)) throw bad("Password can't start or end with a space");
  if (COMMON_PASSWORDS.has(s.toLowerCase())) throw bad("That password is too common. Choose a less predictable one");
  return s;
};
const pincode = (v) => {
  const s = str(v, { max: 10, name: "Pincode", required: true }).replace(/\s/g, "");
  if (/\D/.test(s)) throw bad("Pincode can only contain digits");
  if (s.length !== 6) throw bad("Pincode must be exactly 6 digits");
  if (s[0] === "0") throw bad("Enter a valid Indian pincode (it can't start with 0)");
  return s;
};
/**
 * Shipping address, used by the dashboard, checkout and order placement so every path enforces the same rules.
 * Every error carries the field name (BUG-009/010/011).
 */
const PLACE_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'()&-]*$/u;
const addressInput = (b = {}) => ({
  label: field("label", () => optStr(b.label, { max: 40, name: "Label" })),
  name: field("name", () => personName(b.name, { name: "Full name" })),
  phone: field("phone", () => phone(b.phone, { required: true })),
  line1: field("line1", () => {
    const s = str(b.line1, { max: 255, name: "House no. / street", required: true, min: 4 }).replace(/\s+/g, " ");
    if (!/[\p{L}\d]/u.test(s)) throw bad("Enter your house number and street");
    return s;
  }),
  line2: field("line2", () => optStr(b.line2, { max: 255, name: "Area / landmark" })),
  city: field("city", () => {
    const s = str(b.city, { max: 100, name: "City", required: true, min: 2 }).replace(/\s+/g, " ");
    if (!PLACE_RE.test(s)) throw bad("City can only contain letters and spaces");
    return s;
  }),
  state: field("state", () => {
    const s = str(b.state, { max: 100, name: "State", required: true, min: 2 }).replace(/\s+/g, " ");
    if (!PLACE_RE.test(s)) throw bad("State can only contain letters and spaces");
    return s;
  }),
  pincode: field("pincode", () => pincode(b.pincode)),
  is_default: bool(b.is_default) ? 1 : 0,
});
/** Free search text -> up to 6 lowercase terms (trimmed, whitespace collapsed, hyphens treated as spaces). */
const searchTerms = (v) => String(v || "").toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
  .split(" ").filter(Boolean).slice(0, 6);
const oneOf = (v, list, name = "Value") => { if (!list.includes(v)) throw bad(`${name} is invalid`); return v; };
const date = (v, name = "Date") => {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (isNaN(d)) throw bad(`${name} is invalid`);
  return d;
};
const jsonArr = (v, name = "List", sep = /\n|,/) => {
  if (v === undefined || v === null || v === "") return [];
  const a = typeof v === "string" ? v.split(sep) : v;
  if (!Array.isArray(a)) throw bad(`${name} must be a list`);
  return a.map((x) => String(x).trim()).filter(Boolean).slice(0, 50).map((x) => x.slice(0, 200));
};
const parseJson = (v, d = null) => {
  if (v === null || v === undefined) return d;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return d; }
};

const pageParams = (query, { max = 100, def = 20 } = {}) => {
  const limit = Math.min(max, Math.max(1, parseInt(query.limit, 10) || def));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
};

const csvEscape = (v) => {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Prevent CSV/Excel formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => [cols.map((c) => csvEscape(c[1])).join(","), ...rows.map((r) => cols.map((c) => csvEscape(typeof c[0] === "function" ? c[0](r) : r[c[0]])).join(","))].join("\r\n");

module.exports = {
  HttpError, bad, field, personName, searchTerms, addressInput, notFound, forbidden, wrap, randomToken, sha256, safeEqual, slugify, toPaise, rupees,
  str, optStr, int, bool, email, phone, password, pincode, oneOf, date, jsonArr, parseJson, pageParams, toCsv,
};
