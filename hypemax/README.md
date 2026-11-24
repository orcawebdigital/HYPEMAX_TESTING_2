# HYPEMAX Nutrition: e-commerce platform

Storefront, customer accounts, checkout with Razorpay, and a role-based admin panel for **HYPEMAX Nutrition**.
One Node.js (Express) app + MySQL, images on Cloudinary. Built to run on Hostinger (Business/Cloud Node.js hosting or VPS).

| Document | What it's for |
|---|---|
| [`API_CONFIGURATION_GUIDE.md`](API_CONFIGURATION_GUIDE.md) | **Start here after deploying.** Get and enter Razorpay, Cloudinary, Google, email and MySQL credentials yourself, then test each one. |
| [`docs/DEPLOYMENT-HOSTINGER.md`](docs/DEPLOYMENT-HOSTINGER.md) | Hostinger plan requirements, deployment, SSL, backups, updates |
| [`backend/.env.example`](backend/.env.example) | Every environment variable (template, no values) |
| [`docs/API.md`](docs/API.md) | HTTP API reference |
| [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md) | Security review: what's protected, how it was verified, residual risks |
| [`docs/TESTING_REPORT.md`](docs/TESTING_REPORT.md) | Automated + manual test results; simulated vs real |
| [`docs/FIX-REPORT-2026-11.md`](docs/FIX-REPORT-2026-11.md) | **Nov 2026 bug-fix, auth, SSO, performance and security report** (start here for this release) |
| [`docs/SSO.md`](docs/SSO.md) | HYPEMAX Single Sign-On (OpenID Connect provider): how to connect other HYPEMAX apps |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Audit of the original site, what changed, data questions for the client |
| [`backend/migrations/`](backend/migrations) | MySQL schema (applied automatically on start) |

## Structure

```
package.json            root for Hostinger (npm install / npm start)
backend/
  server.js             entry: runs migrations + seed, starts the app and background jobs
  migrations/*.sql      MySQL schema (auto-applied on start)
  src/
    app.js              Express app: security headers, CSRF, sessions, routes, clean URLs, sitemap/robots
    config.js db.js migrate.js seed.js cli.js rbac.js auth.js security.js util.js
    services/           pricing (server-side totals + coupons), orders (reserve/pay/release/refund),
                        razorpay, cloudinary, catalog, cart, analytics, invoice (PDF), mail, content (CMS)
    routes/             public, auth, cart, checkout (+ Razorpay webhook), account, admin/*
  test/                 integration tests (real MySQL, fake Razorpay network)
frontend/               static files served by Express (no build step)
  *.html                page shells (SEO meta injected server-side for product pages)
  js/core.js            shared: API client (CSRF), header/footer, active nav, accordion, cards, analytics
  js/pages/*.js         home, shop (listing + product), checkout (cart + checkout), account (login + dashboard), info
  js/admin.js, css/admin.css, admin.html    admin panel
  css/style.css         storefront styles (brand tokens, responsive)
  img/                  logo, original hero cut-out, client product photos (seed only; production images are on Cloudinary)
```

## Run locally

Requirements: Node 20+, MySQL 8 (or MariaDB 10.6+).

```
cd backend
cp .env.example .env      # set DB_*, SITE_URL=http://localhost:4000, COOKIE_SECURE=false, NODE_ENV=development, ADMIN_EMAIL/ADMIN_PASSWORD
npm install
npm start                 # http://localhost:4000  (admin at /admin)
```

Tests: 70 integration tests (needs an empty database you don't mind wiping, default name `hypemax_test`, same DB user/host as `.env`). External services are replaced by in-memory fakes, so no credentials are needed:

```
cd backend && TEST_DB_NAME=hypemax_test npm test
```

## Feature status

**Implemented and covered by automated tests or verified in the browser locally**
- Catalogue: products with MRP/selling price/auto discount %, statuses (Draft, Upcoming, Coming soon, Active, Out of stock, Discontinued; only Active with stock is purchasable), categories, search, filters, sorting, related & recently viewed, reviews (verified purchasers, moderated).
- Product page: swipeable image gallery (arrows, dots, thumbnails, keyboard), collapsible accordion sections managed from admin, sticky mobile buy bar.
- Cart (guest + account, merged on login), wishlist, addresses, server-priced totals.
- Coupons: percent/fixed, min order, max discount, start/expiry, total and per-customer limits, product/category restrictions. Validated only on the server, locked rows to prevent overuse under concurrent checkouts *(tested with parallel orders)*.
- Checkout → server-created Razorpay order → signature verification → payment fetched from Razorpay and amount checked → order confirmed. Idempotent; webhook (HMAC-verified, de-duplicated) as backup; unpaid orders hold stock/coupon for 30 min and are reconciled with Razorpay before release *(tested with a simulated Razorpay API)*.
- Orders: status history, shipments (courier, tracking ID/URL, ETA), cancel (auto refund), partial/full refunds, returns, PDF invoices, CSV export.
- Customer dashboard: overview stats, orders by status, tracking, payments & refunds, invoices, wishlist, addresses, notifications, recently viewed, profile, password.
- Auth: bcrypt (12 rounds), httpOnly session cookies (hashed in DB), CSRF double-submit + Origin check, rate limits, account lockout, password reset & email verification tokens, separate admin sessions.
- Admin: Super Admin / Manager / Content Manager / Order Manager with server-side permission checks, audit log, dashboard & analytics from real data (first-party, cookie-based, honours Do-Not-Track/GPC), product/inventory/section management, CMS (settings, homepage, about, contact, policies, banners, FAQs, site images), customers (search, filters, export), messages, newsletter.
- SEO: clean URLs (`/products/<slug>`), server-side titles/descriptions/OG tags, `sitemap.xml`, `robots.txt`, FAQ structured data.
- Navigation underline follows the current route on direct loads, nested routes and back/forward.

**Built, waiting for your credentials (cannot be tested end-to-end without them)**
| Integration | Needed | Until then |
|---|---|---|
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Checkout shows a notice + "Order on WhatsApp" fallback |
| Cloudinary | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Admin uploads return a clear "not configured" message; seed photos served from the app (moved to Cloudinary automatically once configured) |
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Button hidden; email/password works. With only the Client ID, the popup flow is used. |
| Email (SMTP) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `ADMIN_NOTIFY_EMAIL` | Emails are skipped (only the template name and a masked address are logged); forgot-password tells the customer to contact support |

After adding credentials: **Admin → Integrations** (or `npm --prefix backend run check`) tests each service with your keys and shows only Working / Not configured / Failed, never the secrets.

Courier APIs (Shiprocket etc.) are not integrated. Shipments are entered manually by admins and the site never shows invented tracking events. `shipments.provider`/`provider_ref` columns are there for a future integration.
