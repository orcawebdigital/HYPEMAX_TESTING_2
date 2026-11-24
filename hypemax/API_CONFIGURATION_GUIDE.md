# HYPEMAX Nutrition: API & credential configuration guide

This guide is for **you** to configure every external service yourself. Nobody (including any AI assistant) needs to see your keys.

**Rules**
- Enter secrets only in **Hostinger → your Node.js app → Environment variables** (production) or your own local `backend/.env` (development, git-ignored).
- Never paste secrets into chats, tickets, emails, screenshots or source code. `backend/.env.example` is the template and contains no values.
- After changing any variable, **restart the app**, then open **Admin → Integrations** (Super Admin) or run `npm --prefix backend run check`. Both test each service with your credentials and show **Working / Not configured / Failed** without ever displaying a secret.

### Where variables go on Hostinger
hPanel → **Websites** → your site → **Node.js** (the app you deployed) → **Environment variables** → *Add variable* (name + value) → **Save** → **Restart**.
(Menu names can differ slightly between Hostinger plans; look for the Node.js app's *Settings/Environment* section.)

### Summary of every credential

| Service | Variable | Secret? | Where you get it |
|---|---|---|---|
| Site | `SITE_URL` | no | Your final `https://` domain |
| MySQL | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | no | hPanel → Databases |
| MySQL | `DB_PASSWORD` | **yes** | You choose it in hPanel |
| First admin | `ADMIN_EMAIL` | no | Your email |
| First admin | `ADMIN_PASSWORD` | **yes** | You choose it (remove after first login) |
| Razorpay | `RAZORPAY_KEY_ID` | no (public) | Razorpay → API Keys |
| Razorpay | `RAZORPAY_KEY_SECRET` | **yes** | Razorpay → API Keys (shown once) |
| Razorpay | `RAZORPAY_WEBHOOK_SECRET` | **yes** | You invent it when creating the webhook |
| Cloudinary | `CLOUDINARY_CLOUD_NAME` | no | Cloudinary console |
| Cloudinary | `CLOUDINARY_API_KEY` | no | Cloudinary console |
| Cloudinary | `CLOUDINARY_API_SECRET` | **yes** | Cloudinary console |
| Google | `GOOGLE_CLIENT_ID` | no (public) | Google Cloud → Credentials |
| Google | `GOOGLE_CLIENT_SECRET` | **yes** | Google Cloud → Credentials |
| Google | `GOOGLE_CALLBACK_URL` | no | `https://YOUR-DOMAIN/api/auth/google/callback` |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `EMAIL_FROM`, `ADMIN_NOTIFY_EMAIL` | no | Your email provider |
| Email | `SMTP_PASS` | **yes** | Your mailbox password / app password |

Only `RAZORPAY_KEY_ID` and `GOOGLE_CLIENT_ID` are ever sent to browsers (they're designed to be public). Every secret stays on the server.

---

## A. Razorpay (payments)

### 1. Account
1. Sign up at **https://razorpay.com** → *Sign Up*. You can use **Test mode** immediately; Live mode needs KYC (PAN, bank account, business details, website with policies; your site already has the four policy pages).

### 2. Key ID and Key Secret
1. Razorpay Dashboard → switch the mode toggle (top bar) to **Test Mode**.
2. **Account & Settings → API Keys** (under *Website and app settings*) → **Generate Key** (or *Regenerate*).
3. A dialog shows **Key ID** (`rzp_test_…`) and **Key Secret**. The secret is shown **only once**. Download/store it in your password manager.
4. In Hostinger set:
   - `RAZORPAY_KEY_ID` = the Key ID
   - `RAZORPAY_KEY_SECRET` = the Key Secret

### 3. Webhook
1. Dashboard (still in Test Mode) → **Account & Settings → Webhooks** → **Add New Webhook**.
2. **Webhook URL**: `https://YOUR-DOMAIN/api/payments/webhook` (must be public HTTPS; it won't work on `localhost`).
3. **Secret**: make up a long random string (e.g. 40 characters from your password manager's generator).
4. **Active events**, tick exactly these:
   - `payment.captured`
   - `payment.failed`
   - `order.paid`
   - `refund.processed`
   - `refund.failed`
5. Save. In Hostinger set `RAZORPAY_WEBHOOK_SECRET` = the same secret. Restart.

### 4. Settings to check
- **Account & Settings → Payment capture**: *Automatic* (recommended; the site also captures authorised payments itself if needed).

### 5. Test a payment (test mode: no real money)
1. Admin → **Integrations**: *Razorpay payments* = **Working (Mode: TEST)**, *Razorpay webhook* = **Working**.
2. On the storefront, log in as a customer, add HYPEMAX Pre-Workout to the cart, **Checkout**, choose an address, **Pay**.
3. In the Razorpay window:
   - **UPI** → enter `success@razorpay` → payment succeeds. (`failure@razorpay` simulates a failure.)
   - Or **Card** → use a card from Razorpay's *Test Card Details* documentation page (any future expiry, any CVV, OTP page: click *Success*).
4. You should land on **My Account → Orders → (order)** with *Payment confirmed*, and receive the confirmation email if email is configured.
5. Check **Admin → Orders**: the order shows the Razorpay order ID and payment ID. Admin → Integrations should now show a *Last webhook* event.
6. Test a refund: Admin → Orders → the order → **Refund** (e.g. ₹100) → status becomes *Partially refunded*; Razorpay Dashboard → *Refunds* lists it.
7. Test failure: pay with `failure@razorpay` → the checkout shows the error and lets you retry; the order stays *Awaiting payment* and is released after 30 minutes.

### 6. Going live
Complete KYC → switch dashboard to **Live Mode** → generate Live keys (`rzp_live_…`) → replace `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` → create the **same webhook again in Live mode** (webhooks are per-mode) with a new secret → update `RAZORPAY_WEBHOOK_SECRET` → restart → Integrations should show *Mode: LIVE*. Do one small real payment and refund it.

---

## B. Cloudinary (image storage & CDN)

### 1. Account
Sign up at **https://cloudinary.com** (free plan is enough to start).

### 2. Cloud name, API key, API secret
1. Cloudinary Console → **Dashboard** (the *Product Environment Credentials* panel), or **Settings (gear) → API Keys**.
2. Copy:
   - **Cloud name** → `CLOUDINARY_CLOUD_NAME`
   - **API Key** → `CLOUDINARY_API_KEY`
   - **API Secret** (click the eye icon / *Reveal*) → `CLOUDINARY_API_SECRET`
3. Optional: `CLOUDINARY_FOLDER` (default `hypemax`): all uploads go under this folder.
4. Restart. (Alternatively you may set the single `CLOUDINARY_URL` value Cloudinary shows; don't set both.)

### 3. What happens on restart
The product photos that ship with the code are **automatically uploaded to Cloudinary** on the first start with valid credentials, and the database is switched to the Cloudinary URLs. Check the app log for `[images] uploaded …` lines.

### 4. Test uploads
1. Admin → **Integrations**: *Cloudinary images* = **Working** (shows your cloud name).
2. Admin → **Products** → HYPEMAX Pre-Workout → **Images** → upload a JPG/PNG/WEBP (max 8 MB). The thumbnail appears; its URL starts with `https://res.cloudinary.com/<your cloud>/`.
3. Try **Replace**, **reorder** and **Delete**; in Cloudinary → *Media Library* → folder `hypemax/products/...` you'll see the files come and go.
4. Admin → **Content → Site images**: upload a transparent PNG of the tub to the **hero** slot (used by the homepage 3D animation).

---

## C. Google sign-in (OAuth)

### 1. Project
1. Go to **https://console.cloud.google.com** → project picker → **New project** (e.g. "HYPEMAX Website").

### 2. OAuth consent screen
1. **APIs & Services → OAuth consent screen** (newer consoles call this **Google Auth Platform → Branding / Audience**).
2. User type: **External**.
3. App name: *HYPEMAX Nutrition*; support email: yours; logo optional; **Authorised domains**: your domain (e.g. `your-domain.in`); developer contact email.
4. Scopes: only the defaults are needed: `openid`, `email`, `profile` (no sensitive scopes, so no Google verification review is required).
5. **Publishing status**: click **Publish app** (otherwise only listed test users can sign in).

### 3. OAuth client (Client ID & Secret)
1. **APIs & Services → Credentials → Create credentials → OAuth client ID** (or *Google Auth Platform → Clients → Create client*).
2. Application type: **Web application**. Name: *HYPEMAX website*.
3. **Authorised JavaScript origins**:
   - `https://YOUR-DOMAIN` (and `https://www.YOUR-DOMAIN` if you use www)
   - `http://localhost:4000` (only if you test locally)
4. **Authorised redirect URIs**:
   - `https://YOUR-DOMAIN/api/auth/google/callback`
   - `http://localhost:4000/api/auth/google/callback` (only for local testing)
5. Create → copy **Client ID** (ends in `.apps.googleusercontent.com`) and **Client secret**.
6. In Hostinger set:
   - `GOOGLE_CLIENT_ID` = Client ID
   - `GOOGLE_CLIENT_SECRET` = Client secret
   - `GOOGLE_CALLBACK_URL` = `https://YOUR-DOMAIN/api/auth/google/callback` (must match step 4 **exactly**, including `www` or not)
7. Restart.

### 4. Test
1. Admin → **Integrations**: *Google sign-in* shows "Redirect flow enabled" and the exact callback URL to compare with Google Cloud.
2. Open your site's `/login` in a private window → **Continue with Google** → choose an account → you land on *My Account*.
3. Common errors: `redirect_uri_mismatch` = the callback URL in Google Cloud doesn't exactly match `GOOGLE_CALLBACK_URL`; `access blocked: app not published` = publish the consent screen.

How it's secured: one-time `state` + PKCE, server-side code exchange with the client secret, ID-token signature/audience/expiry verified on the server, and accounts are linked only for Google-verified emails.

---

## D. Email (SMTP)

### Recommended provider
**Hostinger Email** (included with most Hostinger plans) for transactional mail from your own domain. For higher volume or better inbox placement later: Brevo, Amazon SES or Zoho Mail; they all work with the same SMTP settings below.

### 1. Create a mailbox
hPanel → **Emails** → your domain → **Create email account**, e.g. `no-reply@your-domain.in` (or `orders@…`). Set its password (this is your `SMTP_PASS`).

### 2. Settings
| Variable | Hostinger Email value |
|---|---|
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` (SSL) — or `587` with `SMTP_SECURE=false` (STARTTLS) |
| `SMTP_SECURE` | `true` for 465, `false` for 587 |
| `SMTP_USER` | the full mailbox address, e.g. `no-reply@your-domain.in` |
| `SMTP_PASS` | that mailbox's password (**secret**) |
| `EMAIL_FROM` | `"HYPEMAX Nutrition <no-reply@your-domain.in>"`; must be the same mailbox (or an alias of it) |
| `ADMIN_NOTIFY_EMAIL` | where new-order and contact-form alerts go, e.g. `orders@your-domain.in` (comma-separated for several) |

Gmail/Google Workspace alternative: `smtp.gmail.com`, port 465, user = the address, password = a 16-character **App password** (Google Account → Security → 2-Step Verification → App passwords). Never your normal password.

### 3. Deliverability (do this once)
hPanel → Emails → your domain → **DNS / Email authentication**: make sure **SPF**, **DKIM** and **DMARC** records are present (Hostinger can add them automatically). Without them, order emails may land in spam.

### 4. Test
1. Admin → **Integrations**: *Email (SMTP)* = **Working**.
2. Click **Send test email to me**: it goes only to the logged-in admin's address.
3. On the storefront, register a test customer with an address you own → you get *Welcome* + *Verify your email*. Use **Forgot password** → you get the reset link.
4. After a test payment you get *Order confirmed*, and `ADMIN_NOTIFY_EMAIL` gets *New order*.

Emails sent: welcome, email verification, password reset, password changed, order confirmed (payment received), status updates (shipped with tracking, out for delivery, delivered…), order cancelled, refund initiated/processed, admin new-order alert, admin contact-form alert.

---

## E. MySQL (database)

### 1. Create the production database
hPanel → **Databases → MySQL Databases** → *Create a new MySQL database and user*:
- **Database name**: e.g. `hypemax` → Hostinger prefixes it: `u123456789_hypemax` → `DB_NAME`
- **Username**: e.g. `hypemax` → becomes `u123456789_hypemax` → `DB_USER`
- **Password**: generate a strong one → `DB_PASSWORD` (**secret**)

### 2. Connection settings
| Variable | Value |
|---|---|
| `DB_HOST` | `localhost` when the Node.js app runs on the same Hostinger account (hPanel shows the host if different) |
| `DB_PORT` | `3306` |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | from step 1 |
| `DB_SSL` | `false` on the same server; `true` only for a remote DB that requires TLS |

### 3. Migrations (safe by design)
- Migrations run **automatically when the app starts** (`backend/migrations/*.sql`). Each file runs once and is recorded in `schema_migrations`; existing data is never dropped.
- To run them manually (Hostinger SSH terminal or locally against the production DB): `npm --prefix backend run migrate`.
- **Before deploying a new version that adds a migration, take a backup** (hPanel → Databases → *Backups*, or phpMyAdmin → Export).
- Never run the test suite against the production database: tests wipe the database they use (`TEST_DB_NAME`, default `hypemax_test`).

### 4. Test
Visit `https://YOUR-DOMAIN/health` → `{"ok":true,"db":true}`. Admin → Integrations → *MySQL database* = **Working** with the number of migrations applied.

---

## F. After everything is configured
1. Admin → **Integrations** → every row **Working** (Site & security requires `https://` `SITE_URL`, `NODE_ENV=production`, `COOKIE_SECURE=true`).
2. Remove `ADMIN_PASSWORD` from the environment after your first admin login and change your password under Admin → **Account**.
3. Run through section A.5 (test payment + refund) once in Test mode, then again with one small real payment after going live.
4. If you ever suspect a key leaked: rotate it in the provider's dashboard (Razorpay *Regenerate*, Cloudinary *Generate new API key*, Google *Reset secret*, mailbox password change), update the variable, restart.
