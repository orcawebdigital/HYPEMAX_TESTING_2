/* CMS: site settings, homepage, about, contact, policies, site images, banners, FAQs */
"use strict";
const CMS_TABS = [["settings", "Site settings"], ["homepage", "Homepage"], ["about", "About"], ["contact", "Contact"], ["policy_privacy", "Privacy policy"], ["policy_terms", "Terms"], ["policy_shipping", "Shipping policy"], ["policy_refund", "Refund policy"], ["images", "Site images"], ["banners", "Banners"], ["faqs", "FAQs"]];
const cmsTabs = (cur) => `<div class="ph"><div><h2>Content</h2><div class="meta">Edit what customers see on the website</div></div></div><nav class="tabs2">${CMS_TABS.map(([k, l]) => `<a href="#/content/${k}" class="${k === cur ? "on" : ""}">${l}</a>`).join("")}</nav>`;

route("content", ["content.manage"], async () => location.replace("#/content/settings"));

/** Editable list of {title, text} rows. */
function listEditor(name, items, { tl = "Title", xl = "Text", add = "Add row" } = {}) {
  const row = (it = {}) => `<div class="lrow" data-lrow><input data-lt placeholder="${esc(tl)}" value="${esc(it.title)}" maxlength="160" aria-label="${esc(tl)}"><textarea data-lx rows="2" placeholder="${esc(xl)}" maxlength="600" aria-label="${esc(xl)}">${esc(it.text)}</textarea><button type="button" class="btn xs dg" data-lrm title="Remove row">✕</button></div>`;
  return `<div class="fld" data-list="${name}"><div data-rows>${(items || []).map(row).join("")}</div><button type="button" class="btn xs" data-ladd>+ ${esc(add)}</button><template>${row()}</template></div>`;
}
function bindLists(root) {
  $$("[data-list]", root).forEach((w) => {
    w.addEventListener("click", (e) => {
      if (e.target.closest("[data-ladd]")) { $("[data-rows]", w).insertAdjacentHTML("beforeend", $("template", w).innerHTML); $("[data-rows] [data-lrow]:last-child input", w).focus(); }
      const rm = e.target.closest("[data-lrm]"); if (rm) rm.closest("[data-lrow]").remove();
    });
  });
}
const readList = (root, name) => $$(`[data-list="${name}"] [data-rows] [data-lrow]`, root).map((r) => ({ title: $("[data-lt]", r).value.trim(), text: $("[data-lx]", r).value.trim() })).filter((x) => x.title || x.text);

const CMS_FIELDS = {
  settings: [["h", "Brand & contact"], ["brandName", "Brand name", 120], ["legalName", "Legal name", 160], ["email", "Customer care email", 190, "email"], ["phone", "Phone", 30], ["whatsapp", "WhatsApp number", 20, "text", "Digits only with country code, e.g. <code>919984472222</code>"], ["gstin", "GSTIN", 20], ["address", "Address", 400, "area"], ["businessHours", "Business hours", 160], ["deliveryEstimate", "Delivery estimate", 120, "text", "e.g. Delivered in 3-7 working days"],
    ["h", "Shipping charges"], ["shippingFee", "Shipping fee (₹)", 10, "number", "0 = free shipping on every order"], ["freeShippingAbove", "Free shipping above (₹)", 10, "number", "Order subtotal at which shipping becomes free. 0 = no threshold."],
    ["h", "Social links"], ["instagram", "Instagram URL", 300, "url"], ["facebook", "Facebook URL", 300, "url"], ["youtube", "YouTube URL", 300, "url"], ["twitter", "X / Twitter URL", 300, "url"], ["linkedin", "LinkedIn URL", 300, "url"],
    ["h", "Site-wide text & SEO"], ["announcement", "Announcement bar", 200, "text", "Shown at the top of every page. Leave empty to hide."], ["footerText", "Footer text", 600, "area"], ["seoTitle", "Default SEO title", 160], ["seoDescription", "Default SEO description", 300, "area"]],
  homepage: [["h", "Hero"], ["heroEyebrow", "Hero eyebrow (small text above title)", 80], ["heroTitle", "Hero title", 160], ["heroText", "Hero text", 400, "area"], ["heroCtaLabel", "Hero button label", 40],
    ["h", "Intro"], ["introTitle", "Intro title", 200], ["introText", "Intro text", 2000, "area"],
    ["h", "Products"], ["productsTitle", "Products section title", 160], ["productsSubtitle", "Products section subtitle", 300], ["comingSoonTitle", "Coming soon title", 160],
    ["h", "Why HYPEMAX"], ["whyTitle", "Section title", 160], ["why", "Reasons", 0, "list"],
    ["h", "Stats"], ["stats", "Stats (title = number, text = caption)", 0, "list"],
    ["h", "Call to action, testimonials & newsletter"], ["ctaTitle", "CTA title", 200], ["ctaText", "CTA text", 300], ["testimonialsTitle", "Testimonials title", 160], ["newsletterTitle", "Newsletter title", 160], ["newsletterText", "Newsletter text", 300]],
  about: [["title", "Title", 160], ["intro", "Intro", 1000, "area"], ["body", "Body", 20000, "bigarea", "Blank line between paragraphs. <code>## Heading</code> lines become headings."], ["values", "Values", 0, "list"], ["mission", "Mission", 2000, "area"]],
  contact: [["title", "Title", 160], ["intro", "Intro", 1000, "area"], ["hours", "Hours", 200], ["mapUrl", "Google Maps embed URL", 500, "url", "Optional https:// Google Maps embed link"]],
};
const POLICY_HINT = "Start a line with <code>## </code> for a heading (e.g. <code>## Returns</code>). Leave a blank line between paragraphs. Lines starting <code>- </code> become bullet points.";

route("content/:tab", ["content.manage"], async (ctx) => {
  const tab = ctx.params.tab;
  if (tab === "images") return contentImages(ctx);
  if (tab === "banners") return contentBanners(ctx);
  if (tab === "faqs") return contentFaqs(ctx);
  const policy = tab.startsWith("policy_");
  const fields = policy ? [["title", "Title", 160], ["body", "Policy text", 50000, "bigarea", POLICY_HINT]] : CMS_FIELDS[tab];
  if (!fields) throw Object.assign(new Error("Unknown content section"), { status: 404 });
  const data = await GET("/content/" + tab);
  const lists = { why: ["Title", "Text", "Add reason"], stats: ["Number, e.g. 30", "Caption, e.g. servings per tub", "Add stat"], values: ["Value", "Description", "Add value"] };
  const html = fields.map(([n, l, max, t, hint]) => {
    if (n === "h") return `<h3 class="full" style="margin:14px 0 10px;font-size:14px;color:#ff9a4d">${esc(l)}</h3>`;
    if (t === "list") { const [tl, xl, add] = lists[n] || []; return `<div class="full"><label>${esc(l)}</label>${listEditor(n, data[n], { tl, xl, add })}</div>`; }
    if (t === "bigarea") return fld({ n, l, t: "area", v: data[n], rows: 22, max, hint, cls: "full", code: true });
    if (t === "area") return fld({ n, l, t: "area", v: data[n], rows: 3, max, hint, cls: "full" });
    if (t === "number") return fld({ n, l, t: "number", v: data[n], min: 0, step: "1", hint });
    return fld({ n, l, t: t || "text", v: data[n], max, hint });
  }).join("");
  const ok = ctx.set(`${cmsTabs(tab)}<form class="pn" id="cmf" novalidate><div class="g2">${html}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><button class="btn p" type="submit">Save ${esc(CMS_TABS.find((x) => x[0] === tab)[1].toLowerCase())}</button>${tab === "homepage" ? `<a class="lk" href="/" target="_blank" rel="noopener">View homepage ↗</a>` : policy ? `<a class="lk" href="/policies/${tab.slice(7)}" target="_blank" rel="noopener">View page ↗</a>` : ""}</div></form>`);
  if (!ok) return;
  const f = $("#cmf");
  bindLists(f);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = {};
    for (const [n, , , t] of fields) { if (n === "h") continue; v[n] = t === "list" ? readList(f, n) : f.elements[n].value; }
    if (tab === "settings") {
      v.whatsapp = v.whatsapp.replace(/\D/g, "");
      if (v.whatsapp && !/^\d{10,15}$/.test(v.whatsapp)) return toast("WhatsApp number must be 10-15 digits incl. country code, e.g. 919984472222", true);
      for (const k of ["instagram", "facebook", "youtube", "twitter", "linkedin"]) if (v[k] && !/^https:\/\//i.test(v[k])) return toast(`${k} link must start with https://`, true);
    }
    if (await act($("button[type=submit]", f), () => PUT("/content/" + tab, v), "Saved. Changes are live on the website.")) ctx.reload();
  });
});

/* ---------- site images ---------- */
const SLOT_INFO = { logo: ["Logo", "Header & footer logo. Transparent PNG works best."], hero: ["Hero (desktop)", "Main homepage hero image."], hero_mobile: ["Hero (mobile)", "Hero image for phones (portrait)."], about: ["About page", "Main image on the About page."], about_2: ["About page (second)", "Secondary About image."], promo: ["Promo", "Promotional section image."], og_image: ["Social share image", "Shown when the site is shared on WhatsApp, Facebook etc. 1200×630 recommended."], contact: ["Contact page", "Image on the Contact page."] };
async function contentImages(ctx) {
  const d = await GET("/images/content");
  const by = Object.fromEntries(d.images.map((i) => [i.owner_key, i]));
  const ok = ctx.set(`${cmsTabs("images")}${STATE.features.cloudinary === false ? `<div class="infobox"><b>Cloudinary isn't configured</b>, so uploads will be rejected until CLOUDINARY_URL is added to the server environment. The site falls back to its built-in images.</div>` : ""}<div class="errbox" id="ierr" hidden></div>
  <div class="slots">${d.slots.map((k) => { const im = by[k], [t, h] = SLOT_INFO[k] || [k, ""]; return `<div class="slot"><div class="im">${im ? `<img src="${esc(im.url)}" alt="${esc(im.alt_text)}">` : "No image (site default)"}</div>
    <div class="ctl"><h4>${esc(t)} <code>${esc(k)}</code></h4><div class="hint" style="margin:0">${esc(h)}</div>
    ${im ? `<input data-ialt="${im.id}" value="${esc(im.alt_text)}" placeholder="Alt text" maxlength="255" aria-label="Alt text">` : ""}
    <div class="prog" data-prog="${k}"><i></i></div>
    <div style="display:flex;gap:6px"><label class="btn xs">${im ? "Replace" : "Upload"}<input type="file" data-slot="${k}" accept="image/png,image/jpeg,image/webp,image/avif" hidden></label>${im ? `<button class="btn xs dg" data-idel="${im.id}" data-k="${esc(t)}">Delete</button>` : ""}</div></div></div>`; }).join("")}</div>`);
  if (!ok) return;
  const err = $("#ierr");
  $$("[data-slot]", ctx.view).forEach((inp) => inp.addEventListener("change", async () => {
    const file = inp.files[0]; inp.value = ""; if (!file) return;
    err.hidden = true;
    try { checkImages([file]); } catch (e) { return toast(e.message, true); }
    const k = inp.dataset.slot, prog = $(`[data-prog="${k}"]`, ctx.view), lbl = inp.closest("label");
    const fd = new FormData(); fd.append("owner_type", "content"); fd.append("owner_key", k); fd.append("files", file);
    prog.style.display = "block"; lbl.classList.add("busy");
    try { await upload("/images", fd, (r) => ($("i", prog).style.width = Math.round(r * 100) + "%")); toast("Image uploaded"); ctx.reload(); }
    catch (e) { prog.style.display = "none"; lbl.classList.remove("busy"); err.textContent = uploadErr(e); err.hidden = false; toast(uploadErr(e), true); }
  }));
  $$("[data-ialt]", ctx.view).forEach((inp) => inp.addEventListener("change", async () => { try { await PUT("/images/" + inp.dataset.ialt, { alt_text: inp.value }); toast("Alt text saved"); } catch (e) { toast(e.message, true); } }));
  $$("[data-idel]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox(`Delete the <b>${esc(b.dataset.k)}</b> image? The site will fall back to its default image.`))) return;
    if (await act(b, () => DEL("/images/" + b.dataset.idel), "Image deleted")) ctx.reload();
  }));
}

/* ---------- banners ---------- */
async function contentBanners(ctx) {
  const rows = await GET("/banners");
  const now = Date.now();
  const live = (b) => b.is_active && (!b.starts_at || new Date(b.starts_at) <= now) && (!b.ends_at || new Date(b.ends_at) > now);
  const ok = ctx.set(`${cmsTabs("banners")}<div class="tbar"><span class="sub2">Hero banners replace the homepage hero; promo banners show mid-page; strip banners show as a thin bar.</span><span class="flex1"></span><button class="btn p sm" id="badd">+ Add banner</button></div><div class="errbox" id="berr" hidden></div>
  <div class="pn flush">${rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Images</th><th>Banner</th><th>Placement</th><th class="r">Sort</th><th>Schedule (IST)</th><th>Status</th><th class="r">Actions</th></tr></thead><tbody>
  ${rows.map((b) => `<tr><td><div class="bnimg"><div title="Desktop">${b.image_url ? `<img src="${esc(b.image_url)}" alt="">` : "Desktop"}</div><div title="Mobile" style="width:30px">${b.mobile_image_url ? `<img src="${esc(b.mobile_image_url)}" alt="">` : "Mob"}</div></div></td>
    <td><b>${esc(b.title || "(no title)")}</b>${b.subtitle ? `<div class="sub2">${esc(b.subtitle)}</div>` : ""}${b.link_url ? `<div class="sub2">→ ${esc(b.link_label || "Link")}: <span class="mono">${esc(b.link_url)}</span></div>` : ""}</td>
    <td><span class="bd in nodot">${esc(b.placement)}</span></td><td class="r">${b.sort_order}</td><td class="nwr sub2">${b.starts_at ? fdt(b.starts_at) : "Any time"}<br>${b.ends_at ? "to " + fdt(b.ends_at) : "no end"}</td>
    <td>${live(b) ? '<span class="bd ok">Live</span>' : b.is_active ? '<span class="bd wn">Scheduled / ended</span>' : '<span class="bd mu">Inactive</span>'}</td>
    <td class="r nwr"><label class="btn xs">Desktop img<input type="file" data-bimg="${b.id}" data-v="desktop" accept="image/png,image/jpeg,image/webp,image/avif" hidden></label> <label class="btn xs">Mobile img<input type="file" data-bimg="${b.id}" data-v="mobile" accept="image/png,image/jpeg,image/webp,image/avif" hidden></label>${b.image_url ? ` <button class="btn xs" data-brm="${b.id}" data-v="desktop">Remove desktop img</button>` : ""}${b.mobile_image_url ? ` <button class="btn xs" data-brm="${b.id}" data-v="mobile">Remove mobile img</button>` : ""}
      <button class="btn xs" data-bed="${b.id}">Edit</button> <button class="btn xs dg" data-bdel="${b.id}">Delete</button></td></tr>`).join("")}
  </tbody></table></div>` : empty("No banners yet")}</div>`);
  if (!ok) return;
  const form = (b = {}) => `<div class="g2">${fld({ n: "placement", l: "Placement", t: "select", v: b.placement || "promo", opts: [["hero", "Hero (homepage top)"], ["promo", "Promo (mid-page)"], ["strip", "Strip (thin bar)"]] })}${fld({ n: "sort_order", l: "Sort order", t: "number", v: b.sort_order ?? 0, step: "1" })}</div>
    ${fld({ n: "title", l: "Title", v: b.title, max: 160 })}${fld({ n: "subtitle", l: "Subtitle", t: "area", rows: 2, v: b.subtitle, max: 300 })}
    <div class="g2">${fld({ n: "link_url", l: "Link URL", v: b.link_url, max: 500, ph: "/products/hypemax-pre-workout", hint: "A site path like /products or a full https:// URL" })}${fld({ n: "link_label", l: "Button label", v: b.link_label, max: 60, ph: "Shop now" })}</div>
    <div class="g2">${fld({ n: "starts_at", l: "Start (IST)", t: "datetime-local", v: toIstInput(b.starts_at), hint: "Blank = immediately" })}${fld({ n: "ends_at", l: "End (IST)", t: "datetime-local", v: toIstInput(b.ends_at), hint: "Blank = no end" })}</div>
    ${fld({ n: "is_active", l: "Active", t: "check", v: b.id ? !!b.is_active : true })}${b.id ? "" : `<div class="hint">Save first, then upload the desktop and mobile images from the list.</div>`}`;
  const edit = async (b) => {
    const r = await modal({ title: b ? "Edit banner" : "New banner", body: form(b || {}), ok: b ? "Save" : "Create",
      onOk: (f) => { const v = vals(f); if (v.link_url && !/^(\/|https:\/\/)/.test(v.link_url)) throw new Error("Link must be a site path like /products or a https:// URL"); v.starts_at = fromIstInput(v.starts_at); v.ends_at = fromIstInput(v.ends_at); if (v.starts_at && v.ends_at && v.ends_at <= v.starts_at) throw new Error("End must be after start"); return b ? PUT("/banners/" + b.id, v) : POST("/banners", v); } });
    if (r) { toast(b ? "Banner saved" : "Banner created"); ctx.reload(); }
  };
  $("#badd").addEventListener("click", () => edit());
  $$("[data-bed]", ctx.view).forEach((x) => x.addEventListener("click", () => edit(rows.find((b) => b.id == x.dataset.bed))));
  $$("[data-bdel]", ctx.view).forEach((x) => x.addEventListener("click", async () => {
    if (!(await confirmBox("Delete this banner and its images?"))) return;
    if (await act(x, () => DEL("/banners/" + x.dataset.bdel), "Banner deleted")) ctx.reload();
  }));
  $$("[data-brm]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox(`Remove the ${b.dataset.v} image from this banner? It is deleted from Cloudinary.`, { ok: "Remove image" }))) return;
    if (await act(b, () => DEL(`/banners/${b.dataset.brm}/image?variant=${b.dataset.v}`), "Image removed")) ctx.reload();
  }));
  $$("[data-bimg]", ctx.view).forEach((inp) => inp.addEventListener("change", async () => {
    const file = inp.files[0]; inp.value = ""; if (!file) return;
    try { checkImages([file]); } catch (e) { return toast(e.message, true); }
    const lbl = inp.closest("label"), err = $("#berr"); lbl.classList.add("busy"); err.hidden = true;
    const fd = new FormData(); fd.append("file", file);
    try { await upload(`/banners/${inp.dataset.bimg}/image?variant=${inp.dataset.v}`, fd); toast("Banner image uploaded"); ctx.reload(); }
    catch (e) { lbl.classList.remove("busy"); err.textContent = uploadErr(e); err.hidden = false; toast(uploadErr(e), true); }
  }));
}

/* ---------- FAQs ---------- */
async function contentFaqs(ctx) {
  const rows = await GET("/faqs");
  const ok = ctx.set(`${cmsTabs("faqs")}<div class="tbar"><span class="sub2">${plural(rows.length, "FAQ")} · ${num(rows.filter((x) => x.is_published).length)} published · shown on the FAQ page in this order</span><span class="flex1"></span><button class="btn p sm" id="fadd">+ Add FAQ</button></div>
  <div class="pn flush">${rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th style="width:70px">Order</th><th>Question & answer</th><th>Published</th><th class="r">Actions</th></tr></thead><tbody>
  ${rows.map((x, i) => `<tr><td class="nwr"><button class="btn xs" data-fmv="-1" data-i="${i}" ${i === 0 ? "disabled" : ""} title="Move up">↑</button> <button class="btn xs" data-fmv="1" data-i="${i}" ${i === rows.length - 1 ? "disabled" : ""} title="Move down">↓</button></td>
    <td><b>${esc(x.question)}</b><div class="sub2" style="white-space:pre-wrap;max-width:760px">${esc(x.answer.length > 240 ? x.answer.slice(0, 240) + "…" : x.answer)}</div></td>
    <td>${sw(`data-fpub="${x.id}" aria-label="Published"`, x.is_published)}</td><td class="r nwr"><button class="btn xs" data-fed="${x.id}">Edit</button> <button class="btn xs dg" data-fdel="${x.id}">Delete</button></td></tr>`).join("")}
  </tbody></table></div>` : empty("No FAQs yet")}</div>`);
  if (!ok) return;
  const find = (id) => rows.find((x) => x.id == id);
  const edit = async (x) => {
    const r = await modal({ title: x ? "Edit FAQ" : "New FAQ", ok: x ? "Save" : "Create", body: `${fld({ n: "question", l: "Question", v: x && x.question, req: true, max: 300 })}${fld({ n: "answer", l: "Answer", t: "area", rows: 6, v: x && x.answer, req: true, max: 5000 })}${fld({ n: "is_published", l: "Published", t: "check", v: x ? !!x.is_published : true })}`,
      onOk: (f) => (x ? PUT("/faqs/" + x.id, vals(f)) : POST("/faqs", vals(f))) });
    if (r) { toast(x ? "FAQ saved" : "FAQ added"); ctx.reload(); }
  };
  $("#fadd").addEventListener("click", () => edit());
  $$("[data-fed]", ctx.view).forEach((b) => b.addEventListener("click", () => edit(find(b.dataset.fed))));
  $$("[data-fdel]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox(`Delete the FAQ “${esc(find(b.dataset.fdel).question)}”?`))) return;
    if (await act(b, () => DEL("/faqs/" + b.dataset.fdel), "FAQ deleted")) ctx.reload();
  }));
  $$("[data-fpub]", ctx.view).forEach((cb) => cb.addEventListener("change", async () => {
    const x = find(cb.dataset.fpub);
    try { await PUT("/faqs/" + x.id, { question: x.question, answer: x.answer, is_published: cb.checked }); x.is_published = cb.checked; toast(cb.checked ? "FAQ published" : "FAQ hidden"); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  }));
  $$("[data-fmv]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    const ids = rows.map((x) => x.id), i = +b.dataset.i, j = i + +b.dataset.fmv;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    if (await act(b, () => PUT("/faqs-order", { ids }), "Order saved")) ctx.reload();
  }));
}
