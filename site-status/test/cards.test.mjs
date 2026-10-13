import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cardHtml, cardSizes, checkPack, fileStem, pngSize, solidPng } from "../scripts/cards.mjs";
import { nicheForWeek, nichePack, niches } from "../scripts/content.mjs";
import { libraryFor, packFor, parseArgs } from "../scripts/pack.mjs";

const now = new Date("2026-10-13T00:30:00.000Z");

test("cards use the channel sizes and keep the sentence", () => {
  const post = nichePack(niches[0], now).posts[2];
  const html = cardHtml(post, niches[0].label);
  assert.match(html, /width: 1200px/);
  assert.match(html, /height: 630px/);
  assert.match(html, /Thursday · LinkedIn/);
  assert.match(html, new RegExp(niches[0].label));
  const escaped = post.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  assert.ok(html.includes(escaped));
  assert.equal(cardSizes.Instagram.width, 1080);
  assert.equal(cardSizes.Instagram.height, 1350);
  assert.equal(cardSizes.Facebook.width, cardSizes.LinkedIn.width);
});

test("the pack check rejects a missing or wrongly sized picture", () => {
  const pack = packFor("Home bakery", now);
  const dir = mkdtempSync(join(tmpdir(), "cards-"));
  try {
    for (const file of pack.files) {
      writeFileSync(join(dir, `${file.stem}.txt`), file.text);
      writeFileSync(join(dir, `${file.stem}.html`), file.html);
    }
    const posts = pack.files.map((file) => ({ ...file.post, caption: file.text }));
    assert.throws(() => checkPack(dir, { posts }), /picture is missing/);
    for (const file of pack.files) {
      const size = cardSizes[file.post.channel];
      writeFileSync(join(dir, `${file.stem}.png`), solidPng(size.width, size.height));
    }
    assert.equal(pngSize(solidPng(1200, 630)).width, 1200);
    checkPack(dir, { posts });
    writeFileSync(join(dir, `${fileStem(pack.pack.posts[0])}.png`), solidPng(10, 10));
    assert.throws(() => checkPack(dir, { posts }), /10×10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the library keeps every niche and names the one to post", () => {
  const niche = nicheForWeek(now);
  const library = libraryFor("", now);
  assert.equal(library.featured.label, niche.label);
  assert.equal(library.packs.length, niches.length);
  assert.match(library.index, new RegExp(`Post this niche: ${niche.label}`));
  assert.match(library.index, /48 pictures/);
  const home = library.packs.find((pack) => pack.niche.slug === "home-bakery");
  const instagram = home.files.find((file) => file.post.channel === "Instagram");
  const linkedin = home.files.find((file) => file.post.channel === "LinkedIn");
  assert.match(instagram.text, /#homebakery #ukbakery/);
  assert.equal(linkedin.text.includes("#"), false);
  assert.deepEqual(parseArgs(["--shots", "social-pack"], { NICHE: "" }), { shots: true, niche: "", all: true, outDir: "social-pack" });
  assert.deepEqual(parseArgs(["Home bakery"], { NICHE: "" }), { shots: false, niche: "Home bakery", all: false, outDir: "social-pack" });
});
