# The Digital Signal

Free website benchmark tool. One audit per business. Results appear instantly.

## What Is Here Now

The dev environment for The Digital Signal. Everything in this folder is isolated from production — no change here touches the live site until you explicitly promote it.

**Files**

- `worker.js` — Cloudflare Worker orchestrator: routing, KV logging, email gate, one-free-Signal enforcement, dual-mode classification via `classifyEntity()`. Imports from all five modules below.
- `fetch.js` — All page fetching: raw fetch, Scrapfly fallback (blocked/bot-protected sites), Browser Rendering fallback (JS-heavy/thin HTML). Also exports DataForSEO on-page and backlinks calls.
- `scorer.js` — Private company scoring pipeline (positioning, SEO, agent readiness, findings) and enterprise scoring pipeline (`scoreEnterprise()` with four dimensions). Re-exports `resolveProfile` and `resolveCompareProfile` from `profiles.js`.
- `profiles.js` — Single source of truth for all twelve scoring profiles. Exports `resolveProfile(userContext)` and `resolveCompareProfile(primaryProfile)`.
- `verdicts.js` — Full verdict text library: positioning verdicts, agent readiness variants, SEO grade titles and descriptions.
- `signals.js` — All Claude API calls: business type inference, Forward Signal generation, enterprise benchmark signal generation, Compare Signal enrichment, optional LLM polish of findings.
- `digital-audit.html` — Standalone audit page that calls the dev worker. Open directly in a browser — no local server needed. Handles both private company and enterprise render paths. Contains the three-question intake form.
- `wrangler.toml` — Deploy config for the dev worker (`sa-ai-audit-dev`). KV namespace `AUDITS` is bound and working.

---

## Three-Question Intake Form

Before submitting, users answer three intake questions that drive profile routing:

**Question 1 — Company type (radio, required):**
- Small or growing business → `small_growing`
- Established or mid-market company → `midmarket_regional`
- Large national or global brand → `large_national_global`
- Nonprofit or mission-driven organization → `nonprofit_gov_media`

**Question 2 — Who visits this site (checkbox, at least one required):**
- Cold prospects → `cold_prospects`
- Existing clients or customers → `existing_clients`
- Investors or board members → `investors`
- Potential hires → `talent`

**Question 3 — What this site needs to do (checkbox, at least one required):**
- Generate leads or inquiries → `generate_leads`
- Build authority and credibility → `build_authority`
- Serve existing relationships → `serve_relationships`
- Inform or educate → `inform_educate`

The Submit button is disabled until all five conditions pass: valid email format, non-empty URL, Q1 radio selected, Q2 at least one checkbox, Q3 at least one checkbox. Custom pill-card indicators are visible at all times (circular for radio, square for checkbox). Values are passed to the worker as `entityType`, `primaryVisitor[]`, and `siteGoal[]` in the request body.

---

## Twelve-Profile Routing System (`profiles.js`)

`resolveProfile(userContext)` maps the three intake answers to one of twelve named profiles. Each profile defines dimension weights (summing to 100) and a calibration block.

| Profile | Weights (pos / seo / agent) | Baseline Grade | Authority Reduced | Hook Critical |
|---|---|---|---|---|
| `smb_lead_gen` | 50 / 30 / 20 | C | yes | yes |
| `smb_authority` | 30 / 40 / 30 | C | yes | no |
| `smb_mixed` | 40 / 35 / 25 | C | yes | no |
| `mid_lead_gen` | 40 / 40 / 20 | B | no | yes |
| `mid_authority` | 25 / 45 / 30 | B | no | no |
| `mid_client_service` | 20 / 40 / 40 | B | no | no |
| `mid_mixed` | 25 / 45 / 30 | B | yes | no |
| `enterprise_benchmark` | 20 / 40 / 40 | A | no | no |
| `nonprofit_inform` | 20 / 35 / 45 | C | yes | no |
| `nonprofit_leads` | 35 / 40 / 25 | C | yes | no |
| `competitor_smb` | 40 / 35 / 25 | C | yes | no |
| `competitor_enterprise` | 20 / 40 / 40 | A | no | no |

**Calibration fields applied at scoring time:**

- **`seoBaselineGrade`** — If the raw SEO grade is below the baseline and fewer than two hard failures are present (missing canonical, not HTTPS, broken page, load time > 5s), the grade is lifted to the baseline. Ensures a mid-market firm is not penalized to C for minor issues when a C-grade outcome is not meaningful in that context.
- **`authorityPenaltyReduced`** — If true and the authority band is "critical", it is treated as "weak" instead. Small businesses and nonprofits are not expected to have a competitive backlink profile.
- **`hookFailureIsCritical`** — If false and the positioning hook is missing, the card color is softened from red to yellow. A missing hook is not a critical failure for profiles where cold conversion is not the primary goal.
- **Dimension weights** — Passed into the Forward Signal system prompt so Claude leads with the highest-priority dimension for this profile type.

**Routing rules:**
- `large_national_global` → `enterprise_benchmark`
- `nonprofit_gov_media` + `inform_educate` goal → `nonprofit_inform`
- `nonprofit_gov_media` (other goals) → `nonprofit_leads`
- `small_growing` + only `cold_prospects` visitors + only `generate_leads` goal → `smb_lead_gen`
- `small_growing` + only `build_authority` goal → `smb_authority`
- `small_growing` (other) → `smb_mixed`
- `midmarket_regional` + only `cold_prospects` + only `generate_leads` → `mid_lead_gen`
- `midmarket_regional` + `build_authority` + `investors` visitors → `mid_authority`
- `midmarket_regional` + `existing_clients` + `serve_relationships` → `mid_client_service`
- `midmarket_regional` (other) → `mid_mixed`
- Default fallback → `smb_mixed`

`resolveCompareProfile(primaryProfile)` returns `competitor_enterprise` for enterprise profiles and `competitor_smb` for all others.

---

## Dual-Mode Scoring Architecture

Every URL submitted routes through `classifyEntity()` in `worker.js` **before any scoring runs**. This is a Claude Haiku call that returns `"private_company"` or `"known_brand"`. On any API failure it defaults to `"private_company"`.

### Mode 1 — Private Company Path

1. Crawl via `dataForSeoOnPage()` + `fetchAgentSignals()`
2. `scoreSeo()` → integer score (0–100)
3. `letterFromScore()` → clean single letter grade (A / B / C / D / F — no `+` or `−` modifiers)
4. Profile resolved from `userContext` via `resolveProfile()` inside `buildRulesReport()`
5. `inferBusinessType()` → business context for positioning and Forward Signal
6. `scoreAgentReadiness()` → level + verdict line
7. `buildRulesReport()` → four findings tiles, profile calibration applied (grade baseline, authority override)
8. `scorePositioning()` → hook / fit / relevance tags + verdict; `hookFailureIsCritical` override applied in `worker.js`
9. `getForwardSignal()` → three-sentence Claude observation, profile weights in system prompt
10. Returns: `seoGrade`, `seoScore`, `findings`, `agentLevel`, `agentLine`, `positioning`, `forwardSignal`

Front end renders: **Position the Brand**, **SEO Readiness**, **Agent Readiness**, **The Forward Signal**, **Compare mechanic**.

**userContext extraction:** The worker wraps userContext construction in a try-catch. If fields are missing or malformed, it falls back to `{entityType: 'small_growing', primaryVisitor: ['cold_prospects'], siteGoal: ['generate_leads']}` and continues the audit without failing.

### Mode 2 — Enterprise / Known Brand Path

Fires for publicly traded companies, Fortune 1000, major media and sports properties, government entities, utilities, and globally recognized consumer brands. Also fires when Q1 = Large national or global brand.

1. Crawl via `fetchAgentSignals()` (DataForSEO attempted, degrades gracefully)
2. `scoreEnterprise()` → four dimensions, each rated tier 1–5
3. `getEnterpriseBenchmarkSignal()` → three-sentence benchmark observation framed for private operators studying this brand
4. Returns: `entityType: "known_brand"`, `brandAuthority`, `audienceClarity`, `aiVisibility`, `contentDepth`, `forwardSignal`

Front end renders: **Brand Authority**, **Content Depth**, **AI Visibility**, **Audience Clarity**, **The Forward Signal**. Section labels update dynamically. No compare mechanic in enterprise mode.

#### Enterprise Dimension Scoring (`scoreEnterprise()` in `scorer.js`)

All four dimensions return tier 1 (Dominant) through tier 5 (Minimal):

| Dimension | Baseline Approach | Key Signals |
|---|---|---|
| **Brand Authority** | Starts at 8 (Dominant), deducts for failures | No JSON-LD −2, not HTTPS −4, no canonical −1, no description −1 |
| **Audience Clarity** | Additive from 0 | Link count, h2 count, content-type keyword diversity (works for consumer media and B2B) |
| **AI Visibility** | Additive from 0 | llms.txt, AI crawler access, JSON-LD, FAQ/Article schema, H1/H2, word count |
| **Content Depth** | Additive from 0 | Content section paths (/news, /video, /scores), link count breadth, h2 count, word count |

**Brand Authority uses a penalize-from-baseline approach.** Dominant is the expected default for any functioning known brand. Only hard observable failures drop the score.

**Audience Clarity uses content-type diversity**, not B2B audience pattern matching, so consumer media brands like ESPN score correctly.

**Content Depth measures section path presence and link breadth** rather than home-page word count alone, which unfairly penalizes large sites whose home page is a lightweight shell.

#### Enterprise Tier Labels

| Tier | Label | CSS Variable | Hex |
|---|---|---|---|
| 1 | Dominant | `--signal-tier-1` | `#1F6B4E` |
| 2 | Strong | `--signal-tier-2` | `#3A9E72` |
| 3 | Moderate | `--signal-tier-3` | `#4A9E8F` |
| 4 | Limited | `--signal-tier-4` | `#7AABB8` |
| 5 | Minimal | `--signal-tier-5` | `#9BAEBB` |

---

## Five-Tier Color Progression System

All scoring badges, pills, grade rings, and agent readiness badges use a five-tier color system declared as CSS custom properties on `#sa-audit`. No legacy mustard or gold colors remain.

```css
--signal-tier-1: #1F6B4E;  /* Dominant / A / ADVANCED / OPTIMIZED */
--signal-tier-2: #3A9E72;  /* Strong   / B / CAPABLE              */
--signal-tier-3: #4A9E8F;  /* Moderate / C / EMERGING / PARTIAL   */
--signal-tier-4: #7AABB8;  /* Limited  / D / LIMITED              */
--signal-tier-5: #9BAEBB;  /* Minimal  / F / BASIC / NOT READY    */
```

JavaScript constants `T1` through `T5` mirror these values. Maps `GC`, `AC`, and `STATUS` in the render script map every grade letter, agent level, and findings status to the correct tier constant. All badge and pill text renders white (`#fff`).

---

## Known Brand Intercept — Removed

Both the `worker.js` early-exit intercept and the `digital-audit.html` front-end redirect block have been **fully removed**. Every URL submitted now reaches the full audit pipeline. Known brands are routed to the enterprise path by `classifyEntity()` — they receive scored results, not a redirect message.

---

## Product Features

**Email gate + KV rate limiting.** Every audit requires a valid email. The worker checks Cloudflare KV before running — same email gets a clean JSON error, not a second audit. Every successful run is logged to KV.

**Three-question intake.** Users classify the site before submitting. Answers drive profile routing and calibration. The Submit button is disabled until all five fields pass validation.

**Page fetch cascade.** Three tiers:
1. Raw fetch — fast, no API cost.
2. Scrapfly (`asp=true`, `render_js=true`) — fires on HTTP 403/429/503 or when the response body is a challenge/block page. Requires `SCRAPFLY_API_KEY` secret.
3. Browser Rendering (Cloudflare Puppeteer) — fires for JS-heavy or thin-HTML pages not blocked by bots.

**Position the Brand section.** Three tags (THE HOOK, THE FIT, THE RELEVANCE) plus a one-sentence verdict. Left border color green/yellow/red. TRUST KILLER tag if a disqualifier is detected. Private company path only. Card color softened for profiles where a missing hook is not critical.

**SEO Readiness section.** Letter grade (A / B / C / D / F — no `+` or `−` modifiers), title, description, and four findings tiles in a two-by-two grid. Grade may be lifted to profile baseline when fewer than two hard failures are present. Private company path only.

**Agent Readiness section.** Level (ADVANCED / CAPABLE / EMERGING / BASIC) with a verdict line. No business name in any verdict. Private company path only.

**The Forward Signal.** Claude generates exactly three complete sentences for both private company and enterprise paths. Structure: sentence one names the single most important observation, sentence two explains why it matters for this business context, sentence three states the implication or opportunity. Sanitization strips em dashes, asterisks, and markdown formatting. Never truncated mid-sentence. Rendered in a blue card. Profile dimension weights are passed to the private company prompt so Claude leads with the highest-priority dimension. If the API call fails, the card does not render.

**Compare mechanic.** After a private company audit, the user can enter a site they admire. The worker fetches and scores that site, calls Claude to produce a new Forward Signal referencing what the admired site does well, and renders a side-by-side comparison table across five dimensions. Not available in enterprise mode.

**Business type inference.** For the private company path, Claude classifies the site and identifies its audience and purpose. Context is passed to positioning scoring and the Forward Signal to avoid penalizing platforms for not having a human-facing homepage.

**Visual consistency.** All four enterprise dimension cards use identical badge sizing (`.sa-agent-level`, 22px bold) and card structure. No grade rings in the enterprise path. Section labels update dynamically between modes.

---

## Section Heading Style

All section labels (Position the Brand, SEO Readiness, Agent Readiness, The Forward Signal, and their enterprise equivalents) render at:
- `font-size: 12px`
- `font-weight: 800`
- `color: var(--ink)` (`#1a1a1a`)
- `text-transform: uppercase`
- `letter-spacing: .14em`

---

## Secrets Required

| Secret | Used For |
|---|---|
| `DATAFORSEO_LOGIN` | DataForSEO on-page crawl |
| `DATAFORSEO_PASSWORD` | DataForSEO on-page crawl |
| `ANTHROPIC_API_KEY` | classifyEntity, Forward Signal, Enterprise Benchmark Signal, Compare Signal, business type inference |
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

When `true`, the KV email gate is bypassed — the same email can run multiple audits. **Set `DEV_MODE = false` before promoting to production.**

---

## Dev Worker

`https://sa-ai-audit-dev.saaudit.workers.dev`

**Deploy** from inside this folder:
```
npx wrangler deploy
```

Never use `--env dev` — that creates the wrong worker name (`sa-ai-audit-dev-dev`).

**Test locally:** open `digital-audit.html` in a browser. Answer all intake questions, enter a work email and a website URL, and click Show Me My Signal.

---

## Production Checklist

### Completed (Dev)

- [x] Three-question intake form with pill-card styling and custom indicators
- [x] Five-field submit button validation (email, URL, Q1 radio, Q2 checkbox, Q3 checkbox)
- [x] `profiles.js` with twelve named profiles, weights, and calibration blocks
- [x] `resolveProfile(userContext)` routes intake answers to correct profile
- [x] `resolveCompareProfile(primaryProfile)` routes compare requests to correct competitor profile
- [x] userContext try-catch with graceful fallback in `worker.js`
- [x] `seoBaselineGrade` calibration applied — grade lifted to profile baseline when hard failure count < 2
- [x] `authorityPenaltyReduced` calibration applied — critical authority demoted to weak for SMB and mixed profiles
- [x] `hookFailureIsCritical` calibration applied — card color softened from red to yellow when false
- [x] Dimension weights passed to Forward Signal system prompt
- [x] SEO grades clean single letters only — no `+` or `−` modifiers
- [x] Forward Signal constrained to exactly three complete sentences with explicit structure
- [x] Five-tier color progression system (`--signal-tier-1` through `--signal-tier-5`)
- [x] Known brand intercept and redirect fully removed from both `worker.js` and `digital-audit.html`
- [x] Dual-mode scoring: `classifyEntity()` → private company or enterprise path
- [x] `scoreEnterprise()` with four dimensions calibrated to Fortune 500 baselines
- [x] Enterprise card layout visually consistent across all four dimensions (large badge, no grade rings)
- [x] All badge and pill text white (`#fff`)
- [x] Section headings at `font-weight: 800`, `color: var(--ink)`
- [x] Compare table company name row at `#1a1a1a`
- [x] `EMERGING` agent level correctly mapped to tier 3 (not tier 4)
- [x] Business type inference via Claude Haiku
- [x] ScrapingBee removed, Scrapfly fully wired
- [x] Compare mechanic with enriched Forward Signal and five-dimension side-by-side table

### Outstanding Before Production

1. **Set `DEV_MODE = false` in `worker.js`.** KV rate limiting must be active in production.
2. **Wire up Cloudflare KV namespace `AUDITS` in production** (create a production namespace, add real ID).
3. **Add all secrets to the production worker** (`ANTHROPIC_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `SCRAPFLY_API_KEY`).
4. **Lock down CORS.** Change `ALLOW_ORIGIN` in `wrangler.toml` from `"*"` to `"https://skalatsky.com"`.
5. **Replace the audit section in `skalatsky.com/index.html`** with final markup from `digital-audit.html`. Update `SA_WORKER_URL` to `https://sa-ai-audit.saaudit.workers.dev`.
6. **Validate enterprise classification accuracy** against a wider range of URLs. Edge cases: regional utilities, government contractors, publicly traded micro-caps.
7. **Validate business type inference** for platforms and SaaS products.
8. **End-to-end QA pass on both paths** before go-live.

---

## How To Promote To Production

1. Set `DEV_MODE = false` in `worker.js`.
2. Deploy to the production worker from inside this folder:
   ```
   npx wrangler deploy --name sa-ai-audit
   ```
3. Replace the audit section in `skalatsky.com/index.html` with the final markup from `digital-audit.html`.
4. Update `SA_WORKER_URL` in the production page to `https://sa-ai-audit.saaudit.workers.dev`.
5. Verify both paths render correctly end-to-end:
   - **Private company:** intake form validates correctly, positioning tags and verdict, SEO grade (single letter), four findings, agent readiness level and verdict, Forward Signal (three sentences), Compare mechanic.
   - **Enterprise:** Brand Authority, Content Depth, AI Visibility, Audience Clarity dimension cards with tier badges, Forward Signal benchmark card (three sentences).
