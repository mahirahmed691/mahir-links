import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const THEMES = [
  { id: "down", priority: "Highest", label: "Pages down" },
  { id: "checkout", priority: "High", label: "Checkout" },
  { id: "price", priority: "High", label: "Prices" },
  { id: "speed", priority: "Medium", label: "Speed" },
  { id: "content", priority: "Medium", label: "Page content" },
  { id: "weight", priority: "Low", label: "Page weight" },
];

const CONFIG_PATHS = [
  process.env.SMOKE_REPORT_CONFIG,
  "/var/lib/jenkins/abayas-daily-report.json",
].filter(Boolean);

export function issueTheme(check) {
  if (check.kind === "mock") return check.ok ? "" : "checkout";
  const reason = String(check.reason || "");
  const notes = check.warnings || [];
  if (!check.ok) {
    if (reason.startsWith("Slow")) return "speed";
    if (reason.startsWith("Heavy page")) return "weight";
    if (reason.startsWith("No price")) return "price";
    if (
      reason.startsWith("it left the shop")
      || reason === "the page was not html"
      || reason.startsWith("the page did not include")
      || reason.startsWith("only ")
      || reason.startsWith("No ")
    ) return "content";
    return "down";
  }
  if (notes.some((note) => note.startsWith("Slow"))) return "speed";
  if (notes.some((note) => note.startsWith("No price") || note.startsWith("No products"))) return "price";
  if (notes.some((note) => note.startsWith("No "))) return "content";
  return "";
}

function londonDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function shopName(sections) {
  const named = sections.find((section) => section.name)?.name || "Abayas Boutique";
  return named.split("·")[0].trim() || "Abayas Boutique";
}

export function buildBrief(sections, { now = new Date() } = {}) {
  const grouped = { down: [], checkout: [], price: [], speed: [], content: [] };
  for (const section of sections) {
    for (const check of section.checks || []) {
      const theme = issueTheme(check);
      if (!theme || theme === "weight") continue;
      grouped[theme].push({ ...check, section: section.name });
    }
  }
  const heavy = sections.reduce((sum, section) => sum + (section.heavy || 0), 0);
  const tickets = THEMES.filter((theme) => theme.id === "weight" ? heavy > 0 : grouped[theme.id].length).map((theme) => {
    const items = theme.id === "weight" ? [] : grouped[theme.id];
    const shown = items.slice(0, 12);
    const rest = items.length - shown.length;
    const lines = shown.map((item) => {
      const where = item.url ? `${item.name} (${item.url})` : item.name;
      return `${where}. ${item.fix || item.reason || "Have a look."}`;
    });
    if (rest > 0) lines.push(`And ${rest} more.`);
    if (theme.id === "weight") lines.push(`Cut the pictures down. ${heavy} pages are heavy.`);
    return {
      theme: theme.id,
      priority: theme.priority,
      summary: `Abayas Boutique: ${theme.label}`,
      description: [`Priority: ${theme.priority}`, `Checked: ${londonDate(now)}`, "", ...lines].join("\n"),
      count: theme.id === "weight" ? heavy : items.length,
    };
  });
  const todos = tickets.map((ticket, index) => ({
    number: index + 1,
    priority: ticket.priority,
    theme: ticket.theme,
    text: ticket.theme === "weight"
      ? `Cut the pictures down. ${heavy} pages are heavy.`
      : ticket.description.split("\n").filter((line) => line && !line.startsWith("Priority:") && !line.startsWith("Checked:")).slice(0, 2).join(" "),
  }));
  const failed = sections.filter((section) => section.ok === false).length;
  return {
    shop: shopName(sections),
    url: sections.find((section) => section.url)?.url || "",
    when: londonDate(now),
    ok: failed === 0,
    headline: todos.length ? `${todos.length} ${todos.length === 1 ? "thing" : "things"} for Mahir.` : "Nothing for Mahir tonight.",
    sections: sections.map((section) => ({
      name: section.name,
      ok: Boolean(section.ok),
      pages: (section.checks || []).length,
      heavy: section.heavy || 0,
    })),
    todos,
    tickets,
  };
}

function pdfEscape(value) {
  const cleaned = String(value)
    .replaceAll("·", " - ")
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replaceAll("’", "'")
    .replaceAll("“", "\"")
    .replaceAll("”", "\"");
  let out = "";
  for (const char of cleaned) {
    if (char === "\\") out += "\\\\";
    else if (char === "(") out += "\\(";
    else if (char === ")") out += "\\)";
    else if (char === "£") out += "\\243";
    else if (char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126) out += " ";
    else out += char;
  }
  return out;
}

function wrap(value, size, width) {
  const words = String(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const limit = Math.max(20, Math.floor(width / (size * 0.52)));
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > limit && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function renderPdf(brief) {
  const pages = [];
  let commands = [];
  let y = 790;
  const margin = 48;
  const width = 595 - margin * 2;
  const bottom = 56;
  const ensure = (height) => {
    if (y - height >= bottom) return;
    pages.push(commands);
    commands = [];
    y = 790;
    text(brief.shop, { size: 12, font: "F2", color: [0.44, 0.29, 1] });
  };
  const text = (value, { size = 11, font = "F1", color = [0.08, 0.06, 0.16], gap = 4, indent = 0 } = {}) => {
    const lines = wrap(value, size, width - indent);
    ensure(lines.length * (size + gap) + 8);
    const [r, g, b] = color;
    commands.push(`${r} ${g} ${b} rg`);
    commands.push("BT");
    commands.push(`/${font} ${size} Tf`);
    commands.push(`1 0 0 1 ${margin + indent} ${y - size} Tm`);
    lines.forEach((line, index) => {
      if (index) commands.push(`0 -${size + gap} Td`);
      commands.push(`(${pdfEscape(line)}) Tj`);
    });
    commands.push("ET");
    y -= lines.length * (size + gap) + 8;
  };
  const gap = (amount = 10) => {
    y -= amount;
  };
  const rule = () => {
    ensure(16);
    commands.push("0.44 0.29 1 RG");
    commands.push("0.6 w");
    commands.push(`${margin} ${y} m ${margin + width} ${y} l S`);
    y -= 16;
  };
  commands.push("0.08 0.06 0.16 rg");
  commands.push(`0 760 595 82 re f`);
  commands.push("1 0.82 0.25 rg");
  commands.push(`0 760 595 6 re f`);
  commands.push("1 1 1 rg");
  commands.push("BT");
  commands.push("/F2 22 Tf");
  commands.push(`1 0 0 1 ${margin} 794 Tm`);
  commands.push(`(${pdfEscape(brief.shop)}) Tj`);
  commands.push("ET");
  commands.push("BT");
  commands.push("/F1 11 Tf");
  commands.push(`1 0 0 1 ${margin} 774 Tm`);
  commands.push(`(${pdfEscape(`${brief.when}. Smoke results.`)}) Tj`);
  commands.push("ET");
  y = 736;
  text(brief.headline, { size: 16, font: "F2" });
  if (brief.url) text(brief.url, { size: 10, color: [0.44, 0.29, 1] });
  gap(6);
  rule();
  text("What ran", { size: 14, font: "F2" });
  for (const section of brief.sections) {
    const mark = section.ok ? "Pass" : "Fail";
    text(`${mark}. ${section.name}. ${section.pages} checks.${section.heavy ? ` ${section.heavy} heavy.` : ""}`, { size: 11 });
  }
  gap(6);
  rule();
  text("For Mahir", { size: 14, font: "F2" });
  if (!brief.todos.length) text("Nothing to fix tonight.", { size: 11 });
  for (const todo of brief.todos) {
    text(`${todo.number}. ${todo.priority}. ${todo.text}`, { size: 11 });
  }
  gap(6);
  rule();
  text("Jira", { size: 14, font: "F2" });
  if (!brief.tickets.length) text("No tickets tonight.", { size: 11 });
  for (const ticket of brief.tickets) {
    const key = ticket.key ? `${ticket.key}. ` : "";
    const state = ticket.action === "created" ? "Filed. " : ticket.action === "commented" ? "Already open. " : "Not filed yet. ";
    text(`${key}${state}${ticket.priority}. ${ticket.summary}`, { size: 11, font: "F2" });
    for (const line of ticket.description.split("\n")) {
      if (!line.trim()) continue;
      text(line, { size: 10, color: [0.22, 0.18, 0.32], indent: 12 });
    }
  }
  pages.push(commands);
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let cursor = Buffer.byteLength(chunks[0]);
  const add = (id, body) => {
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    offsets[id] = cursor;
    cursor += Buffer.byteLength(chunk);
    chunks.push(chunk);
  };
  let next = 3;
  const fontRegular = next++;
  const fontBold = next++;
  const pageIds = [];
  const contentIds = pages.map(() => next++);
  for (const [index, page] of pages.entries()) {
    const stream = page.join("\n");
    add(contentIds[index], `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pageId = next++;
    pageIds.push(pageId);
    add(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`);
  }
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
  add(fontRegular, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(fontBold, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const size = offsets.length;
  const xref = ["xref", `0 ${size}`, "0000000000 65535 f "];
  for (let id = 1; id < size; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  chunks.push(`${xref.join("\n")}\ntrailer << /Size ${size} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function adf(text) {
  const blocks = String(text).split(/\n{2,}/).map((block) => ({
    type: "paragraph",
    content: [{ type: "text", text: block.slice(0, 2000) || " " }],
  }));
  return { type: "doc", version: 1, content: blocks.length ? blocks : [{ type: "paragraph", content: [{ type: "text", text: " " }] }] };
}

export async function syncJira(tickets, { env, fetchImpl = fetch, ledger = {} } = {}) {
  if (!env?.baseUrl || !env?.email || !env?.token || !env?.project) {
    return { tickets: tickets.map((ticket) => ({ ...ticket, key: ledger[ticket.theme] || "", action: "draft" })), ledger };
  }
  const root = env.baseUrl.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${env.email}:${env.token}`).toString("base64")}`;
  const call = async (urlPath, options = {}) => {
    const response = await fetchImpl(`${root}${urlPath}`, {
      ...options,
      headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`Jira answered ${response.status}.`);
    return body;
  };
  const next = { ...ledger };
  const filed = [];
  for (const ticket of tickets) {
    const jql = `project = ${env.project} AND labels = abayas-smoke AND labels = ${ticket.theme} AND statusCategory != Done`;
    const found = await call("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, maxResults: 1, fields: ["summary"] }) });
    const existing = found.issues?.[0];
    if (existing?.key) {
      await call(`/rest/api/3/issue/${existing.key}/comment`, { method: "POST", body: JSON.stringify({ body: adf(ticket.description) }) });
      next[ticket.theme] = existing.key;
      filed.push({ ...ticket, key: existing.key, action: "commented" });
      continue;
    }
    const created = await call("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: env.project },
          summary: ticket.summary,
          issuetype: { name: env.issueType || "Task" },
          priority: { name: ticket.priority },
          labels: ["abayas-smoke", ticket.theme],
          description: adf(ticket.description),
        },
      }),
    });
    next[ticket.theme] = created.key;
    filed.push({ ...ticket, key: created.key, action: "created" });
  }
  return { tickets: filed, ledger: next };
}

export async function sendReport({ to, from, subject, text, html, pdf, filename, apiKey, fetchImpl = fetch }) {
  if (!apiKey || !from || !to?.length) throw new Error("Set the report sender, the API key, and who receives it.");
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      html,
      attachments: [{ filename, content: Buffer.from(pdf).toString("base64") }],
    }),
  });
  if (!response.ok) throw new Error(`Email was not accepted (${response.status}).`);
  return response.json();
}

export function emailBody(brief) {
  const todos = brief.todos.length
    ? brief.todos.map((todo) => `${todo.number}. ${todo.priority}. ${todo.text}`).join("\n")
    : "Nothing to fix tonight.";
  const text = `${brief.shop}\n${brief.when}\n${brief.headline}\n\nFor Mahir\n${todos}\n\nThe PDF is attached. No card was sent to the shop.`;
  const html = `<p><strong>${brief.shop}</strong><br>${brief.when}<br>${brief.headline}</p><p>${todos.replace(/\n/g, "<br>")}</p><p>The PDF is attached.</p>`;
  return { text, html, subject: `${brief.shop} · ${brief.headline}` };
}

async function loadConfig() {
  const fromEnv = {
    to: String(process.env.REPORT_TO || "").split(",").map((item) => item.trim()).filter(Boolean),
    from: process.env.RESEND_FROM || "",
    apiKey: process.env.RESEND_API_KEY || "",
    jira: {
      baseUrl: process.env.JIRA_BASE_URL || "",
      email: process.env.JIRA_EMAIL || "",
      token: process.env.JIRA_API_TOKEN || "",
      project: process.env.JIRA_PROJECT || "",
    },
  };
  for (const configPath of CONFIG_PATHS) {
    try {
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      return {
        to: fromEnv.to.length ? fromEnv.to : saved.to || [],
        from: fromEnv.from || saved.from || "",
        apiKey: fromEnv.apiKey || saved.resendApiKey || "",
        jira: {
          baseUrl: fromEnv.jira.baseUrl || saved.jira?.baseUrl || "",
          email: fromEnv.jira.email || saved.jira?.email || "",
          token: fromEnv.jira.token || saved.jira?.apiToken || "",
          project: fromEnv.jira.project || saved.jira?.project || "",
        },
        ledgerPath: saved.ledgerPath || "/var/lib/jenkins/abayas-jira-ledger.json",
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { ...fromEnv, ledgerPath: "/var/lib/jenkins/abayas-jira-ledger.json" };
}

async function readSections(dir) {
  const files = (await readdir(dir)).filter((file) => /^smoke-.*\.json$/.test(file)).sort();
  const sections = [];
  for (const file of files) sections.push(JSON.parse(await readFile(path.join(dir, file), "utf8")));
  return sections;
}

async function main() {
  const dir = process.argv[2] || ".";
  const dryRun = process.argv.includes("--dry-run");
  const sections = await readSections(dir);
  if (!sections.length) throw new Error("No smoke results to report.");
  const config = await loadConfig();
  let brief = buildBrief(sections);
  const ledgerPath = config.ledgerPath;
  let ledger = {};
  try {
    ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!dryRun) {
    const synced = await syncJira(brief.tickets, { env: config.jira, ledger });
    brief = { ...brief, tickets: synced.tickets };
    if (synced.tickets.some((ticket) => ticket.action !== "draft")) {
      await writeFile(ledgerPath, `${JSON.stringify(synced.ledger, null, 2)}\n`);
    }
  }
  const pdf = renderPdf(brief);
  await writeFile(path.join(dir, "abayas-smoke-report.pdf"), pdf);
  await writeFile(path.join(dir, "abayas-smoke-tickets.json"), `${JSON.stringify(brief.tickets, null, 2)}\n`);
  if (dryRun) {
    process.stdout.write(`${brief.headline}\n`);
    return;
  }
  const message = emailBody(brief);
  await sendReport({
    to: config.to,
    from: config.from,
    subject: message.subject,
    text: message.text,
    html: message.html,
    pdf,
    filename: "abayas-smoke.pdf",
    apiKey: config.apiKey,
  });
  process.stdout.write(`Emailed ${brief.headline}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
