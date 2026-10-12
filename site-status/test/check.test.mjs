import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { alexaTimestamp, buildAlexa, buildStatus, probeSite } from "../scripts/check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsonResponse(status) {
  return async () => ({ status });
}

test("sites.json lists named https urls and skips parked work", async () => {
  const config = JSON.parse(await readFile(join(root, "sites.json"), "utf8"));
  assert.ok(config.sites.length >= 1);
  for (const site of config.sites) {
    assert.equal(typeof site.name, "string");
    assert.ok(site.name.length > 0);
    assert.match(site.url, /^https:\/\//);
  }
  assert.equal(config.sites.some((site) => site.name === "Ceevie"), false);
});

test("a 200 response is up", async () => {
  const result = await probeSite({ name: "Example", url: "https://example.com" }, { fetchImpl: jsonResponse(200) });
  assert.equal(result.up, true);
  assert.equal(result.status, 200);
  assert.equal(result.error, null);
});

test("a 503 response is down", async () => {
  const result = await probeSite({ name: "Example", url: "https://example.com" }, { fetchImpl: jsonResponse(503) });
  assert.equal(result.up, false);
  assert.equal(result.status, 503);
});

test("a 404 response is down", async () => {
  const result = await probeSite({ name: "Example", url: "https://example.com" }, { fetchImpl: jsonResponse(404) });
  assert.equal(result.up, false);
  assert.equal(result.status, 404);
});

test("a network failure is down", async () => {
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const result = await probeSite({ name: "Example", url: "https://example.com" }, { fetchImpl });
  assert.equal(result.up, false);
  assert.equal(result.status, null);
  assert.equal(result.error, "network");
});

test("a timeout is down", async () => {
  const fetchImpl = async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  const result = await probeSite({ name: "Example", url: "https://example.com" }, { fetchImpl });
  assert.equal(result.up, false);
  assert.equal(result.error, "timeout");
});

test("status is ok only when every site is up", () => {
  const updated = new Date("2026-10-12T00:17:00.000Z");
  const status = buildStatus(
    [
      { name: "One", url: "https://one.example", up: true, status: 200, ms: 10, error: null },
      { name: "Two", url: "https://two.example", up: false, status: 500, ms: 20, error: null },
    ],
    updated,
  );
  assert.equal(status.ok, false);
  assert.equal(status.updated, "2026-10-12T00:17:00.000Z");
  assert.equal(status.sites.length, 2);
  assert.equal(buildStatus([{ name: "One", url: "https://one.example", up: true, status: 200, ms: 10, error: null }], updated).ok, true);
});

test("the Alexa feed is a JSON array with the required fields", () => {
  const status = buildStatus(
    [{ name: "One", url: "https://one.example", up: true, status: 200, ms: 10, error: null }],
    new Date("2026-10-12T00:17:00.000Z"),
  );
  const feed = buildAlexa(status, { id: "status-1", redirect: "https://www.mahirahmed.link" });
  assert.ok(Array.isArray(feed));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].uid, "status-1");
  assert.equal(feed[0].titleText, "Site status");
  assert.equal(feed[0].redirectionUrl, "https://www.mahirahmed.link");
  assert.equal(typeof feed[0].mainText, "string");
  assert.ok(feed[0].mainText.length > 0);
});

test("updateDate uses the Flash Briefing timestamp", () => {
  assert.equal(alexaTimestamp(new Date("2026-10-12T00:17:00.000Z")), "2026-10-12T00:17:00.0Z");
  const status = buildStatus([], new Date("2026-10-12T00:17:00.000Z"));
  assert.equal(buildAlexa(status, { id: "status-1" })[0].updateDate, "2026-10-12T00:17:00.0Z");
});

test("mainText names down sites and stays clear when everything is up", () => {
  const updated = new Date("2026-10-12T00:17:00.000Z");
  const down = buildAlexa(
    buildStatus(
      [
        { name: "One", url: "https://one.example", up: true, status: 200, ms: 1, error: null },
        { name: "FlickFinder", url: "https://flick.example", up: false, status: 500, ms: 1, error: null },
      ],
      updated,
    ),
    { id: "status-down" },
  );
  assert.match(down[0].mainText, /Only 1 of the 2 is up/);
  assert.match(down[0].mainText, /UK time/);
  const flicker = down.find((item) => item.titleText === "FlickFinder");
  assert.match(flicker.mainText, /FlickFinder is down/);
  assert.match(flicker.mainText, /status 500/);
  assert.match(flicker.mainText, /millisecond/);
  assert.match(flicker.mainText, /I'd check the host logs/);
  assert.match(down[0].mainText, /Start with FlickFinder\. I'd check the host logs/);
  assert.match(down.map((item) => item.mainText).join(" "), /One is up\. It answered in 1 millisecond/);

  const up = buildAlexa(
    buildStatus([{ name: "One", url: "https://one.example", up: true, status: 200, ms: 1, error: null }], updated),
    { id: "status-up" },
  );
  assert.match(up[0].mainText, /One is up/);
  assert.match(up[0].mainText, /1 millisecond/);
  assert.match(up[0].mainText, /UK time/);
  assert.equal(up[0].mainText.includes("down"), false);
  assert.equal(up[0].mainText.includes("I'd"), false);

  const speeds = buildAlexa(
    buildStatus(
      [
        { name: "One", url: "https://one.example", up: true, status: 200, ttfb: 50, ms: 200, bytes: 2048, contentType: "text/html", error: null },
        { name: "Two", url: "https://two.example", up: true, status: 200, ttfb: 400, ms: 1800, bytes: 12000, contentType: "text/html", redirected: true, finalUrl: "https://two.example/home", error: null },
      ],
      updated,
    ),
    { id: "status-speed" },
  );
  assert.match(speeds[0].mainText, /On average they took 1 second/);
  assert.match(speeds[0].mainText, /One was the quickest, at 200 milliseconds/);
  assert.match(speeds[0].mainText, /Two was the slowest, at 1\.8 seconds/);
  const report = speeds.map((item) => item.mainText).join(" ");
  assert.match(report, /Two is up/);
  assert.match(report, /finished in 1\.8 seconds/);
  assert.match(report, /started answering in 50 milliseconds/);
  assert.match(report, /2 kilobytes/);
  assert.match(report, /sent me on to two\.example/);

  const changed = buildAlexa(
    buildStatus(
      [{ name: "KARV'D", url: "https://www.karvd.uk", up: true, status: 200, ms: 900, title: "KARV'D | Order", certDays: 12, error: null }],
      updated,
    ),
    {
      id: "status-change",
      previous: { updated: "2026-10-12T00:17:00.000Z", sites: [{ name: "KARV'D", up: false, status: 503, ms: 300 }] },
    },
  );
  const changeText = changed.map((item) => item.mainText).join(" ");
  assert.match(changeText, /KARV'D is back/);
  assert.match(changeText, /page calls itself KARV'D, Order/);
  assert.match(changeText, /certificate runs out in 12 days/);

  const slower = buildAlexa(
    buildStatus(
      [
        { name: "One", url: "https://one.example", up: true, status: 200, ms: 200, error: null },
        { name: "Two", url: "https://two.example", up: true, status: 200, ms: 1800, error: null },
      ],
      updated,
    ),
    {
      id: "status-slower",
      previous: {
        updated: "2026-10-11T23:17:00.000Z",
        sites: [
          { name: "One", up: true, ms: 200 },
          { name: "Two", up: true, ms: 400 },
        ],
      },
    },
  );
  assert.match(slower[0].mainText, /Two is 1\.4 seconds slower than an hour ago/);

  const heavy = buildAlexa(
    buildStatus(
      [
        { name: "One", url: "https://one.example", up: true, status: 200, ttfb: 100, ms: 150, bytes: 2048, contentType: "text/html", error: null },
        { name: "Abayas Boutique", url: "https://abayasboutique.com", up: true, status: 200, ttfb: 3600, ms: 3800, bytes: 1468006, contentType: "text/html", error: null },
      ],
      updated,
    ),
    { id: "status-fix" },
  );
  const fixText = heavy.map((item) => item.mainText).join(" ");
  assert.match(fixText, /Abayas Boutique is the one I'd fix\. I'd cache the homepage, and cut the page down from 1\.4 megabytes/);
  assert.equal(fixText.includes("One is the one I'd fix"), false);
});
