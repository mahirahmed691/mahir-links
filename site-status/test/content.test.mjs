import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALL_NICHES, contentPack, findNiche, nicheChoices, nichePack, niches, weekNumber } from "../scripts/content.mjs";

const now = new Date("2026-10-13T00:30:00.000Z");
const shopNames = [
  "Mahir",
  "FlickFinder",
  "Sakinah",
  "Motiv",
  "KARV",
  "Kiano",
  "Sweet Dezire",
  "Blanco",
  "RAPIDER",
  "Sylhet",
  "Abayas",
  "Tara",
  "tsbakes",
  "abayasboutique",
  "flickfinder",
];

test("the week is dated from the Monday and rotates every four weeks", () => {
  assert.equal(weekNumber(new Date("2026-01-01T12:00:00.000Z")), 1);
  const pack = nichePack(niches[0], now);
  assert.equal(pack.week.label, "12 Oct 2026");
  assert.equal(pack.posts.map((post) => `${post.day} ${post.channel}`).join(", "), "Monday LinkedIn, Wednesday Instagram, Thursday LinkedIn, Friday Facebook");
});

test("every niche has four posts and does not name a shop or its speed", () => {
  for (const niche of niches) {
    const pack = nichePack(niche, now);
    assert.equal(pack.posts.length, 4);
    assert.match(pack.text, new RegExp(niche.page));
    for (const name of shopNames) assert.equal(pack.text.includes(name), false, `${niche.label} names ${name}`);
    for (const post of pack.posts.slice(0, 3)) assert.equal(post.text.includes("£"), false);
    assert.match(pack.posts[3].text, /£49 a month/);
    assert.match(pack.posts[3].text, /£150, once/);
  }
});

test("all niches writes one pack each and tells you to post only one", () => {
  const pack = contentPack(ALL_NICHES, now);
  assert.equal(pack.packs.length, niches.length);
  assert.match(pack.index, /Post one niche this week/);
  assert.equal(findNiche("Missing"), null);
  assert.throws(() => contentPack("Missing"), /not on it/);
});

test("the Jenkins dropdown lists the same niches", () => {
  const jenkins = readFileSync(new URL("../../Jenkinsfile.content", import.meta.url), "utf8");
  const listed = nicheChoices().split("\n");
  for (const label of listed) assert.match(jenkins, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(jenkins.includes("choices: ["), false);
});
