#!/usr/bin/env node
// Validates links.json and renders a static site into dist/.
// Usage: node scripts/build.mjs          -> validate + build
//        node scripts/build.mjs --check  -> validate only
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const STATUS_ORDER = ["Live", "In build", "Parked"];

const config = readJson("links.json");
const errors = validate(config);
if (errors.length) fail(errors);
if (process.argv.includes("--check")) {
  console.log("links.json is valid.");
  process.exit(0);
}

const sha = gitSha();
const builtAt = new Date().toISOString();
const links = config.links.filter((l) => l.enabled !== false);
const socials = (config.socials || []).filter((s) => s.enabled !== false);
const businesses = selectBusinesses();
const accent = config.theme?.accent || "#6F4BFF";
const pop = config.theme?.pop || "#FFD23F";
const onAccent = contrastText(accent);
const gc = config.analytics?.goatcounter?.trim();
const vercelAnalytics = config.analytics?.vercel === true;
// Set by CI from actions/configure-pages, e.g. "/my-repo" for project sites, "" for user sites.
const basePath = (process.env.BASE_PATH || "").replace(/\/$/, "") + "/";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (existsSync(join(root, "assets"))) cpSync(join(root, "assets"), join(out, "assets"), { recursive: true });

// Fingerprinted assets can be cached forever; the HTML points at the current hash.
mkdirSync(join(out, "static"), { recursive: true });
const cssFile = fingerprint("styles", "css", css());
const jsFile = fingerprint("app", "js", appJs());
writeFileSync(join(out, "favicon.svg"), favicon());
writeFileSync(join(out, "og.html"), ogCard());
writeFileSync(join(out, "site.webmanifest"), manifest());
if (config.site?.url) {
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${config.site.url.replace(/\/$/, "")}/sitemap.xml\n`);
  writeFileSync(join(out, "sitemap.xml"), sitemap());
}
const contact = (config.socials || []).find((s) => s.url.startsWith("mailto:"))?.url;
if (contact && config.site?.url) {
  mkdirSync(join(out, ".well-known"), { recursive: true });
  writeFileSync(join(out, ".well-known", "security.txt"), securityTxt(contact));
}
writeFileSync(join(out, "index.html"), renderPage());
writeFileSync(join(out, "404.html"), render404());
writeFileSync(join(out, ".nojekyll"), "");

// Private /admin stats page. The function has to live outside dist/: anything inside the
// output directory is a public static file, which is why /admin was a platform 404 and
// /api/admin.mjs was downloadable source. Git builds pick up api/admin.mjs; the CLI
// deploy publishes the same file as a function via .vercel/output.
const adminFn = gc && existsSync(join(root, "functions", "admin.mjs")) ? renderAdminFunction() : null;
rmSync(join(root, "api"), { recursive: true, force: true });
if (adminFn) {
  mkdirSync(join(root, "api"), { recursive: true });
  writeFileSync(join(root, "api", "admin.mjs"), adminFn);
  cpSync(join(root, "functions", "admin.css"), join(out, "admin.css"));
}
writeFileSync(
  join(out, "version.json"),
  JSON.stringify({ sha, builtAt, links: links.length, businesses: businesses.length }, null, 2) + "\n"
);
emitVercelOutput(adminFn);

console.log(`Built dist/ with ${links.length} links and ${businesses.length} businesses (sha ${sha.slice(0, 7)})${adminFn ? ", admin function included" : ""}.`);

function renderAdminFunction() {
  const names = {};
  for (const l of config.links) names[slug(l.title)] = l.title;
  for (const s of config.socials || []) names[slug(s.label)] = s.label;
  for (const b of config.businesses?.items || []) names[slug(b.name)] = b.name;
  names["see-the-studio"] = "See the studio";
  const siteData = { name: config.profile.name, goatcounter: gc, businesses: businesses.map((b) => slug(b.name)), names };
  return readFileSync(join(root, "functions", "admin.mjs"), "utf8").replace("/*SITE*/ {}", JSON.stringify(siteData));
}

// Build Output API so `vercel deploy --prebuilt` runs /api/admin instead of serving it as a file.
function emitVercelOutput(fnSource) {
  const vcOut = join(root, ".vercel", "output");
  rmSync(vcOut, { recursive: true, force: true });
  const staticDir = join(vcOut, "static");
  cpSync(out, staticDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(out, src);
      if (!rel) return true;
      return rel !== "api" && rel !== `api${sep}` && !rel.startsWith(`api${sep}`) && rel !== "vercel.json";
    },
  });

  const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
  const routes = [];
  if (vercel.cleanUrls) {
    const loc = vercel.trailingSlash ? "/$1/" : "/$1";
    routes.push(
      { src: "^/(?:(.+)/)?index(?:\\.html)?/?$", headers: { Location: loc }, status: 308 },
      { src: "^/(.*)\\.html/?$", headers: { Location: loc }, status: 308 }
    );
  }
  if (vercel.trailingSlash === false) {
    routes.push({ src: "^/(.*)\\/$", headers: { Location: "/$1" }, status: 308 });
  }
  for (const rule of vercel.headers || []) {
    const headers = {};
    for (const { key, value } of rule.headers) headers[key] = value;
    routes.push({ src: compileSource(rule.source), headers, continue: true });
  }
  routes.push({ handle: "filesystem" });
  if (fnSource) {
    for (const rule of vercel.rewrites || []) {
      if (typeof rule.destination !== "string") fail([`Rewrite destination must be a path: ${rule.source}`]);
      routes.push({ src: compileSource(rule.source), dest: rule.destination, check: true });
    }
    const fnDir = join(vcOut, "functions", "api", "admin.func");
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(fnDir, "admin.mjs"), fnSource);
    writeFileSync(join(fnDir, ".vc-config.json"), JSON.stringify({
      runtime: "nodejs22.x",
      handler: "admin.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: true,
    }, null, 2) + "\n");
  }
  routes.push({ handle: "miss" });
  routes.push({ src: "^/.*", dest: "/404", status: 404, check: true });

  writeFileSync(join(vcOut, "config.json"), JSON.stringify({
    version: 3,
    routes,
    overrides: htmlOverrides(staticDir),
  }, null, 2) + "\n");
}

// path-to-regexp@6.1.0 with { strict, sensitive, delimiter: "/" }, for the sources in vercel.json.
function compileSource(source) {
  if (!source.startsWith("/")) fail([`Unsupported Vercel route source: ${source}`]);
  let src = "^";
  for (const segment of source.split("/").slice(1)) {
    if (segment === "(.*)") src += "(?:\\/(.*))";
    else if (/[()*?+]/.test(segment)) fail([`Unsupported Vercel route source: ${source}`]);
    else src += "\\/" + segment.replace(/[.+^${}|[\]\\]/g, "\\$&");
  }
  return src + "$";
}

function htmlOverrides(dir, base = "") {
  const overrides = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(overrides, htmlOverrides(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".html") && rel !== "index.html") {
      const clean = rel.slice(0, -".html".length).replace(/\/index$/, "");
      overrides[rel] = { path: clean };
    }
  }
  return overrides;
}

// --- data -------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (err) {
    fail([`${file} could not be read: ${err.message}`]);
  }
}

function validate(c) {
  const e = [];
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const hex = (v) => /^#[0-9a-f]{6}$/i.test(v);
  const hour = (v) => Number.isInteger(v) && v >= 0 && v <= 23;
  const url = (v) => {
    try { return ["https:", "mailto:"].includes(new URL(v).protocol); } catch { return false; }
  };

  if (!c || typeof c !== "object") return ["links.json must contain an object"];
  const p = c.profile || {};
  if (!str(p.name)) e.push("profile.name is required");
  if (p.avatar && !/^https:\/\//.test(p.avatar) && !existsSync(join(root, p.avatar))) {
    e.push(`profile.avatar points to a file that does not exist: ${p.avatar}`);
  }
  if (p.hats && (!Array.isArray(p.hats) || !p.hats.every(str))) e.push("profile.hats must be an array of short labels");
  if (p.sticker !== undefined && !str(p.sticker)) e.push("profile.sticker must be short text, e.g. an emoji pair");

  if (p.clock) {
    if (!str(p.clock.city)) e.push("profile.clock.city is required when clock is set");
    try { new Intl.DateTimeFormat("en-GB", { timeZone: p.clock.timezone }); }
    catch { e.push(`profile.clock.timezone is not a valid IANA timezone: ${p.clock.timezone}`); }
    (p.clock.moods || []).forEach((m, i) => {
      if (!hour(m.from) || !hour(m.to)) e.push(`profile.clock.moods[${i}] needs from and to hours between 0 and 23`);
      if (!str(m.text)) e.push(`profile.clock.moods[${i}].text is required`);
    });
  }

  if (!Array.isArray(c.links) || c.links.length === 0) {
    e.push("links must be a non-empty array");
  } else {
    const seen = new Set();
    c.links.forEach((l, i) => {
      if (!str(l.title)) e.push(`links[${i}].title is required`);
      if (!url(l.url)) e.push(`links[${i}].url must be an https:// or mailto: URL (got ${JSON.stringify(l.url)})`);
      if (seen.has(l.url)) e.push(`links[${i}].url duplicates an earlier link: ${l.url}`);
      seen.add(l.url);
    });
    if (!c.links.some((l) => l.enabled !== false)) e.push("at least one link must be enabled");
  }

  (c.socials || []).forEach((s, i) => {
    if (!str(s.label)) e.push(`socials[${i}].label is required`);
    if (!url(s.url)) e.push(`socials[${i}].url must be an https:// or mailto: URL`);
  });

  if (c.site?.url && !/^https:\/\/[^/]+\/?$/.test(c.site.url)) e.push("site.url must be the site's https:// origin, e.g. https://mahir-links.vercel.app");
  if (c.theme?.accent && !hex(c.theme.accent)) e.push("theme.accent must be a 6-digit hex colour, e.g. #6F4BFF");
  if (c.theme?.pop && !hex(c.theme.pop)) e.push("theme.pop must be a 6-digit hex colour, e.g. #FFD23F");
  if (c.analytics?.vercel !== undefined && typeof c.analytics.vercel !== "boolean") e.push("analytics.vercel must be true or false");
  if (c.analytics?.goatcounter && !/^[a-z0-9-]+$/i.test(c.analytics.goatcounter)) {
    e.push("analytics.goatcounter must be your GoatCounter site code, e.g. alexmorgan");
  }

  const av = c.availability;
  if (av) {
    if (typeof av.enabled !== "boolean") e.push("availability.enabled must be true or false");
    if (av.enabled && !str(av.text)) e.push("availability.text is required when availability is enabled");
    if (av.url && !url(av.url)) e.push("availability.url must be an https:// or mailto: URL");
    if (av.status && !["open", "limited", "closed"].includes(av.status)) e.push("availability.status must be open, limited or closed");
  }

  const b = c.businesses;
  if (b) {
    if (!str(b.title)) e.push("businesses.title is required");
    if (b.more && (!str(b.more.label) || !url(b.more.url))) e.push("businesses.more needs a label and an https:// url");
    if (!Array.isArray(b.items) || b.items.length === 0) {
      e.push("businesses.items must be a non-empty array");
    } else {
      const seen = new Set();
      b.items.forEach((x, i) => {
        if (!str(x.name)) e.push(`businesses.items[${i}].name is required`);
        if (!url(x.url)) e.push(`businesses.items[${i}].url must be an https:// URL`);
        if (!STATUS_ORDER.includes(x.status)) e.push(`businesses.items[${i}].status must be one of: ${STATUS_ORDER.join(", ")}`);
        if (x.stack && !Array.isArray(x.stack)) e.push(`businesses.items[${i}].stack must be an array`);
        if (x.where !== undefined && !str(x.where)) e.push(`businesses.items[${i}].where must be short text, e.g. "iOS App Store"`);
        if (x.alsoOn !== undefined && !str(x.alsoOn)) e.push(`businesses.items[${i}].alsoOn must be short text, e.g. "iOS App Store"`);
        if (x.badgeUntil !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(x.badgeUntil)) e.push(`businesses.items[${i}].badgeUntil must be a date like 2026-10-25`);
        if (x.appStore !== undefined && !/^https:\/\/apps\.apple\.com\//.test(x.appStore)) e.push(`businesses.items[${i}].appStore must be an https://apps.apple.com/ link`);
        if (x.badge !== undefined && !str(x.badge)) e.push(`businesses.items[${i}].badge must be short text, e.g. "New"`);
        if (x.imageFit !== undefined && !["cover", "contain"].includes(x.imageFit)) e.push(`businesses.items[${i}].imageFit must be cover or contain`);
        if (x.imageBg !== undefined && !hex(x.imageBg)) e.push(`businesses.items[${i}].imageBg must be a 6-digit hex colour`);
        if (x.image !== undefined && !/^https:\/\//.test(x.image) && !existsSync(join(root, x.image))) e.push(`businesses.items[${i}].image must be an https:// URL or a file in the repo`);
        if (seen.has(x.name)) e.push(`businesses.items[${i}].name duplicates another business: ${x.name}`);
        seen.add(x.name);
      });
    }
  }
  return e;
}

function selectBusinesses() {
  return (config.businesses?.items || [])
    .map((x, i) => ({ ...x, i }))
    .filter((x) => x.enabled !== false)
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.i - b.i);
}

// --- helpers ----------------------------------------------------------------

function fail(errs) {
  console.error("Config is invalid:\n" + errs.map((x) => `  - ${x}`).join("\n"));
  process.exit(1);
}

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return process.env.GITHUB_SHA || "local";
  }
}

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function contrastText(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#14102A" : "#FFFFFF";
}

function fingerprint(name, ext, content) {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const file = `static/${name}.${hash}.${ext}`;
  writeFileSync(join(out, file), content);
  return file;
}

// 1200x630 share card. Render it to assets/og.png with `npm run og` after changing name, bio or hats.
function ogCard() {
  const { name, hats = [] } = config.profile;
  const site = (config.site?.url || "").replace(/^https:\/\//, "").replace(/\/$/, "");
  const live = businesses.filter((x) => x.status === "Live").length;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,800&family=Instrument+Sans:wght@500;600&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; padding: 72px 80px;
    background: color-mix(in srgb, ${accent} 7%, #fff);
    background-image: radial-gradient(color-mix(in srgb, ${accent} 18%, transparent) 1.5px, transparent 1.8px); background-size: 30px 30px;
    color: #14102A; font-family: "Instrument Sans", system-ui, sans-serif; display: flex; flex-direction: column; }
  .badge { width: 104px; height: 104px; border-radius: 50%; background: ${accent}; color: ${onAccent}; border: 5px solid #14102A;
    display: grid; place-items: center; font: 800 44px/1 "Bricolage Grotesque", "Arial Narrow", sans-serif; }
  h1 { font: 800 150px/0.86 "Bricolage Grotesque", "Arial Narrow", sans-serif; font-stretch: 78%; letter-spacing: -0.035em;
    margin-top: 36px; text-shadow: 7px 7px 0 ${accent}; }
  .hats { display: flex; gap: 14px; margin-top: 40px; flex-wrap: wrap; }
  .hats span { font-size: 26px; font-weight: 600; padding: 8px 20px; border: 3px solid #14102A; border-radius: 999px; background: #fff; }
  .foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; font-size: 28px; font-weight: 600; }
  .pill { background: ${pop}; border: 3px solid #14102A; border-radius: 12px; padding: 8px 18px; box-shadow: 4px 4px 0 #14102A; }
</style></head><body>
  <div class="badge">${esc(initials(name))}</div>
  <h1>${esc(name)}</h1>
  <div class="hats">${hats.slice(0, 3).map((h) => `<span>${esc(h)}</span>`).join("")}</div>
  <div class="foot"><span>${esc(site)}</span>${live ? `<span class="pill">${esc(words(live))} live projects</span>` : ""}</div>
</body></html>
`;
}

function manifest() {
  const { name, bio } = config.profile;
  return JSON.stringify({
    name,
    short_name: name.split(/\s+/)[0],
    description: bio,
    start_url: "/",
    display: "standalone",
    background_color: "#F4F2FF",
    theme_color: accent,
    icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  }, null, 2) + "\n";
}

function sitemap() {
  const site = config.site.url.replace(/\/$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(site)}/</loc><lastmod>${builtAt.slice(0, 10)}</lastmod></url>
</urlset>
`;
}

// RFC 9116. Expires is required; it rolls forward a year on every deploy.
function securityTxt(contact) {
  const site = config.site.url.replace(/\/$/, "");
  const expires = new Date(Date.parse(builtAt) + 365 * 864e5).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  return `Contact: ${contact}
Expires: ${expires}
Preferred-Languages: en
Canonical: ${site}/.well-known/security.txt
`;
}

function favicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="30" cy="30" r="28" fill="${accent}" stroke="#14102A" stroke-width="4"/>
  <text x="30" y="41" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="30" fill="${onAccent}">${esc(initials(config.profile.name))}</text>
  <circle cx="52" cy="52" r="9" fill="${pop}" stroke="#14102A" stroke-width="3"/>
</svg>
`;
}

// For images served through a Next.js image optimiser, offer a 1x and 2x size.
function srcset(src) {
  if (!/\/_next\/image\?/.test(src)) return "";
  const at = (w) => src.replace(/([?&])w=\d+/, `$1w=${w}`);
  return ` srcset="${esc(at(640))} 640w, ${esc(at(1080))} 1080w" sizes="(max-width: 700px) calc(100vw - 2rem), 22rem"`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function words(n) {
  const w = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
  return w[n] ?? String(n);
}

function listJoin(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// Every link carries a stable, human-readable name so clicks can be reported per link.
function clickAttr(label) {
  const name = slug(label);
  return ` data-track="${esc(name)}"` + (gc ? ` data-goatcounter-click="click/${esc(name)}" data-goatcounter-title="${esc(label)}"` : "");
}

// --- rendering --------------------------------------------------------------

function head(title, description, { indexable = true } = {}) {
  const { name, avatar } = config.profile;
  const site = config.site?.url?.replace(/\/$/, "");
  const img = avatar && /^https:\/\//.test(avatar) ? avatar : "";
  const shareImg = site && existsSync(join(root, "assets", "og.png")) ? `${site}/assets/og.png` : img;
  // Profiles that identify you: socials plus featured links (e.g. your blog).
  const sameAs = [...(config.socials || []), ...config.links.filter((l) => l.featured)]
    .map((x) => x.url)
    .filter((u) => /^https:/.test(u));
  const person = {
    "@context": "https://schema.org",
    "@type": "Person",
    name,
    description,
    ...(site && { url: site }),
    ...(img && { image: img }),
    ...(config.businesses && { worksFor: { "@type": "Organization", name: "Prolific Digital Tech", url: config.businesses.more?.url } }),
    sameAs,
  };
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">${indexable ? "" : '\n<meta name="robots" content="noindex">'}
<meta name="theme-color" content="${esc(accent)}">
<link rel="icon" href="${esc(basePath)}favicon.svg" type="image/svg+xml">
<link rel="manifest" href="${esc(basePath)}site.webmanifest">${site && indexable ? `\n<link rel="canonical" href="${esc(site)}/">` : ""}
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(description)}">${site ? `\n<meta property="og:url" content="${esc(site)}/">` : ""}${shareImg ? `\n<meta property="og:image" content="${esc(shareImg)}">\n<meta property="og:image:alt" content="${esc(name)}">` : ""}${shareImg !== img ? '\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">' : ""}
<meta name="twitter:card" content="${shareImg !== img ? "summary_large_image" : "summary"}">
<meta name="build-sha" content="${esc(sha)}">
<meta name="built-at" content="${esc(builtAt)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,600..800&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${esc(basePath + cssFile)}">${indexable ? `\n<script type="application/ld+json">${JSON.stringify(person).replace(/</g, "\\u003c")}</script>` : ""}`;
}

function css() {
  return `
:root {
  --accent: ${accent}; --on-accent: ${onAccent}; --pop: ${pop}; --on-pop: #1A1400;
  --paper: color-mix(in srgb, var(--accent) 7%, #FFFFFF);
  --card: #FFFFFF;
  --ink: color-mix(in srgb, var(--accent) 22%, #0D0B1A);
  --muted: color-mix(in srgb, var(--accent) 18%, #585470);
  --hairline: color-mix(in srgb, var(--accent) 16%, #DAD7E6);
  --dots: color-mix(in srgb, var(--accent) 16%, transparent);
  --accent-text: var(--accent);
  --display: "Bricolage Grotesque", "Arial Narrow", system-ui, sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: color-mix(in srgb, var(--accent) 10%, #0B0A12);
    --card: color-mix(in srgb, var(--accent) 9%, #15141D);
    --ink: #EEEBFF; --muted: #ABA6C4;
    --hairline: color-mix(in srgb, var(--accent) 28%, #2A2838);
    --dots: color-mix(in srgb, var(--accent) 22%, transparent);
    --accent-text: color-mix(in srgb, var(--accent) 55%, white);
  }
}
:root[data-theme="dark"] {
  --paper: color-mix(in srgb, var(--accent) 10%, #0B0A12);
  --card: color-mix(in srgb, var(--accent) 9%, #15141D);
  --ink: #EEEBFF; --muted: #ABA6C4;
  --hairline: color-mix(in srgb, var(--accent) 28%, #2A2838);
  --dots: color-mix(in srgb, var(--accent) 22%, transparent);
  --accent-text: color-mix(in srgb, var(--accent) 55%, white);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
a, button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
body {
  min-height: 100vh;
  background-color: var(--paper);
  background-image: radial-gradient(var(--dots) 1px, transparent 1.2px);
  background-size: 22px 22px;
  color: var(--ink);
  font: 400 1rem/1.55 "Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: max(3rem, env(safe-area-inset-top)) 1.25rem max(3rem, env(safe-area-inset-bottom));
}
main { max-width: 46rem; margin: 0 auto; }
.links, .bio, .now { max-width: 30rem; }

/* intro */
.header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.share {
  min-height: 44px; padding: 0 1.1rem; border-radius: 999px;
  border: 2px solid var(--ink); background: var(--card); color: var(--ink);
  font: 600 0.9375rem/1 "Instrument Sans", system-ui, sans-serif; cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.share:active { transform: translate(1px, 1px); }
.avatar-wrap { position: relative; width: 6rem; height: 6rem; }
.avatar {
  width: 100%; height: 100%; border-radius: 50%;
  border: 3px solid var(--ink); object-fit: cover; display: grid; place-items: center;
  background: var(--accent); color: var(--on-accent);
  font: 800 1.9rem/1 var(--display);
}
.sticker {
  position: absolute; left: 4.25rem; bottom: -0.35rem; white-space: nowrap;
  background: var(--pop); color: var(--on-pop);
  border: 2px solid var(--ink); border-radius: 8px; padding: 0.3rem 0.55rem;
  font: 700 0.85rem/1 "Instrument Sans", system-ui, sans-serif;
  transform: rotate(-7deg); box-shadow: 2px 2px 0 var(--ink);
  animation: slap 420ms cubic-bezier(.2, 1.6, .4, 1) 350ms both;
}
@keyframes slap {
  from { opacity: 0; transform: rotate(-22deg) scale(1.9); }
  to { opacity: 1; transform: rotate(-7deg) scale(1); }
}
h1 {
  font-family: var(--display); font-weight: 800; font-stretch: 78%;
  font-size: clamp(3.5rem, 17vw, 7.5rem); line-height: 0.86; letter-spacing: -0.035em;
  margin: 1.5rem 0 1.25rem;
  text-shadow: 0.045em 0.045em 0 var(--accent);
}
h1 span { display: block; }
.hats { list-style: none; padding: 0; margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.hats li {
  font-size: 0.8125rem; font-weight: 600; padding: 0.3rem 0.7rem;
  border: 1.5px solid var(--ink); border-radius: 999px; background: var(--card);
}
.bio { font-size: 1.0625rem; margin: 0 0 1rem; }
.now { display: flex; align-items: center; gap: 0.55rem; margin: 0 0 2.25rem; color: var(--muted); font-size: 0.9375rem; }
.now::before { content: ""; flex: none; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #2DA44E; box-shadow: 0 0 0 3px color-mix(in srgb, #2DA44E 25%, transparent); }
.now strong { color: var(--ink); font-weight: 600; }

/* availability */
.availability { margin: 0 0 1rem; max-width: 30rem; }
.availability a, .availability > span {
  display: inline-flex; align-items: center; gap: 0.55rem; min-height: 44px; padding: 0 1rem;
  border-radius: 999px; border: 2px dashed var(--ink); background: var(--card); color: var(--ink);
  font-weight: 600; font-size: 0.9375rem; text-decoration: none;
}
.availability i { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--dot); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dot) 25%, transparent); }
.availability-open { --dot: #2DA44E; }
.availability-limited { --dot: #D4A72C; }
.availability-closed { --dot: #8C959F; }

/* links */
.links { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.875rem; }
.links a {
  display: block; padding: 1rem 1.125rem;
  background: var(--card); color: var(--ink); text-decoration: none;
  border: 2px solid var(--ink); border-radius: 14px;
  box-shadow: 0 0 0 var(--accent);
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.links a:active { transform: translate(1px, 1px); box-shadow: 0 0 0 var(--accent); }
.links a.featured { background: var(--accent); color: var(--on-accent); }
.link-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.title { font-weight: 600; font-size: 1.0625rem; }
.tag {
  flex: none; font-size: 0.75rem; font-weight: 600; line-height: 1; padding: 0.3rem 0.5rem;
  border-radius: 6px; background: var(--pop); color: var(--on-pop);
}
.desc { display: block; font-size: 0.9375rem; margin-top: 0.125rem; color: var(--muted); }
.featured .desc { color: inherit; opacity: 0.85; }

/* businesses */
.businesses { margin-top: 4rem; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h2 { font: 800 clamp(1.75rem, 6vw, 2.25rem)/1 var(--display); font-stretch: 85%; letter-spacing: -0.02em; margin: 0; }
.section-head a {
  display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem; border-radius: 999px;
  border: 1.5px solid var(--hairline); background: var(--card);
  color: var(--accent-text); font-weight: 600; text-decoration: none; white-space: nowrap;
}
.section-sub { color: var(--muted); margin: 0.5rem 0 1.25rem; }
.biz-subhead { font: 700 1.125rem/1.2 var(--display); font-stretch: 85%; margin: 2rem 0 0.875rem; color: var(--muted); }
.biz-grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.875rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); }
.biz {
  height: 100%; display: grid; grid-template-columns: auto 1fr; grid-template-areas: "icon top" "desc desc" "meta meta";
  grid-template-rows: auto auto 1fr; column-gap: 0.75rem; row-gap: 0.5rem;
  padding: 1rem 1.125rem; background: var(--card); color: var(--ink); text-decoration: none;
  border: 1.5px solid var(--hairline); border-radius: 12px;
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
}
.biz { position: relative; }
.biz:active:not(:has(.biz-share:active)) { transform: translate(1px, 1px); border-color: var(--ink); }
/* The name link covers the whole card, so tapping anywhere still opens the business */
.biz-link { color: var(--accent-text); text-decoration: none; }
.biz-link::after { content: ""; position: absolute; inset: 0; border-radius: inherit; z-index: 1; }
.biz:has(.biz-link:focus-visible) { outline: 3px solid var(--pop); outline-offset: 3px; }
.biz-link:focus-visible { outline: none; }
.biz-share {
  position: absolute; top: 0.625rem; right: 0.625rem; z-index: 2;
  width: 40px; height: 40px; display: grid; place-items: center; cursor: pointer;
  border-radius: 999px; border: 1.5px solid var(--ink); background: var(--card); color: var(--ink);
  box-shadow: 2px 2px 0 var(--ink); transition: transform 120ms ease, box-shadow 120ms ease;
}
.biz-share:active { transform: translate(2px, 2px); box-shadow: 0 0 0 var(--ink); }
.biz:not(.has-shot) .biz-top { padding-right: 2.75rem; }

/* Share menu (desktop) */
.share-menu {
  position: fixed; z-index: 30; min-width: 13.5rem; padding: 0.375rem;
  background: var(--card); color: var(--ink);
  border: 2px solid var(--ink); border-radius: 12px; box-shadow: 4px 4px 0 var(--accent);
}
.share-menu[hidden] { display: none; }
.share-menu-head { margin: 0; padding: 0.5rem 0.75rem 0.375rem; font-size: 0.8125rem; font-weight: 600; color: var(--muted); }
.share-menu [role="menuitem"] {
  display: flex; align-items: center; width: 100%; min-height: 44px; padding: 0 0.75rem;
  border: 0; border-radius: 8px; background: none; color: inherit; cursor: pointer;
  font: 600 0.9375rem/1 "Instrument Sans", system-ui, sans-serif; text-decoration: none; text-align: left;
}
.share-menu [role="menuitem"]:hover, .share-menu [role="menuitem"]:focus-visible { background: color-mix(in srgb, var(--accent) 12%, var(--card)); outline: none; }
.biz.has-shot { grid-template-areas: "shot shot" "icon top" "desc desc" "meta meta"; grid-template-rows: auto auto auto 1fr; padding-top: 0.75rem; }
.biz-shot {
  grid-area: shot; display: block; margin: 0 -0.375rem 0.25rem; aspect-ratio: 16 / 10; overflow: hidden;
  border-radius: 8px; border: 1.5px solid var(--hairline); background: color-mix(in srgb, var(--accent) 8%, var(--card));
}
.biz-shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.biz-shot.fit-contain img { object-fit: contain; object-position: center; padding: 0.5rem 0 0; }
${(config.businesses?.items || []).filter((x) => x.imageBg).map((x) => `.biz-shot[data-bg="${slug(x.name)}"] { background: ${x.imageBg}; }`).join("\n")}
.biz-icon {
  grid-area: icon; width: 2.5rem; height: 2.5rem; border-radius: 10px;
  display: grid; place-items: center; font-size: 1.3rem;
  background: color-mix(in srgb, var(--pop) 30%, var(--card)); border: 1.5px solid var(--hairline);
}
.biz-top { grid-area: top; align-self: center; display: flex; align-items: center; gap: 0.25rem 0.5rem; flex-wrap: wrap; min-width: 0; }
.biz-name { color: var(--accent-text); font-weight: 700; font-size: 1.0625rem; }

.status {
  display: inline-flex; align-items: center; gap: 0.375rem;
  font-size: 0.75rem; line-height: 1; padding: 0.25rem 0.5rem;
  border: 1px solid var(--hairline); border-radius: 999px; color: var(--muted);
}
.badge-new {
  font-size: 0.7rem; font-weight: 700; line-height: 1; padding: 0.3rem 0.5rem; border-radius: 6px;
  background: var(--pop); color: var(--on-pop); letter-spacing: 0.02em;
}
.also-on { color: var(--ink); font-weight: 600; }
.biz-app {
  grid-column: 1 / -1; position: relative; z-index: 2; justify-self: start; margin-top: 0.25rem;
  display: inline-flex; align-items: center; gap: 0.45rem; min-height: 44px; padding: 0 1rem;
  border-radius: 999px; background: var(--ink); color: var(--paper); font-weight: 600; font-size: 0.875rem; text-decoration: none;
}
.biz-app:active { transform: translate(1px, 1px); }
.biz-grid > li:has(.biz:not(.has-shot)) { align-self: start; }
.status i { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--dot); }
.status-live { --dot: #2DA44E; }
.status-in-build { --dot: #D4A72C; }
.status-parked { --dot: #8C959F; }
.biz-desc { grid-area: desc; font-size: 0.9375rem; color: var(--muted); margin: 0; }
.biz-meta { grid-area: meta; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.8125rem; color: var(--muted); align-self: end; overflow-wrap: anywhere; }

/* outro */
.socials { list-style: none; padding: 0; margin: 3.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.625rem; }
.socials a {
  display: inline-flex; align-items: center; min-height: 44px; padding: 0 1.1rem; border-radius: 999px;
  border: 1.5px solid var(--ink); background: var(--card); color: var(--ink); font-weight: 600; text-decoration: none;
}
.socials a:active, .section-head a:active { transform: translate(1px, 1px); }
footer { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1.5px dashed var(--hairline); font-size: 0.8125rem; color: var(--muted); max-width: 36rem; }
footer code { font-size: 0.8rem; padding: 0.1rem 0.35rem; border-radius: 4px; background: var(--card); border: 1px solid var(--hairline); }
a:focus-visible, button:focus-visible { outline: 3px solid var(--pop); outline-offset: 3px; }

/* Hover effects only on devices that can hover, so taps don't leave cards stuck "lifted". */
@media (hover: hover) {
  .links a:hover { transform: translate(-3px, -3px); box-shadow: 4px 4px 0 var(--accent); }
  .links a.featured:hover { box-shadow: 4px 4px 0 var(--ink); }
  .biz:hover { border-color: var(--ink); transform: translate(-2px, -2px); box-shadow: 3px 3px 0 var(--accent); }
  .biz:hover .biz-name { text-decoration: underline; text-underline-offset: 0.2em; }
  .biz-share:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 var(--accent); }
  .biz-app:hover { box-shadow: 3px 3px 0 var(--accent); transform: translate(-1px, -1px); }
  .share:hover, .socials a:hover, .availability a:hover { transform: translate(-2px, -2px); box-shadow: 3px 3px 0 var(--accent); }
  .section-head a:hover { border-color: var(--accent-text); }
}

/* Phones */
@media (max-width: 480px) {
  body { padding-top: max(1.75rem, env(safe-area-inset-top)); padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right)); }
  h1 { margin: 1.25rem 0 1rem; }
  .hats { gap: 0.375rem; }
  .hats li { font-size: 0.75rem; padding: 0.25rem 0.6rem; }
  .bio { font-size: 1rem; }
  .now { margin-bottom: 1.75rem; }
  .links { gap: 0.75rem; }
  .links a { padding: 0.9rem 1rem; }
  .link-top { display: block; }
  .link-top .tag { display: inline-block; margin-left: 0.4rem; vertical-align: 0.12em; }
  .businesses { margin-top: 3rem; }
  .biz { padding: 0.9rem 1rem; }
  .socials { margin-top: 2.75rem; }
}
/* Mini bar (mobile only, shown by app.js after the name scrolls away) */
.minibar { display: none; }
.swipe-hint { display: none; }

/* ---------- Desktop: two columns, full width ---------- */
@media (min-width: 1024px) {
  body { padding-left: clamp(2rem, 4vw, 4rem); padding-right: clamp(2rem, 4vw, 4rem); }
  .page {
    max-width: 92rem;
    display: grid; column-gap: clamp(2.5rem, 4vw, 5rem);
    grid-template-columns: minmax(19rem, 24rem) minmax(0, 1fr);
    grid-template-areas: "me work" "avail work" "links work" "socials work" "foot work";
    grid-template-rows: auto auto auto auto 1fr;
  }
  .page > header { grid-area: me; }
  .page > .availability { grid-area: avail; }
  .page > .links { grid-area: links; max-width: none; }
  .page > .socials { grid-area: socials; margin-top: 2rem; }
  .page > footer { grid-area: foot; align-self: start; }
  .page > .businesses { grid-area: work; margin-top: 0; padding-top: 0.5rem; }
  .bio, .now { max-width: none; }
  h1 { font-size: clamp(4.5rem, 5.6vw, 6.25rem); }
  h2 { font-size: clamp(2.25rem, 3.2vw, 3rem); }
  .biz-grid { grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr)); gap: 1rem; }
}

/* ---------- A card left alone on the last row stretches into a wide card ---------- */
.biz-grid > li.wide-slot .biz.has-shot {
  grid-template-columns: minmax(0, 1.25fr) auto minmax(0, 1fr);
  grid-template-areas: "shot icon top" "shot desc desc" "shot meta meta";
  grid-template-rows: auto auto 1fr; column-gap: 1rem; padding-top: 1rem;
}
.biz-grid > li.wide-slot .biz-shot { margin: 0 0.25rem 0 -0.375rem; align-self: start; }
@media (min-width: 641px) and (max-width: 1023px) {
  .biz-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .biz-grid > li:last-child:nth-child(2n+1) { grid-column: 1 / -1; }
}
@media (min-width: 1024px) {
  .businesses { container: work / inline-size; }
  @container work (min-width: 32rem) and (max-width: 48.49rem) {
    .biz-grid > li:last-child:nth-child(2n+1) { grid-column: 1 / -1; }
  }
  @container work (min-width: 48.5rem) and (max-width: 64.99rem) {
    .biz-grid > li:last-child:nth-child(3n+1) { grid-column: 1 / -1; }
  }
  @container work (min-width: 65rem) {
    .biz-grid > li:last-child:nth-child(4n+1) { grid-column: 1 / -1; }
  }
}

/* ---------- Phones: app-like ---------- */
@media (max-width: 640px) {
  .minibar {
    display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
    position: fixed; top: 0; left: 0; right: 0; z-index: 10;
    padding: calc(env(safe-area-inset-top) + 0.5rem) max(1rem, env(safe-area-inset-right)) 0.5rem max(1rem, env(safe-area-inset-left));
    background: color-mix(in srgb, var(--paper) 86%, transparent);
    -webkit-backdrop-filter: saturate(1.4) blur(14px); backdrop-filter: saturate(1.4) blur(14px);
    border-bottom: 1px solid var(--hairline);
    transform: translateY(-100%); transition: transform 200ms ease;
  }
  .minibar.show { transform: none; }
  html { scroll-padding-top: calc(env(safe-area-inset-top) + 4rem); }
  .minibar-name { font: 800 1.25rem/1 var(--display); font-stretch: 85%; letter-spacing: -0.02em; }
  .share-sm { min-height: 40px; padding: 0 0.95rem; font-size: 0.875rem; }
  .biz-share { width: 44px; height: 44px; }

  /* Businesses become a swipeable row with the next card peeking in */
  .swipe-hint { display: block; margin: -0.75rem 0 0.75rem; font-size: 0.8125rem; font-weight: 600; color: var(--accent-text); }
  .biz-grid {
    grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: 84%;
    overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory;
    scroll-padding-inline: 1rem; padding: 0.25rem 1rem 1rem; margin: 0 -1rem;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .biz-grid::-webkit-scrollbar { display: none; }
  .biz-grid > li { scroll-snap-align: start; }
  .biz-grid > li:has(.biz:not(.has-shot)) { align-self: stretch; }

  /* Bigger, thumb-friendly rows; socials share the width evenly */
  .links a { padding: 1rem 1.1rem; border-radius: 16px; }
  .socials { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
  .socials li { display: flex; }
  .socials a { flex: 1; justify-content: center; min-height: 48px; }
}

@media (prefers-reduced-motion: reduce) {
  .minibar { transition: none; }
  .sticker { animation: none; }
  .links a, .biz, .share { transition: none; }
  .links a:hover, .biz:hover, .share:hover, .socials a:hover { transform: none; }
}`;
}

function analyticsTag() {
  const tags = [];
  if (vercelAnalytics) tags.push(`<script src="/_vercel/insights/script.js" defer></script>`);
  if (gc) tags.push(`<script data-goatcounter="https://${esc(gc)}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>`);
  return tags.join("\n  ");
}

function renderNow() {
  const clock = config.profile.clock;
  if (!clock) return "";
  const data = { city: clock.city, tz: clock.timezone, moods: clock.moods || [] };
  // Server-rendered fallback, enhanced by the script below with a live clock and mood.
  return `
    <p class="now" data-now="${esc(JSON.stringify(data))}"><span><strong data-clock>${esc(clock.city)}</strong> <span data-mood>${esc(clock.fallback || "")}</span></span></p>`;
}

function appJs() {
  return `(() => {
  // Analytics queue: calls made before Vercel's script loads are replayed once it does.
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  const track = (name, data) => {
    try { window.va("event", { name, data }); } catch (_) {}
    // GoatCounter counts link clicks itself (data-goatcounter-click); shares are sent from here.
    if (name === "Share") {
      try { window.goatcounter?.count?.({ path: "share/" + data.from + "/" + data.method, title: "Share " + data.from + " via " + data.method, event: true }); } catch (_) {}
    }
  };

  // One listener for every tracked link: which link, and which part of the page it was in.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-track]");
    if (!a) return;
    const section = a.closest("[data-section]")?.dataset.section || "page";
    track("Link click", { link: a.dataset.track, section });
  });

  // "New" badges carry an end date; hide them once it has passed, no redeploy needed.
  const today = new Date().toISOString().slice(0, 10);
  document.querySelectorAll(".badge-new[data-until]").forEach((b) => { if (b.dataset.until < today) b.remove(); });

  // A screenshot that fails to load is removed, so the card falls back to its plain layout.
  const dropShot = (img) => { const a = img.closest(".biz"); img.parentElement.remove(); a && a.classList.remove("has-shot"); };
  document.addEventListener("error", (e) => { if (e.target.matches && e.target.matches("img[data-shot]")) dropShot(e.target); }, true);
  document.querySelectorAll("img[data-shot]").forEach((img) => { if (img.complete && img.naturalWidth === 0) dropShot(img); });

  // ---------- Sharing ----------
  // Phones (touch): the native share sheet, which covers Instagram, WhatsApp, Messages and every installed app.
  // Desktop: a small menu of the main platforms plus Copy link.
  const touch = matchMedia("(pointer: coarse)").matches;
  const enc = encodeURIComponent;
  const targets = [
    ["WhatsApp", (d) => "https://wa.me/?text=" + enc(d.text + " " + d.url)],
    ["X", (d) => "https://x.com/intent/tweet?text=" + enc(d.text) + "&url=" + enc(d.url)],
    ["LinkedIn", (d) => "https://www.linkedin.com/sharing/share-offsite/?url=" + enc(d.url)],
    ["Facebook", (d) => "https://www.facebook.com/sharer/sharer.php?u=" + enc(d.url)],
    ["Email", (d) => "mailto:?subject=" + enc(d.title) + "&body=" + enc(d.text + "\\n\\n" + d.url)],
  ];

  const menu = document.createElement("div");
  menu.className = "share-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  let opener = null;

  const closeMenu = (refocus) => {
    if (menu.hidden) return;
    menu.hidden = true;
    opener?.setAttribute("aria-expanded", "false");
    if (refocus) opener?.focus();
    opener = null;
  };

  const openMenu = (btn, d, from) => {
    menu.replaceChildren();
    const head = document.createElement("p");
    head.className = "share-menu-head";
    head.textContent = "Share " + d.title;
    menu.append(head);
    for (const [label, build] of targets) {
      const a = document.createElement("a");
      a.setAttribute("role", "menuitem");
      a.href = build(d);
      a.textContent = label;
      if (!a.href.startsWith("mailto:")) { a.target = "_blank"; a.rel = "noopener"; }
      a.addEventListener("click", () => { track("Share", { from, method: label.toLowerCase() }); closeMenu(false); });
      menu.append(a);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.setAttribute("role", "menuitem");
    copy.textContent = "Copy link";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(d.url); copy.textContent = "Link copied"; } catch (_) { copy.textContent = d.url; }
      track("Share", { from, method: "copy" });
      setTimeout(() => closeMenu(true), 900);
    });
    menu.append(copy);

    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
    const top = r.bottom + 8 + h > innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    opener = btn;
    btn.setAttribute("aria-expanded", "true");
    menu.querySelector("[role=menuitem]")?.focus();
  };

  const share = async (btn, d, from) => {
    if (!menu.hidden && opener === btn) return closeMenu(true);
    if (touch && navigator.share) {
      try { await navigator.share({ title: d.title, text: d.text, url: d.url }); track("Share", { from, method: "native" }); } catch (_) { /* dismissed */ }
      return;
    }
    openMenu(btn, d, from);
  };

  document.querySelectorAll("[data-share]").forEach((btn) => {
    btn.hidden = false;
    btn.addEventListener("click", () => share(btn, {
      title: document.title,
      text: document.querySelector('meta[name="description"]')?.content || document.title,
      url: location.href.split("#")[0],
    }, "page-" + btn.dataset.share));
  });
  document.querySelectorAll("[data-share-card]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      share(btn, { title: btn.dataset.shareTitle, text: btn.dataset.shareText, url: btn.dataset.shareUrl }, btn.dataset.shareId);
    });
  });

  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== opener && !opener?.contains(e.target)) closeMenu(false); });
  document.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") return closeMenu(true);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...menu.querySelectorAll("[role=menuitem]")];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  addEventListener("scroll", () => closeMenu(false), { passive: true });
  addEventListener("resize", () => closeMenu(false), { passive: true });

  // Whichever card CSS stretches across the last row gets the wide, side-by-side layout.
  const markWide = () => document.querySelectorAll(".biz-grid > li").forEach((li) => {
    const grid = li.parentElement.getBoundingClientRect();
    li.classList.toggle("wide-slot", li.getBoundingClientRect().width > grid.width * 0.9 && grid.width > 600);
  });
  markWide();
  addEventListener("resize", markWide, { passive: true });

  // Mobile carousel: the hint becomes a live "3 of 7" position counter once you start swiping.
  const hint = document.querySelector("[data-swipe-hint]");
  const rail = document.querySelector(".biz-grid");
  if (hint && rail) {
    const total = Number(hint.dataset.total);
    let raf = 0;
    rail.addEventListener("scroll", () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const first = rail.querySelector("li");
        if (!first || rail.scrollWidth <= rail.clientWidth) return;
        const step = first.getBoundingClientRect().width + parseFloat(getComputedStyle(rail).columnGap || 0);
        const atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
        const n = atEnd ? total : Math.min(total, Math.round(rail.scrollLeft / step) + 1);
        hint.textContent = n + " of " + total + (n === total ? ". That's everything." : "");
      });
    }, { passive: true });
  }

  // Mobile: a compact bar slides in once the big name has scrolled away.
  const bar = document.querySelector("[data-minibar]");
  const title = document.querySelector("h1");
  if (bar && title && "IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => {
      const show = !e.isIntersecting && e.boundingClientRect.top < 0;
      bar.classList.toggle("show", show);
      bar.inert = !show;
    }).observe(title);
  }

  // Live local clock and mood line.
  const el = document.querySelector("[data-now]");
  if (!el) return;
  const cfg = JSON.parse(el.dataset.now);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: cfg.tz });
  const hourOf = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: cfg.tz });
  const inRange = (h, m) => (m.from <= m.to ? h >= m.from && h < m.to : h >= m.from || h < m.to);
  function tick() {
    const now = new Date();
    const h = Number(hourOf.format(now));
    const mood = cfg.moods.find((m) => inRange(h, m));
    el.querySelector("[data-clock]").textContent = cfg.city + ", " + time.format(now) + ".";
    if (mood) el.querySelector("[data-mood]").textContent = mood.text;
  }
  tick();
  setInterval(tick, 30000);
})();
`;
}

function appScript() {
  return jsFile ? `<script src="${esc(basePath + jsFile)}" defer></script>` : "";
}

function shareIcon() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 3v12M12 3l-4.5 4.5M12 3l4.5 4.5M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderAvailability() {
  const av = config.availability;
  if (!av?.enabled) return "";
  const status = av.status || "open";
  const inner = `<i aria-hidden="true"></i><span>${esc(av.text)}</span>`;
  return `
    <p class="availability availability-${status}" data-section="availability">${av.url
      ? `<a href="${esc(av.url)}"${clickAttr("availability")} rel="noopener">${inner}</a>`
      : `<span>${inner}</span>`}</p>`;
}

function renderBusinesses() {
  if (!businesses.length) return "";
  const { title, more } = config.businesses;
  const liveCount = businesses.filter((x) => x.status === "Live").length;
  const cooking = businesses.filter((x) => x.status === "In build").map((x) => x.name);
  const sub = `${words(liveCount)} live.${cooking.length ? ` ${listJoin(cooking)} ${cooking.length === 1 ? "is" : "are"} still in the oven.` : " Nothing in the oven, for now."}`;

  const card = (x) => {
      const host = x.where || (x.status === "Live" ? new URL(x.url).hostname.replace(/^www\./, "") : "");
      const meta = [
        host ? `<span>${esc(host)}</span>` : "",
        x.alsoOn ? `<span class="also-on">Also on the ${esc(x.alsoOn)}</span>` : "",
        x.kind ? `<span>${esc(x.kind)}</span>` : "",
        x.stack?.length ? `<span>${esc(x.stack.join(", "))}</span>` : "",
      ].filter(Boolean).join("");
      return `
      <li><article class="biz${x.image ? " has-shot" : ""}" id="${esc(slug(x.name))}">
        <button class="biz-share" type="button" data-share-card data-share-url="${esc(x.url)}" data-share-title="${esc(x.name)}" data-share-text="${esc(x.description ? `${x.name}: ${x.description}` : x.name)}" data-share-id="${esc(slug(x.name))}" aria-haspopup="menu" aria-label="${esc(`Share ${x.name}`)}">${shareIcon()}</button>${x.image ? `
        <span class="biz-shot${x.imageFit === "contain" ? " fit-contain" : ""}"${x.imageBg ? ` data-bg="${esc(slug(x.name))}"` : ""}><img src="${esc(/^https:/.test(x.image) ? x.image : basePath + x.image.replace(/^\//, ""))}"${srcset(x.image)} alt="${esc(`Screenshot of ${x.name}`)}" width="640" height="400" loading="lazy" decoding="async" data-shot></span>` : ""}
        <span class="biz-icon" aria-hidden="true">${esc(x.icon || x.name[0])}</span>
        <span class="biz-top"><a class="biz-name biz-link" href="${esc(x.url)}"${clickAttr(x.name)} rel="noopener">${esc(x.name)}</a><span class="status status-${slug(x.status)}"><i aria-hidden="true"></i>${esc(x.status)}</span>${x.badge && !(x.badgeUntil && x.badgeUntil < builtAt.slice(0, 10)) ? `<span class="badge-new"${x.badgeUntil ? ` data-until="${esc(x.badgeUntil)}"` : ""}>${esc(x.badge)}</span>` : ""}</span>${x.description ? `
        <p class="biz-desc">${esc(x.description)}</p>` : ""}${meta ? `
        <span class="biz-meta">${meta}</span>` : ""}${x.appStore ? `
        <a class="biz-app" href="${esc(x.appStore)}"${clickAttr(x.name + " app store")} rel="noopener"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Get it on the App Store</a>` : ""}
      </article></li>`;
  };
  // Screenshot cards first, so image cards share rows with image cards.
  const live = businesses.filter((x) => x.status === "Live").sort((a, b) => Boolean(b.image) - Boolean(a.image));
  const later = businesses.filter((x) => x.status !== "Live");
  const cards = live.map(card).join("");
  const laterCards = later.map(card).join("");

  return `
    <section class="businesses" aria-labelledby="biz-title" data-section="businesses">
      <div class="section-head">
        <h2 id="biz-title">${esc(title)}</h2>${more ? `
        <a href="${esc(more.url)}"${clickAttr("see-the-studio")} rel="noopener">${esc(more.label)}</a>` : ""}
      </div>
      <p class="section-sub">${esc(sub)}</p>
      <p class="swipe-hint" aria-hidden="true" data-swipe-hint data-total="${businesses.length}">Swipe to see all ${esc(words(businesses.length).toLowerCase())}</p>
      <ul class="biz-grid">${cards}
      </ul>${later.length ? `
      <h3 class="biz-subhead">In the oven</h3>
      <ul class="biz-grid biz-grid-later">${laterCards}
      </ul>` : ""}
    </section>`;
}

function renderPage() {
  const { name, bio, avatar, hats, sticker } = config.profile;
  const avatarHtml = avatar
    ? `<img class="avatar" src="${esc(avatar)}" alt="${esc(name)}" width="96" height="96">`
    : `<div class="avatar" aria-hidden="true">${esc(initials(name))}</div>`;
  const stickerHtml = sticker ? `<span class="sticker">${esc(sticker)}</span>` : "";
  const nameHtml = name.split(/\s+/).map((w) => `<span>${esc(w)}</span>`).join("");
  const hatsHtml = hats?.length ? `
    <ul class="hats" aria-label="What I do">${hats.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : "";

  const linkItems = links
    .map(
      (l) => `
      <li><a href="${esc(l.url)}"${l.featured ? ' class="featured"' : ""}${clickAttr(l.title)} rel="noopener">
        <span class="link-top"><span class="title">${esc(l.title)}</span>${l.tag ? `<span class="tag">${esc(l.tag)}</span>` : ""}</span>${l.description ? `
        <span class="desc">${esc(l.description)}</span>` : ""}
      </a></li>`
    )
    .join("");

  const socialItems = socials.length
    ? `
    <ul class="socials" data-section="socials">${socials
      .map((s) => `
      <li><a href="${esc(s.url)}"${clickAttr(s.label)} rel="me noopener">${esc(s.label)}</a></li>`)
      .join("")}
    </ul>`
    : "";

  const updated = new Date(builtAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const commit = sha === "local" ? "a local build" : `commit <code>${esc(sha.slice(0, 7))}</code>`;

  return `<!doctype html>
<html lang="en">
<head>
${head(name, bio || `Links from ${name}`)}
</head>
<body>
  <div class="minibar" data-minibar inert>
    <span class="minibar-name">${esc(name)}</span>
    <button class="share share-sm" type="button" data-share="minibar" aria-haspopup="menu" hidden>Share</button>
  </div>
  <main class="page">
    <header>
      <div class="header-top">
        <div class="avatar-wrap">${avatarHtml}${stickerHtml}</div>
        <button class="share" type="button" data-share="header" aria-haspopup="menu" hidden>Share</button>
      </div>
      <h1>${nameHtml}</h1>${hatsHtml}
      ${bio ? `<p class="bio">${esc(bio)}</p>` : ""}${renderNow()}
    </header>${renderAvailability()}
    <ul class="links" data-section="links">${linkItems}
    </ul>${renderBusinesses()}${socialItems}
    <footer>Hand-built, no framework. Shipped by a pipeline that checks on itself every six hours. Last deployed ${esc(updated)} from ${commit}.</footer>
  </main>
  ${appScript()}
  ${analyticsTag()}
</body>
</html>
`;
}

function render404() {
  return `<!doctype html>
<html lang="en">
<head>
${head("Page not found", "This page does not exist.", { indexable: false })}
</head>
<body>
  <main>
    <h1><span>404</span></h1>
    <p class="bio">This page never shipped. Everything ${esc(config.profile.name)} has shipped is on the home page.</p>
    <ul class="links"><li><a href="${esc(basePath)}"><span class="title">Go to the home page</span></a></li></ul>
  </main>
</body>
</html>
`;
}
