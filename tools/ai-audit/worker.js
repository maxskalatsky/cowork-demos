import { dataForSeoOnPage, fetchAgentSignals, detectJsFramework, extractHtmlMeta, patchPageFromHtml } from "./fetch.js";
import { scoreSeo, letterFromScore, scorePositioning, scoreAgentReadiness, buildRulesReport } from "./scorer.js";
import { inferBusinessType, getForwardSignal, getCompareSignal, polishWithClaude } from "./signals.js";

const DEV_MODE = true; // disable KV email gate in dev; set false before promoting to production


export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST")
      return json({ error: "POST only" }, 405, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }

    // Compare action — separate from the main audit flow, no email/KV required
    if (body.action === "compare") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "api not configured" }, 503, cors);
      const admiredUrl = normalizeUrl(body.admiredUrl);
      if (!admiredUrl) return json({ error: "invalid admired url" }, 400, cors);
      const admiredExtra = await fetchAgentSignals(admiredUrl, env);
      const admiredHtml = admiredExtra.html || "";
      const admiredCtx = await inferBusinessType(admiredHtml, admiredUrl, env);
      const admiredPositioning = scorePositioning(admiredHtml, admiredCtx);
      const admiredMeta = extractHtmlMeta(admiredHtml, admiredUrl);
      const admiredPage = patchPageFromHtml({ checks: {}, meta: {} }, admiredMeta);
      const admiredScores = scoreSeo(admiredPage);
      const admiredSeoGrade = letterFromScore(admiredScores.total);
      const admiredAgent = scoreAgentReadiness(admiredExtra, admiredScores, admiredSeoGrade);
      const enrichedSignal = await getCompareSignal(body, admiredHtml, admiredPositioning, admiredSeoGrade, admiredAgent.level, admiredUrl, env);
      return json({ enrichedSignal, admiredPositioning, admiredSeoGrade, admiredAgentLevel: admiredAgent.level, admiredUrl }, 200, cors);
    }

    const target = normalizeUrl(body.url);
    if (!target) return json({ error: "invalid url" }, 400, cors);


    const email = (body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "A valid work email is required." }, 400, cors);
    }

    // One free Signal per email — check KV before running anything expensive
    if (!DEV_MODE && env.AUDITS) {
      const prior = await env.AUDITS.get(email);
      if (prior) {
        return json({ error: "You have already run a free Signal. Email signal@skalatsky.com to discuss your results." }, 429, cors);
      }
    }

    try {
      // 1. crawl --------------------------------------------------------------
      const rawPage = await dataForSeoOnPage(target, env);
      const extra = await fetchAgentSignals(target, env);

      const jsFramework = detectJsFramework(extra.html || "");
      const page = (jsFramework && !rawPage.meta?.title)
        ? patchPageFromHtml(rawPage, extractHtmlMeta(extra.html || "", target))
        : rawPage;

      // 2. score --------------------------------------------------------------
      const scores = scoreSeo(page);
      const seoGrade = letterFromScore(scores.total);

      // Business type inference — runs in parallel with synchronous steps below
      const businessCtxPromise = env.ANTHROPIC_API_KEY
        ? inferBusinessType(extra.html || "", target, env)
        : Promise.resolve(null);

      // 3. agent readiness ----------------------------------------------------
      const agent = scoreAgentReadiness(extra, scores, seoGrade);

      // 4. findings -----------------------------------------------------------
      const brand = extractBrand(target, extra.html || "", page.meta?.title);
      let report = buildRulesReport(brand, scores, seoGrade, agent, page);
      if ((env.FINDINGS_MODE || "rules") === "llm" && env.ANTHROPIC_API_KEY) {
        report = await polishWithClaude(report, page, brand, env);
      }
      report.url = target;

      if (jsFramework) {
        report.jsFramework = jsFramework;
        report.seoGradeDesc += ` Scored from initial HTML — this site uses ${jsFramework} rendering so some signals may differ from the fully rendered page.`;
      }

      const businessCtx = await businessCtxPromise;

      const positioning = scorePositioning(extra.html || "", businessCtx);

      // Log audit to KV
      if (env.AUDITS) {
        await env.AUDITS.put(email, JSON.stringify({
          email,
          url: target,
          timestamp: new Date().toISOString(),
          seoScore: scores.total,
          seoGrade,
          agentLevel: agent.level,
        }));
      }

      // Forward Signal — Claude-generated opportunity observation
      if (env.ANTHROPIC_API_KEY) {
        const fwd = await getForwardSignal(extra.html, positioning, seoGrade, report.findings, agent.level, businessCtx, env);
        if (fwd) report.forwardSignal = fwd;
      } else {
        console.warn("ANTHROPIC_API_KEY not bound — Forward Signal skipped");
      }

      report.businessName = brand;
      report.positioning = positioning;
      report.rendering_mode = extra.rendering_mode || "fetch";
      return json(report, 200, cors);
    } catch (e) {
      return json({ error: "audit failed", detail: String(e) }, 502, cors);
    }
  },
};

function extractBrand(url, html, metaTitle) {
  const strip = t => (t || "").trim().replace(/\s*[-|–—·]\s.*$/, "").trim();
  const fromTitle = decodeHtmlEntities(strip(metaTitle) || strip(((html || "").match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]));
  if (fromTitle && fromTitle.length > 2 && fromTitle.length < 80) return fromTitle;
  const ogM = (html || "").match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
           || (html || "").match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const fromOg = decodeHtmlEntities(strip((ogM || [])[1]));
  if (fromOg && fromOg.length > 2 && fromOg.length < 80) return fromOg;
  try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return "your site"; }
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function normalizeUrl(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try { const u = new URL(v); return u.hostname.includes(".") ? u.href : null; } catch { return null; }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...(cors || {}) },
  });
}
