#!/usr/bin/env node
// Open the shop pages a customer uses. Fail if one is down, not html, or leaves the shop.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { publicHttpsUrl } from "./pitch.mjs";

export const SLOW_MS = 2500;
export const HEAVY_BYTES = 500 * 1024;

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
    return { name, emoji, url: safe, expect, minProducts };
  });
}

export function paceNotes(ms, bytes) {
  const notes = [];
  if (ms >= SLOW_MS) notes.push(`Slow. ${seconds(ms)}. A customer is waiting.`);
  if (bytes >= HEAVY_BYTES) notes.push(`Heavy page. ${size(bytes)}.`);
  return notes;
}

export async function smokeShop(config, { fetchImpl = fetch, timeoutMs = 25000, now = () => new Date() } = {}) {
  const checks = [];
  for (const page of shopPages(config)) {
    checks.push(await openPage(page, fetchImpl, timeoutMs));
  }
  return {
    name: String(config?.name || "Shop").trim() || "Shop",
    url: publicHttpsUrl(config?.url),
    checkedAt: londonClock(now()),
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
    const reason = pageReason(page, response.status, finalUrl, type, body);
    return {
      ...blank,
      finalUrl,
      status: response.status,
      type,
      title: pageTitle(body),
      products: countProducts(body),
      prices: countPrices(body),
      images: countImages(body),
      bytes,
      ms,
      ok: !reason,
      reason,
      warnings: reason ? [] : paceNotes(ms, bytes),
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

export function smokeReport(result) {
  const lines = [
    `${result.ok ? "✅" : "❌"} ${result.name} smoke`,
    `🕘 ${result.checkedAt}`,
    `🔗 ${result.url}`,
    "",
  ];
  for (const check of result.checks) {
    lines.push(`${check.ok ? "✅" : "❌"} ${check.emoji} ${check.name}`);
    lines.push(`   🔗 ${check.finalUrl}`);
    lines.push(`   🔒 HTTPS  ${hostOf(check.finalUrl)}`);
    lines.push(`   📡 ${check.status ?? "down"}  ${check.type || "no type"}`);
    if (check.title) lines.push(`   🏷️ ${check.title}`);
    lines.push(`   👗 ${label(check.products, "product", "products")}   💷 ${label(check.prices, "price", "prices")}   🖼️ ${label(check.images, "image", "images")}`);
    lines.push(`   ⏱️ ${seconds(check.ms)}   📦 ${size(check.bytes)}`);
    for (const warning of check.warnings) lines.push(`   ⚠️ ${warning}`);
    if (!check.ok) lines.push(`   ❌ ${check.reason}`);
    lines.push("");
  }
  const warnings = result.checks.reduce((sum, check) => sum + check.warnings.length, 0);
  const down = result.checks.filter((check) => !check.ok).length;
  lines.push(
    result.ok
      ? `✅ Pass. ${result.checks.length} pages open.${warnings ? ` ⚠️ ${warnings} warnings.` : ""}`
      : `❌ Fail. ${down} ${down === 1 ? "page" : "pages"} down.`,
  );
  return `${lines.join("\n")}\n`;
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
  const cards = result.checks.map((check) => {
    const tone = check.ok ? (check.warnings.length ? "warn" : "pass") : "fail";
    const facts = [
      ["🔗", "Address", check.finalUrl],
      ["🔒", "Lock", `HTTPS on ${hostOf(check.finalUrl)}`],
      ["📡", "Reply", `${check.status ?? "down"} · ${check.type || "no type"}`],
      ["🏷️", "Title", check.title || "No title"],
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
    main { display: grid; gap: 16px; padding: 24px 8vw 48px; }
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
      <span class="chip">📄 ${result.checks.length} pages</span>
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
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Pass the shop smoke file.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const result = await smokeShop(config);
  const report = smokeReport(result);
  const outPath = process.argv[3];
  if (outPath) {
    await writeFile(outPath, report);
    await writeFile(outPath.replace(/\.txt$/, ".html"), smokeHtml(result));
  }
  process.stdout.write(report);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
