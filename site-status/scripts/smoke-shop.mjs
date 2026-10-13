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
  const extraPages = Array.isArray(config?.extra) ? config.extra : [];
  const extras = extraPages.length ? shopPages({ url: origin, pages: extraPages }) : [];
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
    mockCheckout: section.mockCheckout || null,
  };
}

export function paceNotes(ms, bytes) {
  const notes = [];
  if (ms >= SLOW_MS) notes.push(`Slow. ${seconds(ms)}. A customer is waiting.`);
  if (bytes >= HEAVY_BYTES) notes.push(`Heavy page. ${size(bytes)}.`);
  return notes;
}

export function pageFix(check) {
  const reason = String(check?.reason || "");
  if (!check?.ok) {
    if (reason === "it never answered") return "I'd check that the host is still running.";
    if (reason === "it could not be reached") return "I'd check the domain.";
    if (reason === "status 404") return "I'd check this address. The shop has no page here.";
    if (/^status 5\d\d$/.test(reason)) return "I'd check the host logs.";
    if (reason.startsWith("status ")) return `I'd check why this page answers ${reason.slice("status ".length)}.`;
    if (reason.startsWith("it left the shop")) return "I'd point this link back at the shop.";
    if (reason === "the page was not html") return "I'd serve this address as a page.";
    if (reason.startsWith("the page did not include")) return "I'd put the missing shop text back on this page.";
    if (reason.startsWith("only ")) return "I'd put the products back on this page.";
    if (reason.startsWith("Slow")) return "I'd cache this page. A customer is waiting.";
    if (reason.startsWith("Heavy page")) return "I'd cut the pictures down on this page.";
    if (reason.startsWith("No price")) return "I'd put a price on this product.";
    if (reason === "the shop sent a broken address") return "I'd check the address the shop sent back.";
    return "I'd open this page again.";
  }
  const notes = notableNotes(check);
  if (notes.some((note) => note.startsWith("Slow"))) return "I'd cache this page. A customer is waiting.";
  if (notes.some((note) => note === "No title.")) return "I'd add a title to this page.";
  if (notes.some((note) => note === "No heading.")) return "I'd add a heading to this page.";
  if (notes.some((note) => note === "No description.")) return "I'd add a short description to this page.";
  if (notes.some((note) => note.startsWith("No products"))) return "I'd add a product to this collection.";
  if (notes.some((note) => note.startsWith("No price"))) return "I'd put a price on this product.";
  return "";
}

export function canRecover(check) {
  const reason = String(check?.reason || "");
  return reason === "it never answered" || reason === "it could not be reached" || /^status 5\d\d$/.test(reason) || reason.startsWith("Slow");
}

function isHostWide(reason) {
  const text = String(reason || "");
  return text === "it never answered" || text === "it could not be reached" || /^status 5\d\d$/.test(text);
}

function asPage(check) {
  return {
    name: check.name,
    emoji: check.emoji,
    url: check.url,
    expect: check.expect,
    minProducts: check.minProducts || 0,
    kind: check.kind,
  };
}

export async function retestFailed(checks, open, aspect = "Open") {
  const mode = normalAspect(aspect);
  const failed = checks.filter((check) => !check.ok);
  const recoverable = failed.filter(canRecover);
  const hostWide = recoverable.filter((check) => isHostWide(check.reason));
  const probeFirst = hostWide.length > 1 && hostWide.length === recoverable.length;
  const replacements = new Map();
  const record = (check, next) => {
    const tried = { ...next, attempts: 2 };
    replacements.set(check, next.ok
      ? { ...tried, recovered: true, again: "Opened again. It answered." }
      : { ...tried, again: "Opened again. Still failing.", fix: pageFix(next) });
  };
  const queue = probeFirst ? [hostWide[0]] : recoverable;
  for (const check of queue) record(check, judgeCheck(await open(asPage(check)), mode));
  if (probeFirst && replacements.get(hostWide[0])?.ok) {
    for (const check of hostWide.slice(1)) record(check, judgeCheck(await open(asPage(check)), mode));
  } else if (probeFirst) {
    for (const check of hostWide.slice(1)) {
      replacements.set(check, { ...check, again: "Left alone. The host is still down.", fix: pageFix(check) });
    }
  }
  return checks.map((check) => {
    if (replacements.has(check)) return replacements.get(check);
    if (!check.ok) return { ...check, fix: pageFix(check) };
    const fix = pageFix(check);
    return fix ? { ...check, fix } : check;
  });
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
  const settled = await retestFailed(checks, (page) => openPage(page, fetchImpl, timeoutMs), mode);
  return {
    name: String(config?.name || "Shop").trim() || "Shop",
    url: publicHttpsUrl(config?.url),
    checkedAt: londonClock(now()),
    aspect: mode,
    ok: settled.every((check) => check.ok),
    checks: settled,
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
      expect: page.expect,
      minProducts: page.minProducts || 0,
      ok: !reason,
      reason,
      warnings: reason ? [] : pageNotes(page, { ...detail, ms, bytes }),
    };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ...blank,
      ms: Date.now() - started,
      expect: page.expect,
      minProducts: page.minProducts || 0,
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
  const recovered = result.checks.filter((check) => check.recovered);
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
      if (check.again) lines.push(`   🔁 ${check.again}`);
      for (const warning of notableNotes(check)) lines.push(`   ⚠️ ${warning}`);
      const fix = check.fix || pageFix(check);
      if (fix) lines.push(`   🔧 ${fix}`);
    }
  }
  if (recovered.length) {
    lines.push("", "Opened again");
    for (const check of recovered) lines.push(`🔁 ${check.emoji} ${check.name}  answered the second time`);
  }
  lines.push("", "Every page");
  for (const check of result.checks) {
    const title = check.title ? `  ${check.title}` : "";
    lines.push(`${check.ok ? "✅" : "❌"} ${check.emoji} ${check.name}  ${check.status ?? "down"}  ${seconds(check.ms)}  ${size(check.bytes)}${title}`);
  }
  lines.push(
    "",
    result.ok
      ? `✅ Pass. ${result.checks.length} pages open.${recovered.length ? ` ${recovered.length} answered on a second try.` : ""}${look.length ? ` ⚠️ ${look.length} need a look.` : ""}`
      : `❌ Fail. ${down.length} ${down.length === 1 ? "page" : "pages"} down.`,
  );
  return `${lines.join("\n")}\n`;
}

function pounds(value) {
  return `£${Number(value).toFixed(2)}`;
}

export function runMockCheckout(shop, order = {}) {
  const steps = [];
  const stop = (name, reason, fix) => {
    steps.push({ name, ok: false, detail: reason });
    return { ok: false, reason, fix, steps, orderId: "", mock: true, paid: false };
  };
  const product = String(shop?.product || "").trim();
  const price = Number(shop?.price);
  const options = Array.isArray(shop?.options) ? shop.options : [];
  if (!product || !(price > 0)) throw new Error("Name the dress and its price.");
  const option = String(order.option || "").trim();
  if (!option) return stop("Bag", "The bag is empty.", "I'd add a dress before checkout.");
  const choice = options.find((item) => String(item.value) === option);
  if (!choice) return stop("Length", `Length ${option} is not sold on ${product}.`, "I'd pick a length the shop sells.");
  if (!choice.stock) return stop("Add to bag", `${product} in length ${option} is out of stock.`, "I'd pick a length that is in stock.");
  steps.push({ name: "Add to bag", ok: true, detail: `${product}, length ${option}, ${pounds(price)}` });
  steps.push({ name: "Bag", ok: true, detail: `1 dress, ${pounds(price)}` });
  const customer = order.customer || {};
  const missing = ["name", "email", "address", "city", "postcode"].filter((key) => !String(customer[key] || "").trim());
  if (missing.length) return stop("Details", `Checkout is missing ${missing.join(", ")}.`, "I'd fill the missing checkout fields.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(customer.email).trim())) return stop("Details", "The email address is not usable.", "I'd use an email address.");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(customer.postcode).trim())) return stop("Details", "The postcode is not a UK postcode.", "I'd use a UK postcode.");
  steps.push({ name: "Details", ok: true, detail: `${customer.name}, ${customer.postcode}` });
  const payment = String(order.payment || "");
  if (payment === "mock-card-declined") return stop("Payment", "The mock card was declined. No order was placed.", "I'd try the other mock card.");
  if (payment !== "mock-card-ok") return stop("Payment", "No mock card was chosen.", "I'd choose the mock card. No card is sent to the shop.");
  steps.push({ name: "Payment", ok: true, detail: "Mock card approved. No money moved." });
  steps.push({ name: "Order", ok: true, detail: "Order AB-1001. The bag is empty." });
  return { ok: true, reason: "", fix: "", steps, orderId: "AB-1001", mock: true, paid: false, total: price };
}

export function mockCheckoutSuite(shop, { name = "Shop", url = "" } = {}) {
  const options = Array.isArray(shop?.options) ? shop.options : [];
  const inStock = options.find((item) => item.stock);
  const out = options.find((item) => item.stock === false);
  if (!inStock || !out) throw new Error("Name an in-stock length and an out-of-stock length.");
  const customer = {
    name: "Mock Customer",
    email: "mock-checkout@example.com",
    address: "1 Test Street",
    city: "London",
    postcode: "E1 1AA",
  };
  const cases = [
    { name: "A good mock card places an order", order: { option: String(inStock.value), customer, payment: "mock-card-ok" }, expectOk: true },
    { name: "A declined mock card places no order", order: { option: String(inStock.value), customer, payment: "mock-card-declined" }, expectOk: false },
    { name: "An out of stock length stays out of the bag", order: { option: String(out.value), customer, payment: "mock-card-ok" }, expectOk: false },
    { name: "An empty bag cannot check out", order: { option: "", customer, payment: "mock-card-ok" }, expectOk: false },
    { name: "A missing address never reaches payment", order: { option: String(inStock.value), customer: { name: customer.name, email: customer.email }, payment: "mock-card-ok" }, expectOk: false },
  ];
  const checks = cases.map((item) => {
    const result = runMockCheckout(shop, item.order);
    const behaved = result.ok === item.expectOk && result.paid === false && (item.expectOk ? result.orderId === "AB-1001" : !result.orderId);
    return { name: item.name, ok: behaved, expectOk: item.expectOk, result };
  });
  return { name, url, ok: checks.every((check) => check.ok), checks };
}

export function mockCheckoutReport(result) {
  const lines = [
    `${result.ok ? "✅" : "❌"} ${result.name}`,
    "💳 Mock checkout. No money moved and no card was sent to the shop.",
  ];
  if (result.url) lines.push(`🔗 ${result.url}`);
  for (const check of result.checks) {
    lines.push("", `${check.ok ? "✅" : "❌"} ${check.name}`);
    for (const step of check.result.steps) lines.push(`   ${step.ok ? "✅" : "❌"} ${step.name}  ${step.detail}`);
    if (check.result.fix) lines.push(`   🔧 ${check.result.fix}`);
  }
  const missed = result.checks.filter((check) => !check.ok).length;
  lines.push(
    "",
    result.ok
      ? `✅ Pass. ${result.checks.length} mock checks. No payment was sent to the shop.`
      : `❌ Fail. ${missed} mock ${missed === 1 ? "check" : "checks"} did not behave.`,
  );
  return `${lines.join("\n")}\n`;
}

export function mockCheckoutHtml(result) {
  const rows = result.checks.map((check) => {
    const steps = check.result.steps.map((step) => `<li>${step.ok ? "✅" : "❌"} ${escapeHtml(step.name)} ${escapeHtml(step.detail)}</li>`).join("");
    const fix = check.result.fix ? `<p class="note fix">🔧 ${escapeHtml(check.result.fix)}</p>` : "";
    return `<article class="card ${check.ok ? "pass" : "fail"}"><h2>${check.ok ? "✅" : "❌"} ${escapeHtml(check.name)}</h2><ul>${steps}</ul>${fix}</article>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(result.name)} mock checkout</title>
  <style>
    body { margin: 0; background: #F4F2FF; color: #14102A; font: 16px/1.45 "Instrument Sans", "Segoe UI", sans-serif; }
    header { background: #14102A; color: #F4F2FF; padding: 36px 8vw 28px; }
    h1 { margin: 0 0 8px; font: 700 42px/1.05 "Bricolage Grotesque", Georgia, serif; }
    main { display: grid; gap: 16px; padding: 24px 8vw 48px; }
    .card { background: white; border-radius: 18px; padding: 18px; border-top: 8px solid #6F4BFF; }
    .card.pass { border-top-color: #1F8A4C; }
    .card.fail { border-top-color: #C4384B; }
    .note.fix { background: #EEE9FF; color: #3D2A99; border-radius: 12px; padding: 10px 12px; font-weight: 700; }
  </style>
</head>
<body>
  <header>
    <h1>${result.ok ? "✅" : "❌"} ${escapeHtml(result.name)}</h1>
    <p>💳 Mock checkout. No money moved and no card was sent to the shop.</p>
  </header>
  <main>${rows}</main>
</body>
</html>
`;
}

function partLabel(section) {
  return section.file === "checkout" ? "Checkout" : section.name;
}

function runsWhen(section) {
  const labels = ["All", partLabel(section)];
  if (section.mockCheckout) labels.push("Checkout");
  return labels
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
        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
          dir('site-status') {
            sh "node scripts/smoke-shop.mjs ../${configPath} smoke-${section.file}.txt \\"${section.name}\\" \\"\${params.ASPECT}\\""
          }
        }
      }
      post {
        always {
          archiveArtifacts artifacts: 'site-status/smoke-${section.file}.txt,site-status/smoke-${section.file}.html,site-status/smoke-${section.file}.json', allowEmptyArchive: true
        }
      }
    }`).join("\n\n");
  const files = [
    ...sections.flatMap((section) => [
      `site-status/smoke-${section.file}.txt`,
      `site-status/smoke-${section.file}.html`,
      `site-status/smoke-${section.file}.json`,
    ]),
    "site-status/abayas-smoke-report.pdf",
    "site-status/abayas-smoke-tickets.json",
  ].join(" ");
  return `// Smoke test for ${config.name}. Pick a part of the shop and what to judge.
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timeout(time: 60, unit: 'MINUTES')
  }

  triggers {
    cron("TZ=Europe/London\\n0 18 * * *")
  }

  parameters {
    choice(
      name: 'PART',
      choices: "${partChoices}",
      description: 'Which part of the shop to open. All opens every stage. Checkout opens the bag and runs the mock payment. Mock checkout runs the payment only.'
    )
    choice(
      name: 'ASPECT',
      choices: "${aspectChoices}",
      description: 'Open fails when a page is down. Speed also fails when a page is slow. Weight fails when a page is heavy. Prices fails when a product has no price.'
    )
    booleanParam(
      name: 'SEND_REPORT',
      defaultValue: false,
      description: 'Email the PDF and file the Jira tickets after this run. The 6pm run does this on its own.'
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

    stage('Daily report') {
      when {
        expression { return currentBuild.getBuildCauses('hudson.triggers.TimerTrigger\$TimerTriggerCause').size() > 0 || params.SEND_REPORT == true }
      }
      steps {
        dir('site-status') {
          sh 'node scripts/daily-report.mjs'
        }
      }
      post {
        always {
          archiveArtifacts artifacts: 'site-status/abayas-smoke-report.pdf,site-status/abayas-smoke-tickets.json', allowEmptyArchive: true
        }
      }
    }
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
    const fix = check.fix || pageFix(check);
    const notes = [
      ...check.warnings.map((warning) => `<p class="note warn">⚠️ ${escapeHtml(warning)}</p>`),
      check.ok ? "" : `<p class="note fail">❌ ${escapeHtml(check.reason)}</p>`,
      check.again ? `<p class="note fix">🔁 ${escapeHtml(check.again)}</p>` : "",
      check.recovered ? `<p class="note fix">🔁 Opened again. It answered.</p>` : "",
      fix && !check.recovered ? `<p class="note fix">🔧 ${escapeHtml(fix)}</p>` : "",
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
    .note.fix { background: #EEE9FF; color: #3D2A99; margin-top: 8px; }
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

export function pageRecord(result) {
  const checks = result.checks || [];
  return {
    kind: "pages",
    name: result.name,
    url: result.url || "",
    checkedAt: result.checkedAt || "",
    aspect: result.aspect || "Open",
    ok: Boolean(result.ok),
    heavy: checks.filter((check) => (check.warnings || []).some((warning) => String(warning).startsWith("Heavy"))).length,
    checks: checks.map((check) => ({
      name: check.name,
      url: check.finalUrl || check.url || "",
      ok: Boolean(check.ok),
      reason: check.reason || "",
      fix: check.fix || pageFix(check),
      warnings: notableNotes(check),
      ms: check.ms || 0,
      bytes: check.bytes || 0,
      kind: check.kind || "page",
      recovered: Boolean(check.recovered),
    })),
  };
}

export function mockRecord(result) {
  return {
    kind: "mock",
    name: result.name,
    url: result.url || "",
    checkedAt: result.checkedAt || "",
    aspect: "Payment",
    ok: Boolean(result.ok),
    heavy: 0,
    checks: (result.checks || []).map((check) => ({
      name: check.name,
      url: "",
      ok: Boolean(check.ok),
      reason: check.result?.reason || "",
      fix: check.result?.fix || "",
      warnings: [],
      ms: 0,
      bytes: 0,
      kind: "mock",
    })),
  };
}

async function writeOutputs(outPath, report, html, record) {
  if (!outPath) return;
  await writeFile(outPath, report);
  await writeFile(outPath.replace(/\.txt$/, ".html"), html);
  await writeFile(outPath.replace(/\.txt$/, ".json"), `${JSON.stringify(record, null, 2)}\n`);
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
    if (config.mockCheckout) {
      const result = mockCheckoutSuite(config.mockCheckout, { name: config.name, url: config.url });
      const report = mockCheckoutReport(result);
      reports.push(report);
      process.stdout.write(report);
      if (!result.ok) failed = true;
      await writeOutputs(configs.length === 1 ? outPath : "", report, mockCheckoutHtml(result), mockRecord(result));
      continue;
    }
    const result = await smokeShop(config, {
      aspect,
      onPage: (check, done, total) => process.stderr.write(`${config.name} ${done}/${total} ${check.ok ? "ok" : "down"} ${check.name}\n`),
    });
    const report = smokeReport(result);
    reports.push(report);
    process.stdout.write(report);
    if (!result.ok) failed = true;
    await writeOutputs(configs.length === 1 ? outPath : "", report, smokeHtml(result), pageRecord(result));
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
