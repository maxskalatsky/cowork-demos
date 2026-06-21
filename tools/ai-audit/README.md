# S&A Digital Audit Tool

## What Is Here Now

The dev environment for the S&A Digital Audit tool. Everything in this folder is isolated from production — no change here touches the live site until you explicitly promote it.

**Files**
- `worker.js` — Cloudflare Worker that crawls a submitted URL via DataForSEO, scores it on Anya's SEO rubric, runs agent readiness checks, and returns a JSON report.
- `digital-audit.html` — standalone audit page that calls the dev worker. Open it directly in a browser — no local server needed.
- `wrangler.toml` — deploy config pointing at the dev worker (`sa-ai-audit-dev`).

**Agent readiness scoring** is rules-based and runs entirely from signals fetched directly from the target site — no external API required. Baseline is 40 (EMERGING). Points are added for: `llms.txt` present (+20), robots.txt not blocking known AI crawlers (+15), schema markup (+10), semantic heading structure (+10), meaningful plain-text content (+5). Cap is 100. BASIC only shows when the score falls below 40.

**Dev worker:** `https://sa-ai-audit-dev.saaudit.workers.dev`

**Deploy** from inside this folder:
```
npx wrangler deploy
```

**Test locally:** open `digital-audit.html` in a browser. It calls the live dev worker and returns real audit results with no server setup.

---

## What Needs To Happen Before Production

1. **Wire up Cloudflare URL Scanner.** Create a Cloudflare API token with URL Scanner read and write permissions scoped to account `9d33c8a45a0c3b125d36bd7fd5ff224e`. Set it as a worker secret:
   ```
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   ```
   The worker currently uses the rules-based scorer because no valid token exists. Restoring the CF URL Scanner path requires the token and updating `scoreAgentReadiness` back to the API version.

2. **Lock down CORS.** Change `ALLOW_ORIGIN` in `wrangler.toml` from `"*"` to `"https://skalatsky.com"` before deploying to production.

3. **Add the Anthropic API key** to activate LLM polish mode:
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

4. **Switch findings mode to LLM.** In `wrangler.toml`, set `FINDINGS_MODE = "llm"`. This hands the four findings to Claude for site-specific rewriting after the rules pass runs.

5. **Verify scores before flipping production.** Run audits against several real sites from the dev worker and confirm the report sections render correctly — SEO grade, all four findings, agent readiness level, positioning check, and digital capability assessment.

---

## How To Promote To Production

1. **Deploy worker to production.** From inside this folder, deploy using the production worker name:
   ```
   npx wrangler deploy --name sa-ai-audit
   ```

2. **Update skalatsky.com.** Replace the audit section in `skalatsky.com/index.html` with the final markup from `digital-audit.html`.

3. **Point the production page at the production worker.** In the production `index.html`, update `SA_WORKER_URL` to:
   ```
   https://sa-ai-audit.saaudit.workers.dev
   ```

4. **Push to production and verify.** Confirm all three report sections render correctly end-to-end: SEO grade and four findings, agent readiness level and meter, positioning and digital capability cards.
