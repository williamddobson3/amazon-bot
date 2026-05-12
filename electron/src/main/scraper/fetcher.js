'use strict';

const { session } = require('electron');
const {
  AMAZON_BASE,
  JA_LANG_QUERY,
  FETCH_MIN_INTERVAL_MS,
  FETCH_JITTER_MS,
  CAPTCHA_PAUSE_LADDER_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_DURATION_MS,
  CIRCUIT_BREAKER_INTERVAL_MS,
} = require('../../shared/constants');

// A real Chrome 133 User-Agent on Windows. We MUST override Electron's
// default UA because it contains "Electron/33.x" which Amazon instantly
// classifies as a non-browser client, causing a 312 KB shell page
// instead of the full 1.5 MB SSR page with product cards.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// Call once on app init to strip "Electron" from all requests made via
// session.defaultSession (fetch, BrowserWindow, etc.).
function initSession() {
  const ses = session.defaultSession;
  ses.setUserAgent(CHROME_UA);
  console.log('[fetcher] session UA set to real Chrome');
}

// Check whether the defaultSession cookie jar contains a valid Amazon
// auth cookie. Amazon's auth token is marketplace-specific:
//   at-main    — US      (amazon.com)
//   at-acbjp   — Japan   (amazon.co.jp)
//   at-acb{cc} — other country-specific marketplaces
// Any at-* cookie with a real-length token value means signed in.
// Cheap (cookie-store read, no network), safe to call on every startup.
async function isSignedIn() {
  try {
    // `cookies.get({ url })` returns cookies that would be sent with a
    // request to that URL — resolves both `.amazon.co.jp` and
    // `amazon.co.jp` domain forms automatically.
    const cookies = await session.defaultSession.cookies.get({
      url: 'https://www.amazon.co.jp/',
    });
    return cookies.some((c) =>
      c.name && c.name.startsWith('at-') &&
      c.value && c.value.length > 10
    );
  } catch (err) {
    console.warn('[fetcher] cookie check failed:', err.message);
    return false;
  }
}

// ── Token bucket ────────────────────────────────────────────

let nextAllowedFetchAt = 0;
let pausedUntil        = 0;
let captchaStreak      = 0;
let lastPauseSetAt     = 0;
const PAUSE_DEDUP_MS   = 5000;

// Circuit breaker — when active, the token bucket uses the slower
// CIRCUIT_BREAKER_INTERVAL_MS instead of FETCH_MIN_INTERVAL_MS.
let circuitBreakerUntil = 0;

let onPauseCallback    = null; // set by scheduler
let onResumeCallback   = null;
let onCircuitCallback  = null;
let onBlockCallback    = null; // for telemetry logging

function setPauseCallbacks(onPause, onResume) {
  onPauseCallback = onPause;
  onResumeCallback = onResume;
}

function setCircuitCallback(cb) { onCircuitCallback = cb; }
function setBlockCallback(cb)   { onBlockCallback   = cb; }

// Abortable sleep — resolves either when the timer elapses or when the
// AbortSignal fires. The caller must check `signal?.aborted` after to
// know which path won, since both produce a fulfilled promise (no
// rejection — keeps the call-site simple).
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    }
  });
}

async function awaitFetchSlot(signal) {
  // 1. CAPTCHA pause
  if (pausedUntil > Date.now()) {
    await sleep(pausedUntil - Date.now(), signal);
    if (signal && signal.aborted) return;
  }
  // 2. Token bucket
  const now = Date.now();
  if (nextAllowedFetchAt > now) {
    await sleep(nextAllowedFetchAt - now, signal);
    if (signal && signal.aborted) return;
  }
  // 3. Reserve next slot — interval depends on circuit-breaker state.
  const minInterval = circuitBreakerUntil > Date.now()
    ? CIRCUIT_BREAKER_INTERVAL_MS
    : FETCH_MIN_INTERVAL_MS;
  const jitter = Math.floor(Math.random() * FETCH_JITTER_MS);
  nextAllowedFetchAt = Date.now() + minInterval + jitter;
}

function triggerPause(reason, solveUrl, source) {
  const now = Date.now();
  const withinBurst = (now - lastPauseSetAt) < PAUSE_DEDUP_MS;
  if (!withinBurst) captchaStreak++;
  lastPauseSetAt = now;

  const idx = Math.min(captchaStreak - 1, CAPTCHA_PAUSE_LADDER_MS.length - 1);
  const delay = CAPTCHA_PAUSE_LADDER_MS[idx];
  pausedUntil = now + delay;

  console.warn(
    `[fetcher] ${reason} — pausing ${Math.round(delay / 60000)} min ` +
    `(streak=${captchaStreak}${withinBurst ? ', burst' : ''}, source=${source})`
  );

  if (onBlockCallback) {
    onBlockCallback({
      type: reason,
      source,
      streak: captchaStreak,
      finalUrl: solveUrl,
      urlLen: (solveUrl || '').length,
    });
  }

  if (onPauseCallback) {
    onPauseCallback({ pausedUntil, reason, solveUrl, source, streak: captchaStreak });
  }

  // Circuit-breaker trip — only re-arm if not already tripped.
  if (captchaStreak >= CIRCUIT_BREAKER_THRESHOLD && circuitBreakerUntil < now) {
    circuitBreakerUntil = now + CIRCUIT_BREAKER_DURATION_MS;
    console.warn(
      `[fetcher] circuit breaker TRIPPED — pacing reduced to ${CIRCUIT_BREAKER_INTERVAL_MS/1000}s for 24h`
    );
    if (onCircuitCallback) {
      onCircuitCallback({ active: true, until: circuitBreakerUntil, streak: captchaStreak });
    }
  }
}

function resetStreak() {
  if (captchaStreak > 0) {
    console.info(`[fetcher] clean fetch after ${captchaStreak} block(s), resetting streak`);
    captchaStreak = 0;
  }
}

function liftPause() {
  pausedUntil   = 0;
  captchaStreak = 0;
  lastPauseSetAt = 0;
  if (onResumeCallback) onResumeCallback();
}

function isPaused() {
  return pausedUntil > Date.now();
}

function getPauseState() {
  if (pausedUntil > Date.now()) {
    return { pausedUntil, streak: captchaStreak };
  }
  return null;
}

function isCircuitBreakerActive() {
  return circuitBreakerUntil > Date.now();
}

function getCircuitBreakerState() {
  return circuitBreakerUntil > Date.now()
    ? { active: true, until: circuitBreakerUntil }
    : { active: false, until: 0 };
}

// Manual reset — exposed via IPC for the user to clear the breaker
// early if they've verified the block rate has recovered.
function clearCircuitBreaker() {
  if (circuitBreakerUntil > 0) {
    circuitBreakerUntil = 0;
    console.info('[fetcher] circuit breaker manually cleared');
    if (onCircuitCallback) onCircuitCallback({ active: false, until: 0 });
  }
}

// ── Block-page classification ───────────────────────────────

function classifyBlock(html, finalUrl) {
  if (
    finalUrl.includes('google.com/sorry') ||
    finalUrl.includes('google.co.jp/sorry') ||
    finalUrl.includes('ipv4.google.com') ||
    html.includes('unusual traffic from your computer network') ||
    html.includes('お使いのコンピュータ ネットワークから異常なトラフィック')
  ) {
    return { error: 'GOOGLE_CAPTCHA', reason: 'Google IP-level bot detection', source: 'google', solveUrl: finalUrl };
  }

  if (html.includes('google.com/recaptcha') || html.includes('g-recaptcha')) {
    return { error: 'GOOGLE_RECAPTCHA', reason: 'Google reCAPTCHA widget', source: 'google', solveUrl: finalUrl };
  }

  if (
    finalUrl &&
    !finalUrl.includes('amazon.co.jp') &&
    !finalUrl.includes('google.com') &&
    !finalUrl.includes('google.co.jp') &&
    !finalUrl.startsWith('about:') &&
    !finalUrl.startsWith('chrome')
  ) {
    return { error: 'NETWORK_BLOCK', reason: 'Network interception', source: 'network', solveUrl: finalUrl };
  }

  if (
    html.includes('validateCaptcha') ||
    html.includes('Type the characters you see in this image') ||
    html.includes('画像に表示されている文字を入力してください')
  ) {
    return { error: 'CAPTCHA', reason: 'Amazon CAPTCHA', source: 'amazon', solveUrl: finalUrl };
  }

  if (
    html.includes('Sorry, we just need to make sure') ||
    (html.includes('cs-help-home') && html.length < 5000)
  ) {
    return { error: 'DOG_PAGE', reason: 'Amazon dog page', source: 'amazon', solveUrl: finalUrl };
  }

  if (
    finalUrl.includes('/ap/signin') ||
    finalUrl.includes('/ap/register') ||
    (html.includes('ap_email') && html.includes('ap_password'))
  ) {
    return { error: 'LOGIN_REDIRECT', reason: 'Amazon login wall', source: 'amazon', solveUrl: finalUrl };
  }

  return null;
}

// ── Fetch ───────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': `${AMAZON_BASE}/`,
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="133", "Not:A-Brand";v="24", "Google Chrome";v="133"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
};

async function fetchPage(url, { signal } = {}) {
  await awaitFetchSlot(signal);
  if (signal && signal.aborted) return { error: 'ABORTED' };

  try {
    const ses = session.defaultSession;
    const response = await ses.fetch(url, {
      headers: { ...BROWSER_HEADERS },
      redirect: 'follow',
      credentials: 'include',
      signal,         // Cancels the in-flight request when stop() aborts
    });

    if (response.status === 429) {
      triggerPause('HTTP 429', url, 'amazon');
      return { error: 'RATE_LIMITED', status: 429 };
    }
    if (response.status === 503) {
      return { error: 'SERVICE_UNAVAILABLE', status: 503 };
    }
    if (!response.ok) {
      return { error: 'HTTP_ERROR', status: response.status };
    }

    const html = await response.text();
    const finalUrl = response.url || url;

    const block = classifyBlock(html, finalUrl);
    if (block) {
      triggerPause(block.reason, block.solveUrl, block.source);
      return { error: block.error, finalUrl, source: block.source, solveUrl: block.solveUrl };
    }

    resetStreak();
    return { html, finalUrl, htmlLen: html.length };
  } catch (err) {
    // ses.fetch throws AbortError when the AbortController fires while
    // the request is in flight. Surface as ABORTED so the coverage loop
    // can return cleanly without logging a spurious NETWORK_ERROR.
    if (err.name === 'AbortError' || (signal && signal.aborted)) {
      return { error: 'ABORTED' };
    }
    return { error: 'NETWORK_ERROR', message: err.message };
  }
}

// ── Warmup ──────────────────────────────────────────────────
//
// Called at the start of a run (or after a long idle) to simulate the
// first few requests a real user makes. Homepage first, then optionally
// a bestseller list or generic search. Seeds the session with an
// organic referrer chain and exercises the csm-hit cookie's page-view
// sequence so subsequent search URLs don't look like a cold scrape.
async function warmup() {
  const urls = [`${AMAZON_BASE}/`];
  if (Math.random() < 0.5) urls.push(`${AMAZON_BASE}/gp/bestsellers`);
  if (Math.random() < 0.5) {
    const genericQueries = ['ベストセラー', '新着', 'セール', '人気'];
    const q = genericQueries[Math.floor(Math.random() * genericQueries.length)];
    urls.push(`${AMAZON_BASE}/s?k=${encodeURIComponent(q)}&${JA_LANG_QUERY}`);
  }

  const ses = session.defaultSession;
  for (const url of urls) {
    await awaitFetchSlot();
    try {
      const response = await ses.fetch(url, {
        headers: { ...BROWSER_HEADERS },
        redirect: 'follow',
        credentials: 'include',
      });
      // Drain the body so cookies settle, then discard.
      await response.text();
      console.log(`[fetcher] warmup ${response.status} ${url.split('?')[0].slice(0, 50)}`);
    } catch (err) {
      console.warn(`[fetcher] warmup failed for ${url}: ${err.message}`);
    }
  }
}

module.exports = {
  initSession,
  fetchPage,
  triggerPause,
  liftPause,
  isPaused,
  getPauseState,
  setPauseCallbacks,
  setCircuitCallback,
  setBlockCallback,
  isCircuitBreakerActive,
  getCircuitBreakerState,
  clearCircuitBreaker,
  warmup,
  isSignedIn,
};
