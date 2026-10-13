#!/usr/bin/env node
// Write one niche's posts and type cards. Pass --shots to render the PNGs.
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findNiche, nicheForWeek, nichePack } from "./content.mjs";
import { cardHtml, cardSizes, checkPack, fileStem } from "./cards.mjs";

export function packFor(label, date = new Date()) {
  const niche = label ? findNiche(label) : nicheForWeek(date);
  if (!niche) throw new Error(`Pick a niche from the list. ${label || "Nothing"} is not on it.`);
  const pack = nichePack(niche, date);
  const files = pack.posts.map((post) => ({
    post,
    stem: fileStem(post),
    text: `${post.text}\n`,
    html: cardHtml(post),
  }));
  const index = [
    niche.label,
    `Week of ${pack.week.label}. Theme: ${pack.week.name}.`,
    "Paste these yourself. This job does not post them.",
    "LinkedIn and Facebook pictures are 1200×630. Instagram pictures are 1080×1350.",
    "",
    ...files.map((file) => `${file.post.day} · ${file.post.channel} -> ${file.stem}.txt and ${file.stem}.png`),
    "",
  ].join("\n");
  return { niche, pack, files, index: `${index.trim()}\n` };
}

export function parseArgs(argv, env = process.env) {
  const shots = argv.includes("--shots");
  const args = argv.filter((arg) => arg !== "--shots");
  const niche = env.NICHE?.trim() || "";
  if (niche) return { shots, niche, outDir: args[0] || "social-pack" };
  if (args.length === 0) return { shots, niche: "", outDir: "social-pack" };
  if (args.length === 1 && findNiche(args[0])) return { shots, niche: args[0], outDir: "social-pack" };
  if (args.length === 1) return { shots, niche: "", outDir: args[0] };
  return { shots, niche: args[0], outDir: args[1] };
}

async function writePack(outDir, pack) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.txt"), pack.index);
  await writeFile(join(outDir, `${pack.niche.slug}.txt`), pack.pack.text);
  for (const file of pack.files) {
    await writeFile(join(outDir, `${file.stem}.txt`), file.text);
    await writeFile(join(outDir, `${file.stem}.html`), file.html);
  }
}

function renderShots(outDir, pack) {
  const jobs = pack.files.map((file) => {
    const size = cardSizes[file.post.channel];
    return {
      html: resolve(outDir, `${file.stem}.html`),
      png: resolve(outDir, `${file.stem}.png`),
      width: size.width,
      height: size.height,
    };
  });
  const runner = `
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const jobs = ${JSON.stringify(jobs)};
const browser = await chromium.launch();
for (const job of jobs) {
  const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(job.html).href, { waitUntil: "networkidle" });
  await page.screenshot({ path: job.png, type: "png", scale: "css" });
  await page.close();
}
await browser.close();
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner], { stdio: "inherit", cwd: process.cwd() });
  if (result.status !== 0) throw new Error("The card pictures did not render. Install playwright and chromium first.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pack = packFor(args.niche);
  await writePack(args.outDir, pack);
  if (args.shots) {
    renderShots(args.outDir, pack);
    checkPack(args.outDir, { posts: pack.pack.posts });
  }
  console.log(pack.index.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
