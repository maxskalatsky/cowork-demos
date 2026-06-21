\# S\&A Digital Audit Tool — Dev Environment



Isolated development environment for the S\&A AI Audit tool.

This folder is the single source of truth for all dev work on this tool.

Nothing in here touches production.



\## File Structure



\- `digital-audit.html` — standalone audit page, self-contained, no skalatsky.com dependencies

\- `worker.js` — Cloudflare Worker source code, version controlled here

\- `wrangler.toml` — Cloudflare deploy config for the dev worker

\- `README.md` — this file



\## Environments



| Environment | HTML File | Worker | URL |

|---|---|---|---|

| Dev | digital-audit.html | sa-ai-audit-dev | sa-ai-audit-dev.saaudit.workers.dev |

| Production | skalatsky.com/index.html | sa-ai-audit | sa-ai-audit.saaudit.workers.dev |



\## Rules



\- Never point digital-audit.html at the production worker

\- Never edit worker.js in the Cloudflare dashboard directly. Edit here and deploy via Wrangler

\- All changes go through this repo before touching production

\- Test every audit run locally before pushing to production



\## How to Deploy the Dev Worker



From the terminal inside this folder:



```powershell

cd C:\\Users\\max\\cowork-demos\\tools\\ai-audit

npx wrangler deploy

```



\## How to Set Secrets



Run once per secret. Wrangler will prompt you to paste the value:



```powershell

npx wrangler secret put DATAFORSEO\_LOGIN

npx wrangler secret put DATAFORSEO\_PASSWORD

npx wrangler secret put ANTHROPIC\_API\_KEY

```



\## How to Promote to Production



When the dev build is ready and tested:



1\. Copy the final worker.js to the production worker via wrangler using the production worker name

2\. Replace the audit section in skalatsky.com index.html with the final markup from digital-audit.html

3\. Update the worker URL in the production index.html to point back to sa-ai-audit.saaudit.workers.dev

4\. Push to production and verify



\## Local Preview



Open digital-audit.html directly in a browser. It calls the live dev worker so you get real audit results without any local server needed.



\## GitHub Pages Preview



Enable GitHub Pages on the cowork-demos repo to get a shareable URL:

`https://maxskalatsky.github.io/cowork-demos/tools/ai-audit/digital-audit.html`

