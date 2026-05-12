'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, app, shell } = require('electron');
const { IPC_CHANNEL } = require('../shared/constants');
const Q = require('./db/queries');
const scheduler = require('./services/scheduler');
const { enqueueNotification } = require('./services/notifier');
const { captureProductCard } = require('./services/screenshot');

// In-memory cooldown tracker for FNM notifications. Key = `${context}:${asin}`,
// value = last fired timestamp (ms). Resets on app restart, which is fine —
// a fresh app launch implicitly forgives prior notification frequency.
const fnmNotifLastFired = new Map();
const FNM_NOTIF_COOLDOWN_MS = 60 * 60 * 1000;   // 60 min, matches existing alert engine
const {
  getPauseState,
  getCircuitBreakerState,
  clearCircuitBreaker,
  isSignedIn,
} = require('./scraper/fetcher');

// Callbacks supplied by index.js so the handler can open BrowserWindows
// it doesn't own. Pattern mirrors setPauseCallbacks on the fetcher.
let callbacks = {};
function setWindowCallbacks(fns) {
  callbacks = { ...callbacks, ...fns };
}

function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNEL, async (_event, msg) => {
    const { action, ...payload } = msg;

    switch (action) {
      // ── Products ────────────────────────────────────
      case 'getProducts':
        return Q.getAllProducts({ groupId: payload.groupId });

      case 'getTrashedProducts':
        return Q.getTrashedProducts();

      case 'getProductCount':
        return Q.getProductCount();

      case 'addProducts': {
        const asins = (payload.asins || [])
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => /^[A-Z0-9]{10}$/.test(s));
        const unique = [...new Set(asins)];
        const count = Q.addProducts(unique);
        return { added: count, total: unique.length };
      }

      case 'removeProduct':
        Q.removeProduct(payload.asin);
        return { ok: true };

      case 'softDelete': {
        const n = Q.softDeleteProducts(payload.asins || []);
        return { ok: true, count: n };
      }

      case 'restore': {
        const n = Q.restoreProducts(payload.asins || []);
        return { ok: true, count: n };
      }

      case 'hardDelete': {
        const n = Q.hardDeleteProducts(payload.asins || []);
        return { ok: true, count: n };
      }

      case 'getProductStats':
        return Q.getProductStats(payload.asin);

      case 'getSparklineSeries':
        return Q.getSparklineSeries(payload.asin, payload.days || 30);

      case 'getMonitoringChartData':
        return Q.getMonitoringChartData(payload.asin, payload.from, payload.to);

      case 'fireFnmNotification': {
        // Renderer fires this when a product matches the notification
        // conditions in either active or trash context. We enforce a
        // per-(context, asin) cooldown here so a noisy condition doesn't
        // spam Discord, then gather the full product row + freshly-
        // computed stats so the notifier can render the spec layout
        // (avg-price table, drop rates, charts, links etc.).
        const ctx = payload.context === 'trash' ? 'trash' : 'active';
        const key = `${ctx}:${payload.asin}`;
        const last = fnmNotifLastFired.get(key) || 0;
        if (Date.now() - last < FNM_NOTIF_COOLDOWN_MS) {
          return { ok: false, skipped: 'cooldown' };
        }
        fnmNotifLastFired.set(key, Date.now());
        // Pull the latest persisted product row (product passed in from
        // the renderer is from its in-memory cache; the DB version is
        // authoritative and cheaper to read here than to ship through IPC).
        const dbProduct = Q.getProduct(payload.asin) || payload.product || {};
        let stats = null;
        try { stats = Q.getProductStats(payload.asin); } catch { stats = null; }
        enqueueNotification({
          asin:        payload.asin,
          conditionId: null,
          ruleType:    ctx === 'trash' ? 'fnm_trash_match' : 'fnm_active_match',
          context:     ctx,
          // Slot info — the spec wants the user-edited filter name
          // to appear at the top of the notification card.
          slotIndex:   typeof payload.slotIndex === 'number' ? payload.slotIndex : null,
          slotName:    typeof payload.slotName === 'string' && payload.slotName.trim()
                         ? payload.slotName
                         : (typeof payload.slotIndex === 'number'
                             ? `カスタムフィルタ${payload.slotIndex + 1}`
                             : 'フィルタ条件マッチ'),
          // Full product snapshot for the notifier's product-detail box.
          product:     dbProduct,
          stats:       stats,
          // Legacy single-field surfaces (used by the DB log).
          price:       dbProduct.last_price ?? null,
          mpPrice:     dbProduct.last_mp_price ?? null,
          mpCount:     dbProduct.last_mp_count ?? null,
          points:      dbProduct.last_points ?? null,
          movingAvg:   stats ? stats.avg7d : null,
        });
        return { ok: true };
      }

      // ── Groups ──────────────────────────────────────
      case 'getGroups':
        return Q.getAllGroups();

      case 'ensureGroupSlots':
        // Idempotent: top up the groups table to N empty slots so the
        // dropdown / rename modal / per-row picker can rely on stable
        // slot ids 1..N existing.
        return Q.ensureGroupSlots(payload.count || 20);

      case 'addGroup': {
        try {
          const id = Q.addGroup(payload.name);
          return { ok: true, id };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }

      case 'renameGroup':
        Q.renameGroup(payload.id, payload.name);
        return { ok: true };

      case 'deleteGroup':
        Q.deleteGroup(payload.id);
        return { ok: true };

      case 'assignGroup': {
        const n = Q.assignGroup(payload.asins || [], payload.groupId);
        return { ok: true, count: n };
      }

      // ── Observations ────────────────────────────────
      case 'getObservations':
        return Q.getObservationsInRange(payload.asin, payload.from, payload.to);

      case 'getObservationSpan':
        return Q.getObservationSpan(payload.asin);

      case 'getChartData':
        return Q.getChartData(payload.asin, payload.from, payload.to);

      // ── Notifications ───────────────────────────────
      case 'getNotifications':
        return Q.getRecentNotifications(payload.limit || 50);

      // ── Settings ────────────────────────────────────
      case 'getSetting':
        return Q.getSetting(payload.key);

      case 'setSetting':
        Q.setSetting(payload.key, payload.value);
        return { ok: true };

      case 'getDiscordWebhook':
        return { url: Q.getSetting('discordWebhookUrl') };

      case 'setDiscordWebhook':
        Q.setSetting('discordWebhookUrl', payload.url);
        return { ok: true };

      // ── Scheduler control ───────────────────────────
      case 'getStatus': {
        const rest = scheduler.getRestState();
        return {
          productCount: Q.getProductCount(),
          running: scheduler.isRunning(),
          paused: !!getPauseState(),
          circuitBreaker: getCircuitBreakerState(),
          nextCycleAt:   rest ? rest.nextCycleAt : 0,
          currentRestMs: rest ? rest.restMs      : 0,
          // null = no restriction (full sweep), number = monitoring
          // only that many ✅checked products per the renderer's
          // 監視スタート flow.
          restrictionCount: scheduler.getRestrictionCount(),
        };
      }

      case 'startScraping':
        // Optional `asins` — when present, scrape only this subset.
        // Sent by the renderer's 監視スタート bulk-action button.
        scheduler.start({ asins: Array.isArray(payload.asins) ? payload.asins : null });
        return { ok: true };

      case 'stopScraping':
        scheduler.stop();
        return { ok: true };

      case 'getPauseState':
        return getPauseState();

      // ── Session & health ────────────────────────────
      case 'checkLoginStatus': {
        const loggedIn = await isSignedIn();
        return { loggedIn };
      }

      case 'openLogin':
        if (callbacks.openLogin) callbacks.openLogin();
        return { ok: true };

      case 'solveCaptcha':
        if (callbacks.openCaptchaSolve) callbacks.openCaptchaSolve();
        return { ok: true };

      case 'getHealth': {
        const now = Date.now();
        return {
          productCount:      Q.getProductCount(),
          running:           scheduler.isRunning(),
          paused:            !!getPauseState(),
          circuitBreaker:    getCircuitBreakerState(),
          blocksLast24h:     Q.getBlockEventCountSince(now - 86_400_000),
          blocksLast7d:      Q.getBlockEventCountSince(now - 7 * 86_400_000),
          recentBlockEvents: Q.getRecentBlockEvents(20),
        };
      }

      case 'clearCircuitBreaker':
        clearCircuitBreaker();
        return { ok: true };

      // ── サイト比較: open Keepa + Amazon search in the user's default
      // browser. Routed through shell.openExternal so the real Chrome
      // (or whatever default browser) handles them — embedding the
      // pages in an in-app BrowserWindow trips Keepa's anti-bot check
      // because Electron's webContents has a different fingerprint.
      // Modern browsers reuse the existing window and add each URL as
      // a new tab, satisfying the "1 window, multiple tabs" intent.
      case 'openCompareTabs': {
        const asin = String(payload.asin || '').toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, error: 'INVALID_ASIN' };
        await shell.openExternal(`https://keepa.com/#!product/5-${asin}`);
        await shell.openExternal(`https://www.amazon.co.jp/s?k=${encodeURIComponent(asin)}`);
        return { ok: true };
      }

      // ── Screenshots ─────────────────────────────────
      case 'captureScreenshot': {
        // Trigger a one-off screenshot of the product card. Saves the
        // PNG under userData/screenshots/ so the renderer can preview
        // it via shell.openPath without needing to pipe the buffer
        // back through IPC. Used for the "Test webhook" / preview UI
        // and as a sanity check for the integration.
        const asin = String(payload.asin || '').toUpperCase();
        const result = await captureProductCard(asin);
        if (result.error) return { ok: false, error: result.error, message: result.message };

        const dir = path.join(app.getPath('userData'), 'screenshots');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
        const outPath = path.join(dir, `${asin}-${Date.now()}.png`);
        fs.writeFileSync(outPath, result.png);
        if (payload.reveal) shell.showItemInFolder(outPath);
        return {
          ok: true,
          path: outPath,
          source: result.source,
          rect: result.rect,
          bytes: result.png.length,
        };
      }

      default:
        return { error: 'UNKNOWN_ACTION', action };
    }
  });
}

module.exports = { registerIpcHandlers, setWindowCallbacks };
