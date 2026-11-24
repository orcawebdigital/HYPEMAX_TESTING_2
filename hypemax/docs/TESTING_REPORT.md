# Testing report: HYPEMAX Nutrition (2026-11-22)

## How to run
```
cd backend
TEST_DB_NAME=hypemax_test npm test        # needs an empty MySQL database the tests may wipe; uses DB_* from .env
```
Result on 2026-11-22 (Node 22.19, MySQL 8.0.43): **49 passed, 0 failed** (~50 s).

## What kind of test is what
| Kind | Meaning |
|---|---|
| **Automated, real** | Real Express app + real MySQL database; requests over HTTP like a browser. |
| **Automated, simulated** | Same, but the external service (Razorpay, Cloudinary, Google, SMTP) is replaced by an in-memory fake that behaves like its documented API. Signatures are real HMACs. These prove **our** code paths, not that the real service accepts your credentials. |
| **Manual, browser** | Clicked through in Chromium (built-in browser) at desktop and 375 px mobile width against the local dev server. |
| **Not yet tested against the real service** | Needs your credentials. See `API_CONFIGURATION_GUIDE.md` and Admin → Integrations. |

## Automated tests (49)

### `test/shop.test.js`: commerce, payments, permissions (24, real DB; Razorpay simulated)
CSRF enforcement · admin APIs refuse customer sessions · customer lockout after 5 failures · no hashes/secrets in responses · upcoming products not purchasable · invalid quantities/flavours rejected · guest cart merges on login · coupon rules (invalid, inactive, expired, not started, minimum order, category restriction; checkout refuses them too) · percent coupon with max cap · **tampered totals ignored, Razorpay order created for the server amount** · payment amount mismatch refused · forged signature refused · full purchase (reserve → verify → stock, coupon use, cart cleared, PDF invoice, idempotent verify, per-customer limit, other customers get 404) · **concurrent coupon use (4 parallel → 1)** · **concurrent last unit (3 parallel → 1)** · cancel unpaid order releases stock and coupon · webhook signature, confirmation, duplicate delivery · expired reservations reconciled with Razorpay before release · fulfilment, shipment, partial + full refund, over-refund refused · customer cancellation restocks and refunds · RBAC for order/content managers, CMS change visible on storefront, audit log entry · dashboard figures match DB · admin deletion safeguards · highlights keep commas.

### `test/integrations.test.js`: external integrations (14, simulated)
Emails: welcome + verification on sign-up; reset link; password-changed notice; single-use reset token; old sessions revoked; no account enumeration · order confirmation to customer + new-order alert to admin + shipped (with tracking) + refund emails · contact-form admin alert; test email only to the logged-in admin · templates escape user text.
Google: redirect flow sets state + PKCE, rejects wrong state, single-use state, signs in and redirects to `next` · open redirect via `next` blocked; cancelled consent shows error · unverified Google email and forged tokens rejected · **pre-registration takeover prevented** · verified account linked, password kept; different Google account for same email refused.
Cloudinary: multi-upload stores secure URL + public ID · fake PNG (PHP payload), SVG and 9 MB files refused · **replace uploads new before deleting old**; delete removes from Cloudinary · content slot (hero) and banner image replace/remove · customers and order managers can't upload.
Integrations check: all services report Working with fake credentials and **no secret appears** in the response or in `/api/config`; non-super-admins refused.

### `test/security.test.js`: attacks (11, real DB)
SQL injection in search/sort/category/price/ids/admin search · cookie flags (HttpOnly, SameSite, hashed tokens in DB) · Origin check blocks cross-site requests with a valid CSRF token · rate limiting actually returns 429 (5/hour on password reset) · admin lockout · privilege escalation (self-promotion, creating admins, audit/integrations access, shipping charges, exports, coupons, mass-assignment) · IDOR on addresses and checkout · another customer's payment can't be verified · webhook log stores no PII · security headers · generic 5xx/400 errors.

## Manual browser checks (local dev server)
| Area | Desktop | Mobile 375 px |
|---|---|---|
| Home: hero animation, scroll-pinned 3D tub landing in product card | ✅ | ✅ |
| Navigation underline on every page incl. nested routes, direct load, back/forward | ✅ | ✅ (menu) |
| Product listing: search, category pills, filters, sort | ✅ | ✅ |
| Product page: gallery arrows/dots/thumbnails, swipe, accordion incl. nutrition table, add to cart, sticky buy bar | ✅ | ✅ |
| Cart quantities, remove, coupon UI, summary | ✅ | n/c |
| Register → redirect to checkout; checkout with WhatsApp fallback (no Razorpay keys) | ✅ | ✅ |
| Account dashboard, order detail with tracking/history, invoice PDF layout | ✅ | ✅ (layout bug found and fixed) |
| About, Contact, FAQ, policies, 404 | ✅ | partly |
| Admin: dashboard, analytics, products, sections, inventory, categories, coupons, orders (status update), customers, content, banners, FAQs, reviews, messages, team (create/role/deactivate/delete), audit log, integrations | ✅ | ✅ (no horizontal scroll) |
| Stored XSS probe in admin Messages | ✅ rendered as text, not executed | |

Bugs found by manual testing and fixed: `account.js` syntax error, order page overlap on mobile, mobile gallery ratio, header animation stuck in background tabs, product card image overflow, cart badge "0", first add-to-cart for guests returned empty cart, invoice address overlap, customer-facing internal notes.

## Not yet tested against real services (needs your credentials)
| Service | What to do after configuring |
|---|---|
| Razorpay | Test-mode payment with `success@razorpay`, failure with `failure@razorpay`, partial refund, check webhook arrives (Admin → Integrations → *Last webhook*). |
| Cloudinary | Upload/replace/delete a product image; confirm seed images migrated on restart. |
| Google sign-in | Sign in from a private window on the real domain. |
| Email | *Send test email to me*, forgot-password, order confirmation. |
| Hostinger | Deploy, `/health`, SSL, environment variables. |
Exact steps: `API_CONFIGURATION_GUIDE.md`.

## Not covered
Load/performance testing, real-device testing on iOS Safari / Android Chrome (only emulated widths), cross-browser (Firefox/Safari), accessibility audit beyond labelled form fields and keyboard-operable gallery/accordion, penetration test from the internet.
