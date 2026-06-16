'use strict';
// Throwaway: pull the B0CCTXFCDP card out of the captured dump and show
// (a) what the project's own parser extracts, and (b) the raw price blocks.
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { parseSearchResults } = require('../src/main/scraper/search-parser');

const ASIN = process.argv[2] || 'B0CCTXFCDP';
const html = fs.readFileSync(path.join(__dirname, `dump-${ASIN}.html`), 'utf8');

// (a) what the scraper would extract
const rows = parseSearchResults(html);
const mine = rows.find((r) => r.asin === ASIN);
console.log('=== parseSearchResults() result for', ASIN, '===');
console.log(JSON.stringify(mine, null, 2));
console.log('total cards parsed:', rows.length);

// (b) raw blocks from the exact card
const $ = cheerio.load(html);
const card = $(`[data-component-type="s-search-result"][data-asin="${ASIN}"]`).first();
console.log('\n=== card found:', card.length > 0, '===');

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const atc = card.find('[data-cy="add-to-cart"] [data-csa-c-price-to-pay]').first();
console.log('\n--- [data-cy="add-to-cart"] data-csa-c-price-to-pay ---');
console.log(atc.attr('data-csa-c-price-to-pay'));

console.log('\n--- [data-cy="price-recipe"] (BuyBox) prices ---');
card.find('[data-cy="price-recipe"] .a-price .a-offscreen').each((i, el) => console.log(' offscreen:', norm($(el).text())));
console.log(' price-recipe text:', norm(card.find('[data-cy="price-recipe"]').text()));

console.log('\n--- [data-cy="multi-offer-display"] text ---');
console.log(norm(card.find('[data-cy="multi-offer-display"]').text()) || '(none)');

console.log('\n--- [data-cy="secondary-offer-recipe"] text ---');
console.log(norm(card.find('[data-cy="secondary-offer-recipe"]').text()) || '(none)');

// write the trimmed card HTML for the user
const outCard = path.join(__dirname, `card-${ASIN}.html`);
fs.writeFileSync(outCard, $.html(card));
console.log('\nwrote raw card HTML ->', outCard, `(${$.html(card).length} bytes)`);