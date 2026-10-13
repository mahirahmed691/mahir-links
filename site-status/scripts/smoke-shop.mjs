#!/usr/bin/env node
// Open the shop pages a customer uses. Fail if one is down, not html, or leaves the shop.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { publicHttpsUrl } from "./pitch.mjs";

export const SLOW_MS = 2500;
export const HEAVY_BYTES = 500 * 1024;
export const SMOKE_ASPECTS = ["Open", "Speed", "Weight", "Prices"];

export function normalAspect(value) {
  const aspect = String(value || "Open").trim() || "Open";
  if (!SMOKE_ASPECTS.includes(aspect)) throw new Error(`The aspect must be one of ${SMOKE_ASPECTS.join(", ")}.`);
  return aspect;
}

export function judgeCheck(check, aspect = "Open") {
  const mode = normalAspect(aspect);
  if (!check.ok || mode === "Open") return check;
  const take = (prefix) => (check.warnings || []).find((warning) => warning.startsWith(prefix));
  if (mode === "Speed") {
    const slow = take("Slow");
    if (!slow) return check;
    return { ...check, ok: false, reason: slow, warnings: check.warnings.filter((warning) => warning !== slow) };
  }
  if (mode === "Weight") {
    const heavy = take("Heavy page");
    if (!heavy) return check;
    return { ...check, ok: false, reason: heavy, warnings: check.warnings.filter((warning) => warning !== heavy) };
  }
  if (mode === "Prices" && check.kind === "product" && !check.prices) {
    const reason = "No price on this product.";
    return { ...check, ok: false, reason, warnings: (check.warnings || []).filter((warning) => warning !== reason) };
  }
  return check;
}

export function shopPages(config) {
  const origin = new URL(publicHttpsUrl(config?.url));
  const pages = Array.isArray(config?.pages) ? config.pages : [];
  if (!pages.length) throw new Error("Name the shop pages to open.");
  return pages.map((page) => {
    const name = String(page?.name || "").trim();
    const expect = String(page?.expect || "");
    const emoji = String(page?.emoji || "🔎");
    const minProducts = Number(page?.minProducts || 0);
    if (!name) throw new Error("Every shop page needs a name.");
    if (!expect) throw new Error(`${name} needs the text a customer should see.`);
    const url = new URL(page.path, origin);
    const safe = publicHttpsUrl(url);
    if (new URL(safe).host !== origin.host) throw new Error(`${name} must stay on ${origin.host}.`);
    return { name, emoji, url: safe, expect, minProducts, kind: page?.kind || "page" };
  });
}

export function sitemapLocs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1].replace(/&amp;/g, "&").trim());
}

export function describeUrl(value) {
  const url = new URL(value);
  const path = url.pathname;
  let kind = "page";
  let emoji = "📄";
  if (/^\/product\/.+/.test(path)) {
    kind = "product";
    emoji = "👗";
  } else if (path.startsWith("/collections")) {
    kind = "collection";
    emoji = "🗂️";
  } else if (path.startsWith("/blog")) {
    kind = "journal";
    emoji = "📰";
  } else if (path === "/") emoji = "🏠";
  return { kind, emoji, name: nameFromPath(path) };
}

function nameFromPath(pathname) {
  if (!pathname || pathname === "/") return "Home";
  const slug = pathname.split("/").filter(Boolean).at(-1);
  return slug.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pageKey(value) {
  const url = new URL(value);
  return `${url.host}${url.pathname.replace(/\/$/, "") || "/"}`;
}

export async function discoverPages(config, fetchImpl) {
  const origin = new URL(publicHttpsUrl(config?.url));
  const extras = shopPages({ url: origin, pages: config?.extra || [] });
  const found = [];
  for (const sitemap of config?.sitemaps || []) {
    const safe = publicHttpsUrl(sitemap);
    if (new URL(safe).host !== origin.host) throw new Error("The sitemap must stay on the shop.");
    const response = await fetchImpl(safe, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
      headers: { "user-agent": "mahirahmed-site-status" },
    });
    const xml = typeof response.text === "function" ? await response.text() : "";
    for (const loc of sitemapLocs(xml)) {
      let listed;
      try {
        listed = publicHttpsUrl(loc);
      } catch {
        continue;
      }
      if (new URL(listed).host !== origin.host) continue;
      const described = describeUrl(listed);
      found.push({
        name: described.name,
        emoji: described.emoji,
        url: listed,
        expect: "Abayas Boutique",
        minProducts: 0,
        kind: described.kind,
      });
    }
  }
  const pages = [];
  const seen = new Set();
  for (const page of [...extras, ...found]) {
    const key = pageKey(page.url);
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(page);
  }
  if (!pages.length) throw new Error("The sitemap did not list any shop pages.");
  return pages;
}

export function selectSection(config, name) {
  const sections = Array.isArray(config?.sections) ? config.sections : [];
  const section = sections.find((item) => item.name === name);
  if (!section) {
    const names = sections.map((item) => item.name).join(", ");
    throw new Error(names ? `No smoke stage named ${name}. Stages: ${names}.` : "This smoke file has no stages.");
  }
  return {
    name: `${String(config.name || "Shop").trim()} · ${section.name}`,
    url: config.url,
    sitemaps: section.sitemaps || [],
    pages: section.pages || section.extra || [],
    extra: section.extra || [],
  };
}

export function paceNotes(ms, bytes) {
  const notes = [];
  if (ms >= SLOW_MS) notes.push(`Slow. ${seconds(ms)}. A customer is waiting.`);
  if (bytes >= HEAVY_BYTES) notes.push(`Heavy page. ${size(bytes)}.`);
  return notes;
}

export async function smokeShop(config, { fetchImpl = fetch, timeoutMs = 25000, now = () => new Date(), onPage, aspect = "Open" } = {}) {
  const mode = normalAspect(aspect);
  const pages = config?.sitemaps?.length ? await discoverPages(config, fetchImpl) : shopPages(config);
  const checks = [];
  for (const page of pages) {
    const check = judgeCheck(await openPage(page, fetchImpl, timeoutMs), mode);
    checks.push(check);
    if (onPage) onPage(check, checks.length, pages.length);
  }
  return {
    name: String(config?.name || "Shop").trim() || "Shop",
    url: publicHttpsUrl(config?.url),
    checkedAt: londonClock(now()),
    aspect: mode,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function openPage(page, fetchImpl, timeoutMs) {
  const started = Date.now();
  const blank = {
    name: page.name,
    emoji: page.emoji,
    url: page.url,
    finalUrl: page.url,
    status: null,
    type: "",
    title: "",
    products: 0,
    prices: 0,
    images: 0,
    bytes: 0,
    h1: "",
    description: "",
    canonical: "",
    words: 0,
    links: 0,
    forms: 0,
    kind: page.kind || "page",
    warnings: [],
  };
  try {
    const response = await fetchImpl(page.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "mahirahmed-site-status" },
    });
    const ms = Date.now() - started;
    const finalUrl = response.url || page.url;
    const type = response.headers?.get?.("content-type") || "";
    const body = typeof response.text === "function" ? await response.text() : "";
    const bytes = Buffer.byteLength(body);
    const detail = readPage(body);
    const reason = pageReason(page, response.status, finalUrl, type, body);
    return {
      ...blank,
      ...detail,
      finalUrl,
      status: response.status,
      type,
      bytes,
      ms,
      ok: !reason,
      reason,
      warnings: reason ? [] : pageNotes(page, { ...detail, ms, bytes }),
    };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ...blank,
      ms: Date.now() - started,
      ok: false,
      reason: timedOut ? "it never answered" : "it could not be reached",
    };
  }
}

function pageReason(page, status, finalUrl, type, body) {
  let final;
  try {
    final = new URL(finalUrl);
  } catch {
    return "the shop sent a broken address";
  }
  if (final.protocol !== "https:" || final.host !== new URL(page.url).host) return `it left the shop and opened ${finalUrl}`;
  if (!(status >= 200 && status < 300)) return `status ${status}`;
  if (!type.toLowerCase().includes("text/html")) return "the page was not html";
  if (!body.includes(page.expect)) return `the page did not include "${page.expect}"`;
  const products = countProducts(body);
  if (page.minProducts > 0 && products < page.minProducts) return `only ${products} products, wanted at least ${page.minProducts}`;
  return "";
}

function countProducts(body) {
  return (body.match(/href=["'](?:https?:\/\/[^"']+)?\/product\//g) || []).length;
}

function countPrices(body) {
  return (body.match(/£\s?\d/g) || []).length;
}

function countImages(body) {
  return (body.match(/<img\b/gi) || []).length;
}

function readPage(body) {
  return {
    title: pageTitle(body),
    h1: heading(body),
    description: metaContent(body, "description"),
    canonical: linkHref(body, "canonical"),
    products: countProducts(body),
    prices: countPrices(body),
    images: countImages(body),
    words: wordCount(body),
    links: (body.match(/<a\b/gi) || []).length,
    forms: (body.match(/<form\b/gi) || []).length,
  };
}

function pageNotes(page, detail) {
  const notes = paceNotes(detail.ms, detail.bytes);
  if (!detail.title) notes.push("No title.");
  if (!detail.h1) notes.push("No heading.");
  if (!detail.description) notes.push("No description.");
  if (page.kind === "collection" && detail.products === 0) notes.push("No products in this collection.");
  if (page.kind === "product" && detail.prices === 0) notes.push("No price on this product.");
  return notes;
}

function heading(body) {
  const match = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return "";
  return decode(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function metaContent(body, name) {
  const tag = body.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, "i"));
  if (!tag) return "";
  const content = tag[0].match(/content=["']([^"']*)["']/i);
  return content ? decode(content[1].replace(/\s+/g, " ").trim()) : "";
}

function linkHref(body, rel) {
  const tag = body.match(new RegExp(`<link[^>]+rel=["']${rel}["'][^>]*>`, "i"));
  if (!tag) return "";
  const href = tag[0].match(/href=["']([^"']+)["']/i);
  return href ? decode(href[1]) : "";
}

function wordCount(body) {
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function pageTitle(body) {
  const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decode(match[1].replace(/\s+/g, " ").trim());
}

function decode(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function label(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function seconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function size(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function londonClock(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function notableNotes(check) {
  return (check.warnings || []).filter((warning) => !warning.startsWith("Heavy page"));
}

export function smokeReport(result) {
  const summary = summarise(result);
  const down = result.checks.filter((check) => !check.ok);
  const look = result.checks.filter((check) => check.ok && notableNotes(check).length);
  const heavy = result.checks.filter((check) => (check.warnings || []).some((warning) => warning.startsWith("Heavy page"))).length;
  const lines = [
    `${result.ok ? "✅" : "❌"} ${result.name}`,
    `🕘 ${result.checkedAt}`,
    `🔗 ${result.url}`,
    `🎯 ${result.aspect || "Open"}`,
    `📚 ${Object.entries(summary.kinds).map(([kind, count]) => `${count} ${kind}`).join("   ")}`,
  ];
  if (summary.slowest) lines.push(`🐢 Slowest  ${summary.slowest.emoji} ${summary.slowest.name}  ${seconds(summary.slowest.ms)}`);
  if (summary.heaviest) lines.push(`📦 Heaviest  ${summary.heaviest.emoji} ${summary.heaviest.name}  ${size(summary.heaviest.bytes)}`);
  if (heavy && heavy === result.checks.length) lines.push(`📦 All ${result.checks.length} pages are heavy.`);
  else if (heavy) lines.push(`📦 ${heavy} heavy pages.`);
  if (down.length || look.length) {
    lines.push("", "Needs a look");
    for (const check of [...down, ...look]) {
      lines.push(`${check.ok ? "⚠️" : "❌"} ${check.emoji} ${check.name}  ${check.finalUrl}`);
      if (!check.ok) lines.push(`   ❌ ${check.reason}`);
      for (const warning of notableNotes(check)) lines.push(`   ⚠️ ${warning}`);
    }
  }
  lines.push("", "Every page");
  for (const check of result.checks) {
    const title = check.title ? `  ${check.title}` : "";
    lines.push(`${check.ok ? "✅" : "❌"} ${check.emoji} ${check.name}  ${check.status ?? "down"}  ${seconds(check.ms)}  ${size(check.bytes)}${title}`);
  }
  lines.push(
    "",
    result.ok
      ? `✅ Pass. ${result.checks.length} pages open.${look.length ? ` ⚠️ ${look.length} need a look.` : ""}`
      : `❌ Fail. ${down.length} ${down.length === 1 ? "page" : "pages"} down.`,
  );
  return `${lines.join("\n")}\n`;
}

function partLabel(section) {
  return section.file === "checkout" ? "Checkout" : section.name;
}

function runsWhen(section) {
  return ["All", partLabel(section)]
    .map((label) => `(params.PART ?: 'All') == '${label.replace(/'/g, "\\'")}'`)
    .join(" || ");
}

export function jenkinsSmoke(config, configPath = "sites/abayas-boutique/smoke.json") {
  const sections = Array.isArray(config?.sections) ? config.sections : [];
  if (!sections.length) throw new Error("Name the smoke stages.");
  for (const section of sections) {
    if (!/^[a-z0-9-]+$/.test(section.file || "")) throw new Error(`${section.name} needs a short file name.`);
  }
  const partChoices = ["All", ...sections.map(partLabel)].join("\\n");
  const aspectChoices = SMOKE_ASPECTS.join("\\n");
  const stages = sections.map((section) => `    stage('${section.name}') {
      when {
        expression { return ${runsWhen(section)} }
      }
      steps {
        dir('site-status') {
          sh "node scripts/smoke-shop.mjs ../${configPath} smoke-${section.file}.txt \\"${section.name}\\" \\"\${params.ASPECT}\\""
        }
      }
      post {
        always {
          archiveArtifacts artifacts: 'site-status/smoke-${section.file}.txt,site-status/smoke-${section.file}.html', allowEmptyArchive: true
        }
      }
    }`).join("\n\n");
  const files = sections.flatMap((section) => [`site-status/smoke-${section.file}.txt`, `site-status/smoke-${section.file}.html`]).join(" ");
  return `// Smoke test for ${config.name}. Pick a part of the shop and what to judge.
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timeout(time: 60, unit: 'MINUTES')
  }

  parameters {
    choice(
      name: 'PART',
      choices: "${partChoices}",
      description: 'Which part of the shop to open. All opens every stage. Checkout opens the bag, account, and checkout.'
    )
    choice(
      name: 'ASPECT',
      choices: "${aspectChoices}",
      description: 'Open fails when a page is down. Speed also fails when a page is slow. Weight fails when a page is heavy. Prices fails when a product has no price.'
    )
  }

  stages {
    stage('Prepare') {
      steps {
        dir('site-status') {
          sh 'node --version'
        }
      }
    }

${stages}
  }

  post {
    cleanup {
      sh 'rm -f ${files}'
    }
  }
}
`;
}

function summarise(result) {
  const kinds = {};
  for (const check of result.checks) kinds[check.kind || "page"] = (kinds[check.kind || "page"] || 0) + 1;
  const slowest = result.checks.reduce((best, check) => (!best || check.ms > best.ms ? check : best), null);
  const heaviest = result.checks.reduce((best, check) => (!best || check.bytes > best.bytes ? check : best), null);
  return { kinds, slowest, heaviest };
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function smokeHtml(result) {
  const warnings = result.checks.reduce((sum, check) => sum + check.warnings.length, 0);
  const down = result.checks.filter((check) => !check.ok).length;
  const summary = summarise(result);
  const cardsFor = (list) => list.map((check) => {
    const tone = check.ok ? (check.warnings.length ? "warn" : "pass") : "fail";
    const facts = [
      ["🔗", "Address", check.finalUrl],
      ["🔒", "Lock", `HTTPS on ${hostOf(check.finalUrl)}`],
      ["📡", "Reply", `${check.status ?? "down"} · ${check.type || "no type"}`],
      ["🏷️", "Title", check.title || "No title"],
      ["📰", "Heading", check.h1 || "No heading"],
      ["📝", "Description", check.description || "No description"],
      ["🎯", "Canonical", check.canonical || "No canonical"],
      ["🔤", "Words", label(check.words || 0, "word", "words")],
      ["🔗", "Links", label(check.links || 0, "link", "links")],
      ["📋", "Forms", label(check.forms || 0, "form", "forms")],
      ["👗", "Products", label(check.products, "product", "products")],
      ["💷", "Prices", label(check.prices, "price", "prices")],
      ["🖼️", "Images", label(check.images, "image", "images")],
      ["⏱️", "Time", seconds(check.ms)],
      ["📦", "Size", size(check.bytes)],
    ];
    const notes = [
      ...check.warnings.map((warning) => `<p class="note warn">⚠️ ${escapeHtml(warning)}</p>`),
      check.ok ? "" : `<p class="note fail">❌ ${escapeHtml(check.reason)}</p>`,
    ].join("");
    return `<article class="card ${tone}">
      <header><span class="emoji">${check.emoji}</span><div><h2>${escapeHtml(check.name)}</h2><p>${check.ok ? "✅ Open" : "❌ Down"}</p></div></header>
      <dl>${facts.map(([emoji, label, value]) => `<div><dt>${emoji} ${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
      ${notes}
    </article>`;
  }).join("");
  const downCards = result.checks.filter((check) => !check.ok);
  const lookCards = result.checks.filter((check) => check.ok && notableNotes(check).length);
  const openCards = result.checks.filter((check) => check.ok && !notableNotes(check).length);
  const group = (title, list, open) => list.length
    ? `<details ${open ? "open" : ""}><summary>${escapeHtml(title)} · ${list.length}</summary><div class="stack">${cardsFor(list)}</div></details>`
    : "";
  const cards = `${group("❌ Down", downCards, true)}${group("⚠️ Needs a look", lookCards, true)}${group("✅ Open", openCards, false)}`;
  const banner = result.ok ? "✅ Pass" : "❌ Fail";
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(result.name)} smoke</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; background: #F4F2FF; color: #14102A; font: 16px/1.45 "Instrument Sans", "Segoe UI", sans-serif; }
    header.top { background: #14102A; color: #F4F2FF; padding: 36px 8vw 28px; }
    header.top p { margin: 6px 0; }
    h1 { margin: 0 0 8px; font: 700 42px/1.05 "Bricolage Grotesque", Georgia, serif; }
    .banner { display: inline-block; margin-top: 14px; background: ${result.ok ? "#1F8A4C" : "#C4384B"}; color: white; border-radius: 999px; padding: 8px 16px; font-weight: 700; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .chip { background: #FFD23F; color: #14102A; border-radius: 999px; padding: 6px 12px; font-weight: 700; }
    main { display: grid; gap: 18px; padding: 24px 8vw 48px; }
    details { background: transparent; }
    summary { cursor: pointer; font: 700 22px/1.2 "Bricolage Grotesque", Georgia, serif; margin: 8px 0 12px; }
    .stack { display: grid; gap: 16px; }
    .card { background: white; border-radius: 18px; padding: 18px 18px 8px; border-top: 8px solid #6F4BFF; }
    .card.pass { border-top-color: #1F8A4C; }
    .card.warn { border-top-color: #E3A008; }
    .card.fail { border-top-color: #C4384B; }
    .card header { display: flex; gap: 12px; align-items: center; }
    .emoji { font-size: 36px; }
    h2 { margin: 0; font-size: 22px; }
    .card header p { margin: 2px 0 0; font-weight: 700; }
    dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 16px; margin: 14px 0; }
    dt { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: #6F4BFF; }
    dd { margin: 2px 0 0; word-break: break-word; }
    .note { border-radius: 12px; padding: 10px 12px; font-weight: 700; }
    .note.warn { background: #FFF4CC; color: #8A5A00; }
    .note.fail { background: #FDE8EC; color: #9E2436; }
  </style>
</head>
<body>
  <header class="top">
    <h1>${result.ok ? "✅" : "❌"} ${escapeHtml(result.name)} smoke</h1>
    <p>🕘 ${escapeHtml(result.checkedAt)}</p>
    <p>🔗 ${escapeHtml(result.url)}</p>
    <div class="chips">
      <span class="chip">🎯 ${escapeHtml(result.aspect || "Open")}</span>
      <span class="chip">📄 ${result.checks.length} pages</span>
      ${Object.entries(summary.kinds).map(([kind, count]) => `<span class="chip">${escapeHtml(kind)} ${count}</span>`).join("")}
      <span class="chip">${banner}</span>
      <span class="chip">⚠️ ${warnings} warnings</span>
      <span class="chip">❌ ${down} down</span>
    </div>
  </header>
  <main>${cards}</main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  const [configPath, outPath, sectionName, aspectName] = process.argv.slice(2);
  if (!configPath) throw new Error("Pass the shop smoke file.");
  const aspect = normalAspect(aspectName);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  const runs = sectionName
    ? [selectSection(saved, sectionName)]
    : (saved.sections || []).map((section) => selectSection(saved, section.name));
  const configs = runs.length ? runs : [saved];
  let failed = false;
  const reports = [];
  for (const config of configs) {
    const result = await smokeShop(config, {
      aspect,
      onPage: (check, done, total) => process.stderr.write(`${config.name} ${done}/${total} ${check.ok ? "ok" : "down"} ${check.name}\n`),
    });
    const report = smokeReport(result);
    reports.push(report);
    process.stdout.write(report);
    if (!result.ok) failed = true;
    if (outPath && configs.length === 1) {
      await writeFile(outPath, report);
      await writeFile(outPath.replace(/\.txt$/, ".html"), smokeHtml(result));
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
