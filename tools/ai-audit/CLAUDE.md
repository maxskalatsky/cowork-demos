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

**Email gate.** Every audit request must include a valid email address. Requests without one must return an error. Never run the audit without an email.

**One free Signal per email.** Enforced server-side via Cloudflare KV (namespace: `AUDITS`). A second request from the same email must return the message: `"You have already run a free Signal. Email audit@skalatsky.com to discuss your results."` — not a silent failure, not an HTTP error page, a clean JSON error the front end displays in-form.

**Every audit run must be logged to KV.** Log email, URL, timestamp, SEO score, SEO grade, and agent readiness level. If KV is not bound, the worker must still run audits (graceful degradation) — but in production KV must always be bound.

**Position the Brand section** must return three tags — THE HOOK (lands / partial / missing), THE FIT (clear / partial / unclear), THE RELEVANCE (connects / partial / missing) — plus a one-sentence verdict from the verdict library. Left border color green / yellow / red per the color field. If disqualifier is true, show a single TRUST KILLER tag instead of the three.

**Drive Demand section** must return a letter grade (A / B / C / D / F, no modifier) with a title and description, four findings cards, and an agent readiness level (ADVANCED / CAPABLE / EMERGING / BASIC) with a one-sentence line and a four-segment meter.

**Build the Product section is not yet specced.** It must not render at all. No blank cards, no section label, nothing visible. Hide it until the section is defined and approved.

## Loop rule

Keep iterating — change, deploy, test, read result, fix if wrong — until acceptance criteria pass. Do not stop before that.
