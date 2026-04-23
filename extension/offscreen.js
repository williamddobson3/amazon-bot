import { parseProductPage } from './lib/parser.js';
import { MSG } from './lib/constants.js';

const AMAZON_BASE = 'https://www.amazon.co.jp';
// Japanese-only project: every URL force-sets the UI language via the
// `language=ja_JP` query param + `__mk_ja_JP` legacy flag. Combined with
// the Accept-Language header below, this guarantees Japanese text even
// when the caller's Amazon account or browser prefers another locale.
const JA_LANG_QUERY = 'language=ja_JP&__mk_ja_JP=%E3%82%AB%E3%82%BF%E3%82%AB%E3%83%8A';

// ── Pacing: token bucket ──────────────────────────────────
//
// Every actual fetch to amazon.co.jp goes through awaitFetchSlot() which
// enforces a minimum spacing + random jitter between consecutive fetches
// across ALL concurrent workers. This is the single biggest bot-detection
// defense: instead of bursting 3 requests in the same millisecond, we
// stagger them over ~2 s, matching the traffic profile of a human who
// opened several tabs.
//
// FETCH_MIN_INTERVAL_MS + [0, FETCH_JITTER_MS) ms between starts.
// At 1500 + 0..2000 that's ~1.5-3.5 s, avg ~2.5 s → ~24 req/min.
const FETCH_MIN_INTERVAL_MS = 1500;
const FETCH_JITTER_MS       = 2000;
const MAX_CONCURRENT        = 3;

let activeFetches = 0;
const queue = [];

// Timestamp (ms since epoch) at which the NEXT fetch is allowed to
// start. Writers reserve the slot by bumping this forward before they
// begin their fetch, so concurrent callers serialise naturally.
let nextAllowedFetchAt = 0;

// ── CAPTCHA pause (session-level backoff) ─────────────────
//
// When Amazon shows us a CAPTCHA or a 429, the suspicion score against
// our current session is high. Hammering individual rows with their own
// per-row retry ladders would make it worse. Instead we pause ALL
// fetches for an exponentially growing window and notify background.js
// so it can reject incoming SCRAPE_JOBs without even trying.
//
// Ladder:  2 min → 5 min → 10 min → 20 min → 30 min (cap).
// A single clean successful scrape resets the streak.
const CAPTCHA_PAUSE_LADDER_MS = [
  2  * 60 * 1000,
  5  * 60 * 1000,
  10 * 60 * 1000,
  20 * 60 * 1000,
  30 * 60 * 1000,
];
// Burst-dedup: if multiple parallel scrapes all hit CAPTCHA at nearly
// the same time they would otherwise each increment the streak and
// escalate the pause prematurely. Any trigger within this window of the
// previous one is treated as the same event.
const PAUSE_DEDUP_WINDOW_MS = 5000;

let pausedUntil    = 0;
let captchaStreak  = 0;
let lastPauseSetAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function awaitFetchSlot(options) {
  const bypassPause = !!(options && options.bypassPause);

  // 1. Wait out any active CAPTCHA pause. The recovery probe sets
  //    bypassPause=true so it can sanity-check the session while the
  //    pause is still technically active.
  if (!bypassPause) {
    const now1 = Date.now();
    if (pausedUntil > now1) {
      await sleep(pausedUntil - now1);
    }
  }
  // 2. Wait out the token-bucket slot (always — even the probe should
  //    be paced so it doesn't look like a bot testing the waters).
  const now2 = Date.now();
  if (nextAllowedFetchAt > now2) {
    await sleep(nextAllowedFetchAt - now2);
  }
  // 3. Reserve the next slot BEFORE returning so a second concurrent
  //    caller stacks behind us instead of firing in the same tick.
  const jitter = Math.floor(Math.random() * FETCH_JITTER_MS);
  nextAllowedFetchAt = Date.now() + FETCH_MIN_INTERVAL_MS + jitter;
}

// `source` tells background what kind of CAPTCHA was detected so it can
// decide which URLs to open in the solve flow and whether to auto-tighten
// the token bucket:
//   'amazon'  — Amazon's own /errors/validateCaptcha or dog/login page
//   'google'  — Google reCAPTCHA widget inside Amazon's page, or Google's
//               own "unusual traffic" sorry page, or Google IP-level block
//   'network' — ISP / middle-box / proxy intercepted the request
function triggerCaptchaPause(reason, captchaUrl, source) {
  // Burst dedup: 3 parallel scrapes all hitting CAPTCHA in the same
  // second must not triple-count the streak. Within the dedup window
  // we just refresh pausedUntil without incrementing the streak.
  const now = Date.now();
  const withinBurst = (now - lastPauseSetAt) < PAUSE_DEDUP_WINDOW_MS;
  if (!withinBurst) {
    captchaStreak++;
  }
  lastPauseSetAt = now;

  const idx = Math.min(captchaStreak - 1, CAPTCHA_PAUSE_LADDER_MS.length - 1);
  const delay = CAPTCHA_PAUSE_LADDER_MS[idx];
  pausedUntil = now + delay;
  console.warn(
    `[offscreen] ${reason} — pausing all fetches for ${Math.round(delay / 60000)} min ` +
    `(streak=${captchaStreak}${withinBurst ? ', burst' : ''}, source=${source || 'unknown'})`
  );
  // Let background know so it can short-circuit incoming SCRAPE_JOBs
  // AND surface the CAPTCHA to the user (notification + side-panel banner).
  try {
    chrome.runtime.sendMessage({
      type: MSG.CLIENT_PAUSE,
      pausedUntil,
      reason,
      streak: captchaStreak,
      captchaUrl: captchaUrl || null,
      source: source || 'amazon',
    });
  } catch { /* background may not be up — it will rediscover on next msg */ }
}

function resetCaptchaStreak() {
  if (captchaStreak > 0) {
    console.info(`[offscreen] clean scrape after ${captchaStreak} CAPTCHA(s), resetting streak`);
    captchaStreak = 0;
  }
}

// Background tells us the user solved the CAPTCHA (or the recovery
// probe confirmed the session is clean). Reset state immediately so
// the next fetch runs without waiting for the ladder to expire.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.CLIENT_RESUME) {
    if (pausedUntil > 0 || captchaStreak > 0) {
      console.info('[offscreen] CLIENT_RESUME received — clearing pause state');
    }
    pausedUntil   = 0;
    captchaStreak = 0;
    lastPauseSetAt = 0;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === MSG.SCRAPE) {
    enqueueScrape(msg.asin, msg.useCredentials !== false, !!msg.bypassPause)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message || 'UNKNOWN' }));
    return true;
  }
});

function enqueueScrape(asin, useCredentials, bypassPause) {
  return new Promise((resolve, reject) => {
    queue.push({ asin, useCredentials, bypassPause, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  while (queue.length > 0 && activeFetches < MAX_CONCURRENT) {
    const job = queue.shift();
    activeFetches++;
    try {
      const result = await scrapeAsin(job.asin, job.useCredentials, job.bypassPause);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      activeFetches--;
      // Pacing between jobs is now handled by awaitFetchSlot's token
      // bucket, which runs AT the start of each fetch. No per-job
      // setTimeout is needed here; the while loop re-checks the queue
      // immediately and the next iteration will block inside
      // awaitFetchSlot until its slot is available.
    }
  }
}

/**
 * Scrape a single ASIN by fetching ONLY the detail URL /dp/{ASIN}.
 *
 * Architectural decision: we no longer scrape the search results page.
 * The detail page provides all 7 fields more reliably:
 *   ① title          → #productTitle
 *   ② price          → .a-price .a-offscreen
 *   ③ points         → #pointsInsideBuyBox_feature_div
 *   ④ delivery time  → [data-csa-c-delivery-time] (structured attribute!)
 *   ⑤ ASIN           → known from URL
 *   ⑥ marketplaceLowest → #olpLinkWidget_feature_div
 *   ⑦ newOfferCount  → #olpLinkWidget_feature_div "新品 (N)"
 *
 * Benefits:
 *   - 1 fetch instead of 2 → ~15% faster
 *   - No A/B-bucket variance (search card ⑥⑦ are conditional)
 *   - Single parser, single HTML structure
 *   - Lower CAPTCHA exposure (one endpoint instead of two)
 */
async function scrapeAsin(asin, useCredentials, bypassPause) {
  return scrapeDetailPage(asin, useCredentials, bypassPause);
}

async function scrapeDetailPage(asin, useCredentials, bypassPause) {
  // Pacing gate: enforces token-bucket spacing AND waits out any active
  // CAPTCHA pause. Every real fetch must funnel through here. The
  // recovery probe from background sets bypassPause=true so it can
  // sanity-check the session while the pause is still technically
  // active — it's the only caller allowed to skip the pause wait.
  await awaitFetchSlot({ bypassPause });

  const response = await fetchAmazon(`${AMAZON_BASE}/dp/${asin}?${JA_LANG_QUERY}`, useCredentials);
  if (response.error) {
    // Network-level rate limiting is a session-level signal — trigger
    // the CAPTCHA pause ladder the same way as an actual CAPTCHA page.
    if (response.error === 'RATE_LIMITED') {
      triggerCaptchaPause('HTTP 429 RATE_LIMITED', `${AMAZON_BASE}/dp/${asin}`);
    }
    return { ...response, asin };
  }

  const { html, finalUrl, htmlLen } = response;

  // ── Classify the response ───────────────────────────────
  // Check for Google/ISP/network-level blocks FIRST because they can
  // intercept the response before Amazon's own page is served. If the
  // fetch was redirected off-site (finalUrl no longer starts with
  // amazon.co.jp) that's a strong signal of ISP/network interception.
  const block = classifyBlockPage(html, finalUrl);

  if (block) {
    triggerCaptchaPause(block.reason, block.solveUrl, block.source);
    return { error: block.error, asin, finalUrl, htmlLen, source: block.source };
  }

  const result = parseProductPage(html, asin);

  if (result.error) {
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    console.warn(
      `[detail-only ${asin}] parse failed: ${result.error}`,
      result.missing ? `missing=[${result.missing.join(',')}]` : '',
      `finalUrl=${finalUrl}`,
      `htmlLen=${htmlLen}`,
      titleTag ? `<title>=${titleTag.slice(0, 200)}` : ''
    );
    return { ...result, asin, finalUrl, htmlLen };
  }

  // Clean scrape — Amazon trusts our session again, reset the streak.
  resetCaptchaStreak();

  return {
    asin,
    title: result.title,
    price: result.price,
    points: result.points,
    deliveryTime: result.deliveryTime,
    marketplaceLowest: result.marketplaceLowest,
    newOfferCount: result.newOfferCount,
    scrapedAt: result.scrapedAt,
  };
}

// ── Shared fetch helper ────────────────────────────────────

async function fetchAmazon(url, useCredentials) {
  // Minimal header overrides. Every extra header we set is a fingerprint
  // vs. real Chrome — so we only override what we *must* (locale) and
  // let Chrome fill in the rest (User-Agent, Accept, Accept-Encoding,
  // sec-fetch-*, sec-ch-ua). Notably we DO NOT send:
  //   - a truncated "Accept: text/html,application/xhtml+xml"  (real Chrome sends a much longer list)
  //   - "Cache-Control: no-cache" (real browsers only send this on reload)
  //   - a custom User-Agent (stay with Chrome's default)
  //
  // Referer is set to the Amazon.co.jp root so the request looks like an
  // internal navigation from the homepage rather than a bare context-less
  // hit on /dp/{asin}.
  const headers = {
    'Accept-Language': 'ja-JP,ja;q=0.9',
    'Referer': `${AMAZON_BASE}/`,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      credentials: useCredentials ? 'include' : 'omit',
      redirect: 'follow',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
  } catch (err) {
    return { error: 'NETWORK_ERROR', message: err.message };
  }

  if (!response.ok) {
    if (response.status === 429) return { error: 'RATE_LIMITED', status: 429 };
    if (response.status === 503) return { error: 'SERVICE_UNAVAILABLE', status: 503 };
    return { error: 'HTTP_ERROR', status: response.status };
  }

  const html = await response.text();
  return { html, finalUrl: response.url, htmlLen: html.length };
}

// ── Page detection helpers ─────────────────────────────────
//
// classifyBlockPage returns null if the page is normal, or an object
// { error, reason, source, solveUrl } if any anti-bot block is detected.
// It checks Google/ISP-level blocks FIRST (they can intercept responses
// before Amazon's page is even served), then Amazon-specific blocks.
//
// source values:
//   'google'  — Google reCAPTCHA widget OR Google's own "unusual traffic"
//   'network' — ISP / CDN / proxy injected a challenge page
//   'amazon'  — Amazon's own CAPTCHA, dog page, or login wall

function classifyBlockPage(html, finalUrl) {
  // ── 1. Google IP-level block ("/sorry" page) ──────────
  // Google's own "Our systems have detected unusual traffic" page. This
  // fires when your IP's aggregate request volume (across ALL sites) is
  // flagged. The user should solve it at google.com to clear the IP flag.
  if (
    finalUrl.includes('google.com/sorry') ||
    finalUrl.includes('google.co.jp/sorry') ||
    finalUrl.includes('ipv4.google.com') ||
    html.includes('unusual traffic from your computer network') ||
    html.includes('お使いのコンピュータ ネットワークから異常なトラフィック')
  ) {
    return {
      error:   'GOOGLE_CAPTCHA',
      reason:  'Google IP-level bot detection',
      source:  'google',
      solveUrl: finalUrl.startsWith('http') ? finalUrl : 'https://www.google.co.jp/',
    };
  }

  // ── 2. Google reCAPTCHA widget inside ANY page ────────
  // Amazon sometimes serves a Google reCAPTCHA v2/v3 widget instead of
  // their own text CAPTCHA. The page URL is still amazon.co.jp, but the
  // widget itself comes from google.com/recaptcha.
  if (html.includes('google.com/recaptcha') || html.includes('g-recaptcha')) {
    return {
      error:   'GOOGLE_RECAPTCHA',
      reason:  'Google reCAPTCHA widget',
      source:  'google',
      solveUrl: finalUrl,
    };
  }

  // ── 3. Network / ISP interception ─────────────────────
  // If the final URL is NOT on amazon.co.jp AND not on google.com, the
  // request was intercepted by a middle-box (ISP transparent proxy,
  // corporate firewall, VPN gateway, etc.). Open whatever they served.
  if (
    finalUrl &&
    !finalUrl.includes('amazon.co.jp') &&
    !finalUrl.includes('google.com') &&
    !finalUrl.includes('google.co.jp') &&
    !finalUrl.startsWith('about:') &&
    !finalUrl.startsWith('chrome')
  ) {
    return {
      error:   'NETWORK_BLOCK',
      reason:  'Network-level interception',
      source:  'network',
      solveUrl: finalUrl,
    };
  }

  // ── 4. Amazon CAPTCHA (own text-CAPTCHA form) ────────
  if (
    html.includes('validateCaptcha') ||
    html.includes('Type the characters you see in this image') ||
    html.includes('画像に表示されている文字を入力してください')
  ) {
    return {
      error:   'CAPTCHA',
      reason:  'Amazon CAPTCHA page',
      source:  'amazon',
      solveUrl: finalUrl,
    };
  }

  // ── 5. Amazon dog page ────────────────────────────────
  if (
    html.includes('Sorry, we just need to make sure') ||
    (html.includes('cs-help-home') && html.length < 5000)
  ) {
    return {
      error:   'DOG_PAGE',
      reason:  'Amazon dog/error page',
      source:  'amazon',
      solveUrl: finalUrl,
    };
  }

  // ── 6. Amazon login wall ──────────────────────────────
  if (
    finalUrl.includes('/ap/signin') ||
    finalUrl.includes('/ap/register') ||
    (html.includes('ap_email') && html.includes('ap_password'))
  ) {
    return {
      error:   'LOGIN_REDIRECT',
      reason:  'Amazon login wall',
      source:  'amazon',
      solveUrl: finalUrl,
    };
  }

  return null; // clean page
}
