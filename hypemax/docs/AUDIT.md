# Phase 1 audit: original HYPEMAX site (baseline commit `72643b0`)

## What existed
| Area | Original | Now |
|---|---|---|
| Hosting | Frontend on Vercel, API on Render free tier (sleeps after 15 min) | Single Node.js app on Hostinger |
| Database | MongoDB Atlas (Mongoose, `strict:false` models) | MySQL 8, 40 tables, migrations, FKs, indexes |
| Frontend | 7 static HTML shells + one 22 KB minified `app.js` rendering every page | Same approach (no build step), split into `core.js` + per-page modules |
| Buying | "Buy now" opened WhatsApp with a pre-filled message; checkout form saved an *Enquiry* | Cart → checkout → Razorpay → verified order. WhatsApp kept as fallback and support channel |
| Accounts | None for customers; one admin via JWT in `localStorage` | Customer accounts (email + Google), httpOnly sessions, 4 admin roles |
| Admin | Products, reviews, FAQs, enquiries, homepage text, settings | Everything requested in the brief (see README) |
| Images | Cloudinary upload for admin, URLs stored on the product | Cloudinary with `public_id` tracking, replace/delete/reorder, `f_auto,q_auto`, responsive `srcset` |

## Kept
- Brand identity: black/red/orange palette, gradient, Anton + Inter, logo (matches the H/M mark on the packaging).
- Home page animations: letter-by-letter hero, reveal rings, floating diamonds, the scroll-pinned 4-step 3D tub sequence with spark burst, smooth wheel scrolling, logo loader, reveal-on-scroll. (The pinned section was shortened from 500vh to 400vh to cut scrolling.)
- WhatsApp floating button and WhatsApp links (number from CMS).
- Original seed content: hero text, FAQs, contact details.

## Problems found
1. **Navigation underline stuck on Home**: `app.js` computed the active page as `location.pathname.split("/").pop()` and compared it to `"about.html"` etc. Vercel's `cleanUrls` served `/about`, so the comparison never matched. `/` fell back to `index.html`, which is why Home was the only item that ever got highlighted. Fixed with a route-prefix matcher (`routeKey()` in `core.js`) re-run on `popstate`/`pageshow`, so direct loads, nested routes and back/forward work.
2. Admin JWT stored in `localStorage` (readable by any injected script), 12 h tokens with no revocation, no rate limiting on admin login.
3. `cors` allowed `*` when `FRONTEND_ORIGIN` was unset; generic CRUD routes accepted arbitrary fields (`strict:false`).
4. Prices were client-displayed only and the order total was built in the browser (WhatsApp message), so there was no server-side validation.
5. Hard-coded API URL placeholder (`https://YOUR-API.onrender.com`) in two files.
6. Product/accordion content was free text in fixed fields; no ordering, enabling or custom sections.
7. `img/product.png` (the transparent tub used by the 3D animation) has garbled label text: it isn't the real packaging. It's kept only for the animation until a real cut-out is uploaded (Admin → Content → Site images → *hero*). Product pages use your real photos.

## Data from the packaging that needs your confirmation
- **Contact numbers differ**: the label says customer care **8565069777** and **Hypemaxnutrition@outlook.com**; the old site used **9984472222** and **Customercare@hypemaxnutrition.in**. The site keeps the old site's details (editable in Admin → Content → Site settings).
- **Nutrition table**: the label lists carbohydrate per 10 g as **0.12 g**, but 12 g/100 g implies **1.2 g**. It's transcribed as printed; correct it in Admin → Products → Sections if the label is wrong.
- **"Sugar free"** appears in the label's benefit list while the table shows 2.8 g total sugars/100 g (0 g added). The site says "0 g added sugar" instead of "sugar free".
- **Directions**: the text says 220–250 ml water; the pictogram says 180–200 ml. The site uses the text version.
- **Stock**: seeded as 50 units (placeholder). Set the real quantity before launch.
