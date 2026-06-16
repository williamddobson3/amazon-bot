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

    // BuyBox 価格 ＋ 配送料 (2026-05 仕様)。
    //   - 配送料の表記がある商品は、商品価格に配送料を加算した値を
    //     BuyBox 価格として記録する。
    //   - 「無料配送」「配送料 別途」など金額の無い表記は加算なし。
    //   - mpPrice (他の出品価格) には配送料を加算しない (他の出品側に
    //     表示される金額はそれ自体が「商品+送料込み」のことが多く、
    //     二重加算になるため)。
    const basePrice    = extractPrice(card);
    const shippingFee  = extractShippingFee(card);
    const priceWithShipping = (basePrice != null)
      ? basePrice + (Number.isFinite(shippingFee) ? shippingFee : 0)
      : null;

    results.push({
      asin,
      title:         extractTitle(card),
      imageUrl:      extractImageUrl(card),
      price:         priceWithShipping,
      // ★ 送料は price に加算済みだが、UI 表示用に「送料単独の値」も
      // 別フィールドで残す。送料の表記が無いカードでは null。
      shippingFee:   Number.isFinite(shippingFee) ? shippingFee : null,
      points:        extractPoints(card),
      delivery:      extractDelivery(card),
      mpPrice:       mp.price,
      mpCount:       mp.count,
      mpCondition:   mp.condition,
      monthlySales:  extractMonthlySales(card),
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
  //
  // ★ 「こちらからもご購入いただけます」セクション (= マーケットプレイス
  // 他出品者) の価格は除外する。ASIN 単体検索ではカード内に Featured
  // Offer と他の出品の両方が並ぶことがあり、テンプレートによっては
  // マーケットプレイス側 .a-price が DOM 順で先に来ることがある (2026-05
  // bug: B09B6TSR8J で ¥2,100 ではなく他の出品の ¥1,562 を拾っていた)。
  // [data-cy="price-recipe"] が優先候補、無ければマーケットプレイス節を
  // カードから削除した clone を .a-price 探索の対象にする。
  // mpPrice は extractMarketplaceInfo が別途取得する。
  // 0. ★ Featured Offer の確定 BuyBox 価格 (2026-06): 「カートに入れる」ウィジェットの
  //    data-csa-c-price-to-pay 属性。一意・機械可読で、別オファー (multi-offer / マーケット
  //    プレイス) や参考価格 (取り消し線) を絶対に拾わない。Buy Box が無い商品 (オプションを
  //    表示) には存在しないので null になり、下のフォールバックも価格を返さず「BuyBox 無し」
  //    を正しく表す。最優先。
  const p2p = card.find('[data-cy="add-to-cart"] [data-csa-c-price-to-pay]')
    .first().attr('data-csa-c-price-to-pay');
  if (p2p != null) {
    const f = parseFloat(String(p2p).trim());
    if (Number.isFinite(f) && f > 0) return Math.round(f);
  }

  const recipe = card.find('[data-cy="price-recipe"] .a-price .a-offscreen').first();
  if (recipe.length) {
    const n = parsePrice(recipe.text().trim());
    if (n != null) return n;
  }

  const scope = stripMarketplaceSection(card);
  const priceEl = scope.find('.a-price .a-offscreen');
  if (!priceEl.length) return null;
  const text = priceEl.first().text().trim();
  return parsePrice(text);
}

// マーケットプレイス節 (= 「こちらからもご購入いただけます」セクション
// と /gp/offer-listing/ リンクを含む .a-row) を取り除いた card のクローン
// を返す。BuyBox 系の抽出 (価格・送料・発送情報) で共通利用。
function stripMarketplaceSection(card) {
  const clone = card.clone();
  clone
    .find('.a-section:contains("こちらからもご購入いただけます")')
    .remove();
  clone.find('a[href*="/gp/offer-listing/"]').closest('.a-row').remove();
  // ★ 「より速くお届け」等の別オファー (multi-offer-display) も除外する (2026-06)。
  // これは BuyBox とは別の出品なので、価格・ポイント抽出でここを拾うと
  // 「価格=BuyBox・ポイント=別オファー」の食い違いになる (B0CCTXFCDP)。
  clone.find('[data-cy="multi-offer-display"]').remove();
  return clone;
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

  // ★ ポイントは BuyBox (Featured Offer) のものだけを読む (2026-06)。別オファー
  // (multi-offer-display / マーケットプレイス) のポイントを拾うと、価格=BuyBox・
  // ポイント=別オファー、という食い違いで最新実質BuyBox が過小に化ける。
  // stripMarketplaceSection が両節を除いたクローンを返すので、それを走査対象にする。
  const scope = stripMarketplaceSection(card);

  // 1. Targeted scan: the .a-color-price span(s) that hold the points line.
  const priceSpans = scope.find('.a-color-price');
  for (let i = 0; i < priceSpans.length; i++) {
    const text = priceSpans.eq(i).text().trim();
    const m = text.match(/^(\d[\d,]*)\s*(?:ポイント|pt)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) || null;
  }

  // 2. Fallback: tight regex on the (stripped) card text, still anchored on
  // the "(N%)" suffix so promo copy never matches.
  const text = scope.text();
  const m = text.match(/(\d[\d,]*)\s*(?:ポイント|pt)\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10) || null;

  return null;
}

// Extract the shipping fee shown alongside the price ("配送料 ¥610" etc).
// Returns the integer yen amount, or null when the card has no explicit
// shipping line or only shows a non-numeric variant ("無料配送", "配送料
// 別途", …). The caller adds this to the BuyBox price so the stored
// value reflects what the buyer actually pays.
//
// Match strategy:
//   * Restrict to the BuyBox / featured-offer area whenever possible —
//     `[data-cy="shipping-info-recipe"]` is the structured tag Amazon
//     uses on most cards. Fall back to a tight regex on the full card
//     text only if the structured node is absent.
//   * Reject mp-section text — the seller-list under
//     「こちらからもご購入いただけます」 frequently shows its own
//     「+配送料 ¥XXX」 line, but those refer to the marketplace offer
//     and would double-charge the BuyBox row.
function extractShippingFee(card) {
  // 1. Structured node — preferred.
  const node = card.find('[data-cy="shipping-info-recipe"]').first();
  if (node.length) {
    const t = safeText(node);
    const m = t.match(/配送料\s*[:：]?\s*[¥￥]\s*([\d,]+)/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) || null;
    // Structured node present but no numeric fee → assume free shipping
    // (template put "無料配送" here). Return null so price is unchanged.
    return null;
  }

  // 2. Fallback: scan the card text but exclude the marketplace section
  //    so we don't pick up offer-list shipping lines.
  const scope = stripMarketplaceSection(card);
  const text = scope.text();
  const m = text.match(/配送料\s*[:：]?\s*[¥￥]\s*([\d,]+)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Extract the "過去1か月で○○点以上購入されました" sales indicator
// Amazon shows on some popular cards. The number is a lower-bound
// monthly purchase count threshold. Returns null when the card lacks
// the phrase.
//
// The regex is intentionally lenient because Amazon ships several
// templates that vary the visible text. Accepted variations:
//   * 半角 `1` / 全角 `１`
//   * か / ヵ / ヶ / カ                     (all four were spotted)
//   * 半角 `,` / 全角 `，` thousand separators
//   * 「購入されました」 / 「購入されています」 (perfect vs continuous)
//   * 全角数字 `０-９` inside the count itself (rare but possible)
//
// When the cue phrase is present but the full pattern still misses
// (Amazon changed something), a short snippet is logged so the regex
// can be tightened without guessing.
function extractMonthlySales(card) {
  const text = card.text();
  const m = text.match(
    /過去\s*[1１]\s*[かヵヶカ]月で\s*([\d,，０-９]+)\s*点\s*以上\s*購入され(?:ました|ています)/
  );
  if (!m) {
    if (text.includes('購入されました') || text.includes('購入されています')) {
      const idx = Math.max(0, text.indexOf('購入され') - 30);
      console.warn(
        '[parser] monthly-sales pattern unmatched — snippet: …' +
        text.slice(idx, idx + 60).replace(/\s+/g, ' ')
      );
    }
    return null;
  }
  // Normalize full-width digits / full-width commas before parsing.
  // Note: `String.fromCharCode(N)` — `String(N)` would emit the numeric
  // value as a decimal text ("50" instead of "2") and corrupt the
  // count silently.
  const numStr = m[1]
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[,，]/g, '');
  const n = parseInt(numStr, 10);
  return Number.isFinite(n) ? n : null;
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
  //
  // ★ 探索対象はマーケットプレイス節を除外したクローン。BuyBox 価格と
  // 発送情報が「Featured Offer の値」で揃うようにするため (2026-05 fix)。
  // 他の出品節にも delivery-recipe を貼るテンプレートがあり、それを拾うと
  // 「BuyBox=Featured Offer 価格」「発送情報=他の出品の配送日」と
  // 不整合になる。
  const scope = stripMarketplaceSection(card);

  // 1. Amazon's structured delivery block. data-cy="delivery-recipe"
  //    wraps just the delivery phrase — no purchase counts, no
  //    ratings, just "8月15日 木曜日にお届け" etc.
  //    safeText() strips inline <style>/<script> children that some
  //    Amazon templates embed (e.g. `.prime-brand-color { color: #...}`)
  //    which would otherwise pollute the delivery string. The follow-
  //    up stripCodeNoise pass also removes any CSS rule debris that
  //    survived in attribute or text-node form.
  const recipe = scope.find('[data-cy="delivery-recipe"]').first();
  if (recipe.length) {
    const t = stripCodeNoise(normalizeWhitespace(safeText(recipe)));
    if (t) return t;
  }

  // 2. udm-primary-delivery-message — alternate template Amazon serves
  //    on some search cards. Same shape: delivery text only.
  const udm = scope.find('.udm-primary-delivery-message, [data-component-type="s-delivery-block"]').first();
  if (udm.length) {
    const t = stripCodeNoise(normalizeWhitespace(safeText(udm)));
    if (t) return t;
  }

  // 3. aria-label that explicitly contains a delivery phrase. We
  //    require "お届け" (delivery), not the broader "配送" — "配送"
  //    can appear in unrelated labels like "他の出品の配送料は…" which
  //    are seller-info copy, not the shipping ETA.
  const ariaEl = scope.find('[aria-label*="お届け"]').first();
  if (ariaEl.length) {
    const aria = ariaEl.attr('aria-label');
    if (aria) return stripCodeNoise(normalizeWhitespace(aria));
  }

  // 4. data-csa-c-delivery-time attribute — structured but sometimes
  //    holds a verbose string. Trim to the date phrase.
  const deliveryAttr = scope.find('[data-csa-c-delivery-time]').first();
  if (deliveryAttr.length) {
    const v = deliveryAttr.attr('data-csa-c-delivery-time');
    if (v) return stripCodeNoise(normalizeWhitespace(v));
  }

  // 5. Last-resort regex on full card text, anchored to tight
  //    shipping-only patterns. No `.*?` — each alternative matches
  //    only a self-contained delivery phrase.
  const allText = scope.text();
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
