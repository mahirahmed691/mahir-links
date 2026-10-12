import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedinNote, pitchSite, publicHttpsUrl } from "../scripts/pitch.mjs";

const now = () => new Date("2026-10-12T21:28:00.000Z");

test("a slow shop note names the fix and asks to keep watching", async () => {
  const note = await pitchSite({
    name: "Abayas Boutique",
    url: "https://abayasboutique.com",
    now,
    cert: async () => null,
    probe: async () => ({
      name: "Abayas Boutique",
      url: "https://abayasboutique.com",
      up: true,
      status: 200,
      ttfb: 3600,
      ms: 4800,
      bytes: 1468006,
      contentType: "text/html",
      error: null,
    }),
  });
  assert.match(note, /^I checked abayasboutique\.com\./);
  assert.match(note, /I'd cache the homepage/);
  assert.match(note, /Want me to keep an eye on it\?$/);
});

test("a fast shop note does not invent a fix", async () => {
  const note = await pitchSite({
    name: "Sakinah",
    url: "https://www.mysakinah.app/",
    now,
    cert: async () => null,
    probe: async () => ({
      name: "Sakinah",
      url: "https://www.mysakinah.app/",
      up: true,
      status: 200,
      ms: 197,
      error: null,
    }),
  });
  assert.equal(/\bI'd\b/.test(note), false);
  assert.match(note, /before a customer does\.$/);
});

test("the note uses the spoken check", () => {
  const note = linkedinNote({
    url: "https://www.tsbakes.co.uk/menu",
    spoken: "It's 10:28 in the afternoon, UK time. Tara's Bakes is up. It answered in 400 milliseconds.",
  });
  assert.match(note, /^I checked tsbakes\.co\.uk\./);
  assert.match(note, /Tara's Bakes is up/);
});

test("private and non-https addresses are refused", () => {
  assert.equal(publicHttpsUrl("https://example.com/path").startsWith("https://example.com/"), true);
  assert.throws(() => publicHttpsUrl("http://example.com"), /https:\/\//);
  assert.throws(() => publicHttpsUrl("https://user:secret@example.com"), /password/);
  for (const url of ["https://127.0.0.1", "https://10.1.1.1", "https://192.168.0.8", "https://172.16.0.1", "https://localhost/admin", "https://shop.internal"]) {
    assert.throws(() => publicHttpsUrl(url), /public website/);
  }
});
