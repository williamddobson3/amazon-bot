import { ALARM_TICK, ALARM_SYNC, ALARM_INTERVAL_MIN, SYNC_INTERVAL_MIN, MSG, WS_MSG, POPUP_MSG, BACKEND_WS_URL, BACKEND_HTTP_URL } from './lib/constants.js';
import {
  openDB, addObservation, getObservations, putAsin, deleteAsin, getAsin, getAllAsins, getAsinCount,
  bulkPutAsins, bulkDeleteAsins,
  getSetting, setSetting,
  addCondition, getAllConditions, deleteCondition,
  addNotification, getRecentNotifications,
  pruneObservations,
} from './lib/db.js';
import { updateSelectors, getSelectorVersion } from './lib/parser.js';

let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
let authToken = null;
let offscreenPromise = null;

// ── Lifecycle ──────────────────────────────────────────────
//
// Manifest V3 Service Workers die after ~30s idle and re-evaluate this
// module on every wake-up. We must do all init at the top level (this IIFE),
// not just in onInstalled / onStartup which only fire on specific events.

(async function init() {
  try {
    // Clicking the extension icon opens the side panel (right side of browser)
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    await openDB();
    await ensureAlarms();
    await ensureOffscreen();
    connectWebSocket();
  } catch (err) {
    console.error('init error:', err);
  }
})();

chrome.runtime.onInstalled.addListener(async () => {
  await openDB();
  await ensureAlarms();
  await ensureOffscreen();
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(async () => {
  await openDB();
  await ensureAlarms();
  await ensureOffscreen();
  connectWebSocket();
});

async function ensureAlarms() {
  const existing = await chrome.alarms.get(ALARM_TICK);
  if (!existing) {
    chrome.alarms.create(ALARM_TICK, { periodInMinutes: ALARM_INTERVAL_MIN });
  }
  const syncExisting = await chrome.alarms.get(ALARM_SYNC);
  if (!syncExisting) {
    chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_INTERVAL_MIN });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) {
    await onTick();
  } else if (alarm.name === ALARM_SYNC) {
    await onSync();
  }
});

// ── Offscreen Document ─────────────────────────────────────
//
// Chrome allows only ONE offscreen document per extension. If several
// callers hit ensureOffscreen() at the same time, all of them race past
// the getContexts() check and try to createDocument() twice — throwing
// "Only a single offscreen document may be created." We serialize via
// a singleton Promise so concurrent callers await the same creation.

async function ensureOffscreen() {
  if (offscreenPromise) return offscreenPromise;

  offscreenPromise = (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (contexts.length > 0) return;

      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse Amazon product page HTML to extract price data',
      });
    } catch (err) {
      // Swallow the benign "already exists" race; rethrow everything else.
      const msg = String(err?.message || err);
      if (msg.includes('single offscreen document') || msg.includes('already')) {
        return;
      }
      offscreenPromise = null;
      throw err;
    }
  })();

  return offscreenPromise;
}

async function requestScrape(asin, useCredentials = true) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: MSG.SCRAPE, asin, useCredentials },
      (response) => resolve(response)
    );
  });
}

// ── WebSocket ──────────────────────────────────────────────

function connectWebSocket() {
  if (ws && ws.readyState <= 1) return;

  getSetting('authToken').then((token) => {
    authToken = token;
    if (!authToken) return;
    // Guard again inside the async callback: a second concurrent call may
    // have already created a socket while getSetting() was awaited.
    if (ws && ws.readyState <= 1) return;

    try {
      ws = new WebSocket(BACKEND_WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    // Capture the socket instance in a local variable so that event
    // handlers always reference THIS socket, not the module-level `ws`
    // which may be overwritten by a later connectWebSocket() call.
    const socket = ws;

    socket.onopen = () => {
      wsReconnectDelay = 1000;
      socket.send(JSON.stringify({ type: WS_MSG.AUTH, token: authToken }));
      startHeartbeat();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch { /* ignore malformed */ }
    };

    socket.onclose = () => scheduleReconnect();
    socket.onerror = () => socket.close();
  });
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
    connectWebSocket();
  }, wsReconnectDelay);
}

function wsSend(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Send a structured message to the side-panel popup. Safe to call when
// no popup is attached — chrome.runtime.sendMessage will reject with
// "no receiver", which we swallow.
function sendToPopup(action, payload) {
  try {
    chrome.runtime
      .sendMessage({ target: 'popup', action, ...payload })
      .catch(() => {});
  } catch { /* ignore */ }
}

// Legacy "reload everything" hint — kept for code paths that don't yet
// push structured updates (scrape-job failures, condition triggers, etc.)
function notifyPopupRefresh() {
  sendToPopup(POPUP_MSG.REFRESH, {});
}

let heartbeatTimer = null;
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // 20 s is inside the MV3 service-worker idle kill window (~30 s) so a
  // heartbeat ALWAYS fires before Chrome decides we're idle. With the old
  // 60 s cadence the SW could get killed between heartbeats during quiet
  // periods, leaking activeJobs entries and stalling scraping.
  heartbeatTimer = setInterval(() => {
    wsSend({ type: WS_MSG.HEARTBEAT, activeJobs: activeJobs.size, ts: Date.now() });
  }, 20000);
}

// ── Session-level CAPTCHA pause + user-facing solve flow ─────────────
//
// When offscreen.js detects a CAPTCHA, a 429, a dog page, or a login
// wall, it sends a CLIENT_PAUSE runtime message with an absolute
// `pausedUntil` timestamp and the `captchaUrl` the user should solve.
//
// This module:
//  1. Stores the pause state (+ persists to chrome.storage.local so it
//     survives MV3 service-worker restarts).
//  2. Rejects incoming SCRAPE_JOBs while paused, with a CLIENT_PAUSED
//     failure the backend special-cases to avoid row-level penalty.
//  3. Shows an OS-level Chrome notification that opens the CAPTCHA
//     page in a real tab when clicked.
//  4. Forwards a structured popup message so the side-panel banner
//     appears wherever the popup is currently open.
//  5. Detects recovery via chrome.webNavigation — when the solve tab
//     navigates away from /errors/validateCaptcha, we run a probe
//     scrape to confirm the session is actually clean, then cascade
//     a CLIENT_RESUME through offscreen + popup.

const AMAZON_BASE_URL         = 'https://www.amazon.co.jp';
const GOOGLE_BASE_URL         = 'https://www.google.co.jp';
const CAPTCHA_NOTIFICATION_ID = 'captcha-solve';
const CAPTCHA_URL_MARKER      = '/errors/validateCaptcha';
const LOGIN_URL_MARKER        = '/ap/signin';

let clientPausedUntil  = 0;
let lastCaptchaUrl     = null;
let captchaReason      = null;
let captchaSource      = null;   // 'amazon' | 'google' | 'network'
let captchaSolveTabId  = null;
let captchaSolveTabId2 = null;   // second tab (Amazon warm-up after Google solve)

const PAUSE_STORAGE_KEYS = [
  'clientPausedUntil', 'lastCaptchaUrl', 'captchaReason', 'captchaSource',
];

// Rehydrate pause state from storage on service-worker init so a SW
// restart mid-pause doesn't lose the user's CAPTCHA context.
(async function rehydratePauseState() {
  try {
    const stored = await chrome.storage.local.get(PAUSE_STORAGE_KEYS);
    if (stored?.clientPausedUntil && stored.clientPausedUntil > Date.now()) {
      clientPausedUntil = stored.clientPausedUntil;
      lastCaptchaUrl    = stored.lastCaptchaUrl    || null;
      captchaReason     = stored.captchaReason     || null;
      captchaSource     = stored.captchaSource     || 'amazon';
      showCaptchaNotification();
    } else if (stored?.clientPausedUntil) {
      await chrome.storage.local.remove(PAUSE_STORAGE_KEYS);
    }
  } catch (err) {
    console.warn('[pause] rehydrate failed:', err);
  }
})();

// Offscreen → background CLIENT_PAUSE listener. Also handles other
// one-way runtime messages that don't go through handlePopupMessage.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.CLIENT_PAUSE && typeof msg.pausedUntil === 'number') {
    onClientPauseFromOffscreen(msg);
  }
});

async function onClientPauseFromOffscreen(msg) {
  clientPausedUntil = msg.pausedUntil;
  lastCaptchaUrl    = msg.captchaUrl || lastCaptchaUrl || `${AMAZON_BASE_URL}/`;
  captchaReason     = msg.reason     || 'CAPTCHA';
  captchaSource     = msg.source     || 'amazon';

  const remainingMs = Math.max(0, clientPausedUntil - Date.now());
  console.warn(
    `[background] client paused for ${Math.round(remainingMs / 60000)} min ` +
    `(reason=${captchaReason}, source=${captchaSource}, streak=${msg.streak || '-'})`
  );

  // Persist so SW death doesn't orphan the state.
  try {
    await chrome.storage.local.set({
      clientPausedUntil,
      lastCaptchaUrl,
      captchaReason,
      captchaSource,
    });
  } catch { /* storage is best-effort */ }

  // OS-level notification.
  showCaptchaNotification();

  // Side-panel banner — fire-and-forget; no-op if popup isn't open.
  sendToPopup(POPUP_MSG.CLIENT_PAUSE, {
    pausedUntil: clientPausedUntil,
    captchaUrl:  lastCaptchaUrl,
    reason:      captchaReason,
    source:      captchaSource,
  });
}

function showCaptchaNotification() {
  const titles = {
    amazon:  'Amazon verification required',
    google:  'Google bot detection triggered',
    network: 'Network verification required',
  };
  try {
    chrome.notifications.create(CAPTCHA_NOTIFICATION_ID, {
      type:        'basic',
      iconUrl:     chrome.runtime.getURL('icons/icon128.png'),
      title:       titles[captchaSource] || titles.amazon,
      message:     `${captchaReason || 'CAPTCHA'} — click to solve and resume scraping`,
      priority:    2,
      requireInteraction: true,
    });
  } catch (err) {
    console.warn('[notifications] create failed:', err?.message || err);
  }
}

// Clicking the notification opens the stored CAPTCHA URL in a real tab
// sharing the user's normal Chrome cookie jar. This is critical: the
// user's solve affects the same session our fetch() sees.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId !== CAPTCHA_NOTIFICATION_ID) return;
  await openCaptchaSolveTab();
  try { chrome.notifications.clear(CAPTCHA_NOTIFICATION_ID); } catch {}
});

async function openCaptchaSolveTab() {
  // Rehydrate from storage if the SW woke up fresh.
  if (!lastCaptchaUrl) {
    try {
      const stored = await chrome.storage.local.get(['lastCaptchaUrl', 'captchaSource']);
      lastCaptchaUrl = stored?.lastCaptchaUrl || `${AMAZON_BASE_URL}/`;
      captchaSource  = stored?.captchaSource  || 'amazon';
    } catch {
      lastCaptchaUrl = `${AMAZON_BASE_URL}/`;
      captchaSource  = 'amazon';
    }
  }

  // Focus existing tab if already open.
  if (captchaSolveTabId != null) {
    try { await chrome.tabs.update(captchaSolveTabId, { active: true }); return; }
    catch { captchaSolveTabId = null; }
  }

  // ── Source-aware URL selection ──────────────────────────
  //
  // 'amazon'  → open lastCaptchaUrl (Amazon's validateCaptcha page)
  // 'google'  → open lastCaptchaUrl (Google's sorry page or the page
  //             containing the reCAPTCHA widget), THEN also open Amazon
  //             homepage in a second tab so the session warms up after
  //             the Google solve clears the IP flag.
  // 'network' → open lastCaptchaUrl (whatever the ISP/proxy served)
  const primaryUrl = lastCaptchaUrl;

  try {
    const tab = await chrome.tabs.create({ url: primaryUrl, active: true });
    captchaSolveTabId = tab?.id ?? null;
  } catch (err) {
    console.warn('[captcha] tabs.create primary failed:', err?.message || err);
  }

  // For Google-sourced blocks, also open Amazon's homepage in a
  // background tab. When the user solves Google's challenge, the IP
  // flag lifts, and visiting Amazon in the same session re-establishes
  // trust. The user can then close both tabs and resume.
  if (captchaSource === 'google' || captchaSource === 'network') {
    try {
      const tab2 = await chrome.tabs.create({
        url: `${AMAZON_BASE_URL}/?language=ja_JP`,
        active: false,
      });
      captchaSolveTabId2 = tab2?.id ?? null;
    } catch { /* non-critical */ }
  }
}

// Detect successful solve. When either solve tab navigates AWAY from a
// block page, we run a probe scrape to confirm the session is clean
// and then lift the pause.
const BLOCK_URL_MARKERS = [
  CAPTCHA_URL_MARKER,       // /errors/validateCaptcha
  LOGIN_URL_MARKER,         // /ap/signin
  'google.com/sorry',       // Google IP-level block
  'google.co.jp/sorry',
  'ipv4.google.com',
  'recaptcha/api',          // Google reCAPTCHA challenge frame
];

function isSolveTab(tabId) {
  return tabId === captchaSolveTabId || tabId === captchaSolveTabId2;
}

function isStillOnBlockPage(url) {
  return BLOCK_URL_MARKERS.some((marker) => url.includes(marker));
}

if (chrome.webNavigation?.onCompleted) {
  chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (!isSolveTab(details.tabId)) return;
    if (isStillOnBlockPage(details.url)) return;
    await triggerRecoveryProbe('webNavigation');
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === captchaSolveTabId)  { captchaSolveTabId  = null; }
  if (tabId === captchaSolveTabId2) { captchaSolveTabId2 = null; }
  if (tabId === captchaSolveTabId || !captchaSolveTabId) {
    triggerRecoveryProbe('tabClosed');
  }
});

let probeInFlight = false;
async function triggerRecoveryProbe(source) {
  if (probeInFlight) return;
  if (!clientPausedUntil || clientPausedUntil <= Date.now()) return;
  probeInFlight = true;
  console.info(`[recovery] probe triggered (source=${source})`);
  try {
    // Direct fetch from the service worker — no need to involve the
    // offscreen document. We just need "is Amazon still CAPTCHA'ing
    // this session?", which is a URL + text check, not a DOM parse.
    // The fetch uses the same cookie jar as offscreen (credentials:
    // 'include' + host permission on amazon.co.jp).
    const resp = await fetch(`${AMAZON_BASE_URL}/?language=ja_JP`, {
      method: 'GET',
      headers: {
        'Accept-Language': 'ja-JP,ja;q=0.9',
        'Referer':         `${AMAZON_BASE_URL}/`,
      },
      credentials: 'include',
      redirect:    'follow',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    if (resp.status === 429 || resp.status === 503) {
      console.warn(`[recovery] probe got HTTP ${resp.status} — still blocked`);
      showCaptchaNotification();
      return;
    }

    const finalUrl = resp.url || '';
    if (finalUrl.includes(CAPTCHA_URL_MARKER) || finalUrl.includes(LOGIN_URL_MARKER)) {
      console.warn(`[recovery] probe redirected to ${finalUrl} — still blocked`);
      showCaptchaNotification();
      return;
    }

    // Even if the final URL is the homepage, Amazon can still inline
    // a CAPTCHA form. Do a quick text check on the body.
    const html = await resp.text();
    if (
      html.includes('validateCaptcha') ||
      html.includes('画像に表示されている文字を入力してください') ||
      html.includes('Type the characters you see in this image')
    ) {
      console.warn('[recovery] probe HTML contains CAPTCHA markers — still blocked');
      showCaptchaNotification();
      return;
    }

    console.info('[recovery] probe clean — lifting client pause');
    await liftClientPause();
  } catch (err) {
    console.warn('[recovery] probe threw:', err?.message || err);
  } finally {
    probeInFlight = false;
  }
}

async function liftClientPause() {
  clientPausedUntil = 0;
  lastCaptchaUrl    = null;
  captchaReason     = null;
  captchaSource     = null;

  try { await chrome.storage.local.remove(PAUSE_STORAGE_KEYS); } catch {}

  // Tell offscreen to reset its own pausedUntil + captchaStreak.
  try { chrome.runtime.sendMessage({ type: MSG.CLIENT_RESUME }); } catch {}

  // Tell the popup to hide the banner.
  sendToPopup(POPUP_MSG.CLIENT_RESUME, {});

  // Clear the OS notification.
  try { chrome.notifications.clear(CAPTCHA_NOTIFICATION_ID); } catch {}

  // Close solve tabs if still open.
  if (captchaSolveTabId != null) {
    try { await chrome.tabs.remove(captchaSolveTabId); } catch {}
    captchaSolveTabId = null;
  }
  if (captchaSolveTabId2 != null) {
    try { await chrome.tabs.remove(captchaSolveTabId2); } catch {}
    captchaSolveTabId2 = null;
  }
}

// ── Server Message Handling ────────────────────────────────

const activeJobs = new Map();

async function handleServerMessage(msg) {
  switch (msg.type) {
    case WS_MSG.SCRAPE_JOB:
      await handleScrapeJob(msg);
      break;

    case WS_MSG.PRICE_UPDATE:
      await handlePriceUpdate(msg);
      // Structured per-row push: the popup updates just this row in place
      // via a rAF-coalesced flush queue, no full list re-render.
      sendToPopup(POPUP_MSG.PRICE_UPDATE, {
        asin: msg.asin,
        data: msg.data || null,
        error: msg.error || null,
        updatedAt: msg.updatedAt || Date.now(),
      });
      break;

    case WS_MSG.BATCH_PROGRESS:
      sendToPopup(POPUP_MSG.BATCH_PROGRESS, {
        batchId: msg.batchId,
        total: msg.total,
        completed: msg.completed,
        failed: msg.failed,
        status: msg.status,
      });
      break;

    case WS_MSG.BATCH_COMPLETE:
      sendToPopup(POPUP_MSG.BATCH_COMPLETE, {
        batchId: msg.batchId,
        total: msg.total,
        completed: msg.completed,
        failed: msg.failed,
      });
      break;

    case WS_MSG.CONDITION_TRIGGERED:
      await addNotification({
        asin: msg.asin,
        conditionId: msg.conditionId,
        sentAt: Date.now(),
        discordSent: msg.discordSent,
      });
      notifyPopupRefresh();
      break;

    case WS_MSG.SELECTOR_UPDATE:
      if (msg.version > getSelectorVersion()) {
        updateSelectors(msg.selectors);
        await setSetting('selectors', msg.selectors);
        await setSetting('selectorVersion', msg.version);
      }
      break;

    case WS_MSG.SYNC_WATCHLIST:
      if (msg.asins) {
        for (const a of msg.asins) {
          await putAsin({ asin: a.asin, title: a.title, tier: a.tier || 'cold', addedAt: Date.now() });
        }
      }
      break;
  }
}

async function handleScrapeJob(msg) {
  const { asin, priority, deadline, jobId } = msg;

  // Session-level pause: offscreen has hit a CAPTCHA/429 recently and is
  // sitting in its cooldown. Reject IMMEDIATELY with CLIENT_PAUSED so the
  // backend can reschedule the row without bumping its failure counter.
  if (Date.now() < clientPausedUntil) {
    wsSend({
      type: WS_MSG.SCRAPE_FAILED,
      asin, jobId,
      error: 'CLIENT_PAUSED',
      pausedUntil: clientPausedUntil,
    });
    return;
  }

  if (activeJobs.size >= 3) {
    wsSend({ type: WS_MSG.SCRAPE_FAILED, asin, jobId, error: 'CLIENT_BUSY' });
    return;
  }

  activeJobs.set(asin, { startedAt: Date.now(), jobId });

  // O(1) lookup instead of the old O(n) getAllAsins() table scan.
  // On a 2000-row list the old path was ~100–500 ms per job.
  const myRow = await getAsin(asin);
  const isMyAsin = !!myRow;
  const useCredentials = isMyAsin;

  const result = await requestScrape(asin, useCredentials);

  activeJobs.delete(asin);

  if (result.error) {
    wsSend({
      type: WS_MSG.SCRAPE_FAILED,
      asin,
      jobId,
      error: result.error,
      missing: result.missing,
      finalUrl: result.finalUrl,
      htmlLen: result.htmlLen,
      partial: result.partial,
      cardSnippet: result.cardSnippet,
    });
    // Record the failure locally so the popup can show what went wrong.
    if (isMyAsin) {
      const existing = await getAsin(asin);
      if (existing) {
        await putAsin({
          ...existing,
          lastError: result.missing ? `${result.error}: [${result.missing.join(',')}]` : result.error,
          lastErrorAt: Date.now(),
        });
        notifyPopupRefresh();
      }
    }
    return;
  }

  wsSend({
    type: WS_MSG.SCRAPE_RESULT,
    asin,
    jobId,
    data: {
      title: result.title,
      price: result.price,
      points: result.points,
      deliveryTime: result.deliveryTime,
      marketplaceLowest: result.marketplaceLowest,
      newOfferCount: result.newOfferCount,
    },
    scrapedAt: result.scrapedAt,
  });

  if (isMyAsin) {
    await storeObservationLocally(result);
    notifyPopupRefresh();
  }
}

async function handlePriceUpdate(msg) {
  const master = await getAsin(msg.asin);
  if (!master) return;

  // Failure branch — server sent {asin, error} rather than {asin, data}.
  // Persist the error marker so reopening the panel shows the failed state
  // without waiting for a fresh WS event.
  if (msg.error) {
    await putAsin({
      ...master,
      lastError: msg.error,
      lastErrorAt: msg.updatedAt || Date.now(),
    });
    return;
  }

  const data = msg.data || {};
  const obs = {
    asin: msg.asin,
    observedAt: msg.updatedAt || Date.now(),
    price: data.price ?? msg.price ?? null,
    points: data.points ?? null,
    deliveryTime: data.deliveryTime ?? null,
    marketplaceLowest: data.marketplaceLowest ?? null,
    newOfferCount: data.newOfferCount ?? null,
  };
  await addObservation(obs);

  await putAsin({
    ...master,
    title: data.title || master.title,
    lastPrice: obs.price,
    lastPoints: obs.points,
    lastDeliveryTime: obs.deliveryTime,
    lastMarketplaceLowest: obs.marketplaceLowest,
    lastNewOfferCount: obs.newOfferCount,
    lastObservedAt: obs.observedAt,
    lastError: null,
    lastErrorAt: null,
  });
}

async function storeObservationLocally(result) {
  await addObservation({
    asin: result.asin,
    observedAt: result.scrapedAt,
    price: result.price,
    points: result.points,
    deliveryTime: result.deliveryTime,
    marketplaceLowest: result.marketplaceLowest,
    newOfferCount: result.newOfferCount,
  });

  const existing = await getAsin(result.asin);
  if (existing) {
    await putAsin({
      ...existing,
      title: result.title || existing.title,
      lastPrice: result.price,
      lastPoints: result.points,
      lastDeliveryTime: result.deliveryTime,
      lastMarketplaceLowest: result.marketplaceLowest,
      lastNewOfferCount: result.newOfferCount,
      lastObservedAt: result.scrapedAt,
      lastError: null,
      lastErrorAt: null,
    });
  }
}

// ── Tick: periodic maintenance ─────────────────────────────

async function onTick() {
  connectWebSocket();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await pruneObservations(sevenDaysAgo);
}

// ── Sync: periodic sync with backend ───────────────────────

async function onSync() {
  if (!authToken) return;
  try {
    const resp = await fetch(`${BACKEND_HTTP_URL}/api/selectors`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.version > getSelectorVersion()) {
        updateSelectors(data.selectors);
        await setSetting('selectors', data.selectors);
        await setSetting('selectorVersion', data.version);
      }
    }
  } catch { /* offline, ignore */ }
}

// ── Watchlist reconciliation (IndexedDB ← backend) ────────
//
// The popup reads its list exclusively from IndexedDB, but IndexedDB is
// a CACHE — it can be wiped by Chrome (quota eviction, reinstall, data
// clearing, profile change) and it's never user-scoped. The backend
// is the source of truth.
//
// This function pulls the authoritative watchlist via /api/watchlist and
// merges it into IndexedDB: backend rows are upserted (preserving any
// locally-cached fields not in the backend snapshot), and local rows
// that no longer exist on the backend are deleted. It runs on every
// successful login AND on every popup mount that finds an existing
// session, so logging out and back in can no longer lose products even
// if IndexedDB got wiped in between.
async function reconcileWatchlistFromBackend() {
  if (!authToken) return { ok: false, error: 'NOT_AUTHENTICATED' };

  let rows;
  try {
    const resp = await fetch(`${BACKEND_HTTP_URL}/api/watchlist`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) {
      // 401 here means the JWT is stale — clear it so the popup drops
      // back to the login screen rather than looping.
      if (resp.status === 401) {
        authToken = null;
        await setSetting('authToken', null);
      }
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    rows = await resp.json();
  } catch (err) {
    return { ok: false, error: 'FETCH_FAILED', message: err.message };
  }
  if (!Array.isArray(rows)) return { ok: false, error: 'INVALID_RESPONSE' };

  // Gather the current local state once.
  const localAll = await getAllAsins();
  const localByAsin = new Map(localAll.map((r) => [r.asin, r]));

  // Build the merged row set (backend row + any local-only fields).
  const backendAsins = new Set();
  const merged = [];
  for (const r of rows) {
    backendAsins.add(r.asin);
    const existing = localByAsin.get(r.asin) || {};
    merged.push({
      asin:                   r.asin,
      title:                  r.title || existing.title || '',
      tier:                   existing.tier || 'cold',
      addedAt:                r.added_at
                                ? new Date(r.added_at).getTime()
                                : (existing.addedAt || Date.now()),
      lastPrice:              r.last_price              ?? null,
      lastPoints:             r.last_points             ?? null,
      lastMarketplaceLowest:  r.last_marketplace_lowest ?? null,
      lastNewOfferCount:      r.last_new_offer_count    ?? null,
      lastDeliveryTime:       parseStoredDeliveryTime(r.last_delivery_time),
      lastObservedAt:         r.last_scraped_at
                                ? new Date(r.last_scraped_at).getTime()
                                : (existing.lastObservedAt ?? null),
      lastError:              r.last_error              ?? null,
      lastErrorAt:            r.last_error_at
                                ? new Date(r.last_error_at).getTime()
                                : null,
    });
  }

  // Delete local rows not in the backend (removed on another device,
  // or leftover from a previous user if IDB somehow has cross-user data).
  const toDelete = [];
  for (const localRow of localAll) {
    if (!backendAsins.has(localRow.asin)) toDelete.push(localRow.asin);
  }

  // Commit: one transaction for all upserts, one for all deletes.
  await bulkPutAsins(merged);
  await bulkDeleteAsins(toDelete);

  console.info(
    `[reconcile] ${merged.length} rows from backend, ${toDelete.length} local rows removed`
  );
  return { ok: true, total: merged.length, deleted: toDelete.length };
}

// MySQL stores delivery_time as a string (possibly JSON-encoded).
// The popup's formatter accepts both object and string, but re-parsing
// to an object here preserves the nicer structured rendering.
function parseStoredDeliveryTime(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

// ── Messages from Popup ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'background') {
    handlePopupMessage(msg)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('handlePopupMessage error:', err);
        sendResponse({ error: err.message || String(err) });
      });
    return true;
  }
});

async function handlePopupMessage(msg) {
  await openDB();

  switch (msg.action) {
    case 'login': {
      const resp = await fetch(`${BACKEND_HTTP_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: msg.email, password: msg.password }),
      });
      const data = await resp.json();
      if (data.token) {
        authToken = data.token;
        await setSetting('authToken', data.token);
        connectWebSocket();
        // Pull the authoritative watchlist into IndexedDB BEFORE we
        // resolve the popup's message. This guarantees the popup's
        // follow-up `loadAsins()` sees the freshly-synced state instead
        // of a possibly-empty or stale cache.
        try {
          const recon = await reconcileWatchlistFromBackend();
          if (!recon.ok) {
            console.warn('[login] reconcile failed:', recon.error);
          }
        } catch (err) {
          console.warn('[login] reconcile threw:', err);
        }
      }
      return data;
    }

    case 'reconcileWatchlist': {
      // Explicit reconcile trigger, used by the popup on mount when
      // an auth token is already present (returning user).
      return reconcileWatchlistFromBackend();
    }

    case 'register': {
      const resp = await fetch(`${BACKEND_HTTP_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: msg.email, password: msg.password }),
      });
      return resp.json();
    }

    case 'logout': {
      authToken = null;
      await setSetting('authToken', null);
      await setSetting('activeBatchId', null);
      if (ws) { ws.close(); ws = null; }
      clearInterval(heartbeatTimer);
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
      return { ok: true };
    }

    case 'getStatus': {
      // If we're not connected (e.g. SW just woke up from sleep), attempt
      // a reconnection so the popup shows live status.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!authToken) {
          authToken = await getSetting('authToken');
        }
        if (authToken) {
          connectWebSocket();
        }
      }
      const count = await getAsinCount();
      return {
        asinCount: count,
        wsConnected: ws?.readyState === WebSocket.OPEN,
        activeJobs: activeJobs.size,
        authToken: !!authToken,
      };
    }

    case 'addAsins': {
      // ── Normalise, dedupe, regex-filter ────────────────────
      const seen = new Set();
      const valid = [];
      const invalid = [];
      for (const raw of msg.asins || []) {
        const clean = String(raw || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(clean)) { invalid.push(clean); continue; }
        if (seen.has(clean)) continue;
        seen.add(clean);
        valid.push(clean);
      }
      if (valid.length === 0) {
        return { error: 'NO_VALID_ASINS', invalid: invalid.length };
      }
      if (!authToken) {
        return { error: 'NOT_AUTHENTICATED' };
      }

      // ── One POST to the backend bulk endpoint ──────────────
      let body;
      try {
        const resp = await fetch(`${BACKEND_HTTP_URL}/api/watchlist/bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ asins: valid }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          // Stale JWT — the backend says our user row no longer exists.
          // Clear the local token so the popup drops back to the login
          // screen instead of looping forever on a dead session.
          if (resp.status === 401 || err.error === 'STALE_SESSION') {
            authToken = null;
            await setSetting('authToken', null);
            await setSetting('activeBatchId', null);
            if (ws) { try { ws.close(); } catch {} ws = null; }
            return { error: 'STALE_SESSION', message: err.message || 'Session expired' };
          }
          return { error: err.error || `HTTP ${resp.status}`, message: err.message };
        }
        body = await resp.json();
      } catch (err) {
        return { error: 'FETCH_FAILED', message: err.message };
      }

      // ── Pre-populate IndexedDB with skeleton rows so the side
      // panel can render the whole list as "pending" immediately.
      const now = Date.now();
      const acceptedAsins = body.acceptedAsins || valid;
      for (const asin of acceptedAsins) {
        const existing = await getAsin(asin);
        if (existing) continue;
        await putAsin({
          asin,
          title: '',
          tier: 'cold',
          addedAt: now,
          lastPrice: null,
          lastPoints: null,
          lastDeliveryTime: null,
          lastMarketplaceLowest: null,
          lastNewOfferCount: null,
          lastObservedAt: null,
          lastError: null,
          lastErrorAt: null,
        });
      }

      // ── Persist active batch so the popup can resume progress
      // polling after being closed or after a service-worker restart.
      if (body.batchId && body.total > 0) {
        await setSetting('activeBatchId', body.batchId);
      }

      return {
        batchId: body.batchId,
        total: body.total,
        accepted: body.accepted,
        duplicates: body.duplicates,
        invalid: body.invalid + invalid.length,
      };
    }

    case 'getBatchProgress': {
      if (!authToken || !msg.batchId) return { error: 'NO_BATCH' };
      try {
        const resp = await fetch(
          `${BACKEND_HTTP_URL}/api/watchlist/bulk/${msg.batchId}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (!resp.ok) {
          if (resp.status === 404) return { error: 'NOT_FOUND' };
          return { error: `HTTP ${resp.status}` };
        }
        return await resp.json();
      } catch (err) {
        return { error: 'FETCH_FAILED', message: err.message };
      }
    }

    case 'getActiveBatch': {
      const batchId = await getSetting('activeBatchId');
      return { batchId: batchId || null };
    }

    case 'clearActiveBatch': {
      await setSetting('activeBatchId', null);
      return { ok: true };
    }

    case 'cancelBatch': {
      if (!authToken || !msg.batchId) return { error: 'NO_BATCH' };
      try {
        await fetch(
          `${BACKEND_HTTP_URL}/api/watchlist/bulk/${msg.batchId}/cancel`,
          { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } }
        );
        await setSetting('activeBatchId', null);
        return { ok: true };
      } catch (err) {
        return { error: 'FETCH_FAILED', message: err.message };
      }
    }

    // ── CAPTCHA banner actions ────────────────────────────

    case 'getClientPauseState': {
      // Side panel calls this on mount to rehydrate the banner if a
      // pause is already active (e.g. SW restarted, panel was closed).
      if (clientPausedUntil && clientPausedUntil > Date.now()) {
        return {
          pausedUntil: clientPausedUntil,
          captchaUrl:  lastCaptchaUrl,
          reason:      captchaReason,
          source:      captchaSource,
        };
      }
      return null;
    }

    case 'solveCaptcha': {
      // "Solve now" button in the banner. Opens the CAPTCHA page in
      // a real tab using the user's normal Chrome session.
      await openCaptchaSolveTab();
      try { chrome.notifications.clear(CAPTCHA_NOTIFICATION_ID); } catch {}
      return { ok: true };
    }

    case 'skipClientPause': {
      // "Skip pause" button — the user insists they solved it
      // elsewhere. We still run the recovery probe (trust but verify);
      // if it comes back clean we lift the pause, otherwise we keep
      // it armed and re-show the notification.
      triggerRecoveryProbe('userSkip');
      return { ok: true };
    }

    case 'removeAsin': {
      await deleteAsin(msg.asin);
      if (authToken) {
        try {
          await fetch(`${BACKEND_HTTP_URL}/api/watchlist/${msg.asin}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${authToken}` },
          });
        } catch { /* offline */ }
      }
      return { ok: true };
    }

    case 'refreshAsin': {
      // User clicked "Refresh" on a card: ask backend to kick
      // next_scrape_at=NOW() and push into scrape queue. The coordinator
      // will re-assign on its next tick (within ~1s).
      if (!authToken) return { error: 'NOT_AUTHENTICATED' };
      try {
        const resp = await fetch(
          `${BACKEND_HTTP_URL}/api/watchlist/${msg.asin}/refresh`,
          { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } }
        );
        return await resp.json();
      } catch (err) {
        return { error: 'FETCH_FAILED', message: err.message };
      }
    }

    case 'getAsins':
      return getAllAsins();

    case 'getObservations':
      return getObservations(msg.asin, msg.from, msg.to);

    case 'getObservationsRange': {
      // Short periods use local IndexedDB (faster, works offline).
      // Long periods go to the backend which holds the full history.
      const { asin, from, to, source } = msg;
      if (source === 'local') {
        return getObservations(asin, from, to);
      }
      if (!authToken) return { error: 'NOT_AUTHENTICATED' };
      try {
        const resp = await fetch(
          `${BACKEND_HTTP_URL}/api/observations/${asin}?from=${from}&to=${to}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          return { error: err.error || `HTTP ${resp.status}` };
        }
        return await resp.json();
      } catch {
        // Network failure → fall back to whatever local data we have
        return getObservations(asin, from, to);
      }
    }

    case 'getObservationSpan': {
      if (!authToken) return { firstObservedAt: null, lastObservedAt: null, count: 0 };
      try {
        const resp = await fetch(
          `${BACKEND_HTTP_URL}/api/observations/${msg.asin}/span`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (resp.ok) return await resp.json();
      } catch { /* offline */ }
      return { firstObservedAt: null, lastObservedAt: null, count: 0 };
    }

    case 'getConditions': {
      // Always load from backend when authenticated — it is the authoritative source.
      // Falls back to local IndexedDB when offline or logged out.
      if (authToken) {
        try {
          const resp = await fetch(`${BACKEND_HTTP_URL}/api/conditions`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (resp.ok) {
            const rows = await resp.json();
            return rows.map((c) => ({
              id: c.id,
              asin: c.asin,
              type: c.rule_type,
              params: typeof c.rule_params === 'string'
                ? JSON.parse(c.rule_params)
                : (c.rule_params || {}),
              enabled: !!(c.enabled),
              cooldownSec: c.cooldown_sec,
              lastFiredAt: c.last_fired_at,
            }));
          }
        } catch { /* offline */ }
      }
      return getAllConditions();
    }

    case 'addCondition': {
      const cond = msg.condition;
      if (!authToken) {
        return { error: 'NOT_AUTHENTICATED' };
      }
      try {
        const resp = await fetch(`${BACKEND_HTTP_URL}/api/conditions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(cond),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          return { error: err.error || `HTTP ${resp.status}` };
        }
        const serverCond = await resp.json();
        // Save locally using the server-assigned id so future deletes target the correct row
        await addCondition({
          id: serverCond.id,
          asin: cond.asin,
          type: cond.type,
          params: cond.params,
          enabled: true,
          cooldownSec: cond.cooldownSec,
          lastFiredAt: null,
        });
        return { ok: true };
      } catch {
        return { error: 'OFFLINE' };
      }
    }

    case 'deleteCondition': {
      await deleteCondition(msg.id);
      if (authToken) {
        try {
          await fetch(`${BACKEND_HTTP_URL}/api/conditions/${msg.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${authToken}` },
          });
        } catch { /* offline */ }
      }
      return { ok: true };
    }

    case 'setDiscordWebhook':
      await setSetting('discordWebhookUrl', msg.url);
      if (authToken) {
        try {
          await fetch(`${BACKEND_HTTP_URL}/api/discord-webhook`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ webhookUrl: msg.url }),
          });
        } catch { /* offline */ }
      }
      return { ok: true };

    case 'getDiscordWebhook': {
      const url = await getSetting('discordWebhookUrl');
      return { url };
    }

    case 'getNotifications': {
      const notifs = await getRecentNotifications(msg.limit || 50);
      return notifs;
    }

    default:
      return { error: 'UNKNOWN_ACTION' };
  }
}
