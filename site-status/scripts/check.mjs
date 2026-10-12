#!/usr/bin/env node
// Probe sites.json and write public/status.json, public/alexa.json, and a short page.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    return {
      name: site.name,
      url: site.url,
      up: response.status >= 200 && response.status < 400,
      status: response.status,
      ms: Date.now() - started,
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

function downReason(site) {
  if (typeof site.status === "number") return `returned status ${site.status}`;
  if (site.error === "timeout") return "timed out";
  return "could not be reached";
}

export function buildAlexa(status, { id = randomUUID(), redirect = REDIRECT_URL } = {}) {
  const updated = new Date(status.updated);
  const stamp = alexaTimestamp(updated);
  const down = status.sites.filter((site) => !site.up);
  const up = status.sites.filter((site) => site.up);
  const when = spokenClock(updated);
  const item = (uid, titleText, mainText) => ({ uid, updateDate: stamp, titleText, mainText, redirectionUrl: redirect });

  let summary = `Checked at ${when}. No sites are configured.`;
  if (up.length + down.length === 1 && down.length === 0) summary = `Checked at ${when}. ${up[0].name} is up.`;
  else if (down.length === 0 && up.length > 0) summary = `Checked at ${when}. All ${up.length} sites are up: ${spokenList(up.map((site) => site.name))}.`;
  else if (down.length > 0) summary = `Checked at ${when}. ${up.length} of ${up.length + down.length} sites are up.`;

  const items = [item(id, "Site status", summary)];
  if (!down.length) return items;

  const extra = down.slice(3);
  if (extra.length) items[0].mainText += ` Also down: ${spokenList(extra.map((site) => site.name))}.`;
  for (const [index, site] of down.slice(0, 3).entries()) {
    items.push(item(`${id}-down-${index + 1}`, site.name, `${site.name} is down. It ${downReason(site)}.`));
  }
  if (up.length) items.push(item(`${id}-up`, "Sites up", `These sites are up: ${spokenList(up.map((site) => site.name))}.`));
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

async function main() {
  const config = JSON.parse(await readFile(join(root, "sites.json"), "utf8"));
  const updated = new Date();
  const results = await Promise.all(config.sites.map((site) => probeSite(site)));
  const status = buildStatus(results, updated);
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  await writeFile(join(publicDir, "alexa.json"), `${JSON.stringify(buildAlexa(status), null, 2)}\n`);
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
