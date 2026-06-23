import puppeteer from "@cloudflare/puppeteer";

export async function dataForSeoOnPage(url, env) {
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
  return item;
}

export async function dataForSeoBacklinks(target, env) {
  const auth = "Basic " + btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const host = new URL(target).hostname.replace(/^www\./, "");
  const res = await fetch("https://api.dataforseo.com/v3/backlinks/summary/live", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ target: host, internal_list_limit: 1, backlinks_status_type: "live" }]),
  });
  const data = await res.json();
  return data?.tasks?.[0]?.result?.[0] || null;
}

/* ----------------------------------------------------------------------------
   Agent-readiness signals — fetched directly from the origin (cheap, no API).
   Cascade: raw fetch → Scrapfly (if blocked) → Puppeteer (if thin + not blocked).
---------------------------------------------------------------------------- */
export async function fetchAgentSignals(url, env) {
  const origin = new URL(url).origin;
  const out = { robots: "", llms: false, html: "", rendering_mode: "fetch" };
  let rawStatus = 200;
  try { const resp = await fetch(url); rawStatus = resp.status; out.html = await resp.text(); } catch {}

  // Tier 2 — Scrapfly: HTTP status code is primary trigger (403/429/503);
  // body content check is secondary for sites that return 200 with a challenge page.
  const isBlocked = rawStatus === 403 || rawStatus === 429 || rawStatus === 503 || isBlockPage(out.html);
  if (isBlocked && env && env.SCRAPFLY_API_KEY) {
    console.warn(`Block detected for ${url} (HTTP ${rawStatus}) — trying Scrapfly`);
    try {
      const sfHtml = await fetchWithScrapfly(url, env.SCRAPFLY_API_KEY);
      if (sfHtml && !isBlockPage(sfHtml)) {
        out.html = sfHtml;
        out.rendering_mode = "scrapfly";
      } else {
        console.warn("Scrapfly also returned a block page for:", url);
      }
    } catch (e) {
      console.warn("Scrapfly failed:", String(e));
    }
  }

  // Tier 3 — Puppeteer: fires when HTML is thin or JS-heavy.
  // Scrapfly handles blocked sites above; Puppeteer never runs against blocked sites.
  const strippedForRatio = out.html
    ? out.html.replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"")
              .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()
    : "";
  const isJsHeavy = out.html.length > 50000 && strippedForRatio.length < 4000;
  const needsBrowser = !isBlocked && !isBlockPage(out.html) && env && env.BROWSER
    && (isThinHtml(out.html) || isJsHeavy
        || /\b(__NEXT_DATA__|__NUXT__|ng-version\b)/.test(out.html)
        || /<div[^>]+id=["'](root|app)["'][^>]*>\s*<\/div>/i.test(out.html));
  if (needsBrowser) {
    console.warn(`JS/thin HTML detected for ${url} (raw=${out.html.length}B, text=${strippedForRatio.length}ch) — Browser Rendering fallback`);
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

export async function fetchWithScrapfly(url, apiKey) {
  const endpoint =
    "https://api.scrapfly.io/scrape" +
    "?key=" + encodeURIComponent(apiKey) +
    "&url=" + encodeURIComponent(url) +
    "&render_js=true&asp=true";
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`Scrapfly HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.result?.success) throw new Error(`Scrapfly error: ${JSON.stringify(data?.result?.error || data?.message || "unknown")}`);
  return data.result.content || null;
}

export function isBlockPage(html) {
  if (!html) return false;
  const title = ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").toLowerCase().trim();
  if (/^(access denied|just a moment|attention required|please verify|checking your browser|403 forbidden|403 error|forbidden|429 too many|blocked|error 403|service unavailable)/.test(title)) return true;
  if (/ray id:/i.test(html) && /cloudflare/i.test(html.slice(0, 5000))) return true;
  if (html.length < 30000 && /access denied|you don.t have permission|you do not have permission|request blocked by|\bforbidden\b/i.test(html)) return true;
  return false;
}

export function isThinHtml(html) {
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

export function detectJsFramework(html) {
  if (!html) return null;
  if (/__NEXT_DATA__/.test(html))                                 return "Next.js";
  if (/__NUXT__/.test(html))                                      return "Nuxt";
  if (/\bng-version\b/.test(html))                                return "Angular";
  if (/<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(html))    return "React";
  if (/<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html))     return "Vue";
  return null;
}

export function extractHtmlMeta(html, url) {
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

export function patchPageFromHtml(page, fb) {
  const checks = Object.assign({}, page.checks || {});
  const meta = Object.assign({}, page.meta || {});
  if (!meta.title && fb.title) { meta.title = fb.title; checks.no_title = false; }
  if (!meta.description && fb.description) { meta.description = fb.description; checks.no_description = false; }
  if (!meta.content?.plain_text_word_count && fb.wordCount) {
    meta.content = Object.assign({}, meta.content || {}, { plain_text_word_count: fb.wordCount });
  }
  if (checks.no_h1_tag == null && fb.hasH1)         checks.no_h1_tag = false;
  if (checks.has_micromarkup == null && fb.hasSchema) checks.has_micromarkup = true;
  if (checks.is_https == null)                       checks.is_https = fb.isHttps;
  return Object.assign({}, page, { meta, checks });
}
