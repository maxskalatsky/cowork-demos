/* ----------------------------------------------------------------------------
   Verdict library — all verdict text for positioning, agent readiness, and SEO
   grade descriptions. Scoring logic lives in scorer.js; text lives here.
---------------------------------------------------------------------------- */

export function getPositioningVerdict(disqualifier, disqualifierFiller, disqualifierBuzz, disqualifierCta, hook, fit, relevance) {
  if (disqualifier) {
    if (disqualifierFiller)
      return "The language on this site signals nothing. Phrases like 'we help businesses grow' are placeholders, not positioning. A stranger reads this and cannot tell what you do or who you serve.";
    if (disqualifierBuzz)
      return "Too much jargon, not enough substance. Strip the buzzwords and say the specific thing you do for the specific people you serve.";
    if (disqualifierCta)
      return "Every line is pushing for action before making a case. Pull back the calls to action and build the argument first.";
    return "No structure, no signal. A wall of copy without headings means a reader cannot find what matters, and neither can Google.";
  }

  // hook = lands
  if (hook === "lands" && fit === "clear"   && relevance === "connects")
    return "This site is firing on all cylinders. The opening lands, the offer is clear, and the reader immediately sees what is in it for them.";
  if (hook === "lands" && fit === "clear"   && relevance === "partial")
    return "Strong fundamentals with a targeting gap. The brand lands and the offer is clear, but it speaks to everyone rather than pulling the right person in by name.";
  if (hook === "lands" && fit === "clear"   && relevance === "missing")
    return "Clear and compelling but it does not connect to the reader. The offer is visible but the why it matters to me moment never arrives.";
  if (hook === "lands" && fit === "partial" && relevance === "connects")
    return "The opening grabs attention and the relevance is there, but the offer is not sharp enough to close it. Tighten what you do and for whom.";
  if (hook === "lands" && fit === "partial" && relevance === "partial")
    return "Strong first impression that does not quite deliver. The opening earns the click but the page does not close it.";
  if (hook === "lands" && fit === "unclear" && relevance === "partial")
    return "Strong first impression that does not quite deliver. The opening earns the click but the page does not close it.";
  if (hook === "lands" && fit === "partial" && relevance === "missing")
    return "The opening works but the page loses the reader. The offer is hazy and there is no connection to why it matters.";
  if (hook === "lands" && fit === "unclear" && relevance === "connects")
    return "The energy is right but the offer is buried. A stranger feels something here but cannot tell what they are supposed to do next.";
  if (hook === "lands" && fit === "unclear" && relevance === "missing")
    return "Strong opening, weak follow through. The hook grabs attention but the offer and the connection to the reader both fall away before the page earns anything.";

  // hook = partial
  if (hook === "partial" && fit === "clear" && relevance === "connects")
    return "Clear and relevant but the opening does not earn it. A sharper hook would turn this from a good site into one that converts.";
  if (hook === "partial" && fit === "clear" && relevance === "partial")
    return "The offer is clear but the site is not making a case for itself. Sharpen the opening and connect it to a specific outcome for the reader.";
  if (hook === "partial" && fit === "clear" && relevance === "missing")
    return "Clear enough to read but not compelling enough to act. No hook, no connection, no reason for a stranger to care.";
  if (hook === "partial" && fit === "partial" && relevance === "connects")
    return "The bones are good. Sharpen the opening and clarify the offer and this site does real work.";
  if (hook === "partial" && fit === "partial" && relevance === "partial")
    return "Not landing yet. The hook is soft, the offer is unclear, and the reader has no real reason to engage. Every element needs a sharper point of view.";
  if (hook === "partial" && fit === "partial" && relevance === "missing")
    return "Soft opening, vague offer, no connection to the reader. Pick one thing this site is for and say it plainly at the top.";
  if (hook === "partial" && fit === "unclear" && relevance === "connects")
    return "The reader connects with the message but cannot tell what is being offered. Clarity of fit is the missing piece.";
  if (hook === "partial" && fit === "unclear" && relevance === "partial")
    return "Starting to land but not sticking. The opening is vague, the offer is buried, and the reader has to work too hard to find the point.";
  if (hook === "partial" && fit === "unclear" && relevance === "missing")
    return "No hook, no clear offer, no connection to the reader. This site is not yet doing any work for the business.";

  // hook = missing + fit = unclear (any relevance)
  if (hook === "missing" && fit === "unclear")
    return "The site is not doing its job yet. A stranger cannot tell what this is, who it is for, or why it matters.";

  // hook = missing + fit = clear
  if (hook === "missing" && fit === "clear" && relevance === "connects")
    return "The substance is there but the opening does not earn it. Fix the first five seconds and the rest lands.";
  if (hook === "missing" && fit === "clear" && relevance === "partial")
    return "Clear enough to understand but not compelling enough to act. The fit is there but nothing pulls the reader in.";
  if (hook === "missing" && fit === "clear" && relevance === "missing")
    return "The offer is visible but nothing earns the reader's attention. No hook, no connection, no reason to stay.";

  // hook = missing + fit = partial (any relevance)
  if (hook === "missing" && fit === "partial")
    return "Hard to tell what this is or why it matters from the outside. The offer is implied but never earned, and the reader has no reason to dig deeper.";

  return "This site is not yet making its case. The opening, the offer, and the connection to the reader all need work before a stranger would stop and engage.";
}

export function getAgentLine(agent, base, scores, hasSchema) {
  const p = scores.auth / 10;
  const authBand = p >= 0.8 ? "strong" : p >= 0.6 ? "ok" : p >= 0.4 ? "weak" : "critical";

  switch (agent.level) {
    case "BASIC":
      if (agent.crawlersBlocked)
        return "Your site is actively blocking AI assistants from reading it. Until that changes you will not appear in any AI generated recommendations.";
      if (base === "F")
        return "Your site is effectively invisible to AI assistants. There is not enough structure or content for them to understand what you do or who you serve.";
      return "AI assistants can barely read your site. When someone asks for a business like yours, you are not in the conversation.";
    case "EMERGING":
      if (base === "D" || base === "F")
        return "AI assistants can find you but there is not enough content for them to explain what you do, so you rarely appear when buyers ask for help.";
      if (scores.content < 18)
        return "AI assistants can read your pages but have no structured signals to work from, so competitors with cleaner markup get cited ahead of you.";
      return "AI assistants can find you but struggle to understand what you offer, so you rarely get recommended when buyers ask for help.";
    case "CAPABLE":
      if (authBand === "weak" || authBand === "critical")
        return "Your site is readable to AI assistants and can appear in their answers, but thin authority means better known competitors get cited first.";
      if (base === "C")
        return "AI assistants can read you but competitors with cleaner structure and more content are usually cited ahead of you.";
      return "Your site is readable to AI assistants and can appear in their answers, though competitors with cleaner structure are usually cited first.";
    case "ADVANCED":
      if (hasSchema)
        return "AI assistants can clearly read and summarize your site, and your structured data helps them cite you accurately when buyers ask for a business like yours.";
      if (base === "A")
        return "Your site is fully optimized for AI discovery. You are positioned to be the first recommendation when buyers ask AI tools for a business like yours.";
      return "AI assistants can clearly read and summarize your site, so you are positioned to be recommended when buyers ask for a business like yours.";
    default:
      return "AI assistants can find you but struggle to understand what you offer, so you rarely get recommended when buyers ask for help.";
  }
}

export const SEO_GRADE_TITLE = {
  A: "Strong fundamentals",
  B: "Solid, with gaps",
  C: "Average",
  D: "Underperforming",
  F: "Critical",
};

export function getSeoGradeDesc(base, brand) {
  switch (base) {
    case "A": return "Strong fundamentals. Most of what Google rewards is already in place.";
    case "B": return "Solid, with a few specific gaps holding back better rankings.";
    case "C": return "Average. The basics are partly there but real visibility is being left on the table.";
    case "D": return "Weak. Several core signals Google looks for are missing or broken.";
    default:  return `Critical. Search engines and AI assistants are struggling to understand and rank ${brand} at all.`;
  }
}
