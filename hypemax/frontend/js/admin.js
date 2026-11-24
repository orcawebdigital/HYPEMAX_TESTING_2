/* HYPEMAX admin core: helpers, API client, UI widgets, charts, router, shell, login, account.
   Page modules in /js/admin/*.js register routes with route(). No inline scripts or handlers (CSP). */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const IST_MS = 330 * 60e3;
const TZ = { timeZone: "Asia/Kolkata" };

/* ---------- formatting ---------- */
const num = (n) => Number(n || 0).toLocaleString("en-IN");
const inr = (p) => {
  if (p === null || p === undefined || p === "") return "—";
  const v = Number(p);
  return (v < 0 ? "−₹" : "₹") + (Math.abs(v) / 100).toLocaleString("en-IN", { minimumFractionDigits: v % 100 ? 2 : 0, maximumFractionDigits: 2 });
};
const rup = (p) => (p === null || p === undefined || p === "" ? "" : String(Number(p) / 100));
const pct = (n) => `${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const fdt = (d) => (d ? new Date(d).toLocaleString("en-IN", { ...TZ, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—");
const fd = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { ...TZ, day: "2-digit", month: "short", year: "numeric" }) : "—");
const istDay = (d) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
const toIstInput = (iso) => (iso ? new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 16) : "");
const fromIstInput = (v) => (v ? new Date(v + ":00+05:30").toISOString() : null);
const dateInput = (v) => (!v ? "" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : istDay(v));
const plural = (n, w, pl) => `${num(n)} ${Number(n) === 1 ? w : pl || (/y$/.test(w) && !/[aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s")}`;
const slugify = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);

/* ---------- status badges ---------- */
const ORDER_ST = { pending_payment: ["Awaiting payment", "wn"], order_placed: ["Order placed", "in"], payment_confirmed: ["Payment confirmed", "in"], processing: ["Processing", "or"], packed: ["Packed", "or"], shipped: ["Shipped", "pu"], out_for_delivery: ["Out for delivery", "pu"], delivered: ["Delivered", "ok"], cancelled: ["Cancelled", "er"], returned: ["Returned", "mu"] };
const PAY_ST = { pending: ["Pending", "wn"], successful: ["Successful", "ok"], failed: ["Failed", "er"], refunded: ["Refunded", "mu"], partially_refunded: ["Partially refunded", "or"] };
const PROD_ST = { draft: ["Draft", "mu"], upcoming: ["Upcoming", "in"], coming_soon: ["Coming soon", "or"], active: ["Active", "ok"], out_of_stock: ["Out of stock", "er"], discontinued: ["Discontinued", "mu"] };
const MSG_ST = { new: ["New", "or"], in_progress: ["In progress", "in"], closed: ["Closed", "mu"] };
const badge = (map, v, label) => { const m = map[v] || [String(v || "—").replace(/_/g, " "), "mu"]; return `<span class="bd ${m[1]}">${esc(label || m[0])}</span>`; };
const yesno = (v, y = "Yes", n = "No", yc = "ok", nc = "mu") => `<span class="bd ${v ? yc : nc}">${v ? y : n}</span>`;

/* ---------- API ---------- */
const csrf = () => (document.cookie.match(/(?:^|;\s*)hm_csrf=([^;]+)/) || [])[1] || "";
const ERR_MSG = { 403: "You don't have permission to do that.", 404: "Not found.", 429: "Too many requests. Please wait a moment and try again.", 500: "Server error. Please try again." };
function apiError(status, j) {
  const e = new Error((j && j.error) || ERR_MSG[status] || `Request failed (${status})`);
  e.status = status; e.code = j && j.code; return e;
}
async function api(path, { method = "GET", body, retried } = {}) {
  const opt = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (method !== "GET") opt.headers["X-CSRF-Token"] = decodeURIComponent(csrf());
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch("/api/admin" + path, opt); } catch { throw new Error("Network error. Is the server running?"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 403 && j.code === "CSRF" && !retried) { await fetch("/api/config", { credentials: "same-origin" }).catch(() => {}); return api(path, { method, body, retried: true }); }
    if (r.status === 401 && path !== "/login" && STATE.me) { sessionExpired(); }
    throw apiError(r.status, j);
  }
  return j;
}
const GET = (p) => api(p);
const POST = (p, b) => api(p, { method: "POST", body: b ?? {} });
const PUT = (p, b) => api(p, { method: "PUT", body: b ?? {} });
const DEL = (p) => api(p, { method: "DELETE" });

/** Multipart upload with progress (XHR gives upload progress events, fetch doesn't). */
function upload(path, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/admin" + path);
    x.withCredentials = true;
    x.setRequestHeader("X-CSRF-Token", decodeURIComponent(csrf()));
    x.setRequestHeader("Accept", "application/json");
    if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status >= 200 && x.status < 300) resolve(j);
      else { if (x.status === 401) sessionExpired(); reject(apiError(x.status, j)); }
    };
    x.onerror = () => reject(new Error("Network error during upload."));
    x.send(fd);
  });
}
const IMG_TYPES = /^image\/(png|jpe?g|webp|avif)$/;
function checkImages(files) {
  for (const f of files) {
    if (!IMG_TYPES.test(f.type)) throw new Error(`${f.name}: only PNG, JPG, WEBP or AVIF images are allowed.`);
    if (f.size > 8 * 1024 * 1024) throw new Error(`${f.name}: image must be 8 MB or smaller.`);
  }
}
const uploadErr = (e) => (e.code === "CLOUDINARY_MISSING" ? "Image uploads are not configured yet: Cloudinary is missing on the server (add CLOUDINARY_URL to the backend environment). Nothing was uploaded." : e.message);

/* ---------- state & permissions ---------- */
const STATE = { me: null, features: {}, perms: [] };
const can = (...p) => STATE.perms.includes("*") || p.some((x) => STATE.perms.includes(x));
const isSuper = () => STATE.me && STATE.me.role === "super_admin";

/* ---------- toast ---------- */
function toast(t, err) {
  const m = $("#m"); if (!m) return;
  m.textContent = t; m.className = "toast show" + (err ? " er" : "");
  clearTimeout(m._t); m._t = setTimeout(() => (m.className = "toast" + (err ? " er" : "")), err ? 5500 : 3000);
}

/* ---------- button busy state ---------- */
async function busy(btn, fn) {
  if (btn && btn.classList.contains("busy")) return;
  btn && btn.classList.add("busy");
  try { return await fn(); } finally { btn && btn.classList.remove("busy"); }
}
/** Run an action from a button: busy state + toast on success/error. Returns result or undefined on error. */
async function act(btn, fn, okMsg) {
  try { const r = await busy(btn, fn); if (okMsg) toast(okMsg); return r ?? true; } catch (e) { toast(e.message, true); }
}

/* ---------- form fields ---------- */
/** o: {n name, l label, t type, v value, opts [[v,l]], hint, cls, ph, rows, req, dis, attrs, step, min, max} */
function fld(o) {
  const t = o.t || "text", id = "f_" + o.n + "_" + Math.random().toString(36).slice(2, 7);
  const common = `name="${esc(o.n)}" id="${id}"${o.dis ? " disabled" : ""}${o.req ? " required" : ""}${o.ph ? ` placeholder="${esc(o.ph)}"` : ""}${o.max ? ` maxlength="${o.max}"` : ""} ${o.attrs || ""}`;
  const hint = o.hint ? `<div class="hint">${o.hint}</div>` : "";
  if (t === "check") return `<div class="fld ${o.cls || ""}"><label class="ck"><input type="checkbox" ${common}${o.v ? " checked" : ""}> ${esc(o.l)}</label>${hint}</div>`;
  let input;
  if (t === "area") input = `<textarea ${common} rows="${o.rows || 3}"${o.code ? ' class="code"' : ""}>${esc(o.v)}</textarea>`;
  else if (t === "select") input = `<select ${common}>${(o.opts || []).map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(o.v ?? "") ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  else input = `<input type="${t}" ${common} value="${esc(o.v)}"${o.step ? ` step="${o.step}"` : t === "number" ? ' step="any"' : ""}${o.min !== undefined ? ` min="${o.min}"` : ""}${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ""}>`;
  return `<div class="fld ${o.cls || ""}"><label for="${id}">${esc(o.l)}${o.req ? " *" : ""}</label>${input}${hint}</div>`;
}
/** Read named fields of a form into an object. Checkboxes -> boolean; data-arr checkboxes -> array of values. */
function vals(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled && !el.dataset.keep) continue;
    if (el.type === "checkbox" && el.dataset.arr !== undefined) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); }
    else if (el.type === "checkbox") o[el.name] = el.checked;
    else if (el.type === "file" || el.type === "submit" || el.type === "button") continue;
    else o[el.name] = el.value;
  }
  return o;
}

/* ---------- modal & confirm ---------- */
/** modal({title, body, ok, danger, wide, small, onOk(form, box) -> value (throw to keep open), onOpen(box), cancel}) -> Promise<value|null> */
function modal(o) {
  return new Promise((resolve) => {
    const w = document.createElement("div");
    w.className = "mdl";
    w.innerHTML = `<div class="box ${o.wide ? "wide" : o.small ? "sm" : ""}" role="dialog" aria-modal="true"><form novalidate><div class="mh"><h3>${esc(o.title)}</h3><button type="button" class="x" data-x aria-label="Close">×</button></div>
      <div class="mb"><div class="errbox" hidden></div>${o.body || ""}</div>
      <div class="mf">${o.cancel === false ? "" : `<button type="button" class="btn" data-x>${esc(o.cancel || "Cancel")}</button>`}${o.ok === false ? "" : `<button class="btn ${o.danger ? "dg" : "p"}" type="submit">${esc(o.ok || "Save")}</button>`}</div></form></div>`;
    document.body.appendChild(w);
    const form = $("form", w), errb = $(".errbox", w);
    const close = (v) => { w.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    w.addEventListener("mousedown", (e) => { if (e.target === w) close(null); });
    $$("[data-x]", w).forEach((b) => b.addEventListener("click", () => close(null)));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("button[type=submit]", form);
      errb.hidden = true;
      try {
        const reqd = $$("[required]", form).find((el) => !String(el.value).trim());
        if (reqd) { reqd.focus(); throw new Error(`${(form.querySelector(`label[for="${reqd.id}"]`)?.textContent || "This field").replace(" *", "")} is required.`); }
        const v = o.onOk ? await busy(btn, () => o.onOk(form, w)) : true;
        close(v === undefined ? true : v);
      } catch (x) { errb.textContent = x.message; errb.hidden = false; }
    });
    if (o.onOpen) o.onOpen(w, close);
    const first = $("input:not([type=hidden]):not([type=checkbox]),textarea,select", w) || $("button[type=submit]", w);
    first && setTimeout(() => first.focus(), 30);
  });
}
const confirmBox = (msg, { title = "Are you sure?", ok = "Delete", danger = true } = {}) =>
  modal({ title, body: `<p>${msg}</p>`, ok, danger, small: true }).then((v) => !!v);

/* ---------- small widgets ---------- */
const empty = (t = "No data yet") => `<div class="nodata">${esc(t)}</div>`;
const errBox = (e) => `<div class="errbox">${esc(e.message || e)}</div>`;
const kpi = (label, value, o = {}) => `<div class="kpi ${o.cls || ""}"><span>${esc(label)}</span><b title="${esc(value)}">${esc(value)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</div>`;
const sw = (attrs, on, dis) => `<label class="sw"><input type="checkbox" ${attrs}${on ? " checked" : ""}${dis ? " disabled" : ""}><i></i></label>`;
function pager(total, page, limit, onPage) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total ? (page - 1) * limit + 1 : 0, to = Math.min(total, page * limit);
  const html = `<div class="pager"><span>${num(from)}–${num(to)} of ${num(total)}</span><span class="seg"><a href="#" data-pg="${page - 1}" class="${page <= 1 ? "dis" : ""}">‹ Prev</a><a class="on">Page ${page} / ${pages}</a><a href="#" data-pg="${page + 1}" class="${page >= pages ? "dis" : ""}">Next ›</a></span></div>`;
  return { html, bind: (root) => $$("[data-pg]", root).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); onPage(+a.dataset.pg); })) };
}
const stars = (n) => `<span class="stars" title="${n} of 5">${"★".repeat(n)}<span style="opacity:.25">${"★".repeat(5 - n)}</span></span>`;
const queryStr = (o) => Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== null && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

/* ---------- date range filter ---------- */
const RANGES = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["year", "This year"], ["all", "All time"], ["custom", "Custom"]];
function rangeBar(q, { allowNone } = {}) {
  const cur = q.range || (allowNone ? "" : "30d");
  const opts = (allowNone ? [["", "Any date"]] : []).concat(RANGES);
  return `<div class="tbar rbar"><span class="seg">${opts.map(([v, l]) => `<button type="button" data-range="${v}" class="${cur === v ? "on" : ""}">${l}</button>`).join("")}</span>
    <span class="rcust" ${cur === "custom" ? "" : "hidden"} style="display:${cur === "custom" ? "inline-flex" : "none"};gap:6px;align-items:center"><input type="date" class="rfrom" value="${esc(q.from || "")}" aria-label="From date"><span class="muted">to</span><input type="date" class="rto" value="${esc(q.to || "")}" aria-label="To date"><button type="button" class="btn sm p rapply">Apply</button></span></div>`;
}
function bindRange(root, onChange) {
  const bar = $(".rbar", root); if (!bar) return;
  const cust = $(".rcust", bar);
  $$("[data-range]", bar).forEach((b) => b.addEventListener("click", () => {
    $$("[data-range]", bar).forEach((x) => x.classList.toggle("on", x === b));
    if (b.dataset.range === "custom") { cust.hidden = false; cust.style.display = "inline-flex"; const f = $(".rfrom", bar); if (!f.value) { const d = new Date(Date.now() - 6 * 864e5); f.value = istDay(d); $(".rto", bar).value = istDay(new Date()); } f.focus(); return; }
    cust.style.display = "none";
    onChange({ range: b.dataset.range, from: "", to: "" });
  }));
  $(".rapply", bar).addEventListener("click", () => {
    const from = $(".rfrom", bar).value, to = $(".rto", bar).value;
    if (!from || !to) return toast("Choose both a start and an end date", true);
    if (from > to) return toast("Start date must be before the end date", true);
    onChange({ range: "custom", from, to });
  });
}

/* ---------- charts (hand-rolled SVG) ---------- */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const intMax = (v) => { if (v <= 4) return 4; const m = niceMax(v); return m % 4 ? Math.ceil(m / 4) * 4 : m; };
function shortNum(v, money) {
  const x = money ? v / 100 : v, pre = money ? "₹" : "";
  if (Math.abs(x) >= 1e7) return pre + +(x / 1e7).toFixed(1) + "Cr";
  if (Math.abs(x) >= 1e5) return pre + +(x / 1e5).toFixed(1) + "L";
  if (Math.abs(x) >= 1e3) return pre + +(x / 1e3).toFixed(1) + "k";
  return pre + +x.toFixed(x < 10 && x % 1 ? 1 : 0);
}
/** Build buckets of IST days (or months for long ranges) between from..to, filled from rows keyed by `d`. */
function buckets(rows, range, fields) {
  const today = istDay(new Date());
  let from = range && range.from ? istDay(range.from) : null, to = range && range.to ? istDay(new Date(new Date(range.to).getTime() - 1)) : today;
  if (to > today) to = today;
  const first = rows.length ? rows.map((r) => String(r.d).slice(0, 10)).sort()[0] : null;
  if (!from || from < "2001-01-01") from = first || istDay(Date.now() - 29 * 864e5);
  if (first && first < from) from = first;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const monthly = days > 92;
  const key = (d) => (monthly ? d.slice(0, 7) : d);
  const map = new Map();
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) { const k = key(new Date(t).toISOString().slice(0, 10)); if (!map.has(k)) map.set(k, Object.fromEntries(fields.map((f) => [f, 0]))); }
  for (const r of rows) { const k = key(String(r.d).slice(0, 10)); const b = map.get(k) || Object.fromEntries(fields.map((f) => [f, 0])); fields.forEach((f) => (b[f] += Number(r[f] || 0))); map.set(k, b); }
  const keys = [...map.keys()].sort();
  const label = (k) => monthly ? new Date(k + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }) : new Date(k + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  return { keys, labels: keys.map(label), data: keys.map((k) => map.get(k)), monthly };
}
const CH = { W: 640, H: 230, L: 52, R: 10, T: 12, B: 30 };
function axes(max, labels, fmt) {
  const { W, H, L, R, T, B } = CH, ih = H - T - B, iw = W - L - R;
  let g = "";
  for (let i = 0; i <= 4; i++) { const y = T + ih - (ih * i) / 4; g += `<line class="${i ? "gl" : "bl"}" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="ax" x="${L - 6}" y="${y + 3.5}" text-anchor="end">${esc(fmt((max * i) / 4))}</text>`; }
  const n = labels.length, step = Math.max(1, Math.ceil(n / 8));
  labels.forEach((l, i) => { if (i % step === 0 || (i === n - 1 && n < 12)) g += `<text class="ax" x="${L + (iw * (i + 0.5)) / n}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; });
  return g;
}
/** Single-series column chart. series: {name, color, values[]}; fmt(v) for tooltip/axis; tipExtra(i) extra html line. */
function colChart(labels, s, { fmt = num, axisFmt, tipExtra } = {}) {
  const { W, H, L, R, T, B } = CH, ih = H - T - B, iw = W - L - R, n = labels.length;
  const max = axisFmt ? niceMax(Math.max(...s.values, 0)) : intMax(Math.max(...s.values, 0));
  const bw = Math.max(2, Math.min(28, (iw / n) * 0.7));
  let bars = "";
  s.values.forEach((v, i) => {
    const cx = L + (iw * (i + 0.5)) / n, h = (v / max) * ih, y = T + ih - h;
    const tip = `<b>${esc(labels[i])}</b><i style="background:${s.color}"></i>${esc(s.name)}: <strong>${esc(fmt(v))}</strong>${tipExtra ? "<br>" + tipExtra(i) : ""}`;
    bars += `<rect class="hit" x="${L + (iw * i) / n}" y="${T}" width="${iw / n}" height="${ih}" data-tip="${esc(tip)}" data-cx="${cx}" data-cy="${Math.max(T, y)}"/>`;
    if (v > 0) bars += `<path class="bk" fill="${s.color}" pointer-events="none" d="M${cx - bw / 2},${T + ih} V${y + Math.min(4, h)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${T + ih} Z"/>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.name)} chart">${axes(max, labels, axisFmt || ((v) => shortNum(v)))}${bars}</svg><div class="tip"></div></div>`;
}
/** Multi-series line chart with crosshair tooltip. series: [{name,color,values}] */
function lineChart(labels, series, { fmt = num } = {}) {
  const { W, H, L, R, T, B } = CH, ih = H - T - B, iw = W - L - R, n = labels.length;
  const max = intMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const X = (i) => L + (iw * (i + 0.5)) / n, Y = (v) => T + ih - (v / max) * ih;
  let g = `<line class="vline" x1="-10" x2="-10" y1="${T}" y2="${T + ih}"/>`;
  for (const s of series) {
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${s.values.map((v, i) => `${X(i)},${Y(v)}`).join(" ")}"/>`;
    if (n <= 45) g += s.values.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="2.6" fill="${s.color}" stroke="#111" stroke-width="1.5"/>`).join("");
  }
  for (let i = 0; i < n; i++) {
    const tip = `<b>${esc(labels[i])}</b>` + series.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.name)}: <strong>${esc(fmt(s.values[i]))}</strong></div>`).join("");
    g += `<rect class="hit" x="${L + (iw * i) / n}" y="${T}" width="${iw / n}" height="${ih}" data-tip="${esc(tip)}" data-cx="${X(i)}" data-cy="${Math.min(...series.map((s) => Y(s.values[i])))}" data-line="1"/>`;
  }
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `${legend}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))} chart">${axes(max, labels, (v) => shortNum(v))}${g}</svg><div class="tip"></div></div>`;
}
/** Horizontal bar list. rows: [{label, value, title}] */
function hbars(rows, fmt = num) {
  if (!rows.length) return empty();
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);
  return `<div class="hb">${rows.map((r) => `<div class="hrow" title="${esc(r.title || r.label)}: ${esc(fmt(r.value))}"><span>${esc(r.label)}</span><span class="trk"><i style="width:${(Number(r.value) / max) * 100}%"></i></span><b>${esc(fmt(r.value))}</b></div>`).join("")}</div>`;
}
const DONUT_COLORS = ["#ff6a00", "#60a5fa", "#c084fc", "#4ade80", "#fbbf24", "#9ca3af"];
function donut(rows) {
  const total = rows.reduce((a, r) => a + Number(r.value || 0), 0);
  if (!total) return empty();
  let a0 = -Math.PI / 2, paths = "";
  const R = 60, r = 38, C = 70;
  rows.forEach((x, i) => {
    const frac = Number(x.value) / total; if (!frac) return;
    const a1 = a0 + frac * Math.PI * 2 - (rows.length > 1 ? 0.02 : 0);
    const big = a1 - a0 > Math.PI ? 1 : 0, p = (ang, rad) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
    const d = frac >= 0.9999 ? `M${C - R},${C} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 -${2 * R},0 M${C - r},${C} a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 -${2 * r},0` : `M${p(a0, R)} A${R},${R} 0 ${big} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${big} 0 ${p(a0, r)} Z`;
    paths += `<path d="${d}" fill="${DONUT_COLORS[i % DONUT_COLORS.length]}" fill-rule="evenodd"><title>${esc(x.label)}: ${num(x.value)} (${Math.round(frac * 100)}%)</title></path>`;
    a0 = a0 + frac * Math.PI * 2;
  });
  return `<div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="Breakdown">${paths}<text x="70" y="68" text-anchor="middle" fill="#fff" style="font:20px Anton">${esc(shortNum(total))}</text><text x="70" y="84" text-anchor="middle" fill="#888" style="font:10px Inter">total</text></svg>
    <ul>${rows.map((x, i) => `<li><i style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></i>${esc(x.label)} <b>${num(x.value)}</b> <span class="muted">(${Math.round((Number(x.value) / total) * 100)}%)</span></li>`).join("")}</ul></div>`;
}
// One delegated hover handler for every chart tooltip.
document.addEventListener("mouseover", (e) => {
  const h = e.target.closest && e.target.closest(".chart .hit"); if (!h) return;
  const ch = h.closest(".chart"), tip = $(".tip", ch), svg = $("svg", ch);
  const sc = svg.getBoundingClientRect().width / CH.W;
  tip.innerHTML = h.dataset.tip; tip.style.display = "block";
  let left = +h.dataset.cx * sc; const half = tip.offsetWidth / 2, wmax = ch.clientWidth;
  left = Math.max(half, Math.min(wmax - half, left));
  tip.style.left = left + "px"; tip.style.top = Math.max(+h.dataset.cy * sc, tip.offsetHeight + 4) + "px";
  const vl = $(".vline", ch); if (vl) { vl.setAttribute("x1", h.dataset.cx); vl.setAttribute("x2", h.dataset.cx); }
});
document.addEventListener("mouseout", (e) => {
  const h = e.target.closest && e.target.closest(".chart .hit"); if (!h) return;
  const ch = h.closest(".chart"); if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".chart .hit") && e.relatedTarget.closest(".chart") === ch) return;
  $(".tip", ch).style.display = "none"; const vl = $(".vline", ch); if (vl) { vl.setAttribute("x1", -10); vl.setAttribute("x2", -10); }
});

/* ---------- router ---------- */
const ROUTES = [];
/** route("products/:id", ["products.manage"], async (ctx) => {...}) */
function route(pattern, perms, fn) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  ROUTES.push({ re, keys, perms, fn });
}
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, "")) || "";
  const [path, qs] = [h.split("?")[0].replace(/\/$/, ""), location.hash.split("?")[1] || ""];
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}
const go = (path, query) => { const q = query ? queryStr(query) : ""; location.hash = "#/" + path + (q ? "?" + q : ""); };
let navTok = 0;
async function render() {
  if (!STATE.me) return;
  const { path, query } = parseHash();
  if (!path) { const first = NAV.find((n) => n.key && navAllowed(n)); return location.replace("#/" + (first ? first.key : "account")); }
  const tok = ++navTok;
  $$(".aside nav a").forEach((a) => a.classList.toggle("on", path === a.dataset.k || path.startsWith(a.dataset.k + "/")));
  const view = $("#view");
  let r, m;
  for (const x of ROUTES) if ((m = path.match(x.re))) { r = x; break; }
  window.scrollTo(0, 0);
  if (!r) { view.innerHTML = `<div class="ph"><h2>Not found</h2></div>${empty("This page doesn't exist.")}`; return; }
  if (r.perms && r.perms.length && !can(...r.perms)) { view.innerHTML = `<div class="ph"><h2>No access</h2></div><div class="errbox">Your role (${esc(STATE.me.role_name)}) doesn't have access to this section. Ask a Super Admin if you need it.</div>`; return; }
  const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
  const ctx = {
    path, query, params, view,
    alive: () => tok === navTok,
    set(html) { if (tok === navTok) view.innerHTML = html; return tok === navTok; },
    reload: () => render(),
    setQuery(patch, replace) { const q = { ...query, ...patch }; for (const k in q) if (q[k] === "" || q[k] == null) delete q[k]; const qs = queryStr(q); const h = "#/" + path + (qs ? "?" + qs : ""); if (replace) { history.replaceState(null, "", h); render(); } else location.hash = h; },
  };
  view.innerHTML = `<div class="loading">Loading…</div>`;
  try { await r.fn(ctx); } catch (e) {
    if (!ctx.alive()) return;
    if (e.status === 401) return;
    view.innerHTML = `<div class="ph"><h2>${e.status === 403 ? "No access" : "Something went wrong"}</h2></div>${errBox(e)}<button class="btn sm" data-retry>Try again</button>`;
    const b = $("[data-retry]", view); b && b.addEventListener("click", render);
  }
}
window.addEventListener("hashchange", render);

/* ---------- shell ---------- */
const IC = {
  dashboard: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10", analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2", products: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  categories: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", orders: "M6 2l-2 4v14a2 2 0 002 2h12a2 2 0 002-2V6l-2-4zM4 6h16M16 10a4 4 0 01-8 0",
  customers: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75", coupons: "M20 12l-8 8-9-9V3h8zM7 7h.01",
  content: "M4 4h16v16H4zM4 9h16M9 9v11", reviews: "M12 2l3 7 7 .5-5.5 4.5L18 21l-6-4-6 4 1.5-7L2 9.5 9 9z", messages: "M4 4h16v12H5.17L4 17.17zM4 4l8 7 8-7",
  team: "M12 12a5 5 0 100-10 5 5 0 000 10M3 22a9 9 0 0118 0", integrations: "M9 2v6M15 2v6M7 8h10v4a5 5 0 01-10 0zM12 17v5", audit: "M9 3h6l1 2h4v16H4V5h4zM8 11h8M8 15h8M8 19h5", account: "M12 15a3 3 0 100-6 3 3 0 000 6M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
};
const NAV = [
  { key: "dashboard", label: "Dashboard", perms: ["dashboard.view"] },
  { key: "analytics", label: "Analytics", perms: ["analytics.view"] },
  { grp: "Catalog" },
  { key: "products", label: "Products", perms: ["products.manage", "products.content"] },
  { key: "categories", label: "Categories", perms: ["products.manage"] },
  { grp: "Sales" },
  { key: "orders", label: "Orders", perms: ["orders.view"] },
  { key: "customers", label: "Customers", perms: ["customers.view"] },
  { key: "coupons", label: "Coupons", perms: ["coupons.manage"] },
  { grp: "Website" },
  { key: "content", label: "Content", perms: ["content.manage"] },
  { key: "reviews", label: "Reviews", perms: ["reviews.manage"] },
  { key: "messages", label: "Messages", perms: ["messages.manage"] },
  { grp: "Admin" },
  { key: "team", label: "Team", perms: ["admins.manage"] },
  { key: "audit", label: "Audit log", perms: ["audit.view"] },
  { key: "integrations", label: "Integrations", perms: ["admins.manage"] },
];
const navAllowed = (n) => !n.perms || can(...n.perms);
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${IC[k] || ""}"/></svg>`;
function renderShell() {
  const items = [];
  NAV.forEach((n, i) => {
    if (n.grp) { const next = NAV.slice(i + 1); const end = next.findIndex((x) => x.grp); const grpItems = (end < 0 ? next : next.slice(0, end)).filter(navAllowed); if (grpItems.length) items.push(`<div class="grp">${n.grp}</div>`); return; }
    if (navAllowed(n)) items.push(`<a href="#/${n.key}" data-k="${n.key}">${icon(n.key)}${n.label}</a>`);
  });
  $("#r").innerHTML = `<div class="shell"><aside class="aside"><a class="brand" href="#/"><img src="/img/logo.png" alt="HYPEMAX"><span>Admin</span></a><nav aria-label="Admin sections">${items.join("")}</nav>
    <div class="me"><b>${esc(STATE.me.name)}</b><small>${esc(STATE.me.role_name)}</small><div class="mrow"><a class="btn xs" href="#/account" data-k="account">Account</a><button class="btn xs" id="logout">Log out</button></div></div></aside>
    <main class="main" id="view"></main></div>`;
  $("#logout").addEventListener("click", async (e) => {
    await busy(e.currentTarget, () => POST("/logout").catch(() => {}));
    STATE.me = null; history.replaceState(null, "", location.pathname); renderLogin();
  });
}
function featureBanner() {
  const f = STATE.features || {};
  const NAMES = { razorpay: "Razorpay payments", razorpayWebhook: "Razorpay webhook", cloudinary: "Cloudinary image uploads", google: "Google sign-in", email: "Email (SMTP)" };
  const missing = Object.keys(NAMES).filter((k) => f[k] === false);
  if (!missing.length) return "";
  return `<div class="infobox"><b>Integrations not configured:</b> ${missing.map((k) => esc(NAMES[k])).join(", ")}. Add the matching keys to the server environment to enable them.</div>`;
}

/* ---------- login ---------- */
function renderLogin(msg) {
  STATE.me = null;
  $("#r").innerHTML = `<div class="login"><form id="lf" novalidate><img src="/img/logo.png" alt="HYPEMAX"><h2>Admin login</h2>${msg ? `<div class="infobox">${esc(msg)}</div>` : ""}<div class="errbox" hidden></div>
    ${fld({ n: "email", l: "Email", t: "email", req: true, autocomplete: "username" })}${fld({ n: "password", l: "Password", t: "password", req: true, autocomplete: "current-password" })}
    <button class="btn p" type="submit">Log in</button></form></div>`;
  const f = $("#lf"), eb = $(".errbox", f);
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); eb.hidden = true;
    const v = vals(f);
    if (!v.email || !v.password) { eb.textContent = "Enter your email and password."; eb.hidden = false; return; }
    try {
      await busy($("button[type=submit]", f), async () => {
        if (!csrf()) await fetch("/api/config", { credentials: "same-origin" }).catch(() => {});
        await api("/login", { method: "POST", body: { email: v.email.trim(), password: v.password } });
        await start();
      });
    } catch (x) { eb.textContent = x.message; eb.hidden = false; }
  });
}
let expiredShown = false;
function sessionExpired() {
  if (expiredShown) return; expiredShown = true;
  STATE.me = null; renderLogin("Your session has expired. Please log in again.");
  setTimeout(() => (expiredShown = false), 1000);
}

/* ---------- account (change password) ---------- */
route("account", null, async (ctx) => {
  const me = STATE.me;
  ctx.set(`<div class="ph"><div><h2>My account</h2></div></div>
  <div class="cols2"><div class="pn"><h3>Profile</h3><dl class="kv"><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Email</dt><dd>${esc(me.email)}</dd><dt>Role</dt><dd>${esc(me.role_name)}</dd>
    <dt>Permissions</dt><dd>${STATE.perms.includes("*") ? "All permissions" : STATE.perms.map((p) => `<code>${esc(p)}</code>`).join(" ")}</dd></dl></div>
  <form class="pn" id="pwf" novalidate><h3>Change my password</h3>
    ${fld({ n: "current_password", l: "Current password", t: "password", req: true, autocomplete: "current-password" })}
    ${fld({ n: "new_password", l: "New password", t: "password", req: true, autocomplete: "new-password", hint: "At least 8 characters with letters and numbers." })}
    ${fld({ n: "confirm", l: "Confirm new password", t: "password", req: true, autocomplete: "new-password" })}
    <div class="hint" style="margin-bottom:10px">Changing your password signs you out on every other device.</div>
    <button class="btn p" type="submit">Update password</button></form></div>`);
  const f = $("#pwf");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = vals(f);
    if (!v.current_password || !v.new_password) return toast("Fill in all password fields", true);
    if (v.new_password !== v.confirm) return toast("New passwords don't match", true);
    if (v.new_password.length < 8 || !/[a-z]/i.test(v.new_password) || !/\d/.test(v.new_password)) return toast("Use at least 8 characters with letters and numbers", true);
    if (await act($("button[type=submit]", f), () => POST("/me/password", { current_password: v.current_password, new_password: v.new_password }), "Password updated")) f.reset();
  });
});

/* ---------- boot ---------- */
async function start() {
  try {
    const j = await GET("/me");
    STATE.me = j.admin; STATE.features = j.features || {}; STATE.perms = j.admin.permissions || [];
  } catch (e) {
    if (e.status === 401) return renderLogin();
    $("#r").innerHTML = `<div class="login"><div class="errbox">Couldn't reach the admin API: ${esc(e.message)}</div></div>`;
    return;
  }
  renderShell();
  render();
}
document.addEventListener("DOMContentLoaded", start);
