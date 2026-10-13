#!/usr/bin/env node
// One folder per site. Each folder has its own note pipeline and posts pipeline.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { niches } from "./content.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sitesDir = join(root, "sites");

const nicheBySite = {
  Motiv: "Car hire",
  "KARV'D": "Restaurant",
  "Kiano London": "Modest fashion",
  "Sweet Dezire": "Dessert shop",
  "Blanco Coffee House": "Coffee shop",
  RAPIDER: "Coaching",
  "D Apartment Sylhet": "Holiday let",
  "Abayas Boutique": "Modest fashion",
  "Tara's Bakes": "Home bakery",
};

export function siteSlug(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function groovyLiteral(value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function pipeline({ intro, stage, archive, cleanup }) {
  return `${intro}
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  stages {
    stage('${stage.name}') {
      steps {
${stage.steps}
      }
    }
  }

  post {
    success {
      archiveArtifacts artifacts: '${archive}', onlyIfSuccessful: true
    }
    cleanup {
      sh '${cleanup}'
    }
  }
}
`;
}

export function notePipeline(site) {
  const request = groovyLiteral(JSON.stringify({ name: site.name }));
  return pipeline({
    intro: `// Private LinkedIn note for ${site.name}. Paste it yourself.`,
    stage: {
      name: "Write the LinkedIn note",
      steps: `        writeFile file: 'site-status/pitch-request.json', text: ${request}
        dir('site-status') {
          sh 'node --version'
          sh 'node scripts/pitch.mjs pitch-request.json pitch.txt'
        }`,
    },
    archive: "site-status/pitch.txt",
    cleanup: "rm -f site-status/pitch-request.json site-status/pitch.txt",
  });
}

export function postsPipeline(site) {
  if (site.niche) {
    const request = groovyLiteral(JSON.stringify({ niche: site.niche }));
    return pipeline({
      intro: `// Public posts for ${site.name}, written as a ${site.niche}. Paste them yourself.`,
      stage: {
        name: "Write the week of posts",
        steps: `        writeFile file: 'site-status/content-request.json', text: ${request}
        dir('site-status') {
          sh 'node --version'
          sh 'node scripts/content.mjs content-request.json content'
        }`,
      },
      archive: "site-status/content/*.txt",
      cleanup: "rm -rf site-status/content site-status/content-request.json",
    });
  }
  const message = groovyLiteral(
    `${site.name} is not a shop niche, so this folder does not draft public posts.\nUse the note pipeline for the private LinkedIn note.\n`,
  );
  return pipeline({
    intro: `// ${site.name} has no shop niche, so there is no public post pack.`,
    stage: {
      name: "No public posts",
      steps: `        writeFile file: 'site-status/no-posts.txt', text: ${message}`,
    },
    archive: "site-status/no-posts.txt",
    cleanup: "rm -f site-status/no-posts.txt",
  });
}

export async function loadSites() {
  const listed = JSON.parse(await readFile(new URL("../sites.json", import.meta.url), "utf8"));
  const known = new Set(niches.map((niche) => niche.label));
  return listed.sites.map((site) => {
    const niche = nicheBySite[site.name] || null;
    if (niche && !known.has(niche)) throw new Error(`${site.name} uses an unknown niche: ${niche}`);
    return { name: site.name, url: site.url, niche, slug: siteSlug(site.name) };
  });
}

export async function writeSiteFolders(target = sitesDir) {
  const sites = await loadSites();
  await mkdir(target, { recursive: true });
  const expected = new Set(sites.map((site) => site.slug));
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || expected.has(entry.name)) continue;
    const folder = join(target, entry.name);
    try {
      await readFile(join(folder, "site.json"), "utf8");
    } catch {
      continue;
    }
    await rm(folder, { recursive: true });
  }
  for (const site of sites) {
    const folder = join(target, site.slug);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "site.json"), `${JSON.stringify({ name: site.name, url: site.url, niche: site.niche }, null, 2)}\n`);
    await writeFile(join(folder, "Jenkinsfile.note"), notePipeline(site));
    await writeFile(join(folder, "Jenkinsfile.posts"), postsPipeline(site));
  }
  return sites;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeSiteFolders()
    .then((sites) => {
      for (const site of sites) console.log(`${site.slug}  ${site.niche || "note only"}`);
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}
