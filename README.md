# Link-in-bio on Vercel

A self-hosted Linktree alternative. Your links live in `links.json`, a zero-dependency Node script renders a static page, GitHub Actions validates and ships it to Vercel through a preview first, and a scheduled monitor watches it.

## Set up (once)

The site is hosted on Vercel (project `mahir-links`, live at https://mahir-links.vercel.app). GitHub holds the code and runs the pipeline.

1. Create a GitHub repo and push these files.
2. In Vercel, create a token (**Account Settings → Tokens**) and note your team and project IDs (**Project → Settings → General**).
3. In the project's **Settings → Deployment Protection**, create a **Protection Bypass for Automation** secret so the pipeline can smoke-test protected previews.
4. In GitHub, add repository secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `VERCEL_AUTOMATION_BYPASS_SECRET`.
5. Protect `main` (**Settings → Branches**): require a pull request and the `CI / stage` check.
6. Optional: add required reviewers to the `production` environment (**Settings → Environments**) for a manual approval between preview and production.
7. In Vercel, open **Analytics** and click **Enable** to start recording visits and clicks.

Don't also connect the repo through Vercel's Git integration: that would deploy every push a second time, outside this pipeline.

## Edit your links

Everything is in `links.json`:

| Field | Required | Notes |
|---|---|---|
| `profile.name` | yes | Page title and heading |
| `profile.bio` | no | One or two sentences |
| `profile.avatar` | no | `assets/me.jpg` (commit the file) or an `https://` URL. Initials are shown if empty |
| `profile.hats` | no | Short labels shown as pills under your name |
| `profile.sticker` | no | Short text or emoji on the sticker that slaps onto your avatar |
| `profile.clock` | no | `city`, IANA `timezone`, a `fallback` line for no-JS, and `moods`: `{from, to, text}` by local hour (ranges can wrap past midnight) |
| `links[].title` | yes | Button text |
| `links[].tag` | no | Small yellow label on the button, e.g. `Free PDF` |
| `links[].url` | yes | `https://` or `mailto:` only; duplicates are rejected |
| `links[].description` | no | Second line under the title |
| `links[].featured` | no | Fills the button with your accent colour |
| `links[].enabled` | no | `false` hides a link without deleting it |
| `socials[]` | no | `label` and `url`, shown as a text row |
| `theme.accent` | no | 6-digit hex. The whole palette (paper, ink, borders, dark mode) is derived from it |
| `theme.pop` | no | 6-digit hex for stickers and tags (default `#FFD23F`) |
| `availability` | no | `enabled`, `text`, `status` (`open`, `limited` or `closed`), optional `url`. A pill above your links, e.g. "Booking projects for November" |
| `businesses.items[].badgeUntil` | no | Date the badge stops showing, e.g. `2026-10-25`. Hidden in the browser after that date, no redeploy needed |
| `businesses.items[].appStore` | no | An `https://apps.apple.com/` link; adds a "Get it on the App Store" button, tracked as its own click |
| `businesses.items[].alsoOn` | no | A second place to find it, shown as "Also on the …", e.g. `iOS App Store` |
| `businesses.items[].imageFit` / `imageBg` | no | `contain` shows a tall image (like a phone screenshot) whole instead of cropping; `imageBg` is the hex colour around it |
| `businesses.items[].image` | no | Screenshot URL or a repo file. Shown on the card, lazy-loaded; if it ever fails to load, the card quietly falls back to its plain layout |
| `analytics.vercel` | no | `true` loads Vercel Web Analytics (enable it in the Vercel dashboard first) and sends a `Link click` event for every link |
| `analytics.goatcounter` | no | Your GoatCounter site code, enables page views and per-link click counts |
| `businesses.title` | with businesses | Section heading |
| `businesses.more` | no | `label` and `url` for the link beside the heading |
| `businesses.items[]` | with businesses | `name`, `url`, `status` (`Live`, `In build` or `Parked`), optional `icon` (emoji), `description`, `kind`, `stack`, `enabled` |

The line under the heading is written from the data ("Six live. Sakinah and Motiv are still in the oven."), so it stays true as statuses change. Business cards sort Live first, then In build, then Parked, keeping your order within each group. Live cards show their domain. For anything not live yet, point `url` at its page on the studio site so the link checker doesn't flag a domain that isn't up.

## QR code

`npm run qr` writes `assets/qr.svg`, pointing at your site with `?utm_source=qr` so visits from print show up separately in analytics. SVG scales cleanly to any print size. Test-scan it before printing.

## Pipeline

```
PR opened ──► CI
              validate → build → check every outbound link → upload build artifact
                                          │ blocks merge on failure
merge to main ──► Deploy
                  stage:   build → deploy Vercel preview → smoke test the preview
                  promote: promote that same preview to production → smoke test the live site

every 6h ──► Monitor
             uptime + drift (live SHA == main SHA) + outbound links → opens/updates/closes an issue
```

Production only ever receives a deployment that already passed on an identical preview. The smoke test checks that `/version.json` reports the exact commit, so a stale cache or a wrong promote fails loudly instead of silently.

The deploy job deliberately skips the external link check, so a third-party site being down can never block a deploy or a rollback.

## Share image

`assets/og.png` is the 1200×630 card shown when the link is shared on WhatsApp, LinkedIn, iMessage and so on. It's rendered from `dist/og.html`, which the build generates from your name, hats and business count. After changing those, run `npm run og` and commit the new PNG.

## Runbook

**Bad change is live (fastest, seconds)**

Vercel dashboard → `mahir-links` → **Deployments** → the last good one → **⋯ → Instant Rollback**. No rebuild. Then fix forward with `git revert <bad-sha>` in a PR. Until that merges, the monitor reports drift on purpose, so the rollback isn't forgotten.

**Bad change is live (through the pipeline)**

Actions → **Deploy** → **Run workflow**, with `ref` set to the last good commit. It goes through the same preview and smoke test as any deploy.

**Monitor issue opened**

- *Uptime failed:* check https://www.vercel-status.com, then the latest Deploy run.
- *Drift (live SHA differs from main):* the last Deploy failed, or a rollback is still in place. Re-run Deploy, or revert on main.
- *Link check failed:* the issue lists the broken URLs. Fix them, or set `"enabled": false` in `links.json`, via a PR.

The issue closes itself on the next passing run.

**Slack alerts (optional):** create an incoming webhook for a channel (Slack → **Apps** → **Incoming Webhooks**) and save its URL as the `SLACK_WEBHOOK_URL` repository secret. The monitor then posts once when an incident opens and once when it recovers, not every six hours.

**What's live?** `curl -s https://mahir-links.vercel.app/version.json`

## Stats dashboard (GoatCounter)

Vercel's free plan records page views but not custom events, so clicks and shares go to GoatCounter as well. Set `analytics.goatcounter` to your site code and the dashboard at `https://<code>.goatcounter.com` shows views, referrers, countries and devices, plus:

- `click/<link>`: every link, business card and social, e.g. `click/karv-d`
- `share/<from>/<method>`: every share, e.g. `share/motiv/whatsapp`, `share/page-header/native`

No cookies and no personal data, so no consent banner is needed.

## Private admin page (/admin)

`https://<site>/admin` shows visitors, link clicks, shares, a per-business leaderboard, share platforms, referrers, countries and screen sizes for today, 7 days or 30 days. It's rendered on the server by `functions/admin.mjs` (a Vercel function), so your GoatCounter key never reaches the browser.

Setup, once, in Vercel → Project → Settings → Environment Variables (Production):

- `ADMIN_PASSWORD`: the page password. Any username works at the prompt.
- `GOATCOUNTER_TOKEN`: a GoatCounter API key (GoatCounter → your name → API → New API key, with read permissions only).

Then redeploy so the function picks them up. Without them the page explains what's missing instead of failing. Wrong passwords are slowed down, and the page is never cached or indexed.

GoatCounter's API can trail live traffic by up to two hours; its own dashboard is more current.

## Sharing

Every business card has a share button, and so does the page itself. On phones it opens the native share sheet (Instagram, WhatsApp, Messages and any installed app). On desktop it opens a menu with WhatsApp, X, LinkedIn, Facebook, Email and Copy link. Cards share the business's own URL, so the preview people see is that business's own image and description.

Each share is recorded as a `Share` event with `from` (the business, or `page-header` / `page-minibar`) and `method` (`native`, `whatsapp`, `x`, `linkedin`, `facebook`, `email` or `copy`).

## Analytics: who clicked what, and from where

With `analytics.vercel: true`, every page view is recorded with the visitor's country, device, browser and the site that referred them. Every click sends a `Link click` event with two fields: `link` (for example `karv-d`, `read-the-blog`, `linkedin`) and `section` (`links`, `businesses` or `socials`). Taps on Share send a `Share` event.

It's cookieless and doesn't identify individuals: you see counts by country and source, not who someone is.

Instagram, TikTok and some other apps hide where visitors came from. To see those, share a tagged link in each place, e.g. `https://mahir-links.vercel.app/?utm_source=instagram`, and results can be broken down by `utmSource`.

Only production traffic is recorded; previews aren't.

## Observability

- **Metrics:** GoatCounter page views and per-link clicks (set `analytics.goatcounter`). Free, cookie-free, no consent banner needed.
- **Logs:** every CI, Deploy and Monitor run keeps its logs and a step summary in the Actions tab.
- **Traces:** not applicable to a static page with no backend; the deploy trail (commit → build → deploy → verify) plays that role, and each run is linked from the monitor issue.
- **Alerts:** the monitor issue notifies anyone watching the repo. Turn on GitHub notifications for issues, or add a Slack/email integration on the `monitor` label.

## Files

```
links.json                   your content (the only file you normally touch)
assets/                      avatar and any other images
scripts/build.mjs            validation + static site generator, no dependencies
scripts/smoke.sh             health and exact-commit check (works on protected previews)
vercel.json                  security headers and caching rules
assets/og.png                share image, regenerated with `npm run og`
lychee.toml                  link checker config (sites that block bots are excluded)
.github/workflows/ci.yml     stage: PR validation and preview
.github/workflows/deploy.yml stage and prod on Vercel: preview, smoke test, promote, smoke test
.github/workflows/monitor.yml scheduled uptime, drift and link checks
.github/dependabot.yml       keeps the Actions versions current
```
