/* Product listing (/products) and product detail (/products/:slug). */
window.HM_PAGE = async function () {
  const { $, $$, esc, api, inr, card, accordion, img, I, toast, busy, track, recent, me, loginUrl, site, waLink, fmtDate } = HM;
  const page = document.body.dataset.page;

  // ======================= LISTING =======================
  if (page === "products") {
    const S = await site();
    const sp = new URLSearchParams(location.search);
    const state = { q: sp.get("q") || "", category: sp.get("category") || "", availability: sp.get("availability") || "", sort: sp.get("sort") || "featured", min: sp.get("min") || "", max: sp.get("max") || "" };
    const cats = S.categories || [];
    $("#app").innerHTML = `<div class="wrap pg"><div class="crumbs"><a href="/">Home</a><span>/</span>Shop</div>
      <h1>${state.category ? esc((cats.find((c) => c.slug === state.category) || {}).name || "Shop") : "All products"}</h1>
      <div class="pills" style="margin-top:14px" id="cats"><button data-c="" class="${!state.category ? "on" : ""}">All</button>${cats.map((c) => `<button data-c="${esc(c.slug)}" class="${state.category === c.slug ? "on" : ""}">${esc(c.name)}</button>`).join("")}</div>
      <form class="filters" id="flt" role="search">
        <input class="q" type="search" name="q" value="${esc(state.q)}" placeholder="Search products" aria-label="Search">
        <select name="availability" aria-label="Availability"><option value="">All availability</option><option value="available" ${state.availability === "available" ? "selected" : ""}>In stock</option><option value="upcoming" ${state.availability === "upcoming" ? "selected" : ""}>Coming soon</option></select>
        <input name="min" type="number" min="0" inputmode="numeric" placeholder="Min ₹" value="${esc(state.min)}" style="width:96px" aria-label="Minimum price">
        <input name="max" type="number" min="0" inputmode="numeric" placeholder="Max ₹" value="${esc(state.max)}" style="width:96px" aria-label="Maximum price">
        <select name="sort" aria-label="Sort by">${[["featured", "Featured"], ["newest", "Newest"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"], ["discount", "Biggest discount"], ["rating", "Top rated"], ["name", "Name"]].map(([v, t]) => `<option value="${v}" ${state.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>
        <button class="btn p sm" style="height:38px">Apply</button>
      </form><p class="muted small" id="cnt"></p><div class="grid" id="list"></div></div>`;
    // BUG-002: normalised query (trimmed, single spaces), skips identical repeat requests, cancels stale ones,
    // and searches as you type with a short debounce instead of one request per keystroke.
    let lastQs = null, inflight = null;
    const load = async () => {
      state.q = String(state.q || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v && !(v === "featured")));
      if (qs.toString() === lastQs) return;
      lastQs = qs.toString();
      history.replaceState(null, "", "/products" + (qs.toString() ? "?" + qs : ""));
      $("#list").innerHTML = [1, 2, 3, 4].map(() => '<div class="skel" style="height:340px"></div>').join("");
      if (inflight) inflight.abort();
      const ctl = (inflight = new AbortController());
      let list;
      try { list = await fetch("/api/products?" + qs, { signal: ctl.signal, headers: { Accept: "application/json" } }).then((r) => { if (!r.ok) throw new Error("Products could not be loaded"); return r.json(); }); }
      catch (e) { if (e.name === "AbortError") return; $("#list").innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`; lastQs = null; return; }
      $("#cnt").textContent = `${list.length} product${list.length === 1 ? "" : "s"}${state.q ? ` for “${state.q}”` : ""}`;
      $("#list").innerHTML = list.length ? list.map((p) => card(p)).join("") : `<div class="empty" style="grid-column:1/-1"><h3>No products match “${esc(state.q || "your filters")}”</h3><p>Check the spelling, try fewer words, or <a class="link" href="/products">browse all products</a>.</p></div>`;
      HM.reveal();
      if (state.q) track("search", { path: "/products?q=" + state.q.slice(0, 80) });
    };
    $("#flt").onsubmit = (e) => { e.preventDefault(); Object.assign(state, Object.fromEntries(new FormData(e.target))); load(); };
    let deb;
    $("#flt").q.addEventListener("input", (e) => { clearTimeout(deb); deb = setTimeout(() => { state.q = e.target.value; load(); }, 350); });
    $("#flt").sort.onchange = $("#flt").availability.onchange = () => $("#flt").requestSubmit();
    $("#cats").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.category = b.dataset.c; $$("#cats button").forEach((x) => x.classList.toggle("on", x === b)); load(); };
    return load();
  }

  // ======================= DETAIL =======================
  const slug = decodeURIComponent(location.pathname.split("/")[2] || "");
  let p;
  try { p = await api("/api/products/" + encodeURIComponent(slug)); }
  catch (e) {
    if (e.status === 404) { $("#app").innerHTML = `<div class="wrap pg empty"><h3>Product not found</h3><p>It may have been moved or discontinued.</p><p style="margin-top:14px"><a class="btn p" href="/products">Browse products</a></p></div>`; return; }
    throw e;
  }
  const S = await site();
  document.title = p.meta_title || `${p.name} | HYPEMAX Nutrition`;
  recent.add(p.id);
  track("product_view", { product_id: p.id });

  const imgs = p.images.length ? p.images : p.image ? [{ url: p.image, alt: p.name }] : [];
  const multi = imgs.length > 1;
  const stockMsg = p.purchasable ? (p.low_stock ? `<span class="tag">Only ${p.low_stock} left</span>` : '<span class="tag ok">In stock</span>')
    : `<span class="tag ${p.status === "upcoming" || p.status === "coming_soon" ? "soon" : "grey"}">${esc(p.status_label)}</span>`;
  const fl = p.flavours || [];

  $("#app").innerHTML = `<div class="wrap pg">
  <div class="crumbs"><a href="/">Home</a><span>/</span><a href="/products">Shop</a>${p.category ? `<span>/</span><a href="/products?category=${esc(p.category.slug)}">${esc(p.category.name)}</a>` : ""}<span>/</span>${esc(p.name)}</div>
  <div class="pdp">
    <div class="gal" id="gal">
      <div class="track" id="trk" tabindex="0" aria-label="Product images" aria-roledescription="carousel">${imgs.map((m, i) => `<div class="slide" role="group" aria-label="Image ${i + 1} of ${imgs.length}">${img(m.url, m.alt, { w: 1000, sizes: "(max-width:980px) 100vw, 600px", eager: i === 0 })}</div>`).join("") || '<div class="slide"><span class="muted">Image coming soon</span></div>'}</div>
      ${multi ? `<button class="nav prev" aria-label="Previous image" hidden>${I.left}</button><button class="nav next" aria-label="Next image">${I.right}</button>
      <div class="dots" role="tablist">${imgs.map((_, i) => `<button role="tab" aria-label="Show image ${i + 1}" class="${i ? "" : "on"}" data-i="${i}"></button>`).join("")}</div>
      <div class="thumbs">${imgs.map((m, i) => `<button class="${i ? "" : "on"}" data-i="${i}" aria-label="Show image ${i + 1}">${img(m.url, "", { w: 160, sizes: "64px" })}</button>`).join("")}</div>` : ""}
    </div>
    <div class="pinfo">
      ${p.category ? `<div class="cat">${esc(p.category.name)}</div>` : ""}
      <h1>${esc(p.name)}</h1>
      <div class="row" style="gap:10px">${p.rating ? `<a href="#reviews" class="stars">${"★".repeat(Math.round(p.rating.average))}${"☆".repeat(5 - Math.round(p.rating.average))} <span class="muted small">${p.rating.average} (${p.rating.count} reviews)</span></a>` : ""}${stockMsg}</div>
      <p class="sub" style="margin-top:10px">${esc(p.short_description || "")}</p>
      ${p.price ? `<div class="price"><b>${inr(p.price)}</b>${p.mrp > p.price ? `<s>MRP ${inr(p.mrp)}</s><span class="pct">${p.discount_percent}% OFF</span>` : ""}</div><div class="tax">Inclusive of all taxes${p.mrp > p.price ? ` · You save ${inr(p.mrp - p.price)}` : ""}</div>` : '<p class="muted" style="margin-top:12px">Price will be announced at launch.</p>'}
      ${p.highlights.length ? `<div class="chips">${p.highlights.map((h) => `<span>${esc(h)}</span>`).join("")}</div>` : ""}
      ${fl.length > 1 ? `<label for="fl">Flavour</label><select id="fl">${fl.map((f) => `<option>${esc(f)}</option>`).join("")}</select>` : fl.length ? `<p class="small" style="margin-top:6px"><span class="muted">Flavour:</span> <b>${esc(fl[0])}</b>${p.net_weight ? ` · <span class="muted">Net wt:</span> <b>${esc(p.net_weight)}</b>` : ""}${p.servings ? ` · <b>${esc(p.servings)}</b>` : ""}</p>` : ""}
      ${p.purchasable ? `<div class="buy" id="buy"><div class="qty" aria-label="Quantity"><button type="button" data-q="-1" aria-label="Decrease quantity">−</button><input id="q" type="number" value="1" min="1" max="10" inputmode="numeric" aria-label="Quantity"><button type="button" data-q="1" aria-label="Increase quantity">+</button></div>
        <button class="btn" id="add">Add to cart</button><button class="btn p bn-buy" id="now">Buy now</button>
        <button class="icon-btn wish ${p.wishlisted ? "on" : ""}" id="wish" aria-label="Add to wishlist" aria-pressed="${!!p.wishlisted}">${I.heart}</button></div>`
      : `<div class="notice" style="margin-top:14px">${p.status === "upcoming" || p.status === "coming_soon" ? "This product isn't available to buy yet. Subscribe below to hear when it launches." : "This product is currently unavailable."}</div>
         <form class="newsl" id="notify" style="margin:10px 0 0"><input type="email" name="email" required placeholder="Email for launch updates"><button class="btn p">Notify me</button></form>`}
      <div class="perks"><div>${I.truck}<span>${esc((S.settings && S.settings.deliveryEstimate) || "Fast delivery across India")}</span></div><div>${I.shield}<span>Secure payments by Razorpay</span></div><div>${I.lab}<span>FSSAI licensed, made in India</span></div>
        <div>${I.chat}<a href="${esc(waLink(S.settings, `Hello HYPEMAX Team! I have a question about ${p.name}.`))}" target="_blank" rel="noopener">Questions? WhatsApp us</a></div></div>
    </div>
  </div>
  <div class="pdetails">
    <div>${p.description ? `<h2 style="font-size:1.3rem;margin-bottom:8px">About this product</h2><p class="muted" style="margin-bottom:18px;white-space:pre-line">${esc(p.description)}</p>` : ""}
      ${p.sections.length ? accordion(p.sections.map((s) => ({ title: s.title, content: s.content }))) : ""}</div>
    <div id="reviews"><h2 style="font-size:1.3rem;margin-bottom:10px">Reviews</h2><div id="rvw"><div class="skel" style="height:80px"></div></div></div>
  </div>
  ${p.related.length ? `<section style="padding-bottom:0"><h2>You may also like</h2><div class="grid">${p.related.map((x) => card(x)).join("")}</div></section>` : ""}
  <section id="rvsec" style="padding-bottom:0" hidden><h2>Recently viewed</h2><div class="grid" id="rvlist"></div></section>
  </div>
  ${p.purchasable ? `<div class="sticky-buy" id="sb"><div class="price"><b>${inr(p.price)}</b>${p.mrp > p.price ? `<s>${inr(p.mrp)}</s>` : ""}</div><button class="btn p" id="sbAdd">Add to cart</button></div>` : ""}`;

  // ----- gallery: swipe (native scroll-snap) + arrows + dots + thumbs + keyboard -----
  if (multi) {
    const trk = $("#trk"), dots = $$(".gal .dots button"), th = $$(".gal .thumbs button"), prev = $(".gal .prev"), next = $(".gal .next");
    let cur = 0;
    const go = (i) => { i = Math.max(0, Math.min(imgs.length - 1, i)); trk.scrollTo({ left: i * trk.clientWidth, behavior: "smooth" }); };
    const sync = () => {
      const i = Math.round(trk.scrollLeft / trk.clientWidth);
      if (i === cur) return; cur = i;
      dots.forEach((d, k) => { d.classList.toggle("on", k === i); d.setAttribute("aria-selected", k === i); });
      th.forEach((t, k) => t.classList.toggle("on", k === i));
      prev.hidden = i === 0; next.hidden = i === imgs.length - 1;
    };
    trk.addEventListener("scroll", sync, { passive: true });
    prev.onclick = () => go(cur - 1); next.onclick = () => go(cur + 1);
    [...dots, ...th].forEach((b) => (b.onclick = () => go(+b.dataset.i)));
    trk.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") { e.preventDefault(); go(cur + 1); } if (e.key === "ArrowLeft") { e.preventDefault(); go(cur - 1); } });
    addEventListener("resize", () => trk.scrollTo({ left: cur * trk.clientWidth }));
  }

  // ----- buy box -----
  if (p.purchasable) {
    const q = $("#q");
    const qty = () => Math.min(10, Math.max(1, parseInt(q.value, 10) || 1));
    $("#buy").addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) q.value = Math.min(10, Math.max(1, qty() + +b.dataset.q)); });
    q.onchange = () => (q.value = qty());
    const flavour = () => ($("#fl") ? $("#fl").value : fl[0] || "");
    $("#add").onclick = (e) => HM.addToCart(p.id, flavour(), qty(), e.currentTarget).catch(() => {});
    $("#sbAdd").onclick = (e) => HM.addToCart(p.id, flavour(), qty(), e.currentTarget).catch(() => {});
    // Guests: addToCart remembers the item, sends them to log in, adds it on return, then continues to checkout.
    $("#now").onclick = async (e) => {
      try { await HM.addToCart(p.id, flavour(), qty(), e.currentTarget, { then: "checkout" }); location.href = "/checkout"; } catch { /* toast shown */ }
    };
    $("#wish").onclick = async (e) => {
      const b = e.currentTarget;
      if (!(await me())) { location.href = loginUrl(); return; }
      const on = !b.classList.contains("on");
      await busy(null, () => (on ? api("/api/account/wishlist", { method: "POST", body: { product_id: p.id } }) : api("/api/account/wishlist/" + p.id, { method: "DELETE" })));
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); toast(on ? "Saved to wishlist" : "Removed from wishlist", "ok");
    };
    // Mobile sticky add-to-cart bar once the main buttons scroll out of view
    const sb = $("#sb");
    document.body.classList.add("has-sticky");
    new IntersectionObserver(([en]) => sb.classList.toggle("show", !en.isIntersecting && en.boundingClientRect.top < 0)).observe($("#buy"));
  } else if ($("#notify")) {
    $("#notify").onsubmit = async (e) => {
      e.preventDefault();
      await busy(e.target.querySelector("button"), () => api("/api/newsletter", { method: "POST", body: { email: e.target.email.value } }));
      e.target.reset(); toast("Thanks! We'll email you at launch.", "ok");
    };
  }

  // ----- reviews -----
  api(`/api/products/${encodeURIComponent(p.slug)}/reviews`).then((rv) => {
    $("#rvw").innerHTML = (p.rating ? `<div class="rv-sum"><b>${p.rating.average}</b><div><div class="stars">${"★".repeat(Math.round(p.rating.average))}</div><div class="muted small">${p.rating.count} review${p.rating.count === 1 ? "" : "s"}</div></div></div>` : "") +
      (rv.length ? rv.map((r) => `<div class="rev"><div class="row" style="gap:8px"><span class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>${r.title ? `<b>${esc(r.title)}</b>` : ""}</div><p>${esc(r.body)}</p><div class="tiny muted" style="margin-top:4px">${esc(r.name)} · ${fmtDate(r.created_at)} ${r.verified_purchase ? '<span class="vp">✓ Verified purchase</span>' : ""}</div></div>`).join("")
        : `<p class="muted small">No reviews yet. Customers can review this product from <a class="link" href="/account/orders">their orders</a> after delivery.</p>`);
  }).catch(() => ($("#rvw").innerHTML = '<p class="muted small">Reviews could not be loaded.</p>'));

  // ----- recently viewed -----
  const ids = recent.ids().filter((id) => id !== p.id).slice(0, 4);
  if (ids.length) api("/api/products-by-ids?ids=" + ids.join(",")).then((list) => {
    if (!list.length) return;
    $("#rvlist").innerHTML = list.map((x) => card(x)).join(""); $("#rvsec").hidden = false; HM.reveal();
  }).catch(() => {});
};
