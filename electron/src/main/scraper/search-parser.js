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

    const mp = extractMarketplaceInfo(card);

    results.push({
      asin,
      title:       extractTitle(card),
      imageUrl:    extractImageUrl(card),
      price:       extractPrice(card),
      points:      extractPoints(card),
      delivery:    extractDelivery(card),
      mpPrice:     mp.price,
      mpCount:     mp.count,
      mpCondition: mp.condition,
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

// Strip text that looks like leaked CSS / JS / HTML class chunks. Some
// Amazon delivery wrappers contain inline `<style>` blocks (e.g.
// `.prime-brand-color { color: #0064f9; }`); cheerio's `.text()`
// concatenates style children too, polluting the delivery string. We
// drop anything matching CSS rule patterns before returning.
function stripCodeNoise(str) {
  if (!str) return str;
  let s = str;
  // Remove `.classname { ... }` and `#id { ... }` rule blocks.
  s = s.replace(/[.#][\w-]+\s*\{[^}]*\}/g, '');
  // Remove leftover `key: value;` declarations and trailing `}` braces.
  s = s.replace(/[\w-]+\s*:\s*[^;]+;/g, '');
  s = s.replace(/[{}]/g, '');
  // Drop hex color literals that may dangle on their own.
  s = s.replace(/#[0-9a-fA-F]{3,8}\b/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// Cheerio helper: get text() of an element with <style> / <script>
// children removed so their content doesn't pollute the result.
function safeText($el) {
  if (!$el || !$el.length) return '';
  const clone = $el.clone();
  clone.find('style, script, noscript').remove();
  return clone.text();
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
  // The canonical Amazon points display looks like:
  //   <span class="a-color-price">31ポイント(1%)</span>
  // The trailing "(N%)" parenthetical is what makes this an *earned*
  // points line. Promotional copy elsewhere on the card uses "ポイント"
  // without that suffix:
  //   "200ポイント還元中"     ← rebate banner
  //   "毎月最大3%ポイントUP"  ← Prime promo
  //   "+1,000ポイント獲得"    ← campaign
  // The previous regex matched any "Nポイント" / "Npt" anywhere in the
  // card HTML and so picked up the first promo banner instead of the
  // real points number. By requiring "(N%)" we disambiguate cleanly.

  // 1. Targeted scan: the .a-color-price span(s) that hold the points line.
  const priceSpans = card.find('.a-color-price');
  for (let i = 0; i < priceSpans.length; i++) {
    const text = priceSpans.eq(i).text().trim();
    const m = text.match(/^(\d[\d,]*)\s*(?:ポイント|pt)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) || null;
  }

  // 2. Fallback: tight regex on the full card text, still anchored on
  // the "(N%)" suffix so promo copy never matches.
  const text = card.text();
  const m = text.match(/(\d[\d,]*)\s*(?:ポイント|pt)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10) || null;

  return null;
}

function extractDelivery(card) {
  // Locate delivery info ONLY from delivery-flagged DOM nodes. The
  // previous version had a regex fallback (`.*?日.*?にお届け`) that ran
  // against `card.text()` — the entire concatenated text of the card —
  // and `.*?` greedily scooped adjacent unrelated text (purchase
  // counts, rating snippets, "200点以上購入されました" etc.) up to the
  // first "にお届け". Result: the 発送情報 column displayed sales
  // figures and other noise alongside the actual delivery phrase. Now
  // we pull text only from elements that are structurally tagged as
  // delivery, and a final regex fallback is anchored to tight,
  // shipping-only patterns.

  // 1. Amazon's structured delivery block. data-cy="delivery-recipe"
  //    wraps just the delivery phrase — no purchase counts, no
  //    ratings, just "8月15日 木曜日にお届け" etc.
  //    safeText() strips inline <style>/<script> children that some
  //    Amazon templates embed (e.g. `.prime-brand-color { color: #...}`)
  //    which would otherwise pollute the delivery string. The follow-
  //    up stripCodeNoise pass also removes any CSS rule debris that
  //    survived in attribute or text-node form.
  const recipe = card.find('[data-cy="delivery-recipe"]').first();
  if (recipe.length) {
    const t = stripCodeNoise(normalizeWhitespace(safeText(recipe)));
    if (t) return t;
  }

  // 2. udm-primary-delivery-message — alternate template Amazon serves
  //    on some search cards. Same shape: delivery text only.
  const udm = card.find('.udm-primary-delivery-message, [data-component-type="s-delivery-block"]').first();
  if (udm.length) {
    const t = stripCodeNoise(normalizeWhitespace(safeText(udm)));
    if (t) return t;
  }

  // 3. aria-label that explicitly contains a delivery phrase. We
  //    require "お届け" (delivery), not the broader "配送" — "配送"
  //    can appear in unrelated labels like "他の出品の配送料は…" which
  //    are seller-info copy, not the shipping ETA.
  const ariaEl = card.find('[aria-label*="お届け"]').first();
  if (ariaEl.length) {
    const aria = ariaEl.attr('aria-label');
    if (aria) return stripCodeNoise(normalizeWhitespace(aria));
  }

  // 4. data-csa-c-delivery-time attribute — structured but sometimes
  //    holds a verbose string. Trim to the date phrase.
  const deliveryAttr = card.find('[data-csa-c-delivery-time]').first();
  if (deliveryAttr.length) {
    const v = deliveryAttr.attr('data-csa-c-delivery-time');
    if (v) return stripCodeNoise(normalizeWhitespace(v));
  }

  // 5. Last-resort regex on full card text, anchored to tight
  //    shipping-only patterns. No `.*?` — each alternative matches
  //    only a self-contained delivery phrase.
  const allText = card.text();
  const tightPatterns = [
    /明日中にお届け/,
    /本日中にお届け/,
    /\d+月\d+日(?:\s*[（(]?[月火水木金土日][)）]?(?:曜日)?)?\s*にお届け/,
    /\d+\s*日後にお届け/,
    /無料配送/,
  ];
  for (const re of tightPatterns) {
    const m = allText.match(re);
    if (m) return normalizeWhitespace(m[0]);
  }

  return null;
}

// Extract third-party seller price + offer count + condition from a
// search-result card. Two known layout variants on Amazon.co.jp:
//
// A. Classic "こちらからもご購入いただけます" section — a link list of
//    other sellers under that heading.
//
// B. "Featured Offer not available" row — appears when no seller meets
//    the Featured Offer requirements:
//      <div class="a-row a-size-base a-color-secondary">
//        <span>「おすすめ出品」の要件を満たす出品はありません</span><br>
//        <span class="a-color-price">￥4,490</span>
//        <a href="/gp/offer-listing/...">（3点の新品）</a>
//      </div>
//    The /gp/offer-listing/ link is the reliable anchor — it appears
//    on every variant of this row regardless of localization tweaks.
function extractMarketplaceInfo(card) {
  let section = card.find('.a-section:contains("こちらからもご購入いただけます")').first();

  if (!section.length) {
    const offerLink = card.find('a[href*="/gp/offer-listing/"]').first();
    if (offerLink.length) {
      // Walk up to the row containing both the price and the link.
      section = offerLink.closest('.a-row');
      if (!section.length) section = offerLink.parent();
    }
  }

  if (!section.length) return { price: null, count: null, condition: null };

  const text = section.text();

  // Price: yen symbol + digits. Falls back to any number for non-JP layouts.
  const priceMatch = text.match(/[¥￥]\s*([\d,]+)/) || text.match(/([\d,]+(?:\.\d+)?)/);
  const price = priceMatch
    ? Math.round(parseFloat(priceMatch[1].replace(/,/g, '')))
    : null;

  // Count: must be qualified by 新品/中古 — i.e. "（3点の新品）",
  // "20点の中古", "5点 新品". The bare /\d+点/ used to also catch the
  // 「過去1か月で1000点以上購入されました」 purchase-count banner that
  // Amazon shows in the same .a-row container, polluting our seller
  // count. The 「N以上」 form never has 新品/中古 after it, so requiring
  // that qualifier disambiguates cleanly. 「件」 (e.g., "5 件") is also
  // safe as a fallback since purchase banners always use 点, never 件.
  const countMatch =
       text.match(/(\d+)\s*点\s*(?:の)?\s*(?:新品|中古)/)
    || text.match(/(\d+)\s*件/);
  const count = countMatch ? parseInt(countMatch[1], 10) : null;

  const conditions = [];
  if (text.includes('新品')) conditions.push('新品');
  if (text.includes('中古品') || text.includes('中古')) conditions.push('中古品');
  const condition = conditions.length > 0 ? conditions.join('と') : null;

  return { price, count, condition };
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
