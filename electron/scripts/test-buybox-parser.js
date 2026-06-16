'use strict';
// Parity test for the JS search-parser BuyBox/points fix (mirrors the Rust unit tests).
// BuyBox price must come from data-csa-c-price-to-pay; points must belong to the
// SAME offer as the BuyBox (alt "より速くお届け" / marketplace points excluded).
const { parseSearchResults } = require('../src/main/scraper/search-parser');

// Card A: BuyBox ¥4,566 (price-recipe + atc price-to-pay); ¥6,534 + 1876pt are an
// ALTERNATIVE offer in multi-offer-display → must NOT be used.
const CARD_BUYBOX_4566 = `<div data-component-type="s-search-result" data-asin="B0CCTXFCDP">
  <div data-cy="price-recipe" class="a-section"><div class="a-row a-size-base a-color-base"><div class="a-row">
    <a aria-describedby="price-link">
      <span class="a-price" data-a-color="price"><span class="a-offscreen">￥4,566</span></span>
      <span class="a-offscreen">参考: ￥5,400</span>
      <div class="a-section aok-inline-block"><span class="a-color-secondary">参考: </span>
        <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">￥5,400</span></span></div>
    </a></div></div></div>
  <div data-cy="add-to-cart"><div class="ax-atc atc-btn-container" data-csa-c-price-to-pay="4566.0">
    <div data-csa-c-type="action" data-csa-c-price-to-pay="4566.0"><button>カートに入れる</button></div></div></div>
  <div data-cy="multi-offer-display" class="a-row"><a><span class="a-color-link a-text-bold">より速くお届け</span></a>
    <div class="a-row"><a aria-describedby="price-link"><span class="a-price" data-a-color="price"><span class="a-offscreen">￥6,534</span></span></a></div>
    <div class="a-row a-color-secondary"><span class="a-color-price">1876ポイント(29%)</span></div></div>
</div>`;

// Card B: BuyBox ¥6,534 (price-recipe) WITH its own 1876pt in price-recipe; ¥4,566 is こちらからも other-seller.
const CARD_BUYBOX_6534 = `<div data-component-type="s-search-result" data-asin="B0CCTXFCDP">
  <div data-cy="price-recipe" class="a-section"><div class="a-row a-size-base a-color-base"><div class="a-row">
    <a aria-describedby="price-link"><span class="a-price" data-a-color="price"><span class="a-offscreen">￥6,534</span></span></a></div></div>
    <div class="a-row a-color-secondary"><span class="a-color-price">1876ポイント(29%)</span></div></div>
  <div data-cy="add-to-cart"><div class="ax-atc atc-btn-container" data-csa-c-price-to-pay="6534.0"><button>カートに入れる</button></div></div>
  <div data-cy="secondary-offer-recipe" class="a-section"><div class="a-row a-color-secondary">
    <span class="a-color-secondary">こちらからもご購入いただけます</span><br>
    <span class="a-color-price">￥4,566</span>
    <a href="/gp/offer-listing/B0CCTXFCDP/">（14点の新品）</a></div></div>
</div>`;

// No Buy Box: only third-party ¥4,893, no add-to-cart.
const CARD_NO_BUYBOX = `<div data-component-type="s-search-result" data-asin="B0CCTXFCDP">
  <div data-cy="secondary-offer-recipe" class="a-section"><div class="a-row a-color-secondary">
    <span class="a-color-secondary">「おすすめ出品」の要件を満たす出品はありません</span><br>
    <span class="a-color-price">￥4,893</span>
    <a href="/gp/offer-listing/B0CCTXFCDP/">（2点の新品）</a></div></div>
</div>`;

let fails = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
  if (!ok) fails++;
};
const one = (html) => parseSearchResults(html)[0];

let p = one(CARD_BUYBOX_4566);
eq('cardA price = 4566 (price-to-pay, not the ¥6,534 alt)', p.price, 4566);
eq('cardA points = null (1876pt belongs to ¥6,534 alt offer)', p.points, null);

p = one(CARD_BUYBOX_6534);
eq('cardB price = 6534', p.price, 6534);
eq('cardB points = 1876 (its own price-recipe points)', p.points, 1876);
eq('cardB mpPrice = 4566 (other-seller)', p.mpPrice, 4566);

p = one(CARD_NO_BUYBOX);
eq('no-buybox price = null', p.price, null);
eq('no-buybox points = null', p.points, null);
eq('no-buybox mpPrice = 4893', p.mpPrice, 4893);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAIL(S)'}`);
process.exit(fails === 0 ? 0 : 1);
