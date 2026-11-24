/* Reviews, Messages (contact + newsletter), Team (admins, roles), Audit log */
"use strict";

/* ---------- reviews ---------- */
route("reviews", ["reviews.manage"], async (ctx) => {
  const st = ctx.query.status || "";
  const rows = await GET("/reviews" + (st ? "?status=" + st : ""));
  const ok = ctx.set(`<div class="ph"><div><h2>Reviews</h2><div class="meta">${plural(rows.length, "review")}${rows.length >= 500 ? " (latest 500)" : ""}</div></div><div class="acts"><button class="btn p" id="radd">+ Add testimonial</button></div></div>
  <div class="tbar"><span class="seg">${[["", "All"], ["pending", "Pending"], ["published", "Published"]].map(([v, l]) => `<a href="#/reviews${v ? "?status=" + v : ""}" class="${st === v ? "on" : ""}">${l}</a>`).join("")}</span></div>
  <div class="pn flush">${rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Rating</th><th>Review</th><th>By</th><th>Product</th><th>Status</th><th>Homepage</th><th class="r">Actions</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${stars(r.rating)}</td><td style="min-width:220px;max-width:420px">${r.title ? `<b>${esc(r.title)}</b><br>` : ""}<span style="white-space:pre-wrap">${esc(r.body)}</span><div class="sub2">${fdt(r.created_at)}</div></td>
    <td>${esc(r.name)}${r.user_email ? `<div class="sub2">${esc(r.user_email)}</div>` : '<div class="sub2">Added by admin</div>'}${r.verified_purchase ? '<span class="bd ok nodot">Verified purchase</span>' : ""}</td>
    <td>${esc(r.product_name || "—")}</td><td>${r.is_published ? '<span class="bd ok">Published</span>' : '<span class="bd wn">Pending</span>'}</td>
    <td><label class="ck" style="margin:0!important" title="Show as a homepage testimonial">${sw(`data-rtest="${r.id}"`, r.is_testimonial)}</label></td>
    <td class="r nwr"><button class="btn xs ${r.is_published ? "" : "p"}" data-rpub="${r.id}">${r.is_published ? "Unpublish" : "Publish"}</button> <button class="btn xs dg" data-rdel="${r.id}">Delete</button></td></tr>`).join("")}
  </tbody></table></div>` : empty(st === "pending" ? "No reviews waiting for moderation" : "No reviews yet")}</div>`);
  if (!ok) return;
  const find = (id) => rows.find((r) => r.id == id);
  $$("[data-rpub]", ctx.view).forEach((b) => b.addEventListener("click", async () => { const r = find(b.dataset.rpub); if (await act(b, () => PUT("/reviews/" + r.id, { is_published: !r.is_published }), r.is_published ? "Review unpublished" : "Review published")) ctx.reload(); }));
  $$("[data-rtest]", ctx.view).forEach((cb) => cb.addEventListener("change", async () => {
    const r = find(cb.dataset.rtest);
    try { await PUT("/reviews/" + r.id, { is_testimonial: cb.checked }); r.is_testimonial = cb.checked; toast(cb.checked ? (r.is_published ? "Shown on homepage" : "Marked as testimonial (publish it to show on the homepage)") : "Removed from homepage"); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  }));
  $$("[data-rdel]", ctx.view).forEach((b) => b.addEventListener("click", async () => { if (!(await confirmBox("Delete this review permanently?"))) return; if (await act(b, () => DEL("/reviews/" + b.dataset.rdel), "Review deleted")) ctx.reload(); }));
  $("#radd").addEventListener("click", async () => {
    const prods = await GET("/products").catch(() => []);
    const r = await modal({ title: "Add testimonial", ok: "Add", body: `<p class="sub2">For feedback received elsewhere (WhatsApp, Instagram…). It is never marked as a verified purchase.</p>
      <div class="g2">${fld({ n: "name", l: "Customer name", req: true, max: 120 })}${fld({ n: "rating", l: "Rating", t: "select", v: 5, opts: [[5, "★★★★★ 5"], [4, "★★★★ 4"], [3, "★★★ 3"], [2, "★★ 2"], [1, "★ 1"]] })}</div>
      ${fld({ n: "title", l: "Title", max: 160 })}${fld({ n: "body", l: "Text", t: "area", rows: 4, req: true, max: 3000 })}
      ${prods.length ? fld({ n: "product_id", l: "Product (optional)", t: "select", opts: [["", "None"], ...prods.map((p) => [p.id, p.name])] }) : ""}
      ${fld({ n: "is_published", l: "Published", t: "check", v: true })}${fld({ n: "is_testimonial", l: "Show on homepage as a testimonial", t: "check", v: true })}`,
      onOk: (f) => POST("/reviews", vals(f)) });
    if (r) { toast("Testimonial added"); ctx.reload(); }
  });
});

/* ---------- messages & newsletter ---------- */
route("messages", ["messages.manage"], async (ctx) => {
  const tab = ctx.query.tab === "newsletter" ? "newsletter" : "inbox";
  const tabs = `<div class="ph"><div><h2>Messages</h2></div></div><nav class="tabs2"><a href="#/messages" class="${tab === "inbox" ? "on" : ""}">Contact messages</a><a href="#/messages?tab=newsletter" class="${tab === "newsletter" ? "on" : ""}">Newsletter subscribers</a></nav>`;
  if (tab === "newsletter") {
    const rows = await GET("/newsletter");
    const ok = ctx.set(`${tabs}<div class="tbar"><span class="sub2">${plural(rows.length, "subscriber")} · ${num(rows.filter((r) => r.is_active).length)} active</span><span class="flex1"></span>${can("customers.export") ? `<a class="btn sm" href="/api/admin/newsletter.csv" download>Export CSV</a>` : ""}</div>
    <div class="pn flush">${rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Email</th><th>Status</th><th>Joined</th></tr></thead><tbody>${rows.map((r) => `<tr><td><a class="lk" href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td>${yesno(r.is_active, "Subscribed", "Unsubscribed")}</td><td class="nwr sub2">${fdt(r.created_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No subscribers yet")}</div>`);
    return ok;
  }
  const st = ctx.query.status || "", page = Math.max(1, +ctx.query.page || 1), limit = 30;
  const rows = await GET(`/messages?${queryStr({ status: st, page, limit })}`);
  const ok = ctx.set(`${tabs}<div class="tbar"><span class="seg">${[["", "All"], ["new", "New"], ["in_progress", "In progress"], ["closed", "Closed"]].map(([v, l]) => `<a href="#/messages${v ? "?status=" + v : ""}" class="${st === v ? "on" : ""}">${l}</a>`).join("")}</span></div>
  ${rows.length ? rows.map((m) => `<div class="msg"><div class="top"><div><b>${esc(m.name)}</b> ${badge(MSG_ST, m.status)}<div class="sub2">${m.email ? `<a class="lk" href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ""}${m.email && m.phone ? " · " : ""}${m.phone ? `<a class="lk" href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : ""}</div></div><span class="sub2">${fdt(m.created_at)}</span></div>
    ${m.subject ? `<div class="strong">${esc(m.subject)}</div>` : ""}<div class="body">${esc(m.message)}</div>
    <form class="ed" data-mid="${m.id}"><select name="status" aria-label="Status">${Object.entries(MSG_ST).map(([k, [l]]) => `<option value="${k}"${m.status === k ? " selected" : ""}>${l}</option>`).join("")}</select><textarea name="admin_note" rows="1" maxlength="500" placeholder="Internal note (not sent to the customer)" aria-label="Internal note">${esc(m.admin_note)}</textarea><button class="btn sm p" type="submit">Save</button></form></div>`).join("")
    : `<div class="pn">${empty(st ? "No messages with this status" : "No contact messages yet")}</div>`}
  ${page > 1 || rows.length === limit ? `<div class="pager" style="border:0"><span>Page ${page}</span><span class="seg"><a href="#" data-pg="${page - 1}" class="${page <= 1 ? "dis" : ""}">‹ Newer</a><a href="#" data-pg="${page + 1}" class="${rows.length < limit ? "dis" : ""}">Older ›</a></span></div>` : ""}`);
  if (!ok) return;
  $$("[data-pg]", ctx.view).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); ctx.setQuery({ page: a.dataset.pg }); }));
  $$("[data-mid]", ctx.view).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = vals(f);
    if (await act($("button", f), () => PUT("/messages/" + f.dataset.mid, v), "Message updated")) { const b = f.closest(".msg").querySelector(".bd"); b.outerHTML = badge(MSG_ST, v.status); }
  }));
});

/* ---------- team ---------- */
route("team", ["admins.manage"], async (ctx) => {
  const [admins, rr] = await Promise.all([GET("/admins"), GET("/roles")]);
  const roles = rr.roles, perms = rr.permissions;
  const roleOpts = roles.map((r) => [r.slug, r.name]);
  const meId = STATE.me.id;
  const ok = ctx.set(`<div class="ph"><div><h2>Team</h2><div class="meta">${plural(admins.length, "admin")}</div></div><div class="acts">${can("audit.view") ? `<a class="btn sm" href="#/audit">Audit log</a>` : ""}<button class="btn p" id="aadd">+ Add admin</button></div></div>
  <div class="pn flush"><div class="tw"><table class="tbl"><thead><tr><th>Admin</th><th>Role</th><th>Status</th><th>Last login</th><th>Added</th><th class="r">Actions</th></tr></thead><tbody>
  ${admins.map((a) => `<tr><td><b>${esc(a.name)}</b>${a.id === meId ? ' <span class="bd or nodot">You</span>' : ""}<div class="sub2">${esc(a.email)}</div></td>
    <td><select data-arole="${a.id}" aria-label="Role" style="width:auto;min-width:150px">${roleOpts.map(([v, l]) => `<option value="${v}"${a.role === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></td>
    <td>${a.is_active ? '<span class="bd ok">Active</span>' : '<span class="bd er">Deactivated</span>'}</td><td class="nwr sub2">${a.last_login_at ? fdt(a.last_login_at) : "Never"}</td><td class="nwr sub2">${fd(a.created_at)}</td>
    <td class="r nwr"><button class="btn xs" data-aname="${a.id}">Rename</button> <button class="btn xs" data-apw="${a.id}">Reset password</button> <button class="btn xs ${a.is_active ? "dg" : ""}" data-aact="${a.id}">${a.is_active ? "Deactivate" : "Activate"}</button>${a.id === meId ? "" : ` <button class="btn xs dg" data-adel="${a.id}">Delete</button>`}</td></tr>`).join("")}
  </tbody></table></div></div>
  <div class="pn flush"><div class="pnh"><h3>Roles & permissions</h3><span class="sub2">Fixed roles. The server enforces every permission.</span></div><div class="tw"><table class="tbl mx"><thead><tr><th>Permission</th>${roles.map((r) => `<th class="c">${esc(r.name)}</th>`).join("")}</tr></thead><tbody>
  ${Object.entries(perms).map(([k, d]) => `<tr><td><code>${esc(k)}</code><div class="sub2">${esc(d)}</div></td>${roles.map((r) => `<td class="c">${r.permissions.includes(k) ? '<span class="yes" aria-label="yes">✓</span>' : '<span class="no" aria-label="no">–</span>'}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div></div>`);
  if (!ok) return;
  const find = (id) => admins.find((a) => a.id == id);
  const pwHint = "At least 8 characters with letters and numbers.";
  $("#aadd").addEventListener("click", async () => {
    const r = await modal({ title: "Add admin", ok: "Create admin", body: `${fld({ n: "name", l: "Name", req: true, max: 120 })}${fld({ n: "email", l: "Email", t: "email", req: true, autocomplete: "off" })}${fld({ n: "password", l: "Temporary password", t: "password", req: true, hint: pwHint + " Share it privately; they can change it under Account.", autocomplete: "new-password" })}${fld({ n: "role", l: "Role", t: "select", v: "order_manager", opts: roleOpts })}`,
      onOk: (f) => POST("/admins", vals(f)) });
    if (r) { toast("Admin created"); ctx.reload(); }
  });
  $$("[data-arole]", ctx.view).forEach((s) => s.addEventListener("change", async () => {
    const a = find(s.dataset.arole), name = s.options[s.selectedIndex].text;
    if (!(await confirmBox(`Change <b>${esc(a.name)}</b>'s role to <b>${esc(name)}</b>? They will be signed out and need to log in again.`, { ok: "Change role", danger: false, title: "Change role" }))) { s.value = a.role; return; }
    try { await PUT("/admins/" + a.id, { role: s.value }); toast("Role updated"); if (a.id === meId) return start(); ctx.reload(); } catch (e) { s.value = a.role; toast(e.message, true); }
  }));
  $$("[data-aact]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    const a = find(b.dataset.aact);
    if (a.is_active && !(await confirmBox(`Deactivate <b>${esc(a.name)}</b>? They are signed out immediately and can't log in.`, { ok: "Deactivate" }))) return;
    if (await act(b, () => PUT("/admins/" + a.id, { is_active: !a.is_active }), a.is_active ? "Admin deactivated" : "Admin activated")) ctx.reload();
  }));
  $$("[data-adel]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    const a = find(b.dataset.adel);
    if (!(await confirmBox(`Permanently delete admin <b>${esc(a.name)}</b> (${esc(a.email)})? This can't be undone. Their audit history is kept.`, { ok: "Delete admin" }))) return;
    if (await act(b, () => DEL("/admins/" + a.id), "Admin deleted")) ctx.reload();
  }));
  $$("[data-apw]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    const a = find(b.dataset.apw);
    const r = await modal({ title: "Reset password", ok: "Set password", small: true, body: `<p>Set a new password for <b>${esc(a.name)}</b>. They will be signed out everywhere.</p>${fld({ n: "password", l: "New password", t: "password", req: true, hint: pwHint, autocomplete: "new-password" })}`,
      onOk: (f) => PUT("/admins/" + a.id, { password: vals(f).password }) });
    if (r) toast("Password reset");
  }));
  $$("[data-aname]", ctx.view).forEach((b) => b.addEventListener("click", async () => {
    const a = find(b.dataset.aname);
    const r = await modal({ title: "Rename admin", small: true, body: fld({ n: "name", l: "Name", v: a.name, req: true, max: 120 }), onOk: (f) => PUT("/admins/" + a.id, { name: vals(f).name }) });
    if (r) { toast("Name updated"); ctx.reload(); }
  }));
});

/* ---------- audit log ---------- */
route("audit", ["audit.view"], async (ctx) => {
  const page = Math.max(1, +ctx.query.page || 1);
  const [data, admins] = await Promise.all([GET("/audit-logs?" + queryStr({ page, limit: 50, admin_id: ctx.query.admin_id, entity_type: ctx.query.entity_type })), can("admins.manage") ? GET("/admins").catch(() => []) : Promise.resolve([])]);
  const ENT = ["admin", "product", "order", "customer", "coupon", "content", "banner", "faq", "category", "review", "newsletter"];
  const pretty = (d) => { if (d == null || d === "") return ""; let o = d; if (typeof d === "string") { try { o = JSON.parse(d); } catch { return esc(d); } } return esc(JSON.stringify(o, null, 2)); };
  const ok = ctx.set(`<div class="ph"><div><h2>Audit log</h2><div class="meta">${plural(data.total, "entry", "entries")}</div></div></div>
  <div class="tbar">${admins.length ? `<select id="aud_a" aria-label="Admin"><option value="">All admins</option>${admins.map((a) => `<option value="${a.id}"${ctx.query.admin_id == a.id ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>` : ""}
    <select id="aud_e" aria-label="Entity"><option value="">All entities</option>${ENT.map((e) => `<option${ctx.query.entity_type === e ? " selected" : ""}>${e}</option>`).join("")}</select></div>
  <div class="pn flush">${data.rows.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Time (IST)</th><th>Admin</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead><tbody>
  ${data.rows.map((l) => { const d = pretty(l.details); return `<tr><td class="nwr sub2">${fdt(l.created_at)}</td><td>${esc(l.admin_name || "—")}<div class="sub2">${esc(l.admin_email || "")}</div></td><td><code>${esc(l.action)}</code></td><td class="nwr">${esc(l.entity_type || "")}${l.entity_id ? ` <span class="mono">#${esc(l.entity_id)}</span>` : ""}</td>
    <td style="min-width:200px">${d ? `<details class="dj"><summary>View details</summary><pre class="json">${d}</pre></details>` : '<span class="sub2">—</span>'}</td><td class="mono sub2">${esc(l.ip || "")}</td></tr>`; }).join("")}
  </tbody></table></div>` : empty("No audit entries")}<div id="apg"></div></div>`);
  if (!ok) return;
  if (data.total > data.limit) { const pg = pager(data.total, page, data.limit, (p) => ctx.setQuery({ page: p })); $("#apg").innerHTML = pg.html; pg.bind($("#apg")); }
  const a = $("#aud_a"); a && a.addEventListener("change", () => ctx.setQuery({ admin_id: a.value, page: "" }));
  $("#aud_e").addEventListener("change", (e) => ctx.setQuery({ entity_type: e.target.value, page: "" }));
});
