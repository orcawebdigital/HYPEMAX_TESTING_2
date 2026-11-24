# HYPEMAX bug-fix, authentication, SSO, performance and security report (24 Nov 2026)

Branch: `fix/auth-cart-security-audit` (base: the zip as received, committed as `Baseline: uncommitted changes that came in the zip`).

How each item was checked:

* **Repro**: the bug was reproduced first.
* **Auto**: an automated test runs against the real Express app and a real MySQL 8 database.
* **Browser**: driven by hand in a real browser (desktop, and mobile at 375 px).

Third-party services (Google, Razorpay, SMTP) were **not** contacted: no credentials were supplied. Their code paths
are tested with in-memory fakes of the provider's network API. Our own validation, state, nonce, PKCE and session
logic still runs for real. Those items are marked *pending real credentials*.

## A. Bug-fix table

| Bug ID | Issue | Root cause | Fix implemented | Test result |
|---|---|---|---|---|
| BUG-002 | Product search by name not working | The whole query was matched as one `LIKE '%…%'` string, so extra spaces, word order and "pre workout" vs "Pre-Workout" all returned 0. Reproduced: `"pre  workout"`, `"  whey  "`, `"whey isolate"` gave 0 results. | Query is trimmed and spaces collapsed; hyphens are treated as spaces; it is split into up to 6 words, and **every word** must match name, SKU, flavour, description or category, in any order (case-insensitive collation; `%`/`_` escaped). Frontend: normalised query, live search with a 350 ms debounce, identical repeat requests skipped, stale requests aborted, "No products match “…”" message. | Repro ✔ · Auto ✔ (partial, case, spaces, hyphen, word order, no-results, `%` literal) · Browser ✔ |
| BUG-003 | Google OAuth not working | (1) If the site is opened on a host other than the callback host (www vs apex, a preview domain), the PKCE/state cookie is set on one host and the callback runs on the other, so every attempt ends with "session expired". (2) The CSRF Origin check blocked POSTs from the www twin (see BUG-008), so the popup flow's `/api/auth/google` POST failed too. (3) No loading state and no double-click guard; the Google script loaded on every login visit. | `/google/start` first bounces to the callback host when the visitor is on another host we own. www/apex and `ALLOWED_ORIGINS` are accepted. **Nonce** added to both flows (redirect: stored hashed in the state cookie; popup: one-time `/api/auth/google/nonce`). `iss` is checked. Google's white button style, full width, 46 px, a "Redirecting to Google…" state, double clicks ignored, a fresh nonce after a failure, and Google's script loaded only when the popup button is shown. | Auto ✔ (state, PKCE, nonce replay refused, unverified email refused, forged token, open-redirect `next`) · *pending real Google credentials* |
| BUG-004 | Password visibility toggle not working | No toggle existed anywhere. | Every password field on the storefront (login, register, confirm, reset, profile) gets an accessible show/hide button (`aria-pressed`, `aria-label`, keeps the cursor position). Fields are re-hidden on submit so browsers never save from a visible field. | Browser ✔ |
| BUG-005 | Detailed authentication review | See section C. Main findings: logout could fail silently; sessions weren't rotated on login; Google could merge into any same-email account; no nonce; signed-in pages were cacheable; nothing synchronised tabs. | All fixed (sections B and C). | Auto ✔ (20 new tests) |
| BUG-006 | Customer email incorrect | (1) After a failed logout the old session stayed, so A's email kept showing (BUG-008 chain). (2) Order emails and the Razorpay "resume payment" prefill used the email copied onto the order when it was placed, so a customer who changed their email kept getting mail at the old one. | (1) Fixed with BUG-008 and the account-switch fix. (2) Order and refund emails, status updates and the payment prefill now use the account's **current** email (falling back to the stored copy for deleted accounts). The dashboard shows "Signed in as <email>". | Auto ✔ (switch A→B→C shows the right email at every step) · Browser ✔ |
| BUG-007 | Delete address not working | **The Delete button was invisible and unclickable.** A decorative `.ghost` rule (giant outlined background text: `position:absolute; color:transparent; pointer-events:none`) also matched `class="btn ghost"`. The same bug hid **Remove coupon** and **Write a review**. `window.confirm()` is also suppressed in some in-app browsers. | Decorative rule scoped to `.ghost:not(.btn)`. Inline "Delete this address? Delete / Cancel" confirmation instead of `confirm()`. Errors are shown. The API returns 404 for an address that isn't yours (ownership in the `WHERE`), and the newest remaining address is promoted to default. | Repro ✔ (button rendered off-card and transparent) · Auto ✔ (own delete, IDOR 404, default promotion, double delete) · Browser ✔ |
| BUG-008 | Dashboard logout not working | `POST /api/auth/logout` was rejected with **403 "Cross-site request blocked"** whenever the browser's Origin wasn't exactly `SITE_URL` (www vs non-www, or a Vercel/Render host). The handler had **no error handling**, so nothing happened and the customer stayed signed in. Reproduced with `Origin: https://www.…` → 403. | Logout is exempt from the CSRF/Origin check (safe: it only removes access, and SameSite=Lax cookies aren't sent cross-site). The www/apex twin and `ALLOWED_ORIGINS` are trusted. New `HM.logout()` always completes: server session and SSO grants deleted, `hm_sid`/cart/Google cookies cleared, `Clear-Site-Data: "cache"`, per-account local/session storage cleared, other tabs told to reload, and `location.replace` so Back doesn't return. Signed-in pages are now `no-store` and reload if restored from the back/forward cache. | Repro ✔ · Auto ✔ · Browser ✔ (logout → Back shows login; second tab switched to login by itself) |
| BUG-009 | Required address fields not validated | The frontend relied on HTML `required`/`pattern` only (bypassed by the custom submit handlers). The backend checked presence but allowed names like "123", cities with digits, and anything as a state. Old saved addresses were never re-checked at checkout. | One shared address form and rule set for the dashboard and checkout, with a message under each field (red border, `aria-invalid`, focus on the first error). State is a dropdown of the 36 states/UTs. Backend `addressInput()` is used by every path and returns the `field` name. Saved addresses are re-validated at checkout (`ADDRESS_INVALID` asks the customer to edit). | Auto ✔ (16 invalid cases, each refused with the right field; nothing saved) · Browser ✔ |
| BUG-010 | Customer name and contact number entry not working | **On a first checkout (no saved address) the form had no Save button**, and Pay refused with "Save your delivery address first", so what the customer typed could never be saved. Mobile numbers with `+91`, spaces or dashes failed the HTML pattern. | The form always has "Use this address", and **Pay saves the address itself**. Name: letters/spaces/`.'-` only. Mobile: letters are stripped as you type; `+91`, a leading 0, spaces and dashes are accepted and normalised to 10 digits starting 6–9, on both client and server. Name and mobile are prefilled from the account. | Repro ✔ · Auto ✔ · Browser ✔ (saved as `9812345678` from `+91 98123-45678`) |
| BUG-011 | Pincode validation not working | The server checked `^[1-9]\d{5}$` but the messages were generic. The client allowed letters (the `pattern` was bypassed). | Digits only (letters stripped as you type), exactly 6, can't start with 0. Specific messages ("only digits", "exactly 6 digits", "can't start with 0"). Spaces inside ("226 010") are accepted. Shipping uses the validated stored pincode. | Auto ✔ (`22601`, `2260100`, `ABCDEF`, `22601A`, `026010` refused) · Browser ✔ |

## B. Requested features

### Mandatory login before Add to Cart
* **Backend:** `POST/PATCH/DELETE /api/cart/items` return `401 AUTH_REQUIRED` without a session. Guests' `GET /api/cart` returns an empty cart with `login_required: true`. Carts are keyed by `user_id`, so one customer can never see another's.
* **Frontend:** a guest's click is remembered (product, flavour, quantity, page). They see "Please log in to add products to your cart" and go to `/login?next=<product page>`. After login or sign-up they return, and the item is added **once**: the intent is cleared before the request, expires after 30 min, and only runs on the page where it started. Buy Now continues to checkout. An expired session takes the same path. Buttons are disabled while a request runs, so double clicks can't add twice. The cart page asks guests to log in.
* Old guest carts from before this change are still merged into the account on login.
* **Tests:** Auto ✔ (guest 401 on add/update/remove; isolation between customers; expired session; same cart on another device) · Browser ✔ (guest → login → back on product page, "Added to cart", badge = 1).

### Single Sign-On
A real OpenID Connect provider is built into the backend, not just a Google button. It uses Authorization Code + PKCE, RS256 ID and access tokens with a JWKS endpoint, rotating refresh tokens with reuse detection, revocation, userinfo and RP-initiated logout. Every grant is bound to the HYPEMAX session, so storefront logout ends every connected app. Full details are in [`docs/SSO.md`](SSO.md). **No second HYPEMAX app exists yet**, so none is connected. Adding one needs only an `SSO_CLIENTS` entry. Auto ✔ (7 tests).

### Account switching (Gmail A → logout → Gmail B shows A)
Root cause chain:

1. Logout silently failed (BUG-008), so A's session survived.
2. The login page then saw A's session and **auto-redirected to A's dashboard**, even after B had just authenticated with Google.
3. Pages restored from the back/forward cache, and other open tabs, kept showing A.
4. Logging in never ended the previous session on that browser.

Fixes:

* Logout always works.
* A session is **rotated on every login**: the old one is deleted.
* The login page shows "You're signed in as A – Continue / Use another account" instead of a silent redirect.
* Per-account browser storage is cleared whenever the account changes.
* BroadcastChannel and storage events reload other tabs, and the bfcache/visibility checks reload stale pages.
* Google's popup is told `disableAutoSelect()` on logout, and the redirect flow always uses `prompt=select_account`.

Tests:

* **Auto ✔:** A→logout→B→logout→C on one browser, with the old cookie dead each time; B logging in over A deletes A's session.
* **Browser ✔:** Bina → logout → Back → Alice shows Alice, her email, and an empty cart; the second tab follows the logout.
* **Real Gmail accounts:** *pending real credentials*.

## C. Security report

| # | Finding | Severity | Fix | Retest |
|---|---|---|---|---|
| 1 | Logout blocked by the Origin check, with errors ignored (stuck sessions; wrong account shown) | High | See BUG-008 | Auto ✔ |
| 2 | **Stock oversell**: one product split across many "flavour" lines (or a fake flavour on a product without flavours) passed the per-line stock check and the 10-unit limit | High | Stock and the limit are checked per product across all lines; a fake flavour is refused when adding and when pricing | Auto ✔ |
| 3 | **Late payment after cancel**: an order could still be paid after cancellation from the still-open Razorpay window, reusing a coupon someone else had since taken and taking stock without a check | High | `markPaid` re-checks stock and coupon limits under lock for released orders; on conflict the order is cancelled with a **full automatic refund** | Auto ✔ |
| 4 | No session rotation on login (fixation / stale session) | Medium | The old session is deleted on every login | Auto ✔ |
| 5 | Google account merged into any existing same-email account | Medium | Auto-link only when Google is authoritative for the address (Gmail, or a Workspace `hd` claim); otherwise "log in with your password". A nonce prevents token replay/injection. | Auto ✔ |
| 6 | Signed-in pages cacheable (Back shows previous customer) | Medium | `Cache-Control: no-store, private` plus bfcache reload | Auto ✔ / Browser ✔ |
| 7 | Payment captured before the amount check | Low | Amount compared before capture | Auto ✔ (existing amount-mismatch test) |
| 8 | Crash (500) when an order has no payment row | Low | Returns 400 | Code review |
| 9 | CMS accepted prototype keys (`constructor`, `__proto__`) | Low | `Object.hasOwn` allow-list | Auto ✔ |
| 10 | Admin image upload buffered up to 80 MB before the permission check | Low | Permission check runs before multer | Existing upload-permission tests ✔ |
| 11 | Admin password change: no rate limit, no input check | Low | 10/hour per admin; input validated | Code review |
| 12 | No Permissions-Policy; no server timeouts (Slowloris) | Low | Permissions-Policy; `headersTimeout` 20 s, `requestTimeout` 30 s, `keepAliveTimeout` 65 s, `maxHeadersCount` 100 | Auto ✔ (header) |
| 13 | Weak/common passwords accepted | Low | Common-password list; no leading or trailing spaces; strength meter | Auto ✔ |

**Checked and found safe** (independent review plus tests): SQL injection (all parameterised; dynamic names are whitelisted); mass assignment; webhook HMAC, deduplication and amount check; server-side pricing; coupon race conditions (locking reads); file upload (magic-byte type check, 8 MB, Cloudinary); open redirects (`next` and banner links); XSS in storefront and admin (all output escaped); CSV formula injection; no password hashes or tokens in responses; IDOR on orders, payments and addresses.

**Rate limits now in place** (per IP unless noted):
* Whole API: 300/min.
* Login: 20 per 15 min, plus a per-account lockout after 5 failures (15 min) and an IP ceiling of 20 failures per 15 min.
* Register: 10/h. Forgot password: 5/h. Reset: 10/h. Resend verification: 3/h.
* Google: 30 per 15 min.
* Add to cart: 60/min. Cart update/remove: 120/min.
* Checkout: 15 per 10 min. Verify: 30 per 10 min.
* Contact form: 8/h. Newsletter: 10/h.
* SSO authorize/token/revoke: 60/min.
* Admin password: 10/h per admin.
* Body limits: JSON 300 KB, form data 20 KB.

**DDoS (not solvable in app code).** These limiters are in memory, for a single Node process. They stop abuse and brute force, not a volumetric attack. For production:

* Put the site behind **Cloudflare** (free plan is fine): proxy DNS (orange cloud), SSL "Full (strict)", "Always use HTTPS", Bot Fight Mode on.
* Add a rate-limiting rule for `/api/auth/*` (for example 20 per minute per IP → managed challenge).
* Add a WAF managed ruleset.
* Cache `/css/*`, `/js/*` and `/img/*`; they are versioned (`?v=`) on every deploy.
* Lock the origin so it only accepts Cloudflare IPs.

**Remaining risks:**
* The in-memory limits reset on restart and aren't shared across instances. Use Redis if you scale out.
* Email verification is optional (`REQUIRE_EMAIL_VERIFICATION=false` by default, as before).
* Google, Razorpay and SMTP were not tested with real credentials.
* CSP still allows `'unsafe-inline'` styles (inline style attributes are used throughout).

## D. Performance report

Measured with **Lighthouse 12.2.1**: mobile form factor, default simulated throttling (slow 4G, 4× CPU), headless Chrome.

Both versions ran side by side on the same machine:
* **Before:** the original code, on port 4200.
* **After:** the fixed code, on port 4100.

Both use a local MySQL with the seed catalogue, in development mode. Local Lighthouse runs vary by ±10–20 points, so the login page was run 3× on each version (median shown).

| Page | Score before → after | FCP | LCP | TBT | CLS | Page weight |
|---|---|---|---|---|---|---|
| Home `/` | **68 → 91** | 2.5 → 1.6 s | 7.1 → 3.4 s | 0 → 0 | 0 → 0 | 1,099 → 270 KiB |
| Shop `/products` | **78 → 91** | 2.8 → 1.6 s | 4.9 → 3.5 s | 0 → 0 | 0 → 0.015 | 552 → 311 KiB |
| Product page | **81 → 95** | 1.9 → 2.0 s | 4.8 → 2.5 s | 110 → 0 ms | 0.035 → 0.035 | 924 → 519 KiB |
| Login (median of 3) | **76 → 94** | 3.1 → 2.5 s | 4.2 → 2.5 s | 0 → 0 | 0 → 0 | 407 → 132 KiB |

What changed:

* **Images (largest win):** WebP versions of every local image, capped at 2× display size and served automatically to browsers that accept WebP (`Vary: Accept`; the original is the fallback).
  * Homepage hero: 753 → 52 KiB.
  * Logo: 146 → 21 KiB.
  * All local images together: 1,407 → 677 KiB.
  * Images uploaded through the admin were already served by Cloudinary with `f_auto,q_auto`.
* **LCP image discovered early:** the homepage hero is preloaded from `<head>` with `fetchpriority="high"`. Before, it was only requested after two API calls.
* **No render-blocking font chain:** Google Fonts moved from an `@import` inside `style.css` (CSS → CSS → font) to `preconnect` plus a `<link>` in `<head>`.
* **Google's script (~90 KiB) not loaded on the login page** unless the popup button is actually shown.
* **gzip compression** for HTML, CSS, JS and JSON (`compression` middleware). Before, nothing was compressed:
  * `core.js`: 36 → 13 KiB.
  * `style.css`: 32 → 9 KiB.
* **Cache-busting asset versions** (`?v=<hash>`), so the 7-day static cache can never serve stale JS after a deploy.
* **Search:** debounced live search, duplicate requests skipped, stale requests aborted (fewer API calls).
* **Unchanged by design:**
  * The catalogue query: one parameterised query per listing, no N+1 (query times were not separately benchmarked).
  * Skeleton loaders: already present for product lists, the dashboard and reviews.
  * CLS is ≤ 0.035 on every page.

**Remaining recommendations:**
* Put Cloudflare (or any CDN) in front so images, CSS and JS are served from the edge.
* In production, images live on Cloudinary, so the WebP step only matters for the seed images, the logo and the hero cut-out.
* A Lighthouse run against the real production URL is still needed. These numbers are from a local machine.

## E. Testing report

* **Automated:** 70 tests, 70 passed, 0 failed. That is the 49 original tests, plus 1 split from an original, plus 20 new in `test/audit.test.js`. They run against the real Express app and MySQL 8.0.43. Command: `cd backend && TEST_DB_NAME=hypemax_test npm test`.
* Seven original tests were updated because they asserted the **old** behaviour the brief asked to change: guests adding to cart, phone optional at sign-up, and Google without a nonce or merging any email.
* **Browser (manual, real Chromium):**
  * guest Add to Cart → login → item added once
  * sign-up validation messages and the password toggle
  * first-time checkout address: invalid then valid
  * delete address
  * dashboard logout → Back
  * account switch Bina → Alice
  * two-tab logout sync
  * search with extra spaces
  * mobile 375 px layout (no horizontal scroll)
* **Blocked / pending external credentials:** real Google sign-in with 3 Gmail accounts; Razorpay live/test payment; SMTP delivery. Every integration is checked with **Admin → Integrations** after keys are added.

## F. Deployment

1. **Database:** `migrations/002_sso.sql` is applied automatically on start. No manual step.
2. **New environment variables** (all documented in `backend/.env.example`):
   * `ALLOWED_ORIGINS`: every extra host that serves the site or proxies `/api` (for example a Vercel URL).
   * `SSO_ISSUER`, `SSO_PRIVATE_KEY`, `SSO_CLIENTS`, `SSO_ACCESS_TOKEN_MINUTES`, `SSO_REFRESH_TOKEN_DAYS`.
3. **Google Cloud → Credentials → OAuth client (Web):**
   * Authorised JavaScript origins: `https://www.YOUR-DOMAIN` and `https://YOUR-DOMAIN`.
   * Authorised redirect URI: exactly the value of `GOOGLE_CALLBACK_URL`.
   * **Pick ONE canonical host**, use it in `SITE_URL` and `GOOGLE_CALLBACK_URL`, and redirect the other host to it.
4. **Render (backend):**
   * Start command: `npm start`; Node 20+.
   * Set `NODE_ENV=production`, `SITE_URL=https://…`, `COOKIE_SECURE=true` and the DB variables.
   * `trust proxy` is already on.
5. **Vercel (if the storefront is served from Vercel):**
   * Rewrite `/api/*`, `/oauth/*` and `/.well-known/*` to the Render URL, so cookies stay first-party.
   * Add the Vercel domain to `ALLOWED_ORIGINS`.
   * Better: serve the whole site from one origin.
6. **Cloudflare:** see section C.
7. **SSO clients:** see `docs/SSO.md`.
