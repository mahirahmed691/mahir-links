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

export function buildAlexa(status, { id = randomUUID(), redirect = REDIRECT_URL } = {}) {
  const down = status.sites.filter((site) => !site.up);
  const total = status.sites.length;
  const up = total - down.length;
  const mainText = down.length
    ? `${up} of ${total} sites are up. Down: ${down.map((site) => site.name).join(", ")}.`
    : `All ${total} sites are up.`;

  return [
    {
      uid: id,
      updateDate: alexaTimestamp(new Date(status.updated)),
      titleText: "Site status",
      mainText,
      redirectionUrl: redirect,
    },
  ];
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
