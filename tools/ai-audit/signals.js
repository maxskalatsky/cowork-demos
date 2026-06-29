/* ----------------------------------------------------------------------------
   Claude API calls — business type inference, forward signal, compare signal,
   and optional LLM polish of findings.
---------------------------------------------------------------------------- */

export async function inferBusinessType(html, url, env) {
  if (!env.ANTHROPIC_API_KEY || !html) return null;
  const plainText = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
  if (plainText.length < 100) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content:
          `Classify this website. URL: ${url}\n\nContent: ${plainText}\n\n` +
          `Return only valid JSON with these fields:\n` +
          `- type: one of "platform","saas","agency","consultancy","ecommerce","local_service","professional_services","media","other"\n` +
          `- isPlatform: true if this is a marketplace, hosting provider, domain registrar, website builder, payment processor, CRM, or similar tool that serves many other businesses\n` +
          `- audience: one phrase describing who this site serves (e.g. "small business owners", "enterprise HR teams", "B2B software buyers")\n` +
          `- purpose: one phrase describing what success looks like for this site (e.g. "drive free trial signups", "generate enterprise demo requests", "sell domain registrations")\n` +
          `No other text, only the JSON object.`
        }],
      }),
    });
    const data = await res.json();
    const raw = (data?.content?.[0]?.text || "").trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      type: parsed.type || "other",
      isPlatform: !!parsed.isPlatform,
      audience: parsed.audience || "",
      purpose: parsed.purpose || "",
    };
  } catch { return null; }
}

/* ----------------------------------------------------------------------------
   THE FORWARD SIGNAL — single Claude call for highest-leverage opportunity.
---------------------------------------------------------------------------- */
export async function getForwardSignal(pageHtml, positioning, seoGrade, findings, agentLevel, businessCtx, profile, env) {
  const plainText = (pageHtml || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  const siteContext = businessCtx
    ? (businessCtx.isPlatform
        ? `This is a platform or tool (type: ${businessCtx.type}) serving ${businessCtx.audience || "other businesses"}. Its goal is to ${businessCtx.purpose || "acquire users"}. Evaluate the opportunity in that context — do not penalize it for being a platform. `
        : `This site serves ${businessCtx.audience || "prospective clients"} and aims to ${businessCtx.purpose || "generate leads"}. `)
    : "";

  let weightContext = "";
  if (profile && profile.weights) {
    const entries = Object.entries(profile.weights).sort((a, b) => b[1] - a[1]);
    const [topKey, topVal] = entries[0];
    const dimLabel = { positioning: "brand positioning and message clarity", seo: "SEO visibility", agent: "AI agent readiness" }[topKey] || topKey;
    weightContext = `For this site, ${dimLabel} is the highest-priority dimension (${topVal}% of overall signal weight). Lead your observation with what most impacts ${dimLabel}. `;
  }

  const systemPrompt =
    "You are a senior marketing and GTM advisor reviewing a private company website. " +
    siteContext +
    weightContext +
    "Based on the positioning verdict, SEO grade, and agent readiness provided, generate exactly one observation " +
    "identifying the single highest leverage opportunity this business is leaving on the table right now. " +
    "Frame it as an opportunity not a problem. Be specific to what you read on the page. " +
    "Sound like a knowledgeable advisor pointing at something the owner has not seen yet, not a tool generating generic advice. " +
    "Be encouraging but direct. Never be harsh. Never use the word audit. Never be generic. " +
    "If you cannot generate a specific confident observation based on what you read, return nothing. " +
    "Write exactly three complete sentences. Each sentence must be under 30 words. " +
    "Use plain, direct language a business owner can understand without marketing experience. " +
    "No subordinate clauses. No stacked ideas in a single sentence. One thought per sentence. " +
    "Sentence one: name the single most important observation about this site. " +
    "Sentence two: explain why it matters for this specific business in one plain sentence. " +
    "Sentence three: state the one concrete thing the owner can act on. " +
    "If your output is more than three sentences, return only the first three. " +
    "Do not truncate mid-sentence. Never use em dashes, hyphens as dashes, or asterisks.";

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
      max_tokens: 400,
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
    if (/\b(content was blocked|page was blocked|was blocked|unable to (access|read)|could not (access|read)|couldn.t (access|read)|page content (was|is))\b/i.test(raw)) return null;
    return raw ? sanitizeForwardSignal(raw) : null;
  } catch (e) {
    console.warn("Forward Signal exception:", String(e));
    return null;
  }
}

/* ----------------------------------------------------------------------------
   COMPARE SIGNAL — enriched forward signal that references an admired site.
---------------------------------------------------------------------------- */
export async function getCompareSignal(originalData, admiredHtml, admiredPositioning, admiredSeoGrade, admiredAgentLevel, admiredUrl, env) {
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
    "Write exactly two complete sentences. Each sentence must be under 30 words. " +
    "Plain language only. One thought per sentence. No subordinate clauses. " +
    "Sentence one: name the specific thing the admired site does well. " +
    "Sentence two: state the one concrete move the prospect can apply to their own site. " +
    "Do not truncate mid-sentence. Never use em dashes, hyphens as dashes, or asterisks.";

  const userContent =
    `Prospect SEO grade: ${originalData.seoGrade || "unknown"}\n` +
    `Prospect agent readiness: ${originalData.agentLevel || "unknown"}\n` +
    `Prospect positioning: Hook ${originalData.positioningHook || "?"}, Fit ${originalData.positioningFit || "?"}, Relevance ${originalData.positioningRelevance || "?"}\n` +
    `Prospect positioning verdict: ${originalData.positioningVerdict || ""}\n` +
    `Prospect finding statuses: ${(originalData.findings || []).map(f => `${f.category}: ${f.status}`).join(", ")}\n` +
    `Original forward signal: ${originalData.originalSignal || ""}\n\n` +
    `Admired site (${admiredUrl}) content excerpt: ${admiredPlain}\n` +
    `Admired site positioning: Hook ${admiredPositioning.hook}, Fit ${admiredPositioning.fit}, Relevance ${admiredPositioning.relevance}\n` +
    `Admired site positioning verdict: ${admiredPositioning.verdict}\n` +
    `Admired site SEO grade: ${admiredSeoGrade}\n` +
    `Admired site agent readiness: ${admiredAgentLevel}`;

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

/* Optional LLM polish: hand Claude the raw checks + the rules draft and ask it
   to rewrite the four findings in plain business language for THIS site. */
export async function polishWithClaude(report, page, brand, env) {
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
   ENTERPRISE BENCHMARK SIGNAL — two-sentence observation for a private
   operator studying a known brand's digital presence.
---------------------------------------------------------------------------- */
export async function getEnterpriseBenchmarkSignal(html, brandName, dimensions, url, env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const plainText = (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
  if (plainText.length < 50) return null;

  const systemPrompt =
    "You are a senior marketing strategist. " +
    "A private company operator is studying " + brandName + " as a benchmark. " +
    "Based on the enterprise scoring data provided, write exactly three complete sentences. " +
    "Each sentence must be under 30 words. " +
    "Use plain, direct language a business owner can understand without marketing experience. " +
    "No subordinate clauses. No stacked ideas in a single sentence. One thought per sentence. " +
    "Sentence one: name the single most important observation about this site. " +
    "Sentence two: explain why it matters for this specific business in one plain sentence. " +
    "Sentence three: state the one concrete thing the owner can act on. " +
    "If your output is more than three sentences, return only the first three. " +
    "Do not truncate mid-sentence. Never use em dashes, hyphens as dashes, or asterisks.";

  const userContent =
    `Brand: ${brandName} (${url})\n` +
    `Brand Authority: ${dimensions.brandAuthority.label} (tier ${dimensions.brandAuthority.tier}) — ${dimensions.brandAuthority.text}\n` +
    `Audience Clarity: ${dimensions.audienceClarity.label} (tier ${dimensions.audienceClarity.tier}) — ${dimensions.audienceClarity.text}\n` +
    `AI Visibility: ${dimensions.aiVisibility.label} (tier ${dimensions.aiVisibility.tier}) — ${dimensions.aiVisibility.text}\n` +
    `Content Depth: ${dimensions.contentDepth.label} (tier ${dimensions.contentDepth.tier}) — ${dimensions.contentDepth.text}\n\n` +
    `Page excerpt: ${plainText}`;

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
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.content?.[0]?.text || "").trim();
    return raw ? sanitizeForwardSignal(raw) : null;
  } catch { return null; }
}

function sanitizeForwardSignal(text) {
  let s = text
    .replace(/\s*—\s*/g, ", ")
    .replace(/—/g, "")
    .replace(/\*/g, "")
    .replace(/[#`]/g, "")
    .replace(/  +/g, " ")
    .trim();
  // Return the first three complete sentences. Never truncate mid-sentence.
  let count = 0, cutAt = s.length;
  const rx = /[.!?](?=\s|$)/g;
  let m;
  while ((m = rx.exec(s)) !== null) { count++; if (count === 3) { cutAt = m.index + 1; break; } }
  return s.slice(0, cutAt).trim();
}
