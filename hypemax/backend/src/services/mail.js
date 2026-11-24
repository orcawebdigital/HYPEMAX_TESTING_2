/**
 * Transactional email (SMTP via nodemailer). Credentials come only from SMTP_* env vars.
 * Message bodies are never logged (they can contain password-reset and verification links).
 */
const config = require("../config");

let transport = null;
let testTransport = null; // tests inject a capturing transport; never used by the app itself

function getTransport() {
  if (testTransport) return testTransport;
  if (!config.features.email) return null;
  if (!transport) {
    transport = require("nodemailer").createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transport;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const maskEmail = (e) => String(e || "").replace(/^(.).*(@.*)$/, "$1***$2");
const inr = (p) => "₹" + (Number(p || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Table-based, inline-styled layout that renders in Gmail/Outlook/Apple Mail. */
function layout({ title, preheader = "", body }) {
  const site = config.siteUrl;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#efefef;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
<span style="display:none!important;opacity:0;color:transparent;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efefef"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:10px;overflow:hidden">
 <tr><td style="background:#0b0b0b;padding:18px 24px"><a href="${esc(site)}" style="text-decoration:none"><img src="${esc(site)}/img/logo.png" alt="HYPEMAX Nutrition" height="36" style="display:block;height:36px;border:0"></a></td></tr>
 <tr><td style="height:4px;background:#ff2525;background-image:linear-gradient(90deg,#ff2525,#ff6a00)"></td></tr>
 <tr><td style="padding:26px 24px 8px"><h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#0b0b0b">${esc(title)}</h1>
   <div style="font-size:15px;line-height:1.6;color:#333">${body}</div></td></tr>
 <tr><td style="padding:18px 24px 24px;border-top:1px solid #eee;font-size:12px;line-height:1.5;color:#888">
   HYPEMAX Nutrition · <a href="${esc(site)}" style="color:#888">${esc(site.replace(/^https?:\/\//, ""))}</a><br>
   Questions? Reply to this email or visit <a href="${esc(site)}/contact" style="color:#888">our contact page</a>.</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0"><tr><td style="border-radius:6px;background:#ff2525">
<a href="${esc(href)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-weight:bold;text-decoration:none;font-size:15px">${esc(label)}</a></td></tr></table>`;
const p = (html) => `<p style="margin:0 0 12px">${html}</p>`;
const small = (html) => `<p style="margin:12px 0 0;font-size:13px;color:#777">${html}</p>`;

function orderTable(o) {
  const rows = (o.items || []).map((it) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(it.product_name)}${it.flavour ? ` <span style="color:#888">(${esc(it.flavour)})</span>` : ""} × ${it.quantity}</td>
    <td align="right" style="padding:8px 0;border-bottom:1px solid #eee;white-space:nowrap">${inr(it.line_total)}</td></tr>`).join("");
  const line = (l, v, b) => `<tr><td style="padding:4px 0;${b ? "font-weight:bold;color:#000" : "color:#555"}">${l}</td><td align="right" style="padding:4px 0;${b ? "font-weight:bold;color:#000" : "color:#555"}">${v}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 12px">${rows}
    ${line("Subtotal", inr(o.subtotal))}${o.discount ? line(`Coupon${o.coupon_code ? " " + esc(o.coupon_code) : ""}`, "− " + inr(o.discount)) : ""}
    ${line("Shipping", o.shipping_fee ? inr(o.shipping_fee) : "Free")}${line("Total paid", inr(o.total), true)}</table>`;
}
const address = (o) => `${esc(o.ship_name)}<br>${esc(o.ship_line1)}${o.ship_line2 ? ", " + esc(o.ship_line2) : ""}<br>${esc(o.ship_city)}, ${esc(o.ship_state)} - ${esc(o.ship_pincode)}`;
const orderLink = (o) => `${config.siteUrl}/account/orders/${encodeURIComponent(o.order_number)}`;

// ---------------- templates ----------------
const T = {
  welcome: (u) => ({ subject: "Welcome to HYPEMAX Nutrition", title: `Welcome, ${u.name.split(" ")[0]}!`, preheader: "Your account is ready.",
    body: p("Your HYPEMAX Nutrition account is ready. Track orders, save addresses and check out faster.") + button(config.siteUrl + "/products", "Shop now") }),
  verifyEmail: (u, link) => ({ subject: "Verify your HYPEMAX Nutrition email", title: "Confirm your email", preheader: "One click to verify your email address.",
    body: p(`Hi ${esc(u.name)}, please confirm this is your email address.`) + button(link, "Verify email") + small("This link expires in 48 hours. If you didn't create an account, ignore this email.") }),
  passwordReset: (u, link) => ({ subject: "Reset your HYPEMAX Nutrition password", title: "Reset your password", preheader: "Use this link within 1 hour.",
    body: p(`Hi ${esc(u.name)}, we received a request to reset your password.`) + button(link, "Choose a new password") + small("This link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email; your password won't change.") }),
  passwordChanged: (u) => ({ subject: "Your HYPEMAX Nutrition password was changed", title: "Password changed", preheader: "Your password was just changed.",
    body: p(`Hi ${esc(u.name)}, the password for your account was just changed and other devices were signed out.`) + p("If this wasn't you, reset your password immediately and contact us.") + button(config.siteUrl + "/forgot-password", "Reset password") }),
  orderConfirmed: (o) => ({ subject: `Order ${o.order_number} confirmed: payment received`, title: "Thanks! Your order is confirmed", preheader: `We received ${inr(o.total)} for order ${o.order_number}.`,
    body: p(`Hi ${esc(o.ship_name)}, we've received your payment of <b>${inr(o.total)}</b> and your order <b>${esc(o.order_number)}</b> is confirmed.`) + orderTable(o) +
      p(`<b>Delivering to</b><br>${address(o)}`) + button(orderLink(o), "View order") + small("Your invoice can be downloaded from your order page.") }),
  statusUpdate: (o, label, note, shipment) => ({ subject: `Order ${o.order_number}: ${label}`, title: `Your order is ${label.toLowerCase()}`, preheader: `Update on order ${o.order_number}.`,
    body: p(`Order <b>${esc(o.order_number)}</b> is now <b>${esc(label)}</b>.`) + (note ? p(esc(note)) : "") +
      (shipment && shipment.tracking_id ? p(`Courier: <b>${esc(shipment.courier || "-")}</b><br>Tracking ID: <b>${esc(shipment.tracking_id)}</b>`) + (shipment.tracking_url ? button(shipment.tracking_url, "Track shipment") : "") : "") +
      button(orderLink(o), "View order") }),
  cancelled: (o, reason) => ({ subject: `Order ${o.order_number} cancelled`, title: "Your order has been cancelled", preheader: `Order ${o.order_number} was cancelled.`,
    body: p(`Order <b>${esc(o.order_number)}</b> has been cancelled.`) + (reason ? p("Reason: " + esc(reason)) : "") + p("If you paid online, the refund is initiated automatically; you'll get a separate email.") + button(orderLink(o), "View order") }),
  refund: (o, amount, status) => ({ subject: `Refund ${status === "processed" ? "processed" : "initiated"} for order ${o.order_number}`, title: status === "processed" ? "Your refund has been processed" : "Your refund is on its way",
    preheader: `${inr(amount)} refund for order ${o.order_number}.`,
    body: p(`A refund of <b>${inr(amount)}</b> for order <b>${esc(o.order_number)}</b> has been ${status === "processed" ? "processed" : "initiated"} to your original payment method.`) + p("Banks usually credit refunds within 5-7 working days.") + button(orderLink(o), "View order") }),
  adminNewOrder: (o) => ({ subject: `New order ${o.order_number}: ${inr(o.total)}`, title: "New paid order", preheader: `${o.ship_name} paid ${inr(o.total)}.`,
    body: p(`<b>${esc(o.ship_name)}</b> (${esc(o.customer_email)}, ${esc(o.ship_phone)}) placed order <b>${esc(o.order_number)}</b>.`) + orderTable(o) + p(`<b>Ship to</b><br>${address(o)}`) +
      button(`${config.siteUrl}/admin#/orders/${encodeURIComponent(o.order_number)}`, "Open in admin") }),
  adminNewMessage: (m) => ({ subject: `New contact message from ${m.name}`, title: "New contact form message", preheader: m.subject || "",
    body: p(`<b>${esc(m.name)}</b>${m.email ? " · " + esc(m.email) : ""}${m.phone ? " · " + esc(m.phone) : ""}`) + (m.subject ? p("<b>" + esc(m.subject) + "</b>") : "") +
      p(esc(m.message).replace(/\n/g, "<br>")) + button(`${config.siteUrl}/admin#/messages`, "Open in admin") }),
  test: () => ({ subject: "HYPEMAX Nutrition: test email", title: "Email delivery works", preheader: "Your SMTP settings are correct.",
    body: p("This test email was sent from the HYPEMAX Nutrition admin panel. Your SMTP settings are working.") }),
};

const toText = (html) => html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|tr|h1|div)>/gi, "\n").replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
  .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Send a templated email. Never throws: returns true if handed to the SMTP server, false otherwise.
 * `name` is a key of T; args are passed to the template.
 */
async function sendTemplate(to, name, ...args) {
  if (!to) return false;
  const t = getTransport();
  const m = T[name](...args);
  if (!t) {
    if (!config.isProd && process.env.NODE_ENV !== "test") console.log(`[email not configured] would send "${name}" to ${maskEmail(to)}`);
    return false;
  }
  try {
    const html = layout(m);
    await t.sendMail({ from: config.smtp.from || config.smtp.user, to, subject: m.subject, html, text: toText(html), headers: { "X-Template": name } });
    return true;
  } catch (e) {
    console.error(`Email "${name}" to ${maskEmail(to)} failed: ${e.code || ""} ${e.message}`);
    return false;
  }
}

/** Admin alert recipients: ADMIN_NOTIFY_EMAIL, else the store email in Site settings. */
async function adminRecipients() {
  if (config.adminNotifyEmail) return config.adminNotifyEmail;
  const { getSettings } = require("./content");
  return (await getSettings()).email || "";
}

/** Verify SMTP credentials without sending anything (for the integrations check). */
async function verify() {
  const t = getTransport();
  if (!t) return { ok: false, error: "SMTP is not configured" };
  try { await t.verify(); return { ok: true }; } catch (e) { return { ok: false, error: `${e.code || ""} ${e.message}`.trim() }; }
}

module.exports = { sendTemplate, adminRecipients, verify, esc, templates: T, _setTestTransport: (t) => { testTransport = t; } };
