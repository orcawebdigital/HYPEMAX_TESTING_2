/* Dashboard + Analytics */
"use strict";
const rangeQS = (q) => queryStr({ range: q.range || "30d", from: q.range === "custom" ? q.from : "", to: q.range === "custom" ? q.to : "" });

route("dashboard", ["dashboard.view"], async (ctx) => {
  const q = ctx.query;
  const [d, a] = await Promise.all([GET("/dashboard?" + rangeQS(q)), GET("/activity")]);
  const t = d.traffic, o = d.orders, rv = d.revenue, p = d.payments, pr = d.products, c = d.coupons, cu = d.customers;
  const ok = ctx.set(`<div class="ph"><div><h2>Dashboard</h2><div class="meta">Hello ${esc(STATE.me.name)} · Showing <b style="color:#fff">${esc(d.range.label)}</b> (IST)</div></div>
    <div class="acts">${can("analytics.view") ? `<a class="btn sm" href="#/analytics?${rangeQS(q)}">Open analytics</a>` : ""}</div></div>
  ${featureBanner()}
  ${rangeBar(q)}
  <div class="kh">Sales</div><div class="kgrid">
    ${kpi("Net revenue", inr(rv.net), { cls: "hl", sub: "Paid orders minus refunds" })}${kpi("Gross revenue", inr(rv.gross), { sub: "Paid order totals" })}${kpi("Average order value", inr(rv.average_order))}
    ${kpi("Paid orders", num(o.total))}${kpi("Cancelled orders", num(o.cancelled), { sub: "Paid then cancelled", cls: o.cancelled ? "warn" : "" })}${kpi("Awaiting fulfilment", num(o.awaiting_fulfilment), { sub: "Right now, all dates", cls: o.awaiting_fulfilment ? "warn" : "" })}
  </div>
  <div class="kh">Payments</div><div class="kgrid">
    ${kpi("Successful", num(p.successful))}${kpi("Pending", num(p.pending))}${kpi("Failed", num(p.failed), { cls: p.failed ? "bad" : "" })}${kpi("Refunded", num(p.refunded))}
  </div>
  <div class="kh">Customers & coupons</div><div class="kgrid">
    ${kpi("Total customers", num(cu.total), { sub: "All time" })}${kpi("New customers", num(cu.new), { sub: "Registered in range" })}${kpi("Coupon uses", num(c.uses))}${kpi("Coupon discount given", inr(c.discount))}
  </div>
  <div class="kh">Products (current)</div><div class="kgrid">
    ${kpi("Products", num(pr.total), { sub: "Excluding discontinued" })}${kpi("Active", num(pr.active))}${kpi("Low stock", num(pr.low_stock), { cls: pr.low_stock ? "warn" : "" })}${kpi("Out of stock", num(pr.out_of_stock), { cls: pr.out_of_stock ? "bad" : "" })}${kpi("Upcoming / coming soon", num(pr.upcoming))}
  </div>
  <div class="kh">Traffic & funnel</div><div class="kgrid">
    ${kpi("Visits", num(t.visits), { sub: "Sessions" })}${kpi("Unique visitors", num(t.unique_visitors))}${kpi("Anonymous visitors", num(t.anonymous_visitors))}${kpi("Logged-in customers", num(t.logged_in_customers))}
    ${kpi("Page views", num(t.page_views))}${kpi("Home page views", num(t.home_views))}${kpi("Product views", num(t.product_views))}${kpi("Add to cart", num(t.add_to_cart))}${kpi("Removed from cart", num(t.remove_from_cart))}
    ${kpi("Checkout starts", num(t.checkout_start))}${kpi("Purchases", num(t.purchases))}${kpi("Conversion rate", pct(t.conversion_rate), { cls: "hl", sub: "Purchases ÷ visits" })}${kpi("Cart abandonment", pct(t.cart_abandonment_rate), { sub: "Carts without purchase" })}
  </div>
  <div class="cols2" style="margin-top:18px">
    <div class="pn flush"><div class="pnh"><h3>Recent orders</h3>${can("orders.view") ? `<a class="lk" href="#/orders">All orders →</a>` : ""}</div>
      ${a.orders.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th class="r">Total</th></tr></thead><tbody>${a.orders.map((x) => `<tr class="clk" data-href="#/orders/${esc(x.order_number)}"><td><span class="mono">${esc(x.order_number)}</span><div class="sub2">${fdt(x.created_at)}</div></td><td>${esc(x.ship_name)}</td><td>${badge(ORDER_ST, x.status)} ${badge(PAY_ST, x.payment_status)}</td><td class="r nwr">${inr(x.total)}</td></tr>`).join("")}</tbody></table></div>` : empty("No orders yet")}</div>
    <div class="pn flush"><div class="pnh"><h3>Low stock</h3>${can("products.manage", "products.content") ? `<a class="lk" href="#/products">Products →</a>` : ""}</div>
      ${a.low_stock.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Product</th><th class="r">Available</th><th class="r">Alert at</th></tr></thead><tbody>${a.low_stock.map((x) => `<tr${can("products.manage", "products.content") ? ` class="clk" data-href="#/products/${x.id}"` : ""}><td>${esc(x.name)}</td><td class="r ${x.stock - x.reserved <= 0 ? "red" : ""}">${num(x.stock - x.reserved)}<div class="sub2">${num(x.stock)} in stock · ${num(x.reserved)} reserved</div></td><td class="r">${num(x.low_stock_threshold)}</td></tr>`).join("")}</tbody></table></div>` : empty("All active products are above their low-stock alert")}</div>
  </div>`);
  if (!ok) return;
  bindRange(ctx.view, (r) => ctx.setQuery(r));
  bindRowLinks(ctx.view);
});

/** Rows with data-href navigate on click (ignoring clicks on buttons/links/inputs inside). */
function bindRowLinks(root) {
  $$("tr[data-href]", root).forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.closest("a,button,input,select,label,textarea")) return; location.hash = tr.dataset.href; }));
}

route("analytics", ["analytics.view"], async (ctx) => {
  const q = ctx.query;
  const [an, d] = await Promise.all([GET("/analytics?" + rangeQS(q)), can("dashboard.view") ? GET("/dashboard?" + rangeQS(q)) : Promise.resolve(null)]);
  const sb = buckets(an.sales, an.range, ["orders", "revenue"]);
  const tb = buckets(an.traffic, an.range, ["visits", "visitors"]);
  const per = sb.monthly ? "month" : "day";
  const hasSales = an.sales.length > 0, hasTraffic = an.traffic.length > 0;
  let funnel = "";
  if (d) {
    const t = d.traffic;
    const steps = [["Visits", t.visits], ["Product views", t.product_views], ["Add to cart", t.add_to_cart], ["Checkout starts", t.checkout_start], ["Purchases", t.purchases]];
    const max = Math.max(1, ...steps.map((s) => Number(s[1]) || 0));
    funnel = `<div class="pn"><div class="pnh"><h3>Conversion funnel</h3><span class="sub2">Conversion ${pct(t.conversion_rate)} · Cart abandonment ${pct(t.cart_abandonment_rate)}</span></div>
      ${t.visits || t.purchases ? `<div class="funnel">${steps.map(([l, v], i) => `<div class="fst"><span>${l}</span><span class="bar0"><i style="width:${(Number(v) / max) * 100}%"></i></span><span class="r"><b>${num(v)}</b>${i ? `${steps[i - 1][1] ? `<small>${pct(Math.round((Number(v) / Number(steps[i - 1][1])) * 1000) / 10)} of previous</small>` : ""}` : ""}</span></div>`).join("")}</div>` : empty("No visits recorded in this period yet")}</div>`;
  }
  const ok = ctx.set(`<div class="ph"><div><h2>Analytics</h2><div class="meta">Showing <b style="color:#fff">${esc(an.range.label)}</b> (IST) · charts per ${per}</div></div><div class="acts"><a class="btn sm" href="/api/admin/reports/sales.csv?${rangeQS(q)}" download>Download sales report (CSV)</a></div></div>
  ${rangeBar(q)}
  <div class="cols2">
    <div class="pn"><div class="pnh"><h3>Revenue per ${per}</h3><span class="sub2">Gross paid order value · ${inr(sb.data.reduce((a, x) => a + x.revenue, 0))}</span></div>${hasSales ? colChart(sb.labels, { name: "Revenue", color: "#ff6a00", values: sb.data.map((x) => x.revenue) }, { fmt: inr, axisFmt: (v) => shortNum(v, true), tipExtra: (i) => `Orders: <strong>${num(sb.data[i].orders)}</strong>` }) : empty("No paid orders in this period yet")}</div>
    <div class="pn"><div class="pnh"><h3>Orders per ${per}</h3><span class="sub2">${plural(sb.data.reduce((a, x) => a + x.orders, 0), "paid order")}</span></div>${hasSales ? colChart(sb.labels, { name: "Orders", color: "#60a5fa", values: sb.data.map((x) => x.orders) }) : empty("No paid orders in this period yet")}</div>
  </div>
  <div class="cols2">
    <div class="pn"><div class="pnh"><h3>Visits & visitors per ${per}</h3></div>${hasTraffic ? lineChart(tb.labels, [{ name: "Visits", color: "#ff6a00", values: tb.data.map((x) => x.visits) }, { name: "Unique visitors", color: "#60a5fa", values: tb.data.map((x) => x.visitors) }]) : empty("No visits recorded in this period yet")}</div>
    ${funnel || `<div class="pn"><h3>Conversion funnel</h3>${empty("Needs the dashboard permission")}</div>`}
  </div>
  <div class="cols2">
    <div class="pn flush"><div class="pnh"><h3>Top products</h3><span class="sub2">By units sold</span></div>${an.top_products.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Product</th><th class="r">Units</th><th class="r">Revenue</th></tr></thead><tbody>${an.top_products.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${num(x.units)}</td><td class="r">${inr(x.revenue)}</td></tr>`).join("")}</tbody></table></div>` : empty("No sales in this period yet")}</div>
    <div class="pn"><div class="pnh"><h3>Most viewed products</h3></div>${hbars(an.most_viewed.map((x) => ({ label: x.name, value: x.views })))}</div>
  </div>
  <div class="cols2">
    <div class="pn"><div class="pnh"><h3>Traffic sources</h3></div>${hbars(an.sources.map((x) => ({ label: x.source || "direct", value: x.visits })))}</div>
    <div class="pn"><div class="pnh"><h3>Devices</h3></div>${donut(["desktop", "mobile", "tablet"].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: Number((an.devices.find((x) => x.device === k) || {}).visits || 0) })).concat(an.devices.filter((x) => !["desktop", "mobile", "tablet"].includes(x.device)).map((x) => ({ label: x.device || "Other", value: Number(x.visits) }))))}</div>
  </div>
  <div class="pn flush"><div class="pnh"><h3>Top pages</h3></div>${an.pages.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Path</th><th class="r">Page views</th></tr></thead><tbody>${an.pages.map((x) => `<tr><td class="mono">${esc(x.path)}</td><td class="r">${num(x.views)}</td></tr>`).join("")}</tbody></table></div>` : empty("No page views recorded in this period yet")}</div>`);
  if (!ok) return;
  bindRange(ctx.view, (r) => ctx.setQuery(r));
});
