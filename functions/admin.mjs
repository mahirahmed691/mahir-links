// /admin: password-protected stats dashboard, rendered on the server.
// Needs two environment variables in Vercel (Project → Settings → Environment Variables):
//   ADMIN_PASSWORD     the password for this page (any username works)
//   GOATCOUNTER_TOKEN  a GoatCounter API key with read access
// The GoatCounter key never reaches the browser; this function fetches the numbers and returns plain HTML.
import crypto from "node:crypto";

// Filled in by scripts/build.mjs from links.json (display names, business list, GoatCounter code).
const site = /*SITE*/ {};

const RANGES = { today: { label: "Today", days: 1 }, "7d": { label: "7 days", days: 7 }, "30d": { label: "30 days", days: 30 } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const password = process.env.ADMIN_PASSWORD;
  const token = process.env.GOATCOUNTER_TOKEN;
  if (!password || !token) {
    res.statusCode = 503;
    return send(res, page("Admin not set up", `<p class="note">Add <code>ADMIN_PASSWORD</code> and <code>GOATCOUNTER_TOKEN</code> in Vercel → Project → Settings → Environment Variables, then redeploy.</p>`));
  }
  if (!authorised(req.headers.authorization, password)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down password guessing
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="Stats", charset="UTF-8"');
    return send(res, page("Sign in required", `<p class="note">This page is private.</p>`));
  }

  const rangeKey = RANGES[req.query?.range] ? req.query.range : "7d";
  try {
    const data = await load(globalThis.__adminFetch || fetch, token, rangeKey);
    send(res, page("Stats", render(data, rangeKey)));
  } catch (err) {
    console.error("admin: GoatCounter request failed", err);
    res.statusCode = 502;
    send(res, page("Stats unavailable", `<p class="note">Couldn't reach GoatCounter: ${esc(err.message)}. Try again in a minute.</p>`));
  }
}

function authorised(header, password) {
  if (!header || !header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(given), h(password));
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
  const get = (path) => getRange(path, q);
  const getRange = async (path, query) => {
    const r = await fetchImpl(`${base}${path}${path.includes("?") ? "&" : "?"}${query}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!r.ok) throw new Error(`${path.split("?")[0]} returned ${r.status}`);
    return r.json();
  };
  // Sequential: GoatCounter allows ~4 requests/second.
  const hits = await get("/stats/hits?limit=100");
  const prevStart = new Date(start.getTime() - RANGES[rangeKey].days * 864e5);
  const prevHits = await getRange("/stats/hits?limit=100", `start=${fmt(prevStart)}&end=${fmt(start)}`);
  const refs = await get("/stats/toprefs?limit=8");
  const locations = await get("/stats/locations?limit=8");
  const sizes = await get("/stats/sizes?limit=6");

  const list = hits.hits || [];
  const pages = list.filter((h) => !h.event);
  const events = list.filter((h) => h.event);
  const clicks = events.filter((h) => h.path.startsWith("click/"));
  const shares = events.filter((h) => h.path.startsWith("share/"));

  // Visitors per day (or per hour for "today"), from page hits only.
  const series = new Map();
  for (const p of pages) for (const s of p.stats || []) {
    if (rangeKey === "today") (s.hourly || []).forEach((n, i) => series.set(`${s.day} ${i}`, (series.get(`${s.day} ${i}`) || 0) + n));
    else series.set(s.day, (series.get(s.day) || 0) + (s.daily || 0));
  }
  let points = [...series.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
  if (rangeKey === "today") points = points.slice(-24);

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
    businesses: [...board.values()].sort((a, b) => b.clicks + b.shares - (a.clicks + a.shares) || a.name.localeCompare(b.name)),
    links: otherLinks.sort((a, b) => b.count - a.count),
    methods: [...byMethod.entries()].map(([name, count]) => ({ name: METHOD_NAMES[name] || name, count })).sort((a, b) => b.count - a.count),
    referrers: byCount((refs.stats || []).map((r) => ({ name: r.name || "Direct or unknown", count: r.count }))),
    locations: byCount((locations.stats || []).map((r) => ({ name: r.name || "Unknown", count: r.count }))),
    devices: byCount((sizes.stats || []).map((r) => ({ name: r.name || "Unknown", count: r.count }))),
  };
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
</head><body><main class="admin">${body}</main></body></html>`;
}

function bars(rows) {
  if (!rows.length) return `<p class="empty">Nothing yet.</p>`;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return `<ul class="bars">${rows.map((r) => `<li><span class="bar-label">${esc(r.name)}</span><span class="bar-track"><span class="bar-fill w${Math.max(2, Math.round((r.count / max) * 50) * 2)}"></span></span><span class="bar-num">${n(r.count)}</span></li>`).join("")}</ul>`;
}

function chart(points, hourly) {
  if (!points.length || points.every(([, v]) => !v)) return `<p class="empty">No visitors recorded in this period yet.</p>`;
  const W = 720, H = 180, pad = 22, max = Math.max(...points.map(([, v]) => v), 1);
  const bw = (W - pad) / points.length;
  const label = (k) => hourly ? `${k.split(" ")[1]}:00` : new Date(k + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const every = Math.ceil(points.length / 8);
  return `<svg class="chart" viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="Visitors over time">
${points.map(([k, v], i) => {
    const h = Math.round((v / max) * (H - 30));
    const x = pad + i * bw + bw * 0.15, w = bw * 0.7;
    return `<rect x="${x.toFixed(1)}" y="${H - h}" width="${w.toFixed(1)}" height="${h}" rx="3" class="chart-bar"><title>${esc(label(k))}: ${n(v)}</title></rect>` +
      (i % every === 0 ? `<text x="${(x + w / 2).toFixed(1)}" y="${H + 15}" text-anchor="middle" class="chart-label">${esc(label(k))}</text>` : "");
  }).join("")}
<text x="0" y="0" dominant-baseline="hanging" class="chart-label">${n(max)} max</text>
</svg>`;
}

function trend(now, before, rangeKey) {
  const period = { today: "yesterday", "7d": "previous 7 days", "30d": "previous 30 days" }[rangeKey];
  if (!before && !now) return `<span class="trend flat">No change vs ${period}</span>`;
  if (!before) return `<span class="trend up">New vs ${period}</span>`;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return `<span class="trend flat">Same as ${period}</span>`;
  return `<span class="trend ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs ${period}</span>`;
}

function render(d, rangeKey) {
  const ctr = d.visitors ? Math.round((d.clicks / d.visitors) * 100) : 0;
  const tabs = Object.entries(RANGES).map(([k, r]) => `<a href="/admin?range=${k}"${k === rangeKey ? ' aria-current="page"' : ""}>${esc(r.label)}</a>`).join("");
  const updated = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  return `
<header class="admin-head">
  <div><h1>Stats</h1><p class="sub">${esc(site.name)} · <a href="/">View site</a></p></div>
  <nav class="tabs" aria-label="Date range">${tabs}</nav>
</header>
<section class="kpis">
  <div class="kpi"><span class="kpi-num">${n(d.visitors)}</span><span class="kpi-label">Visitors</span>${trend(d.visitors, d.prev.visitors, rangeKey)}</div>
  <div class="kpi"><span class="kpi-num">${n(d.clicks)}</span><span class="kpi-label">Link clicks</span>${trend(d.clicks, d.prev.clicks, rangeKey)}</div>
  <div class="kpi"><span class="kpi-num">${n(d.shares)}</span><span class="kpi-label">Shares</span>${trend(d.shares, d.prev.shares, rangeKey)}</div>
  <div class="kpi"><span class="kpi-num">${ctr}%</span><span class="kpi-label">Clicks per visitor</span></div>
</section>
<section class="panel wide"><h2>Visitors ${rangeKey === "today" ? "by hour" : "by day"}</h2>${chart(d.points, rangeKey === "today")}</section>
<section class="panel wide">
  <h2>Businesses</h2>
  <table><thead><tr><th>Business</th><th>Clicks</th><th>Shares</th></tr></thead><tbody>
  ${d.businesses.map((b) => `<tr><td>${esc(b.name)}</td><td>${n(b.clicks)}</td><td>${n(b.shares)}</td></tr>`).join("")}
  </tbody></table>
</section>
<div class="grid">
  <section class="panel"><h2>Other links</h2>${bars(d.links)}</section>
  <section class="panel"><h2>Shared via</h2>${bars(d.methods)}</section>
  <section class="panel"><h2>Where visitors came from</h2>${bars(d.referrers)}</section>
  <section class="panel"><h2>Countries</h2>${bars(d.locations)}</section>
  <section class="panel"><h2>Screen sizes</h2>${bars(d.devices)}</section>
</div>
<p class="note">Updated ${esc(updated)} UK time. GoatCounter's figures can lag live traffic by up to two hours. <a href="https://${esc(site.goatcounter)}.goatcounter.com">Full GoatCounter dashboard</a></p>`;
}
