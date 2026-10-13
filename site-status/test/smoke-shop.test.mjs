import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { describeUrl, discoverPages, jenkinsSmoke, judgeCheck, mockCheckoutReport, mockCheckoutSuite, normalAspect, notableNotes, paceNotes, pageFix, retestFailed, selectSection, shopPages, sitemapLocs, smokeHtml, smokeReport, smokeShop } from "../scripts/smoke-shop.mjs";

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
  assert.deepEqual(saved.sections.map((section) => section.name), [
    "Shop pages",
    "Collections",
    "Products",
    "Journal",
    "Bag, account, and checkout",
    "Mock checkout",
  ]);
  const checkout = selectSection(saved, "Bag, account, and checkout");
  assert.equal(checkout.name, "Abayas Boutique · Bag, account, and checkout");
  assert.deepEqual(shopPages(checkout).map((page) => page.url), [
    "https://abayasboutique.com/cart/",
    "https://abayasboutique.com/my-account/",
    "https://abayasboutique.com/checkout/",
  ]);
  assert.deepEqual(selectSection(saved, "Journal").sitemaps, [
    "https://abayasboutique.com/post-sitemap.xml",
    "https://abayasboutique.com/category-sitemap.xml",
  ]);
  const jenkins = await readFile(new URL("../../sites/abayas-boutique/Jenkinsfile.smoke", import.meta.url), "utf8");
  assert.equal(jenkins, jenkinsSmoke(saved));
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

test("speed, weight, and prices can fail a page that is still open", () => {
  const slow = { ok: true, kind: "page", prices: 1, warnings: ["Slow. 2.7s. A customer is waiting.", "Heavy page. 1.4 MB."] };
  assert.equal(judgeCheck(slow, "Open").ok, true);
  assert.equal(judgeCheck(slow, "Speed").ok, false);
  assert.match(judgeCheck(slow, "Speed").reason, /Slow/);
  assert.equal(judgeCheck(slow, "Weight").ok, false);
  const bare = { ok: true, kind: "product", prices: 0, warnings: ["No price on this product."] };
  assert.equal(judgeCheck(bare, "Prices").ok, false);
  assert.equal(judgeCheck({ ...bare, prices: 2, warnings: [] }, "Prices").ok, true);
  assert.throws(() => normalAspect("Colour"), /aspect must be one of/);
});

test("a page that answers the second time passes, and a dead host is not hammered", async () => {
  const down = (name) => ({
    name,
    emoji: "📄",
    url: `https://abayasboutique.com/${name.toLowerCase()}`,
    expect: "Abayas Boutique",
    kind: "page",
    ok: false,
    reason: "it never answered",
    warnings: [],
  });
  const quiet = [down("Home"), down("About"), down("Contact")];
  let calls = 0;
  const stillDown = await retestFailed(quiet, async () => {
    calls += 1;
    return { ...quiet[0], ok: false, reason: "it never answered", warnings: [] };
  });
  assert.equal(calls, 1);
  assert.match(stillDown[0].again, /Still failing/);
  assert.match(stillDown[1].again, /Left alone/);
  assert.match(stillDown[0].fix, /host is still running/);
  assert.match(stillDown[2].fix, /host is still running/);

  calls = 0;
  const bag = { name: "Bag", emoji: "🛍️", url: "https://abayasboutique.com/cart/", expect: "Bag", kind: "page", ok: false, reason: "it never answered", warnings: [] };
  const settled = await retestFailed([bag], async (page) => {
    calls += 1;
    return { name: page.name, emoji: page.emoji, url: page.url, finalUrl: page.url, status: 200, ok: true, reason: "", warnings: [], kind: "page", ms: 20, bytes: 100 };
  });
  assert.equal(calls, 1);
  assert.equal(settled[0].ok, true);
  assert.equal(settled[0].recovered, true);
  assert.match(smokeReport({ name: "Shop", url: "https://abayasboutique.com", checkedAt: "Tuesday", ok: true, aspect: "Open", checks: settled }), /answered the second time/);

  calls = 0;
  const missing = { name: "Home", emoji: "🏠", url: "https://abayasboutique.com/", ok: false, reason: 'the page did not include "Abayas Boutique"', warnings: [] };
  const named = await retestFailed([missing], async () => {
    calls += 1;
    return missing;
  });
  assert.equal(calls, 0);
  assert.equal(pageFix(missing), "I'd put the missing shop text back on this page.");
  assert.equal(named[0].fix, pageFix(missing));
});

test("a heavy page stays in the open list and a slow page needs a look", () => {
  const heavy = { name: "About", emoji: "📄", kind: "page", ok: true, finalUrl: "https://abayasboutique.com/about-us/", status: 200, ms: 1000, bytes: 1400000, warnings: ["Heavy page. 1.4 MB."], title: "About" };
  const slow = { name: "Home", emoji: "🏠", kind: "page", ok: true, finalUrl: "https://abayasboutique.com/", status: 200, ms: 2700, bytes: 1400000, warnings: ["Slow. 2.7s. A customer is waiting.", "Heavy page. 1.4 MB."], title: "Home" };
  const result = { name: "Abayas Boutique · Shop pages", url: "https://abayasboutique.com/", checkedAt: "Tuesday", ok: true, checks: [slow, heavy] };
  const report = smokeReport(result);
  assert.deepEqual(notableNotes(heavy), []);
  assert.match(report, /Needs a look[\s\S]*Home/);
  assert.doesNotMatch(report.split("Every page")[0], /About/);
  assert.match(report, /All 2 pages are heavy/);
  assert.match(smokeHtml(result), /Needs a look · 1/);
  assert.match(smokeHtml(result), /Open · 1/);
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
  const sitemapOnly = await discoverPages(
    { url: "https://abayasboutique.com", sitemaps: ["https://abayasboutique.com/page-sitemap.xml"] },
    fetchImpl,
  );
  assert.deepEqual(sitemapOnly.map((page) => page.url), [
    "https://abayasboutique.com/about-us/",
    "https://abayasboutique.com/cart/",
  ]);
});

test("the mock checkout pays with a fake card and never charges the shop", async () => {
  const saved = JSON.parse(await readFile(new URL("../../sites/abayas-boutique/smoke.json", import.meta.url), "utf8"));
  const section = selectSection(saved, "Mock checkout");
  const result = mockCheckoutSuite(section.mockCheckout, { name: section.name, url: section.url });
  assert.equal(result.ok, true);
  const paid = result.checks[0].result;
  assert.equal(paid.orderId, "AB-1001");
  assert.equal(paid.paid, false);
  assert.match(paid.steps.at(-1).detail, /bag is empty/);
  const declined = result.checks[1].result;
  assert.equal(declined.ok, false);
  assert.equal(declined.orderId, "");
  assert.match(declined.reason, /declined/);
  assert.match(result.checks[2].result.reason, /out of stock/);
  assert.match(result.checks[3].result.reason, /bag is empty/);
  assert.match(result.checks[4].result.reason, /missing/);
  assert.match(mockCheckoutReport(result), /No payment was sent to the shop/);
  assert.match(jenkinsSmoke(saved), /Mock checkout/);
});

test("a page on another site is refused", () => {
  assert.throws(
    () => shopPages({ url: "https://abayasboutique.com", pages: [{ name: "Away", path: "https://example.com/", expect: "x" }] }),
    /must stay on abayasboutique.com/,
  );
});
