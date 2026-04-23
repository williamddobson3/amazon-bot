'use strict';

const { session } = require('electron');
const {
  AMAZON_BASE,
  FETCH_MIN_INTERVAL_MS,
  FETCH_JITTER_MS,
  CAPTCHA_PAUSE_LADDER_MS,
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

// ── Token bucket ────────────────────────────────────────────

let nextAllowedFetchAt = 0;
let pausedUntil        = 0;
let captchaStreak      = 0;
let lastPauseSetAt     = 0;
const PAUSE_DEDUP_MS   = 5000;

let onPauseCallback    = null; // set by scheduler
let onResumeCallback   = null;

function setPauseCallbacks(onPause, onResume) {
  onPauseCallback = onPause;
  onResumeCallback = onResume;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function awaitFetchSlot() {
  // 1. CAPTCHA pause
  if (pausedUntil > Date.now()) {
    await sleep(pausedUntil - Date.now());
  }
  // 2. Token bucket
  const now = Date.now();
  if (nextAllowedFetchAt > now) {
    await sleep(nextAllowedFetchAt - now);
  }
  // 3. Reserve next slot
  const jitter = Math.floor(Math.random() * FETCH_JITTER_MS);
  nextAllowedFetchAt = Date.now() + FETCH_MIN_INTERVAL_MS + jitter;
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

  if (onPauseCallback) {
    onPauseCallback({ pausedUntil, reason, solveUrl, source, streak: captchaStreak });
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

// ── Block-page classification ───────────────────────────────

function classifyBlock(html, finalUrl) {
  // Google IP-level block
  if (
    finalUrl.includes('google.com/sorry') ||
    finalUrl.includes('google.co.jp/sorry') ||
    finalUrl.includes('ipv4.google.com') ||
    html.includes('unusual traffic from your computer network') ||
    html.includes('お使いのコンピュータ ネットワークから異常なトラフィック')
  ) {
    return { error: 'GOOGLE_CAPTCHA', reason: 'Google IP-level bot detection', source: 'google', solveUrl: finalUrl };
  }

  // Google reCAPTCHA widget
  if (html.includes('google.com/recaptcha') || html.includes('g-recaptcha')) {
    return { error: 'GOOGLE_RECAPTCHA', reason: 'Google reCAPTCHA widget', source: 'google', solveUrl: finalUrl };
  }

  // Network / ISP interception
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

  // Amazon CAPTCHA
  if (
    html.includes('validateCaptcha') ||
    html.includes('Type the characters you see in this image') ||
    html.includes('画像に表示されている文字を入力してください')
  ) {
    return { error: 'CAPTCHA', reason: 'Amazon CAPTCHA', source: 'amazon', solveUrl: finalUrl };
  }

  // Amazon dog page
  if (
    html.includes('Sorry, we just need to make sure') ||
    (html.includes('cs-help-home') && html.length < 5000)
  ) {
    return { error: 'DOG_PAGE', reason: 'Amazon dog page', source: 'amazon', solveUrl: finalUrl };
  }

  // Amazon login wall
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

// Full set of headers matching a real Chrome 133 top-level navigation.
// These are what Amazon's WAF checks to decide whether to serve the full
// SSR page (with product cards) or a JS-dependent shell.
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

async function fetchPage(url) {
  await awaitFetchSlot();

  try {
    const ses = session.defaultSession;
    const response = await ses.fetch(url, {
      headers: { ...BROWSER_HEADERS },
      redirect: 'follow',
      credentials: 'include',
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

    // Clean fetch
    resetStreak();
    return { html, finalUrl, htmlLen: html.length };
  } catch (err) {
    return { error: 'NETWORK_ERROR', message: err.message };
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
};
