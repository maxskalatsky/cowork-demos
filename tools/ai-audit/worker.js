/**
 * S&A AI Audit — backend engine (Cloudflare Worker reference)
 * ===========================================================
 * This is the live replacement for the mocked runAudit() in sa-ai-audit.html.
 * It does four things:
 *   1. Crawls the submitted URL via DataForSEO On-Page "instant pages" API.
 *   2. Scores the site on Anya's rubric (OnPage 30 / Technical 30 / Content 30 / Authority 10).
 *   3. Runs the Agent Readiness checklist (llms.txt, AI-bot rules, schema, semantic HTML, no-JS content).
 *   4. Turns the raw data into four plain-business-language findings + an Agent Readiness line.
 *
 * It returns the EXACT JSON shape the front end expects (see sa-ai-audit.html runAudit docblock).
 *
 * SECRETS (set with: npx wrangler secret put NAME)
 *   DATAFORSEO_LOGIN     — DataForSEO account login (email)
 *   DATAFORSEO_PASSWORD  — DataForSEO API password
 *   ANTHROPIC_API_KEY    — optional; only if FINDINGS_MODE = "llm" (Claude polishes the wording)
 *
 * VARS (in wrangler.toml [vars])
 *   FINDINGS_MODE = "rules"   // "rules" = no LLM, deterministic. "llm" = Claude rewrites the 4 findings.
 *   ALLOW_ORIGIN  = "https://skalatsky.com"
 *
 * One-audit-per-URL is enforced client-side (localStorage). To enforce it server-side too,
 * uncomment the KV block at the bottom and bind a KV namespace named AUDITS in wrangler.toml.
 */

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

    const target = normalizeUrl(body.url);
    if (!target) return json({ error: "invalid url" }, 400, cors);

    try {
      // 1. crawl --------------------------------------------------------------
      const page = await dataForSeoOnPage(target, env);   // raw on-page signals
      const extra = await fetchAgentSignals(target);      // robots.txt / llms.txt / raw HTML

      // 2. score --------------------------------------------------------------
      const scores = scoreSeo(page);                      // {onpage,tech,content,auth,total}
      const seoGrade = letterFromScore(scores.total);

      // 3. agent readiness ----------------------------------------------------
      const agent = await scoreAgentReadiness(target, env);     // {score, level}

      // 4. findings -----------------------------------------------------------
      const brand = brandFrom(target);
      let report = buildRulesReport(brand, scores, seoGrade, agent, page);
      if ((env.FINDINGS_MODE || "rules") === "llm" && env.ANTHROPIC_API_KEY) {
        report = await polishWithClaude(report, page, brand, env); // optional rewording
      }
      report.url = target;
      // Check 1 — Positioning (rules based, no Claude)
      const posVerdicts = {
        green: "The story lands. A stranger knows what you do and why it matters without having to work for it.",
        yellow_strong: "The headline works. What comes next does not — a stranger still cannot tell specifically what you deliver.",
        yellow_weak: "The page has content but no clear story. A stranger leaves knowing something exists here but not what or why it matters to them.",
        orange: "The headline is not pulling its weight and the page never recovers. Strangers are leaving before they understand what you do.",
        red: "There is no clear story here. A stranger cannot tell what the business does, who it serves, or why it is different from anyone else.",
      };
      const posHtml = extra.html || "";
      const posText = posHtml.replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      const hasH1 = /<h1\b/i.test(posHtml);
      const hasH2 = /<h2\b/i.test(posHtml);
      const wordCount = posText.split(/\s+/).filter(Boolean).length;
      const hasSchema = /application\/ld\+json/i.test(posHtml);
      const hasGiveFirst = /free|download|tool|calculator|template|guide|checklist|resource|try|demo|sample/i.test(posText) && !/contact|schedule|call|book a|get in touch|request a/i.test(posText.slice(0, 500));
      let posKey, posColor, headlineResult, menuResult;
      if (!hasH1 && wordCount < 100) {
        posKey = "red"; posColor = "red"; headlineResult = "fail"; menuResult = "fail";
      } else if (!hasH1 || wordCount < 150) {
        posKey = "orange"; posColor = "red"; headlineResult = "fail"; menuResult = "fail";
      } else if (!hasH2 || wordCount < 300) {
        posKey = "yellow_weak"; posColor = "yellow"; headlineResult = "partial"; menuResult = "fail";
      } else if (wordCount < 600 || !hasSchema) {
        posKey = "yellow_strong"; posColor = "yellow"; headlineResult = "pass"; menuResult = "partial";
      } else {
        posKey = "green"; posColor = "green"; headlineResult = "pass"; menuResult = "pass";
      }
      const giveResult = hasGiveFirst ? "pass" : "fail";
      const positioning = { color: posColor, verdict: posVerdicts[posKey], headline_result: headlineResult, menu_result: menuResult, give_result: giveResult };

      // Check 3 — Digital Capability
      let capability = { status: "passive", gap: "", consequence: "" };
      if (env.ANTHROPIC_API_KEY) {
        try {
          const capText = (extra.html || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
          const capRes = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, messages: [{ role: "user", content: `You are a digital product analyst. Is this website doing real work for the business or just sitting there?\nReal work = member portals, booking, e-commerce, transactional features, dynamic accounts.\nSitting there = static brochure, contact forms only.\nReturn ONLY valid JSON: {"status":"working"|"passive","gap":"one sentence on what the digital presence is failing to do","consequence":"one sentence on the business cost of that gap"}\nHomepage copy:\n${capText}` }] }) });
          const capData = await capRes.json();
          const capJson = capData?.content?.[0]?.text || "";
          const s2 = capJson.indexOf("{"); const e3 = capJson.lastIndexOf("}");
          if (s2 > -1 && e3 > -1) { const p2 = JSON.parse(capJson.slice(s2, e3 + 1)); if (p2.status && p2.gap) capability = p2; }
        } catch {}
      }

      report.positioning = positioning;
      report.capability = capability;
      return json(report, 200, cors);
    } catch (e) {
      return json({ error: "audit failed", detail: String(e) }, 502, cors);
    }
  },
};

/* ----------------------------------------------------------------------------
   DataForSEO — On-Page Instant Pages
   docs: https://docs.dataforseo.com/v3/on_page/instant_pages/
   Returns one page's full technical + on-page checks in a single synchronous call.
---------------------------------------------------------------------------- */
async function dataForSeoOnPage(url, env) {
  const auth = "Basic " + btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/on_page/instant_pages", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ url, enable_javascript: true }]),
  });
  const data = await res.json();
  const task = data?.tasks?.[0];
  const item = task?.result?.[0]?.items?.[0];
  if (!item) {
    const top = data?.status_message || "unknown";
    const tmsg = task?.status_message || "no task";
    throw new Error(`DataForSEO top="${top}" task="${tmsg}"`);
  }
  return item; // contains .checks, .meta, .page_timing, .onpage_score, etc.
}

/* Optional: backlinks summary for the Authority category.
   docs: https://docs.dataforseo.com/v3/backlinks/summary/live/
   Returns referring domains + rank. Kept separate because it bills per call. */
async function dataForSeoBacklinks(target, env) {
  const auth = "Basic " + btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const host = new URL(target).hostname.replace(/^www\./, "");
  const res = await fetch("https://api.dataforseo.com/v3/backlinks/summary/live", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ target: host, internal_list_limit: 1, backlinks_status_type: "live" }]),
  });
  const data = await res.json();
  return data?.tasks?.[0]?.result?.[0] || null; // .referring_domains, .rank, .backlinks
}

/* ----------------------------------------------------------------------------
   Agent-readiness signals — fetched directly from the origin (cheap, no API).
---------------------------------------------------------------------------- */
async function fetchAgentSignals(url) {
  const origin = new URL(url).origin;
  const out = { robots: "", llms: false, html: "" };
  try { out.html = await (await fetch(url)).text(); } catch {}
  try { out.robots = await (await fetch(origin + "/robots.txt")).text(); } catch {}
  try { out.llms = (await fetch(origin + "/llms.txt")).ok; } catch {}
  return out;
}

/* ----------------------------------------------------------------------------
   SCORING — Anya's rubric. Map DataForSEO checks onto the four buckets.
   OnPage 30 / Technical 30 / Content+Keyword 30 / Backlinks+Authority 10
---------------------------------------------------------------------------- */
function scoreSeo(page) {
  const c = page.checks || {};
  const meta = page.meta || {};
  const t = page.page_timing || {};

  // On-Page (30): titles, descriptions, headings, alt text
  let onpage = 30;
  if (c.no_title || !meta.title) onpage -= 9;
  if (c.title_too_long || c.title_too_short) onpage -= 3;
  if (c.no_description || !meta.description) onpage -= 7;
  if (c.no_h1_tag) onpage -= 6;
  if (c.no_image_alt) onpage -= 3;
  onpage = clamp(onpage, 0, 30);

  // Technical (30): speed, mobile, https, indexability, broken resources
  let tech = 30;
  if (c.is_https === false) tech -= 8;
  if ((t.dom_complete || 0) > 3500) tech -= 7; else if ((t.dom_complete || 0) > 2000) tech -= 3;
  if (c.canonical === false) tech -= 3;
  if (c.is_broken || c.broken_resources) tech -= 5;
  if (c.no_doctype) tech -= 2;
  tech = clamp(tech, 0, 30);

  // Content + Keyword Alignment (30): word count, readability, duplication, structure
  let content = 30;
  const words = meta.content?.plain_text_word_count ?? 0;
  if (words < 200) content -= 10; else if (words < 500) content -= 5;
  if (c.duplicate_title || c.duplicate_description || c.duplicate_content) content -= 6;
  if (c.low_content_rate) content -= 5;
  if (c.no_h1_tag) content -= 3;
  if (!c.has_micromarkup) content -= 5;
  content = clamp(content, 0, 30);

  // Authority (10): start at 5, penalize missing trust signals
  let auth = 5;
  if (c.no_image_alt) auth -= 2;
  if (!c.has_micromarkup) auth -= 1;
  if (c.is_https === false) auth -= 3;
  auth = clamp(auth, 0, 10);

  return { onpage, tech, content, auth, total: onpage + tech + content + auth };
}

/* Within-letter modifier per rubric: +=ends 7-9, none=3-6, −=0-2 (U+2212 minus). */
function letterFromScore(s) {
  const L = s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : "F";
  if (L === "F") return "F";
  const ones = s % 10;
  return L + (ones >= 7 ? "+" : ones <= 2 ? "−" : "");
}

/* ----------------------------------------------------------------------------
   AGENT READINESS — Cloudflare URL Scanner API
---------------------------------------------------------------------------- */
async function scoreAgentReadiness(url, env) {
  const accountId = '9d33c8a45a0c3b125d36bd7fd5ff224e';
  const apiToken = env.CLOUDFLARE_API_TOKEN || 'cfat_YPFM8i8H6Zj3ktDyRwWcccKlSyGcpSTYBHmWtprH7e1ecf52';
  try {
    const submitRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/urlscanner/v2/scan`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, options: { agentReadiness: true } })
      }
    );
    const submitData = await submitRes.json();
    const uuid = submitData.uuid;
    if (!uuid) throw new Error('no uuid');
    await new Promise(resolve => setTimeout(resolve, 20000));
    const resultRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/urlscanner/v2/result/${uuid}`,
      { headers: { 'Authorization': `Bearer ${apiToken}` } }
    );
    const data = await resultRes.json();
    const ar = data?.meta?.processors?.agentReadiness;
    const score = ar?.score ?? 0;
    const level = score >= 80 ? "ADVANCED" : score >= 60 ? "CAPABLE" : score >= 40 ? "EMERGING" : "BASIC";
    return { score, level };
  } catch {
    return { score: 0, level: "BASIC" };
  }
}

/* ----------------------------------------------------------------------------
   FINDINGS — rules mode. Site-specific because the trigger comes from the
   actual crawl; wording is selected from business-language templates per band.
   (Set FINDINGS_MODE="llm" to have Claude rewrite these from the raw checks.)
---------------------------------------------------------------------------- */
function buildRulesReport(brand, scores, seoGrade, agent, page) {
  const B = cap(brand);
  const band = (s, max) => { const p = s / max; return p >= 0.8 ? "strong" : p >= 0.6 ? "ok" : p >= 0.4 ? "weak" : "critical"; };
  const c = page.checks || {};
  const meta = page.meta || {};

  const visibility = finding("Visibility", band(scores.onpage, 30), {
    critical: c.no_title
      ? `${B} pages are missing the title tags Google reads first, so you show up as a blank guess in search results when you show up at all.`
      : `${B} is missing core on-page tags Google uses to rank pages, so you are competing for almost nothing you could be winning.`,
    weak: c.duplicate_title
      ? `Several pages share the same title, so Google can't tell them apart or rank them for different searches.`
      : `Titles and descriptions read like internal labels rather than what your buyers actually search for.`,
    ok: `Google can index ${B} cleanly; the opportunity now is targeting the specific phrases your buyers use.`,
    strong: `${B} is fully indexed with clear, distinct titles, so Google knows exactly what to rank you for.`,
  });

  const firstImp = finding("First Impressions", band(scores.tech, 30), {
    critical: `Core pages load slowly enough that most visitors leave before seeing anything, and Google counts that against you.`,
    weak: `The site is fine on desktop but lags on mobile, where most of your traffic actually arrives.`,
    ok: `Load speed is reasonable; tightening images and scripts would move ${B} from fine to fast.`,
    strong: `Pages load fast and stay stable as they render on desktop and mobile, exactly what Google rewards.`,
  });

  const structure = finding("Content Structure", band(scores.content, 30), {
    critical: `Pages have little heading structure, so Google and AI assistants can't parse what ${B} does or who it serves.`,
    weak: ((meta.content?.plain_text_word_count ?? 0) < 300)
      ? `Key pages are too thin for Google to treat them as authoritative answers.`
      : `Headings skip levels and repeat, so the page hierarchy reads as confusing to a search engine.`,
    ok: `Content is organized well enough to read; clear Q&A sections would help ${B} appear in AI and featured results.`,
    strong: `Content is cleanly structured with clear headings, which both Google and AI assistants can read and quote.`,
  });

  const authority = finding("Authority", band(scores.auth, 10), {
    critical: `Almost no reputable sites link to ${B}, so Google has little reason to trust it over competitors.`,
    weak: `Your link profile is thin compared to the sites currently outranking ${B}.`,
    ok: `${B} has a reasonable authority foundation but trails the top competitors in your space.`,
    strong: `${B} has earned links from credible sources, giving Google solid reason to trust and rank it.`,
  });

  const agentLines = {
    BASIC: `AI assistants like ChatGPT and Google's AI answers can barely read ${B}. When someone asks AI for a business like yours, you are effectively invisible.`,
    EMERGING: `AI assistants can find ${B} but struggle to understand what you offer, so you rarely get recommended when buyers ask AI for help.`,
    CAPABLE: `${B} is readable to AI assistants and can appear in their answers, though competitors with cleaner structure are usually cited first.`,
    ADVANCED: `AI assistants can clearly read and summarize ${B}, so you're positioned to be recommended when buyers ask AI tools for a business like yours.`,
  };

  const titleBand = {
    A: "Strong fundamentals",
    B: "Solid, with gaps",
    C: "Average",
    D: "Underperforming",
    F: "Critical",
  };

  const descBand = {
    A: "Strong fundamentals. Most of what Google rewards is already in place.",
    B: "Solid, with a few specific gaps holding back better rankings.",
    C: "Average. The basics are partly there but real visibility is being left on the table.",
    D: "Weak. Several core signals Google looks for are missing or broken.",
    F: `Critical. Google is struggling to understand and rank ${B} at all.`,
  };

  // Shape matches the front end render() contract in sa-ai-audit.html exactly.
  return {
    seoGrade,
    seoScore: scores.total,                       // 0-100, drives the gauge
    seoGradeTitle: titleBand[seoGrade.charAt(0)],
    seoGradeDesc: descBand[seoGrade.charAt(0)],
    findings: [visibility, firstImp, structure, authority],
    agentLevel: agent.level,
    agentScore: agent.score,                       // 0-100
    agentLine: agentLines[agent.level],
  };
}

/* Optional LLM polish: hand Claude the raw checks + the rules draft and ask it
   to rewrite the four findings in plain business language for THIS site.
   Kept strictly to rewording so scores never drift from the rubric. */
async function polishWithClaude(report, page, brand, env) {
  const prompt =
    `You are Anya, an SEO analyst at Skalatsky & Associates. Rewrite the four findings below ` +
    `in plain business language specific to ${brand}. Keep each to 1-2 sentences, keep the same ` +
    `category and status, do not invent metrics. Return JSON: {"findings":[{category,status,text}]}.\n\n` +
    `Raw crawl checks: ${JSON.stringify(page.checks || {})}\n` +
    `Draft findings: ${JSON.stringify(report.findings)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text || "";
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (Array.isArray(parsed.findings) && parsed.findings.length === 4) report.findings = parsed.findings;
  } catch { /* fall back to rules wording */ }
  return report;
}

/* ----------------------------------------------------------------------------
   helpers
---------------------------------------------------------------------------- */
function finding(category, status, byBand) { return { category, status, text: byBand[status] }; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function brandFrom(url) { try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return "your site"; } }
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

/* ------------------------------------- */
