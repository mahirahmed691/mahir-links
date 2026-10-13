#!/usr/bin/env node
// Write every niche's posts and type cards. Pass --shots to render the PNGs.
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { findNiche, nicheForWeek, nichePack, niches, tagsFor } from "./content.mjs";
import { cardHtml, cardSizes, checkPack, fileStem } from "./cards.mjs";

export function caption(post, niche) {
  if (post.channel !== "Instagram") return `${post.text}\n`;
  return `${post.text}\n\n${tagsFor(niche).map((tag) => `#${tag}`).join(" ")}\n`;
}

export function packFor(label, date = new Date()) {
  const niche = label ? findNiche(label) : nicheForWeek(date);
  if (!niche) throw new Error(`Pick a niche from the list. ${label || "Nothing"} is not on it.`);
  const pack = nichePack(niche, date);
  const files = pack.posts.map((post) => ({
    post,
    stem: fileStem(post),
    text: caption(post, niche),
    html: cardHtml(post, niche.label),
  }));
  return { niche, pack, files };
}

export function libraryFor(label, date = new Date()) {
  const featured = label ? findNiche(label) : nicheForWeek(date);
  if (!featured) throw new Error(`Pick a niche from the list. ${label || "Nothing"} is not on it.`);
  const ordered = [featured, ...niches.filter((niche) => niche.slug !== featured.slug)];
  const selected = label ? [featured] : ordered;
  const packs = selected.map((niche) => packFor(niche.label, date));
  const later = packs.filter((pack) => pack.niche.slug !== featured.slug);
  const index = [
    `Week of ${packs[0].pack.week.label}. Theme: ${packs[0].pack.week.name}.`,
    `Post this niche: ${featured.label}.`,
    "Paste these yourself. This job does not post them.",
    `${packs.length} ${packs.length === 1 ? "niche" : "niches"}. ${packs.length * 4} pictures.`,
    "LinkedIn and Facebook pictures are 1200×630. Instagram pictures are 1080×1350.",
    "",
    "This week",
    `${featured.label} -> ${featured.slug}/`,
    ...(later.length ? ["", "Later", ...later.map((pack) => `${pack.niche.label} -> ${pack.niche.slug}/`)] : []),
    "",
  ].join("\n");
  return { featured, packs, index: `${index.trim()}\n` };
}

export function checkLibrary(dir, library) {
  const errors = [];
  const indexPath = join(dir, "index.txt");
  if (!existsSync(indexPath)) errors.push("The index is missing.");
  else if (!readFileSync(indexPath, "utf8").includes(`Post this niche: ${library.featured.label}.`)) {
    errors.push("The index does not name this week's niche.");
  }
  for (const pack of library.packs) {
    try {
      checkPack(join(dir, pack.niche.slug), {
        posts: pack.files.map((file) => ({ ...file.post, caption: file.text })),
        niche: pack.niche.label,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

export function parseArgs(argv, env = process.env) {
  const shots = argv.includes("--shots");
  const args = argv.filter((arg) => arg !== "--shots");
  const niche = env.NICHE?.trim() || "";
  if (niche) return { shots, niche, all: false, outDir: args[0] || "social-pack" };
  if (args.length === 0) return { shots, niche: "", all: true, outDir: "social-pack" };
  if (args.length === 1 && findNiche(args[0])) return { shots, niche: args[0], all: false, outDir: "social-pack" };
  if (args.length === 1) return { shots, niche: "", all: true, outDir: args[0] };
  return { shots, niche: args[0], all: false, outDir: args[1] };
}

async function writeLibrary(outDir, library) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.txt"), library.index);
  for (const pack of library.packs) {
    const folder = join(outDir, pack.niche.slug);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${pack.niche.slug}.txt`), pack.pack.text);
    for (const file of pack.files) {
      await writeFile(join(folder, `${file.stem}.txt`), file.text);
      await writeFile(join(folder, `${file.stem}.html`), file.html);
    }
  }
}

function renderShots(outDir, library) {
  const jobs = library.packs.flatMap((pack) => pack.files.map((file) => {
    const size = cardSizes[file.post.channel];
    const folder = join(outDir, pack.niche.slug);
    return {
      html: resolve(folder, `${file.stem}.html`),
      png: resolve(folder, `${file.stem}.png`),
      width: size.width,
      height: size.height,
    };
  }));
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
  const library = libraryFor(args.niche);
  await writeLibrary(args.outDir, library);
  if (args.shots) {
    renderShots(args.outDir, library);
    checkLibrary(args.outDir, library);
  }
  console.log(library.index.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
