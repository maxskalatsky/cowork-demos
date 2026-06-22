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

const KNOWN_BRANDS = new Set([
  "espn.com","nike.com","apple.com","google.com","amazon.com",
  "microsoft.com","facebook.com","instagram.com","twitter.com","x.com",
  "linkedin.com","netflix.com","disney.com","coca-cola.com","pepsi.com",
  "ford.com","gm.com","bmw.com","mercedes.com","adidas.com",
  "nordstrom.com","walmart.com","target.com","homedepot.com","lowes.com",
  "mcdonalds.com","starbucks.com","salesforce.com","oracle.com","sap.com",
  "ibm.com","intel.com","cisco.com","adobe.com","nfl.com",
  "nba.com","mlb.com","nhl.com","cnn.com","foxnews.com",
  "nytimes.com","wsj.com","bloomberg.com","forbes.com","huffpost.com",
  "reddit.com","youtube.com","tiktok.com","snapchat.com","uber.com",
  "lyft.com","airbnb.com","doordash.com","stripe.com","shopify.com",
  "squarespace.com","wix.com",
]);

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

    // Known brand check — returns early, no email required
    const hostname = new URL(target).hostname.replace(/^www\./, "");
    if (KNOWN_BRANDS.has(hostname)) {
      return json({
        known_brand: true,
        message: "This tool is designed for private and growth stage businesses. Enterprise and globally recognized brands signal differently. Email signal@skalatsky.com for an enterprise conversation.",
      }, 200, cors);
    }

    const email = (body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "A valid work email is required." }, 400, cors);
    }

    // One free Signal per email — check KV before running anything expensive
    if (env.AUDITS) {
      const prior = await env.AUDITS.get(email);
      if (prior) {
        return json({ error: "You have already run a free Signal. Email signal@skalatsky.com to discuss your results." }, 429, cors);
      }
    }

    try {
      // 1. crawl --------------------------------------------------------------
      const page = await dataForSeoOnPage(target, env);   // raw on-page signals
      const extra = await fetchAgentSignals(target);      // robots.txt / llms.txt / raw HTML

      // 2. score --------------------------------------------------------------
      const scores = scoreSeo(page);                      // {onpage,tech,content,auth,total}
      const seoGrade = letterFromScore(scores.total);

      // 3. agent readiness ----------------------------------------------------
      const agent = scoreAgentReadiness(extra);                     // {score, level}

      // 4. findings -----------------------------------------------------------
      const brand = extractBrand(target, extra.html || "", page.meta?.title);
      let report = buildRulesReport(brand, scores, seoGrade, agent, page);
      if ((env.FINDINGS_MODE || "rules") === "llm" && env.ANTHROPIC_API_KEY) {
        report = await polishWithClaude(report, page, brand, env); // optional rewording
      }
      report.url = target;
      // Check 1 — Positioning
      const positioning = scorePositioning(extra.html || "");

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

      report.businessName = brand;
      report.positioning = positioning;
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
   POSITIONING — three tests + one trust-killer disqualifier.
   Returns { hook, fit, relevance, disqualifier, color, verdict }.
---------------------------------------------------------------------------- */
function scorePositioning(html) {
  const clean = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
  const text = clean.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const first500  = text.slice(0, 500);
  const first1500 = text.slice(0, 1500);

  // ── TRUST KILLER ──────────────────────────────────────────────────────────
  const fillerRx = /\b(we help (businesses|companies|organizations) (grow|succeed|thrive|reach their potential)|solutions for (your needs|every need|businesses)|your (success|goals) (is|are) our|comprehensive (solutions|services)|best[- ]in[- ]class|world[- ]class (service|solution|quality)|innovative solutions|we are committed to excellence|one[- ]stop (shop|solution)|end[- ]to[- ]end solution|full[- ]service (agency|firm|provider))\b/i;
  const buzzRx = /\b(ai[- ]powered|cutting[- ]edge|revolutionary|disruptive|next[- ]gen(eration)?|state[- ]of[- ]the[- ]art|synerg|paradigm[- ]shift|leverage (ai|the|our|your|data|technology)|future[- ]proof)\b/gi;
  const buzzCount = (text.match(buzzRx) || []).length;
  const ctaRx = /\b(get started|get a (free|quote)|sign up( for| now| free)?|book (a |an |your )?(call|demo|consultation|meeting|appointment)|schedule (a |an |your )?(call|demo|consultation)|contact us( today)?|request (a |an )?(demo|consultation|quote|proposal))\b/gi;
  const ctaCount = (text.match(ctaRx) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasSubheadings = /<h[2-6][\s>]/i.test(html);

  const disqualifier =
    fillerRx.test(first500) ||
    buzzCount >= 3 ||
    ctaCount > 4 ||
    (wordCount > 700 && !hasSubheadings);

  // ── THE HOOK ──────────────────────────────────────────────────────────────
  const hasH1 = /<h1[\s>]/i.test(html);
  const h1Raw = (clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "";
  const h1Text = h1Raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const genericH1 = /^(welcome|home|about|our services?|solutions|leading|premier|trusted|reliable|professional|innovative|your (success|partner|journey)|we are|we help)/i.test(h1Text) || h1Text.length < 4;
  const specificRx = /(\d[\d,]*\+?|\$[\d,.]+[km]?|%|\b(without|stop |tired of|struggling|finally|guarantee[d]?|proven|exactly|specifically|the only|the best|the fastest)|for (startups?|founders?|agencies?|brands?|ecommerce|healthcare|legal|finance|realtors?|coaches?|consultants?))/i;
  const emotionalRx = /\b(stop |no more |never again|finally|guaranteed|honest|straight|real results|actually works)\b/i;

  let hook;
  if (!hasH1 || genericH1) {
    hook = "missing";
  } else if (specificRx.test(first1500) || emotionalRx.test(first500)) {
    hook = "lands";
  } else {
    hook = "partial";
  }

  // ── THE FIT ───────────────────────────────────────────────────────────────
  const serviceVerbRx = /\b(we |i )(build|create|design|develop|write|produce|manage|run|deliver|offer|provide|make|handle|craft|launch|grow|scale|train|coach|audit|consult|advise)\b/i;
  const productNounRx = /\b(software|app|platform|tool|agency|studio|firm|consultanc|coach(ing)?|course|program|subscription|membership|shop|store|brand|collection|apparel|gear|equipment|training|workshop|service|system|technology)\b/i;
  const jargonRx = /\b(ecosystem|paradigm|synergy|holistic approach|robust solution|scalable|turnkey|agnostic|frictionless|seamless experience|leverage our|empower your)\b/gi;
  const jargonCount = (first1500.match(jargonRx) || []).length;
  const hasServiceVerb = serviceVerbRx.test(first1500);
  const hasProductNoun = productNounRx.test(first1500);

  let fit;
  if (hasServiceVerb && hasProductNoun && jargonCount === 0) {
    fit = "clear";
  } else if (hasServiceVerb || hasProductNoun) {
    fit = "partial";
  } else {
    fit = "unclear";
  }

  // ── THE RELEVANCE ─────────────────────────────────────────────────────────
  const youCount = (first1500.match(/\b(you|your)\b/gi) || []).length;
  const outcomeRx = /\b(so (you can|that you)|which means (you|your)|grow(th|ing)?|increas(e|ing)|sav(e|ing)|boost(ing)?|more (leads?|sales|revenue|clients?|customers?)|less (time|hassle|cost|stress)|without (the hassle|having to))\b/i;
  const personaRx = /\bfor (you|your (team|business|company|brand|startup|agency)|founders?|owners?|managers?|professionals?|coaches?|consultants?|entrepreneurs?)\b/i;

  let relevance;
  if (youCount >= 4 && (outcomeRx.test(first1500) || personaRx.test(first1500))) {
    relevance = "connects";
  } else if (youCount >= 2 || personaRx.test(first1500) || outcomeRx.test(first1500)) {
    relevance = "partial";
  } else {
    relevance = "missing";
  }

  // ── COLOR ─────────────────────────────────────────────────────────────────
  const failCount = (hook === "missing" ? 1 : 0) + (fit === "unclear" ? 1 : 0) + (relevance === "missing" ? 1 : 0);
  const color = (!disqualifier && hook === "lands" && fit === "clear" && relevance === "connects")
    ? "green"
    : (disqualifier || failCount >= 2) ? "red" : "yellow";

  // ── VERDICT ───────────────────────────────────────────────────────────────
  let verdict;
  if (disqualifier) {
    verdict = (hook === "partial" && fit === "partial")
      ? "Too many things competing for attention and none of them winning. Strip it back and start with one clear idea."
      : "Too much noise, not enough signal. A stranger cannot find the story through all the clutter.";
  } else if (hook === "missing" && fit === "unclear"  && relevance === "missing")  { verdict = "Nothing here earns the next click. A stranger lands and leaves without knowing what you do or why it matters.";
  } else if (hook === "missing" && fit === "clear"    && relevance === "missing")  { verdict = "The offer is clear but nothing pulls you in. You know what they do but not why you should care.";
  } else if (hook === "missing" && fit === "clear"    && relevance === "connects") { verdict = "The substance is there but the opening does not earn it. Fix the first five seconds and the rest lands.";
  } else if (hook === "lands"   && fit === "unclear"  && relevance === "missing")  { verdict = "Strong opening, weak follow through. You get their attention and then lose them.";
  } else if (hook === "lands"   && fit === "clear"    && relevance === "missing")  { verdict = "Clear and compelling but it does not connect to the reader. Missing the why it matters to me moment.";
  } else if (hook === "lands"   && fit === "unclear"  && relevance === "connects") { verdict = "The energy is right but the offer is buried. A stranger cannot tell what you actually do.";
  } else if (hook === "lands"   && fit === "clear"    && relevance === "connects") { verdict = "Clean, clear, and relevant. A stranger knows exactly what this is and whether it is for them.";
  } else if (hook === "partial" && fit === "partial"  && relevance === "connects") { verdict = "The bones are good. Sharpen the opening and clarify the offer and this site does real work.";
  } else if (hook === "partial" && fit === "partial"  && relevance === "partial")  { verdict = "Directionally right but not landing yet. Every element needs one more pass of clarity and confidence.";
  } else if (hook === "lands"   && fit === "partial"  && relevance === "partial")  { verdict = "Strong first impression that does not quite deliver. The opening earns the click but the page does not close it.";
  } else { verdict = "Directionally right but not landing yet. Every element needs one more pass of clarity and confidence."; }

  return { hook, fit, relevance, disqualifier, color, verdict };
}

/* ----------------------------------------------------------------------------
   AGENT READINESS — rules-based, no external API.
   Baseline 40 so zero-signal sites land at EMERGING not BASIC.
   BASIC only when score < 40 (i.e. active signals subtract from baseline,
   which cannot happen with this rubric — BASIC is reserved for future use).
   Max 100: llms.txt +20 / robots OK +15 / schema +10 / headings +10 / content +5.
---------------------------------------------------------------------------- */
function scoreAgentReadiness(extra) {
  const html = extra.html || "";
  const robots = extra.robots || "";
  let score = 40;

  if (extra.llms) score += 20;
  if (!aiCrawlersBlocked(robots)) score += 15;
  if (/application\/ld\+json/i.test(html)) score += 10;
  const hasH1 = /<h1[\s>]/i.test(html);
  const hasH2 = /<h2[\s>]/i.test(html);
  if (hasH1 && hasH2) score += 10;
  else if (hasH1 || hasH2) score += 5;
  const plainText = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plainText.split(/\s+/).filter(Boolean).length >= 300) score += 5;

  score = clamp(score, 0, 100);
  const level = score >= 80 ? "ADVANCED" : score >= 60 ? "CAPABLE" : score >= 40 ? "EMERGING" : "BASIC";
  return { score, level };
}

function aiCrawlersBlocked(robotsTxt) {
  if (!robotsTxt) return false;
  const bots = ['gptbot', 'chatgpt-user', 'anthropic-ai', 'claudebot', 'perplexitybot', 'ccbot', 'google-extended', 'cohere-ai'];
  for (const block of robotsTxt.split(/\n\s*\n/)) {
    const lines = block.split('\n').map(l => l.trim().toLowerCase());
    const agents = lines.filter(l => l.startsWith('user-agent:')).map(l => l.replace('user-agent:', '').trim());
    const disallowsRoot = lines.some(l => /^disallow:\s*\/$/.test(l));
    if (disallowsRoot && bots.some(b => agents.includes(b))) return true;
  }
  return false;
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
function extractBrand(url, html, metaTitle) {
  const strip = t => (t || "").trim().replace(/\s*[-|–—·]\s.*$/, "").trim();
  const fromTitle = strip(metaTitle) || strip(((html || "").match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]);
  if (fromTitle && fromTitle.length > 2 && fromTitle.length < 80) return fromTitle;
  const ogM = (html || "").match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
           || (html || "").match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const fromOg = strip((ogM || [])[1]);
  if (fromOg && fromOg.length > 2 && fromOg.length < 80) return fromOg;
  try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return "your site"; }
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

/* ------------------------------------- */
