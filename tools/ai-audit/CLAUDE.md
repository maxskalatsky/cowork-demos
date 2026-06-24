# CLAUDE.md — The Digital Signal (ai-audit tool)

## Dev worker

`https://sa-ai-audit-dev.saaudit.workers.dev`

## Deploy

Always deploy from inside `tools/ai-audit/`. Running wrangler from any other directory will target the wrong worker. Never use `--env dev` — that creates `sa-ai-audit-dev-dev` instead of `sa-ai-audit-dev`.

```
npx wrangler deploy
```

## Test every change

After every deploy, POST to the dev worker with a real email and URL and read the full response. Do not assume the deploy worked — verify it.

```powershell
Invoke-RestMethod -Method POST -Uri "https://sa-ai-audit-dev.saaudit.workers.dev" `
  -ContentType "application/json" `
  -Body '{"url":"https://skalatsky.com","email":"test@example.com"}'
```

## DEV_MODE

`worker.js` has `const DEV_MODE = true;` at the top. This bypasses the KV email gate so the same email can submit multiple audits during testing. **Set `DEV_MODE = false` before promoting to production.** The rate limit must be active on the production worker.

## Page fetch cascade

Three tiers, in order:

1. **Raw fetch** — direct HTTP, no API cost.
2. **Scrapfly** — fires when HTTP status is 403, 429, or 503, or when the response body is a bot-challenge/block page. Uses `asp=true` and `render_js=true`. Requires `SCRAPFLY_API_KEY` secret. Do not reference ScrapingBee anywhere — it has been replaced.
3. **Browser Rendering** (Cloudflare Puppeteer) — fires for JS-heavy or thin-HTML pages that are not blocked by bots. Only runs when `env.BROWSER` is bound.

All fetch logic lives in `fetch.js`. `worker.js` calls `fetchAgentSignals()` and never touches fetch tiers directly.

## Module structure

- `worker.js` — orchestrator: routing, email gate, KV logging, dual-mode classification via `classifyEntity()`. Imports from all four modules.
- `fetch.js` — all page fetching (raw, Scrapfly, Puppeteer) and DataForSEO calls.
- `scorer.js` — private company scoring (positioning, SEO, agent readiness, findings) and enterprise scoring (`scoreEnterprise()` with four dimensions).
- `verdicts.js` — verdict text library only: positioning verdicts, agent readiness variants, SEO grade titles/descriptions.
- `signals.js` — all Claude API calls: business type inference, Forward Signal, enterprise benchmark signal, Compare Signal, optional LLM polish.

## Dual-mode scoring

Every URL submitted routes through `classifyEntity()` **before any scoring runs**. This is a Claude Haiku call (max_tokens=10) that returns the exact string `"private_company"` or `"known_brand"`. It defaults to `"private_company"` on any API failure or missing key.

**Known brand definition:** publicly traded company, Fortune 1000, major media or sports property, government entity, utility, or globally recognized consumer brand. Everything else is `"private_company"`.

`classifyEntity()` is called immediately after the KV email gate, before the main try block. The result determines which pipeline runs — the two paths share no scoring logic.

## Acceptance criteria

**The product is called The Digital Signal.**

**Three-question intake.** The intake form must contain three questions between the URL field and the Submit button. Question 1 is a radio group (company type), Question 2 is a checkbox group (who visits the site), Question 3 is a checkbox group (what the site needs to do). The Submit button must remain disabled until all five conditions pass: valid email format, non-empty URL, Q1 has exactly one radio selected, Q2 has at least one checkbox selected, Q3 has at least one checkbox selected. Custom pill-card indicators must be visible at all times and styled per the dual color system (green/teal for selected, light border for unselected).

**Profile routing.** Every private company audit submission must resolve to a named profile via `resolveProfile(userContext)`. The resolved profile name must appear in the worker console log on every request. The profile calibration must be applied to scoring output: SEO grade baseline, authority penalty reduction, hook failure severity, and dimension weights in the Forward Signal prompt.

**Email gate.** Every audit request must include a valid email address. Requests without one must return an error. Never run the audit without an email.

**One free Signal per email.** Enforced server-side via Cloudflare KV (namespace: `AUDITS`). A second request from the same email must return the message: `"You have already run a free Signal. Email signal@skalatsky.com to discuss your results."` — not a silent failure, not an HTTP error page, a clean JSON error the front end displays in-form.

**Every audit run must be logged to KV.** Log email, URL, timestamp, SEO score (or entityType for enterprise), and agent readiness level (or scores for enterprise). If KV is not bound, the worker must still run audits (graceful degradation) — but in production KV must always be bound.

**Every URL must route through `classifyEntity()` before any scoring runs.** The classification call is mandatory — no URL bypasses it.

---

### Private Company Path

**Position the Brand section** must return three tags — THE HOOK (lands / partial / missing), THE FIT (clear / partial / unclear), THE RELEVANCE (connects / partial / missing) — plus a one-sentence verdict from the verdict library. Left border color green / yellow / red per the color field. If disqualifier is true, show a single TRUST KILLER tag instead of the three.

**SEO Readiness section** must return a letter grade (A / B / C / D / F — single letter only, no `+` or `−` modifiers) with a title and description, and four findings cards in a two-by-two grid. Layout: grade circle top left, descriptive sentence to the right of the circle, four tiles below in a two-by-two grid. All contained within one card with one left border color matching the grade. The grade may be lifted to the profile baseline when fewer than two hard failures are present — this override is applied inside `buildRulesReport()` before the grade is returned.

**Agent Readiness section** must return a level (ADVANCED / CAPABLE / EMERGING / BASIC) and a verdict line. The verdict is selected from three variants per level based on SEO grade and page signals — see the variant library in `verdicts.js`. No business name in any agent readiness verdict string. All verdicts are written in second person.

**The Forward Signal** is a Claude-generated observation identifying the single highest-leverage opportunity the site is leaving on the table. Rules:
- Exactly three complete sentences. Cut at the third sentence-terminal punctuation mark. Never truncate mid-sentence.
- Structure: sentence one names the single most important observation, sentence two explains why it matters for this business context, sentence three states the concrete implication or opportunity the owner can act on.
- Sanitization runs on every response: replace em dashes surrounded by spaces with a comma and space, remove bare em dashes, remove asterisks, remove pound signs and backticks, collapse double spaces.
- Never use em dashes, hyphens as dashes, or asterisks in the response.
- System prompt instructs Claude: "Write exactly three complete sentences following this structure: sentence one names the single most important observation, sentence two explains why it matters for this specific business context, sentence three states the concrete implication or opportunity. If your output is more than three sentences, return only the first three complete sentences. Do not truncate output under any circumstances."
- Profile dimension weights must be included in the system prompt for the private company path so Claude leads with the highest-priority dimension.
- `max_tokens: 400` for the Forward Signal call.
- Rendered in a blue card below the Agent Readiness section.
- If the API call fails or returns nothing, the card does not render.

**The Compare mechanic** appears below the Forward Signal card after a successful private company audit. Rules:
- One input for a site the user admires, plus a Compare button.
- On submit: worker fetches and scores the admired site (positioning, SEO grade, agent readiness), then calls Claude to produce a new two-sentence Forward Signal that directly references what the admired site does well and what specific move the user can apply.
- The enriched signal replaces the original Forward Signal text in the blue card.
- A side-by-side comparison table renders below with five rows: THE HOOK, THE FIT, THE RELEVANCE, SEO GRADE, AGENT READINESS. SEO GRADE shows the letter only, no +/− modifier.
- Compare table company name row must render at `color: #1a1a1a` (not gray).
- Outcome branch: if the admired site scores higher overall, CTA reads "Beat them. Talk to S&A." If the user is already ahead, CTA reads "Stay ahead. Talk to S&A."
- CTA buttons in the comparison card must be horizontally centered.
- After the comparison renders, the compare input box is removed from the DOM entirely. It is re-inserted when the user runs a new audit.
- Compare is one-shot per audit run. The button does nothing after the first use.
- Compare is only available in the private company path. Never show the compare box after an enterprise audit.

---

### Enterprise / Known Brand Path

**Known brand intercept must not exist anywhere in `worker.js` or `digital-audit.html`.** There is no early-exit, no redirect, and no hardcoded brand list. Every URL reaches the full pipeline; routing is determined by `classifyEntity()` alone.

**Enterprise path must activate when Question 1 = "Large national or global brand."** This selection maps to `entityType: large_national_global`, which `resolveProfile()` maps to `enterprise_benchmark`. The worker's `classifyEntity()` call provides a second layer of routing for any URL submitted as a known brand regardless of Q1 selection.

**Known brands receive four dimension scores, not the private company pipeline.** The response must include `entityType: "known_brand"` and all four scored dimensions. No SEO grade, no findings, no positioning tags, no compare mechanic.

**Four enterprise dimensions** (each scored tier 1–5 with label Dominant/Strong/Moderate/Limited/Minimal):

1. **Brand Authority** — starts at 8 (Dominant baseline), deducts only for hard failures (no JSON-LD −2, not HTTPS −4, no canonical −1, no description −1). Dominant is the expected default — Fortune 500 brands should not have to earn it.

2. **Audience Clarity** — additive scoring from link count, h2 count, and content-type keyword diversity. Keywords include consumer media terms (news, video, live, fantasy, scores, standings, sports) as well as B2B terms. Do not use B2B-only audience pattern matching.

3. **AI Visibility** — additive scoring from llms.txt presence, AI crawler access, JSON-LD, FAQ/Article schema, H1/H2 structure, word count.

4. **Content Depth** — additive scoring from section path presence (/news, /video, /scores, /insights in href links), total link count, h2 breadth, word count. Do not use home-page word count alone.

**Enterprise section labels** update dynamically:
- `sa-lbl-pos` → "Brand Authority"
- `sa-lbl-seo` → "Content Depth"
- `sa-lbl-agent` → "AI Visibility"
- New `sa-audience-wrap` block → "Audience clarity"

**Enterprise card layout** — all four dimension cards must use `.sa-agent-level` (22px bold, white text) badges. No grade rings (`.sa-gauge`) in the enterprise path. No grade circle.
- Brand Authority: large `.sa-agent-level` badge injected into `sa-pos-tests`.
- Content Depth: `.sa-gauge` hidden, `div#sa-ent-cd-badge.sa-agent-level` injected into `.sa-seo-top` before `.sa-hero-meta`.
- AI Visibility: `.sa-alevel` badge in the `.sa-agent-card` slot.
- Audience Clarity: `.sa-aud-level` badge in the `#sa-audience-wrap` slot (hidden by default, shown for enterprise).

**Enterprise Forward Signal** — The `getEnterpriseBenchmarkSignal()` call in `signals.js` generates two sentences framing what a private operator can learn from studying this brand. Same sanitization rules as the private company Forward Signal. `max_tokens: 400`. Compare box must not appear.

**No compare box in enterprise mode.** The compare box is hidden (not removed) so it can be restored if the user runs a private company URL next.

**Enterprise cleanup on re-run.** When the user runs a private company URL after an enterprise URL in the same session, `render()` must:
- Restore section labels to "Position the brand", "SEO readiness", "Agent readiness"
- Remove `#sa-ent-cd-badge` from the DOM
- Restore `.sa-gauge` visibility
- Restore compare box visibility
- Hide `#sa-audience-wrap`

---

### Visual and Style Rules

**Five-tier color system.** All badges, pills, grade rings, and agent readiness badges use these CSS vars:
- `--signal-tier-1: #1F6B4E` — Dominant / A / ADVANCED / OPTIMIZED
- `--signal-tier-2: #3A9E72` — Strong / B / CAPABLE
- `--signal-tier-3: #4A9E8F` — Moderate / C / EMERGING / PARTIAL
- `--signal-tier-4: #7AABB8` — Limited / D / LIMITED
- `--signal-tier-5: #9BAEBB` — Minimal / F / BASIC / NOT READY

`EMERGING` maps to tier 3 (`--signal-tier-3`). It does not map to tier 4.

**All badge and pill text must render white (`#fff`).** This includes `.sa-pos-tag`, `.sa-agent-level`, and any tier badge injected in the enterprise path. Never inherit color from a parent that makes it unreadable.

**Section labels** must render at:
- `font-size: 12px`
- `font-weight: 800`
- `color: var(--ink)` (`#1a1a1a`)
- `text-transform: uppercase`
- `letter-spacing: .14em`

**Compare table company name row** must render at `color: #1a1a1a`, not gray.

**Known brand intercept is removed.** There is no early-exit intercept in `worker.js` and no redirect block in `digital-audit.html`. Every URL reaches the full pipeline.

---

## Loop rule

Keep iterating — change, deploy, test, read result, fix if wrong — until acceptance criteria pass. Do not stop before that.
