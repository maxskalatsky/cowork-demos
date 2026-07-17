// Playwright verification script for skalatsky-web/deck.html
//
// Run: npm install && npx playwright install chromium && node scripts/deck_test.js
// (npm install must be run inside scripts/, e.g. `cd scripts && npm install`)
//
// NOTE: build the file:// URL with path.resolve() + split(path.sep).join('/'),
// never with a regex replace — a prior heredoc-authored version mangled
// `.replace(/\\/g, '/')` into an unterminated regex literal and crashed with
// "SyntaxError: missing ) after argument list". Keep it regex-free.

const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const DECK_HTML_PATH = process.env.DECK_HTML_PATH || 'C:\\Users\\max\\skalatsky-web\\deck.html';

const EXPECTED_TITLE = 'AI Adoption and Product Marketing Deck | Skalatsky & Associates';

// #slideLabel text for each of the 9 slides, in order: cover-open, 7 content
// slides, cover-close.
const EXPECTED_LABELS = [
  'Skalatsky & Associates',
  'Global AI Adoption',
  'US AI Adoption',
  'As tech accelerates, what stays the same?',
  'Where does the time go?',
  'Absorption Gap',
  'Loop Stack',
  'Agentic Pod',
  'Contact',
];

const TOTAL_SLIDES = EXPECTED_LABELS.length; // 9

function toFileUrl(inputPath) {
  const resolved = path.resolve(inputPath);
  const posixish = resolved.split(path.sep).join('/');
  return 'file:///' + posixish;
}

async function main() {
  const fileUrl = toFileUrl(DECK_HTML_PATH);
  console.log(`Opening ${fileUrl}`);

  const browser = await chromium.launch();
  try {
    await runChecks(browser, fileUrl);
  } finally {
    await browser.close();
  }
}

async function runChecks(browser, fileUrl) {
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err && err.message ? err.message : String(err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(fileUrl, { waitUntil: 'load' });

  // 1. Title check
  const title = await page.title();
  assert.strictEqual(title, EXPECTED_TITLE, `Title mismatch: got "${title}"`);
  console.log(`PASS: title === "${title}"`);

  // 2. Backlink exists, visible, correct href
  const backlink = page.locator('a.backlink');
  assert.strictEqual(await backlink.count(), 1, 'Expected exactly one a.backlink element');
  const backlinkHref = await backlink.getAttribute('href');
  assert.strictEqual(backlinkHref, '/', `Expected a.backlink href="/", got "${backlinkHref}"`);
  const backlinkBox = await backlink.boundingBox();
  assert.ok(backlinkBox, 'a.backlink must have a valid (visible) bounding box');
  console.log(`PASS: a.backlink present, href="/", bbox=${JSON.stringify(backlinkBox)}`);

  // 3. .bar exists and does not vertically overlap the backlink
  const bar = page.locator('.bar');
  assert.strictEqual(await bar.count(), 1, 'Expected exactly one .bar element');
  const barBox = await bar.boundingBox();
  assert.ok(barBox, '.bar must have a valid (visible) bounding box');
  console.log(`.bar bbox=${JSON.stringify(barBox)}`);

  const backlinkTop = backlinkBox.y;
  const backlinkBottom = backlinkBox.y + backlinkBox.height;
  const barTop = barBox.y;
  const barBottom = barBox.y + barBox.height;
  const verticallyOverlaps = backlinkTop < barBottom && barTop < backlinkBottom;
  assert.ok(
    !verticallyOverlaps,
    `Expected a.backlink and .bar to NOT vertically overlap. backlink=${JSON.stringify(backlinkBox)} bar=${JSON.stringify(barBox)}`
  );
  assert.ok(
    backlinkBottom <= barTop,
    `Expected a.backlink to sit above .bar (near top vs. pinned bottom). backlink=${JSON.stringify(backlinkBox)} bar=${JSON.stringify(barBox)}`
  );
  console.log('PASS: .bar present and does not vertically overlap a.backlink');

  // 4. Slide cycling: click #next 8 times, walking through all 9 slides.
  const slideLabelLoc = page.locator('#slideLabel');
  const countLoc = page.locator('#count');
  const nextBtn = page.locator('#next');

  async function assertSlideState(slideNumber, expectedLabel) {
    const label = await slideLabelLoc.textContent();
    const count = await countLoc.textContent();
    const expectedCount = `${slideNumber} / ${TOTAL_SLIDES}`;
    assert.strictEqual(
      label,
      expectedLabel,
      `Slide ${slideNumber}: expected #slideLabel "${expectedLabel}", got "${label}"`
    );
    assert.strictEqual(
      count,
      expectedCount,
      `Slide ${slideNumber}: expected #count "${expectedCount}", got "${count}"`
    );
    console.log(`PASS: slide ${slideNumber}/${TOTAL_SLIDES} -> label="${label}" count="${count}"`);
  }

  // Initial state, before any click: slide 1 of 9.
  await assertSlideState(1, EXPECTED_LABELS[0]);

  for (let i = 1; i <= 8; i++) {
    await nextBtn.click();
    await assertSlideState(i + 1, EXPECTED_LABELS[i]);
  }

  // 5. No page errors or console errors during the whole run.
  assert.strictEqual(
    pageErrors.length,
    0,
    `Expected no pageerror events, got: ${JSON.stringify(pageErrors)}`
  );
  assert.strictEqual(
    consoleErrors.length,
    0,
    `Expected no console.error events, got: ${JSON.stringify(consoleErrors)}`
  );
  console.log('PASS: no pageerror or console.error events fired');

  console.log('\nAll checks passed: deck.html verified clean across all 9 slides.');
}

main().catch((err) => {
  console.error('\nFAIL:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
