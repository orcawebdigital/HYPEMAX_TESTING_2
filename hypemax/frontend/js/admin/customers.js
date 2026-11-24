/* Customers list + detail */
"use strict";
const custQS = (q) => queryStr({ q: q.q, has_orders: q.has_orders, login: q.login, from: q.from, to: q.to, sort: q.sort });

route("customers", ["customers.view"], async (ctx) => {
  const q = ctx.query, page = Math.max(1, +q.page || 1);
  const data = await GET("/customers?" + custQS(q) + `&page=${page}&limit=25`);
  const filtered = q.q || q.has_orders || q.login || q.from || q.to;
  const ok = ctx.set(`<div class="ph"><div><h2>Customers</h2><div class="meta">${plural(data.total, "customer")}${filtered ? " match these filters" : ""}</div></div>
    <div class="acts">${can("customers.export") ? `<a class="btn sm" href="/api/admin/customers/export.csv?${custQS(q)}" download>Export CSV</a>` : ""}</div></div>
  <form class="tbar" id="cf"><input class="grow" type="search" name="q" placeholder="Name, email or phone" value="${esc(q.q || "")}">
    <select name="has_orders" aria-label="Has orders"><option value="">Any orders</option><option value="1"${q.has_orders === "1" ? " selected" : ""}>Has paid orders</option><option value="0"${q.has_orders === "0" ? " selected" : ""}>No paid orders</option></select>
    <select name="login" aria-label="Login method"><option value="">Any login</option><option value="google"${q.login === "google" ? " selected" : ""}>Google login</option></select>
    <span class="dates"><span class="sub2">Registered</span><input type="date" name="from" value="${esc(q.from || "")}" aria-label="Registered from"><span class="muted">to</span><input type="date" name="to" value="${esc(q.to || "")}" aria-label="Registered to"></span>
    <select name="sort" aria-label="Sort">${[["newest", "Newest first"], ["oldest", "Oldest first"], ["spent", "Top spenders"], ["orders", "Most orders"], ["name", "Name A–Z"]].map(([v, l]) => `<option value="${v}"${(q.sort || "newest") === v ? " selected" : ""}>${l}</option>`).join("")}</select>
    <button class="btn sm p" type="submit">Search</button>${filtered ? `<a class="btn sm gh" href="#/customers">Clear</a>` : ""}</form>
  <div class="pn flush">${data.rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Customer</th><th>Phone</th><th>Registered</th><th class="r">Orders</th><th class="r">Spent</th><th>Last order</th><th>Account</th></tr></thead><tbody>
    ${data.rows.map((u) => `<tr class="clk" data-href="#/customers/${u.id}"><td><a class="strong" href="#/customers/${u.id}">${esc(u.name)}</a><div class="sub2">${esc(u.email)}${u.google ? ' · <span class="bd in nodot">Google</span>' : ""}</div></td>
      <td class="nwr">${esc(u.phone || "—")}</td><td class="nwr">${fd(u.created_at)}</td><td class="r">${num(u.orders)}</td><td class="r nwr">${inr(u.spent)}</td><td class="nwr">${u.last_order_at ? fd(u.last_order_at) : "—"}</td>
      <td>${u.is_active ? (u.email_verified ? '<span class="bd ok">Active</span>' : '<span class="bd wn">Unverified</span>') : '<span class="bd er">Suspended</span>'}</td></tr>`).join("")}
  </tbody></table></div>` : empty(filtered ? "No customers match these filters" : "No customers yet")}<div id="cpg"></div></div>`);
  if (!ok) return;
  if (data.total > data.limit) { const pg = pager(data.total, page, data.limit, (p) => ctx.setQuery({ page: p })); $("#cpg").innerHTML = pg.html; pg.bind($("#cpg")); }
  const f = $("#cf");
  f.addEventListener("submit", (e) => { e.preventDefault(); const v = vals(f); if (v.from && v.to && v.from > v.to) return toast("Start date must be before the end date", true); ctx.setQuery({ ...v, q: v.q.trim(), page: "" }); });
  $$("select", f).forEach((s) => s.addEventListener("change", () => f.requestSubmit()));
  bindRowLinks(ctx.view);
});

route("customers/:id", ["customers.view"], async (ctx) => {
  const u = await GET("/customers/" + encodeURIComponent(ctx.params.id));
  const ok = ctx.set(`<div class="ph"><div><div class="crumb"><a href="#/customers">Customers</a> /</div><h2>${esc(u.name)}</h2>
    <div class="meta">${u.is_active ? '<span class="bd ok">Active</span>' : '<span class="bd er">Suspended</span>'} ${u.email_verified ? '<span class="bd ok nodot">Email verified</span>' : '<span class="bd wn nodot">Email not verified</span>'} ${u.google ? '<span class="bd in nodot">Google login</span>' : ""}</div></div>
    <div class="acts">${can("customers.export") ? `<button class="btn sm ${u.is_active ? "dg" : "p"}" id="csus">${u.is_active ? "Suspend account" : "Reactivate account"}</button>` : ""}</div></div>
  <div class="kgrid" style="margin-bottom:16px">${kpi("Paid orders", num(u.orders))}${kpi("Total spent", inr(u.spent), { cls: "hl", sub: "Net of refunds" })}${kpi("Registered", fd(u.created_at))}${kpi("Last order", u.last_order_at ? fd(u.last_order_at) : "—")}${kpi("Last login", u.last_login_at ? fd(u.last_login_at) : "—")}</div>
  <div class="cols"><div>
    <div class="pn flush"><div class="pnh"><h3>Orders</h3></div>${u.orders.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Order</th><th>Date</th><th>Payment</th><th>Status</th><th class="r">Total</th></tr></thead><tbody>
      ${u.orders.map((o) => `<tr class="clk" data-href="#/orders/${esc(o.order_number)}"><td><a class="mono strong" href="#/orders/${esc(o.order_number)}">${esc(o.order_number)}</a>${o.coupon_code ? `<div class="sub2">Coupon ${esc(o.coupon_code)}</div>` : ""}</td><td class="nwr">${fdt(o.created_at)}</td><td>${badge(PAY_ST, o.payment_status)}</td><td>${badge(ORDER_ST, o.status)}</td><td class="r nwr">${inr(o.total)}</td></tr>`).join("")}</tbody></table></div>` : empty("No orders yet")}</div>
    <div class="pn flush"><div class="pnh"><h3>Payments & transactions</h3></div>${u.payments.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Razorpay payment</th><th>Order</th><th>Method</th><th>Status</th><th class="r">Amount</th><th>Paid</th></tr></thead><tbody>
      ${u.payments.map((p) => `<tr><td class="mono">${esc(p.razorpay_payment_id || "—")}</td><td><a class="lk mono" href="#/orders/${esc(p.order_number)}">${esc(p.order_number)}</a></td><td>${esc(p.method || "—")}</td><td>${badge(PAY_ST, p.status)}</td><td class="r nwr">${inr(p.amount)}</td><td class="nwr sub2">${fdt(p.paid_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No payments yet")}</div>
    <div class="pn flush"><div class="pnh"><h3>Coupon usage</h3></div>${u.coupons.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Code</th><th>Order</th><th>Status</th><th class="r">Discount</th><th>Date</th></tr></thead><tbody>
      ${u.coupons.map((c) => `<tr><td><code>${esc(c.code)}</code></td><td><a class="lk mono" href="#/orders/${esc(c.order_number)}">${esc(c.order_number)}</a></td><td><span class="bd ${c.status === "used" ? "ok" : c.status === "reserved" ? "wn" : "mu"}">${esc(c.status)}</span></td><td class="r">${inr(c.discount_amount)}</td><td class="nwr sub2">${fdt(c.created_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No coupons used")}</div>
    ${u.activity ? `<div class="pn flush"><div class="pnh"><h3>Recent activity</h3><span class="sub2">Last 50 events</span></div>${u.activity.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Event</th><th>Path</th><th>When</th></tr></thead><tbody>${u.activity.map((a) => `<tr><td>${esc(a.event_type.replace(/_/g, " "))}${a.product_id ? ` <span class="sub2">product #${a.product_id}</span>` : ""}</td><td class="mono">${esc(a.path || "")}</td><td class="nwr sub2">${fdt(a.created_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No tracked activity")}</div>` : ""}
  </div><div>
    <div class="pn"><h3>Profile</h3><dl class="kv"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>Email</dt><dd><a class="lk" href="mailto:${esc(u.email)}">${esc(u.email)}</a></dd><dt>Phone</dt><dd>${u.phone ? `<a class="lk" href="tel:${esc(u.phone)}">${esc(u.phone)}</a>` : "—"}</dd>
      <dt>Registered</dt><dd>${fdt(u.created_at)}</dd><dt>Last login</dt><dd>${fdt(u.last_login_at)}</dd><dt>Customer ID</dt><dd>${u.id}</dd></dl></div>
    <div class="pn"><h3>Addresses</h3>${u.addresses.length ? u.addresses.map((a) => `<div class="adr" style="padding:8px 0;border-bottom:1px solid var(--ln)">${a.is_default ? '<span class="bd ok nodot">Default</span> ' : ""}${a.label ? `<span class="bd mu nodot">${esc(a.label)}</span>` : ""}<br><b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(a.line1)}${a.line2 ? ", " + esc(a.line2) : ""}<br>${esc(a.city)}, ${esc(a.state)} ${esc(a.pincode)}</div>`).join("") : empty("No saved addresses")}</div>
  </div></div>`);
  if (!ok) return;
  bindRowLinks(ctx.view);
  const b = $("#csus");
  b && b.addEventListener("click", async () => {
    if (u.is_active && !(await confirmBox(`Suspend <b>${esc(u.name)}</b>? They are logged out everywhere and can't log in until reactivated. Orders are not affected.`, { ok: "Suspend" }))) return;
    if (await act(b, () => POST(`/customers/${u.id}/active`, { is_active: !u.is_active }), u.is_active ? "Account suspended" : "Account reactivated")) ctx.reload();
  });
});
