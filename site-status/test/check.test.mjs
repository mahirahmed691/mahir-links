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
  assert.match(down[0].mainText, /1 of 2 sites are up/);
  assert.match(down[0].mainText, /UK time/);
  const flicker = down.find((item) => item.titleText === "FlickFinder");
  assert.match(flicker.mainText, /FlickFinder is down/);
  assert.match(flicker.mainText, /status 500/);
  assert.match(flicker.mainText, /millisecond/);
  assert.match(down[0].mainText, /One responded in/);
  assert.match(down.find((item) => item.titleText === "Sites up").mainText, /One in/);

  const up = buildAlexa(
    buildStatus([{ name: "One", url: "https://one.example", up: true, status: 200, ms: 1, error: null }], updated),
    { id: "status-up" },
  );
  assert.match(up[0].mainText, /One is up/);
  assert.match(up[0].mainText, /1 millisecond/);
  assert.match(up[0].mainText, /UK time/);
  assert.equal(up[0].mainText.includes("down"), false);

  const speeds = buildAlexa(
    buildStatus(
      [
        { name: "One", url: "https://one.example", up: true, status: 200, ms: 200, error: null },
        { name: "Two", url: "https://two.example", up: true, status: 200, ms: 1800, error: null },
      ],
      updated,
    ),
    { id: "status-speed" },
  );
  assert.match(speeds[0].mainText, /Average response was 1 second/);
  assert.match(speeds[0].mainText, /Fastest was One at 200 milliseconds/);
  assert.match(speeds[0].mainText, /Slowest was Two at 1.8 seconds/);
  assert.match(speeds.find((item) => item.titleText === "Response times").mainText, /Two in 1.8 seconds/);
});
