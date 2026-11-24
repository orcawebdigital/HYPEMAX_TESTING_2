# Security audit: HYPEMAX Nutrition (2026-11-22)

Scope: everything in this repository (Express backend, storefront, admin panel), as deployed per `docs/DEPLOYMENT-HOSTINGER.md`.
Method: code review of every route and service, plus **behavioural tests** that attack the running app against a real MySQL database (`backend/test/*.test.js`, 49 tests, all passing). A control is listed as verified only when a test or manual check exercised it.
Not in scope: Hostinger's infrastructure, the third-party services themselves, penetration testing from the internet, load testing.

## Summary

| Area | Status | How it was verified |
|---|---|---|
| SQL injection | ✅ Protected | All queries parameterised (mysql2 `?`), `ORDER BY` from allow-lists, `multipleStatements` off. Test *SQL injection payloads … are inert* (search, sort, category, price, ids, admin search). |
| XSS (storefront/admin) | ✅ Protected | All DB/user text is HTML-escaped before insertion; rich text uses a whitelisted renderer that escapes first; CSP `script-src 'self'` (no inline scripts allowed). Manual browser check: `<img onerror>`/`<script>` payload in a contact message renders as text in the admin panel and does not execute. |
| XSS (emails) | ✅ Protected | Templates escape all user text. Test *email templates escape user-supplied text*. |
| CSRF | ✅ Protected | Double-submit token (`hm_csrf`, SameSite=Strict) required on every state-changing `/api` call + Origin check; session cookies SameSite=Lax. Tests: *…without the CSRF token are rejected*, *cross-site requests are refused even with a valid CSRF token*. OAuth callback protected by one-time `state` (test *google redirect flow …*). |
| Password storage | ✅ | bcrypt, cost 12; constant-time comparison incl. dummy hash for unknown emails (no timing-based account discovery). Hashes never returned (test *password hashes and secrets never appear*). |
| Sessions | ✅ | 256-bit random tokens, only SHA-256 stored in DB, httpOnly + SameSite=Lax + Secure (prod) cookies, server-side expiry (14 d customer / 12 h admin), separate admin cookie, revoked on password change/reset, admin deactivation and role change. Tests: *session cookies are HttpOnly…*, *reset … old session was revoked*. |
| Brute force | ✅ | Per-account lockout (5 failures → 15 min) for customers and admins, per-IP failure ceiling, per-route IP rate limits. Tests: *account locks after 5 failures*, *admin brute force*, *rate limiting actually throttles*. |
| Authorisation / RBAC | ✅ | Every admin route checks permissions on the server; field-level checks on products (content managers can't change price/stock/status) and shipping charges. Tests: *role-based access…*, *privilege escalation attempts are blocked*, *only authorised admins can upload*. |
| IDOR | ✅ | All customer queries are scoped by `user_id`. Tests: *customers can only see their own data*, *verify endpoint refuses another customer's payment*, invoice of another customer → 404. |
| Payment verification | ✅ (simulated) | Razorpay order created server-side for the server-computed amount; HMAC signature check (timing-safe); payment fetched from Razorpay and amount/order/currency matched; idempotent confirmation; late payments reconciled. Tests: forged signature, wrong amount, replayed verify, reconcile on expiry. |
| Webhook verification | ✅ (simulated) | HMAC over the raw body, timing-safe; duplicate event IDs ignored; failures release the dedupe marker so Razorpay retries. Tests: bad signature → 400, duplicate → ignored. |
| Coupon manipulation | ✅ | Coupons validated and amounts computed only on the server; client-sent totals ignored; row locks + locking reads prevent over-use under concurrency. Tests: tampered totals, expired/not-started/min-order/restricted, per-customer limit, **4 parallel checkouts on a 1-use coupon → exactly 1 succeeds**. |
| Stock integrity | ✅ | Reservation with row locks. Test: 3 parallel checkouts for the last unit → exactly 1 succeeds. |
| File uploads | ✅ | Admin-only; type detected from **magic bytes** (PNG/JPEG/WEBP/AVIF only; SVG refused); 8 MB limit; max 10 files; memory storage → Cloudinary (nothing written to Hostinger disk); random public IDs. Tests: PHP-in-.png refused, SVG refused, 9 MB refused, replace uploads new before deleting old. |
| Sensitive data exposure | ✅ | Secrets read only from env; `/api/config` exposes only the public Razorpay Key ID and Google Client ID; integrations check returns pass/fail only. Test *integrations check reports status without leaking any secret* (scans responses for every secret). Webhook log stores IDs/amounts only (test). Error logs no longer include SQL text or parameters; dev mail log no longer prints message bodies (reset links). |
| Error handling | ✅ | 5xx returns a generic message; no stack traces or SQL to clients (test). |
| Security headers | ✅ | Helmet: CSP, HSTS (prod), X-Content-Type-Options, frame protection, `strict-origin-when-cross-origin` referrer, no `X-Powered-By` (test). |
| Open redirects | ✅ | `next=` only accepts same-site paths (`//x`, `/\x` refused), both in the browser and the OAuth callback (test). |
| Account takeover via Google linking | ✅ **Fixed in this audit** | Previously, signing in with Google linked to an existing account with the same email even if that account's email was never verified, so a squatter who pre-registered a victim's email kept a working password. Now an unverified account's password is removed and its sessions revoked on link; a verified account is linked normally; a different Google account for the same email is refused. Tests cover all three cases. |
| Environment protection | ✅ | `.gitignore` excludes `.env*` (except the template), key files and OAuth client JSON. `git ls-files` contains no env file. `.env.example` has no values. |
| Database transactions | ✅ | Order creation, payment confirmation, release, refunds, cancellations, inventory and coupon usage run in transactions with row locks; refund amount is reserved before calling Razorpay to prevent double refunds. |
| Dependencies | ✅ | `npm audit --omit=dev`: **0 vulnerabilities** after upgrading nodemailer to 10.x and google-auth-library to 10.x (fixed 1 high, 2 moderate). |

## Issues found and fixed during development
1. **Coupon over-use race** (high): usage counted with a snapshot read after acquiring the coupon lock → 4 of 4 concurrent orders got a single-use coupon. Fixed with locking reads. Regression test added.
2. **Google pre-registration account takeover** (high): see table above.
3. **Lockout off-by-one** (low): accounts locked after 4 failures instead of 5.
4. **Guest cart merge error** (medium, availability): login returned 500 when a guest cart existed.
5. **Open redirect via `/\host`** (medium): `next=` accepted backslash paths.
6. **PII in logs** (medium): MySQL errors logged with full SQL and parameters; dev mail logger printed reset links. Both removed.
7. **PII in webhook log** (low): full Razorpay payloads (contact, VPA, card last4) were stored; now IDs and amounts only.
8. **Vulnerable dependencies** (high/moderate): nodemailer ≤ 10.1.3, uuid < 11.1.1; upgraded.

## Residual risks and recommendations (none critical)
| Risk | Severity | Recommendation |
|---|---|---|
| Registration reveals whether an email already has an account (409) | Low | Accepted for usability; login and password reset do not reveal it. |
| Rate limits are in memory (per Node process) | Low | Fine for a single Hostinger app instance. If you ever run several instances, move limits to MySQL/Redis. Per-account lockout is already DB-backed. |
| No two-factor authentication for admins | Medium | Use long unique admin passwords, keep few Super Admins, review Admin → Audit log. Consider adding TOTP 2FA before scaling the team. |
| CSP allows inline `style` attributes | Low | Scripts are fully restricted; inline styles can't execute code. |
| Per-customer coupon limits can be bypassed with a new account | Low (business) | Use usage limits, minimum order values and short expiries for high-value coupons. |
| Admin sessions have a fixed 12 h lifetime, no idle timeout | Low | Log out on shared computers; reduce `ADMIN_SESSION_HOURS` if desired. |
| Uploaded images aren't virus-scanned | Low | Only raster image formats are accepted and they're served from Cloudinary's domain, not yours. |
| Real third-party behaviour (Razorpay, Cloudinary, Google, SMTP) | n/a | Verified only against faithful fakes. After you add credentials, run Admin → Integrations and the manual tests in `API_CONFIGURATION_GUIDE.md`. |

## Production checklist
- [ ] `NODE_ENV=production`, `SITE_URL=https://…`, `COOKIE_SECURE=true` (Admin → Integrations → *Site & security* = Working)
- [ ] SSL + *Force HTTPS* enabled in hPanel
- [ ] `ADMIN_PASSWORD` removed from the environment after first login
- [ ] Razorpay webhook created for the live domain with its own secret
- [ ] Database backups enabled and one restore tested
- [ ] Only the people who need it have admin accounts; roles reviewed
