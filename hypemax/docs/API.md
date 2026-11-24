# HYPEMAX Nutrition API reference

Same-origin JSON API served by the Express backend. All money values are **integers in paise** (₹1,499 = `149900`). Format on the client as `₹` + `(paise/100).toLocaleString("en-IN")`.

## Conventions

- **Auth**: httpOnly cookies. Customer session `hm_sid`, admin session `hm_asid`. Always send `credentials: "same-origin"` (default for same-origin `fetch`).
- **CSRF**: every `POST/PUT/PATCH/DELETE` to `/api/*` must send header `X-CSRF-Token` equal to the readable cookie `hm_csrf` (set on any request). Missing/mismatched → `403 {code:"CSRF"}`.
- **Errors**: `{ error: "Human readable message", code?: "MACHINE_CODE" }` with 4xx/5xx. `401 AUTH_REQUIRED` (customer) / `401 ADMIN_AUTH_REQUIRED` (admin), `403` permission, `429 RATE_LIMIT`, `503 *_MISSING` when an integration (Razorpay/Cloudinary/Google) isn't configured.
- Uploads are `multipart/form-data` (still need the CSRF header).
- Images: URLs are Cloudinary `https://res.cloudinary.com/...` (or `/img/...` in local dev before Cloudinary is set up). For optimisation insert `f_auto,q_auto,w_<n>` after `/upload/`.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | `{razorpay_key_id, google_client_id, features:{payments,google,google_redirect,email,uploads}, user}`. Public identifiers only, never secrets. |
| GET | `/api/site` | `{settings, homepage, banners[], categories[]}`. settings: brandName, email, phone, whatsapp, address, instagram, facebook, youtube, twitter, linkedin, footerText, announcement, seoTitle, seoDescription, shippingFee, freeShippingAbove (rupees, strings), deliveryEstimate, businessHours. homepage: heroEyebrow, heroTitle, heroText, heroCtaLabel, introTitle, introText, productsTitle, productsSubtitle, comingSoonTitle, whyTitle, why[{title,text}], stats[{title,text}], ctaTitle, ctaText, testimonialsTitle, newsletterTitle, newsletterText. banners: {id, placement: hero/promo/strip, title, subtitle, link_url, link_label, image_url, mobile_image_url} |
| GET | `/api/content/:key` | key ∈ homepage, about, contact, policy_privacy, policy_terms, policy_shipping, policy_refund. Policies `{title, body}` (body uses `## Heading` lines + paragraphs). about `{title,intro,body,values[],mission}`, contact `{title,intro,hours,mapUrl}` |
| GET | `/api/categories` | `[{id,name,slug,description,image_url}]` |
| GET | `/api/products?q=&category=&availability=available\|upcoming&sort=featured\|newest\|price_asc\|price_desc\|name\|discount\|rating&min=&max=` | min/max in rupees. Returns product[] (see shape below) |
| GET | `/api/products/:slug` | product + `sections[{id,title,content}]`, `related[]`, `wishlisted` |
| GET | `/api/products/:slug/reviews` | `[{id,name,rating,title,body,verified_purchase,created_at}]` |
| GET | `/api/products-by-ids?ids=1,2` | for guest "recently viewed" |
| GET | `/api/faqs` | `[{id,question,answer}]` |
| GET | `/api/testimonials` | published testimonial reviews |
| POST | `/api/contact` | `{name, email?, phone?, subject?, message, website(honeypot, leave empty)}` |
| POST | `/api/newsletter` | `{email}` |
| POST | `/api/t` | analytics beacon `{type: page_view\|product_view\|checkout_start\|search, path, product_id?, referrer?, utm?}` → 204 |

**Product shape**: `{id, name, slug, sku, status: upcoming|coming_soon|active|out_of_stock|discontinued, status_label, purchasable, short_description, description, highlights[], flavours[], net_weight, servings, mrp, price, discount_percent, low_stock (number|null), category{id,name,slug}|null, featured, rating{average,count}|null, image, images[{id,url,alt,width,height}], meta_title, meta_description}`

**Section content format** (accordion): plain text. Lines starting `- ` are bullet points; consecutive lines containing ` | ` form a table (first such line of the block is the header when there are ≥3 columns; 2-column blocks are key/value rows); blank line separates paragraphs.

## Customer auth `/api/auth`

| Method | Path | Body / Notes |
|---|---|---|
| POST | `/register` | `{name, email, password, phone?}` → `{user}` (logs in) or `{verification_required}` |
| POST | `/login` | `{email, password}` → `{user}`. Merges guest cart. |
| POST | `/google` | `{credential}` (Google Identity Services ID token; popup flow) |
| GET | `/google/start?next=/path` | Redirect flow: sets one-time state + PKCE cookie, redirects to Google (needs `GOOGLE_CLIENT_SECRET`) |
| GET | `/google/callback` | Google redirects here; verifies state, exchanges code server-side, verifies ID token, signs in, redirects to `next` (errors → `/login?google_error=`) |
| POST | `/logout` | |
| GET | `/me` | `{user|null}` user: `{id,name,email,phone,email_verified,has_password,google_linked}` |
| POST | `/forgot-password` | `{email}` |
| POST | `/reset-password` | `{token, password}` |
| POST | `/verify-email` | `{token}` |
| POST | `/resend-verification` | |

Password rule: ≥8 chars with letters and numbers.

## Cart `/api/cart` (guest or logged in)

Every response is the **server-priced cart**: `{lines[{key, product_id, name, slug, image, flavour, quantity, unit_mrp, unit_price, line_total, line_discount, available, purchasable}], problems[{product_id,message}], subtotal, mrp_total, savings_on_mrp, discount, shipping, total, coupon{id,code,description}|null, coupon_error{message,code}|null, count}`

| Method | Path | Body |
|---|---|---|
| GET | `/api/cart?coupon=CODE` | coupon only previewed |
| POST | `/api/cart/items` | `{product_id, flavour, quantity, coupon?}` (adds) |
| PATCH | `/api/cart/items` | `{product_id, flavour, quantity, coupon?}` (sets) |
| DELETE | `/api/cart/items` | `{product_id, flavour, coupon?}` |

## Checkout `/api/checkout` (login required)

1. `POST /api/checkout` `{address_id}` or `{address:{name,phone,line1,line2,city,state,pincode,save}}`, `coupon_code?`, `notes?` → `{order_number, amount, razorpay:{key, order_id, amount, currency, name, description, prefill}}`
2. Open Razorpay Checkout with those options. On success handler POST `/api/checkout/verify` `{razorpay_order_id, razorpay_payment_id, razorpay_signature}` → `{ok, order_number}`.
3. On `payment.failed` event: POST `/api/checkout/:number/failed` `{error:{code,description}}` (order stays payable for 30 min).
4. Popup dismissed: either retry with `GET /api/checkout/:number/pay` (returns same razorpay object) or `POST /api/checkout/:number/cancel`.

Webhook: `POST /api/payments/webhook` (Razorpay only, HMAC-verified).

## Account `/api/account` (login required)

| Method | Path | Notes |
|---|---|---|
| GET | `/profile` | `{user, stats:{orders,current_orders,delivered,cancelled,returned,spent,unread_notifications}}` |
| PUT | `/profile` | `{name, phone, email?, current_password? (needed to change email)}` |
| POST | `/password` | `{current_password?, new_password}` |
| GET/POST | `/addresses` | address `{id,label,name,phone,line1,line2,city,state,pincode,is_default}` |
| PUT/DELETE | `/addresses/:id` | |
| GET | `/orders?filter=current\|completed\|cancelled\|returned\|pending` | `[{order_number,status,status_label,payment_status,total,discount,coupon_code,created_at,paid_at,item_count,image}]` |
| GET | `/orders/:number` | full order: items, payments, refunds, shipment{courier,tracking_id,tracking_url,status,estimated_delivery,notes}, history[{status,note,created_at}], can_cancel |
| POST | `/orders/:number/cancel` | `{reason?}` (auto refund for paid orders) |
| GET | `/orders/:number/invoice` | PDF download (paid orders) |
| GET | `/payments` | `{payments[], refunds[]}` |
| GET/POST | `/wishlist` | POST `{product_id}` |
| DELETE | `/wishlist/:productId` | |
| GET | `/recently-viewed` | product[] |
| GET | `/notifications` · POST `/notifications/read` | |
| POST | `/reviews` | `{product_id, rating 1-5, title?, body}` (delivered purchases only; moderated) |

Order statuses: `pending_payment, order_placed, payment_confirmed, processing, packed, shipped, out_for_delivery, delivered, cancelled, returned`. Payment statuses: `pending, successful, failed, refunded, partially_refunded`.

## Admin `/api/admin` (admin session + permission per route)

Auth: `POST /login {email,password}`, `POST /logout`, `GET /me` → `{admin:{id,name,email,role,role_name,permissions[] ("*" = all)}, features:{razorpay,razorpayWebhook,cloudinary,google,email}}`, `POST /me/password {current_password,new_password}`.

Permissions: dashboard.view, analytics.view, products.manage, products.content, orders.view, orders.manage, orders.refund, customers.view, customers.export, coupons.manage, content.manage, reviews.manage, messages.manage, admins.manage, audit.view.

Date range query (dashboard, analytics, orders): `range=today|yesterday|7d|30d|month|year|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (IST).

| Area | Endpoints |
|---|---|
| Dashboard | `GET /dashboard?range=` → `{range, customers{total,new}, orders{total,cancelled,awaiting_fulfilment}, revenue{net,gross,average_order}, payments{successful,pending,failed,refunded}, products{total,active,low_stock,out_of_stock,upcoming}, coupons{uses,discount}, traffic{visits,unique_visitors,anonymous_visitors,logged_in_customers,page_views,home_views,product_views,add_to_cart,remove_from_cart,checkout_start,purchases,conversion_rate,cart_abandonment_rate}}`; `GET /activity` → `{orders[], low_stock[]}` |
| Reports | `GET /reports/sales.csv?range=` daily sales (IST) for accounting |
| Integrations (Super Admin) | `GET /integrations` → per service `{ok, configured, detail}` (no secrets) · `POST /integrations/test-email` (sends only to the logged-in admin) |
| Analytics | `GET /analytics?range=` → `{sales[{d,orders,revenue}], traffic[{d,visits,visitors}], top_products[{name,units,revenue}], most_viewed[{name,views}], sources[{source,visits}], devices[{device,visits}], pages[{path,views}]}` |
| Products | `GET /products` (list incl. stock, reserved, units_sold, image) · `GET /products/:id` (all fields + images[] + sections[] + movements[]) · `POST /products` · `PUT /products/:id` · `DELETE /products/:id`. Body fields: name, slug, sku, status (draft/upcoming/coming_soon/active/out_of_stock/discontinued), short_description, description, highlights (array or newline text), flavours (array or comma text), net_weight, servings, **mrp & price in rupees**, category_id, featured, sort_order, meta_title, meta_description; on create also stock, low_stock_threshold. |
| Inventory | `POST /products/:id/inventory {mode:"set"\|"adjust", quantity, low_stock_threshold, reason}` |
| Sections | `POST /products/:id/sections {title,content,is_enabled}` · `PUT /products/:id/sections/:sid` · `DELETE ...` · `PUT /products/:id/sections-order {ids:[]}` |
| Images | `POST /images` multipart `files[]`, `owner_type=product\|content`, `owner_id` (product) or `owner_key` (content slot: logo, hero, hero_mobile, about, about_2, promo, og_image, contact), `alt_text` · `POST /images/:id/replace` multipart `file` · `PUT /images/:id {alt_text}` · `DELETE /images/:id` · `PUT /images-order {product_id, ids:[]}` · `GET /images/content` → `{slots, images[]}` · `POST /banners/:id/image?variant=desktop\|mobile` multipart `file` · `POST /categories/:id/image` multipart `file` |
| Orders | `GET /orders?q=&status=&payment_status=&range=&page=&limit=&include_unpaid=1` → `{rows,total,page,limit}` · `GET /orders/export.csv?...` · `GET /orders/:number` (+customer, fulfilment_statuses[{value,label}]) · `POST /orders/:number/status {status,note}` · `PUT /orders/:number/shipment {courier,tracking_id,tracking_url,status,estimated_delivery(YYYY-MM-DD),notes}` · `POST /orders/:number/cancel {reason}` · `POST /orders/:number/refund {amount(rupees, empty=full), reason}` · `POST /orders/:number/return {note}` · `POST /orders/:number/reconcile` · `GET /orders/:number/invoice` |
| Customers | `GET /customers?q=&has_orders=1\|0&login=google&from=&to=&sort=newest\|oldest\|spent\|orders\|name&page=` → `{rows,total}` · `GET /customers/export.csv` · `GET /customers/:id` (orders, addresses, payments, coupons, activity) · `POST /customers/:id/active {is_active}` |
| Coupons | `GET /coupons` (with used, reserved, total_discount, customers) · `GET /coupons/:id` (+product_ids, category_ids, usages[], stats) · `POST /coupons` · `PUT /coupons/:id` · `POST /coupons/:id/active {is_active}` · `DELETE /coupons/:id`. Body: code, description, discount_type percent\|fixed, discount_value (percent 1-100, or rupees), min_order_value (₹), max_discount (₹, optional), starts_at, expires_at (ISO/datetime-local), usage_limit, per_customer_limit, is_active, product_ids[], category_ids[] |
| CMS | `GET/PUT /content/:key` (settings, homepage, about, contact, policy_privacy, policy_terms, policy_shipping, policy_refund) · banners `GET/POST /banners`, `PUT/DELETE /banners/:id` {placement,title,subtitle,link_url,link_label,sort_order,is_active,starts_at,ends_at} · faqs `GET/POST /faqs`, `PUT/DELETE /faqs/:id` {question,answer,is_published}, `PUT /faqs-order {ids}` · categories `GET/POST /categories`, `PUT/DELETE /categories/:id` {name,slug,description,sort_order,is_active} |
| Reviews | `GET /reviews?status=pending\|published` · `POST /reviews` (admin testimonial) · `PUT /reviews/:id {is_published,is_testimonial}` · `DELETE /reviews/:id` |
| Messages | `GET /messages?status=&page=` (total in `X-Total-Count` header) · `PUT /messages/:id {status,admin_note}` · `GET /newsletter` · `GET /newsletter.csv` |
| Team | `GET /roles` · `GET /admins` · `POST /admins {name,email,password,role}` · `PUT /admins/:id {name,role,is_active,password}` · `DELETE /admins/:id` (not self; keeps ≥1 Super Admin) · `GET /audit-logs?page=` |
