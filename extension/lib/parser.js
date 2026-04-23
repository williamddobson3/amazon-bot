let selectors = {
  version: 1,

  title: {
    primary: '#productTitle',
    fallback: '#title span',
  },

  price: {
    primary: '#corePrice_feature_div .a-offscreen',
    fallback: '.priceToPay .a-offscreen',
    buyBox: '#price_inside_buybox',
    wholeAndFraction: {
      whole: '.a-price-whole',
      fraction: '.a-price-fraction',
    },
  },

  points: {
    container: '#corePrice_feature_div',
    priceBlock: '[data-cy="price-recipe"]',
    colorClass: '.a-color-price',
  },

  delivery: {
    block: '#deliveryBlockMessage',
    csaTimeAttr: 'data-csa-c-delivery-time',
    csaCutoffAttr: 'data-csa-c-delivery-cutoff',
    csaPriceAttr: 'data-csa-c-delivery-price',
    primaryMessage: '.udm-primary-delivery-message',
    mirBlock: '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
  },

  asin: {
    linkPattern: /\/dp\/([A-Z0-9]{10})/,
    dataAttr: '[data-csa-c-asin]',
    inputName: 'input[name="ASIN"]',
    canonical: 'link[rel="canonical"]',
  },

  otherSellers: {
    container: '#olpLinkWidget_feature_div',
    ingressLink: '#aod-ingress-link',
    price: '#aod-ingress-link .a-price .a-offscreen',
    // Matches all known formats:
    //   "New & Used (21) from"  →  21   (English detail page)
    //   "新品・中古品 (21) から"  →  21   (Japanese detail page)
    //   "新品(21件)"             →  21   (compact Japanese)
    //   "New (5)"               →  5
    countPattern: /(?:New|新品)[^(]*\((\d+)/i,
  },
};

export function updateSelectors(newSelectors) {
  selectors = { ...selectors, ...newSelectors };
}

export function getSelectorVersion() {
  return selectors.version;
}

/**
 * Parse the Amazon.co.jp SEARCH RESULTS page for a specific ASIN.
 *
 * Expects HTML from `https://www.amazon.co.jp/s?k={ASIN}`.
 * Finds the main search-result card matching the given ASIN,
 * filters out Sponsored / Ad cards, and extracts 5 of the 7 fields:
 * ① title, ② price, ③ points, ④ delivery, ⑤ ASIN.
 *
 * Fields ⑥ (marketplace lowest) and ⑦ (new offer count) are NOT
 * available on the search results page — they require the detail
 * page (`/dp/{ASIN}`) and are filled in by a second fetch.
 */
export function parseSearchResultsPage(html, expectedAsin) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const card = findAsinCard(doc, expectedAsin);

  if (!card) {
    return {
      error: 'ASIN_NOT_IN_RESULTS',
      expected: expectedAsin,
    };
  }

  const result = {
    title: extractCardTitle(card),
    price: extractCardPrice(card),
    points: extractCardPoints(card),
    deliveryTime: extractCardDelivery(card),
    asin: expectedAsin,
    marketplaceLowest: null,
    newOfferCount: null,
    scrapedAt: Date.now(),
  };

  const missing = [];
  if (!result.title) missing.push('title');
  if (result.price == null) missing.push('price');

  if (missing.length > 0) {
    // Snippet of card innerHTML so the caller can inspect what Amazon
    // actually served us when selectors miss.
    const snippet = (card.innerHTML || '').slice(0, 800);
    return { error: 'PARSE_INCOMPLETE', missing, partial: result, cardSnippet: snippet };
  }

  return result;
}

function findAsinCard(doc, asin) {
  // Primary: role="listitem" + data-asin. Japanese and English layouts
  // both use this. Exclude sponsored (AdHolder / /sspa/click).
  let candidates = Array.from(doc.querySelectorAll(`div[role="listitem"][data-asin="${asin}"]`));

  // Fallback: any element with data-asin if none of the listitems match
  // (some locales / A/B tests don't set role="listitem" on the root).
  if (candidates.length === 0) {
    candidates = Array.from(doc.querySelectorAll(`[data-asin="${asin}"]`))
      // Prefer the "outermost" — parents before children
      .filter((el) => el.className && /s-result-item|s-card-container/.test(el.className));
  }

  for (const card of candidates) {
    if (card.classList?.contains?.('AdHolder')) continue;
    if (card.closest?.('.AdHolder')) continue;

    // Reject cards whose primary link points to a sponsored /sspa/click URL
    const primaryHref = card.querySelector('h2 a, a[href*="/dp/"]')?.getAttribute('href') || '';
    if (primaryHref.includes('/sspa/click')) continue;

    return card;
  }

  return null;
}

function extractCardTitle(card) {
  // Strategy 1: h2 aria-label (works on both JP and EN search pages)
  const h2 = card.querySelector('h2');
  if (h2) {
    const aria = h2.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().replace(/\s+/g, ' ');
    const span = h2.querySelector('span');
    if (span && span.textContent.trim()) return span.textContent.trim().replace(/\s+/g, ' ');
    const text = h2.textContent.trim();
    if (text) return text.replace(/\s+/g, ' ');
  }

  // Strategy 2: the product image alt text
  const img = card.querySelector('img.s-image');
  if (img) {
    const alt = img.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().replace(/\s+/g, ' ');
  }

  return null;
}

function extractCardPrice(card) {
  // Strategy 1: .a-price .a-offscreen (accessibility span, "¥4,780")
  const offscreen = card.querySelector('.a-price .a-offscreen');
  if (offscreen) {
    const p = parsePriceText(offscreen.textContent);
    if (p != null && p > 0) return p;
  }

  // Strategy 2: .a-price-whole (visible "4,780")
  const whole = card.querySelector('.a-price-whole');
  if (whole) {
    const val = parseInt(whole.textContent.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 3: data-csa-c-price-to-pay attribute (Add-to-Cart widget,
  // value like "4780.0")
  const priceAttrEls = card.querySelectorAll('[data-csa-c-price-to-pay]');
  for (const el of priceAttrEls) {
    const raw = el.getAttribute('data-csa-c-price-to-pay');
    if (!raw) continue;
    const val = Math.round(parseFloat(raw));
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 4: [data-a-price] / data-a-size="l" nested
  const priceEl = card.querySelector('span.a-price');
  if (priceEl) {
    const nested = priceEl.querySelector('.a-price-whole');
    if (nested) {
      const val = parseInt(nested.textContent.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(val) && val > 0) return val;
    }
  }

  // Strategy 5: regex over card's full text content for "¥4,780"
  //             This is the ultimate fallback and should catch any locale.
  const text = card.textContent || '';
  const yenMatch = text.match(/[¥￥]\s*([\d,]+)/);
  if (yenMatch) {
    const val = parseInt(yenMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 6: "NNN円" format (occasional Japanese variant)
  const enMatch = text.match(/([\d,]{3,})\s*円/);
  if (enMatch) {
    const val = parseInt(enMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(val) && val > 0) return val;
  }

  return null;
}

// Points and price use completely different Amazon CSS classes:
//   Price  → span.a-price          (text contains ¥)
//   Points → span.a-color-price    (text contains "N pt (N%)" or "Nポイント", NO ¥)
//
// The key rule: if the text contains ¥ or ￥ it is a price — skip it.
// If the text contains "pt" or "ポイント" without ¥ it is points.

function extractCardPoints(card) {
  // Strategy 1: .a-color-price elements only.
  // Parent container is a-color-secondary (points), NOT a-color-base (price).
  // Explicitly skip any element whose text contains ¥ to avoid false matches.
  const els = card.querySelectorAll('.a-color-price');
  for (const el of els) {
    const text = el.textContent || '';
    if (/[¥￥]/.test(text)) continue;           // skip — this is a price element
    let m = text.match(/(\d[\d,]*)\s*pt/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    m = text.match(/(\d[\d,]*)\s*ポイント/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  }

  // Strategy 2: scan innerHTML so each value is bounded by ">" on the left,
  // preventing textContent concatenation (e.g. "¥4,727"+"47 pt"→"4,72747 pt").
  // The ">...pt..." pattern ensures we are at a tag boundary, not mid-number.
  const html = card.innerHTML || '';
  let m = html.match(/>[ \t\n]*(\d[\d,]{0,5})[ \t]*pt[ \t\n<(]/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  m = html.match(/>[ \t\n]*(\d[\d,]{0,5})[ \t]*ポイント/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);

  return null;
}

function extractCardDelivery(card) {
  // Strategy 1: .udm-primary-delivery-message (standard udm block)
  const msg = card.querySelector('.udm-primary-delivery-message');
  if (msg) {
    const text = msg.textContent.trim().replace(/\s+/g, ' ');
    const boldDate = msg.querySelector('.a-text-bold');
    return {
      time: text,
      cutoff: '',
      deliveryPrice: /^FREE|無料|送料無料/.test(text) ? 'FREE' : '',
      dateBold: boldDate ? boldDate.textContent.trim().replace(/\s+/g, ' ') : '',
    };
  }

  // Strategy 2: any element with data-cy="delivery-recipe"
  const recipe = card.querySelector('[data-cy="delivery-recipe"]');
  if (recipe) {
    const text = recipe.textContent.trim().replace(/\s+/g, ' ');
    if (text) {
      return {
        time: text.slice(0, 200),
        cutoff: '',
        deliveryPrice: /^FREE|無料|送料無料/.test(text) ? 'FREE' : '',
        dateBold: '',
      };
    }
  }

  // Strategy 3: regex on card text for typical patterns
  const text = card.textContent || '';
  const patterns = [
    /(?:FREE\s+delivery|お届け|配送)[^。]{0,80}/i,
    /(\d+月\d+日[^\s]*)/,        // Japanese date like "4月12日 日曜日"
    /(\w{3},?\s+\w{3}\s+\d{1,2})/, // English date like "Sun, Apr 12"
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      return {
        time: m[0].trim().slice(0, 200),
        cutoff: '',
        deliveryPrice: /FREE|無料|送料無料/.test(m[0]) ? 'FREE' : '',
        dateBold: '',
      };
    }
  }

  return null;
}

export function parseProductPage(html, expectedAsin) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Source-of-truth ASIN: when we explicitly fetch /dp/{ASIN}, the URL
  // already guarantees which product we asked for. The page's canonical
  // <link> element often points to the PARENT ASIN of a variation family
  // (different color/size/capacity), even when the page itself is the
  // child variant we requested. So trust the URL, not the canonical.
  //
  // Sanity check: the requested ASIN should appear SOMEWHERE in the page
  // (in any data-csa-c-asin attribute, /dp/ link, or product input field).
  // If it doesn't appear at all, the page was probably redirected to a
  // completely different product → genuine mismatch.
  if (expectedAsin) {
    if (!asinAppearsOnPage(doc, html, expectedAsin)) {
      const extracted = extractAsin(doc);
      return { error: 'ASIN_MISMATCH', expected: expectedAsin, got: extracted };
    }
  }

  const result = {
    title: extractTitle(doc),
    price: extractPrice(doc),
    points: extractPoints(doc),
    deliveryTime: extractDelivery(doc),
    asin: expectedAsin || extractAsin(doc),
    marketplaceLowest: extractMarketplacePrice(doc),
    newOfferCount: extractOfferCount(doc),
    scrapedAt: Date.now(),
  };

  const missing = [];
  if (!result.title) missing.push('title');
  if (result.price === null) missing.push('price');
  if (result.asin === null) missing.push('asin');

  if (missing.length > 0) {
    return { error: 'PARSE_INCOMPLETE', missing, partial: result };
  }

  return result;
}

// Returns true if `expectedAsin` appears on the page in any of the canonical
// product-identifying locations (data-csa-c-asin, /dp/ link, or as an exact
// raw token). This confirms the page is for the requested product even when
// the canonical <link> points to a parent variation.
function asinAppearsOnPage(doc, html, expectedAsin) {
  // Fast path: any element with data-csa-c-asin matching the expected ASIN.
  // Detail pages have many of these (pointsInsideBuyBox_feature_div,
  // olpLinkWidget_feature_div, asin-related widgets, etc.)
  if (doc.querySelector(`[data-csa-c-asin="${expectedAsin}"]`)) return true;

  // Any /dp/{expectedAsin} link in the page (related products, breadcrumbs)
  if (doc.querySelector(`a[href*="/dp/${expectedAsin}"]`)) return true;

  // Hidden ASIN input
  const inp = doc.querySelector(`input[name="ASIN"]`);
  if (inp && inp.getAttribute('value') === expectedAsin) return true;

  // Last-ditch raw string scan — catches Amazon's inline JSON config blobs
  // that embed the ASIN in script tags. Cheap because we already have the
  // HTML string in memory.
  if (html && html.indexOf(expectedAsin) !== -1) return true;

  return false;
}

function extractTitle(doc) {
  const el =
    doc.querySelector(selectors.title.primary) ||
    doc.querySelector(selectors.title.fallback);
  if (!el) return null;
  return el.textContent.trim().replace(/\s+/g, ' ');
}

function extractPrice(doc) {
  const offscreen =
    doc.querySelector(selectors.price.primary) ||
    doc.querySelector(selectors.price.fallback) ||
    doc.querySelector(selectors.price.buyBox);

  if (offscreen) {
    return parsePriceText(offscreen.textContent);
  }

  const whole = doc.querySelector(selectors.price.wholeAndFraction.whole);
  if (whole) {
    const w = whole.textContent.replace(/[^0-9]/g, '');
    const val = parseInt(w, 10);
    return isNaN(val) ? null : val;
  }

  return null;
}

function extractPoints(doc) {
  const containers = [
    doc.querySelector(selectors.points.container),
    doc.querySelector(selectors.points.priceBlock),
  ];

  for (const container of containers) {
    if (!container) continue;
    const priceEls = container.querySelectorAll(selectors.points.colorClass);
    for (const el of priceEls) {
      const text = el.textContent;
      if (/[¥￥]/.test(text)) continue;         // skip — price element, not points
      const match = text.match(/(\d[\d,]*)\s*pt/i);
      if (match) {
        return parseInt(match[1].replace(/,/g, ''), 10);
      }
      const matchJp = text.match(/(\d[\d,]*)\s*ポイント/);
      if (matchJp) {
        return parseInt(matchJp[1].replace(/,/g, ''), 10);
      }
    }
  }

  // Strategy 3: search all .a-color-price elements across the whole document.
  // More reliable than body.textContent which concatenates adjacent price and
  // points digits (e.g. "¥4,727" + "47 pt" → "4,72747 pt" → 472747).
  // Skip any element whose text contains ¥ — that is a price, not points.
  const allColorPrice = doc.querySelectorAll('.a-color-price');
  for (const el of allColorPrice) {
    const text = el.textContent;
    if (/[¥￥]/.test(text)) continue;
    let m = text.match(/(\d[\d,]*)\s*pt/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    m = text.match(/(\d[\d,]*)\s*ポイント/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  }

  // Strategy 4: scan innerHTML so each value is bounded by ">" on the left,
  // preventing cross-element concatenation that textContent causes.
  const bodyHtml = doc.body ? doc.body.innerHTML : '';
  let gm = bodyHtml.match(/>[ \t\n]*(\d[\d,]{0,5})[ \t]*pt[ \t\n<(]/i);
  if (gm) return parseInt(gm[1].replace(/,/g, ''), 10);
  gm = bodyHtml.match(/>[ \t\n]*(\d[\d,]{0,5})[ \t]*ポイント/);
  if (gm) return parseInt(gm[1].replace(/,/g, ''), 10);

  return null;
}

function extractDelivery(doc) {
  const block = doc.querySelector(selectors.delivery.block) ||
                doc.querySelector(selectors.delivery.mirBlock);
  if (!block) return null;

  const csaEl = block.querySelector(`[${selectors.delivery.csaTimeAttr}]`);
  if (csaEl) {
    const time = csaEl.getAttribute(selectors.delivery.csaTimeAttr) || '';
    const cutoff = csaEl.getAttribute(selectors.delivery.csaCutoffAttr) || '';
    const price = csaEl.getAttribute(selectors.delivery.csaPriceAttr) || '';
    return { time, cutoff, deliveryPrice: price };
  }

  const msgEl = block.querySelector(selectors.delivery.primaryMessage) || block;
  const text = msgEl.textContent.trim().replace(/\s+/g, ' ');
  return { time: text, cutoff: '', deliveryPrice: '' };
}

function extractAsin(doc) {
  const canonical = doc.querySelector(selectors.asin.canonical);
  if (canonical) {
    const match = canonical.getAttribute('href')?.match(selectors.asin.linkPattern);
    if (match) return match[1];
  }

  const dataEl = doc.querySelector(selectors.asin.dataAttr);
  if (dataEl) {
    const val = dataEl.getAttribute('data-csa-c-asin');
    if (val && /^[A-Z0-9]{10}$/.test(val)) return val;
  }

  const input = doc.querySelector(selectors.asin.inputName);
  if (input) {
    const val = input.getAttribute('value');
    if (val && /^[A-Z0-9]{10}$/.test(val)) return val;
  }

  const links = doc.querySelectorAll('a[href*="/dp/"]');
  for (const link of links) {
    const match = link.getAttribute('href')?.match(selectors.asin.linkPattern);
    if (match) return match[1];
  }

  return null;
}

function extractMarketplacePrice(doc) {
  const priceEl = doc.querySelector(selectors.otherSellers.price);
  if (priceEl) {
    return parsePriceText(priceEl.textContent);
  }

  const container = doc.querySelector(selectors.otherSellers.container);
  if (!container) return null;

  const allPrices = container.querySelectorAll('.a-price .a-offscreen');
  for (const el of allPrices) {
    const p = parsePriceText(el.textContent);
    if (p !== null) return p;
  }

  return null;
}

function extractOfferCount(doc) {
  const link = doc.querySelector(selectors.otherSellers.ingressLink);
  if (!link) {
    const container = doc.querySelector(selectors.otherSellers.container);
    if (!container) return null;
    const text = container.textContent;
    const match = text.match(selectors.otherSellers.countPattern);
    return match ? parseInt(match[1], 10) : null;
  }

  const text = link.textContent;
  const match = text.match(selectors.otherSellers.countPattern);
  return match ? parseInt(match[1], 10) : null;
}

function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[¥￥,\s]/g, '');
  const match = cleaned.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
