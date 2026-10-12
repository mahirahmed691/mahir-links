# Site status

Hourly probes of the live sites, published as an [Alexa Flash Briefing](https://developer.amazon.com/en-US/docs/alexa/flashbriefing/flash-briefing-skill-api-feed-reference.html) feed.

`sites.json` is the list this job checks. It is a copy of the portfolio URL plus every live entry in the parent `links.json` `businesses.items` list. Parked or disabled work (Ceevie) is left out. A later change can generate this file from `links.json` so there is one source of truth. That generator is not wired up yet.

## Commands

```bash
npm test
npm run check
```

`npm run check` writes:

- `public/status.json` — one object per site
- `public/alexa.json` — the Flash Briefing feed
- `public/index.html` — the same result as a page

A site that is down is recorded in the feed. It does not fail the command. Alexa needs a fresh file either way.

## GitHub Actions

`.github/workflows/site-status.yml` runs at minute 17 of every hour. On `main` it uploads `public/` as the `site-status-feed` artifact.

GitHub Pages cannot host that feed. The repository is private, and enabling Pages returns: "Your current plan does not support GitHub Pages for this repository." Alexa needs a public HTTPS URL, so the feed still has to be served from the live site (`https://www.mahirahmed.link/alexa.json`) or the repository has to be public before Pages can be turned on.

## Alexa

1. Open the Alexa developer console and create a Flash Briefing skill.
2. Add a text feed whose URL is the `alexa.json` address above.
3. Set the preamble to `In site status` (Amazon requires a short preamble that starts with "In" or "From").
4. The feed is a JSON array. Each item has `uid`, `updateDate`, `titleText`, `mainText`, and `redirectionUrl`.

Alexa caches the feed and ignores items older than 7 days. The hourly job refreshes `updateDate` and `uid`.

## Rollback

`vercel.json` sets `ignoreCommand` to `bash site-status/scripts/vercel-ignore.sh`. Vercel skips its own rebuild when a commit only touches this directory or the workflow file. The portfolio deploy workflow ignores those same paths, so a status-only push does not ship a new production build.

This directory, `.github/workflows/site-status.yml`, the path filters on the existing workflows, and that `ignoreCommand` line are the whole addition. Reverting that commit removes it.
