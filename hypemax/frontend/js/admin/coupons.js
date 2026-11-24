/* Coupons list, editor (with product/category restrictions) and usage history */
"use strict";
const couponValue = (c) => (c.discount_type === "percent" ? `${c.discount_value}% off${c.max_discount ? ` (max ${inr(c.max_discount)})` : ""}` : `${inr(c.discount_value)} off`);
function couponState(c) {
  const now = Date.now();
  if (!c.is_active) return ["Inactive", "mu"];
  if (c.starts_at && new Date(c.starts_at) > now) return ["Scheduled", "in"];
  if (c.expires_at && new Date(c.expires_at) <= now) return ["Expired", "er"];
  if (c.usage_limit && Number(c.used) >= c.usage_limit) return ["Used up", "wn"];
  return ["Live", "ok"];
}

route("coupons", ["coupons.manage"], async (ctx) => {
  const rows = await GET("/coupons");
  const ok = ctx.set(`<div class="ph"><div><h2>Coupons</h2><div class="meta">${plural(rows.length, "coupon")}</div></div><div class="acts"><a class="btn p" href="#/coupons/new">+ Create coupon</a></div></div>
  <div class="pn flush">${rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Code</th><th>Discount</th><th class="r">Min order</th><th>Limits</th><th>Validity (IST)</th><th class="r">Used</th><th class="r">Discount given</th><th class="r">Customers</th><th>Active</th></tr></thead><tbody>
    ${rows.map((c) => { const st = couponState(c); return `<tr class="clk" data-href="#/coupons/${c.id}"><td><a class="mono strong" href="#/coupons/${c.id}">${esc(c.code)}</a> <span class="bd ${st[1]}">${st[0]}</span>${c.description ? `<div class="sub2">${esc(c.description)}</div>` : ""}</td>
      <td class="nwr">${esc(couponValue(c))}</td><td class="r nwr">${c.min_order_value ? inr(c.min_order_value) : "—"}</td>
      <td class="nwr sub2">${c.usage_limit ? `${num(c.usage_limit)} total` : "Unlimited"}<br>${c.per_customer_limit ? `${num(c.per_customer_limit)} per customer` : "No per-customer limit"}</td>
      <td class="nwr sub2">${c.starts_at ? "From " + fdt(c.starts_at) : "From creation"}<br>${c.expires_at ? "Until " + fdt(c.expires_at) : "No expiry"}</td>
      <td class="r">${num(c.used)}${Number(c.reserved) ? `<div class="sub2">+${num(c.reserved)} reserved</div>` : ""}</td><td class="r nwr">${inr(c.total_discount)}</td><td class="r">${num(c.customers)}</td>
      <td>${sw(`data-cact="${c.id}" aria-label="Active"`, c.is_active)}</td></tr>`; }).join("")}
  </tbody></table></div>` : empty("No coupons yet")}</div>`);
  if (!ok) return;
  bindRowLinks(ctx.view);
  $$("[data-cact]", ctx.view).forEach((cb) => cb.addEventListener("change", async () => {
    try { await POST(`/coupons/${cb.dataset.cact}/active`, { is_active: cb.checked }); toast(cb.checked ? "Coupon activated" : "Coupon deactivated"); ctx.reload(); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  }));
});

route("coupons/:id", ["coupons.manage"], async (ctx) => {
  const isNew = ctx.params.id === "new";
  const [c, prods, cats] = await Promise.all([isNew ? null : GET("/coupons/" + encodeURIComponent(ctx.params.id)), GET("/products").catch(() => []), GET("/categories").catch(() => [])]);
  const C = c || { discount_type: "percent", is_active: 1, product_ids: [], category_ids: [] };
  const pids = new Set((C.product_ids || []).map(String)), cids = new Set((C.category_ids || []).map(String));
  const st = c ? couponState({ ...c, used: c.stats.uses }) : null;
  const ok = ctx.set(`<div class="ph"><div><div class="crumb"><a href="#/coupons">Coupons</a> /</div><h2>${isNew ? "New coupon" : esc(C.code)}</h2>${st ? `<div class="meta"><span class="bd ${st[1]}">${st[0]}</span> Created ${fdt(C.created_at)}</div>` : ""}</div>
    <div class="acts">${!isNew ? `<button class="btn sm" id="ctog">${C.is_active ? "Deactivate" : "Activate"}</button><button class="btn sm dg" id="cdel">Delete</button>` : ""}</div></div>
  ${!isNew ? `<div class="kgrid" style="margin-bottom:16px">${kpi("Times used", num(c.stats.uses))}${kpi("Discount given", inr(c.stats.discount), { cls: "hl" })}${kpi("Unique customers", num(c.stats.customers))}</div>` : ""}
  <div class="cols"><form class="pn" id="cpf" novalidate><h3>Coupon</h3>
    <div class="g2">${fld({ n: "code", l: "Code", v: C.code, req: true, max: 40, ph: "e.g. WELCOME10", hint: "3–40 letters, numbers, dashes or underscores. Saved in capitals.", attrs: 'style="text-transform:uppercase"' })}
    ${fld({ n: "description", l: "Description", v: C.description, max: 255, ph: "Shown to customers", hint: "Optional, e.g. 10% off your first order" })}</div>
    <div class="g3">${fld({ n: "discount_type", l: "Type", t: "select", v: C.discount_type, opts: [["percent", "Percentage (%)"], ["fixed", "Fixed amount (₹)"]] })}
    ${fld({ n: "discount_value", l: "Value", t: "number", v: C.discount_type === "fixed" ? rup(C.discount_value) : C.discount_value, req: true, min: 0, step: "0.01" })}
    ${fld({ n: "max_discount", l: "Max discount (₹)", t: "number", v: rup(C.max_discount), min: 0, step: "0.01", hint: "Optional cap for % coupons" })}</div>
    <div class="g3">${fld({ n: "min_order_value", l: "Min order value (₹)", t: "number", v: rup(C.min_order_value) || "", min: 0, step: "0.01", ph: "0" })}
    ${fld({ n: "usage_limit", l: "Total usage limit", t: "number", v: C.usage_limit ?? "", min: 1, step: "1", ph: "Unlimited" })}
    ${fld({ n: "per_customer_limit", l: "Per customer limit", t: "number", v: C.per_customer_limit ?? "", min: 1, step: "1", ph: "Unlimited" })}</div>
    <div class="g2">${fld({ n: "starts_at", l: "Starts (IST)", t: "datetime-local", v: toIstInput(C.starts_at), hint: "Blank = active immediately" })}${fld({ n: "expires_at", l: "Expires (IST)", t: "datetime-local", v: toIstInput(C.expires_at), hint: "Blank = never expires" })}</div>
    <div class="g2"><div class="fld"><label>Only for these products</label><div class="chk-list">${prods.length ? prods.map((p) => `<label class="ck"><input type="checkbox" name="product_ids" data-arr value="${p.id}"${pids.has(String(p.id)) ? " checked" : ""}> ${esc(p.name)} <span class="sub2">${esc(PROD_ST[p.status] ? PROD_ST[p.status][0] : p.status)}</span></label>`).join("") : '<span class="sub2">No products</span>'}</div></div>
    <div class="fld"><label>Only for these categories</label><div class="chk-list">${cats.length ? cats.map((k) => `<label class="ck"><input type="checkbox" name="category_ids" data-arr value="${k.id}"${cids.has(String(k.id)) ? " checked" : ""}> ${esc(k.name)}</label>`).join("") : '<span class="sub2">No categories</span>'}</div></div></div>
    <div class="hint" style="margin:-4px 0 10px">Leave both lists empty for a store-wide coupon. If you pick products or categories, the discount applies only to matching cart items.</div>
    ${fld({ n: "is_active", l: "Active", t: "check", v: !!C.is_active })}
    <button class="btn p" type="submit">${isNew ? "Create coupon" : "Save coupon"}</button></form>
  <div>${!isNew ? `<div class="pn flush"><div class="pnh"><h3>Usage history</h3><span class="sub2">${plural(c.usages.length, "use")}</span></div>${c.usages.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Customer</th><th>Order</th><th class="r">Discount</th><th>Status</th><th>Date</th></tr></thead><tbody>
    ${c.usages.map((u) => `<tr><td>${can("customers.view") ? `<a class="lk" href="#/customers/${u.user_id}">${esc(u.name)}</a>` : esc(u.name)}<div class="sub2">${esc(u.email)}</div></td><td>${can("orders.view") ? `<a class="lk mono" href="#/orders/${esc(u.order_number)}">${esc(u.order_number)}</a>` : `<span class="mono">${esc(u.order_number)}</span>`}<div class="sub2">${inr(u.total)}</div></td><td class="r nwr">${inr(u.discount_amount)}</td><td><span class="bd ${u.status === "used" ? "ok" : u.status === "reserved" ? "wn" : "mu"}">${esc(u.status)}</span></td><td class="nwr sub2">${fdt(u.created_at)}</td></tr>`).join("")}
    </tbody></table></div>` : empty("Not used yet")}</div>` : `<div class="pn"><h3>Tips</h3><p class="sub2" style="margin:0">Percentage coupons take a whole number from 1 to 100. Fixed coupons take a rupee amount. Reserved uses are held by unpaid checkouts and are released if payment doesn't complete.</p></div>`}</div></div>`);
  if (!ok) return;
  const f = $("#cpf");
  const typeSel = f.elements.discount_type, maxF = f.elements.max_discount, valF = f.elements.discount_value;
  const syncType = () => { const pctT = typeSel.value === "percent"; maxF.disabled = !pctT; valF.step = pctT ? "1" : "0.01"; valF.max = pctT ? "100" : ""; valF.placeholder = pctT ? "e.g. 10 (%)" : "e.g. 200 (₹)"; };
  typeSel.addEventListener("change", syncType); syncType();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = vals(f);
    v.code = v.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,40}$/.test(v.code)) return toast("Code must be 3–40 letters, numbers, dashes or underscores", true);
    if (v.discount_type === "percent" && !(Number.isInteger(+v.discount_value) && +v.discount_value >= 1 && +v.discount_value <= 100)) return toast("Percentage must be a whole number from 1 to 100", true);
    if (!(+v.discount_value > 0)) return toast("Enter a discount value", true);
    const body = { ...v, max_discount: v.discount_type === "percent" ? v.max_discount || "" : "", starts_at: fromIstInput(v.starts_at), expires_at: fromIstInput(v.expires_at), product_ids: v.product_ids || [], category_ids: v.category_ids || [] };
    if (body.starts_at && body.expires_at && body.expires_at <= body.starts_at) return toast("Expiry must be after the start", true);
    const r = await act($("button[type=submit]", f), () => (isNew ? POST("/coupons", body) : PUT("/coupons/" + C.id, body)), isNew ? "Coupon created" : "Coupon saved");
    if (r) isNew ? go("coupons/" + r.id) : ctx.reload();
  });
  if (isNew) return;
  $("#ctog").addEventListener("click", async (e) => { if (await act(e.currentTarget, () => POST(`/coupons/${C.id}/active`, { is_active: !C.is_active }), C.is_active ? "Coupon deactivated" : "Coupon activated")) ctx.reload(); });
  $("#cdel").addEventListener("click", async (e) => {
    if (!(await confirmBox(`Delete coupon <b>${esc(C.code)}</b>? Coupons that have been used can't be deleted; deactivate them instead.`))) return;
    if (await act(e.currentTarget, () => DEL("/coupons/" + C.id), "Coupon deleted")) go("coupons");
  });
});
