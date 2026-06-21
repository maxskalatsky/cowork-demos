# The Digital Signal

Free website benchmark tool. One audit per business. Results appear instantly.

## What Is Here Now

The dev environment for The Digital Signal. Everything in this folder is isolated from production — no change here touches the live site until you explicitly promote it.

**Files**
- `worker.js` — Cloudflare Worker: crawls the submitted URL via DataForSEO, runs positioning analysis, scores SEO on Anya's rubric, checks agent readiness, enforces one-per-email via KV, logs every run.
- `digital-audit.html` — standalone audit page that calls the dev worker. Open directly in a browser — no local server needed.
- `wrangler.toml` — deploy config for the dev worker (`sa-ai-audit-dev`). KV namespace `AUDITS` is stubbed here; bind it after creating the namespace.

**Agent readiness scoring** is rules-based, no external API. Baseline 40 (EMERGING). Points added for: `llms.txt` present (+20), robots.txt not blocking AI crawlers (+15), schema markup (+10), semantic headings (+10), meaningful text (+5). Cap 100. BASIC only below 40.

**Email gate + KV rate limiting.** Every audit requires a valid email. The worker checks Cloudflare KV before running — same email gets a clean error, not a second audit. Every successful run is logged to KV with email, URL, timestamp, and scores.

**Build the Product section** is hidden pending spec. The card and section label are `display:none` in the HTML. Do not remove them — they will be enabled when the section is defined.

**Dev worker:** `https://sa-ai-audit-dev.saaudit.workers.dev`

**Deploy** from inside this folder:
```
npx wrangler deploy
```

**Test locally:** open `digital-audit.html` in a browser. Fill in all three questions, a work email, and a website URL.

---

## What Needs To Happen Before Production

1. **Wire up Cloudflare KV namespace `AUDITS`** for rate limiting and audit logging. Already stubbed in `wrangler.toml`. Create the namespace and add the real ID:
   ```
   npx wrangler kv namespace create AUDITS
   ```
   Then update `wrangler.toml` with the returned ID. Verify email rate limiting is working end-to-end before launch — run the same email twice and confirm the second request returns the limit message.

2. **Spec and build the Build the Product section.** Pending definition. Do not launch without it. The card is hidden in the HTML but the `capability` object is already returned by the worker when `ANTHROPIC_API_KEY` is set.

3. **Lock down CORS.** Change `ALLOW_ORIGIN` in `wrangler.toml` from `"*"` to `"https://skalatsky.com"`.

4. **Add the Anthropic API key** and set `FINDINGS_MODE = "llm"` to activate Claude-polished findings and the digital capability assessment:
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

5. **Add a valid Cloudflare API token** if reinstating the URL Scanner path for agent readiness scoring:
   ```
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   ```
   Token needs URL Scanner read and write permissions on account `9d33c8a45a0c3b125d36bd7fd5ff224e`.

6. **Replace the audit section in `skalatsky.com/index.html`** with the final markup from `digital-audit.html`. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.

---

## How To Promote To Production

1. Deploy to the production worker from inside this folder:
   ```
   npx wrangler deploy --name sa-ai-audit
   ```

2. Replace the audit section in `skalatsky.com/index.html` with the final markup from `digital-audit.html`.

3. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.

4. Verify all sections render correctly end-to-end: positioning tags and verdict, SEO grade and four findings, agent readiness level and meter. Confirm the Build the Product section does not render.
