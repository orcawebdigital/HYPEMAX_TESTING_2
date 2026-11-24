/* Integrations (Super Admin): live checks of Razorpay, Cloudinary, Google, email and the database using the
   credentials configured on the server. The API only returns pass/fail and non-secret details. */
route("integrations", ["admins.manage"], async (ctx) => {
  const r = await GET("/integrations");
  if (!ctx.alive()) return;
  const NAMES = {
    database: ["MySQL database", "DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD"],
    razorpay: ["Razorpay payments", "RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET"],
    razorpay_webhook: ["Razorpay webhook", "RAZORPAY_WEBHOOK_SECRET"],
    cloudinary: ["Cloudinary images", "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET"],
    google: ["Google sign-in", "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL"],
    email: ["Email (SMTP)", "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM"],
    site: ["Site & security", "SITE_URL, NODE_ENV, COOKIE_SECURE"],
  };
  const badge = (v) => v.ok ? '<span class="bd ok">Working</span>' : v.configured === false ? '<span class="bd mu">Not configured</span>' : '<span class="bd er">Failed</span>';
  ctx.set(`<div class="ph"><h2>Integrations</h2><div class="row"><button class="btn sm" data-recheck>Re-check</button><button class="btn sm p" data-testmail>Send test email to me</button></div></div>
  <p class="sub2" style="margin:-6px 0 14px">Each check talks to the real service with the credentials in the server environment. Secrets are never shown here. Credentials are set in Hostinger → your Node.js app → Environment variables (see API_CONFIGURATION_GUIDE.md), then restart the app.</p>
  <div class="card" style="padding:0"><table><thead><tr><th>Service</th><th>Status</th><th>Details</th><th>Environment variables</th></tr></thead><tbody>
  ${Object.entries(r).map(([k, v]) => `<tr><td><b>${esc((NAMES[k] || [k])[0])}</b></td><td>${badge(v)}</td>
    <td>${esc(v.detail || "")}${v.note ? `<div class="sub2">${esc(v.note)}</div>` : ""}${v.last_event ? `<div class="sub2">Last webhook: ${esc(v.last_event.event)} at ${esc(new Date(v.last_event.processed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}</div>` : ""}</td>
    <td><code style="font-size:.72rem;white-space:normal">${esc((NAMES[k] || ["", ""])[1])}</code></td></tr>`).join("")}
  </tbody></table></div>
  <div class="card" style="margin-top:14px"><h3>Manual tests after configuring</h3><ul class="sub2" style="margin:8px 0 0 18px;line-height:1.8">
    <li>Razorpay: place a ₹1 test order on the storefront using Razorpay test mode, then refund it from Orders.</li>
    <li>Cloudinary: upload an image on any product's Images tab; the URL should start with https://res.cloudinary.com.</li>
    <li>Google: open <a href="/login" target="_blank" rel="noopener">/login</a> in a private window and choose "Continue with Google".</li>
    <li>Email: use "Send test email to me", then trigger "Forgot password" for a customer account you own.</li></ul></div>`);
  $("[data-recheck]", ctx.view).addEventListener("click", () => ctx.reload());
  $("[data-testmail]", ctx.view).addEventListener("click", async (e) => {
    const x = await act(e.currentTarget, () => POST("/integrations/test-email"), null);
    if (x) toast(x.ok ? `Test email sent to ${x.to}. Check the inbox (and spam folder).` : "SMTP accepted the login but the message wasn't sent. Check EMAIL_FROM.", !x.ok);
  });
});
