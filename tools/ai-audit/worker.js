import puppeteer from "@cloudflare/puppeteer";

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

    // Compare action — separate from the main audit flow, no email/KV required
    if (body.action === "compare") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "api not configured" }, 503, cors);
      const admiredUrl = normalizeUrl(body.admiredUrl);
      if (!admiredUrl) return json({ error: "invalid admired url" }, 400, cors);
      let admiredHtml = "";
      try { admiredHtml = await (await fetch(admiredUrl)).text(); } catch {}
      const admiredPositioning = scorePositioning(admiredHtml);
      const enrichedSignal = await getCompareSignal(body, admiredHtml, admiredPositioning, admiredUrl, env);
      return json({ enrichedSignal, admiredPositioning, admiredUrl }, 200, cors);
    }

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
      const rawPage = await dataForSeoOnPage(target, env);  // raw on-page signals
      const extra = await fetchAgentSignals(target, env);    // robots.txt / llms.txt / raw HTML

      // If DataForSEO meta is empty (title + word_count both null), it could not
      // fully parse the page — common with JS-heavy frameworks. Detect the
      // framework from the direct-fetch HTML and patch the page object with
      // signals we can extract from the initial HTML response.
      const jsFramework = detectJsFramework(extra.html || "");
      const page = (jsFramework && !rawPage.meta?.title)
        ? patchPageFromHtml(rawPage, extractHtmlMeta(extra.html || "", target))
        : rawPage;

      // 2. score --------------------------------------------------------------
      const scores = scoreSeo(page);                      // {onpage,tech,content,auth,total}
      const seoGrade = letterFromScore(scores.total);

      // 3. agent readiness ----------------------------------------------------
      const agent = scoreAgentReadiness(extra, scores, seoGrade);    // {score, level}

      // 4. findings -----------------------------------------------------------
      const brand = extractBrand(target, extra.html || "", page.meta?.title);
      let report = buildRulesReport(brand, scores, seoGrade, agent, page);
      if ((env.FINDINGS_MODE || "rules") === "llm" && env.ANTHROPIC_API_KEY) {
        report = await polishWithClaude(report, page, brand, env); // optional rewording
      }
      report.url = target;

      // Flag JS framework sites so the front end can show a caveat
      if (jsFramework) {
        report.jsFramework = jsFramework;
        report.seoGradeDesc += ` Scored from initial HTML — this site uses ${jsFramework} rendering so some signals may differ from the fully rendered page.`;
      }

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

      // Forward Signal — Claude-generated opportunity observation
      if (env.ANTHROPIC_API_KEY) {
        const fwd = await getForwardSignal(extra.html, positioning, seoGrade, report.findings, agent.level, env);
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
   Falls back to Browser Rendering when the raw fetch returns thin HTML.
---------------------------------------------------------------------------- */
async function fetchAgentSignals(url, env) {
  const origin = new URL(url).origin;
  const out = { robots: "", llms: false, html: "", rendering_mode: "fetch" };
  try { out.html = await (await fetch(url)).text(); } catch {}

  if (isThinHtml(out.html) && env && env.BROWSER) {
    console.warn(`Thin HTML detected for ${url} — triggering Browser Rendering fallback`);
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
      out.html = await page.content();
      out.rendering_mode = "browser";
    } catch (e) {
      console.warn("Browser Rendering fallback failed:", String(e));
    } finally {
      if (browser) { try { await browser.close(); } catch {} }
    }
  }

  try { out.robots = await (await fetch(origin + "/robots.txt")).text(); } catch {}
  try { out.llms = (await fetch(origin + "/llms.txt")).ok; } catch {}
  return out;
}

function isThinHtml(html) {
  if (!html) return true;
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 1500) return true;
  const elemCount = (html.match(/<(p|h[1-6])[\s>]/gi) || []).length;
  if (elemCount < 3) return true;
  return false;
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

  const disqualifierFiller = fillerRx.test(first500);
  const disqualifierBuzz   = buzzCount >= 3;
  const disqualifierCta    = ctaCount > 4;
  const disqualifierWall   = wordCount > 700 && !hasSubheadings;
  const disqualifier = disqualifierFiller || disqualifierBuzz || disqualifierCta || disqualifierWall;

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
    if (disqualifierFiller)
      verdict = "The language on this site signals nothing. Phrases like 'we help businesses grow' are placeholders, not positioning. A stranger reads this and cannot tell what you do or who you serve.";
    else if (disqualifierBuzz)
      verdict = "Too much jargon, not enough substance. Strip the buzzwords and say the specific thing you do for the specific people you serve.";
    else if (disqualifierCta)
      verdict = "Every line is pushing for action before making a case. Pull back the calls to action and build the argument first.";
    else
      verdict = "No structure, no signal. A wall of copy without headings means a reader cannot find what matters, and neither can Google.";

  // hook = lands
  } else if (hook === "lands" && fit === "clear"   && relevance === "connects") {
    verdict = "This site is firing on all cylinders. The opening lands, the offer is clear, and the reader immediately sees what is in it for them.";
  } else if (hook === "lands" && fit === "clear"   && relevance === "partial") {
    verdict = "Strong fundamentals with a targeting gap. The brand lands and the offer is clear, but it speaks to everyone rather than pulling the right person in by name.";
  } else if (hook === "lands" && fit === "clear"   && relevance === "missing") {
    verdict = "Clear and compelling but it does not connect to the reader. The offer is visible but the why it matters to me moment never arrives.";
  } else if (hook === "lands" && fit === "partial" && relevance === "connects") {
    verdict = "The opening grabs attention and the relevance is there, but the offer is not sharp enough to close it. Tighten what you do and for whom.";
  } else if (hook === "lands" && fit === "partial" && relevance === "partial") {
    verdict = "Strong first impression that does not quite deliver. The opening earns the click but the page does not close it.";
  } else if (hook === "lands" && fit === "unclear" && relevance === "partial") {
    verdict = "Strong first impression that does not quite deliver. The opening earns the click but the page does not close it.";
  } else if (hook === "lands" && fit === "partial" && relevance === "missing") {
    verdict = "The opening works but the page loses the reader. The offer is hazy and there is no connection to why it matters.";
  } else if (hook === "lands" && fit === "unclear" && relevance === "connects") {
    verdict = "The energy is right but the offer is buried. A stranger feels something here but cannot tell what they are supposed to do next.";
  } else if (hook === "lands" && fit === "unclear" && relevance === "missing") {
    verdict = "Strong opening, weak follow through. The hook grabs attention but the offer and the connection to the reader both fall away before the page earns anything.";

  // hook = partial
  } else if (hook === "partial" && fit === "clear" && relevance === "connects") {
    verdict = "Clear and relevant but the opening does not earn it. A sharper hook would turn this from a good site into one that converts.";
  } else if (hook === "partial" && fit === "clear" && relevance === "partial") {
    verdict = "The offer is clear but the site is not making a case for itself. Sharpen the opening and connect it to a specific outcome for the reader.";
  } else if (hook === "partial" && fit === "clear" && relevance === "missing") {
    verdict = "Clear enough to read but not compelling enough to act. No hook, no connection, no reason for a stranger to care.";
  } else if (hook === "partial" && fit === "partial" && relevance === "connects") {
    verdict = "The bones are good. Sharpen the opening and clarify the offer and this site does real work.";
  } else if (hook === "partial" && fit === "partial" && relevance === "partial") {
    verdict = "Not landing yet. The hook is soft, the offer is unclear, and the reader has no real reason to engage. Every element needs a sharper point of view.";
  } else if (hook === "partial" && fit === "partial" && relevance === "missing") {
    verdict = "Soft opening, vague offer, no connection to the reader. Pick one thing this site is for and say it plainly at the top.";
  } else if (hook === "partial" && fit === "unclear" && relevance === "connects") {
    verdict = "The reader connects with the message but cannot tell what is being offered. Clarity of fit is the missing piece.";
  } else if (hook === "partial" && fit === "unclear" && relevance === "partial") {
    verdict = "Starting to land but not sticking. The opening is vague, the offer is buried, and the reader has to work too hard to find the point.";
  } else if (hook === "partial" && fit === "unclear" && relevance === "missing") {
    verdict = "No hook, no clear offer, no connection to the reader. This site is not yet doing any work for the business.";

  // hook = missing + fit = unclear (any relevance)
  } else if (hook === "missing" && fit === "unclear") {
    verdict = "The site is not doing its job yet. A stranger cannot tell what this is, who it is for, or why it matters.";

  // hook = missing + fit = clear
  } else if (hook === "missing" && fit === "clear" && relevance === "connects") {
    verdict = "The substance is there but the opening does not earn it. Fix the first five seconds and the rest lands.";
  } else if (hook === "missing" && fit === "clear" && relevance === "partial") {
    verdict = "Clear enough to understand but not compelling enough to act. The fit is there but nothing pulls the reader in.";
  } else if (hook === "missing" && fit === "clear" && relevance === "missing") {
    verdict = "The offer is visible but nothing earns the reader's attention. No hook, no connection, no reason to stay.";

  // hook = missing + fit = partial (any relevance)
  } else if (hook === "missing" && fit === "partial") {
    verdict = "Hard to tell what this is or why it matters from the outside. The offer is implied but never earned, and the reader has no reason to dig deeper.";

  } else {
    verdict = "This site is not yet making its case. The opening, the offer, and the connection to the reader all need work before a stranger would stop and engage.";
  }

  return { hook, fit, relevance, disqualifier, color, verdict };
}

/* ----------------------------------------------------------------------------
   AGENT READINESS — rules-based, no external API.
   Baseline 40 so zero-signal sites land at EMERGING not BASIC.
   BASIC only when score < 40 (i.e. active signals subtract from baseline,
   which cannot happen with this rubric — BASIC is reserved for future use).
   Max 100: llms.txt +20 / robots OK +15 / schema +10 / headings +10 / content +5.
---------------------------------------------------------------------------- */
function scoreAgentReadiness(extra, scores, seoGrade) {
  const html = extra.html || "";
  const robots = extra.robots || "";
  let score = 40;

  const crawlersBlocked = aiCrawlersBlocked(robots);
  if (extra.llms) score += 20;
  if (!crawlersBlocked) score += 15;
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
  let level = score >= 80 ? "ADVANCED" : score >= 60 ? "CAPABLE" : score >= 40 ? "EMERGING" : "BASIC";

  // SEO-quality gates: AI readiness cannot outrun the underlying content and authority.
  // A site Google cannot parse is a site AI assistants cannot parse either.
  const base = (seoGrade || "F").charAt(0);
  const contentBand = scores.content >= 24 ? "strong" : scores.content >= 18 ? "ok" : scores.content >= 12 ? "weak" : "critical";
  const authBand    = scores.auth    >=  8 ? "strong" : scores.auth    >=  6 ? "ok" : scores.auth    >=  4 ? "weak" : "critical";

  // F grade: cap at EMERGING regardless of signals
  if (base === "F" && (level === "CAPABLE" || level === "ADVANCED")) level = "EMERGING";
  // D grade + critical authority: cap at EMERGING
  if (base === "D" && authBand === "critical" && (level === "CAPABLE" || level === "ADVANCED")) level = "EMERGING";
  // ADVANCED requires strong content AND strong authority
  if (level === "ADVANCED" && !(contentBand === "strong" && authBand === "strong")) level = "CAPABLE";
  // CAPABLE requires at least ok content AND at least weak (non-critical) authority
  if (level === "CAPABLE" && !((contentBand === "strong" || contentBand === "ok") && authBand !== "critical")) level = "EMERGING";

  return { score, level, crawlersBlocked };
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
      ? `${B} pages are missing the title tags search engines read first, so you show up as a blank guess in search results when you show up at all.`
      : `${B} is missing core on-page tags search engines use to rank pages, so you are competing for almost nothing you could be winning.`,
    weak: c.duplicate_title
      ? `Several pages share the same title, so search engines can't tell them apart or rank them for different searches.`
      : `Titles and descriptions read like internal labels rather than what your buyers actually search for.`,
    ok: `Search engines can index ${B} cleanly; the opportunity now is targeting the specific phrases your buyers use.`,
    strong: `${B} is fully indexed with clear, distinct titles, so search engines know exactly what to rank you for.`,
  });

  const firstImp = finding("First Impressions", band(scores.tech, 30), {
    critical: `Core pages load slowly enough that most visitors leave before seeing anything, and search engines count that against you.`,
    weak: `The site is fine on desktop but lags on mobile, where most of your traffic actually arrives.`,
    ok: `Load speed is reasonable; tightening images and scripts would move ${B} from fine to fast.`,
    strong: `Pages load fast and stay stable as they render on desktop and mobile, exactly what search engines and AI reward.`,
  });

  const structure = finding("Content Structure", band(scores.content, 30), {
    critical: `Pages have little heading structure, so search engines and AI assistants can't parse what ${B} does or who it serves.`,
    weak: ((meta.content?.plain_text_word_count ?? 0) < 300)
      ? `Key pages are too thin for search engines to treat them as authoritative answers.`
      : `Headings skip levels and repeat, so the page hierarchy reads as confusing to a search engine.`,
    ok: `Content is organized well enough to read; clear Q&A sections would help ${B} appear in AI and featured results.`,
    strong: `Content is cleanly structured with clear headings, which both search engines and AI assistants can read and quote.`,
  });

  const authority = finding("Authority", band(scores.auth, 10), {
    critical: `Almost no reputable sites link to ${B}, so search engines have little reason to trust it over competitors.`,
    weak: `Your link profile is thin compared to the sites currently outranking ${B}.`,
    ok: `${B} has a reasonable authority foundation but trails the top competitors in your space.`,
    strong: `${B} has earned links from credible sources, giving search engines solid reason to trust and rank it.`,
  });

  const base = seoGrade.charAt(0);
  const authBand = band(scores.auth, 10);
  const hasSchema = !!(c.has_micromarkup);

  let agentLine;
  switch (agent.level) {
    case "BASIC":
      if (agent.crawlersBlocked)
        agentLine = "Your site is actively blocking AI assistants from reading it. Until that changes you will not appear in any AI generated recommendations.";
      else if (base === "F")
        agentLine = "Your site is effectively invisible to AI assistants. There is not enough structure or content for them to understand what you do or who you serve.";
      else
        agentLine = "AI assistants can barely read your site. When someone asks for a business like yours, you are not in the conversation.";
      break;
    case "EMERGING":
      if (base === "D" || base === "F")
        agentLine = "AI assistants can find you but there is not enough content for them to explain what you do, so you rarely appear when buyers ask for help.";
      else if (scores.content < 18)
        agentLine = "AI assistants can read your pages but have no structured signals to work from, so competitors with cleaner markup get cited ahead of you.";
      else
        agentLine = "AI assistants can find you but struggle to understand what you offer, so you rarely get recommended when buyers ask for help.";
      break;
    case "CAPABLE":
      if (authBand === "weak" || authBand === "critical")
        agentLine = "Your site is readable to AI assistants and can appear in their answers, but thin authority means better known competitors get cited first.";
      else if (base === "C")
        agentLine = "AI assistants can read you but competitors with cleaner structure and more content are usually cited ahead of you.";
      else
        agentLine = "Your site is readable to AI assistants and can appear in their answers, though competitors with cleaner structure are usually cited first.";
      break;
    case "ADVANCED":
      if (hasSchema)
        agentLine = "AI assistants can clearly read and summarize your site, and your structured data helps them cite you accurately when buyers ask for a business like yours.";
      else if (base === "A")
        agentLine = "Your site is fully optimized for AI discovery. You are positioned to be the first recommendation when buyers ask AI tools for a business like yours.";
      else
        agentLine = "AI assistants can clearly read and summarize your site, so you are positioned to be recommended when buyers ask for a business like yours.";
      break;
    default:
      agentLine = "AI assistants can find you but struggle to understand what you offer, so you rarely get recommended when buyers ask for help.";
  }

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
    F: `Critical. Search engines and AI assistants are struggling to understand and rank ${B} at all.`,
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
    agentLine,
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
   THE FORWARD SIGNAL — single Claude call for highest-leverage opportunity.
---------------------------------------------------------------------------- */
async function getForwardSignal(pageHtml, positioning, seoGrade, findings, agentLevel, env) {
  const plainText = (pageHtml || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  const systemPrompt =
    "You are a senior marketing and GTM advisor reviewing a private company website. " +
    "Based on the positioning verdict, SEO grade, and agent readiness provided, generate exactly one observation " +
    "identifying the single highest leverage opportunity this business is leaving on the table right now. " +
    "Frame it as an opportunity not a problem. Be specific to what you read on the page. " +
    "Sound like a knowledgeable advisor pointing at something the owner has not seen yet, not a tool generating generic advice. " +
    "Be encouraging but direct. Never be harsh. Never use the word audit. Never be generic. " +
    "If you cannot generate a specific confident observation based on what you read, return nothing. " +
    "The response must be exactly two sentences. Hard limit: two sentences, no more. If you cannot say it in two sentences, cut — do not add a third. " +
    "Never use em dashes, hyphens used as dashes, or asterisks for emphasis anywhere in your response.";

  const userContent =
    `Page content: ${plainText}\n\n` +
    `Positioning verdict: ${positioning.verdict}\n` +
    `Hook: ${positioning.hook}, Fit: ${positioning.fit}, Relevance: ${positioning.relevance}\n` +
    `SEO grade: ${seoGrade}\n` +
    `Finding statuses: ${findings.map(f => `${f.category}: ${f.status}`).join(", ")}\n` +
    `Agent readiness: ${agentLevel}`;

  try {
    const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 250,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: reqBody,
    });
    if (!res.ok) { const errBody = await res.text(); console.warn("Forward Signal HTTP error:", res.status, errBody || "(empty body)"); return null; }
    const data = await res.json();
    if (data?.error) { console.warn("Forward Signal API error:", JSON.stringify(data.error)); return null; }
    const raw = (data?.content?.[0]?.text || "").trim();
    return raw ? sanitizeForwardSignal(raw) : null;
  } catch (e) {
    console.warn("Forward Signal exception:", String(e));
    return null;
  }
}

/* ----------------------------------------------------------------------------
   helpers
---------------------------------------------------------------------------- */
function detectJsFramework(html) {
  if (!html) return null;
  if (/__NEXT_DATA__/.test(html))                                 return "Next.js";
  if (/__NUXT__/.test(html))                                      return "Nuxt";
  if (/\bng-version\b/.test(html))                                return "Angular";
  if (/<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(html))    return "React";
  if (/<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html))     return "Vue";
  return null;
}

function extractHtmlMeta(html, url) {
  const title = ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "").trim();
  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)
             || html.match(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']description["']/i);
  const description = ((descM || [])[1] || "").trim();
  const hasH1 = /<h1[\s>]/i.test(html);
  const hasSchema = /application\/ld\+json/i.test(html);
  const isHttps = /^https:\/\//i.test(url);
  const plainText = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  return { title, description, hasH1, hasSchema, isHttps, wordCount };
}

function patchPageFromHtml(page, fb) {
  const checks = Object.assign({}, page.checks || {});
  const meta = Object.assign({}, page.meta || {});
  if (!meta.title && fb.title) { meta.title = fb.title; checks.no_title = false; }
  if (!meta.description && fb.description) { meta.description = fb.description; checks.no_description = false; }
  if (!meta.content?.plain_text_word_count && fb.wordCount) {
    meta.content = Object.assign({}, meta.content || {}, { plain_text_word_count: fb.wordCount });
  }
  if (checks.no_h1_tag == null && fb.hasH1)       checks.no_h1_tag = false;
  if (checks.has_micromarkup == null && fb.hasSchema) checks.has_micromarkup = true;
  if (checks.is_https == null)                    checks.is_https = fb.isHttps;
  return Object.assign({}, page, { meta, checks });
}

function sanitizeForwardSignal(text) {
  let s = text
    .replace(/\s*—\s*/g, ", ")   // em dash with spaces → comma + space
    .replace(/—/g, "")            // bare em dash → nothing
    .replace(/\*/g, "")           // asterisks → nothing
    .replace(/[#`]/g, "")         // pound signs and backticks → nothing
    .replace(/  +/g, " ")         // collapse double spaces
    .trim();
  // Hard cap: at most 2 sentences — cut at the end of the 2nd sentence boundary.
  let count = 0, cutAt = s.length;
  const rx = /[.!?](?=\s|$)/g;
  let m;
  while ((m = rx.exec(s)) !== null) { count++; if (count === 2) { cutAt = m.index + 1; break; } }
  s = s.slice(0, cutAt).trim();
  if (s.length <= 400) return s;
  // Truncate at the nearest sentence boundary before 400 chars, never mid-sentence.
  const boundary = s.slice(0, 400).lastIndexOf(". ");
  return boundary > 0 ? s.slice(0, boundary + 1).trim() : s.slice(0, 400).trim();
}

/* ----------------------------------------------------------------------------
   COMPARE SIGNAL — enriched forward signal that references an admired site.
---------------------------------------------------------------------------- */
async function getCompareSignal(originalData, admiredHtml, admiredPositioning, admiredUrl, env) {
  const admiredPlain = admiredHtml
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);

  if (!admiredPlain) return null;

  const systemPrompt =
    "You are a senior marketing and GTM advisor. " +
    "Given a website's audit results and a site the owner admires, generate exactly two sentences " +
    "identifying the single highest-leverage opportunity for the prospect, " +
    "specifically referencing what the admired site does well and how that specific move applies to the prospect's situation. " +
    "Be concrete: name the specific thing the admired site does and connect it directly to what the prospect can do. " +
    "Frame it as an opportunity, not a critique. Sound like a knowledgeable advisor, not a generic tool. " +
    "Exactly two sentences. Hard limit — do not add a third. " +
    "Never use em dashes, hyphens used as dashes, or asterisks for emphasis.";

  const userContent =
    `Prospect SEO grade: ${originalData.seoGrade || "unknown"}\n` +
    `Prospect agent readiness: ${originalData.agentLevel || "unknown"}\n` +
    `Prospect positioning: Hook ${originalData.positioningHook || "?"}, Fit ${originalData.positioningFit || "?"}, Relevance ${originalData.positioningRelevance || "?"}\n` +
    `Prospect positioning verdict: ${originalData.positioningVerdict || ""}\n` +
    `Prospect finding statuses: ${(originalData.findings || []).map(f => `${f.category}: ${f.status}`).join(", ")}\n` +
    `Original forward signal: ${originalData.originalSignal || ""}\n\n` +
    `Admired site (${admiredUrl}) content excerpt: ${admiredPlain}\n` +
    `Admired site positioning: Hook ${admiredPositioning.hook}, Fit ${admiredPositioning.fit}, Relevance ${admiredPositioning.relevance}\n` +
    `Admired site positioning verdict: ${admiredPositioning.verdict}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": (env.ANTHROPIC_API_KEY || "").trim(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 250,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.error) return null;
    const raw = (data?.content?.[0]?.text || "").trim();
    return raw ? sanitizeForwardSignal(raw) : null;
  } catch { return null; }
}

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
