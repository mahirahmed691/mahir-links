// /admin: password-protected stats dashboard, rendered on the server.
// Needs two environment variables in Vercel (Project → Settings → Environment Variables):
//   ADMIN_PASSWORD     your password for this page (any username works). Also signs guest links.
//   GOATCOUNTER_TOKEN  a GoatCounter API key with read access
// The GoatCounter key never reaches the browser; this function fetches the numbers and returns plain HTML.
import crypto from "node:crypto";

// Filled in by scripts/build.mjs from links.json (display names, business list, GoatCounter code).
const site = /*SITE*/ {};

const RANGES = { today: { label: "Today", days: 1 }, "7d": { label: "7 days", days: 7 }, "30d": { label: "30 days", days: 30 } };
const SHARE_DAYS = [1, 7, 30];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const password = process.env.ADMIN_PASSWORD;
  const token = process.env.GOATCOUNTER_TOKEN;
  if (!password || !token) {
    res.statusCode = 503;
    return send(res, page("Admin not set up", `<p class="note">Add <code>ADMIN_PASSWORD</code> and <code>GOATCOUNTER_TOKEN</code> in Vercel → Project → Settings → Environment Variables, then redeploy.</p>`));
  }
  const owner = isOwner(req, password);
  const guestToken = queryValue(req, "guest");
  if (guestToken && !owner) {
    const shared = verifyGuest(guestToken, password);
    if (!shared) {
      await pause();
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="Stats", charset="UTF-8"');
      return send(res, page("Link expired", `<p class="note">This access link is invalid or has expired. Ask for a new one.</p>`));
    }
    setGuestCookie(res, guestToken, shared.exp);
    const range = queryValue(req, "range");
    res.statusCode = 302;
    res.setHeader("Location", RANGES[range] ? `/admin?range=${range}` : "/admin");
    return res.end();
  }

  const guest = owner ? null : verifyGuest(cookieValue(req, "admin_guest"), password);
  if (!owner && !guest) {
    await pause();
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="Stats", charset="UTF-8"');
    return send(res, page("Sign in required", `<p class="note">This page is private.</p>`));
  }

  const view = viewOf(req);
  const access = owner ? { owner: true, share: shareLink(req, password) } : { owner: false, guest };
  try {
    const data = await load(globalThis.__adminFetch || fetch, token, view.rangeKey);
    send(res, page("Stats", render(data, view, access)));
  } catch (err) {
    console.error("admin: GoatCounter request failed", err);
    res.statusCode = 502;
    const note = `<p class="note">Couldn't reach GoatCounter: ${esc(err.message)}. Try again in a minute.</p>`;
    const extra = owner ? (access.share?.url ? linkCallout(access.share) : "") + accessNote(access, view) : "";
    send(res, page("Stats unavailable", note + extra));
  }
}

function viewOf(req) {
  const rangeParam = queryValue(req, "range");
  const sortParam = queryValue(req, "sort");
  return {
    rangeKey: RANGES[rangeParam] ? rangeParam : "7d",
    sort: ["clicks", "shares", "name"].includes(sortParam) ? sortParam : "clicks",
    quiet: queryValue(req, "quiet") === "show" ? "show" : "hide",
  };
}

function href(view, patch = {}) {
  const next = { ...view, ...patch };
  const q = new URLSearchParams();
  q.set("range", next.rangeKey);
  if (next.sort !== "clicks") q.set("sort", next.sort);
  if (next.quiet === "show") q.set("quiet", "show");
  return `/admin?${q}`;
}

function queryValue(req, key) {
  const fromHelper = req.query?.[key];
  if (typeof fromHelper === "string") return fromHelper;
  try {
    const url = typeof req.url === "string" && req.url.startsWith("http") ? new URL(req.url) : new URL(req.url || "/", "http://localhost");
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

const pause = () => new Promise((r) => setTimeout(r, 400));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOwner(req, password) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(given), h(password));
}

function signGuest(label, exp, secret) {
  const payload = Buffer.from(JSON.stringify({ label, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyGuest(token, secret) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return null; }
  if (!data || typeof data.label !== "string" || data.label.length > 40 || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
  return data;
}

function shareLink(req, password) {
  const raw = queryValue(req, "for");
  if (!raw) return null;
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label || label.length > 40) return { error: "Use a name of 40 characters or fewer." };
  const days = Number(queryValue(req, "days"));
  if (!SHARE_DAYS.includes(days)) return { error: "Choose 1, 7, or 30 days." };
  const exp = Date.now() + days * 864e5;
  const guest = signGuest(label, exp, password);
  return { url: `${requestOrigin(req)}/admin?guest=${guest}`, label, exp, days };
}

function requestOrigin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${String(host).split(",")[0].trim()}`;
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function setGuestCookie(res, token, exp) {
  const maxAge = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  res.setHeader("Set-Cookie", `admin_guest=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${maxAge}`);
}

function when(exp) {
  return new Date(exp).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

// ---------- data ----------
async function load(fetchImpl, token, rangeKey) {
  const end = new Date();
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() + 1);
  const start = new Date(end.getTime() - RANGES[rangeKey].days * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 19) + "Z";
  const q = `start=${fmt(start)}&end=${fmt(end)}`;
  const base = `https://${site.goatcounter}.goatcounter.com/api/v0`;
  // GoatCounter allows about 4 requests a second. These used to fire back to back, so the last call (/stats/sizes) returned 429 and the whole page failed.
  let lastCall = 0;
  const getRange = async (path, query, { required = true } = {}) => {
    const url = `${base}${path}${path.includes("?") ? "&" : "?"}${query}`;
    const label = path.split("?")[0];
    let wait = 800;
    for (let attempt = 0; attempt < 4; attempt++) {
      const gap = 300 - (Date.now() - lastCall);
      if (gap > 0) await sleep(gap);
      lastCall = Date.now();
      const r = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (r.status === 429) {
        const retryAfter = Number(typeof r.headers?.get === "function" ? r.headers.get("retry-after") : r.headers?.["retry-after"]);
        wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2000) : wait;
        if (attempt < 3) {
          await sleep(wait);
          wait = Math.min(wait * 2, 2000);
          continue;
        }
        if (!required) return { stats: [], hits: [], missing: true };
        throw new Error(`${label} returned 429`);
      }
      if (!r.ok) {
        if (!required) return { stats: [], hits: [], missing: true };
        throw new Error(`${label} returned ${r.status}`);
      }
      return r.json();
    }
    if (!required) return { stats: [], hits: [], missing: true };
    throw new Error(`${label} returned 429`);
  };
  const hits = await getRange("/stats/hits?limit=100", q);
  const prevStart = new Date(start.getTime() - RANGES[rangeKey].days * 864e5);
  const prevHits = await getRange("/stats/hits?limit=100", `start=${fmt(prevStart)}&end=${fmt(start)}`);
  const refs = await getRange("/stats/toprefs?limit=8", q, { required: false });
  const locations = await getRange("/stats/locations?limit=8", q, { required: false });
  const sizes = await getRange("/stats/sizes?limit=6", q, { required: false });

  const list = hits.hits || [];
  const pages = list.filter((h) => !h.event);
  const events = list.filter((h) => h.event);
  const clicks = events.filter((h) => h.path.startsWith("click/"));
  const shares = events.filter((h) => h.path.startsWith("share/"));

  const sum = (xs) => xs.reduce((a, h) => a + (h.count || 0), 0);
  const nameOf = (slug) => site.names[slug] || slug;

  // Per-business leaderboard: clicks and shares.
  const board = new Map(site.businesses.map((slug) => [slug, { name: nameOf(slug), clicks: 0, shares: 0 }]));
  for (const c of clicks) { const slug = c.path.slice(6); if (board.has(slug)) board.get(slug).clicks += c.count; }
  const byMethod = new Map();
  for (const s of shares) {
    const [, from, method] = s.path.split("/");
    if (board.has(from)) board.get(from).shares += s.count;
    byMethod.set(method, (byMethod.get(method) || 0) + s.count);
  }
  const bizSlugs = new Set(site.businesses);
  const otherLinks = clicks.filter((c) => !bizSlugs.has(c.path.slice(6)))
    .map((c) => ({ name: c.title || nameOf(c.path.slice(6)), count: c.count }));

  const prevList = prevHits.hits || [];
  const points = alignSeries(list, rangeKey, start, end);
  const prevPoints = alignSeries(prevList, rangeKey, prevStart, start);
  const prev = {
    visitors: sum(prevList.filter((h) => !h.event)),
    clicks: sum(prevList.filter((h) => h.event && h.path.startsWith("click/"))),
    shares: sum(prevList.filter((h) => h.event && h.path.startsWith("share/"))),
  };

  return {
    rangeKey,
    prev,
    visitors: sum(pages),
    clicks: sum(clicks),
    shares: sum(shares),
    points,
    prevPoints,
    businesses: [...board.values()],
    links: otherLinks.sort((a, b) => b.count - a.count),
    methods: [...byMethod.entries()].map(([name, count]) => ({ name: METHOD_NAMES[name] || name, count })).sort((a, b) => b.count - a.count),
    referrers: byCount((refs.stats || []).map((r) => ({ name: r.name || "Direct or unknown", count: r.count }))),
    locations: byCount((locations.stats || []).map((r) => ({ name: r.name || "Unknown", count: r.count }))),
    devices: byCount((sizes.stats || []).map((r) => ({ name: r.name || "Unknown", count: r.count }))),
    missing: { referrers: !!refs.missing, locations: !!locations.missing, devices: !!sizes.missing },
  };
}

function alignSeries(list, rangeKey, start, end) {
  const raw = new Map();
  for (const p of (list || []).filter((h) => !h.event)) for (const s of p.stats || []) {
    if (rangeKey === "today") (s.hourly || []).forEach((count, i) => raw.set(`${s.day} ${i}`, (raw.get(`${s.day} ${i}`) || 0) + count));
    else raw.set(s.day, (raw.get(s.day) || 0) + (s.daily || 0));
  }
  if (rangeKey === "today") {
    const out = [];
    for (let t = start.getTime(); t < end.getTime(); t += 3600e3) {
      const d = new Date(t);
      const key = `${d.toISOString().slice(0, 10)} ${d.getUTCHours()}`;
      out.push([key, raw.get(key) || 0]);
    }
    return out;
  }
  const out = [];
  const from = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const to = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let t = from; t <= to; t += 864e5) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push([key, raw.get(key) || 0]);
  }
  return out;
}

const byCount = (rows) => rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const METHOD_NAMES = { native: "Phone share sheet", whatsapp: "WhatsApp", x: "X", linkedin: "LinkedIn", facebook: "Facebook", email: "Email", copy: "Copy link" };

// ---------- rendering ----------
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const n = (x) => Number(x || 0).toLocaleString("en-GB");

function send(res, html) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(site.name)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin.css">
</head><body><main class="admin">${body}</main><script src="/admin.js"></script></body></html>`;
}

function widthClass(count, max) {
  if (!count || !max) return "w0";
  return `w${Math.max(2, Math.round((count / max) * 50) * 2)}`;
}

function bars(rows, missing) {
  if (missing) return `<p class="empty">Not loaded this time. Refresh in a minute.</p>`;
  if (!rows.length) return `<p class="empty">Nothing yet.</p>`;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return `<ul class="bars">${rows.map((r) => `<li><span class="bar-label">${esc(r.name)}</span><span class="bar-track"><span class="bar-fill ${widthClass(r.count, max)}"></span></span><span class="bar-num">${n(r.count)}</span></li>`).join("")}</ul>`;
}

function pointLabel(key, hourly) {
  if (!key) return "";
  if (hourly) return `${String(key.split(" ")[1]).padStart(2, "0")}:00`;
  return new Date(key + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function chart(points, prevPoints, hourly) {
  const len = Math.max(points.length, prevPoints.length);
  if (!len) return `<p class="empty">No visitors recorded in this period yet.</p>`;
  const slots = Array.from({ length: len }, (_, i) => ({
    key: points[i]?.[0] || "",
    now: points[i]?.[1] || 0,
    then: prevPoints[i]?.[1] || 0,
  }));
  if (slots.every((s) => !s.now && !s.then)) return `<p class="empty">No visitors recorded in this period yet.</p>`;
  const W = 720, H = 200, pad = 28;
  const max = Math.max(...slots.flatMap((s) => [s.now, s.then]), 1);
  const bw = (W - pad) / slots.length;
  const hasPrev = slots.some((s) => s.then);
  const avg = slots.reduce((sum, s) => sum + s.now, 0) / slots.length;
  const avgY = H - Math.round((avg / max) * (H - 28));
  const every = Math.ceil(slots.length / 8);
  const peak = Math.max(...slots.map((s) => s.now));
  const bars = slots.map((s, i) => {
    const x = pad + i * bw;
    const nowH = Math.round((s.now / max) * (H - 28));
    const thenH = Math.round((s.then / max) * (H - 28));
    const label = pointLabel(s.key, hourly) || `Day ${i + 1}`;
    const prevBar = hasPrev
      ? `<rect x="${(x + bw * 0.08).toFixed(1)}" y="${H - thenH}" width="${(bw * 0.36).toFixed(1)}" height="${thenH}" rx="2" class="chart-prev"><title>Previous, ${esc(label)}: ${n(s.then)}</title></rect>`
      : "";
    const nowX = hasPrev ? x + bw * 0.5 : x + bw * 0.18;
    const nowW = hasPrev ? bw * 0.36 : bw * 0.64;
    const peakClass = s.now && s.now === peak ? " chart-peak" : "";
    const tick = s.key && i % every === 0
      ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H + 16}" text-anchor="middle" class="chart-label">${esc(hourly ? label : label.replace(/^\S+\s/, ""))}</text>`
      : "";
    return `${prevBar}<rect x="${nowX.toFixed(1)}" y="${H - nowH}" width="${nowW.toFixed(1)}" height="${nowH}" rx="2" class="chart-bar${peakClass}"><title>${esc(label)}: ${n(s.now)} visitors</title></rect>${tick}`;
  }).join("");
    const avgLine = avg
    ? `<line x1="${pad}" x2="${W - 4}" y1="${avgY}" y2="${avgY}" class="chart-avg"></line><text x="${pad}" y="${Math.max(12, avgY - 4)}" class="chart-label">avg ${esc(compact(avg))}</text>`
    : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H + 22}" role="img" aria-label="Visitors this period compared with the previous period">
${bars}${avgLine}
<text x="0" y="0" dominant-baseline="hanging" class="chart-label">${n(max)} max</text>
</svg>${hasPrev ? `<p class="legend"><span class="swatch then"></span> Previous period <span class="swatch now"></span> This period <span class="swatch peak"></span> Busiest</p>` : ""}`;
}

function changeHtml(now, before) {
  if (!before && !now) return `<td class="flat">Same</td>`;
  if (!before) return `<td class="up">New</td>`;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return `<td class="flat">Same</td>`;
  return `<td class="${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</td>`;
}

function rateChange(now, before) {
  if (!now && !before) return `<td class="flat">Same</td>`;
  if (!before) return `<td class="up">New</td>`;
  const pts = now - before;
  if (pts === 0) return `<td class="flat">Same</td>`;
  return `<td class="${pts > 0 ? "up" : "down"}">${pts > 0 ? "▲" : "▼"} ${Math.abs(pts)} pts</td>`;
}

const rate = (part, whole) => whole ? Math.round((part / whole) * 100) : 0;
const plural = (count, one, many) => count === 1 ? one : many;
const compact = (x) => {
  const rounded = Math.abs(x) >= 10 ? Math.round(x) : Math.round(x * 10) / 10;
  return rounded.toLocaleString("en-GB");
};

function movement(label, now, before, rangeKey) {
  if (!now && !before) return null;
  const period = { today: "yesterday", "7d": "the previous 7 days", "30d": "the previous 30 days" }[rangeKey];
  if (!before) return `${label} are new compared with ${period}.`;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return `${label} match ${period}.`;
  return `${label} are ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on ${period}.`;
}

function briefing(d, rangeKey) {
  const hourly = rangeKey === "today";
  const span = hourly ? "today" : `over these ${RANGES[rangeKey].label.toLowerCase()}`;
  const sentences = [];
  if (!d.visitors && !d.clicks && !d.shares) sentences.push(`Nothing recorded ${span} yet.`);
  else sentences.push(`${n(d.visitors)} ${plural(d.visitors, "visitor", "visitors")}, ${n(d.clicks)} ${plural(d.clicks, "click", "clicks")}, and ${n(d.shares)} ${plural(d.shares, "share", "shares")} ${span}.`);
  const move = movement("Visitors", d.visitors, d.prev.visitors, rangeKey);
  if (move) sentences.push(move);
  const top = [...d.businesses].sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name))[0];
  if (top?.clicks && d.clicks) sentences.push(`${top.name} took ${rate(top.clicks, d.clicks)}% of clicks.`);
  const peak = d.points.reduce((best, point) => point[1] > best[1] ? point : best, ["", 0]);
  if (peak[1]) {
    const avg = d.points.reduce((sum, [, value]) => sum + value, 0) / d.points.length;
    const unit = hourly ? "hour" : "day";
    sentences.push(`Busiest ${unit}: ${pointLabel(peak[0], hourly)} (${n(peak[1])} visitors), against an average of ${compact(avg)} per ${unit}.`);
  }
  if (!d.missing.referrers && d.referrers[0]?.count) sentences.push(`Top source: ${d.referrers[0].name}.`);
  else if (d.methods[0]?.count) sentences.push(`Most shares went out by ${d.methods[0].name}.`);
  return sentences;
}

function periodLabel(d, rangeKey) {
  if (rangeKey === "today") return "Today";
  const keys = d.points.map(([key]) => key).filter(Boolean);
  if (!keys.length) return RANGES[rangeKey].label;
  const fmt = (key) => new Date(key + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${fmt(keys[0])} to ${fmt(keys[keys.length - 1])}`;
}

function compareTable(d) {
  const nowRate = rate(d.clicks, d.visitors);
  const prevRate = rate(d.prev.clicks, d.prev.visitors);
  const rows = [
    ["Visitors", n(d.visitors), n(d.prev.visitors), changeHtml(d.visitors, d.prev.visitors)],
    ["Link clicks", n(d.clicks), n(d.prev.clicks), changeHtml(d.clicks, d.prev.clicks)],
    ["Shares", n(d.shares), n(d.prev.shares), changeHtml(d.shares, d.prev.shares)],
    ["Clicks per visitor", `${nowRate}%`, `${prevRate}%`, rateChange(nowRate, prevRate)],
  ];
  return `<table class="compare"><caption>Against the previous period</caption><thead><tr><th scope="col">Metric</th><th scope="col">This period</th><th scope="col">Previous</th><th scope="col">Change</th></tr></thead><tbody>
${rows.map(([label, now, then, change]) => `<tr><th scope="row">${label}</th><td>${now}</td><td>${then}</td>${change}</tr>`).join("")}
</tbody></table>`;
}

function orderBusinesses(list, sort) {
  const rows = [...list];
  if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "shares") rows.sort((a, b) => b.shares - a.shares || b.clicks - a.clicks || a.name.localeCompare(b.name));
  else rows.sort((a, b) => b.clicks - a.clicks || b.shares - a.shares || a.name.localeCompare(b.name));
  return rows;
}

function ranking(d, view) {
  const quietCount = d.businesses.filter((b) => !b.clicks && !b.shares).length;
  const visible = orderBusinesses(d.businesses, view.sort).filter((b) => view.quiet === "show" || b.clicks || b.shares);
  const maxClicks = Math.max(...d.businesses.map((b) => b.clicks), 0);
  const sorts = [["clicks", "Clicks"], ["shares", "Shares"], ["name", "Name"]];
  const sortNav = sorts.map(([key, label]) => `<a href="${esc(href(view, { sort: key }))}"${view.sort === key ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const quietLink = quietCount
    ? `<a class="textlink" href="${esc(href(view, { quiet: view.quiet === "hide" ? "show" : "hide" }))}">${view.quiet === "hide" ? `Show ${quietCount} quiet` : `Hide ${quietCount} quiet`}</a>`
    : "";
  const rows = visible.length
    ? `<ol class="rank">${visible.map((b, i) => {
      const pct = d.clicks ? rate(b.clicks, d.clicks) : 0;
      const quiet = !b.clicks && !b.shares ? ` class="quiet"` : "";
      return `<li${quiet}><span class="rank-i">${i + 1}</span><span class="rank-name">${esc(b.name)}</span><span class="bar-track" aria-hidden="true"><span class="bar-fill ${widthClass(b.clicks, maxClicks)}"></span></span><span class="rank-stat"><b>${n(b.clicks)}</b> clicks</span><span class="rank-stat">${pct}%</span><span class="rank-stat"><b>${n(b.shares)}</b> shares</span></li>`;
    }).join("")}</ol>`
    : `<p class="empty">${view.quiet === "hide" ? "Every business was quiet in this period." : "No businesses yet."}</p>`;
  const note = quietCount && view.quiet === "show" ? `<p class="note tight">${quietCount} of ${d.businesses.length} had no clicks or shares.</p>` : "";
  return `<section class="block">
<header class="block-head"><div><h2>Businesses</h2>${note}</div><div class="tools"><nav class="tabs" aria-label="Sort businesses">${sortNav}</nav>${quietLink}</div></header>
${rows}</section>`;
}

function sendActions(share) {
  const text = `Stats for ${share.label} until ${when(share.exp)}: ${share.url}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const mail = `mailto:?subject=${encodeURIComponent("Stats link for " + share.label)}&body=${encodeURIComponent(text)}`;
  return `<p class="actions"><button type="button" class="btn" data-copy="guest-url">Copy link</button><a class="btn" href="${esc(wa)}">Send on WhatsApp</a><a class="btn" href="${esc(mail)}">Email the link</a></p>`;
}

function linkCallout(share) {
  return `<section class="callout"><h2>Link for ${esc(share.label)}</h2>
<p class="linkbox" id="guest-url">${esc(share.url)}</p>
${sendActions(share)}
<p class="note tight">Works until ${esc(when(share.exp))}. Anyone with this link can view stats.</p></section>`;
}

function accessNote(access, view) {
  if (!access.owner) return "";
  const chosen = access.share?.days || 7;
  const days = SHARE_DAYS.map((d) => `<option value="${d}"${d === chosen ? " selected" : ""}>${d === 1 ? "1 day" : d + " days"}</option>`).join("");
  const name = access.share?.label ? ` value="${esc(access.share.label)}"` : "";
  const error = access.share?.error ? `<p class="note tight">${esc(access.share.error)}</p>` : "";
  const keep = ["range", "sort", "quiet"].map((key) => {
    const value = key === "range" ? view.rangeKey : key === "sort" ? view.sort : view.quiet;
    if (key === "sort" && value === "clicks") return "";
    if (key === "quiet" && value === "hide") return "";
    return `<input type="hidden" name="${key}" value="${esc(value)}">`;
  }).join("");
  return `<section class="block desk"><h2>Temporary access</h2>
<p class="note tight">A link lets one person view these stats until it expires. They do not get your password, and they cannot create links. Changing your admin password ends every link.</p>
<form class="share" action="/admin" method="get">
${keep}
<label>Name <input name="for" maxlength="40" required placeholder="Ada" autocomplete="off"${name}></label>
<label>For <select name="days">${days}</select></label>
<button class="btn primary" type="submit">Create link</button>
</form>${error}</section>`;
}

function render(d, view, access) {
  const { rangeKey } = view;
  const hourly = rangeKey === "today";
  const sentences = briefing(d, rangeKey);
  const tabs = Object.entries(RANGES).map(([k, r]) => `<a href="${esc(href(view, { rangeKey: k }))}"${k === rangeKey ? ' aria-current="page"' : ""}>${esc(r.label)}</a>`).join("");
  const updated = new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  const banner = !access.owner
    ? `<p class="banner">Viewing as ${esc(access.guest.label)} until ${esc(when(access.guest.exp))}.</p>`
    : access.share?.url ? linkCallout(access.share) : "";
  const sections = [
    ["Other links", bars(d.links), d.links.length],
    ["Shared via", bars(d.methods), d.methods.length],
    ["Where visitors came from", bars(d.referrers, d.missing.referrers), true],
    ["Countries", bars(d.locations, d.missing.locations), true],
    ["Screen sizes", bars(d.devices, d.missing.devices), true],
  ];
  return `
${banner}
<header class="mast">
  <div>
    <p class="kicker">Private stats</p>
    <h1>${esc(site.name)}</h1>
    <p class="sub">${esc(periodLabel(d, rangeKey))} · <a href="/">View site</a></p>
  </div>
  <div class="mast-tools">
    <nav class="tabs" aria-label="Date range">${tabs}</nav>
    <div class="actions"><button type="button" class="btn" data-copy="briefing">Copy summary</button><button type="button" class="btn" data-print>Print</button></div>
  </div>
</header>
<section class="lead">
  <div id="briefing">${sentences.map((s) => `<p>${esc(s)}</p>`).join("")}</div>
  ${compareTable(d)}
</section>
<section class="block">
  <header class="block-head"><h2>Visitors ${hourly ? "by hour" : "by day"}</h2></header>
  ${chart(d.points, d.prevPoints || [], hourly)}
</section>
${ranking(d, view)}
<div class="sources">${sections.filter(([, , show]) => show).map(([title, body]) => `<section class="block"><h2>${title}</h2>${body}</section>`).join("")}</div>
<p class="note">Updated ${esc(updated)} UK time. GoatCounter can lag live traffic by up to two hours. <a href="https://${esc(site.goatcounter)}.goatcounter.com">Full GoatCounter dashboard</a></p>
${accessNote(access, view)}`;
}
