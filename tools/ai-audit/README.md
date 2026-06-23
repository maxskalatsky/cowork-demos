# The Digital Signal

Free website benchmark tool. One audit per business. Results appear instantly.

## What Is Here Now

The dev environment for The Digital Signal. Everything in this folder is isolated from production — no change here touches the live site until you explicitly promote it.

**Files**

- `worker.js` — Cloudflare Worker orchestrator: routing, KV logging, email gate, one-free-Signal enforcement. Imports from the four modules below.
- `fetch.js` — All page fetching: raw fetch, Scrapfly fallback (blocked/bot-protected sites), Browser Rendering fallback (JS-heavy/thin HTML). Also exports DataForSEO on-page and backlinks calls.
- `scorer.js` — Positioning scoring, SEO scoring, agent readiness scoring, findings report builder.
- `verdicts.js` — Full verdict text library: positioning verdicts, agent readiness variants, SEO grade titles and descriptions.
- `signals.js` — All Claude API calls: business type inference, Forward Signal generation, Compare Signal enrichment, optional LLM polish of findings.
- `digital-audit.html` — Standalone audit page that calls the dev worker. Open directly in a browser — no local server needed.
- `wrangler.toml` — Deploy config for the dev worker (`sa-ai-audit-dev`). KV namespace `AUDITS` is bound and working.

---

## Product Features

**Email gate + KV rate limiting.** Every audit requires a valid email. The worker checks Cloudflare KV before running — same email gets a clean JSON error, not a second audit. Every successful run is logged to KV with email, URL, timestamp, SEO score, SEO grade, and agent readiness level.

**Known brand check.** Globally recognized brands (Nike, Apple, ESPN, etc.) are matched against a hardcoded set in `worker.js`. If matched, the worker returns a clean JSON message explaining the tool is designed for private and growth-stage businesses, without running an audit. No email required for this check.

**Page fetch cascade.** Three tiers:
1. Raw fetch — fast, no API cost.
2. Scrapfly (`asp=true`, `render_js=true`) — fires on HTTP 403/429/503 or when the response body is a challenge/block page. Requires `SCRAPFLY_API_KEY` secret.
3. Browser Rendering (Cloudflare Puppeteer) — fires for JS-heavy or thin-HTML pages not blocked by bots.

**Position the Brand section.** Three tags (THE HOOK, THE FIT, THE RELEVANCE) plus a one-sentence verdict from the verdict library. Left border color green/yellow/red. If a disqualifier is detected, shows a TRUST KILLER tag instead.

**SEO Readiness section.** Letter grade (A–F with +/− modifier), title, description, and four findings tiles in a two-by-two grid.

**Agent Readiness section.** Four levels (ADVANCED / CAPABLE / EMERGING / BASIC) with a verdict line selected from three variants per level based on SEO grade and page signals. No business name in any verdict. All verdicts written in second person.

**The Forward Signal.** Claude generates a two-sentence observation identifying the highest-leverage opportunity the site is leaving on the table. Hard limit: two sentences, 400 characters. Sanitization strips em dashes, asterisks, and markdown formatting. Rendered in a blue card below Agent Readiness. If the API call fails, the card does not render.

**Compare mechanic.** After an audit completes, the user can enter a site they admire. The worker fetches and scores that site, then calls Claude to produce a new Forward Signal that directly references what the admired site does well and how the user can apply the same move. The comparison card shows a side-by-side table across five dimensions (THE HOOK, THE FIT, THE RELEVANCE, SEO GRADE, AGENT READINESS). Outcome branches: if the admired site is ahead, the CTA reads "Beat them. Talk to S&A."; if the user is already ahead, it reads "Stay ahead. Talk to S&A." The compare input box is removed from the DOM after the comparison runs.

**Business type inference.** Before scoring positioning, Claude classifies the site (platform, SaaS, agency, consultancy, e-commerce, etc.) and identifies its audience and purpose. This context is passed to both positioning scoring and the Forward Signal to avoid penalizing platforms for not having a human-facing homepage.

---

## Secrets Required

| Secret | Used For |
|---|---|
| `DATAFORSEO_LOGIN` | DataForSEO on-page crawl |
| `DATAFORSEO_PASSWORD` | DataForSEO on-page crawl |
| `ANTHROPIC_API_KEY` | Forward Signal, Compare Signal, business type inference |
| `SCRAPFLY_API_KEY` | Scrapfly fallback fetch for bot-protected sites |

Set each via:
```
npx wrangler secret put <SECRET_NAME> --name sa-ai-audit-dev
```

---

## DEV_MODE Flag

`worker.js` contains:

```js
const DEV_MODE = true;
```

When `true`, the KV email gate is bypassed — the same email can run multiple audits. This is intentional for dev/testing. **Set `DEV_MODE = false` before promoting to production.** The KV rate limiting must be active in production to enforce one free Signal per email.

---

## Dev worker

`https://sa-ai-audit-dev.saaudit.workers.dev`

**Deploy** from inside this folder:
```
npx wrangler deploy
```

**Test locally:** open `digital-audit.html` in a browser. Enter a work email and a website URL and click Show Me My Signal.

---

## Before Production

1. **Set `DEV_MODE = false` in `worker.js`.** The KV email gate must be active in production.

2. **Wire up Cloudflare KV namespace `AUDITS` in production.** The namespace is already bound in dev. Create a production namespace and add the real ID to the production wrangler config:
   ```
   npx wrangler kv namespace create AUDITS
   ```

3. **Add all secrets to production.** `ANTHROPIC_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, and `SCRAPFLY_API_KEY` must all be set on the production worker.

4. **Lock down CORS.** Change `ALLOW_ORIGIN` in `wrangler.toml` from `"*"` to `"https://skalatsky.com"`.

5. **Replace the audit section in `skalatsky.com/index.html`** with the final markup from `digital-audit.html`. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.

6. **Business type inference validation.** Confirm classification is accurate for the range of site types expected in production — platform/SaaS sites should not be penalized for positioning signals that only apply to service businesses.

---

## How To Promote To Production

1. Deploy to the production worker from inside this folder:
   ```
   npx wrangler deploy --name sa-ai-audit
   ```

2. Replace the audit section in `skalatsky.com/index.html` with the final markup from `digital-audit.html`.

3. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.

4. Verify all sections render correctly end-to-end: positioning tags and verdict, SEO grade and four findings, agent readiness level and verdict, Forward Signal card, Compare mechanic.
