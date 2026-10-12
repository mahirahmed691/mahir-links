#!/usr/bin/env node
// Check one public shop and write the LinkedIn note for that check.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildAlexa, buildStatus, certificateDays, probeSite } from "./check.mjs";

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;

export function publicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("The address must be an https URL.");
  }
  if (url.protocol !== "https:") throw new Error("The address must start with https://.");
  if (url.username || url.password) throw new Error("The address must not include a password.");
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || isPrivateAddress(host)) throw new Error("The address must be a public website.");
  return url.toString();
}

function isPrivateAddress(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe80:")) return true;
  const parts = bare.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((number) => number > 255)) return true;
  const [first, second] = numbers;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  return false;
}

export function linkedinNote({ url, spoken }) {
  const host = new URL(url).host.replace(/^www\./, "");
  const closer = /\bI'd\b/.test(spoken)
    ? "I do this every hour for a few shops. If yours goes down or gets slow, you hear one sentence about what to fix. Want me to keep an eye on it?"
    : "I watch a few shops every hour and only speak up when something is down, slow, or too heavy. Happy to add it to that list so you hear about it before a customer does.";
  return `I checked ${host}. ${spoken} ${closer}`;
}

export async function pitchSite({ name, url, probe = probeSite, cert = certificateDays, now = () => new Date() } = {}) {
  const label = String(name || "").trim();
  if (!label || label.length > 80) throw new Error("Give the shop a name, up to 80 characters.");
  const safeUrl = publicHttpsUrl(url);
  const result = await probe({ name: label, url: safeUrl });
  result.certDays = await cert(safeUrl);
  const spoken = buildAlexa(buildStatus([result], now()), { id: "pitch" })
    .map((item) => item.mainText)
    .join(" ");
  return linkedinNote({ url: safeUrl, spoken });
}

async function requestFromArgs(argv) {
  const [first, second] = argv.slice(2);
  if (!first) throw new Error("Pass a shop name and an https URL, or a JSON file with name and url.");
  if (first.endsWith(".json")) {
    const body = JSON.parse(await readFile(first, "utf8"));
    return { name: body.name, url: body.url, outPath: second || "pitch.txt" };
  }
  return { name: first, url: second, outPath: "pitch.txt" };
}

async function main() {
  const request = await requestFromArgs(process.argv);
  const note = await pitchSite(request);
  await writeFile(request.outPath, `${note}\n`);
  console.log(note);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
