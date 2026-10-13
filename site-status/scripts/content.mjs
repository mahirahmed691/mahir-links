#!/usr/bin/env node
// Draft one week of public posts for a niche. Jenkins archives the files.
// Nothing here is posted. Shop names and measured speeds stay out of the copy.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const ALL_NICHES = "All niches";

export const niches = [
  {
    label: "Home bakery",
    slug: "home-bakery",
    short: "home bakery",
    page: "order page",
    room: "kitchen",
    rush: "Saturday morning",
    miss: "A home bakery's Saturday orders sit on one page. If that page is down, the cake goes to whoever answers first.",
    busy: "That is when the order page earns the week.",
    heavy: "The cake photos are the page.",
  },
  {
    label: "Coffee shop",
    slug: "coffee-shop",
    short: "coffee shop",
    page: "menu page",
    room: "shop",
    rush: "the morning rush",
    miss: "A coffee shop's regulars check the hours and the menu before they leave the house. If that page is down, they walk to the next one.",
    busy: "That is when someone decides whether to cross the road.",
    heavy: "The shop photos and the board are the page.",
  },
  {
    label: "Restaurant",
    slug: "restaurant",
    short: "restaurant",
    page: "pre-order page",
    room: "kitchen",
    rush: "Sunday collection",
    miss: "A restaurant's Sunday collection is booked on a page, not at the door. If that page is down, the slot stays empty.",
    busy: "That is the hour the pre-order page has to answer.",
    heavy: "The food photos are doing the selling.",
  },
  {
    label: "Dessert shop",
    slug: "dessert-shop",
    short: "dessert shop",
    page: "menu page",
    room: "shop",
    rush: "the weekend",
    miss: "A dessert shop takes family orders from the menu page. If it is down on a Saturday, they do not ring. They pick another till.",
    busy: "That is when a family is choosing before they go out.",
    heavy: "The dessert photos are the menu.",
  },
  {
    label: "Modest fashion",
    slug: "modest-fashion",
    short: "modest fashion shop",
    page: "collection page",
    room: "studio",
    rush: "a new drop",
    miss: "A modest fashion shop sells the drop from the collection page. If it is down on the night it goes live, the order happens somewhere else.",
    busy: "That is the hour the collection page is the shop.",
    heavy: "The lookbook is the page.",
  },
  {
    label: "Car hire",
    slug: "car-hire",
    short: "car hire firm",
    page: "booking page",
    room: "office",
    rush: "a wedding weekend",
    miss: "A car hire firm takes the wedding weekend on a booking page. If that page is down on Thursday, Friday is already too late.",
    busy: "That is when the booking page has to load before they ask someone else.",
    heavy: "The car photos are the booking page.",
  },
  {
    label: "Holiday let",
    slug: "holiday-let",
    short: "holiday let",
    page: "enquiry page",
    room: "office",
    rush: "booking week",
    miss: "A holiday let is chosen from the photos and the enquiry page. If the page is down, they book the next place.",
    busy: "That is when an enquiry has to go through before they pick another flat.",
    heavy: "The flat photos are the enquiry.",
  },
  {
    label: "Coaching",
    slug: "coaching",
    short: "coach",
    page: "booking page",
    room: "gap between sessions",
    rush: "a new enquiry",
    miss: "A coach's next client books from a page, not from a comment. If that page is down, the person who was ready does not wait.",
    busy: "That is when the booking page has to open on a phone.",
    heavy: "A long page of promises is still a slow page.",
  },
  {
    label: "Salon",
    slug: "salon",
    short: "salon",
    page: "booking page",
    room: "salon",
    rush: "Friday",
    miss: "A salon's Friday book fills up from the booking page. If it is down at lunch, the chair stays empty.",
    busy: "That is when someone is trying to grab the last appointment.",
    heavy: "The before-and-after photos are the booking page.",
  },
  {
    label: "Takeaway",
    slug: "takeaway",
    short: "takeaway",
    page: "menu page",
    room: "shop",
    rush: "Friday night",
    miss: "A takeaway's Friday night starts on the menu page. If it is down at six, the order goes to the shop that loads.",
    busy: "That is the hour the menu page is the till.",
    heavy: "The dish photos are the menu.",
  },
  {
    label: "Florist",
    slug: "florist",
    short: "florist",
    page: "order page",
    room: "shop",
    rush: "a same-day order",
    miss: "A florist sells today from the order page. If it is down in the morning, they buy the bouquet from whoever answers.",
    busy: "That is when a same-day order has to go through.",
    heavy: "The bouquet photos are the order page.",
  },
  {
    label: "Trade business",
    slug: "trade-business",
    short: "trade business",
    page: "quote page",
    room: "van",
    rush: "an emergency",
    miss: "A plumber or electrician gets the emergency from a quote page as often as from a phone call. If the page is down, the job goes to the next van.",
    busy: "That is when the quote page has to open on a wet pavement.",
    heavy: "The job photos are the quote page.",
  },
];

const weeks = [
  {
    name: "The missed order",
    monday: (n) =>
      `${n.miss} I check that page every hour and say the fix out loud, so you hear it in the ${n.room} before a customer has to tell you.`,
    wednesday: (n) => `${n.miss} One sentence an hour is enough.`,
    thursday: (n) =>
      `The check is simple. Once an hour, the ${n.page} is opened. If it is down, slow to start, or too heavy, you get one sentence about what to fix. If it is fine, you get told it is up. There is no dashboard to log into.`,
  },
  {
    name: "When it is busy",
    monday: (n) =>
      `A ${n.short} can look fine in a quiet hour and still fail when ${n.rush} arrives. ${n.busy} You want to hear that while you can still fix it.`,
    wednesday: (n) => `When ${n.rush} arrives, the ${n.page} has to work. The quiet hours do not count.`,
    thursday: (n) =>
      `Slow to start means the server sat there before the first part of the page arrived. The site can still be "up" and feel broken on a phone. The hourly sentence says that in plain words, instead of handing you a chart.`,
  },
  {
    name: "The heavy page",
    monday: (n) =>
      `${n.heavy} That is what makes a ${n.short} look like itself, and it is also what makes the ${n.page} wait on a phone. When the page is heavy, the sentence says to cut it down.`,
    wednesday: (n) => `The photos are the point. They should not make the ${n.page} wait.`,
    thursday: (n) =>
      `A heavy page is one the phone has to download before anyone can read the ${n.page}. Photos are the usual reason. The fix I say out loud is to cache the page and cut the pictures down.`,
  },
  {
    name: "Say it out loud",
    monday: (n) =>
      `You should not have to open a laptop to know the ${n.page} is up. The hourly check can be read out in the ${n.room}. You hear that it is fine, or you hear the one fix.`,
    wednesday: (n) => `One sentence, out loud, in the ${n.room}. That is the whole report for a ${n.short}.`,
    thursday: (n) =>
      `The same hourly check can play on Alexa. You ask for your flash briefing and the ${n.short} is one of the sentences. It is for the person running the place, while they are still in the ${n.room}.`,
  },
];

function friday(niche) {
  return `If you run a ${niche.short} and people reach you through the ${niche.page}, I will check it once for free. Watching it every hour after that is £49 a month for the one site. Having that same check read out on Alexa is £150, once.`;
}

export function weekNumber(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  return Math.ceil(((copy - yearStart) / 86400000 + 1) / 7);
}

export function weekOf(date) {
  const index = (weekNumber(date) - 1) % weeks.length;
  const copy = new Date(date.getTime());
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  const label = copy.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  return { ...weeks[index], index, label };
}

export function nicheChoices() {
  return [ALL_NICHES, ...niches.map((niche) => niche.label)].join("\n");
}

export function findNiche(label) {
  const name = String(label || "").trim();
  if (!name || name === ALL_NICHES) return null;
  return niches.find((niche) => niche.label === name) || null;
}

export function nichePack(niche, date = new Date()) {
  const week = weekOf(date);
  const posts = [
    { day: "Monday", channel: "LinkedIn", text: week.monday(niche) },
    { day: "Wednesday", channel: "Instagram", text: week.wednesday(niche) },
    { day: "Thursday", channel: "LinkedIn", text: week.thursday(niche) },
    { day: "Friday", channel: "Facebook", text: friday(niche) },
  ];
  const lines = [
    niche.label,
    `Week of ${week.label}. Theme: ${week.name}.`,
    "Paste these yourself. This job does not post them.",
    "Use one niche this week. Leave out any shop's name and any shop's speed.",
    "Saturday and Sunday stay quiet.",
    "",
    ...posts.flatMap((post) => [`${post.day} · ${post.channel}`, post.text, ""]),
  ];
  return { niche, week, posts, text: `${lines.join("\n").trim()}\n` };
}

export function contentPack(label, date = new Date()) {
  const name = String(label || "").trim();
  const selected = name === ALL_NICHES ? niches : [findNiche(name)].filter(Boolean);
  if (!selected.length) throw new Error(`Pick a niche from the list. ${name || "Nothing"} is not on it.`);
  const packs = selected.map((niche) => nichePack(niche, date));
  const index = [
    `${packs.length} ${packs.length === 1 ? "niche" : "niches"} for the week of ${packs[0].week.label}.`,
    `Theme: ${packs[0].week.name}.`,
    "Post one niche this week. Keep the other files for later.",
    "Monday and Thursday are LinkedIn. Wednesday is Instagram. Friday is Facebook.",
    "",
    ...packs.map((pack) => `${pack.niche.label} -> ${pack.niche.slug}.txt`),
    "",
  ].join("\n");
  return { packs, index: `${index.trim()}\n` };
}

async function requestFromArgs(argv) {
  const [first, second] = argv.slice(2);
  if (!first) throw new Error("Pass a niche name, or a JSON file with niche.");
  if (first.endsWith(".json")) {
    const body = JSON.parse(await readFile(first, "utf8"));
    return { niche: body.niche, outDir: second || "content" };
  }
  return { niche: first, outDir: second || "content" };
}

async function main() {
  const request = await requestFromArgs(process.argv);
  const pack = contentPack(request.niche);
  await mkdir(request.outDir, { recursive: true });
  await writeFile(join(request.outDir, "index.txt"), pack.index);
  for (const item of pack.packs) {
    await writeFile(join(request.outDir, `${item.niche.slug}.txt`), item.text);
  }
  console.log(pack.index.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
