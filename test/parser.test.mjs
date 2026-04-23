// Standalone test harness for the extension parser.
// Uses linkedom to polyfill DOMParser in Node, then imports the real
// parser module from the extension and runs it against HTML samples.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseHTML, DOMParser as LinkDOMParser } from 'linkedom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Polyfill DOMParser globally so parser.js (which uses `new DOMParser()`) works
globalThis.DOMParser = class {
  parseFromString(html) {
    return parseHTML(html).document;
  }
};

// Now import the parser — it will use our polyfilled DOMParser
const { parseSearchResultsPage, parseProductPage } = await import('../extension/lib/parser.js');

const TARGET_ASIN = 'B08PTNSTT9';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  dim:   '\x1b[2m',
  bold:  '\x1b[1m',
};

function ok(msg)   { console.log(`  ${COLORS.green}✓${COLORS.reset} ${msg}`); }
function bad(msg)  { console.log(`  ${COLORS.red}✗${COLORS.reset} ${msg}`); }
function info(msg) { console.log(`  ${COLORS.dim}${msg}${COLORS.reset}`); }
function section(title) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}${title}${COLORS.reset}`);
  console.log(COLORS.dim + '─'.repeat(60) + COLORS.reset);
}

const failures = [];

function check(name, cond, expected, actual) {
  if (cond) {
    ok(`${name}: ${COLORS.green}${JSON.stringify(actual)}${COLORS.reset}`);
  } else {
    bad(`${name}: expected ${COLORS.yellow}${JSON.stringify(expected)}${COLORS.reset}, got ${COLORS.red}${JSON.stringify(actual)}${COLORS.reset}`);
    failures.push(`${name}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// TEST 1: Search-results page (page.html)
// ─────────────────────────────────────────────────────────────

section(`TEST 1 — parseSearchResultsPage against page.html`);
info(`Sample: /s?k=${TARGET_ASIN} (non-logged-in)`);

{
  const html = readFileSync(join(ROOT, 'page.html'), 'utf8');
  const result = parseSearchResultsPage(html, TARGET_ASIN);

  if (result.error) {
    bad(`parseSearchResultsPage returned error: ${result.error}`);
    if (result.missing) info(`  missing=[${result.missing.join(',')}]`);
    if (result.partial) info(`  partial=${JSON.stringify(result.partial)}`);
    failures.push(`page.html: error=${result.error}`);
  } else {
    console.log(`  Result: ${JSON.stringify(result, null, 2).split('\n').join('\n  ')}`);
    console.log();
    check('① title',      /KIOXIA/i.test(result.title || ''),         'contains "KIOXIA"',       result.title);
    check('② price',      result.price === 4780,                       4780,                      result.price);
    check('③ points',     result.points === 48,                        48,                        result.points);
    check('④ delivery',   result.deliveryTime != null,                 'non-null object',         result.deliveryTime);
    check('⑤ asin',       result.asin === TARGET_ASIN,                 TARGET_ASIN,               result.asin);
    check('⑥ marketplaceLowest (expected null on search page)',
                          result.marketplaceLowest === null,           null,                      result.marketplaceLowest);
    check('⑦ newOfferCount (expected null on search page)',
                          result.newOfferCount === null,               null,                      result.newOfferCount);
  }
}

// ─────────────────────────────────────────────────────────────
// TEST 2: Search-results page (logined_page.html)
// ─────────────────────────────────────────────────────────────

section(`TEST 2 — parseSearchResultsPage against logined_page.html`);
info(`Sample: /s?k=${TARGET_ASIN} (logged-in, some fields may differ)`);

{
  const html = readFileSync(join(ROOT, 'logined_page.html'), 'utf8');
  const result = parseSearchResultsPage(html, TARGET_ASIN);

  if (result.error) {
    bad(`parseSearchResultsPage returned error: ${result.error}`);
    if (result.missing) info(`  missing=[${result.missing.join(',')}]`);
    if (result.partial) info(`  partial=${JSON.stringify(result.partial)}`);
    failures.push(`logined_page.html: error=${result.error}`);
  } else {
    console.log(`  Result: ${JSON.stringify(result, null, 2).split('\n').join('\n  ')}`);
    console.log();
    check('① title',      /KIOXIA/i.test(result.title || ''),         'contains "KIOXIA"',       result.title);
    check('② price',      result.price === 4780,                       4780,                      result.price);
    check('③ points',     result.points === 48,                        48,                        result.points);
    check('④ delivery',   result.deliveryTime != null,                 'non-null object',         result.deliveryTime);
    check('⑤ asin',       result.asin === TARGET_ASIN,                 TARGET_ASIN,               result.asin);
  }
}

// ─────────────────────────────────────────────────────────────
// TEST 3: Detail page (detail_login_before.html)
// ─────────────────────────────────────────────────────────────

section(`TEST 3 — parseProductPage against detail_login_before.html`);
info(`Sample: /dp/${TARGET_ASIN} (non-logged-in, with ZIP cookie)`);

{
  const html = readFileSync(join(ROOT, 'detail_login_before.html'), 'utf8');
  const result = parseProductPage(html, TARGET_ASIN);

  if (result.error) {
    bad(`parseProductPage returned error: ${result.error}`);
    if (result.missing) info(`  missing=[${result.missing.join(',')}]`);
    if (result.partial) info(`  partial=${JSON.stringify(result.partial)}`);
    failures.push(`detail_login_before.html: error=${result.error}`);
  } else {
    console.log(`  Result: ${JSON.stringify(result, null, 2).split('\n').join('\n  ')}`);
    console.log();
    check('① title',      /KIOXIA/i.test(result.title || ''),        'contains "KIOXIA"',      result.title);
    check('② price',      result.price === 4780,                      4780,                     result.price);
    check('③ points',     result.points === 48,                       48,                       result.points);
    check('④ delivery',   result.deliveryTime != null,                'non-null',               result.deliveryTime);
    check('⑤ asin',       result.asin === TARGET_ASIN,                TARGET_ASIN,              result.asin);
    check('⑥ marketplaceLowest', result.marketplaceLowest === 4780,  4780,                     result.marketplaceLowest);
    check('⑦ newOfferCount',     result.newOfferCount === 20,         20,                       result.newOfferCount);
  }
}

// ─────────────────────────────────────────────────────────────
// TEST 4: Detail page (detail_login_after.html)
// ─────────────────────────────────────────────────────────────

section(`TEST 4 — parseProductPage against detail_login_after.html`);
info(`Sample: /dp/${TARGET_ASIN} (logged-in)`);

{
  const html = readFileSync(join(ROOT, 'detail_login_after.html'), 'utf8');
  const result = parseProductPage(html, TARGET_ASIN);

  if (result.error) {
    bad(`parseProductPage returned error: ${result.error}`);
    if (result.missing) info(`  missing=[${result.missing.join(',')}]`);
    if (result.partial) info(`  partial=${JSON.stringify(result.partial)}`);
    failures.push(`detail_login_after.html: error=${result.error}`);
  } else {
    console.log(`  Result: ${JSON.stringify(result, null, 2).split('\n').join('\n  ')}`);
    console.log();
    check('① title',      /KIOXIA/i.test(result.title || ''),        'contains "KIOXIA"',      result.title);
    check('② price',      result.price === 4780,                      4780,                     result.price);
    check('③ points',     result.points === 48,                       48,                       result.points);
    check('④ delivery',   result.deliveryTime != null,                'non-null',               result.deliveryTime);
    check('⑤ asin',       result.asin === TARGET_ASIN,                TARGET_ASIN,              result.asin);
    check('⑥ marketplaceLowest', result.marketplaceLowest === 4780,  4780,                     result.marketplaceLowest);
    check('⑦ newOfferCount',     result.newOfferCount === 20,         20,                       result.newOfferCount);
  }
}

// ─────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`${COLORS.bold}${COLORS.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.green}  ✓ ALL TESTS PASSED${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  process.exit(0);
} else {
  console.log(`${COLORS.bold}${COLORS.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.red}  ✗ ${failures.length} FAILURE(S):${COLORS.reset}`);
  failures.forEach((f) => console.log(`    • ${f}`));
  console.log(`${COLORS.bold}${COLORS.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  process.exit(1);
}
