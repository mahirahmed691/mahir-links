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
  if (text.length > 260) return portrait ? 42 : 32;
  if (text.length > 180) return portrait ? 48 : 36;
  return portrait ? 56 : 42;
}

export function cardHtml(post, who = author) {
  const size = cardSizes[post.channel];
  if (!size) throw new Error(`No card size for ${post.channel}.`);
  const type = typeSize(post.text, size);
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,800&family=Instrument+Sans:wght@500;600&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
  body { padding: ${size.height > size.width ? 88 : 64}px; display: flex; flex-direction: column;
    background: #F4F2FF; color: #14102A; font-family: "Instrument Sans", sans-serif;
    background-image: radial-gradient(rgba(111, 75, 255, 0.18) 1.5px, transparent 1.8px); background-size: 28px 28px; }
  .pill { align-self: flex-start; background: #FFD23F; border: 3px solid #14102A; border-radius: 999px;
    padding: 10px 22px; font-weight: 600; font-size: ${size.height > size.width ? 32 : 26}px; }
  h1 { margin-top: 36px; font: 800 ${type}px/1.2 "Bricolage Grotesque", "Arial Narrow", sans-serif;
    font-stretch: 80%; letter-spacing: -0.03em; }
  footer { margin-top: auto; display: flex; justify-content: space-between; align-items: baseline;
    font-size: ${size.height > size.width ? 32 : 26}px; font-weight: 600; }
  footer b { font: 800 ${size.height > size.width ? 40 : 32}px/1 "Bricolage Grotesque", "Arial Narrow", sans-serif; }
</style></head><body>
  <div class="pill">${escapeHtml(post.day)} · ${escapeHtml(post.channel)}</div>
  <h1>${escapeHtml(post.text)}</h1>
  <footer><b>${escapeHtml(who.name)}</b><span>${escapeHtml(who.site)}</span></footer>
</body></html>
`;
}

export function checkPack(dir, { posts }) {
  const errors = [];
  for (const post of posts) {
    const stem = fileStem(post);
    const expected = cardSizes[post.channel];
    const textPath = join(dir, `${stem}.txt`);
    const htmlPath = join(dir, `${stem}.html`);
    const pngPath = join(dir, `${stem}.png`);
    const label = `${post.day} ${post.channel}`;
    if (!existsSync(textPath)) errors.push(`${label} text is missing.`);
    else if (readFileSync(textPath, "utf8") !== `${post.text}\n`) errors.push(`${label} text does not match the post.`);
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
