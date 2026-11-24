/* Cart (/cart) and Checkout (/checkout). Every amount shown comes from the server's pricing engine. */
window.HM_PAGE = async function () {
  const { $, $$, esc, api, inr, img, toast, busy, me, loginUrl, config, site, waLink, track, store } = HM;
  const page = document.body.dataset.page;
  let coupon = store.sget("hm_coupon", "") || "";
  const setCoupon = (c) => { coupon = c || ""; store.sset("hm_coupon", coupon || null); };
  const getCart = () => api("/api/cart" + (coupon ? "?coupon=" + encodeURIComponent(coupon) : ""));

  const summary = (c, { showCoupon = true } = {}) => `
    <h3 style="margin-bottom:10px">Order summary</h3>
    <div class="sumrow"><span>Total MRP</span><span>${inr(c.mrp_total)}</span></div>
    ${c.savings_on_mrp ? `<div class="sumrow"><span>Discount on MRP</span><span class="neg">− ${inr(c.savings_on_mrp)}</span></div>` : ""}
    ${c.coupon ? `<div class="sumrow"><span>Coupon (${esc(c.coupon.code)})</span><span class="neg">− ${inr(c.discount)}</span></div>` : ""}
    <div class="sumrow"><span>Shipping</span><span>${c.shipping ? inr(c.shipping) : '<span class="neg">FREE</span>'}</span></div>
    <div class="sumrow tot"><span>Total</span><span>${inr(c.total)}</span></div>
    ${c.savings_on_mrp + c.discount > 0 ? `<p class="okmsg" style="margin-top:6px">You save ${inr(c.savings_on_mrp + c.discount)} on this order</p>` : ""}
    ${showCoupon ? `<div style="margin-top:16px">${c.coupon ? `<div class="applied"><span><b>${esc(c.coupon.code)}</b> applied${c.coupon.description ? " · " + esc(c.coupon.description) : ""}</span><button class="btn ghost sm" id="rmc" type="button">Remove</button></div>`
      : `<form class="coupon" id="cpf"><input name="code" placeholder="Coupon code" aria-label="Coupon code" maxlength="40" value="${esc(c.coupon_error ? coupon : "")}" autocomplete="off"><button class="btn sm">Apply</button></form>${c.coupon_error ? `<p class="err" style="margin-top:6px">${esc(c.coupon_error.message)}</p>` : ""}`}</div>` : ""}`;

  function wireCoupon(rerender) {
    const f = $("#cpf"), r = $("#rmc");
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const code = f.code.value.trim().toUpperCase();
      if (!code) return;
      setCoupon(code);
      const c = await busy(f.querySelector("button"), () => getCart());
      rerender(c); // renders the server's verdict (and keeps the typed code next to any error)
      if (c.coupon) toast(`Coupon applied: you save ${inr(c.discount)}`, "ok");
      else setCoupon("");
    };
    if (r) r.onclick = async () => { setCoupon(""); rerender(await getCart()); toast("Coupon removed"); };
  }

  // ======================= CART =======================
  if (page === "cart") {
    if (!(await me())) {
      // Carts belong to signed-in customers only (enforced by the API as well).
      $("#app").innerHTML = `<div class="wrap pg empty"><h3>Log in to see your cart</h3><p>Your cart is saved to your HYPEMAX account, so it follows you across devices.</p>
        <p style="margin-top:16px"><a class="btn p" href="${esc(loginUrl("/cart"))}">Log in</a> <a class="btn" href="/register?next=%2Fcart">Create account</a></p></div>`;
      return;
    }
    const render = (c) => {
      HM.refreshCartCount(c);
      if (!c.lines.length) {
        $("#app").innerHTML = `<div class="wrap pg empty"><h3>Your cart is empty</h3><p>Fuel your next session.</p><p style="margin-top:16px"><a class="btn p" href="/products">Shop products</a></p></div>`;
        return;
      }
      $("#app").innerHTML = `<div class="wrap pg"><h1>Your cart <span class="muted" style="font:500 1rem Inter">(${c.count} item${c.count === 1 ? "" : "s"})</span></h1>
      <div class="cart" style="margin-top:16px"><div>
        ${c.problems.length ? `<div class="notice warn" style="margin-bottom:10px">${c.problems.map((x) => esc(x.message)).join("<br>")}</div>` : ""}
        ${c.lines.map((l) => `<div class="cl" data-pid="${l.product_id}" data-fl="${esc(l.flavour)}">
          <a href="/products/${esc(l.slug)}">${l.image ? img(l.image, l.name, { w: 200, sizes: "84px" }) : '<div style="width:84px;height:84px;background:#111;border-radius:8px"></div>'}</a>
          <div><a class="nm" href="/products/${esc(l.slug)}">${esc(l.name)}</a><div class="meta">${l.flavour ? esc(l.flavour) + " · " : ""}${inr(l.unit_price)} each${l.unit_mrp > l.unit_price ? ` <s>${inr(l.unit_mrp)}</s>` : ""}</div>
            ${l.purchasable ? "" : '<div class="err" style="margin:4px 0 0">Unavailable: remove to continue</div>'}
            <div class="row" style="margin-top:8px;gap:12px"><div class="qty" style="height:34px"><button data-d="-1" aria-label="Decrease">−</button><input value="${l.quantity}" readonly aria-label="Quantity"><button data-d="1" aria-label="Increase">+</button></div><button class="rm" data-rm>Remove</button></div></div>
          <div class="cr" style="text-align:right"><b>${inr(l.line_total)}</b>${l.line_mrp > l.line_total ? `<div class="tiny muted"><s>${inr(l.line_mrp)}</s></div>` : ""}</div></div>`).join("")}
        <p style="margin-top:14px"><a class="link" href="/products">← Continue shopping</a></p></div>
      <aside class="card sumbox">${summary(c)}<a class="btn p block lg" style="margin-top:16px" id="go" href="/checkout">Proceed to checkout</a>
        <p class="tiny muted" style="margin-top:10px;text-align:center">Prices and coupons are verified again at checkout.</p></aside></div></div>`;
      wireCoupon(render);
      $("#go").onclick = async (e) => { if (c.problems.length) { e.preventDefault(); toast("Remove unavailable items first", "er"); return; } if (!(await me())) { e.preventDefault(); location.href = loginUrl("/checkout"); } };
      $$(".cl").forEach((row) => {
        const pid = +row.dataset.pid, flv = row.dataset.fl, q = +row.querySelector("input").value;
        row.querySelectorAll("[data-d]").forEach((b) => (b.onclick = async () => {
          const n = q + +b.dataset.d;
          if (n < 1) return;
          try { render(await busy(b, () => api("/api/cart/items", { method: "PATCH", body: { product_id: pid, flavour: flv, quantity: n, coupon } }))); }
          catch (x) { if (x.status === 401) location.href = loginUrl("/cart"); }
        }));
        row.querySelector("[data-rm]").onclick = async (e) => {
          try { render(await busy(e.currentTarget, () => api("/api/cart/items", { method: "DELETE", body: { product_id: pid, flavour: flv, coupon } }))); }
          catch (x) { if (x.status === 401) location.href = loginUrl("/cart"); }
        };
      });
    };
    return render(await getCart());
  }

  // ======================= CHECKOUT =======================
  const user = await me();
  if (!user) { location.replace(loginUrl("/checkout")); return; }
  const [cfg, S] = await Promise.all([config(), site()]);
  let cart = await getCart();
  if (!cart.lines.length) { location.replace("/cart"); return; }
  track("checkout_start");
  let addresses = await api("/api/account/addresses");
  let selected = (addresses.find((a) => a.is_default) || addresses[0] || {}).id || null;
  const payOn = cfg.features && cfg.features.payments;

  // The new-address form always has its own Save button (BUG-010: on a first checkout it had none, so the name
  // and mobile number typed there could never be saved and Pay refused to continue). Pay also saves it.
  const addrForm = () => `<form id="naf" class="fg" style="margin-top:6px" autocomplete="on" novalidate>${HM.addressFields({}, user)}
    <div style="display:flex;align-items:end"><label class="check"><input type="checkbox" name="save" checked> Save to my addresses</label></div>
    <div class="full row"><button class="btn sm p">Use this address</button>${addresses.length ? '<button type="button" class="btn sm" id="cancelNew">Cancel</button>' : ""}</div>
    <div class="full" id="nafmsg"></div></form>`;

  /** Validate (field by field) and save the new address. Returns true when an address is selected. */
  async function saveNewAddress(btn) {
    const f = $("#naf");
    $("#nafmsg").innerHTML = "";
    if (!HM.validateForm(f, HM.addressRules())) return false;
    const d = Object.fromEntries(new FormData(f));
    try {
      const a = await busy(btn, () => api("/api/account/addresses", { method: "POST", body: d }));
      addresses = await api("/api/account/addresses"); selected = a.id; addingNew = false; renderAddr();
      return true;
    } catch (x) {
      if (!HM.showServerError(f, x)) $("#nafmsg").innerHTML = `<div class="notice bad">${esc(x.message)}</div>`;
      return false;
    }
  }

  let addingNew = !addresses.length;
  function renderAddr() {
    $("#addr").innerHTML = addingNew ? addrForm() :
      addresses.map((a) => `<label class="addr ${a.id === selected ? "on" : ""}"><input type="radio" name="addr" value="${a.id}" ${a.id === selected ? "checked" : ""} class="sr">
        <b>${esc(a.name)}</b> ${a.label ? `<span class="tag grey">${esc(a.label)}</span>` : ""}<br>${esc(a.line1)}${a.line2 ? ", " + esc(a.line2) : ""}, ${esc(a.city)}, ${esc(a.state)} - ${esc(a.pincode)}<br><span class="muted">Phone: ${esc(a.phone)}</span></label>`).join("") +
      `<button class="btn sm" type="button" id="addNew">+ Add a new address</button>`;
    if (addingNew) {
      $("#naf").onsubmit = (e) => { e.preventDefault(); saveNewAddress(e.target.querySelector(".btn.p")); };
      const c = $("#cancelNew"); if (c) c.onclick = () => { addingNew = false; renderAddr(); };
    } else {
      $$("#addr input[name=addr]").forEach((r) => (r.onchange = () => { selected = +r.value; renderAddr(); }));
      $("#addNew").onclick = () => { addingNew = true; renderAddr(); };
    }
  }

  function renderSummary(c) {
    cart = c;
    $("#sum").innerHTML = `${c.lines.map((l) => `<div class="row" style="gap:10px;flex-wrap:nowrap;margin-bottom:10px">${l.image ? img(l.image, l.name, { w: 120, sizes: "48px", attrs: 'style="width:48px;height:48px;object-fit:cover;border-radius:6px"' }) : ""}<div style="flex:1;font-size:.86rem"><b>${esc(l.name)}</b><div class="muted tiny">${l.flavour ? esc(l.flavour) + " · " : ""}Qty ${l.quantity}</div></div><b style="font-size:.88rem">${inr(l.line_total)}</b></div>`).join("")}
      ${c.problems.length ? `<div class="notice warn" style="margin:8px 0">${c.problems.map((x) => esc(x.message)).join("<br>")} <a class="link" href="/cart">Edit cart</a></div>` : ""}
      <hr style="border:0;border-top:1px solid var(--line);margin:10px 0">${summary(c)}`;
    wireCoupon(renderSummary);
    $("#pay").textContent = payOn ? `Pay ${inr(c.total)} securely` : "Online payment unavailable";
  }

  $("#app").innerHTML = `<div class="wrap pg"><div class="steps"><a href="/cart">Cart</a> › <b>Address &amp; payment</b> › Confirmation</div><h1>Checkout</h1>
  ${payOn ? "" : `<div class="notice warn" style="margin-top:12px">Online payments are being set up. You can still place your order on WhatsApp and our team will confirm payment and delivery with you. <a class="link" id="waorder" target="_blank" rel="noopener" href="#">Order on WhatsApp →</a></div>`}
  <div class="cart" style="margin-top:16px"><div>
    <div class="card"><h3 style="margin-bottom:10px">1. Delivery address</h3><div id="addr"></div></div>
    <div class="card" style="margin-top:14px"><h3 style="margin-bottom:6px">2. Order notes <span class="muted small" style="font-family:Inter;text-transform:none">(optional)</span></h3><textarea id="notes" rows="2" maxlength="500" placeholder="Delivery instructions"></textarea></div>
    <div class="card" style="margin-top:14px"><h3 style="margin-bottom:6px">3. Payment</h3><p class="muted small">Pay with UPI, cards, net banking or wallets via Razorpay. Your order is confirmed only after the payment is verified.</p></div>
  </div>
  <aside class="card sumbox"><div id="sum"></div><button class="btn p block lg" style="margin-top:16px" id="pay" ${payOn ? "" : "disabled"}>Pay</button>
    <p class="tiny muted" style="margin-top:10px;text-align:center">Logged in as ${esc(user.email)}</p><div id="payerr"></div></aside></div></div>`;
  renderAddr(); renderSummary(cart);

  if (!payOn) {
    $("#waorder").href = waLink(S.settings, `Hello HYPEMAX Team!\n\nI'd like to order:\n${cart.lines.map((l) => `- ${l.name}${l.flavour ? " (" + l.flavour + ")" : ""} x${l.quantity}`).join("\n")}\nTotal: ${inr(cart.total)}\n\nName: ${user.name}\nEmail: ${user.email}`);
    return;
  }

  // ----- Razorpay flow -----
  const showErr = (html) => ($("#payerr").innerHTML = html ? `<div class="notice bad" style="margin-top:12px">${html}</div>` : "");
  function openRazorpay(o) {
    return new Promise((resolve) => {
      if (!window.Razorpay) { showErr("The payment window could not load. Check your connection or disable ad-blockers, then try again."); return resolve("noscript"); }
      const rz = new window.Razorpay({
        key: o.razorpay.key, order_id: o.razorpay.order_id, amount: o.razorpay.amount, currency: o.razorpay.currency,
        name: o.razorpay.name, description: o.razorpay.description, image: location.origin + "/img/logo.png",
        prefill: o.razorpay.prefill, theme: { color: "#ff2525" }, retry: { enabled: true, max_count: 3 },
        handler: async (resp) => {
          showErr("");
          $("#pay").classList.add("busy"); $("#pay").textContent = "Verifying payment…";
          try {
            await api("/api/checkout/verify", { method: "POST", body: resp });
            setCoupon("");
            location.replace(`/account/orders/${encodeURIComponent(o.order_number)}?placed=1`);
          } catch (e) {
            // The webhook may still confirm it; send the customer to the order page either way.
            showErr(`We couldn't verify your payment yet (${esc(e.message)}). If money was debited, it will be confirmed automatically within a few minutes. <a class="link" href="/account/orders/${esc(o.order_number)}">View order</a>`);
            $("#pay").classList.remove("busy");
          }
          resolve("paid");
        },
        modal: { ondismiss: () => resolve("dismissed"), escape: true, confirm_close: true },
      });
      rz.on("payment.failed", (r) => {
        const er = (r && r.error) || {};
        api(`/api/checkout/${encodeURIComponent(o.order_number)}/failed`, { method: "POST", body: { error: { code: er.code, description: er.description } } }).catch(() => {});
        showErr(`Payment failed: ${esc(er.description || "please try again")}. You can retry from the payment window or choose another method.`);
      });
      rz.open();
    });
  }

  let pending = store.sget("hm_pending_order", null);
  $("#pay").onclick = async (e) => {
    const btn = e.currentTarget;
    showErr("");
    if (addingNew && !(await saveNewAddress(btn))) { toast("Check the highlighted address fields", "er"); return; }
    if (!selected) { toast("Choose a delivery address", "er"); return; }
    if (cart.problems.length) { toast("Some items are unavailable. Update your cart.", "er"); return; }
    let o;
    try {
      btn.classList.add("busy");
      o = await api("/api/checkout", { method: "POST", body: { address_id: selected, coupon_code: coupon || null, notes: $("#notes").value } });
      pending = o.order_number; store.sset("hm_pending_order", pending);
    } catch (er) {
      btn.classList.remove("busy");
      showErr(esc(er.message));
      if (er.code && er.code.startsWith("COUPON")) { setCoupon(""); renderSummary(await getCart()); }
      if (er.code === "CART_INVALID") renderSummary(await getCart());
      return;
    }
    btn.classList.remove("busy");
    const r = await openRazorpay(o);
    if (r === "dismissed") {
      showErr(`Payment not completed. Your items are reserved for 30 minutes.<div class="row" style="margin-top:10px"><button class="btn p sm" id="retry">Retry payment</button><button class="btn sm" id="cxl">Cancel order</button></div>`);
      $("#retry").onclick = async (ev) => { const x = await busy(ev.target, () => api(`/api/checkout/${encodeURIComponent(o.order_number)}/pay`)); openRazorpay(x); };
      $("#cxl").onclick = async (ev) => {
        const x = await busy(ev.target, () => api(`/api/checkout/${encodeURIComponent(o.order_number)}/cancel`, { method: "POST" }));
        store.sset("hm_pending_order", null);
        if (x.status === "payment_confirmed") location.replace(`/account/orders/${encodeURIComponent(o.order_number)}?placed=1`);
        else { showErr(""); toast("Order cancelled. Your cart is unchanged."); }
      };
    }
  };
};
