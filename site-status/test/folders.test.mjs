import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { loadSites, notePipeline, postsPipeline } from "../scripts/folders.mjs";

const sitesRoot = new URL("../../sites/", import.meta.url);

test("every site has its own folder and both pipelines", async () => {
  const sites = await loadSites();
  assert.equal(new Set(sites.map((site) => site.slug)).size, sites.length);
  const folders = readdirSync(sitesRoot).sort();
  assert.deepEqual(folders, sites.map((site) => site.slug).sort());
  for (const site of sites) {
    const folder = new URL(`${site.slug}/`, sitesRoot);
    const saved = JSON.parse(readFileSync(new URL("site.json", folder), "utf8"));
    assert.deepEqual(saved, { name: site.name, url: site.url, niche: site.niche });
    assert.equal(readFileSync(new URL("Jenkinsfile.note", folder), "utf8"), notePipeline(site));
    assert.equal(readFileSync(new URL("Jenkinsfile.posts", folder), "utf8"), postsPipeline(site));
    assert.equal(readFileSync(new URL("Jenkinsfile.note", folder), "utf8").includes("choices: ["), false);
    if (site.niche) assert.match(readFileSync(new URL("Jenkinsfile.posts", folder), "utf8"), new RegExp(site.niche));
    else assert.match(readFileSync(new URL("Jenkinsfile.posts", folder), "utf8"), /no shop niche/);
  }
});
