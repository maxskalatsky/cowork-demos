import { dataForSeoOnPage, fetchAgentSignals, detectJsFramework, extractHtmlMeta, patchPageFromHtml } from "./fetch.js";
import { scoreSeo, letterFromScore, scorePositioning, scoreAgentReadiness, buildRulesReport, scoreEnterprise, resolveProfile } from "./scorer.js";
import { inferBusinessType, getForwardSignal, getCompareSignal, polishWithClaude, getEnterpriseBenchmarkSignal } from "./signals.js";

const DEV_MODE = false; // bypass KV email gate during dev testing; set false before promoting to production

async function logToNotion(env, { businessName, email, url, seoGrade, agentLevel }) {
  if (!env.NOTION_API_KEY) return;
  const today = new Date().toISOString().split("T")[0];
  const props = {
    "Prospect Name": { title: [{ text: { content: businessName || "" } }] },
    "Prospect Email": { email: email || null },
    "Prospect Company": { rich_text: [{ text: { content: businessName || "" } }] },
    "Prospect URL": { url: url || null },
    "Signal Date": { date: { start: today } },
  };
  if (seoGrade) props["SEO Grade"] = { select: { name: seoGrade } };
  if (agentLevel) props["Agent Level"] = { select: { name: agentLevel } };
  try {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: "cd12287db4f143a3931f09a8ac8f55c8" },
        properties: props,
      }),
    });
  } catch (e) {
    console.warn("Notion log failed:", String(e));
  }
}

async function classifyEntity(url, env) {
  if (!env.ANTHROPIC_API_KEY) return "private_company";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content:
          `Classify this URL. Reply with exactly one of these two strings and nothing else:\nprivate_company\nknown_brand\n\n` +
          `URL: ${url}\n\n` +
          `known_brand = publicly traded company, Fortune 1000, major media or sports property, government entity, utility, or globally recognized consumer brand.\n` +
          `private_company = everything else including small businesses, local services, startups, and agencies.`
        }],
      }),
    });
    if (!res.ok) return "private_company";
    const data = await res.json();
    const text = (data?.content?.[0]?.text || "").trim().toLowerCase();
    return text.includes("known_brand") ? "known_brand" : "private_company";
  } catch { return "private_company"; }
}


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

    let userContext;
    try {
      userContext = {
        entityType: body.entityType || null,
        primaryVisitor: Array.isArray(body.primaryVisitor) ? body.primaryVisitor : [],
        siteGoal: Array.isArray(body.siteGoal) ? body.siteGoal : [],
      };
    } catch (e) {
      console.warn("userContext parse failed, using fallback:", String(e));
      userContext = { entityType: 'small_growing', primaryVisitor: ['cold_prospects'], siteGoal: ['generate_leads'] };
    }
    console.log("userContext:", JSON.stringify(userContext));

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

    // Classify entity before any scoring — determines which pipeline runs
    const entityType = await classifyEntity(target, env);

    try {
      // ── ENTERPRISE PATH (known_brand) ──────────────────────────────────────
      if (entityType === "known_brand") {
        const extra = await fetchAgentSignals(target, env);
        let rawPage = { checks: {}, meta: {} };
        try { rawPage = await dataForSeoOnPage(target, env); } catch {}

        const brand = extractBrand(target, extra.html || "", rawPage.meta?.title);
        const enterpriseScores = scoreEnterprise(extra, rawPage, userContext);

        if (env.AUDITS) {
          await env.AUDITS.put(email, JSON.stringify({
            email, url: target, timestamp: new Date().toISOString(), entityType: "known_brand",
          }));
        }
        await logToNotion(env, { businessName: brand, email, url: target, seoGrade: null, agentLevel: null });
        const fwd = env.ANTHROPIC_API_KEY
          ? await getEnterpriseBenchmarkSignal(extra.html || "", brand, enterpriseScores, target, env)
          : null;

        return json({
          entityType: "known_brand",
          url: target,
          businessName: brand,
          rendering_mode: extra.rendering_mode || "fetch",
          ...enterpriseScores,
          ...(fwd ? { forwardSignal: fwd } : {}),
        }, 200, cors);
      }

      // ── PRIVATE COMPANY PATH (unchanged) ───────────────────────────────────
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
      let report = buildRulesReport(brand, scores, seoGrade, agent, page, userContext);
      const profile = resolveProfile(userContext);
      if ((env.FINDINGS_MODE || "rules") === "llm" && env.ANTHROPIC_API_KEY) {
        report = await polishWithClaude(report, page, brand, env);
      }
      report.url = target;

      if (jsFramework) {
        report.jsFramework = jsFramework;
        report.seoGradeDesc += ` Scored from initial HTML — this site uses ${jsFramework} rendering so some signals may differ from the fully rendered page.`;
      }

      const businessCtx = await businessCtxPromise;

      let positioning = scorePositioning(extra.html || "", businessCtx);
      if (!profile.calibration.hookFailureIsCritical && positioning.hook === "missing" && positioning.color === "red") {
        positioning = { ...positioning, color: "yellow" };
      }

      // Log audit to KV
      if (env.AUDITS) {
        await env.AUDITS.put(email, JSON.stringify({
          email, url: target, timestamp: new Date().toISOString(),
          seoScore: scores.total, seoGrade, agentLevel: agent.level,
        }));
      }
      await logToNotion(env, { businessName: brand, email, url: target, seoGrade, agentLevel: agent.level });

      // Forward Signal — Claude-generated opportunity observation
      if (env.ANTHROPIC_API_KEY) {
        const fwd = await getForwardSignal(extra.html, positioning, report.seoGrade, report.findings, agent.level, businessCtx, profile, env);
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
