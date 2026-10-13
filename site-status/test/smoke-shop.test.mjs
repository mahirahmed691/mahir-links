import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { describeUrl, discoverPages, paceNotes, shopPages, sitemapLocs, smokeHtml, smokeReport, smokeShop } from "../scripts/smoke-shop.mjs";

const shop = {
  name: "Abayas Boutique",
  url: "https://abayasboutique.com",
  pages: [
    { name: "Home", emoji: "🏠", path: "/", expect: "Abayas Boutique" },
    { name: "Abayas", emoji: "👗", path: "/collections/abayas/", expect: "Abayas Boutique" },
    { name: "Bag", emoji: "🛍️", path: "/cart/", expect: "Abayas Boutique" },
    { name: "Account", emoji: "👤", path: "/my-account/", expect: "My account" },
  ],
};

function page(body, { status = 200, finalUrl, type = "text/html; charset=UTF-8" } = {}) {
  return {
    status,
    url: finalUrl,
    headers: { get: (name) => (name === "content-type" ? type : null) },
    text: async () => body,
  };
}

function fakeFetch(overrides = {}) {
  return async (url) => {
    const hit = overrides[url];
    if (hit) return { ...hit, url: hit.url || url };
    const account = url.endsWith("/my-account/");
    return page(account ? "My account" : "Abayas Boutique", { finalUrl: url });
  };
}

test("the Abayas Boutique smoke file checks the customer pages", async () => {
  const saved = JSON.parse(await readFile(new URL("../../sites/abayas-boutique/smoke.json", import.meta.url), "utf8"));
  assert.equal(saved.url, "https://abayasboutique.com");
  assert.deepEqual(saved.sitemaps, [
    "https://abayasboutique.com/page-sitemap.xml",
    "https://abayasboutique.com/product_cat-sitemap.xml",
    "https://abayasboutique.com/product-sitemap.xml",
    "https://abayasboutique.com/post-sitemap.xml",
    "https://abayasboutique.com/category-sitemap.xml",
  ]);
  assert.deepEqual(shopPages({ url: saved.url, pages: saved.extra }).map((page) => page.url), [
    "https://abayasboutique.com/cart/",
    "https://abayasboutique.com/my-account/",
    "https://abayasboutique.com/checkout/",
  ]);
  const jenkins = await readFile(new URL("../../sites/abayas-boutique/Jenkinsfile.smoke", import.meta.url), "utf8");
  assert.match(jenkins, /smoke-shop\.mjs/);
  assert.match(jenkins, /abayas-boutique\/smoke\.json/);
});

test("a shop that answers on every page passes", async () => {
  const result = await smokeShop(shop, { fetchImpl: fakeFetch() });
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 4);
  const report = smokeReport(result);
  assert.match(report, /✅ 🏠 Home/);
  assert.match(report, /✅ Pass\. 4 pages open\./);
  assert.match(smokeHtml(result), /Abayas Boutique smoke/);
  assert.match(smokeHtml(result), /#1F8A4C/);
});

test("a broken collection fails the smoke test", async () => {
  const result = await smokeShop(shop, {
    fetchImpl: fakeFetch({
      "https://abayasboutique.com/collections/abayas/": page("Abayas Boutique", { status: 500, finalUrl: "https://abayasboutique.com/collections/abayas/" }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "Abayas").reason, "status 500");
  assert.match(smokeReport(result), /❌ Fail\. 1 page down\./);
  assert.match(smokeHtml(result), /#C4384B/);
});

test("a page that leaves the shop fails", async () => {
  const result = await smokeShop(shop, {
    fetchImpl: fakeFetch({
      "https://abayasboutique.com/cart/": page("Abayas Boutique", { finalUrl: "https://example.com/cart/" }),
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.name === "Bag").reason, /left the shop/);
});

test("a page without the shop text fails", async () => {
  const result = await smokeShop(shop, {
    fetchImpl: fakeFetch({
      "https://abayasboutique.com/": page("Something else", { finalUrl: "https://abayasboutique.com/" }),
    }),
  });
  assert.equal(result.checks.find((check) => check.name === "Home").reason, 'the page did not include "Abayas Boutique"');
});

test("a page that is not html fails", async () => {
  const result = await smokeShop(shop, {
    fetchImpl: fakeFetch({
      "https://abayasboutique.com/": page("Abayas Boutique", { finalUrl: "https://abayasboutique.com/", type: "application/json" }),
    }),
  });
  assert.equal(result.checks.find((check) => check.name === "Home").reason, "the page was not html");
});

test("a slow heavy page stays open and is flagged", () => {
  const notes = paceNotes(2700, 1400000);
  assert.match(notes[0], /Slow/);
  assert.match(notes[1], /Heavy page/);
});

test("a shop page with no products fails when products are required", async () => {
  const result = await smokeShop(
    { ...shop, pages: [{ name: "Abayas", emoji: "👗", path: "/collections/abayas/", expect: "Abayas Boutique", minProducts: 1 }] },
    { fetchImpl: fakeFetch() },
  );
  assert.equal(result.ok, false);
  assert.match(result.checks[0].reason, /only 0 products/);
});

test("the sitemap walk keeps shop urls and names each kind", async () => {
  const locs = sitemapLocs("<loc>https://abayasboutique.com/about-us/</loc><loc>https://abayasboutique.com/product/ona-green/</loc>");
  assert.equal(locs.length, 2);
  assert.equal(describeUrl("https://abayasboutique.com/product/ona-green/").kind, "product");
  assert.equal(describeUrl("https://abayasboutique.com/collections/hijabs/").kind, "collection");
  assert.equal(describeUrl("https://abayasboutique.com/blog/history-of-the-abaya/").kind, "journal");
  const config = {
    url: "https://abayasboutique.com",
    sitemaps: ["https://abayasboutique.com/page-sitemap.xml"],
    extra: [{ name: "Bag", emoji: "🛍️", path: "/cart/", expect: "Bag" }],
  };
  const fetchImpl = async (url) => ({
    status: 200,
    url,
    headers: { get: () => "application/xml" },
    text: async () => "<loc>https://abayasboutique.com/about-us/</loc><loc>https://abayasboutique.com/cart/</loc><loc>https://other.example/nope</loc>",
  });
  const pages = await discoverPages(config, fetchImpl);
  assert.deepEqual(pages.map((page) => page.url), [
    "https://abayasboutique.com/cart/",
    "https://abayasboutique.com/about-us/",
  ]);
});

test("a page on another site is refused", () => {
  assert.throws(
    () => shopPages({ url: "https://abayasboutique.com", pages: [{ name: "Away", path: "https://example.com/", expect: "x" }] }),
    /must stay on abayasboutique.com/,
  );
});
