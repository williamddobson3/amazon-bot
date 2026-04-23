'use strict';

const cheerio = require('cheerio');

// Parse an Amazon.co.jp search results page and extract all product
// cards. Returns an array of objects, one per visible product, with the
// 9 fields specified in the client's requirements.
//
// The search URL is:  /s?k=ASIN1|ASIN2|...|ASIN135
// Amazon shows ~45 of the 135 searched ASINs in a random subset.
// Each product card is a <div data-component-type="s-search-result"
// data-asin="B0XXXXXXXX">.

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const card = $(el);
    const asin = card.attr('data-asin');
    if (!asin || asin.length !== 10) return;

    results.push({
      asin,
      title:       extractTitle(card),
      imageUrl:    extractImageUrl(card),
      price:       extractPrice(card),
      points:      extractPoints(card),
      delivery:    extractDelivery(card),
      mpPrice:     extractMarketplacePrice(card),
      mpCount:     extractMarketplaceCount(card),
      mpCondition: extractMarketplaceCondition(card),
    });
  });

  return results;
}

// ── Field extractors ────────────────────────────────────────

function extractTitle(card) {
  // Primary: h2 > a > span
  const h2 = card.find('h2 a span');
  if (h2.length) return normalizeWhitespace(h2.text());
  // Fallback: .a-text-normal
  const alt = card.find('.a-text-normal');
  return alt.length ? normalizeWhitespace(alt.first().text()) : null;
}

// Collapse runs of whitespace/newlines into single spaces.
function normalizeWhitespace(str) {
  return str ? str.replace(/\s+/g, ' ').trim() : null;
}

function extractImageUrl(card) {
  const img = card.find('img.s-image');
  return img.length ? img.attr('src') : null;
}

function extractPrice(card) {
  // The .a-offscreen element inside .a-price holds the accessible price
  // text. Format varies by locale:
  //   Japanese: "￥4,482" or "¥4,482"
  //   European: "EUR 17.26" or "€17.26"
  //   Generic:  "4,482"
  const priceEl = card.find('.a-price .a-offscreen');
  if (!priceEl.length) return null;
  const text = priceEl.first().text().trim();
  return parsePrice(text);
}

function extractPoints(card) {
  // Points appear near the price as "Npt" or "Nポイント" in a small row.
  const html = card.html() || '';
  // Pattern: number followed by "pt" or "ポイント"
  const m = html.match(/(\d[\d,]*)(?:\s*)(?:pt|ポイント)/i);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ''), 10) || null;
}

function extractDelivery(card) {
  // Several possible locations for delivery text.
  // 1. data-csa-c-delivery-time attribute (structured)
  const deliveryAttr = card.find('[data-csa-c-delivery-time]');
  if (deliveryAttr.length) {
    return deliveryAttr.attr('data-csa-c-delivery-time');
  }

  // 2. Text containing "お届け" or "配送" in a delivery-related row
  const allText = card.text();
  const deliveryMatch = allText.match(/(無料配送[^。]*お届け|.*?日.*?にお届け|明日中にお届け|本日中にお届け)/);
  if (deliveryMatch) return normalizeWhitespace(deliveryMatch[0]);

  // 3. Spans with delivery class
  const deliverySpan = card.find('[aria-label*="配送"], [aria-label*="お届け"]');
  if (deliverySpan.length) return deliverySpan.attr('aria-label');

  return null;
}

function extractMarketplacePrice(card) {
  // "こちらからもご購入いただけます" section contains the lowest
  // third-party price. It may appear as a link with a price.
  const mpSection = card.find('.a-section:contains("こちらからもご購入いただけます")');
  if (!mpSection.length) return null;

  const text = mpSection.text();
  // Try yen first, then any number
  const m = text.match(/[¥￥]([\d,]+)/) || text.match(/([\d,]+(?:\.\d+)?)/);
  return m ? Math.round(parseFloat(m[1].replace(/,/g, ''))) : null;
}

function extractMarketplaceCount(card) {
  // e.g. "5点" or "5 件"
  const mpSection = card.find('.a-section:contains("こちらからもご購入いただけます")');
  if (!mpSection.length) return null;

  const text = mpSection.text();
  const m = text.match(/(\d+)\s*[点件]/);
  return m ? parseInt(m[1], 10) : null;
}

function extractMarketplaceCondition(card) {
  // e.g. "中古品", "新品", "中古品と新品"
  const mpSection = card.find('.a-section:contains("こちらからもご購入いただけます")');
  if (!mpSection.length) return null;

  const text = mpSection.text();
  const conditions = [];
  if (text.includes('新品')) conditions.push('新品');
  if (text.includes('中古品') || text.includes('中古')) conditions.push('中古品');
  return conditions.length > 0 ? conditions.join('と') : null;
}

// ── Helpers ─────────────────────────────────────────────────

// Parse price from any format: "¥4,482", "￥4,482", "EUR 17.26", "€17.26", "$12.99"
// Returns an integer (rounds if decimal). For yen this is exact; for
// other currencies it strips the decimal. The caller can decide whether
// to convert currencies.
function parsePrice(text) {
  if (!text) return null;
  // Strip currency symbols and labels, keep digits, commas, and decimal point
  const cleaned = text.replace(/[¥￥$€£]|EUR|USD|GBP|JPY/gi, '').replace(/\s/g, '');
  // Extract first number-like sequence: "17.26" or "4,482"
  const m = cleaned.match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) ? null : Math.round(n);
}

// Keep the old name as an alias for backward compatibility
function parseYen(text) {
  return parsePrice(text);
}

module.exports = { parseSearchResults };
