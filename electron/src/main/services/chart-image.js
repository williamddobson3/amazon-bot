'use strict';

// Renders the app's own 7-day price+sellers chart into a PNG buffer
// for Discord notifications. Uses a hidden BrowserWindow so we can
// reuse the existing TimeSeriesChart class (renderer-side, requires a
// real DOM/canvas) without adding a node-canvas native dependency.
//
// Singleton window kept warm for repeated calls; auto-closes after
// WINDOW_IDLE_MS of inactivity. captureChain serialises calls so two
// near-simultaneous notifications don't race on shared canvas state.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const Q = require('../db/queries');

const WIDTH  = 820;
// Stats table (~140px) + price chart (220px) + sellers chart (110px) +
// row paddings + section titles + outer margins. Rendered as a single
// PNG that mirrors the spec image exactly: spec 4-row × 7-col stats
// grid on top, two charts below. Discord scales the image to fit any
// embed width without ever wrapping the contents.
const HEIGHT = 600;
const WINDOW_IDLE_MS = 90_000;
const RENDER_TIMEOUT_MS = 10_000;

let win = null;
let pageLoaded = false;
let lastUsedAt = 0;
let idleTimer = null;
let chartChain = Promise.resolve();

function getOrCreateWindow() {
  if (win && !win.isDestroyed()) return win;
  pageLoaded = false;
  win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    backgroundColor: '#080813',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'renderer', 'chart-render-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });
  win.on('closed', () => { win = null; pageLoaded = false; });
  return win;
}

function scheduleIdleClose() {
  lastUsedAt = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (win && !win.isDestroyed() && Date.now() - lastUsedAt >= WINDOW_IDLE_MS) {
      console.info('[chart-image] closing idle render window');
      win.close();
    }
  }, WINDOW_IDLE_MS + 1000);
}

async function renderOnce(asin) {
  const now = Date.now();
  const from = now - 7 * 86_400_000;
  let data;
  let stats;
  let product;
  try {
    data    = Q.getMonitoringChartData(asin, from, now);
    stats   = Q.getProductStats(asin) || {};
    product = Q.getProduct(asin) || {};
  } catch (err) {
    console.warn(`[chart-image] data fetch failed for ${asin}: ${err.message}`);
    return null;
  }

  const w = getOrCreateWindow();
  if (!pageLoaded) {
    await w.loadFile(path.join(__dirname, '..', '..', 'renderer', 'chart-render.html'));
    pageLoaded = true;
  }

  // Ready handshake — we send the data, the page draws, then sends
  // 'chart:ready' back. We attach the listener BEFORE sending so we
  // don't miss the response.
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ipcMain.removeListener('chart:ready', handler);
      reject(new Error('chart render timeout'));
    }, RENDER_TIMEOUT_MS);
    const handler = (e) => {
      if (!w || w.isDestroyed() || e.sender !== w.webContents) return;
      clearTimeout(t);
      ipcMain.removeListener('chart:ready', handler);
      resolve();
    };
    ipcMain.on('chart:ready', handler);
  });

  // Compute current effective price (latest BuyBox − points) for the
  // stats table's "実質最新価格" column and drop-rate denominators.
  const latestEff = product.last_price != null
    ? product.last_price - (product.last_points || 0)
    : null;

  w.webContents.send('chart:render', {
    asin, from, to: now,
    data, avgKey: 'avg7d',
    stats, latestEff,
  });

  await ready;
  const image = await w.webContents.capturePage({
    x: 0, y: 0, width: WIDTH, height: HEIGHT,
  });
  scheduleIdleClose();
  return image.toPNG();
}

async function renderChartImage(asin) {
  // Serialise — running two captures concurrently against the shared
  // window/canvas would interleave their data and produce garbage.
  return chartChain = chartChain.then(
    () => renderOnce(asin).catch((err) => {
      console.warn(`[chart-image] render failed for ${asin}: ${err.message}`);
      return null;
    })
  );
}

module.exports = { renderChartImage };
