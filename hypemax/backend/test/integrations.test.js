// External integrations against in-memory fakes (no real Razorpay/Cloudinary/Google/SMTP traffic).
// These prove OUR code paths; they do not prove the real services accept your credentials.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

let root, PID;
before(async () => {
  await H.start();
  root = await H.admin();
  PID = (await H.q("SELECT id FROM products WHERE slug='hypemax-pre-workout'"))[0].id;
});
after(H.stop);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
function form(fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, buf, name, type] of files) fd.append(k, new Blob([buf], { type }), name);
  return fd;
}
async function upload(c, path, fd) {
  // multipart through the cookie-aware client: build the body with Response to get boundary + bytes
  const r = new Response(fd);
  const body = Buffer.from(await r.arrayBuffer());
  return c.raw("POST", path, body, { headers: { "content-type": r.headers.get("content-type") } });
}

// ---------------- email ----------------
test("emails: welcome + verification on sign-up, reset link, password-changed notice", async () => {
  const c = await H.customer("mailer@example.test", "Mail Tester");
  assert.ok(await H.waitForMail((m) => m.to === "mailer@example.test" && m.headers["X-Template"] === "welcome"));
  const v = await H.waitForMail((m) => m.to === "mailer@example.test" && m.headers["X-Template"] === "verifyEmail");
  assert.ok(v && /\/account\/verify\?token=[a-f0-9]{64}/.test(v.html), "verification link");
  assert.ok(v.text.length > 20, "plain-text alternative");

  await H.client().post("/api/auth/forgot-password", { email: "mailer@example.test" });
  const reset = await H.waitForMail((m) => m.to === "mailer@example.test" && m.headers["X-Template"] === "passwordReset");
  const token = reset.html.match(/reset-password\?token=([a-f0-9]{64})/)[1];
  const r = await H.client().post("/api/auth/reset-password", { token, password: "NewPassw0rd" });
  assert.equal(r.status, 200);
  assert.ok(await H.waitForMail((m) => m.to === "mailer@example.test" && m.headers["X-Template"] === "passwordChanged"));
  // token is single-use
  assert.equal((await H.client().post("/api/auth/reset-password", { token, password: "Another123" })).status, 400);
  // old session was revoked
  assert.equal((await c.get("/api/account/profile")).status, 401);
  // forgot-password response is identical for unknown emails (no account enumeration)
  const unknown = await H.client().post("/api/auth/forgot-password", { email: "nobody@example.test" });
  assert.equal(unknown.status, 200);
});

test("emails: order confirmation to customer, alert to admin, shipping update, refund", async () => {
  const c = await H.customer("orders-mail@example.test", "Order Mailer");
  await c.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  const o = (await c.post("/api/checkout", { address_id: c.addressId })).data;
  const { payment, ...body } = H.pay(o.razorpay.order_id);
  assert.equal((await c.post("/api/checkout/verify", body)).status, 200);
  const conf = await H.waitForMail((m) => m.to === "orders-mail@example.test" && m.headers["X-Template"] === "orderConfirmed");
  assert.ok(conf && conf.html.includes(o.order_number) && conf.html.includes("1,499"));
  assert.ok(await H.waitForMail((m) => m.to === "ops@test.local" && m.headers["X-Template"] === "adminNewOrder" && m.subject.includes(o.order_number)));

  await root.put(`/api/admin/orders/${o.order_number}/shipment`, { courier: "Delhivery", tracking_id: "TRK999" });
  await root.post(`/api/admin/orders/${o.order_number}/status`, { status: "shipped" });
  const ship = await H.waitForMail((m) => m.to === "orders-mail@example.test" && m.headers["X-Template"] === "statusUpdate" && m.subject.includes("Shipped"));
  assert.ok(ship && ship.html.includes("TRK999"));

  await root.post(`/api/admin/orders/${o.order_number}/refund`, { amount: 100, reason: "Goodwill" });
  assert.ok(await H.waitForMail((m) => m.to === "orders-mail@example.test" && m.headers["X-Template"] === "refund"));
});

test("emails: contact form alerts the admin; test-email endpoint only sends to the logged-in admin", async () => {
  await H.client().post("/api/contact", { name: "Visitor", email: "v@example.test", message: "Do you ship to Goa?" });
  assert.ok(await H.waitForMail((m) => m.to === "ops@test.local" && m.headers["X-Template"] === "adminNewMessage"));
  const r = await root.post("/api/admin/integrations/test-email", { to: "attacker@example.test" });
  assert.equal(r.status, 200);
  assert.equal(r.data.to, "root@test.local");
  assert.ok(!H.outbox.some((m) => m.to === "attacker@example.test"));
});

test("email templates escape user-supplied text", async () => {
  await H.client().post("/api/contact", { name: '<img src=x onerror="alert(1)">', email: "x@example.test", message: "<script>alert(1)</script> hi there" });
  const m = await H.waitForMail((m) => m.headers["X-Template"] === "adminNewMessage" && m.html.includes("onerror"));
  assert.ok(m);
  assert.ok(!m.html.includes("<img src=x") && !m.html.includes("<script>"));
});

// ---------------- Google sign-in ----------------
const gPayload = (o) => ({ iss: "https://accounts.google.com", sub: "g-" + o.email, email: o.email, email_verified: true, name: "G User", ...o });

test("google redirect flow: start sets state+PKCE, callback rejects bad state, then signs in", async () => {
  const c = H.client();
  const s = await c.get("/api/auth/google/start?next=/checkout");
  assert.equal(s.status, 302);
  const loc = new URL(s.headers.get("location"));
  assert.equal(loc.hostname, "accounts.google.com");
  const state = loc.searchParams.get("state");
  assert.ok(state && loc.searchParams.get("code_challenge"));
  assert.equal(loc.searchParams.get("redirect_uri"), "http://localhost/api/auth/google/callback");
  assert.ok(c.jar.has("hm_gstate"), "state cookie set");

  H.google.idTokens.set("idtok-1", gPayload({ email: "newg@example.test" }));
  H.google.codes.set("code-1", "idtok-1");
  // wrong state (CSRF on the OAuth callback) is refused
  const bad = await c.get("/api/auth/google/callback?code=code-1&state=wrong");
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get("location"), /^\/login\?google_error=/);
  assert.equal((await c.get("/api/account/profile")).status, 401);
  // state cookie is single-use: a fresh /start is required
  const s2 = await c.get("/api/auth/google/start?next=/checkout");
  const st2 = new URL(s2.headers.get("location")).searchParams.get("state");
  const ok = await c.get(`/api/auth/google/callback?code=code-1&state=${st2}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/checkout");
  const me = (await c.get("/api/account/profile")).data.user;
  assert.equal(me.email, "newg@example.test");
  assert.equal(me.google_linked, true);
  assert.equal(me.email_verified, true);
});

test("google: open redirect via next= is blocked; cancelled consent shows an error", async () => {
  const c = H.client();
  const s = await c.get("/api/auth/google/start?next=//evil.example");
  const st = new URL(s.headers.get("location")).searchParams.get("state");
  H.google.idTokens.set("idtok-2", gPayload({ email: "redir@example.test" }));
  H.google.codes.set("code-2", "idtok-2");
  const r = await c.get(`/api/auth/google/callback?code=code-2&state=${st}`);
  assert.equal(r.headers.get("location"), "/account");
  const x = await H.client().get("/api/auth/google/callback?error=access_denied");
  assert.match(decodeURIComponent(x.headers.get("location")), /cancelled/);
});

test("google: unverified Google email and forged tokens are rejected", async () => {
  H.google.idTokens.set("idtok-unv", gPayload({ email: "unv@example.test", email_verified: false }));
  const r1 = await H.googlePopup(H.client(), "idtok-unv");
  assert.equal(r1.status, 401);
  const r2 = await H.googlePopup(H.client(), "forged-token");
  assert.equal(r2.status, 401);
  // A valid token without this browser's one-time nonce (replayed / injected) is refused
  H.google.idTokens.set("idtok-replay", gPayload({ email: "replay@gmail.com" }));
  const r3 = await H.client().post("/api/auth/google", { credential: "idtok-replay" });
  assert.equal(r3.status, 401);
  assert.equal(r3.data.code, "GOOGLE_NONCE");
});

test("google: linking to an UNVERIFIED pre-registered account removes the squatter's password", async () => {
  // attacker registers the victim's email with their own password (never verifies it)
  await H.client().post("/api/auth/register", { name: "Squatter", email: "victim@example.test", password: "Attacker123", phone: "9876543210" });
  const squatter = H.client();
  assert.equal((await squatter.post("/api/auth/login", { email: "victim@example.test", password: "Attacker123" })).status, 200);
  // real owner signs in with Google
  H.google.idTokens.set("idtok-v", gPayload({ email: "victim@example.test", sub: "victim-sub", hd: "example.test" }));
  const owner = H.client();
  assert.equal((await H.googlePopup(owner, "idtok-v")).status, 200);
  // attacker's password and session no longer work
  assert.equal((await H.client().post("/api/auth/login", { email: "victim@example.test", password: "Attacker123" })).status, 401);
  assert.equal((await squatter.get("/api/account/profile")).status, 401);
  assert.equal((await owner.get("/api/account/profile")).status, 200);
});

test("google: a VERIFIED existing account is linked and keeps its password", async () => {
  await H.customer("linked@example.test");
  await H.q("UPDATE users SET email_verified_at=UTC_TIMESTAMP() WHERE email='linked@example.test'");
  H.google.idTokens.set("idtok-l", gPayload({ email: "linked@example.test", sub: "linked-sub", hd: "example.test" }));
  assert.equal((await H.googlePopup(H.client(), "idtok-l")).status, 200);
  assert.equal((await H.client().post("/api/auth/login", { email: "linked@example.test", password: "Passw0rd!" })).status, 200);
  // a different Google account can't take over the same email
  H.google.idTokens.set("idtok-l2", gPayload({ email: "linked@example.test", sub: "other-sub", hd: "example.test" }));
  assert.equal((await H.googlePopup(H.client(), "idtok-l2")).status, 409);
  // A Google account that merely *lists* a non-Google address (no hd claim, not gmail) is never merged
  await H.customer("personal@mydomain.test");
  H.google.idTokens.set("idtok-p", gPayload({ email: "personal@mydomain.test", sub: "personal-sub" }));
  const pr = await H.googlePopup(H.client(), "idtok-p");
  assert.equal(pr.status, 409);
  assert.equal(pr.data.code, "GOOGLE_LINK_REFUSED");
  assert.equal((await H.q("SELECT google_sub FROM users WHERE email='personal@mydomain.test'"))[0].google_sub, null);
});

// ---------------- Cloudinary ----------------
test("image upload: validates real file type and size, stores secure URL + public_id", async () => {
  const ok = await upload(root, "/api/admin/images", form({ owner_type: "product", owner_id: PID, alt_text: "Tub" }, [["files", PNG, "a.png", "image/png"], ["files", JPG, "b.jpg", "image/jpeg"]]));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.length, 2);
  const row = (await H.q("SELECT * FROM images WHERE id=?", [ok.data[0].id]))[0];
  assert.match(row.url, /^https:\/\/res\.cloudinary\.com\//);
  assert.ok(row.public_id);

  const fakePng = await upload(root, "/api/admin/images", form({ owner_type: "product", owner_id: PID }, [["files", Buffer.from("<?php system($_GET['c']); ?>"), "shell.png", "image/png"]]));
  assert.equal(fakePng.status, 400, "content is sniffed, not trusted from the filename/mimetype");
  const svg = await upload(root, "/api/admin/images", form({ owner_type: "product", owner_id: PID }, [["files", Buffer.from('<svg onload="alert(1)"/>'), "x.svg", "image/svg+xml"]]));
  assert.equal(svg.status, 400, "SVG (scriptable) is refused");
  const big = await upload(root, "/api/admin/images", form({ owner_type: "product", owner_id: PID }, [["files", Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]), "big.png", "image/png"]]));
  assert.equal(big.status, 400);
});

test("image replace uploads the new file BEFORE deleting the old one; delete removes from Cloudinary", async () => {
  const up = await upload(root, "/api/admin/images", form({ owner_type: "product", owner_id: PID }, [["files", PNG, "c.png", "image/png"]]));
  const img = (await H.q("SELECT * FROM images WHERE id=?", [up.data[0].id]))[0];
  H.cloudLog.length = 0;
  const rep = await upload(root, `/api/admin/images/${img.id}/replace`, form({}, [["file", JPG, "d.jpg", "image/jpeg"]]));
  assert.equal(rep.status, 200);
  assert.deepEqual(H.cloudLog.map((x) => x[0]), ["upload", "destroy"]);
  assert.equal(H.cloudLog[1][1], img.public_id);
  const after = (await H.q("SELECT public_id FROM images WHERE id=?", [img.id]))[0];
  assert.notEqual(after.public_id, img.public_id);

  H.cloudLog.length = 0;
  assert.equal((await root.del(`/api/admin/images/${img.id}`)).status, 200);
  assert.deepEqual(H.cloudLog, [["destroy", after.public_id]]);
});

test("content image slot and banner image: replace and remove", async () => {
  const s1 = await upload(root, "/api/admin/images", form({ owner_type: "content", owner_key: "hero" }, [["files", PNG, "h.png", "image/png"]]));
  assert.equal(s1.status, 201);
  const site = (await H.client().get("/api/site")).data;
  assert.equal(site.images.hero, s1.data.url);
  const b = await root.post("/api/admin/banners", { placement: "promo", title: "Launch" });
  assert.equal((await upload(root, `/api/admin/banners/${b.data.id}/image?variant=desktop`, form({}, [["file", PNG, "b.png", "image/png"]]))).status, 200);
  assert.equal((await root.del(`/api/admin/banners/${b.data.id}/image?variant=desktop`)).status, 200);
  assert.equal((await H.q("SELECT image_url FROM banners WHERE id=?", [b.data.id]))[0].image_url, null);
});

test("only authorised admins can upload: customers and order managers are refused", async () => {
  const cust = await H.customer("noupload@example.test");
  assert.equal((await upload(cust, "/api/admin/images", form({ owner_type: "product", owner_id: PID }, [["files", PNG, "a.png", "image/png"]]))).status, 401);
  await root.post("/api/admin/admins", { name: "OM2", email: "om2@test.local", password: "OrderMgr123", role: "order_manager" });
  const om = await H.admin("om2@test.local", "OrderMgr123");
  assert.equal((await upload(om, "/api/admin/images", form({ owner_type: "product", owner_id: PID }, [["files", PNG, "a.png", "image/png"]]))).status, 403);
});

// ---------------- integrations check ----------------
test("integrations check reports status without leaking any secret", async () => {
  const r = await root.get("/api/admin/integrations");
  assert.equal(r.status, 200);
  for (const k of ["database", "razorpay", "cloudinary", "google", "email"]) assert.equal(r.data[k].ok, true, k + ": " + r.data[k].detail);
  const s = JSON.stringify(r.data);
  for (const secret of H.SECRETS) assert.ok(!s.includes(secret), "leaked " + secret);
  const cfg = JSON.stringify((await H.client().get("/api/config")).data);
  for (const secret of H.SECRETS) assert.ok(!cfg.includes(secret), "config leaked " + secret);
  // non-super admins cannot run it
  const om = await H.admin("om2@test.local", "OrderMgr123");
  assert.equal((await om.get("/api/admin/integrations")).status, 403);
});
