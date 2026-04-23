'use strict';

const { ipcMain } = require('electron');
const { IPC_CHANNEL } = require('../shared/constants');
const Q = require('./db/queries');
const scheduler = require('./services/scheduler');
const { getPauseState } = require('./scraper/fetcher');

function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNEL, async (_event, msg) => {
    const { action, ...payload } = msg;

    switch (action) {
      // ── Products ────────────────────────────────────
      case 'getProducts':
        return Q.getAllProducts();

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

      // ── Observations ────────────────────────────────
      case 'getObservations':
        return Q.getObservationsInRange(payload.asin, payload.from, payload.to);

      case 'getObservationSpan':
        return Q.getObservationSpan(payload.asin);

      // ── Conditions ──────────────────────────────────
      case 'getConditions':
        return Q.getAllConditions();

      case 'addCondition': {
        const id = Q.addCondition(payload.condition);
        return { ok: true, id };
      }

      case 'deleteCondition':
        Q.deleteCondition(payload.id);
        return { ok: true };

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
      case 'getStatus':
        return {
          productCount: Q.getProductCount(),
          running: scheduler.isRunning(),
          paused: !!getPauseState(),
        };

      case 'startScraping':
        scheduler.start();
        return { ok: true };

      case 'stopScraping':
        scheduler.stop();
        return { ok: true };

      case 'getPauseState':
        return getPauseState();

      default:
        return { error: 'UNKNOWN_ACTION', action };
    }
  });
}

module.exports = { registerIpcHandlers };
