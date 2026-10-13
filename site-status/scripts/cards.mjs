// Type cards for the weekly posts. LinkedIn and Facebook share one size.
import { deflateSync, crc32 } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const author = {
  name: "Mahir Ahmed",
  site: "mahirahmed.link",
};

export const cardSizes = {
  LinkedIn: { width: 1200, height: 630 },
  Facebook: { width: 1200, height: 630 },
  Instagram: { width: 1080, height: 1350 },
};

export function fileStem(post) {
  return `${post.day}-${post.channel}`.toLowerCase();
}

export function pngSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const signature = "89504e470d0a1a0a";
  if (bytes.subarray(0, 8).toString("hex") !== signature) throw new Error("Not a PNG.");
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("PNG is missing its size.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function solidPng(width, height) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function typeSize(text, size) {
  const portrait = size.height > size.width;
  if (text.length > 260) return portrait ? 40 : 28;
  if (text.length > 180) return portrait ? 46 : 32;
  return portrait ? 52 : 36;
}

export function cardHtml(post, nicheLabel, who = author) {
  const size = cardSizes[post.channel];
  if (!size) throw new Error(`No card size for ${post.channel}.`);
  if (!nicheLabel) throw new Error("A card needs its niche.");
  const portrait = size.height > size.width;
  const type = typeSize(post.text, size);
  const title = portrait ? 128 : 78;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,800&family=Instrument+Sans:wght@500;600&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
  body { display: flex; flex-direction: column; background: #F4F2FF; color: #14102A;
    font-family: "Instrument Sans", sans-serif; }
  .stage { flex: 1; display: flex; flex-direction: column; justify-content: space-between;
    padding: ${portrait ? "84px 84px 56px" : "48px 56px 36px"};
    background-image: radial-gradient(rgba(111, 75, 255, 0.18) 1.5px, transparent 1.8px); background-size: 28px 28px; }
  .pill { align-self: flex-start; background: #FFD23F; border: 3px solid #14102A; border-radius: 999px;
    padding: 10px 22px; font-weight: 600; font-size: ${portrait ? 32 : 24}px; }
  h1 { font: 800 ${title}px/0.9 "Bricolage Grotesque", "Arial Narrow", sans-serif;
    font-stretch: 78%; letter-spacing: -0.045em; max-width: ${portrait ? "7em" : "12em"}; }
  .sheet { background: #14102A; color: #F4F2FF; padding: ${portrait ? "64px 84px 72px" : "36px 56px 40px"}; }
  p { max-width: ${portrait ? "16em" : "36em"}; font: 600 ${type}px/1.28 "Instrument Sans", sans-serif; }
  footer { display: flex; justify-content: space-between; align-items: baseline; margin-top: ${portrait ? 48 : 28}px;
    font-size: ${portrait ? 30 : 22}px; font-weight: 600; }
  footer b { font: 800 ${portrait ? 36 : 28}px/1 "Bricolage Grotesque", "Arial Narrow", sans-serif; }
  footer span { color: #FFD23F; }
</style></head><body>
  <section class="stage">
    <div class="pill">${escapeHtml(post.day)} · ${escapeHtml(post.channel)}</div>
    <h1>${escapeHtml(nicheLabel)}</h1>
  </section>
  <section class="sheet">
    <p>${escapeHtml(post.text)}</p>
    <footer><b>${escapeHtml(who.name)}</b><span>${escapeHtml(who.site)}</span></footer>
  </section>
</body></html>
`;
}

export function checkPack(dir, { posts, niche = "" }) {
  const errors = [];
  for (const post of posts) {
    const stem = fileStem(post);
    const expected = cardSizes[post.channel];
    const textPath = join(dir, `${stem}.txt`);
    const htmlPath = join(dir, `${stem}.html`);
    const pngPath = join(dir, `${stem}.png`);
    const label = `${niche ? `${niche} ` : ""}${post.day} ${post.channel}`;
    const expectedText = post.caption ?? `${post.text}\n`;
    if (!existsSync(textPath)) errors.push(`${label} text is missing.`);
    else if (readFileSync(textPath, "utf8") !== expectedText) errors.push(`${label} text does not match the post.`);
    if (!existsSync(htmlPath)) errors.push(`${label} card is missing.`);
    else {
      const html = readFileSync(htmlPath, "utf8");
      if (!html.includes(`width: ${expected.width}px`) || !html.includes(`height: ${expected.height}px`)) {
        errors.push(`${label} card is not ${expected.width}×${expected.height}.`);
      }
      if (!html.includes(escapeHtml(post.text))) errors.push(`${label} card is missing its sentence.`);
    }
    if (!existsSync(pngPath)) errors.push(`${label} picture is missing.`);
    else {
      try {
        const actual = pngSize(readFileSync(pngPath));
        if (actual.width !== expected.width || actual.height !== expected.height) {
          errors.push(`${label} picture is ${actual.width}×${actual.height}. It should be ${expected.width}×${expected.height}.`);
        }
      } catch {
        errors.push(`${label} picture is not a PNG.`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
