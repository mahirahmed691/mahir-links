#!/usr/bin/env node
// Probe sites.json and write public/status.json, public/alexa.json, and a short page.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import tls from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT_URL = "https://www.mahirahmed.link";

export function alexaTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, ".0Z");
}

export async function probeSite(site, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const started = Date.now();
  try {
    const response = await fetchImpl(site.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "mahirahmed-site-status" },
    });
    const ttfb = Date.now() - started;
    let bytes = null;
    let title = null;
    try {
      if (typeof response.arrayBuffer === "function") {
        const buffer = await response.arrayBuffer();
        bytes = buffer.byteLength;
        title = pageTitle(buffer);
      }
    } catch {
      bytes = null;
    }
    return {
      name: site.name,
      url: site.url,
      finalUrl: response.url || site.url,
      redirected: Boolean(response.redirected),
      up: response.status >= 200 && response.status < 400,
      status: response.status,
      ttfb,
      ms: Date.now() - started,
      bytes,
      title,
      contentType: response.headers?.get?.("content-type") ?? null,
      error: null,
    };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      name: site.name,
      url: site.url,
      up: false,
      status: null,
      ms: Date.now() - started,
      error: timedOut ? "timeout" : "network",
    };
  }
}

export function buildStatus(results, updated) {
  return {
    updated: updated.toISOString(),
    ok: results.every((site) => site.up),
    sites: results,
  };
}

function spokenClock(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("hour")}:${value("minute")} ${value("dayPeriod").toUpperCase()} UK time`;
}

function spokenList(names) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function spokenDuration(ms) {
  const rounded = Math.max(0, Math.round(Number(ms) || 0));
  if (rounded < 1000) return `${rounded} millisecond${rounded === 1 ? "" : "s"}`;
  const tenths = Math.round(rounded / 100) / 10;
  const text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
  return `${text} second${tenths === 1 ? "" : "s"}`;
}

function downReason(site) {
  const timing = ` after ${spokenDuration(site.ms)}`;
  if (typeof site.status === "number") return `returned status ${site.status}${timing}`;
  if (site.error === "timeout") return `timed out${timing}`;
  return `could not be reached${timing}`;
}

function speedInsight(sites) {
  if (!sites.length) return "";
  if (sites.length === 1) return `${sites[0].name} responded in ${spokenDuration(sites[0].ms)}.`;
  const average = Math.round(sites.reduce((sum, site) => sum + site.ms, 0) / sites.length);
  const slowest = sites.reduce((slow, site) => (site.ms > slow.ms ? site : slow));
  const fastest = sites.reduce((fast, site) => (site.ms < fast.ms ? site : fast));
  let text = `Average response was ${spokenDuration(average)}.`;
  if (fastest.ms !== slowest.ms) {
    text += ` Fastest was ${fastest.name} at ${spokenDuration(fastest.ms)}. Slowest was ${slowest.name} at ${spokenDuration(slowest.ms)}.`;
  }
  return text;
}

function spokenSize(bytes) {
  if (typeof bytes !== "number") return "";
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 10) {
    const rounded = Math.round(kilobytes * 10) / 10;
    return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} kilobytes`;
  }
  if (kilobytes < 1024) return `${Math.round(kilobytes)} kilobytes`;
  return `${(Math.round(kilobytes / 102.4) / 10).toFixed(1)} megabytes`;
}

function spokenKind(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (type === "text/html") return "an HTML page";
  if (type === "application/json") return "JSON";
  if (type === "text/plain") return "plain text";
  if (type.startsWith("image/")) return "an image";
  return "";
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function pageTitle(buffer) {
  const html = Buffer.from(buffer).subarray(0, 65536).toString("utf8");
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const text = decodeEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function certificateDays(url, now = Date.now()) {
  let hostname = "";
  let port = 443;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return Promise.resolve(null);
    hostname = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : 443;
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const expiry = Date.parse(cert?.valid_to || "");
      if (!cert || Number.isNaN(expiry)) return resolve(null);
      resolve(Math.floor((expiry - now) / 86400000));
    });
    const giveUp = () => {
      socket.destroy();
      resolve(null);
    };
    socket.on("error", giveUp);
    socket.on("timeout", giveUp);
  });
}

export function compareSites(current, previous) {
  if (!previous?.sites) return [];
  const prior = new Map(previous.sites.map((site) => [site.name, site]));
  const notes = [];
  for (const site of current) {
    const old = prior.get(site.name);
    if (!old) continue;
    if (!old.up && site.up) notes.push(`${site.name} has recovered.`);
    else if (old.up && !site.up) notes.push(`${site.name} has gone down.`);
    else if (old.up && site.up && old.ms > 0 && typeof site.ms === "number") {
      const delta = site.ms - old.ms;
      if (Math.abs(delta) >= 300 && Math.abs(delta) / old.ms >= 0.5) {
        notes.push(delta > 0
          ? `${site.name} is ${spokenDuration(delta)} slower than last time.`
          : `${site.name} is ${spokenDuration(-delta)} faster than last time.`);
      }
    }
  }
  return notes;
}

function siteReport(site) {
  if (!site.up) return `${site.name} is down. It ${downReason(site)}.`;
  const parts = [`${site.name} is up`, `status ${site.status}`];
  if (typeof site.ttfb === "number" && site.ms - site.ttfb > 50) {
    parts.push(`first byte in ${spokenDuration(site.ttfb)}`, `finished in ${spokenDuration(site.ms)}`);
  } else {
    parts.push(`responded in ${spokenDuration(site.ms)}`);
  }
  const size = spokenSize(site.bytes);
  if (size) parts.push(size);
  const kind = spokenKind(site.contentType);
  if (kind) parts.push(kind);
  let sentence = `${parts.join(", ")}.`;
  if (site.redirected) {
    const host = hostOf(site.finalUrl);
    sentence += host ? ` It redirected to ${host}.` : " It redirected.";
  }
  if (site.title && site.title.toLowerCase() !== site.name.toLowerCase()) sentence += ` The page title is ${site.title}.`;
  if (typeof site.certDays === "number" && site.certDays < 0) sentence += " Its certificate has expired.";
  else if (typeof site.certDays === "number" && site.certDays <= 30) sentence += ` Its certificate expires in ${site.certDays} day${site.certDays === 1 ? "" : "s"}.`;
  return sentence;
}

function chunks(list, slots) {
  if (!list.length || slots < 1) return [];
  const size = Math.ceil(list.length / slots);
  const groups = [];
  for (let index = 0; index < list.length; index += size) groups.push(list.slice(index, index + size));
  return groups;
}

export function buildAlexa(status, { id = randomUUID(), redirect = REDIRECT_URL, previous = null } = {}) {
  const updated = new Date(status.updated);
  const stamp = alexaTimestamp(updated);
  const down = status.sites.filter((site) => !site.up);
  const up = status.sites.filter((site) => site.up);
  const when = spokenClock(updated);
  const item = (uid, titleText, mainText) => ({ uid, updateDate: stamp, titleText, mainText, redirectionUrl: redirect });

  let summary = `Checked ${when}. No sites are configured.`;
  if (down.length === 0 && up.length === 1) summary = `Checked ${when}. ${siteReport(up[0])}`;
  else if (down.length === 0 && up.length > 1) summary = `Checked ${when}. All ${up.length} sites are up. ${speedInsight(up)}`;
  else if (down.length > 0) summary = `Checked ${when}. ${up.length} of ${up.length + down.length} sites are up. ${speedInsight(up.length ? up : down)}`;
  const changes = compareSites(status.sites, previous);
  if (previous?.sites) {
    const since = previous.updated ? `since ${spokenClock(new Date(previous.updated))}` : "since the last check";
    summary += changes.length ? ` ${changes.join(" ")}` : ` Nothing notable has changed ${since}.`;
  }

  const items = [item(id, "Site status", summary)];
  if (up.length + down.length > 1) {
    const groups = chunks([...down, ...up], 4);
    for (const [index, group] of groups.entries()) {
      const title = group.length === 1 ? group[0].name : "Site report";
      items.push(item(`${id}-report-${index + 1}`, title, group.map(siteReport).join(" ")));
    }
  }
  return items.slice(0, 5);
}

export function renderPage(status) {
  const items = status.sites
    .map((site) => `<li>${escapeHtml(site.name)}: ${site.up ? "Up" : "Down"}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site status</title>
<h1>Site status</h1>
<p>Updated ${escapeHtml(status.updated)}.</p>
<ul>
${items}
</ul>
<p><a href="alexa.json">Alexa feed</a> · <a href="status.json">JSON</a></p>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const HISTORY_URL = process.env.STATUS_HISTORY_URL || "https://mahirahmed691.github.io/mahir-links/status.json";

async function loadPrevious() {
  try {
    const response = await fetch(HISTORY_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    return Array.isArray(body?.sites) ? body : null;
  } catch {
    return null;
  }
}

async function main() {
  const config = JSON.parse(await readFile(join(root, "sites.json"), "utf8"));
  const updated = new Date();
  const [results, certs, previous] = await Promise.all([
    Promise.all(config.sites.map((site) => probeSite(site))),
    Promise.all(config.sites.map((site) => certificateDays(site.url))),
    loadPrevious(),
  ]);
  results.forEach((site, index) => {
    site.certDays = certs[index];
  });
  const status = buildStatus(results, updated);
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  await writeFile(join(publicDir, "alexa.json"), `${JSON.stringify(buildAlexa(status, { previous }), null, 2)}\n`);
  await writeFile(join(publicDir, "index.html"), renderPage(status));
  const down = results.filter((site) => !site.up);
  console.log(`${results.length - down.length}/${results.length} up`);
  for (const site of results) console.log(`${site.up ? "up  " : "down"} ${site.status ?? site.error} ${site.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
