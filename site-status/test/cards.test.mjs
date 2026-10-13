import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cardHtml, cardSizes, checkPack, fileStem, pngSize, solidPng } from "../scripts/cards.mjs";
import { nicheForWeek, nichePack, niches } from "../scripts/content.mjs";
import { packFor, parseArgs } from "../scripts/pack.mjs";

const now = new Date("2026-10-13T00:30:00.000Z");

test("cards use the channel sizes and keep the sentence", () => {
  const post = nichePack(niches[0], now).posts[2];
  const html = cardHtml(post);
  assert.match(html, /width: 1200px/);
  assert.match(html, /height: 630px/);
  assert.match(html, /Thursday · LinkedIn/);
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
    assert.throws(() => checkPack(dir, { posts: pack.pack.posts }), /picture is missing/);
    for (const file of pack.files) {
      const size = cardSizes[file.post.channel];
      writeFileSync(join(dir, `${file.stem}.png`), solidPng(size.width, size.height));
    }
    assert.equal(pngSize(solidPng(1200, 630)).width, 1200);
    checkPack(dir, { posts: pack.pack.posts });
    writeFileSync(join(dir, `${fileStem(pack.pack.posts[0])}.png`), solidPng(10, 10));
    assert.throws(() => checkPack(dir, { posts: pack.pack.posts }), /10×10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this week's niche is one shop type and the pack names its pictures", () => {
  const niche = nicheForWeek(now);
  assert.ok(niches.includes(niche));
  const pack = packFor("", now);
  assert.equal(pack.niche.label, niche.label);
  assert.equal(pack.files.length, 4);
  assert.match(pack.index, /1200×630/);
  assert.match(pack.index, /1080×1350/);
  assert.deepEqual(parseArgs(["--shots", "social-pack"], { NICHE: "" }), { shots: true, niche: "", outDir: "social-pack" });
  assert.deepEqual(parseArgs(["Home bakery"], { NICHE: "" }), { shots: false, niche: "Home bakery", outDir: "social-pack" });
});
