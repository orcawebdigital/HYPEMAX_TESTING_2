/* CMS-driven content pages: About, FAQ, Contact, Policies, 404. */
window.HM_PAGE = async function () {
  const { $, $$, esc, api, accordion, site, waLink, busy, toast, img, I } = HM;
  const page = document.body.dataset.page;
  const S = await site();
  const st = S.settings || {};

  /** Policy/about body: "## Heading" lines + paragraphs + "- " bullets. Always escaped. */
  const prose = (src) => String(src || "").replace(/\r/g, "").split(/\n\s*\n/).map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (/^##\s+/.test(t)) { const [h, ...rest] = t.split("\n"); return `<h2>${esc(h.replace(/^##\s+/, ""))}</h2>${rest.length ? HM.richText(rest.join("\n")) : ""}`; }
    return HM.richText(t);
  }).join("");

  if (page === "about") {
    const a = await api("/api/content/about").catch(() => ({}));
    const im = (S.images || {});
    $("#app").innerHTML = `<div class="wrap pg"><div class="crumbs"><a href="/">Home</a><span>/</span>About us</div>
      <div class="split" style="align-items:start"><div><h1 class="rv">${esc(a.title || "Our story")}</h1><p class="sub rv" style="font-size:1.02rem">${esc(a.intro || "")}</p><div class="prose rv" style="margin-top:16px">${prose(a.body)}</div>
        ${a.mission ? `<div class="card rv" style="margin-top:16px"><h3>Our mission</h3><p style="margin-top:6px">${esc(a.mission)}</p></div>` : ""}</div>
        <div class="rv">${img(im.about || "/img/products/pre-workout-collage.jpg", "HYPEMAX Nutrition products", { w: 900, sizes: "(max-width:820px) 100vw, 560px", attrs: 'style="border-radius:12px;border:1px solid var(--line)"' })}</div></div>
      ${(a.values || []).length ? `<section style="padding-bottom:0"><h2 class="rv">What we stand for</h2><div class="grid">${a.values.map((v, i) => `<div class="card rv"><div style="font:1.6rem Anton;color:var(--red)">0${i + 1}</div><h3 style="margin-top:4px">${esc(v.title)}</h3><p style="margin-top:6px;font-size:.9rem">${esc(v.text)}</p></div>`).join("")}</div></section>` : ""}
      <section class="cta" style="margin-top:30px;border-radius:12px"><h2>Ready to train harder?</h2><div class="row"><a class="btn p" href="/products">Shop HYPEMAX</a></div></section></div>`;
    return;
  }

  if (page === "faq") {
    const faqs = await api("/api/faqs").catch(() => []);
    $("#app").innerHTML = `<div class="wrap pg" style="max-width:860px"><div class="crumbs"><a href="/">Home</a><span>/</span>FAQ</div><h1>Frequently asked questions</h1>
      <div style="margin-top:18px">${faqs.length ? accordion(faqs.map((f) => ({ title: f.question, content: f.answer }))) : '<p class="muted">No FAQs yet.</p>'}</div>
      <div class="card" style="margin-top:24px"><h3>Still have questions?</h3><p style="margin-top:6px">Our team is happy to help.</p><div class="row" style="margin-top:12px"><a class="btn p sm" href="/contact">Contact us</a><a class="btn sm" target="_blank" rel="noopener" href="${esc(waLink(st, "Hello HYPEMAX Team! I have a question."))}">WhatsApp</a></div></div></div>`;
    // FAQPage structured data for search engines
    const ld = document.createElement("script");
    ld.type = "application/ld+json";
    ld.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })) });
    document.head.append(ld);
    return;
  }

  if (page === "contact") {
    const c = await api("/api/content/contact").catch(() => ({}));
    $("#app").innerHTML = `<div class="wrap pg"><div class="crumbs"><a href="/">Home</a><span>/</span>Contact us</div>
      <div class="split" style="align-items:start"><div><h1>${esc(c.title || "Get in touch")}</h1><p class="sub">${esc(c.intro || "")}</p>
        <div class="card" style="margin-top:18px;display:grid;gap:12px">
          ${st.email ? `<div><label>Email</label><p><a class="link" href="mailto:${esc(st.email)}">${esc(st.email)}</a></p></div>` : ""}
          ${st.phone ? `<div><label>Phone / WhatsApp</label><p><a href="tel:+91${esc(String(st.phone).replace(/\D/g, "").slice(-10))}">+91 ${esc(st.phone)}</a></p></div>` : ""}
          ${c.hours || st.businessHours ? `<div><label>Hours</label><p>${esc(c.hours || st.businessHours)}</p></div>` : ""}
          ${st.address ? `<div><label>Address</label><p>${esc(st.address)}</p></div>` : ""}
          <a class="btn" style="background:#25d366;border:0;color:#062" target="_blank" rel="noopener" href="${esc(waLink(st, "Hello HYPEMAX Team! I have a question."))}">${I.wa.replace("<svg", '<svg style="width:18px;fill:#062"')} Chat on WhatsApp</a></div></div>
      <form class="card fg" id="cf" style="margin-top:8px"><h3 class="full" style="margin-bottom:8px">Send us a message</h3>
        <div><label>Your name *</label><input name="name" required maxlength="120" autocomplete="name"></div><div><label>Phone</label><input name="phone" type="tel" maxlength="20" autocomplete="tel"></div>
        <div class="full"><label>Email</label><input name="email" type="email" autocomplete="email"></div>
        <div class="full"><label>Subject</label><input name="subject" maxlength="200"></div>
        <div class="full"><label>Message *</label><textarea name="message" rows="5" required minlength="5" maxlength="4000"></textarea></div>
        <input name="website" tabindex="-1" autocomplete="off" class="sr" aria-hidden="true">
        <div class="full"><button class="btn p">Send message</button><div id="cmsg" style="margin-top:10px"></div></div></form></div></div>`;
    $("#cf").onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      if (!d.email && !d.phone) { $("#cmsg").innerHTML = '<p class="err">Add your email or phone so we can reply.</p>'; return; }
      await busy(e.target.querySelector("button"), () => api("/api/contact", { method: "POST", body: d }));
      e.target.reset();
      $("#cmsg").innerHTML = '<div class="notice good">Thanks! We\'ve received your message and will reply soon.</div>';
    };
    return;
  }

  if (page === "policies") {
    const KEYS = [["privacy", "Privacy"], ["terms", "Terms"], ["shipping", "Shipping"], ["refund", "Returns & refunds"]];
    let slug = location.pathname.split("/")[2] || (location.hash || "").slice(1) || "privacy";
    if (!KEYS.some(([k]) => k === slug)) slug = "privacy";
    const pol = await api("/api/content/policy_" + slug).catch(() => ({}));
    if (location.pathname === "/policies") history.replaceState(null, "", "/policies/" + slug);
    document.title = `${pol.title || "Policies"} | HYPEMAX Nutrition`;
    $("#app").innerHTML = `<div class="wrap pg" style="max-width:860px"><div class="crumbs"><a href="/">Home</a><span>/</span>Policies</div>
      <div class="pills" style="margin-bottom:18px">${KEYS.map(([k, t]) => `<a href="/policies/${k}" class="${k === slug ? "on" : ""}">${esc(t)}</a>`).join("")}</div>
      <h1>${esc(pol.title || "Policy")}</h1><div class="prose" style="margin-top:14px">${pol.body ? prose(pol.body) : '<p class="muted">This policy will be published soon. Contact us with any questions.</p>'}</div></div>`;
    return;
  }

  // 404
  $("#app").innerHTML = `<div class="wrap pg empty"><h1 style="font-size:4rem" class="grad">404</h1><h3>Page not found</h3><p>The page you're looking for doesn't exist or has moved.</p><div class="row" style="justify-content:center;margin-top:16px"><a class="btn p" href="/">Go home</a><a class="btn" href="/products">Shop products</a></div></div>`;
};
