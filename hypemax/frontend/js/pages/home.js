/* Home page. Hero letter animation, scroll-pinned 3D tub sequence and smooth wheel scrolling are
   carried over from the original site; all text/products now come from the CMS + database. */
window.HM_PAGE = async function () {
  const { $, $$, esc, api, site, card, accordion, img, inr } = HM;
  document.body.insertAdjacentHTML("afterbegin", '<div id="ld"><img src="/img/logo.png" alt=""></div>');
  const [S, products, faqs, testimonials] = await Promise.all([site(), api("/api/products").catch(() => []), api("/api/faqs").catch(() => []), api("/api/testimonials").catch(() => [])]);
  const H = S.homepage || {}, images = S.images || {};
  const hero = products.find((p) => p.featured && p.purchasable) || products.find((p) => p.purchasable) || products[0];
  // Transparent cut-out used by the 3D animation (CMS "hero" slot, else the original asset)
  const tub = images.hero || "/img/product.png";

  const title = H.heroTitle || "UNLEASH YOUR MAX POTENTIAL.";
  const T = title.split(" "); let n = 0;
  const hw = T.map((w, i) => `<span class="w">${[...w].map((c) => `<span class="lt${i >= T.length - 2 ? " hot" : ""}" style="--i:${n++}">${esc(c)}</span>`).join("")}</span>`).join(" ");
  const bt = [[.12, .2, 120], [.86, .18, 96], [.07, .74, 84], [.655, .15, 78], [.205, .885, 70]].map((v, i) => `<span class="bt" style="--x:${v[0] * 100}%;--y:${v[1] * 100}%;--s:${v[2] * .5}px;--r:${i * 22 - 20}deg;--i:${i}"></span>`).join("");
  const banners = (S.banners || []);
  const heroBanners = banners.filter((b) => b.placement === "hero" && b.image_url);
  const promos = banners.filter((b) => b.placement === "promo");
  const strips = banners.filter((b) => b.placement === "strip");
  const bannerHtml = (b) => `<a class="bn rv" href="${esc(b.link_url || "/products")}">${b.image_url ? `<picture>${b.mobile_image_url ? `<source media="(max-width:640px)" srcset="${esc(HM.cld(b.mobile_image_url, 700))}">` : ""}${img(b.image_url, b.title || "", { w: 1200, sizes: "(max-width:640px) 100vw, 600px" })}</picture>` : ""}<div class="bt2">${b.title ? `<h3>${esc(b.title)}</h3>` : ""}${b.subtitle ? `<p>${esc(b.subtitle)}</p>` : ""}${b.link_label ? `<span class="btn p sm">${esc(b.link_label)}</span>` : ""}</div></a>`;
  const active = products.filter((p) => p.status !== "discontinued");

  $("#app").innerHTML = `
<header class="hero"><div class="rev"></div><div class="rings"></div>${bt}<span class="ghost">HYPE</span>
 <div class="wrap"><div><span class="tag">${esc(H.heroEyebrow || "Premium sports nutrition")}</span>
  <h1 aria-label="${esc(title)}">${hw}</h1><p class="sub">${esc(H.heroText || "")}</p>
  ${hero && hero.price ? `<p class="price-hint">${esc(hero.name)} <b>${inr(hero.price)}</b> ${hero.mrp > hero.price ? `<s class="muted">${inr(hero.mrp)}</s> <span class="tag ok">${hero.discount_percent}% off</span>` : ""}</p>` : ""}
  <div class="row">${hero ? `<a class="btn p lg" href="/products/${esc(hero.slug)}">${esc(H.heroCtaLabel || "Shop now")}</a>` : ""}<a class="btn lg" href="/products">Explore products</a></div></div>
  ${hero ? `<img id="hA" class="tubA" src="${esc(tub)}" alt="" aria-hidden="true" fetchpriority="high" decoding="async">` : ""}</div></header>
${strips.map((b) => `<div class="bar" style="text-transform:none">${b.link_url ? `<a href="${esc(b.link_url)}">${esc(b.title || "")} ${b.link_label ? "→ " + esc(b.link_label) : ""}</a>` : esc(b.title || "")}</div>`).join("")}
${hero ? `<section id="in" style="padding:0"><div class="pin"><div class="dk"></div><div class="nw"><div class="num" id="inN">01</div></div><div id="inBar"></div><div class="ihw"><div class="ih" id="inH"></div></div><div class="ic">${[1, 2, 3, 4].map((i) => `<button data-s="${i - 1}" aria-label="Step ${i}">0${i}</button>`).join("")}</div><div class="icap" id="inC"></div></div></section>` : ""}
<section id="shop" style="background:var(--panel)"><div class="wrap"><div class="sec-h"><div><h2 class="rv">${esc(H.productsTitle || "Shop HYPEMAX")}</h2><p class="sub rv">${esc(H.productsSubtitle || "")}</p></div><a class="link rv" href="/products">View all →</a></div>
 <div class="grid">${active.map((p) => card(p, { imgOverride: hero && p.id === hero.id ? tub : null })).join("") || '<p class="muted">Products coming soon.</p>'}</div></div></section>
${heroBanners.length || promos.length ? `<section><div class="wrap"><div class="banners">${[...heroBanners, ...promos].map(bannerHtml).join("")}</div></div></section>` : ""}
<section><div class="wrap split"><div class="rv"><h2>${esc(H.introTitle || "")}</h2></div><div class="rv"><p class="sub" style="max-width:none">${esc(H.introText || "")}</p>
 ${(H.stats || []).length ? `<div class="stat">${H.stats.map((s) => `<div><b>${esc(s.title)}</b><span>${esc(s.text)}</span></div>`).join("")}</div>` : ""}</div></div></section>
${(H.why || []).length ? `<section class="why" style="background:var(--panel)"><div class="wrap"><h2 class="rv">${esc(H.whyTitle || "Why HYPEMAX")}</h2><div class="grid">${H.why.map((c, i) => `<div class="card rv"><div class="n">0${i + 1}</div><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></div>`).join("")}</div></div></section>` : ""}
${testimonials.length ? `<section><div class="wrap"><h2 class="rv">${esc(H.testimonialsTitle || "What athletes say")}</h2><div class="grid">${testimonials.map((r) => `<div class="card rv"><div class="stars">${"★".repeat(r.rating)}</div>${r.title ? `<h3 style="margin-top:6px;font-size:1rem">${esc(r.title)}</h3>` : ""}<p style="color:#ddd">“${esc(r.body)}”</p><p class="small" style="margin-top:8px"><b style="color:#fff">${esc(r.name)}</b>${r.verified_purchase ? ' <span class="vp">✓ Verified buyer</span>' : ""}</p></div>`).join("")}</div></div></section>` : ""}
${faqs.length ? `<section><div class="wrap" style="max-width:820px"><h2 class="rv">Questions?</h2><div class="rv" style="margin-top:16px">${accordion(faqs.slice(0, 5).map((f) => ({ title: f.question, content: f.answer })))}</div><p style="margin-top:14px"><a class="link" href="/faq">All FAQs →</a></p></div></section>` : ""}
<section class="cta"><div class="wrap rv"><h2>${esc(H.ctaTitle || "Your next session starts here.")}</h2><p class="sub" style="margin:10px auto 0">${esc(H.ctaText || "")}</p>
 <div class="row">${hero && hero.purchasable ? `<button class="btn p lg" data-add="${hero.id}" data-fl="${esc((hero.flavours || [])[0] || "")}">Add ${esc(hero.name)} to cart</button>` : ""}</div>
 <h3 style="margin-top:36px">${esc(H.newsletterTitle || "Join the HYPEMAX crew")}</h3><p class="sub" style="margin:6px auto 0">${esc(H.newsletterText || "")}</p>
 <form class="newsl" id="hnl"><input type="email" name="email" required placeholder="Your email" aria-label="Email"><button class="btn p">Subscribe</button></form></div></section>`;

  $("#hnl").onsubmit = async (e) => {
    e.preventDefault();
    await HM.busy(e.target.querySelector("button"), () => api("/api/newsletter", { method: "POST", body: { email: e.target.email.value } }));
    e.target.reset(); HM.toast("You're subscribed!", "ok");
  };
  setTimeout(() => { const l = $("#ld"); if (l) { l.style.opacity = 0; setTimeout(() => l.remove(), 500); } }, 450);
  if (hero) travel(tub);
  smoothWheel();

  // ---------- original scroll-pinned 3D tub animation ----------
  function travel(src0) {
    const lerp = (x, y, t) => x + (y - x) * t, cl = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)), ez = (t) => (t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2), R0 = matchMedia("(prefers-reduced-motion:reduce)").matches;
    const STEPS = [["TRANSPARENT<br>INGREDIENTS", "Know what is in<br>every scoop."], ["BUILT FOR<br>TRAINING", "Energy. Focus.<br>Performance."], ["30<br>SERVINGS", "One tub.<br>A month of sessions."], ["HYPE<br>MAX", "Unleash your<br>max potential."]], ANG = [0, 180, 360, 720], PC = ["#0d0606", "#3b0b0b", "#4a1606", "#2a0707"];
    function circ(s) { const p = $(".pin"); if (!p) return; if (R0) { p.style.setProperty("--pc", PC[s]); return; } const e = document.createElement("div"), r = document.createElement("div"); e.className = "cir"; r.className = "rg"; e.style.background = PC[s]; p.insertBefore(e, $(".nw")); p.insertBefore(r, $(".nw")); e.onanimationend = () => { p.style.setProperty("--pc", PC[s]); e.remove(); }; r.onanimationend = () => r.remove(); }
    function swap(el, h, ins) { if (ins || R0) { el.innerHTML = h; return; } el.style.cssText = "transition:translate .24s,opacity .24s;translate:0 -10px;opacity:0"; setTimeout(() => { el.innerHTML = h; el.style.cssText = "translate:0 14px;opacity:0"; void el.offsetWidth; el.style.cssText = "transition:translate .46s cubic-bezier(.22,1,.36,1),opacity .46s;translate:0 0;opacity:1"; }, 280); }
    function setStep(s, ins) { swap($("#inN"), "0" + (s + 1), ins); swap($("#inH"), STEPS[s][0], ins); swap($("#inC"), STEPS[s][1], ins); $$(".ic button").forEach((b, i) => b.classList.toggle("on", i === s)); }
    const src = esc(src0);
    new Promise((r) => { const i = new Image(); i.onload = () => r(i.width / i.height); i.onerror = () => r(.9); i.src = src0; }).then((ar) => {
      document.documentElement.style.setProperty("--ar", ar);
      const tr = document.createElement("div"); tr.id = "tr"; tr.innerHTML = `<img class="f" src="${src}" alt=""><img class="k" src="${src}" alt=""><img class="l" src="/img/logo.png" alt="">`; document.body.append(tr);
      const st = document.createElement("div"); st.id = "st"; const rn = (i) => { const x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); };
      const pcs = [...Array(20)].map((_, i) => { const e = document.createElement("i"); e.className = "sp"; st.append(e); return { e, a: rn(i) * 6.283, ph: i / 20 + rn(i + 50) * .03, sp: (rn(i + 9) - .5) * 720, sz: .7 + rn(i + 3) * .7 }; }); document.body.append(st);
      const c0 = $("#shop .pc .pimg img"); c0 && (c0.style.visibility = "hidden");
      $$(".ic button").forEach((b) => (b.onclick = () => { const S = $("#in").getBoundingClientRect(); scrollTo({ top: scrollY + S.top + (+b.dataset.s * .19 + .095) * (S.height - $(".pin").offsetHeight), behavior: "smooth" }); }));
      let ry = 0, from = 0, to = 0, t0 = -1e9, dur = 1, step = -1;
      const L = (u, v, t) => { const o = {}; for (const k in u) o[k] = lerp(u[k], v[k], t); return o; };
      function loop(now) {
        const vh = innerHeight, vw = innerWidth, H = $("#hA").getBoundingClientRect(), S = $("#in").getBoundingClientRect(), B = $("#inBar").getBoundingClientRect(), N = $("#shop").getBoundingClientRect(), C = c0 && c0.getBoundingClientRect();
        const pv = $(".pin").offsetHeight || vh, p = cl(-S.top / Math.max(1, S.height - pv)), q = cl((p - .76) / .24), sn = Math.floor(Math.min(p, .759) / .19);
        if (sn !== step) { const first = step < 0; step = sn; from = ry; to = ANG[sn]; if (first || R0) { ry = from = to; setStep(sn, 1); circ(sn); } else { circ(sn); dur = 720 * cl(Math.abs(to - ry) / 180, .4, 2); t0 = now; setTimeout(() => setStep(sn), .38 * Math.min(dur, 720)); } }
        ry = now - t0 < dur ? lerp(from, to, -(Math.cos(Math.PI * (now - t0) / dur) - 1) / 2) : to;
        const fl = R0 ? 0 : Math.sin(now / 4600 * 6.283), bob = R0 ? 0 : Math.sin(now / 2600 * 6.283) * 6;
        let s = { x: H.left + H.width / 2, y: H.top + H.height / 2 + fl * 9, h: H.height, rz: fl * .6, ry: 0 };
        const b = { x: B.left + B.width / 2, y: B.top + B.height / 2 + bob, h: B.height, rz: 14, ry: ry + 720 * q }, p1 = cl(1 - S.top / vh), p3 = cl((vh - N.top) / (.7 * vh));
        if (p1 > 0) s = L(s, b, ez(p1)); if (p3 > 0 && C && C.height) s = L(s, { x: C.left + C.width / 2, y: C.top + C.height / 2, h: C.height * .9, rz: 0, ry: Math.round(b.ry / 360) * 360 }, ez(p3));
        const w = s.h * ar; tr.style.width = w + "px"; tr.style.height = s.h + "px"; tr.style.transform = `translate(${s.x - w / 2}px,${s.y - s.h / 2}px) perspective(1400px) rotateZ(${s.rz}deg) rotateY(${s.ry}deg)`;
        // keep the travelling tub under the sticky header once it has landed in the product card
        tr.style.zIndex = p3 >= 1 ? 1 : 5;
        const f = 1 - cl(4 * q); $$(".nw,.ihw,.ic,.icap").forEach((e) => (e.style.opacity = f)); $(".dk").style.opacity = cl(3.5 * q) * .42;
        const R = .55 * Math.hypot(vw, vh), bs = .085 * Math.min(vw, vh), cy = B.top + B.height / 2;
        pcs.forEach((o) => { const t = cl((q - .45 * o.ph) / .55); if (R0 || q <= 0 || q >= 1 || t <= 0 || t >= 1) { o.e.style.opacity = 0; return; } const r = (.06 + t ** 1.5 * .95) * R; o.e.style.opacity = Math.sin(Math.PI * t) * cl(5 * q) * cl(6 * (1 - q)); o.e.style.transform = `translate(${vw / 2 + Math.cos(o.a) * r}px,${cy + Math.sin(o.a) * r * .8}px) translate(-50%,-50%) rotate(${o.sp * t}deg) scale(${(.2 + 1.7 * t) * o.sz * bs / 44})`; });
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    });
  }

  // ---------- original smooth wheel scrolling (desktop, motion allowed) ----------
  function smoothWheel() {
    if (matchMedia("(pointer:coarse),(prefers-reduced-motion:reduce)").matches) return;
    let tg = 0, cu = 0, raf = 0, last = 0; const mx = () => document.documentElement.scrollHeight - innerHeight;
    const st = (t) => { const dt = Math.min(50, t - last); last = t; cu += (tg - cu) * (1 - Math.exp(-dt / 120)); if (Math.abs(tg - cu) < .5) { scrollTo(0, tg); raf = 0; return; } scrollTo(0, cu); raf = requestAnimationFrame(st); };
    addEventListener("wheel", (e) => { if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.target.closest(".tblw,.gal .track,.search-pop")) return; e.preventDefault(); if (!raf) { tg = cu = scrollY; last = performance.now(); raf = requestAnimationFrame(st); } tg = Math.min(mx(), Math.max(0, tg + e.deltaY)); }, { passive: false });
    ["keydown", "pointerdown"].forEach((v) => addEventListener(v, () => { cancelAnimationFrame(raf); raf = 0; }));
  }
};