import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief, issueTheme, renderPdf, syncJira } from "../scripts/daily-report.mjs";

const down = {
  name: "Abayas Boutique · Shop pages",
  url: "https://abayasboutique.com",
  ok: false,
  heavy: 2,
  checks: [
    { name: "Home", url: "https://abayasboutique.com/", ok: false, reason: "it never answered", fix: "I'd check that the host is still running.", warnings: [], kind: "page" },
    { name: "About", url: "https://abayasboutique.com/about-us/", ok: true, reason: "", fix: "I'd add a short description to this page.", warnings: ["No description."], kind: "page" },
  ],
};

test("a down page is Mahir's first job and each theme is one ticket", () => {
  const brief = buildBrief([
    down,
    {
      name: "Abayas Boutique · Mock checkout",
      url: "https://abayasboutique.com",
      ok: true,
      heavy: 0,
      checks: [{ name: "A good mock card places an order", ok: true, reason: "", fix: "", warnings: [], kind: "mock" }],
    },
  ]);
  assert.equal(brief.headline, "3 things for Mahir.");
  assert.equal(brief.todos[0].priority, "Highest");
  assert.match(brief.todos[0].text, /host is still running/);
  assert.deepEqual(brief.tickets.map((ticket) => ticket.theme), ["down", "content", "weight"]);
  assert.equal(issueTheme(down.checks[1]), "content");
  const pdf = renderPdf(brief);
  const text = pdf.toString("latin1");
  assert.match(text, /^%PDF-1.4/);
  assert.match(text, /For Mahir/);
  assert.match(text, /Not filed yet/);
  assert.match(text, /startxref/);
});

test("a quiet shop has nothing for Mahir", () => {
  const brief = buildBrief([{
    name: "Abayas Boutique · Shop pages",
    url: "https://abayasboutique.com",
    ok: true,
    heavy: 0,
    checks: [{ name: "Home", url: "https://abayasboutique.com/", ok: true, reason: "", fix: "", warnings: [], kind: "page" }],
  }]);
  assert.equal(brief.headline, "Nothing for Mahir tonight.");
  assert.equal(brief.tickets.length, 0);
});

test("an open Jira ticket is updated instead of filed again", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(`${options.method || "GET"} ${url}`);
    if (url.endsWith("/search/jql")) return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [{ key: "AB-4" }] }) };
    if (url.endsWith("/comment")) return { ok: true, status: 201, text: async () => "{}" };
    return { ok: false, status: 500, text: async () => "{}" };
  };
  const result = await syncJira(
    [{ theme: "down", priority: "Highest", summary: "Abayas Boutique: Pages down", description: "Home is down." }],
    { env: { baseUrl: "https://example.atlassian.net", email: "a@b.c", token: "secret", project: "AB" }, fetchImpl },
  );
  assert.equal(result.tickets[0].key, "AB-4");
  assert.equal(result.tickets[0].action, "commented");
  assert.equal(result.ledger.down, "AB-4");
  assert.equal(calls.some((call) => call.startsWith("POST") && call.endsWith("/issue")), false);
});

test("without Jira the tickets stay drafts", async () => {
  const result = await syncJira(
    [{ theme: "speed", priority: "Medium", summary: "Abayas Boutique: Speed", description: "Cache the home page." }],
    { env: {} },
  );
  assert.equal(result.tickets[0].action, "draft");
  assert.equal(result.tickets[0].key, "");
});
