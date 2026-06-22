# CLAUDE.md — The Digital Signal (ai-audit tool)

## Dev worker

`https://sa-ai-audit-dev.saaudit.workers.dev`

## Deploy

Always deploy from inside `tools/ai-audit/`. Running wrangler from any other directory will target the wrong worker.

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

## Acceptance criteria

**The product is called The Digital Signal.**

**Form.** Two fields and one button: work email, website URL, and Run My Digital Signal. No other intake fields.

**Email gate.** Every audit request must include a valid email address. Requests without one must return an error. Never run the audit without an email.

**One free Signal per email.** Enforced server-side via Cloudflare KV (namespace: `AUDITS`). A second request from the same email must return the message: `"You have already run a free Signal. Email signal@skalatsky.com to discuss your results."` — not a silent failure, not an HTTP error page, a clean JSON error the front end displays in-form.

**Every audit run must be logged to KV.** Log email, URL, timestamp, SEO score, SEO grade, and agent readiness level. If KV is not bound, the worker must still run audits (graceful degradation) — but in production KV must always be bound.

**Position the Brand section** must return three tags — THE HOOK (lands / partial / missing), THE FIT (clear / partial / unclear), THE RELEVANCE (connects / partial / missing) — plus a one-sentence verdict from the verdict library. Left border color green / yellow / red per the color field. If disqualifier is true, show a single TRUST KILLER tag instead of the three.

**SEO Readiness section** must return a letter grade (A / B / C / D / F, with +/− modifier) with a title and description, and four findings cards in a two-by-two grid. Layout: grade circle top left, descriptive sentence to the right of the circle, four tiles below in a two-by-two grid. All contained within one card with one left border color matching the grade.

**Agent Readiness section** must return a level (ADVANCED / CAPABLE / EMERGING / BASIC) and a verdict line. The verdict is selected from three variants per level based on SEO grade and page signals — see the variant library in `worker.js`. No business name in any agent readiness verdict string. All verdicts are written in second person.

**The Forward Signal** is a Claude-generated observation identifying the single highest-leverage opportunity the site is leaving on the table. Rules:
- Exactly two sentences. Hard limit — cut, do not add a third sentence.
- Maximum 400 characters after sanitization. Truncate at the nearest sentence boundary before the limit, never mid-sentence.
- Sanitization runs on every response before it is returned: replace em dashes surrounded by spaces with a comma and space, remove bare em dashes, remove asterisks, remove pound signs and backticks, collapse double spaces.
- Never use em dashes, hyphens as dashes, or asterisks in the response.
- Rendered in a blue card (background `#E6F1FB`, left border `#185FA5`) below the Agent Readiness section, under the section label "The forward signal".
- If the API call fails or returns nothing, the card does not render. Never show an error string in the Forward Signal card.

## Loop rule

Keep iterating — change, deploy, test, read result, fix if wrong — until acceptance criteria pass. Do not stop before that.
