'use strict';

const { BrowserWindow } = require('electron');
const { AMAZON_BASE, JA_LANG_QUERY } = require('../../shared/constants');

// ── Hidden capture window ───────────────────────────────────
//
// One reusable BrowserWindow shared across captures. Loading is the
// expensive part (~3-8s per page on a cold session), so reusing the
// window keeps the process JIT-warm and avoids GPU init per shot.
// Closed automatically after WINDOW_IDLE_MS of inactivity.
let captureWindow = null;
let lastUsedAt = 0;
let idleTimer = null;
const WINDOW_IDLE_MS = 90_000;
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS      = 900;
// Tall enough that a typical product card stays in the rendered region
// even when sponsored cards push it down the page.
const WIN_WIDTH      = 1280;
const WIN_HEIGHT     = 2400;

// Captures are serialised so a second request doesn't hijack the
// shared window's navigation mid-flight. Duplicate captures of the
// same ASIN are still bounded upstream by the 60-min FNM cooldown
// in ipc-handlers.js, which prevents notification spam from causing
// repeated captures of the same product.
let captureChain = Promise.resolve();

function getOrCreateWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) return captureWindow;

  captureWindow = new BrowserWindow({
    show: false,
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    webPreferences: {
      // Share the default session so cookies (auth, csm-hit) match the
      // scraper. Anonymous captures get blocked far faster.
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
      images: true,
    },
  });
  captureWindow.on('closed', () => { captureWindow = null; });
  return captureWindow;
}

function scheduleIdleClose() {
  lastUsedAt = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (
      captureWindow && !captureWindow.isDestroyed() &&
      Date.now() - lastUsedAt >= WINDOW_IDLE_MS
    ) {
      console.info('[screenshot] closing idle capture window');
      captureWindow.close();
      captureWindow = null;
    }
  }, WINDOW_IDLE_MS + 1500);
}

function loadWithTimeout(win, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      win.webContents.removeListener('did-finish-load', onLoad);
      win.webContents.removeListener('did-fail-load', onFail);
      clearTimeout(timer);
    };
    const onLoad = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
    const onFail = (_e, code, desc, validatedUrl, isMainFrame) => {
      // Sub-frame failures (ads, beacons) shouldn't reject the whole load.
      if (!isMainFrame) return;
      if (!settled) { settled = true; cleanup(); reject(new Error(`${code} ${desc}`)); }
    };

    const timer = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); reject(new Error(`navigation timeout after ${timeoutMs}ms`)); }
    }, timeoutMs);

    win.webContents.on('did-finish-load', onLoad);
    win.webContents.on('did-fail-load', onFail);
    win.loadURL(url).catch((err) => {
      if (!settled) { settled = true; cleanup(); reject(err); }
    });
  });
}

// ── Capture ─────────────────────────────────────────────────
//
// Returns one of:
//   { png: Buffer, source: 'search-card'|'detail-page', rect, url }
//   { error: 'INVALID_ASIN'|'CARD_NOT_FOUND'|'CAPTURE_FAILED', ... }
//
// Loads the search results page for a single ASIN, locates the matching
// product card via [data-component-type=s-search-result][data-asin=ASIN],
// then clips the page screenshot to that card's bounding rect. Falls
// back to /dp/<ASIN> when the card isn't on the search page (e.g.
// out-of-stock items Amazon hides from search).
async function captureProductCard(asin) {
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return { error: 'INVALID_ASIN', asin };
  }
  return captureChain = captureChain.then(() => doCapture(asin)).catch((err) => {
    console.error('[screenshot] chain error:', err.message);
    return { error: 'CAPTURE_FAILED', message: err.message };
  });
}

async function doCapture(asin) {
  const win = getOrCreateWindow();
  const searchUrl = `${AMAZON_BASE}/s?k=${asin}&${JA_LANG_QUERY}`;

  try {
    await loadWithTimeout(win, searchUrl, NAV_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // The card-locator runs in three phases inside the page:
    //   1. resolve the matching element by ASIN (preferring the
    //      mainline s-search-result over sponsored variants);
    //   2. scroll it to the TOP of the viewport with block:'start' so
    //      the rect we hand to capturePage is anchored at small y;
    //   3. wait two rAF frames so the scroll has actually painted
    //      before reading getBoundingClientRect — otherwise the rect
    //      reflects pre-scroll coordinates and capturePage clips the
    //      wrong region of the page (we saw exactly that bug in
    //      testing — the capture showed the page header above the
    //      card because rect.y was a stale post-scroll number that
    //      pointed at unscrolled content).
    const cardInfo = await win.webContents.executeJavaScript(`
      (async () => {
        const candidates = [
          'div[data-component-type="s-search-result"][data-asin="${asin}"]',
          'div[data-asin="${asin}"]:not([data-component-type="sp-sponsored-result"])',
          'div[data-asin="${asin}"]',
        ];
        let el = null;
        for (const sel of candidates) {
          el = document.querySelector(sel);
          if (el) break;
        }
        if (!el) return null;

        // Strip sticky overlays so they don't bleed into the capture
        // when we scroll the card to y=0.
        document.querySelectorAll('#navbar-main, #nav-main, .navFooterLine, #navFooter').forEach((n) => {
          n.style.position = 'static';
        });

        el.scrollIntoView({ block: 'start', behavior: 'instant' });
        // Two rAF guarantees the layout/paint has flushed.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        void el.offsetHeight;

        const r = el.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(r.left)),
          y: Math.max(0, Math.round(r.top)),
          width: Math.round(r.width),
          height: Math.round(r.height),
          type: el.getAttribute('data-component-type') || 'unknown',
          asinAttr: el.getAttribute('data-asin') || '',
        };
      })();
    `, true);

    if (
      cardInfo &&
      cardInfo.width >= 100 &&
      cardInfo.height >= 80 &&
      cardInfo.asinAttr === asin
    ) {
      const rect = {
        x: cardInfo.x,
        y: cardInfo.y,
        width: cardInfo.width,
        // Cap to a sane upper bound — Discord won't inline images
        // taller than ~2000px cleanly, and a card itself rarely
        // exceeds 1100px even with full A+ content.
        height: Math.min(cardInfo.height, 1400),
      };
      const image = await win.webContents.capturePage(rect);
      const png = image.toPNG();
      scheduleIdleClose();
      console.info(
        `[screenshot] ${asin}: ${cardInfo.type} ${rect.width}x${rect.height} ` +
        `(${(png.length / 1024).toFixed(1)}KB)`
      );
      return { png, source: 'search-card', rect, url: searchUrl };
    }

    // Fallback: product detail page. Slower (full DP page weight) but
    // works when Amazon hides the ASIN from the keyword search index.
    console.info(`[screenshot] card for ${asin} not on search page — falling back to /dp`);
    const dpUrl = `${AMAZON_BASE}/dp/${asin}`;
    await loadWithTimeout(win, dpUrl, NAV_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const dpRect = await win.webContents.executeJavaScript(`
      (() => {
        const candidates = ['#ppd', '#dp-container', '#centerCol', '#dp', 'body'];
        let el = null;
        for (const sel of candidates) {
          el = document.querySelector(sel);
          if (el) break;
        }
        if (!el) return null;
        el.scrollIntoView({ block: 'start' });
        void el.offsetHeight;
        const r = el.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(r.left)),
          y: Math.max(0, Math.round(r.top)),
          width: Math.round(r.width),
          // Cap detail-page height — full DP can be 4000px+ which
          // Discord refuses to inline.
          height: Math.min(1100, Math.round(r.height)),
        };
      })();
    `, true);

    if (!dpRect || dpRect.width < 100 || dpRect.height < 80) {
      return { error: 'CARD_NOT_FOUND', asin };
    }

    const image = await win.webContents.capturePage(dpRect);
    const png = image.toPNG();
    scheduleIdleClose();
    return { png, source: 'detail-page', rect: dpRect, url: dpUrl };
  } catch (err) {
    console.error(`[screenshot] capture failed for ${asin}:`, err.message);
    scheduleIdleClose();
    return { error: 'CAPTURE_FAILED', message: err.message, asin };
  }
}

function closeCaptureWindow() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
    captureWindow = null;
  }
}

module.exports = {
  captureProductCard,
  closeCaptureWindow,
};
