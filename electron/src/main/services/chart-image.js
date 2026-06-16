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
// Stats table (~190px, now 6 rows: 価格/差額/下落率/利益額/利益率 — spec 項目11)
// + price chart (220px) + sellers chart (110px) + row paddings + section
// titles + outer margins. Rendered as a single PNG that mirrors the spec
// image: 6-row × 7-col stats grid on top, two charts below. Discord scales
// the image to fit any embed width without ever wrapping the contents.
// HEIGHT は chart-render.html の html,body { height } と必ず一致させること。
const HEIGHT = 648;
const WINDOW_IDLE_MS = 90_000;
const RENDER_TIMEOUT_MS = 10_000;

// GPU プロセスがクラッシュした瞬間に capturePage が走ると、viz の
// CopyOutputResult メッセージが破棄されて画像バッファが空 (0 B〜数 KB)
// で返ってくることがある。健全な PNG はヘッダ + メタ + 描画内容で
// 必ず ~10 KB を超えるので、それ以下は空キャプチャ扱いで再試行する。
// ※820×600 の真っ黒画像でも PNG 圧縮で ~2 KB あるので閾値 8 KB は安全。
const MIN_VALID_PNG_BYTES = 8 * 1024;

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
      // Hidden windows are background-throttled by default in Chromium
      // (rAF ≤ 1 Hz, timers stretched). The chart-render page uses two
      // rAFs to defer the ready signal until pixels are committed — if
      // those rAFs are throttled the capture fires too early and we
      // get a blank/black image. Disabling throttling here keeps the
      // render gate running at full speed.
      backgroundThrottling: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
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
  let readyHandler = null;
  let readyTimer  = null;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => {
      if (readyHandler) ipcMain.removeListener('chart:ready', readyHandler);
      reject(new Error('chart render timeout'));
    }, RENDER_TIMEOUT_MS);
    readyHandler = (e) => {
      if (!w || w.isDestroyed() || e.sender !== w.webContents) return;
      clearTimeout(readyTimer);
      ipcMain.removeListener('chart:ready', readyHandler);
      resolve();
    };
    ipcMain.on('chart:ready', readyHandler);
  });

  // Compute current effective price (latest BuyBox − points) for the
  // stats table's "実質最新価格" column and drop-rate denominators.
  // 実質価格 = BuyBox − ポイント + 送料 (2026-05 fix)。UI のリスト表示
  // と同じ計算式を通知用チャート画像でも適用する。
  const latestEff = product.last_price != null
    ? product.last_price - (product.last_points || 0) + (product.last_shipping_fee || 0)
    : null;

  // GPU プロセスが死んで再起動も失敗している間は、ウィンドウ自体は生きて
  // いても renderer フレームが disposed 状態になる。その状態で send()
  // を呼ぶと同期 throw でスタックトレースを撒き散らすので try/catch で
  // 受けて、ready の timeout 待ちをスキップして即 null を返す
  // (renderOnceWithRetry 側で次の再試行へ進む)。
  try {
    w.webContents.send('chart:render', {
      asin, from, to: now,
      data, avgKey: 'avg7d',
      stats, latestEff,
      // FBA利益額/ROE利益率 行 (spec 項目11) を表に出すための各手数料。
      fees: {
        amazon:  product.amazon_fee ?? null,
        fba:     product.fba_fee ?? null,
        storage: product.inventory_storage_fee ?? null,
      },
    });
  } catch (err) {
    if (readyTimer) clearTimeout(readyTimer);
    if (readyHandler) ipcMain.removeListener('chart:ready', readyHandler);
    return null;
  }

  try {
    await ready;
  } catch {
    // ready timeout — renderer は描画完了通知を返せなかった。GPU 死亡
    // 時はここに来る。null を返して上位で再生成 → リトライさせる。
    return null;
  }

  let image;
  try {
    image = await w.webContents.capturePage({
      x: 0, y: 0, width: WIDTH, height: HEIGHT,
    });
  } catch {
    return null;
  }
  scheduleIdleClose();
  // NativeImage.isEmpty() は GPU 経路が死んでいる時に true。toPNG() は
  // 空でも 0 B Buffer を返してしまうので、ここで先に弾く。
  if (image.isEmpty()) return null;
  const png = image.toPNG();
  return (png && png.length >= MIN_VALID_PNG_BYTES) ? png : null;
}

// GPU 障害連発時の保護: 直近に複数回失敗していたら、しばらくの間
// チャート添付をスキップして CPU/GPU の負荷を抑える。サイクル進行中の
// 通知を完全に止めはしないが、無駄なタイムアウト待ちを排除する。
let consecutiveFailures = 0;
let suspendUntilMs      = 0;
const FAILS_BEFORE_SUSPEND = 3;
const SUSPEND_MS            = 30_000;

// 1 回目が失敗した時の挙動。ウィンドウを破棄 → 短い待機 (GPU 側の
// 復旧時間を確保) → 1 回だけ再試行。それでも駄目なら null を返し、
// 連続失敗カウンタを増やす。3 連続失敗で 30 秒間スキップモードに入る。
async function renderOnceWithRetry(asin) {
  // スキップモード中は即 null 返却 (タイムアウト待ち 10 秒を完全に避ける)。
  if (Date.now() < suspendUntilMs) return null;

  let png = await renderOnce(asin);
  if (png) {
    consecutiveFailures = 0;
    return png;
  }

  console.warn(`[chart-image] empty capture for ${asin} — recreating window and retrying once`);
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch { /* swallow */ }
  }
  win = null;
  pageLoaded = false;
  // GPU プロセスが再起動するまでの猶予 — 即座に再生成しても renderer
  // フレームが死んだままになることが多いので短く待つ。
  await new Promise((r) => setTimeout(r, 500));

  png = await renderOnce(asin);
  if (png) {
    console.info(`[chart-image] retry succeeded for ${asin} (${png.length} bytes)`);
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILS_BEFORE_SUSPEND) {
      suspendUntilMs = Date.now() + SUSPEND_MS;
      console.warn(
        `[chart-image] ${consecutiveFailures} consecutive failures — ` +
        `suspending chart attachments for ${SUSPEND_MS / 1000}s`
      );
      consecutiveFailures = 0;
    } else {
      console.warn(`[chart-image] retry also returned empty for ${asin} — skipping attachment`);
    }
  }
  return png;
}

async function renderChartImage(asin) {
  // Serialise — running two captures concurrently against the shared
  // window/canvas would interleave their data and produce garbage.
  return chartChain = chartChain.then(
    () => renderOnceWithRetry(asin).catch((err) => {
      console.warn(`[chart-image] render failed for ${asin}: ${err.message}`);
      return null;
    })
  );
}

module.exports = { renderChartImage };
