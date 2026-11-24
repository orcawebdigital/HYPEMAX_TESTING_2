/* Products (list, editor, inventory, gallery, detail sections) + Categories */
"use strict";
const PROD_STATUSES = [["draft", "Draft (hidden)"], ["upcoming", "Upcoming"], ["coming_soon", "Coming soon"], ["active", "Active (on sale)"], ["out_of_stock", "Out of stock"], ["discontinued", "Discontinued"]];
const discPct = (mrp, price) => (mrp > 0 && price > 0 && price < mrp ? Math.round(((mrp - price) / mrp) * 100) : 0);

/* ---------- list ---------- */
route("products", ["products.manage", "products.content"], async (ctx) => {
  const rows = await GET("/products");
  const q = ctx.query;
  const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  const ok = ctx.set(`<div class="ph"><div><h2>Products</h2><div class="meta">${plural(rows.length, "product")}</div></div>
    <div class="acts">${can("products.manage") ? `<a class="btn p" href="#/products/new">+ Add product</a>` : ""}</div></div>
  <div class="pn flush"><div class="tbar" style="padding:12px 12px 0">
    <input class="grow" id="pq" type="search" placeholder="Search name, SKU or slug" value="${esc(q.q || "")}">
    <select id="pst"><option value="">All statuses</option>${PROD_STATUSES.map(([v, l]) => `<option value="${v}"${q.status === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
    <select id="pcat"><option value="">All categories</option>${cats.map((c) => `<option${q.cat === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
  </div><div id="plist"></div></div>`);
  if (!ok) return;
  const draw = () => {
    const s = $("#pq").value.trim().toLowerCase(), st = $("#pst").value, cat = $("#pcat").value;
    history.replaceState(null, "", "#/products" + (queryStr({ q: s, status: st, cat }) ? "?" + queryStr({ q: s, status: st, cat }) : ""));
    const list = rows.filter((r) => (!s || [r.name, r.sku, r.slug].join(" ").toLowerCase().includes(s)) && (!st || r.status === st) && (!cat || r.category === cat));
    $("#plist").innerHTML = list.length ? `<div class="tw"><table class="tbl"><thead><tr><th></th><th>Product</th><th>Status</th><th class="r">MRP</th><th class="r">Price</th><th class="r">Discount</th><th class="r">Stock</th><th class="r">Sold</th></tr></thead><tbody>
      ${list.map((r) => { const avail = r.stock - r.reserved, low = r.status === "active" && avail <= r.low_stock_threshold; const dp = discPct(r.mrp, r.price);
        return `<tr class="clk" data-href="#/products/${r.id}"><td class="thumb">${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : `<div class="ph0">IMG</div>`}</td>
        <td><a class="strong" href="#/products/${r.id}">${esc(r.name)}</a>${r.featured ? ' <span class="bd or nodot">Featured</span>' : ""}<div class="sub2">${esc(r.category || "No category")}${r.sku ? " · " + esc(r.sku) : ""}</div></td>
        <td>${badge(PROD_ST, r.status)}</td><td class="r nwr">${r.mrp ? inr(r.mrp) : "—"}</td><td class="r nwr">${r.price ? inr(r.price) : "—"}</td><td class="r">${dp ? `<span class="green">${dp}%</span>` : "—"}</td>
        <td class="r nwr"><span class="${avail <= 0 && r.status === "active" ? "red" : low ? "" : ""}" style="${low && avail > 0 ? "color:var(--wn)" : ""}">${num(r.stock)}</span>${r.reserved ? `<div class="sub2">${num(r.reserved)} reserved</div>` : ""}</td><td class="r">${num(r.units_sold)}</td></tr>`; }).join("")}
      </tbody></table></div>` : empty(rows.length ? "No products match these filters" : "No products yet");
    bindRowLinks($("#plist"));
  };
  let t; $("#pq").addEventListener("input", () => { clearTimeout(t); t = setTimeout(draw, 150); });
  $("#pst").addEventListener("change", draw); $("#pcat").addEventListener("change", draw);
  draw();
});

/* ---------- editor ---------- */
route("products/:id", ["products.manage", "products.content"], async (ctx) => {
  const isNew = ctx.params.id === "new";
  if (isNew && !can("products.manage")) throw Object.assign(new Error("Only managers can create products."), { status: 403 });
  const [p, cats] = await Promise.all([isNew ? Promise.resolve(null) : GET("/products/" + encodeURIComponent(ctx.params.id)), GET("/categories").catch(() => [])]);
  const P = p || { status: "draft", highlights: [], flavours: [], featured: 0, sort_order: 0, low_stock_threshold: 10 };
  const mg = can("products.manage"), ct = can("products.content", "products.manage");
  const dis = !mg; // commercial fields
  const ok = ctx.set(`<div class="savebar"><div class="ph"><div><div class="crumb"><a href="#/products">Products</a> /</div><h2>${isNew ? "New product" : esc(P.name)}</h2>
    ${isNew ? "" : `<div class="meta">${badge(PROD_ST, P.status)} <span>ID ${P.id}</span> · <span>Updated ${fdt(P.updated_at)}</span> · <a class="lk" href="/products/${esc(P.slug)}" target="_blank" rel="noopener">View on site ↗</a></div>`}</div>
    <div class="acts"><a class="btn" href="#/products">Cancel</a><button class="btn p" type="submit" form="pf">${isNew ? "Create product" : "Save changes"}</button></div></div></div>
  ${!mg ? `<div class="infobox">You can edit product content (text, images, sections). Prices, stock, status and URL need the <b>products.manage</b> permission.</div>` : ""}
  <div class="cols"><div>
    <form id="pf" class="pn" novalidate><h3>Details</h3>
      <div class="g2">
        ${fld({ n: "name", l: "Name", v: P.name, req: true, max: 160, dis: !ct, cls: "full" })}
        ${fld({ n: "slug", l: "URL slug", v: P.slug, max: 180, dis, hint: `Shown as <code>/products/<span id="slugp">${esc(P.slug || "…")}</span></code>. Leave blank to generate from the name.` })}
        ${fld({ n: "sku", l: "SKU", v: P.sku, max: 60, dis })}
        ${fld({ n: "status", l: "Status", t: "select", v: P.status, opts: PROD_STATUSES, dis })}
        ${fld({ n: "category_id", l: "Category", t: "select", v: P.category_id || "", opts: [["", "No category"], ...cats.map((c) => [c.id, c.name + (c.is_active ? "" : " (inactive)")])], dis })}
        ${fld({ n: "mrp", l: "MRP (₹)", t: "number", v: rup(P.mrp), min: 0, step: "0.01", dis })}
        <div class="fld"><label>Selling price (₹)</label><input type="number" name="price" min="0" step="0.01" value="${esc(rup(P.price))}"${dis ? " disabled" : ""}><div class="disc" id="disc"></div></div>
      </div>
      ${fld({ n: "short_description", l: "Short description", t: "area", v: P.short_description, rows: 2, max: 500, dis: !ct, hint: "Shown near the price and in product cards. Max 500 characters." })}
      ${fld({ n: "description", l: "Description", t: "area", v: P.description, rows: 6, dis: !ct })}
      <div class="g2">
        ${fld({ n: "highlights", l: "Highlights (one per line)", t: "area", v: (P.highlights || []).join("\n"), rows: 5, dis: !ct })}
        <div>${fld({ n: "flavours", l: "Flavours (comma separated)", v: (P.flavours || []).join(", "), dis: !ct, hint: "Customers pick one of these when ordering." })}
        ${fld({ n: "net_weight", l: "Net weight", v: P.net_weight, max: 40, ph: "e.g. 300 g", dis: !ct })}${fld({ n: "servings", l: "Servings", v: P.servings, max: 40, ph: "e.g. 30 servings", dis: !ct })}</div>
      </div>
      <div class="g2">${fld({ n: "sort_order", l: "Sort order", t: "number", v: P.sort_order ?? 0, step: "1", dis, hint: "Lower numbers show first." })}<div style="padding-top:18px">${fld({ n: "featured", l: "Featured on homepage", t: "check", v: !!P.featured, dis })}</div></div>
      ${isNew ? `<div class="g2">${fld({ n: "stock", l: "Opening stock", t: "number", v: 0, min: 0, step: "1" })}${fld({ n: "low_stock_threshold", l: "Low-stock alert at", t: "number", v: 10, min: 0, step: "1" })}</div>` : ""}
      <h3 style="margin:8px 0 12px">Search engine (SEO)</h3>
      ${fld({ n: "meta_title", l: "Meta title", v: P.meta_title, max: 160, dis: !ct, hint: "Defaults to the product name. ~60 characters is ideal." })}
      ${fld({ n: "meta_description", l: "Meta description", t: "area", v: P.meta_description, rows: 2, max: 300, dis: !ct, hint: "~155 characters is ideal." })}
      <button class="btn p" type="submit">${isNew ? "Create product" : "Save changes"}</button>
    </form>
    ${isNew ? `<div class="pn"><h3>Images & detail sections</h3>${empty("Create the product first, then add images, stock movements and accordion sections here.")}</div>` : `<div class="pn" id="gal"></div><div class="pn" id="secs"></div>`}
  </div>
  <div class="sticky-r">${isNew ? "" : `<div class="pn" id="inv"></div>${mg ? `<div class="pn"><h3>Delete product</h3><p class="sub2" style="margin:0 0 10px">Products with orders can't be deleted; set them to <b>Discontinued</b> instead.</p><button class="btn sm dg" id="pdel">Delete product</button></div>` : ""}`}</div></div>`);
  if (!ok) return;

  const f = $("#pf");
  const E = (n) => f.elements[n];
  const upd = () => {
    const m = Number(E("mrp").value) || 0, pr = Number(E("price").value) || 0, el = $("#disc");
    if (m && pr > m) { el.textContent = "Selling price is higher than MRP"; el.style.color = "var(--er)"; }
    else if (m && pr && pr < m) { el.textContent = `${discPct(m, pr)}% off · customer saves ${inr(Math.round((m - pr) * 100))}`; el.style.color = ""; }
    else { el.textContent = m && pr ? "No discount" : ""; el.style.color = "#888"; }
  };
  E("mrp").addEventListener("input", upd); E("price").addEventListener("input", upd); upd();
  const slugTouched = { v: !!P.slug };
  E("slug").addEventListener("input", () => { slugTouched.v = !!E("slug").value; $("#slugp").textContent = slugify(E("slug").value) || "…"; });
  E("name").addEventListener("input", () => { if (!slugTouched.v && !E("slug").disabled) { E("slug").value = slugify(E("name").value); $("#slugp").textContent = E("slug").value || "…"; } });

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = vals(f);
    const body = {};
    const content = ["name", "short_description", "description", "net_weight", "servings", "meta_title", "meta_description"];
    if (ct) { content.forEach((k) => (body[k] = v[k])); body.highlights = String(v.highlights || "").split("\n").map((s) => s.trim()).filter(Boolean); body.flavours = String(v.flavours || "").split(",").map((s) => s.trim()).filter(Boolean); }
    if (mg) Object.assign(body, { slug: slugify(v.slug || v.name), sku: v.sku, status: v.status, category_id: v.category_id || null, mrp: v.mrp === "" ? 0 : v.mrp, price: v.price === "" ? 0 : v.price, featured: !!v.featured, sort_order: v.sort_order === "" ? 0 : v.sort_order });
    if (isNew) Object.assign(body, { stock: v.stock || 0, low_stock_threshold: v.low_stock_threshold === "" ? 10 : v.low_stock_threshold });
    if (!String(v.name || "").trim()) return toast("Name is required", true);
    if (mg && Number(v.price) > Number(v.mrp) && Number(v.mrp) > 0) return toast("Selling price cannot be higher than MRP", true);
    const btns = $$('button[type=submit][form=pf], #pf button[type=submit]');
    btns.forEach((b) => b.classList.add("busy"));
    try {
      if (isNew) { const r = await POST("/products", body); toast("Product created"); go("products/" + r.id); }
      else { await PUT("/products/" + P.id, body); toast("Product saved"); ctx.reload(); }
    } catch (x) { toast(x.message, true); } finally { btns.forEach((b) => b.classList.remove("busy")); }
  });
  if (isNew) return;

  drawInventory(P, mg, ctx);
  drawGallery(P, ct);
  drawSections(P, ct);
  const del = $("#pdel");
  del && del.addEventListener("click", async () => {
    if (!(await confirmBox(`Delete <b>${esc(P.name)}</b> permanently? Its images and sections are removed too. This cannot be undone.`))) return;
    if (await act(del, () => DEL("/products/" + P.id), "Product deleted")) go("products");
  });
});

function drawInventory(P, mg, ctx) {
  const el = $("#inv");
  const avail = P.stock - P.reserved;
  el.innerHTML = `<h3>Inventory</h3><div class="kgrid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">${kpi("In stock", num(P.stock))}${kpi("Reserved", num(P.reserved), { sub: "Unpaid checkouts" })}${kpi("Available", num(avail), { cls: avail <= 0 ? "bad" : avail <= P.low_stock_threshold ? "warn" : "" })}</div>
  ${mg ? `<form id="invf" novalidate><div class="g2">${fld({ n: "mode", l: "Action", t: "select", v: "adjust", opts: [["adjust", "Adjust by (+/−)"], ["set", "Set stock to"]] })}${fld({ n: "quantity", l: "Quantity", t: "number", step: "1", ph: "e.g. 20 or -3" })}</div>
    ${fld({ n: "reason", l: "Reason", max: 60, ph: "e.g. New batch received, damaged, recount" })}
    ${fld({ n: "low_stock_threshold", l: "Low-stock alert at", t: "number", v: P.low_stock_threshold, min: 0, step: "1" })}
    <button class="btn sm p" type="submit">Update stock</button></form>` : `<p class="sub2">Low-stock alert at ${num(P.low_stock_threshold)}. Stock changes need the products.manage permission.</p>`}
  <h3 style="margin:16px 0 8px;font-size:13px">Recent movements</h3>
  ${P.movements.length ? `<div class="tw"><table class="tbl"><thead><tr><th>When</th><th>Reason</th><th class="r">Change</th></tr></thead><tbody>${P.movements.map((m) => `<tr><td class="nwr sub2">${fdt(m.created_at)}</td><td>${esc(m.reason)}${m.order_id ? ` <span class="sub2">order #${m.order_id}</span>` : ""}</td><td class="r strong ${m.change_qty < 0 ? "red" : "green"}">${m.change_qty > 0 ? "+" : ""}${num(m.change_qty)}</td></tr>`).join("")}</tbody></table></div>` : empty("No stock movements yet")}`;
  const f = $("#invf");
  f && f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = vals(f);
    if (v.quantity === "" && String(v.low_stock_threshold) === String(P.low_stock_threshold)) return toast("Enter a quantity or change the alert level", true);
    if (v.mode === "adjust" && v.quantity !== "" && Number(v.quantity) === 0) return toast("Adjustment can't be zero", true);
    const r = await act($("button[type=submit]", f), () => POST(`/products/${P.id}/inventory`, { mode: v.mode, quantity: v.quantity, reason: v.reason || (v.mode === "set" ? "stock count" : "manual adjustment"), low_stock_threshold: v.low_stock_threshold }), "Stock updated");
    if (r) { const fresh = await GET("/products/" + P.id); Object.assign(P, fresh); drawInventory(P, mg, ctx); }
  });
}

/* ---------- image gallery ---------- */
function drawGallery(P, ct) {
  const el = $("#gal");
  const imgs = P.images || [];
  el.innerHTML = `<div class="pnh"><h3>Images</h3><span class="sub2">${plural(imgs.length, "image")} · first image is the main image · drag to reorder</span></div>
  ${ct ? `<div class="drop" id="drop">Drop images here or <label class="btn sm" style="display:inline-flex;margin:0 0 0 6px">Choose files<input type="file" id="gfile" multiple accept="image/png,image/jpeg,image/webp,image/avif" hidden></label>
    <div class="hint">PNG, JPG, WEBP or AVIF · max 8 MB each · up to 10 at once</div><div class="prog" id="gprog"><i></i></div><div id="gstat" class="hint"></div></div><div class="errbox" id="gerr" hidden></div>` : ""}
  ${imgs.length ? `<div class="gallery" id="glist">${imgs.map((im, i) => `<div class="gi" data-id="${im.id}" draggable="${ct}">
    <div class="im" data-prev="${im.id}">${i === 0 ? '<span class="main">Main</span>' : ""}${ct ? '<span class="handle" title="Drag to reorder">⠿</span>' : ""}<img src="${esc(im.url)}" alt="${esc(im.alt_text)}" loading="lazy"></div>
    ${ct ? `<div class="ctl"><input value="${esc(im.alt_text)}" data-alt="${im.id}" placeholder="Alt text (describe the image)" maxlength="255" aria-label="Alt text">
    <div class="gbt"><button class="btn xs" data-mv="-1" data-i="${i}" ${i === 0 ? "disabled" : ""} title="Move left">←</button><button class="btn xs" data-mv="1" data-i="${i}" ${i === imgs.length - 1 ? "disabled" : ""} title="Move right">→</button>
    <label class="btn xs" title="Replace image file">⟳<input type="file" data-rep="${im.id}" accept="image/png,image/jpeg,image/webp,image/avif" hidden></label><button class="btn xs dg" data-gdel="${im.id}" title="Delete image">✕</button></div></div>` : ""}</div>`).join("")}</div>` : empty("No images yet")}`;
  const gerr = $("#gerr");
  const showErr = (m) => { if (gerr) { gerr.textContent = m; gerr.hidden = !m; } if (m) toast(m, true); };
  const refresh = async () => { const fresh = await GET("/products/" + P.id); P.images = fresh.images; drawGallery(P, ct); };
  $$("[data-prev]", el).forEach((d) => d.addEventListener("click", (e) => {
    if (e.target.closest(".handle")) return;
    const im = imgs.find((x) => x.id == d.dataset.prev);
    modal({ title: "Image preview", wide: true, ok: false, cancel: "Close", body: `<img class="preview" src="${esc(im.url)}" alt="${esc(im.alt_text)}"><p class="sub2" style="margin-top:10px">${esc(im.alt_text || "No alt text")}${im.width ? ` · ${im.width}×${im.height}px` : ""}</p><p class="sub2 mono" style="word-break:break-all">${esc(im.url)}</p>` });
  }));
  if (!ct) return;
  const doUpload = async (files) => {
    if (!files.length) return;
    try { checkImages(files); } catch (e) { return showErr(e.message); }
    if (files.length > 10) return showErr("Upload at most 10 images at once.");
    showErr("");
    const fd = new FormData();
    fd.append("owner_type", "product"); fd.append("owner_id", P.id);
    for (const f of files) fd.append("files", f);
    const prog = $("#gprog"), bar = $("i", prog), stat = $("#gstat");
    prog.style.display = "block"; bar.style.width = "0"; stat.textContent = `Uploading ${plural(files.length, "image")}…`;
    try {
      await upload("/images", fd, (r) => { bar.style.width = Math.round(r * 100) + "%"; if (r >= 1) stat.textContent = "Processing on server…"; });
      toast(`${plural(files.length, "image")} uploaded`); await refresh();
    } catch (e) { prog.style.display = "none"; stat.textContent = ""; showErr(uploadErr(e)); }
  };
  const fi = $("#gfile"); fi.addEventListener("change", () => { doUpload([...fi.files]); fi.value = ""; });
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); drop.classList.add("over"); } }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); doUpload([...e.dataTransfer.files]); } });

  const saveOrder = async (ids) => {
    try { await PUT("/images-order", { product_id: P.id, ids }); toast("Image order saved"); await refresh(); } catch (e) { showErr(e.message); }
  };
  $$("[data-mv]", el).forEach((b) => b.addEventListener("click", () => {
    const ids = imgs.map((x) => x.id), i = +b.dataset.i, j = i + +b.dataset.mv;
    [ids[i], ids[j]] = [ids[j], ids[i]]; b.classList.add("busy"); saveOrder(ids);
  }));
  // drag & drop reorder
  let dragId = null;
  $$(".gi", el).forEach((card) => {
    card.addEventListener("dragstart", (e) => { if (e.target.closest("input")) return e.preventDefault(); dragId = card.dataset.id; card.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
    card.addEventListener("dragend", () => { card.classList.remove("drag"); $$(".gi.over", el).forEach((c) => c.classList.remove("over")); });
    card.addEventListener("dragover", (e) => { if (!dragId) return; e.preventDefault(); card.classList.add("over"); });
    card.addEventListener("dragleave", () => card.classList.remove("over"));
    card.addEventListener("drop", (e) => {
      if (!dragId) return; e.preventDefault(); e.stopPropagation();
      const ids = imgs.map((x) => String(x.id)), from = ids.indexOf(dragId), to = ids.indexOf(card.dataset.id);
      dragId = null; if (from < 0 || to < 0 || from === to) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]); saveOrder(ids.map(Number));
    });
  });
  $$("[data-alt]", el).forEach((inp) => inp.addEventListener("change", async () => {
    try { await PUT("/images/" + inp.dataset.alt, { alt_text: inp.value }); toast("Alt text saved"); const im = imgs.find((x) => x.id == inp.dataset.alt); if (im) im.alt_text = inp.value; } catch (e) { showErr(e.message); }
  }));
  $$("[data-rep]", el).forEach((inp) => inp.addEventListener("change", async () => {
    const file = inp.files[0]; inp.value = ""; if (!file) return;
    try { checkImages([file]); } catch (e) { return showErr(e.message); }
    const lbl = inp.closest("label"); lbl.classList.add("busy"); toast("Uploading replacement…");
    const fd = new FormData(); fd.append("file", file);
    try { await upload(`/images/${inp.dataset.rep}/replace`, fd); toast("Image replaced"); await refresh(); } catch (e) { lbl.classList.remove("busy"); showErr(uploadErr(e)); }
  }));
  $$("[data-gdel]", el).forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox("Delete this image from the product? The file is also removed from Cloudinary."))) return;
    if (await act(b, () => DEL("/images/" + b.dataset.gdel), "Image deleted")) refresh();
  }));
}

/* ---------- accordion sections ---------- */
const SECTION_HINT = `Plain text. Start a line with <code>- </code> for a bullet point. Lines like <code>Label | Value</code> become table rows (3+ columns: the first row is the header). Leave a blank line between paragraphs.`;
function drawSections(P, ct, openId) {
  const el = $("#secs");
  const S = P.sections || [];
  el.innerHTML = `<div class="pnh"><h3>Detail sections (accordion)</h3>${ct ? `<button class="btn sm" id="secadd">+ Add section</button>` : ""}</div>
  <div class="hint" style="margin:-4px 0 12px">Only enabled sections with content show on the product page. ${SECTION_HINT}</div>
  ${S.length ? S.map((s, i) => `<div class="sec ${s.is_enabled ? "" : "off"} ${openId == s.id ? "open" : ""}" data-sid="${s.id}">
    <div class="sh" data-tog><span class="car">▶</span><span class="t">${esc(s.title)}<small>${s.content ? plural(s.content.split("\n").filter(Boolean).length, "line") : "empty"}</small></span>
      ${ct ? `${sw(`data-en="${s.id}" aria-label="Enabled"`, s.is_enabled)}<button class="btn xs" data-smv="-1" data-i="${i}" ${i === 0 ? "disabled" : ""} title="Move up">↑</button><button class="btn xs" data-smv="1" data-i="${i}" ${i === S.length - 1 ? "disabled" : ""} title="Move down">↓</button>` : badge({ 1: ["Enabled", "ok"], 0: ["Hidden", "mu"] }, s.is_enabled ? 1 : 0)}</div>
    <div class="sb"><form data-sf="${s.id}" novalidate>${fld({ n: "title", l: "Title", v: s.title, max: 120, dis: !ct })}${fld({ n: "content", l: "Content", t: "area", v: s.content, rows: 9, code: true, dis: !ct })}
      ${ct ? `<div style="display:flex;gap:8px;justify-content:space-between"><button class="btn sm p" type="submit">Save section</button><button class="btn sm dg" type="button" data-sdel="${s.id}">Delete</button></div>` : ""}</form></div></div>`).join("") : empty("No sections yet")}`;
  const refresh = async (open) => { const fresh = await GET("/products/" + P.id); P.sections = fresh.sections; drawSections(P, ct, open); };
  $$("[data-tog]", el).forEach((h) => h.addEventListener("click", (e) => { if (e.target.closest(".sw,button")) return; h.parentElement.classList.toggle("open"); }));
  if (!ct) return;
  const find = (id) => S.find((s) => s.id == id);
  $$("[data-en]", el).forEach((cb) => cb.addEventListener("change", async () => {
    const s = find(cb.dataset.en);
    try { await PUT(`/products/${P.id}/sections/${s.id}`, { title: s.title, content: s.content, is_enabled: cb.checked }); s.is_enabled = cb.checked ? 1 : 0; cb.closest(".sec").classList.toggle("off", !cb.checked); toast(cb.checked ? "Section enabled" : "Section hidden"); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  }));
  $$("[data-smv]", el).forEach((b) => b.addEventListener("click", async () => {
    const ids = S.map((s) => s.id), i = +b.dataset.i, j = i + +b.dataset.smv;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    if (await act(b, () => PUT(`/products/${P.id}/sections-order`, { ids }), "Order saved")) refresh();
  }));
  $$("[data-sf]", el).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = find(f.dataset.sf), v = vals(f);
    if (!v.title.trim()) return toast("Section title is required", true);
    if (await act($("button[type=submit]", f), () => PUT(`/products/${P.id}/sections/${s.id}`, { title: v.title, content: v.content, is_enabled: !!s.is_enabled }), "Section saved")) refresh(s.id);
  }));
  $$("[data-sdel]", el).forEach((b) => b.addEventListener("click", async () => {
    const s = find(b.dataset.sdel);
    if (!(await confirmBox(`Delete the section <b>${esc(s.title)}</b> and its content?`))) return;
    if (await act(b, () => DEL(`/products/${P.id}/sections/${s.id}`), "Section deleted")) refresh();
  }));
  $("#secadd").addEventListener("click", async () => {
    const r = await modal({ title: "Add section", ok: "Add section", body: `${fld({ n: "title", l: "Title", req: true, max: 120, ph: "e.g. Ingredients" })}${fld({ n: "content", l: "Content", t: "area", rows: 7, code: true, hint: SECTION_HINT })}${fld({ n: "is_enabled", l: "Show on product page", t: "check", v: true })}`,
      onOk: (f) => { const v = vals(f); return POST(`/products/${P.id}/sections`, { title: v.title, content: v.content, is_enabled: v.is_enabled }); } });
    if (r) { toast("Section added"); refresh(r.id); }
  });
}

/* ---------- categories ---------- */
route("categories", ["products.manage"], async (ctx) => {
  const rows = await GET("/categories");
  const ok = ctx.set(`<div class="ph"><div><h2>Categories</h2><div class="meta">${plural(rows.length, "category")}</div></div><div class="acts"><button class="btn p" id="cadd">+ Add category</button></div></div>
  <div class="errbox" id="cerr" hidden></div>
  <div class="pn flush">${rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th></th><th>Name</th><th>Slug</th><th class="r">Products</th><th class="r">Sort</th><th>Status</th><th class="r">Actions</th></tr></thead><tbody>
  ${rows.map((c) => `<tr><td class="thumb">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : `<div class="ph0">IMG</div>`}</td><td><b>${esc(c.name)}</b><div class="sub2">${esc((c.description || "").slice(0, 90))}</div></td><td class="mono">${esc(c.slug)}</td><td class="r">${num(c.products)}</td><td class="r">${c.sort_order}</td><td>${yesno(c.is_active, "Active", "Hidden")}</td>
    <td class="r nwr"><label class="btn xs">Image<input type="file" data-cimg="${c.id}" accept="image/png,image/jpeg,image/webp,image/avif" hidden></label> <button class="btn xs" data-ced="${c.id}">Edit</button> <button class="btn xs dg" data-cdel="${c.id}">Delete</button></td></tr>`).join("")}
  </tbody></table></div>` : empty("No categories yet")}</div>`);
  if (!ok) return;
  const form = (c = {}) => `<div class="g2">${fld({ n: "name", l: "Name", v: c.name, req: true, max: 120 })}${fld({ n: "slug", l: "URL slug", v: c.slug, hint: "Blank = generated from name" })}</div>${fld({ n: "description", l: "Description", t: "area", v: c.description, rows: 3, max: 2000 })}
    <div class="g2">${fld({ n: "sort_order", l: "Sort order", t: "number", v: c.sort_order ?? 0, step: "1" })}<div style="padding-top:18px">${fld({ n: "is_active", l: "Active (visible on site)", t: "check", v: c.id ? !!c.is_active : true })}</div></div>`;
  const edit = async (c) => {
    const r = await modal({ title: c ? "Edit category" : "New category", body: form(c || {}), ok: c ? "Save" : "Create", onOk: (f) => { const v = vals(f); return c ? PUT("/categories/" + c.id, v) : POST("/categories", v); } });
    if (r) { toast(c ? "Category saved" : "Category created"); ctx.reload(); }
  };
  $("#cadd").addEventListener("click", () => edit());
  $$("[data-ced]", ctx.view).forEach((b) => b.addEventListener("click", () => edit(rows.find((c) => c.id == b.dataset.ced))));
  $$("[data-cdel]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    const c = rows.find((x) => x.id == b.dataset.cdel);
    if (!(await confirmBox(`Delete the category <b>${esc(c.name)}</b>?${c.products ? ` ${plural(c.products, "product")} will be left without a category.` : ""}`))) return;
    if (await act(b, () => DEL("/categories/" + c.id), "Category deleted")) ctx.reload();
  }));
  $$("[data-cimg]", ctx.view).forEach((inp) => inp.addEventListener("change", async () => {
    const file = inp.files[0]; inp.value = ""; if (!file) return;
    const err = $("#cerr"); err.hidden = true;
    try { checkImages([file]); } catch (e) { return toast(e.message, true); }
    const lbl = inp.closest("label"); lbl.classList.add("busy");
    const fd = new FormData(); fd.append("file", file);
    try { await upload(`/categories/${inp.dataset.cimg}/image`, fd); toast("Category image updated"); ctx.reload(); }
    catch (e) { lbl.classList.remove("busy"); err.textContent = uploadErr(e); err.hidden = false; toast(uploadErr(e), true); }
  }));
});
