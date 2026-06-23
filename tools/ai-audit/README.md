# The Digital Signal

Free website benchmark tool. One audit per business. Results appear instantly.

## What Is Here Now

The dev environment for The Digital Signal. Everything in this folder is isolated from production — no change here touches the live site until you explicitly promote it.

**Files**
- `worker.js` — Cloudflare Worker: crawls the submitted URL via DataForSEO, runs positioning analysis, scores SEO on Anya's rubric, checks agent readiness, generates the Forward Signal via Claude, enforces one-per-email via KV, logs every run.
- `digital-audit.html` — standalone audit page that calls the dev worker. Open directly in a browser — no local server needed.
- `wrangler.toml` — deploy config for the dev worker (`sa-ai-audit-dev`). KV namespace `AUDITS` is bound and working.

**Agent readiness scoring** is rules-based, no external API. Baseline 40 (EMERGING). Points added for: `llms.txt` present (+20), robots.txt not blocking AI crawlers (+15), schema markup (+10), semantic headings (+10), meaningful text (+5). Cap 100. BASIC only below 40. Three verdict variants per level selected by SEO grade and page signals.

**Email gate + KV rate limiting.** ✅ Confirmed working. Every audit requires a valid email. The worker checks Cloudflare KV before running — same email gets a clean JSON error, not a second audit. Every successful run is logged to KV with email, URL, timestamp, SEO score, SEO grade, and agent readiness level.

**Forward Signal.** ✅ Built and tested. Claude generates a two-sentence observation identifying the highest-leverage opportunity the site is leaving on the table. Hard limit: two sentences, 400 characters. Sanitization strips em dashes, asterisks, and markdown formatting before the text is returned. Rendered in a blue card below Agent Readiness.

**Dev worker:** `https://sa-ai-audit-dev.saaudit.workers.dev`

**Deploy** from inside this folder:
```
npx wrangler deploy
```

**Test locally:** open `digital-audit.html` in a browser. Enter a work email and a website URL and click Run My Digital Signal.

---

## BEFORE PRODUCTION

Re-enable the email gate in worker.js before promoting to production. Set DEV_MODE to false or remove the flag entirely. The KV rate limiting check must be active on production to enforce one free Signal per email.

---

## What Needs To Happen Before Production

1. **Wire up Cloudflare KV namespace `AUDITS` in production.** The namespace is already bound in dev. Create a production namespace and add the real ID to the production wrangler config:
   ```
   npx wrangler kv namespace create AUDITS
   ```

2. **Add the Anthropic API key to production.** `ANTHROPIC_API_KEY` is set in dev and the Forward Signal is working. Set the secret in production before launch:
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

3. **Lock down CORS.** Change `ALLOW_ORIGIN` in `wrangler.toml` from `"*"` to `"https://skalatsky.com"`.

4. **Replace the audit section in `skalatsky.com/index.html`** with the final markup from `digital-audit.html`. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.

---

## How To Promote To Production

1. Deploy to the production worker from inside this folder:
   ```
   npx wrangler deploy --name sa-ai-audit
   ```

2. Replace the audit section in `skalatsky.com/index.html` with the final markup from `digital-audit.html`.

3. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.

4. Verify all sections render correctly end-to-end: positioning tags and verdict, SEO grade and four findings, agent readiness level and verdict, Forward Signal card.
