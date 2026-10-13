#!/usr/bin/env node
// Open the shop pages a customer uses. Fail if one is down, not html, or leaves the shop.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { publicHttpsUrl } from "./pitch.mjs";

export function shopPages(config) {
  const origin = new URL(publicHttpsUrl(config?.url));
  const pages = Array.isArray(config?.pages) ? config.pages : [];
  if (!pages.length) throw new Error("Name the shop pages to open.");
  return pages.map((page) => {
    const name = String(page?.name || "").trim();
    const expect = String(page?.expect || "");
    if (!name) throw new Error("Every shop page needs a name.");
    if (!expect) throw new Error(`${name} needs the text a customer should see.`);
    const url = new URL(page.path, origin);
    const safe = publicHttpsUrl(url);
    if (new URL(safe).host !== origin.host) throw new Error(`${name} must stay on ${origin.host}.`);
    return { name, url: safe, expect };
  });
}

export async function smokeShop(config, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const checks = [];
  for (const page of shopPages(config)) {
    checks.push(await openPage(page, fetchImpl, timeoutMs));
  }
  return {
    name: String(config?.name || "Shop").trim() || "Shop",
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function openPage(page, fetchImpl, timeoutMs) {
  const started = Date.now();
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
    const reason = pageReason(page, response.status, finalUrl, type, body);
    return { name: page.name, url: page.url, finalUrl, status: response.status, ms, ok: !reason, reason };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      name: page.name,
      url: page.url,
      finalUrl: page.url,
      status: null,
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
  return "";
}

export function smokeReport(result) {
  const lines = [`${result.name} smoke`];
  for (const check of result.checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    const status = check.status ?? "down";
    const seconds = `${(check.ms / 1000).toFixed(1)}s`;
    const detail = check.ok ? "" : `  ${check.reason}`;
    lines.push(`${mark}  ${check.name}  ${status}  ${seconds}  ${check.finalUrl}${detail}`);
  }
  lines.push(result.ok ? "Pass." : "Fail.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Pass the shop smoke file.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const result = await smokeShop(config);
  const report = smokeReport(result);
  const outPath = process.argv[3];
  if (outPath) await writeFile(outPath, report);
  process.stdout.write(report);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
