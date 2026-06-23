import { getPositioningVerdict, getAgentLine, SEO_GRADE_TITLE, getSeoGradeDesc } from "./verdicts.js";

/* ----------------------------------------------------------------------------
   SCORING — Anya's rubric. Map DataForSEO checks onto four buckets.
   OnPage 30 / Technical 30 / Content+Keyword 30 / Backlinks+Authority 10
---------------------------------------------------------------------------- */
export function scoreSeo(page) {
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
export function letterFromScore(s) {
  const L = s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : "F";
  if (L === "F") return "F";
  const ones = s % 10;
  return L + (ones >= 7 ? "+" : ones <= 2 ? "−" : "");
}

/* ----------------------------------------------------------------------------
   POSITIONING — three tests + one trust-killer disqualifier.
   Returns { hook, fit, relevance, disqualifier, color, verdict }.
---------------------------------------------------------------------------- */
export function scorePositioning(html, ctx) {
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
  // Platforms (hosting, website builders, registrars, SaaS tools) use broad CTAs and buzz by design — suppress Trust Killer
  const isPlatform = ctx?.isPlatform === true;
  const disqualifier = isPlatform ? false : (disqualifierFiller || disqualifierBuzz || disqualifierCta || disqualifierWall);

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

  const verdict = getPositioningVerdict(disqualifier, disqualifierFiller, disqualifierBuzz, disqualifierCta, hook, fit, relevance);

  return { hook, fit, relevance, disqualifier, color, verdict };
}

/* ----------------------------------------------------------------------------
   AGENT READINESS — rules-based, no external API.
---------------------------------------------------------------------------- */
export function scoreAgentReadiness(extra, scores, seoGrade) {
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

  const base = (seoGrade || "F").charAt(0);
  const contentBand = scores.content >= 24 ? "strong" : scores.content >= 18 ? "ok" : scores.content >= 12 ? "weak" : "critical";
  const authBand    = scores.auth    >=  8 ? "strong" : scores.auth    >=  6 ? "ok" : scores.auth    >=  4 ? "weak" : "critical";

  if (base === "F" && (level === "CAPABLE" || level === "ADVANCED")) level = "EMERGING";
  if (base === "D" && authBand === "critical" && (level === "CAPABLE" || level === "ADVANCED")) level = "EMERGING";
  if (level === "ADVANCED" && !(contentBand === "strong" && authBand === "strong")) level = "CAPABLE";
  if (level === "CAPABLE" && !((contentBand === "strong" || contentBand === "ok") && authBand !== "critical")) level = "EMERGING";

  return { score, level, crawlersBlocked };
}

export function aiCrawlersBlocked(robotsTxt) {
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
   FINDINGS — rules mode.
---------------------------------------------------------------------------- */
export function buildRulesReport(brand, scores, seoGrade, agent, page) {
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
  const hasSchema = !!(c.has_micromarkup);
  const agentLine = getAgentLine(agent, base, scores, hasSchema);

  return {
    seoGrade,
    seoScore: scores.total,
    seoGradeTitle: SEO_GRADE_TITLE[base],
    seoGradeDesc: getSeoGradeDesc(base, B),
    findings: [visibility, firstImp, structure, authority],
    agentLevel: agent.level,
    agentScore: agent.score,
    agentLine,
  };
}

function finding(category, status, byBand) { return { category, status, text: byBand[status] }; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
