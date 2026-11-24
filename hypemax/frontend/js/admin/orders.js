/* Orders list + order detail with fulfilment, shipment, cancel/refund/return, reconcile, invoice */
"use strict";
const orderFilterQS = (q) => queryStr({ q: q.q, status: q.status, payment_status: q.payment_status, range: q.range, from: q.range === "custom" ? q.from : "", to: q.range === "custom" ? q.to : "", include_unpaid: q.include_unpaid });

route("orders", ["orders.view"], async (ctx) => {
  const q = ctx.query, page = Math.max(1, +q.page || 1);
  const data = await GET("/orders?" + orderFilterQS(q) + `&page=${page}&limit=25`);
  const filtered = q.q || q.status || q.payment_status || q.range;
  const ok = ctx.set(`<div class="ph"><div><h2>Orders</h2><div class="meta">${plural(data.total, "order")}${filtered ? " match these filters" : ""}</div></div>
    <div class="acts">${can("customers.export") ? `<a class="btn sm" href="/api/admin/orders/export.csv?${orderFilterQS(q)}" download>Export CSV</a>` : ""}</div></div>
  ${rangeBar(q, { allowNone: true })}
  <form class="tbar" id="of"><input class="grow" type="search" name="q" placeholder="Order #, name, email, phone or Razorpay payment ID" value="${esc(q.q || "")}">
    <select name="status"><option value="">All order statuses</option>${Object.entries(ORDER_ST).map(([k, [l]]) => `<option value="${k}"${q.status === k ? " selected" : ""}>${l}</option>`).join("")}</select>
    <select name="payment_status"><option value="">All payment statuses</option>${Object.entries(PAY_ST).map(([k, [l]]) => `<option value="${k}"${q.payment_status === k ? " selected" : ""}>${l}</option>`).join("")}</select>
    <label class="ck" title="Show checkouts that were never paid and were released"><input type="checkbox" name="include_unpaid"${q.include_unpaid ? " checked" : ""}> Include abandoned</label>
    <button class="btn sm p" type="submit">Search</button>${filtered || q.include_unpaid ? `<a class="btn sm gh" href="#/orders">Clear</a>` : ""}</form>
  <div class="pn flush">${data.rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th class="r">Items</th><th>Payment</th><th>Status</th><th class="r">Total</th></tr></thead><tbody>
    ${data.rows.map((o) => `<tr class="clk" data-href="#/orders/${esc(o.order_number)}"><td><a class="mono strong" href="#/orders/${esc(o.order_number)}">${esc(o.order_number)}</a>${o.coupon_code ? `<div class="sub2">Coupon ${esc(o.coupon_code)}</div>` : ""}</td>
      <td class="nwr">${fdt(o.created_at)}</td><td>${esc(o.ship_name)}<div class="sub2">${esc(o.customer_email)}${o.ship_city ? " · " + esc(o.ship_city) : ""}</div></td><td class="r">${num(o.units)}</td>
      <td>${badge(PAY_ST, o.payment_status)}</td><td>${badge(ORDER_ST, o.status)}</td><td class="r nwr strong">${inr(o.total)}${o.discount ? `<div class="sub2">−${inr(o.discount)}</div>` : ""}</td></tr>`).join("")}
  </tbody></table></div>` : empty(filtered ? "No orders match these filters" : "No orders yet")}<div id="opg"></div></div>`);
  if (!ok) return;
  const pg = pager(data.total, page, data.limit, (p) => ctx.setQuery({ page: p }));
  if (data.total > data.limit) { $("#opg").innerHTML = pg.html; pg.bind($("#opg")); }
  bindRange(ctx.view, (r) => ctx.setQuery({ ...r, page: "" }));
  const f = $("#of");
  f.addEventListener("submit", (e) => { e.preventDefault(); const v = vals(f); ctx.setQuery({ q: v.q.trim(), status: v.status, payment_status: v.payment_status, include_unpaid: v.include_unpaid ? "1" : "", page: "" }); });
  $$("select,input[type=checkbox]", f).forEach((s) => s.addEventListener("change", () => f.requestSubmit()));
  bindRowLinks(ctx.view);
});

route("orders/:number", ["orders.view"], async (ctx) => {
  const o = await GET("/orders/" + encodeURIComponent(ctx.params.number));
  const paid = !!o.paid_at, refundable = paid && o.total - o.refunded_amount > 0 && !["refunded"].includes(o.payment_status);
  const closed = ["cancelled", "returned"].includes(o.status);
  const sh = o.shipment || {};
  const mgO = can("orders.manage"), mgR = can("orders.refund");
  const c = o.customer;
  const ok = ctx.set(`<div class="ph"><div><div class="crumb"><a href="#/orders">Orders</a> /</div><h2 class="mono" style="font-family:Anton">${esc(o.order_number)}</h2>
    <div class="meta">${badge(ORDER_ST, o.status)} ${badge(PAY_ST, o.payment_status)} <span>Placed ${fdt(o.created_at)}</span>${paid ? `<span>· Paid ${fdt(o.paid_at)}</span>` : ""}</div></div>
    <div class="acts">${paid ? `<a class="btn sm" href="/api/admin/orders/${encodeURIComponent(o.order_number)}/invoice" target="_blank" rel="noopener">Download invoice</a>` : ""}
    ${mgO && (o.status === "pending_payment" || o.payment_status === "failed") ? `<button class="btn sm" id="orec">Check payment with Razorpay</button>` : ""}
    ${mgR && !closed ? `<button class="btn sm dg" id="ocancel">Cancel order</button>` : ""}</div></div>
  ${o.status === "cancelled" && o.cancel_reason ? `<div class="errbox">Cancelled ${fdt(o.cancelled_at)}: ${esc(o.cancel_reason)}</div>` : ""}
  ${o.status === "pending_payment" ? `<div class="infobox">This checkout hasn't been paid yet${o.reservation_expires_at ? `; stock is reserved until ${fdt(o.reservation_expires_at)}` : ""}. If the customer says they paid, use <b>Check payment with Razorpay</b>.</div>` : ""}
  <div class="cols"><div>
    <div class="pn flush"><div class="pnh"><h3>Items</h3><span class="sub2">${plural(o.items.reduce((a, i) => a + i.quantity, 0), "unit")}</span></div><div class="tw"><table class="tbl"><thead><tr><th></th><th>Product</th><th class="r">Unit price</th><th class="r">Qty</th><th class="r">Total</th></tr></thead><tbody>
      ${o.items.map((i) => `<tr><td class="thumb">${i.image_url ? `<img src="${esc(i.image_url)}" alt="">` : `<div class="ph0">IMG</div>`}</td><td>${i.product_id && can("products.manage", "products.content") ? `<a class="lk" href="#/products/${i.product_id}">${esc(i.product_name)}</a>` : esc(i.product_name)}${i.flavour ? `<div class="sub2">${esc(i.flavour)}</div>` : ""}</td>
        <td class="r nwr">${inr(i.unit_price)}${i.unit_mrp > i.unit_price ? `<div class="sub2" style="text-decoration:line-through">${inr(i.unit_mrp)}</div>` : ""}</td><td class="r">${num(i.quantity)}</td><td class="r nwr">${inr(i.line_total)}${i.line_discount ? `<div class="sub2">−${inr(i.line_discount)} coupon</div>` : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <div style="padding:12px 16px;border-top:1px solid var(--ln)"><dl class="kv" style="max-width:360px;margin-left:auto;grid-template-columns:1fr auto">
      <dt>Subtotal</dt><dd class="r">${inr(o.subtotal)}</dd>${o.mrp_total > o.subtotal ? `<dt>MRP total</dt><dd class="r muted">${inr(o.mrp_total)}</dd>` : ""}
      <dt>Coupon${o.coupon_code ? ` <code>${esc(o.coupon_code)}</code>` : ""}</dt><dd class="r">${o.discount ? "−" + inr(o.discount) : "—"}</dd>
      <dt>Shipping</dt><dd class="r">${o.shipping_fee ? inr(o.shipping_fee) : "Free"}</dd>
      <dt class="strong" style="color:#fff">Total</dt><dd class="r strong">${inr(o.total)}</dd>
      ${o.refunded_amount ? `<dt>Refunded</dt><dd class="r red">−${inr(o.refunded_amount)}</dd><dt>Net</dt><dd class="r">${inr(o.total - o.refunded_amount)}</dd>` : ""}
    </dl></div></div>
    ${o.notes ? `<div class="pn"><h3>Customer note</h3><p style="margin:0;white-space:pre-wrap">${esc(o.notes)}</p></div>` : ""}
    <div class="pn flush"><div class="pnh"><h3>Payments</h3></div>${o.payments.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Razorpay IDs</th><th>Status</th><th>Method</th><th class="r">Amount</th><th>When</th></tr></thead><tbody>
      ${o.payments.map((p) => `<tr><td><div class="mono">Order: ${esc(p.razorpay_order_id || "—")}</div><div class="mono">Payment: ${esc(p.razorpay_payment_id || "—")}</div>${p.error_code || p.error_description ? `<div class="red" style="font-size:12px">${esc(p.error_code || "")} ${esc(p.error_description || "")}</div>` : ""}</td>
        <td>${badge(PAY_ST, p.status)}${p.verified_via ? `<div class="sub2">via ${esc(p.verified_via)}</div>` : ""}</td><td>${esc(p.method || "—")}</td><td class="r nwr">${inr(p.amount)}</td><td class="nwr sub2">${fdt(p.paid_at || p.created_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No payment attempts yet")}</div>
    <div class="pn flush"><div class="pnh"><h3>Refunds</h3>${mgR && refundable ? `<button class="btn sm" id="orefund">Issue refund</button>` : ""}</div>${o.refunds.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Refund ID</th><th>Reason</th><th>Status</th><th class="r">Amount</th><th>When</th></tr></thead><tbody>
      ${o.refunds.map((r) => `<tr><td class="mono">${esc(r.razorpay_refund_id || "—")}</td><td>${esc(r.reason || "")}</td><td><span class="bd ${/fail/.test(r.status) ? "er" : /process/.test(r.status) ? "ok" : "wn"}">${esc(r.status)}</span></td><td class="r nwr">${inr(r.amount)}</td><td class="nwr sub2">${fdt(r.created_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No refunds")}</div>
    <div class="pn"><h3>Status history</h3>${o.history.length ? `<ul class="tline">${o.history.slice().reverse().map((h) => `<li><b>${esc(ORDER_ST[h.status] ? ORDER_ST[h.status][0] : h.status.replace(/_/g, " "))}</b><small>${fdt(h.created_at)} · ${esc(h.actor_type || "system")}</small>${h.note ? `<p>${esc(h.note)}</p>` : ""}</li>`).join("")}</ul>` : empty("No history yet")}</div>
  </div>
  <div>
    <div class="pn"><div class="pnh"><h3>Customer</h3>${c && can("customers.view") ? `<a class="lk" href="#/customers/${c.id}">Profile →</a>` : ""}</div>
      ${c ? `<dl class="kv"><dt>Name</dt><dd>${esc(c.name)}</dd><dt>Email</dt><dd><a class="lk" href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd><dt>Phone</dt><dd>${esc(c.phone || "—")}</dd><dt>Since</dt><dd>${fd(c.created_at)}</dd><dt>Paid orders</dt><dd>${num(c.orders)}</dd><dt>Total spent</dt><dd>${inr(c.spent)}</dd></dl>` : `<p class="sub2">Order email: ${esc(o.customer_email)}</p>`}</div>
    <div class="pn"><h3>Shipping address</h3><div class="adr"><b>${esc(o.ship_name)}</b><br>${esc(o.ship_line1)}${o.ship_line2 ? "<br>" + esc(o.ship_line2) : ""}<br>${esc(o.ship_city)}, ${esc(o.ship_state)} ${esc(o.ship_pincode)}<br>Phone: <a class="lk" href="tel:${esc(o.ship_phone)}">${esc(o.ship_phone)}</a><br>${esc(o.customer_email)}</div></div>
    ${mgO && paid && !closed ? `<form class="pn" id="ostf" novalidate><h3>Update status</h3>${fld({ n: "status", l: "New status", t: "select", v: o.fulfilment_statuses.some((s) => s.value === o.status) ? o.status : "", opts: [["", "Choose…"], ...o.fulfilment_statuses.map((s) => [s.value, s.label])] })}
      ${fld({ n: "note", l: "Note (shown to customer)", t: "area", rows: 2, max: 500 })}<button class="btn sm p" type="submit">Update status</button>
      ${["shipped", "out_for_delivery", "delivered"].includes(o.status) ? `<button class="btn sm" type="button" id="oret" style="margin-left:6px">Mark returned</button>` : ""}</form>` : ""}
    <form class="pn" id="oshf" novalidate><h3>Shipment</h3>
      <div class="g2">${fld({ n: "courier", l: "Courier", v: sh.courier, max: 80, dis: !mgO, ph: "e.g. Delhivery" })}${fld({ n: "tracking_id", l: "Tracking ID", v: sh.tracking_id, max: 120, dis: !mgO })}</div>
      ${fld({ n: "tracking_url", l: "Tracking URL", t: "url", v: sh.tracking_url, max: 500, dis: !mgO, ph: "https://…" })}
      <div class="g2">${fld({ n: "status", l: "Shipment status", v: sh.status, max: 40, dis: !mgO, ph: "e.g. In transit" })}${fld({ n: "estimated_delivery", l: "Estimated delivery", t: "date", v: dateInput(sh.estimated_delivery), dis: !mgO })}</div>
      ${fld({ n: "notes", l: "Notes", t: "area", v: sh.notes, rows: 2, max: 500, dis: !mgO })}
      ${mgO ? `<button class="btn sm p" type="submit">Save shipment</button><div class="hint">Adding a tracking ID notifies the customer.</div>` : ""}</form>
  </div></div>`);
  if (!ok) return;
  const N = encodeURIComponent(o.order_number);
  const stf = $("#ostf");
  stf && stf.addEventListener("submit", async (e) => {
    e.preventDefault(); const v = vals(stf);
    if (!v.status) return toast("Choose a status", true);
    if (await act($("button[type=submit]", stf), () => POST(`/orders/${N}/status`, v), "Status updated")) ctx.reload();
  });
  const shf = $("#oshf");
  shf.addEventListener("submit", async (e) => {
    e.preventDefault(); const v = vals(shf);
    if (v.tracking_url && !/^https:\/\//i.test(v.tracking_url)) return toast("Tracking URL must start with https://", true);
    if (await act($("button[type=submit]", shf), () => PUT(`/orders/${N}/shipment`, v), "Shipment saved")) ctx.reload();
  });
  const ret = $("#oret");
  ret && ret.addEventListener("click", async () => {
    const r = await modal({ title: "Mark as returned", ok: "Mark returned", danger: true, body: `<p>Marks <b>${esc(o.order_number)}</b> as returned. Issue any refund separately from the Refunds panel.</p>${fld({ n: "note", l: "Note", t: "area", rows: 2, max: 500 })}`,
      onOk: (f) => POST(`/orders/${N}/return`, vals(f)) });
    if (r) { toast("Order marked as returned"); ctx.reload(); }
  });
  const cn = $("#ocancel");
  cn && cn.addEventListener("click", async () => {
    const msg = paid ? `<p>Cancelling a paid order <b>automatically refunds the remaining ${inr(o.total - o.refunded_amount)}</b> to the customer through Razorpay and returns the stock.</p>` : `<p>This order isn't paid. Cancelling releases the reserved stock.</p>`;
    const r = await modal({ title: "Cancel order " + o.order_number, ok: "Cancel order", cancel: "Keep order", danger: true, body: msg + fld({ n: "reason", l: "Reason", req: true, max: 200, ph: "e.g. Customer request, out of stock" }),
      onOk: (f) => POST(`/orders/${N}/cancel`, vals(f)) });
    if (r) { toast(r.refund_error ? "Order cancelled, but the refund failed: " + r.refund_error : "Order cancelled", !!r.refund_error); ctx.reload(); }
  });
  const rf = $("#orefund");
  rf && rf.addEventListener("click", async () => {
    const remaining = o.total - o.refunded_amount;
    const r = await modal({ title: "Refund " + o.order_number, ok: "Issue refund", danger: true, body: `<p>Refunded so far: ${inr(o.refunded_amount)} · Remaining: <b>${inr(remaining)}</b>. The refund goes back to the customer's original payment method via Razorpay.</p>
      ${fld({ n: "amount", l: "Amount (₹)", t: "number", min: 0, step: "0.01", ph: `Blank = full remaining (${rup(remaining)})`, hint: "Leave blank for a full refund of the remaining amount." })}${fld({ n: "reason", l: "Reason", req: true, max: 200 })}`,
      onOk: (f) => { const v = vals(f); if (v.amount !== "" && (Number(v.amount) <= 0 || Math.round(Number(v.amount) * 100) > remaining)) throw new Error(`Amount must be between ₹0.01 and ${inr(remaining)}`); return POST(`/orders/${N}/refund`, v); } });
    if (r) { toast(`Refund of ${inr(r.amount)} issued`); ctx.reload(); }
  });
  const rec = $("#orec");
  rec && rec.addEventListener("click", async () => {
    const r = await act(rec, () => POST(`/orders/${N}/reconcile`));
    if (r) { toast(r.changed ? "Payment status updated from Razorpay" : "No change: Razorpay has no successful payment for this order"); if (r.changed) ctx.reload(); }
  });
});
