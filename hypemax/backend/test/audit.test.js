// Regression tests for the 2026-11 bug-fix / security audit (BUG-002..011, cart login, account switching, SSO).
// Real Express app + real MySQL (see helpers.js). Razorpay/Google are in-memory fakes; nothing here is mocked
// on our side of the API.
const crypto = require("crypto");
process.env.SSO_CLIENTS = JSON.stringify([
  { client_id: "hm-app", name: "HYPEMAX App (public, PKCE)", redirect_uris: ["https://app.hypemax.test/callback"], post_logout_redirect_uris: ["https://app.hypemax.test/"] },
  { client_id: "hm-portal", name: "Partner portal (confidential)", redirect_uris: ["https://portal.hypemax.test/cb"], client_secret_hash: crypto.createHash("sha256").update("portal-secret").digest("hex") },
]);
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

let root, PID, CID; // pre-workout (has flavours), creatine (no flavours)
before(async () => {
  await H.start();
  root = await H.admin();
  PID = (await H.q("SELECT id FROM products WHERE slug='hypemax-pre-workout'"))[0].id;
  const cr = (await H.q("SELECT id, flavours FROM products WHERE slug='hypemax-creatine'"))[0];
  CID = cr && cr.id;
});
after(H.stop);

const me = async (c) => (await c.get("/api/auth/me")).data.user;

// ======================= account switching / logout (BUG-008, Gmail A -> B) =======================
test("A -> logout -> B -> logout -> C: each login shows only its own account; old tokens are dead", async () => {
  const emails = ["switch.a@test.local", "switch.b@test.local", "switch.c@test.local"];
  for (const e of emails) await H.customer(e).then((c) => c.post("/api/auth/logout"));
  const browser = H.client(); // one browser, three accounts in turn
  let prevToken = null;
  for (const e of emails) {
    const r = await browser.post("/api/auth/login", { email: e, password: "Passw0rd!" });
    assert.equal(r.status, 200);
    assert.equal((await me(browser)).email, e);
    assert.equal((await browser.get("/api/account/profile")).data.user.email, e);
    if (prevToken) {
      // the previous account's cookie value no longer authenticates anything
      const ghost = H.client(); ghost.jar.set("hm_sid", prevToken);
      assert.equal(await me(ghost), null);
    }
    prevToken = browser.jar.get("hm_sid");
    const out = await browser.post("/api/auth/logout");
    assert.equal(out.status, 200);
    assert.match(out.headers.get("clear-site-data") || "", /cache/);
    assert.equal(await me(browser), null, "logged out");
    assert.equal((await browser.get("/api/account/profile")).status, 401, "dashboard API refused after logout");
  }
});

test("logging in as B while A is still signed in on the same browser ends A's session (rotation)", async () => {
  await H.customer("rot.a@test.local"); await H.customer("rot.b@test.local");
  const b = H.client();
  await b.post("/api/auth/login", { email: "rot.a@test.local", password: "Passw0rd!" });
  const aTok = b.jar.get("hm_sid");
  await b.post("/api/auth/login", { email: "rot.b@test.local", password: "Passw0rd!" });
  assert.equal((await me(b)).email, "rot.b@test.local");
  const n = (await H.q("SELECT COUNT(*) n FROM sessions WHERE id=?", [crypto.createHash("sha256").update(aTok).digest("hex")]))[0].n;
  assert.equal(n, 0, "A's session row deleted");
});

test("logout works even without a CSRF token or from another origin (it only removes access)", async () => {
  const c = await H.customer("lo.csrf@test.local");
  const r = await c.post("/api/auth/logout", {}, { csrf: false, headers: { origin: "https://www.somewhere-else.test" } });
  assert.equal(r.status, 200);
  assert.equal(await me(c), null);
  // ...while every other state-changing call from a foreign origin is still refused
  const c2 = await H.customer("lo.csrf2@test.local");
  const x = await c2.post("/api/account/addresses", { name: "X Y" }, { headers: { origin: "https://evil.test" } });
  assert.equal(x.status, 403);
});

test("signed-in pages are never cached (Back after logout can't show the old account)", async () => {
  for (const p of ["/account", "/account/addresses", "/checkout", "/cart", "/login"]) {
    const r = await H.client().get(p);
    assert.match(r.headers.get("cache-control") || "", /no-store/, p);
  }
  assert.match((await H.client().get("/products")).headers.get("cache-control") || "", /no-cache/);
});

test("SITE_URL's www/apex twin and ALLOWED_ORIGINS are accepted; others are not", () => {
  const { execFileSync } = require("child_process");
  const out = execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./src/config').allowedOrigins))"], {
    cwd: require("path").join(__dirname, ".."), env: { ...process.env, SITE_URL: "https://hypemax.in", ALLOWED_ORIGINS: "https://hypemax.vercel.app, bad-url" },
  }).toString();
  assert.deepEqual(JSON.parse(out), ["https://hypemax.in", "https://www.hypemax.in", "https://hypemax.vercel.app"]);
});

// ======================= registration & passwords =======================
test("registration validates every field and reports which one is wrong", async () => {
  const base = { name: "Asha Verma", email: "reg.ok@test.local", phone: "98765 43210", password: "Gainz2026x" };
  const cases = [
    [{ name: "" }, "name"], [{ name: "123" }, "name"], [{ email: "not-an-email" }, "email"],
    [{ phone: "" }, "phone"], [{ phone: "12345" }, "phone"], [{ phone: "5876543210" }, "phone"], [{ phone: "98765abcde" }, "phone"],
    [{ password: "short1" }, "password"], [{ password: "lettersonly" }, "password"], [{ password: "password123" }, "password"],
    [{ confirm_password: "Mismatch99" }, "confirm_password"],
  ];
  for (const [over, field] of cases) {
    const r = await H.client().post("/api/auth/register", { ...base, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.data.field, field, JSON.stringify(over));
  }
  const ok = await H.client().post("/api/auth/register", base);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.phone, "9876543210", "phone normalised to 10 digits");
  const dup = await H.client().post("/api/auth/register", { ...base, email: "REG.OK@test.local" });
  assert.equal(dup.status, 409, "duplicate (case-insensitive) refused");
  assert.equal(dup.data.field, "email");
  const pw = (await H.q("SELECT password_hash FROM users WHERE email='reg.ok@test.local'"))[0].password_hash;
  assert.match(pw, /^\$2[aby]\$12\$/, "bcrypt cost 12");
});

test("login: wrong password and unknown account get the same message", async () => {
  await H.customer("login.same@test.local");
  const a = await H.client().post("/api/auth/login", { email: "login.same@test.local", password: "WrongPass1" });
  const b = await H.client().post("/api/auth/login", { email: "nobody.here@test.local", password: "WrongPass1" });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
});

// ======================= cart requires login =======================
test("add to cart: guest refused (401), customer allowed, carts isolated between customers", async () => {
  const guest = await H.client().post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  assert.equal(guest.status, 401);
  assert.equal(guest.data.code, "AUTH_REQUIRED");
  const a = await H.customer("cart.a@test.local"), b = await H.customer("cart.b@test.local");
  assert.equal((await a.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 3 })).status, 200);
  assert.equal((await b.get("/api/cart")).data.count, 0, "B never sees A's cart");
  assert.equal((await a.get("/api/cart")).data.count, 3);
  // expired session -> 401 again
  const aTok = crypto.createHash("sha256").update(a.jar.get("hm_sid")).digest("hex");
  await H.q("UPDATE sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id=?", [aTok]);
  assert.equal((await a.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 })).status, 401);
});

test("oversell via flavour lines is blocked: stock and the 10-unit limit count the whole product", async () => {
  const c = await H.customer("oversell@test.local");
  const fl = (await H.client().get("/api/products/hypemax-pre-workout")).data.flavours;
  assert.ok(fl.length >= 1);
  await c.post("/api/cart/items", { product_id: PID, flavour: fl[0], quantity: 10 });
  if (fl[1]) {
    await c.post("/api/cart/items", { product_id: PID, flavour: fl[1], quantity: 5 });
    const cart = (await c.get("/api/cart")).data;
    assert.ok(cart.problems.some((p) => /at most 10/.test(p.message)), JSON.stringify(cart.problems));
    assert.equal((await c.post("/api/checkout", { address_id: c.addressId })).status, 409);
  }
  if (CID) {
    const r = await c.post("/api/cart/items", { product_id: CID, flavour: "made-up-flavour", quantity: 1 });
    // creatine has flavours in the seed? Either way an unknown flavour must be refused.
    assert.equal(r.status, 400);
  }
});

// ======================= addresses (BUG-007, 009, 010, 011) =======================
const ADDR = { name: "Ravi Kumar", phone: "9123456789", line1: "Flat 4B, Shanti Apartments", line2: "Near City Mall", city: "Lucknow", state: "Uttar Pradesh", pincode: "226010" };

test("address validation: every required field, Indian mobile and 6-digit PIN, with the field named", async () => {
  const c = await H.customer("addr.val@test.local");
  const cases = [
    [{ name: "" }, "name"], [{ name: "R2D2" }, "name"], [{ phone: "" }, "phone"], [{ phone: "91234" }, "phone"], [{ phone: "0123456789" }, "phone"],
    [{ line1: "" }, "line1"], [{ line1: "ab" }, "line1"], [{ city: "" }, "city"], [{ city: "123" }, "city"], [{ state: "" }, "state"],
    [{ pincode: "" }, "pincode"], [{ pincode: "22601" }, "pincode"], [{ pincode: "2260100" }, "pincode"], [{ pincode: "ABCDEF" }, "pincode"],
    [{ pincode: "22601A" }, "pincode"], [{ pincode: "026010" }, "pincode"],
  ];
  for (const [over, field] of cases) {
    const r = await c.post("/api/account/addresses", { ...ADDR, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.data.field, field, JSON.stringify(over) + " -> " + JSON.stringify(r.data));
  }
  const before = (await c.get("/api/account/addresses")).data.length;
  assert.equal(before, 1, "nothing incomplete was saved");
  const ok = await c.post("/api/account/addresses", { ...ADDR, phone: "+91 91234-56789", pincode: " 226 010 " });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.phone, "9123456789");
  assert.equal(ok.data.pincode, "226010");
  assert.equal(ok.data.name, "Ravi Kumar");
});

test("checkout refuses an incomplete inline address and an old invalid saved one", async () => {
  const c = await H.customer("addr.chk@test.local");
  await c.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  const r = await c.post("/api/checkout", { address: { ...ADDR, pincode: "12" } });
  assert.equal(r.status, 400); assert.equal(r.data.field, "pincode");
  await H.q("UPDATE addresses SET pincode='ABCDEF' WHERE id=?", [c.addressId]); // saved before validation existed
  const r2 = await c.post("/api/checkout", { address_id: c.addressId });
  assert.equal(r2.status, 400); assert.equal(r2.data.code, "ADDRESS_INVALID");
});

test("delete address: own deleted and default promoted; another customer's id is 404 and untouched", async () => {
  const a = await H.customer("del.a@test.local"), b = await H.customer("del.b@test.local");
  const second = (await a.post("/api/account/addresses", ADDR)).data;
  assert.equal((await a.del(`/api/account/addresses/${a.addressId}`)).status, 200); // the default one
  const left = (await a.get("/api/account/addresses")).data;
  assert.deepEqual(left.map((x) => [x.id, x.is_default]), [[second.id, 1]], "remaining address became default");
  // IDOR: B tries to delete A's address
  const x = await b.del(`/api/account/addresses/${second.id}`);
  assert.equal(x.status, 404);
  assert.equal((await a.get("/api/account/addresses")).data.length, 1, "A's address still there");
  assert.equal((await b.put(`/api/account/addresses/${second.id}`, ADDR)).status, 404);
  assert.equal((await a.del(`/api/account/addresses/${second.id}`)).status, 200);
  assert.equal((await a.del(`/api/account/addresses/${second.id}`)).status, 404, "second delete reports not found");
});

// ======================= search (BUG-002) =======================
test("search: partial, any case, extra spaces, hyphen vs space, multiple words in any order, no-results", async () => {
  const names = async (q) => (await H.client().get("/api/products?q=" + encodeURIComponent(q))).data.map((p) => p.name);
  for (const q of ["pre", "PRE-WORKOUT", "  pre   workout  ", "pre workout", "workout pre", "Pre-Work"])
    assert.ok((await names(q)).includes("HYPEMAX Pre-Workout"), q);
  assert.deepEqual(await names("zzzz-no-such-thing"), []);
  assert.deepEqual(await names("%"), [], "LIKE wildcards are literal");
  assert.equal((await names("")).length, (await names("   ")).length, "blank search = full list");
});

// ======================= payments: late payment after cancel =======================
test("a payment that lands after the order was cancelled, when its coupon was reused, is refunded (no double coupon use)", async () => {
  await root.post("/api/admin/coupons", { code: "LATE1", discount_type: "percent", discount_value: 10, is_active: true, usage_limit: 1 });
  const a = await H.customer("late.a@test.local"), b = await H.customer("late.b@test.local");
  await a.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  const oa = (await a.post("/api/checkout", { address_id: a.addressId, coupon_code: "LATE1" })).data;
  assert.equal((await a.post(`/api/checkout/${oa.order_number}/cancel`)).data.status, "cancelled");
  await b.post("/api/cart/items", { product_id: PID, flavour: "Fruit Punch", quantity: 1 });
  assert.equal((await b.post("/api/checkout", { address_id: b.addressId, coupon_code: "LATE1" })).status, 201);
  const refundsBefore = H.fake.refunds.length;
  const { payment, ...body } = H.pay(oa.razorpay.order_id); // A completes the still-open Razorpay popup
  const v = await a.post("/api/checkout/verify", body);
  const o = (await H.q("SELECT status, payment_status FROM orders WHERE order_number=?", [oa.order_number]))[0];
  assert.equal(o.status, "cancelled", JSON.stringify({ verify: v.data, o }));
  assert.equal(H.fake.refunds.length, refundsBefore + 1, "full refund issued");
  const used = (await H.q("SELECT COUNT(*) n FROM coupon_usages cu JOIN coupons c ON c.id=cu.coupon_id WHERE c.code='LATE1' AND cu.status IN ('used','reserved')"))[0].n;
  assert.equal(used, 1, "coupon limit respected");
});

// ======================= security headers / admin =======================
test("Permissions-Policy, CSP and frame protection are sent; compression is on", async () => {
  const r = await fetch(H.base() + "/", { headers: { "accept-encoding": "gzip" } });
  assert.match(r.headers.get("permissions-policy") || "", /camera=\(\)/);
  assert.match(r.headers.get("content-security-policy") || "", /frame-ancestors 'self'/);
  assert.equal(r.headers.get("content-encoding"), "gzip");
  const html = await r.text();
  assert.match(html, /\/js\/core\.js\?v=[a-f0-9]{10}/, "assets are versioned for cache-busting");
});

test("CMS rejects prototype keys (constructor/__proto__)", async () => {
  for (const k of ["constructor", "toString", "__proto__"]) assert.equal((await root.get("/api/admin/content/" + k)).status, 404, k);
});

// ======================= SSO (OpenID Connect) =======================
const b64url = (b) => Buffer.from(b).toString("base64url");
const pkce = () => { const v = b64url(crypto.randomBytes(32)); return { v, c: b64url(crypto.createHash("sha256").update(v).digest()) }; };
async function authorize(c, { client_id = "hm-app", redirect_uri = "https://app.hypemax.test/callback", scope = "openid email profile offline_access", nonce = "n-123", challenge, prompt } = {}) {
  const qs = new URLSearchParams({ response_type: "code", client_id, redirect_uri, scope, state: "st-1", nonce, code_challenge: challenge, code_challenge_method: "S256", ...(prompt ? { prompt } : {}) });
  return c.get("/oauth/authorize?" + qs);
}
async function verifyIdToken(jwt, jwks, aud) {
  const [h, p, s] = jwt.split(".");
  const head = JSON.parse(Buffer.from(h, "base64url"));
  const k = jwks.keys.find((x) => x.kid === head.kid);
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: k, format: "jwk" }), Buffer.from(s, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  return { ok, claims, aud };
}

test("SSO: discovery + JWKS; login once, connected app gets verified tokens via code+PKCE", async () => {
  const disc = (await H.client().get("/.well-known/openid-configuration")).data;
  assert.equal(disc.issuer, "http://localhost");
  assert.deepEqual(disc.code_challenge_methods_supported, ["S256"]);
  const jwks = (await H.client().get("/oauth/jwks")).data;
  assert.equal(jwks.keys[0].kty, "RSA");
  assert.ok(!("d" in jwks.keys[0]), "private part never published");

  // not signed in -> sent to HYPEMAX login, coming back to the same authorize URL
  const { v, c } = pkce();
  const anon = await authorize(H.client(), { challenge: c });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location"), /^\/login\?next=%2Foauth%2Fauthorize/);
  const none = await authorize(H.client(), { challenge: c, prompt: "none" });
  assert.match(none.headers.get("location"), /error=login_required/);

  const user = await H.customer("sso.user@test.local", "Sso User");
  const r = await authorize(user, { challenge: c });
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, "https://app.hypemax.test/callback");
  assert.equal(loc.searchParams.get("state"), "st-1");
  assert.equal(loc.searchParams.get("iss"), "http://localhost");
  const code = loc.searchParams.get("code");

  const app = H.client(); // the connected app's back-end (no cookies)
  // wrong verifier -> refused
  const bad = await app.post("/oauth/token", { grant_type: "authorization_code", client_id: "hm-app", code, redirect_uri: "https://app.hypemax.test/callback", code_verifier: pkce().v });
  assert.equal(bad.status, 400); assert.equal(bad.data.error, "invalid_grant");
  // a code is single-use, so get a fresh one
  const { v: v2, c: c2 } = pkce();
  const code2 = new URL((await authorize(user, { challenge: c2 })).headers.get("location")).searchParams.get("code");
  const tok = await app.post("/oauth/token", { grant_type: "authorization_code", client_id: "hm-app", code: code2, redirect_uri: "https://app.hypemax.test/callback", code_verifier: v2 });
  assert.equal(tok.status, 200, JSON.stringify(tok.data));
  const { ok, claims } = await verifyIdToken(tok.data.id_token, jwks);
  assert.ok(ok, "ID token signature verifies with the published JWKS");
  assert.equal(claims.iss, "http://localhost"); assert.equal(claims.aud, "hm-app"); assert.equal(claims.nonce, "n-123");
  assert.equal(claims.email, "sso.user@test.local"); assert.ok(claims.exp > Date.now() / 1000);
  const ui = await app.get("/oauth/userinfo", { headers: { authorization: "Bearer " + tok.data.access_token } });
  assert.equal(ui.status, 200); assert.equal(ui.data.email, "sso.user@test.local");
  // replaying the same code: refused and the tokens it produced are revoked
  const replay = await app.post("/oauth/token", { grant_type: "authorization_code", client_id: "hm-app", code: code2, redirect_uri: "https://app.hypemax.test/callback", code_verifier: v2 });
  assert.equal(replay.status, 400);
  const afterReplay = await app.post("/oauth/token", { grant_type: "refresh_token", client_id: "hm-app", refresh_token: tok.data.refresh_token });
  assert.equal(afterReplay.status, 400, "refresh token from a replayed code is revoked");
  void v;
});

test("SSO: refresh rotation, stolen-token reuse detection, and central logout ends every connected app", async () => {
  const user = await H.customer("sso.rot@test.local");
  const app = H.client();
  const get = async () => {
    const { v, c } = pkce();
    const code = new URL((await authorize(user, { challenge: c })).headers.get("location")).searchParams.get("code");
    return (await app.post("/oauth/token", { grant_type: "authorization_code", client_id: "hm-app", code, redirect_uri: "https://app.hypemax.test/callback", code_verifier: v })).data;
  };
  const t1 = await get();
  const t2 = (await app.post("/oauth/token", { grant_type: "refresh_token", client_id: "hm-app", refresh_token: t1.refresh_token })).data;
  assert.ok(t2.refresh_token && t2.refresh_token !== t1.refresh_token, "rotated");
  // attacker replays the old refresh token -> whole family revoked, including the legit new one
  assert.equal((await app.post("/oauth/token", { grant_type: "refresh_token", client_id: "hm-app", refresh_token: t1.refresh_token })).status, 400);
  assert.equal((await app.post("/oauth/token", { grant_type: "refresh_token", client_id: "hm-app", refresh_token: t2.refresh_token })).status, 400);

  // central logout on HYPEMAX: connected app can no longer refresh or call userinfo
  const t3 = await get();
  assert.equal((await app.get("/oauth/userinfo", { headers: { authorization: "Bearer " + t3.access_token } })).status, 200);
  await user.post("/api/auth/logout");
  assert.equal((await app.post("/oauth/token", { grant_type: "refresh_token", client_id: "hm-app", refresh_token: t3.refresh_token })).status, 400);
  assert.equal((await app.get("/oauth/userinfo", { headers: { authorization: "Bearer " + t3.access_token } })).status, 401);
});

test("SSO: unregistered redirect_uri / client never redirects; confidential client needs its secret; PKCE is mandatory", async () => {
  const user = await H.customer("sso.neg@test.local");
  const { c, v } = pkce();
  const evil = await authorize(user, { challenge: c, redirect_uri: "https://evil.test/cb" });
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get("location"), null);
  assert.equal((await authorize(user, { challenge: c, client_id: "nope" })).status, 400);
  const noPkce = await user.get("/oauth/authorize?" + new URLSearchParams({ response_type: "code", client_id: "hm-app", redirect_uri: "https://app.hypemax.test/callback", scope: "openid", state: "s" }));
  assert.match(noPkce.headers.get("location"), /error=invalid_request/);
  const code = new URL((await authorize(user, { challenge: c, client_id: "hm-portal", redirect_uri: "https://portal.hypemax.test/cb" })).headers.get("location")).searchParams.get("code");
  const body = { grant_type: "authorization_code", client_id: "hm-portal", code, redirect_uri: "https://portal.hypemax.test/cb", code_verifier: v };
  assert.equal((await H.client().post("/oauth/token", { ...body, client_secret: "wrong" })).status, 401);
  const ok = await H.client().post("/oauth/token", body, { headers: { authorization: "Basic " + Buffer.from("hm-portal:portal-secret").toString("base64") } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test("SSO logout endpoint only signs out with a matching id_token_hint and only redirects to registered URIs", async () => {
  const user = await H.customer("sso.lo@test.local");
  const { v, c } = pkce();
  const code = new URL((await authorize(user, { challenge: c })).headers.get("location")).searchParams.get("code");
  const t = (await H.client().post("/oauth/token", { grant_type: "authorization_code", client_id: "hm-app", code, redirect_uri: "https://app.hypemax.test/callback", code_verifier: v })).data;
  // no hint: not logged out
  const r0 = await user.get("/oauth/logout?post_logout_redirect_uri=" + encodeURIComponent("https://app.hypemax.test/"));
  assert.equal(r0.headers.get("location"), "/account");
  assert.ok(await me(user));
  // unregistered target with valid hint: logs out but never redirects off-site
  const r1 = await user.get("/oauth/logout?" + new URLSearchParams({ id_token_hint: t.id_token, post_logout_redirect_uri: "https://evil.test/" }));
  assert.equal(r1.headers.get("location"), "/login?logged_out=1");
  assert.equal(await me(user), null);
});
