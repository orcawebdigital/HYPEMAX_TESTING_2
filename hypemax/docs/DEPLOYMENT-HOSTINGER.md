# Deploying HYPEMAX Nutrition on Hostinger

The site is **one Node.js app** (Express) serving the storefront, admin panel and API, backed by **MySQL**. Images live on **Cloudinary**, payments go through **Razorpay**, email via **SMTP**.
Credentials: see **[API_CONFIGURATION_GUIDE.md](../API_CONFIGURATION_GUIDE.md)**. You enter every secret yourself; none are in the code.

```
Browser ──► Hostinger Node.js app (backend/server.js) ──► Hostinger MySQL
   │                    ├──► Razorpay API (orders, verification, refunds)  ◄── Razorpay webhooks
   │                    ├──► Cloudinary API (admin uploads/deletes)
   │                    ├──► Google OAuth (code exchange)      └──► SMTP (emails)
   └──── images ──────────► Cloudinary CDN (f_auto, q_auto, responsive widths)
```

## 0. Hostinger plan compatibility

| Plan | Node.js app? | Notes |
|---|---|---|
| Single / Premium Web Hosting | **No** | PHP-only shared hosting; upgrade before deploying. |
| **Business Web Hosting** | **Yes** (Node.js Web Apps) | Recommended minimum. MySQL included. Limited CPU/RAM and process count: fine for a single store; one app instance. |
| **Cloud Startup / Professional / Enterprise** | **Yes** | More CPU/RAM; same deployment steps. |
| **KVM VPS** | **Yes** | Full control; you manage Node, MySQL, Nginx, SSL and backups yourself (section 11). |

Confirm in hPanel that you can create a **Node.js** app (*Websites → Add website → Node.js Apps* or similar) before continuing. Requirements: **Node.js 20 or 22**, MySQL 8 or MariaDB 10.6+. The app keeps **no permanent files on disk**: images go to Cloudinary, everything else to MySQL, so redeploys and container restarts lose nothing.

## 1. Create the MySQL database
hPanel → **Databases → MySQL Databases** → create database + user (strong password). Note the prefixed names (`u123456789_…`). Host is usually `localhost`. Details: guide section E.

## 2. Create the Node.js app
hPanel → **Websites → Add website → Node.js Apps** (or *Deploy Node.js app*):
- **Source**: connect the GitHub repository, or upload the project ZIP (it contains no `node_modules` and no `.env`).
- **Root directory**: the repository root (folder with `package.json`, `backend/`, `frontend/`).
- **Node version**: 20 or 22.
- **Install command**: `npm install` (the root `postinstall` runs `cd backend && npm install --omit=dev`). Verified: a clean install from the ZIP + `npm start` against an empty database creates all tables, seeds and serves the site.
- **Start command / entry file**: `npm start` (equivalently entry file `backend/server.js`).

## 3. Environment variables
Add them under the app's **Environment variables**. The full list with explanations is in `backend/.env.example` and the guide. Minimum to boot:

`NODE_ENV=production`, `SITE_URL=https://your-domain`, `COOKIE_SECURE=true`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.

Then, per service (each can be added later; the site degrades gracefully until then):
- Razorpay: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- Cloudinary: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `ADMIN_NOTIFY_EMAIL`

> If you use a `.env` file (VPS), wrap values containing `#` or spaces in double quotes; an unquoted `#` starts a comment and silently truncates the value.

## 4. Start and check
Start/restart the app. The log shows `HYPEMAX Nutrition running on …` and lists integrations not configured yet. On first start it creates all tables (migrations), seeds the catalogue/content and creates the Super Admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- **Health check**: `https://your-domain/health` → `{"ok":true,"db":true}` (HTTP 503 if the database is unreachable; use it for uptime monitoring).
- **Integrations**: log in at `/admin` → **Integrations**: each service shows Working / Not configured / Failed.

## 5. Domain & SSL
hPanel → the website → **Domains**: point the domain at the Node.js app. Enable the free **SSL** certificate and **Force HTTPS**. `SITE_URL` must match the final address exactly (with or without `www`).

## 6. Razorpay
Keys, webhook (`https://your-domain/api/payments/webhook`, events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`), test payment and going live: guide section A.

## 7. Cloudinary
Set the three variables and restart: the seed product photos are uploaded to Cloudinary **automatically** on start and the database switches to Cloudinary URLs (log lines `[images] …`). Manual alternative: `npm --prefix backend run upload-seed-images`. Guide section B.

## 8. Google sign-in & email
Guide sections C and D. Google's redirect URI must equal `GOOGLE_CALLBACK_URL` exactly.

## 9. Handover checklist
1. Log in to `/admin` with `ADMIN_EMAIL`; change the password (sidebar → **Account**); remove `ADMIN_PASSWORD` from the environment; restart.
2. Admin → **Products → HYPEMAX Pre-Workout → Inventory**: set the **real stock** (seed placeholder: 50).
3. Admin → **Content → Site settings**: phone, email, WhatsApp, address, socials, shipping fee / free-shipping threshold, delivery estimate, business hours.
4. Admin → **Content → Policies**: review all four policies with the business owner.
5. Admin → **Content → Site images → hero**: transparent PNG cut-out of the tub for the homepage animation.
6. Admin → **Team**: create Manager / Content Manager / Order Manager accounts.
7. Admin → **Integrations**: everything Working; run the test payment + refund from the guide.

## 10. Backups & updates
- **Database**: hPanel → Databases → *Backups* (automatic on Business/Cloud) plus a weekly manual export (phpMyAdmin → Export → SQL). Test a restore into a scratch database once.
- **Images**: in Cloudinary. **Code**: the Git repository. **Config**: keep your environment variables in a password manager.
- **Updating**: back up the DB → push to the connected branch / upload the new ZIP → redeploy/restart. New migrations apply automatically and never drop data. Run `npm test` locally (against a throwaway test DB) before deploying checkout or coupon changes.
- **Logs**: hPanel → Node.js app → *Logs*. Logs contain request paths and error codes, never request bodies, SQL parameters, tokens or secrets.

## 11. VPS alternative (Hostinger KVM)
```
sudo apt install -y nodejs npm mysql-server nginx     # use NodeSource for Node 22
git clone <repo> /var/www/hypemax && cd /var/www/hypemax && npm install
cp backend/.env.example backend/.env && chmod 600 backend/.env   # fill in values yourself
sudo npm i -g pm2 && pm2 start npm --name hypemax -- start && pm2 save && pm2 startup
```
Nginx: `proxy_pass http://127.0.0.1:4000;` with `proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme;` and `client_max_body_size 90m;` (multi-image uploads). SSL: `certbot --nginx`. Backups: nightly `mysqldump --single-transaction` via cron, copied off-server.
