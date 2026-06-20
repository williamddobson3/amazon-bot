'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, app, shell } = require('electron');
const { IPC_CHANNEL } = require('../shared/constants');
const Q = require('./db/queries');
const scheduler = require('./services/scheduler');
const { enqueueNotification } = require('./services/notifier');
const { captureProductCard } = require('./services/screenshot');
const feeCalc = require('./services/fee-calc');
const { loadFeeSettings } = require('./services/fee-settings');
const keepaRefresh = require('./services/keepa-refresh');
const fnmEval = require('./services/fnm-eval');
const appLog = require('./services/app-log');

// FNM スロット通知の最終再評価 (2026-06 fix)。renderer の評価キャッシュが
// 古い / アプリ多重起動などで、保存済み条件を満たさない商品の誤通知が
// renderer から飛んできても、ここで「現在保存されているスロット条件」+
// 「最新 stats」に照らして弾く。slotIndex は active/trash いずれかの
// customFilters 配列上の位置。条件が読めない/満たさない/実質無条件なら false。
function revalidateFnmSlot(ctx, slotIndex, stats) {
  try {
    const key = ctx === 'trash' ? 'trashFnm.customFilters' : 'fnm.customFilters';
    const raw = Q.getSetting(key);
    if (!raw) return false;
    const slots = JSON.parse(raw);
    const slot = slots && slots[slotIndex];
    const state = slot && slot.state;
    if (!state) return false;
    // 実質無条件 (全 unbounded) のスロットは通知させない。
    if (!fnmEval.hasFireableBound(state)) return false;
    const latestEff = stats && stats.latestEffective != null ? stats.latestEffective : null;
    return fnmEval.statsConditionsPass(stats, latestEff, state);
  } catch {
    return false;   // パース/読込失敗は安全側で発火しない
  }
}

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
  logout,
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

      // Keepa CSV の列名 → パラメータ名 マッピングを renderer に渡す。
      // renderer はこれを使い、CSV 各行から必要列だけ抜き出して
      // importProductsWithKeepaData に送る (送信ペイロードを最小化)。
      case 'getKeepaColumnMap':
        return feeCalc.KEEPA_CSV_COLUMN_MAP;

      // Keepa CSV インポート (2026-06 spec 項目7 + ①)。
      // payload.rows = [{ asin, params: { paramName: cellValue, ... } }, ...]
      // 各行について salesPrice を決め、fee-calc で 4 値を算出し、インポート
      // 直値と併せて products 行に保存する。
      case 'importProductsWithKeepaData': {
        const settings = loadFeeSettings(Q);
        const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
        const records = [];
        const seen = new Set();
        for (const r of rawRows) {
          const asin = String(r && r.asin || '').trim().toUpperCase();
          if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
          if (seen.has(asin)) continue;       // CSV 内重複は先勝ち
          seen.add(asin);
          let rec;
          try {
            // CSV に BuyBox 価格が無い行でも手数料を正しく算出できるよう、既に登録済みの
            // 商品の監視中現在価格 (last_price) を salesPrice のフォールバックとして渡す
            // (2026-06, client報告 B0BN7B9FKK: 価格欠落で Amazon手数料¥33/FBA手数料371 に
            // 化けていた)。新規商品で last_price が無ければ null (従来どおり)。
            const existing = Q.getProduct(asin);
            const fallbackPrice = existing && existing.last_price != null ? existing.last_price : null;
            rec = feeCalc.buildImportRecord(r.params || {}, settings, fallbackPrice);
          } catch (err) {
            // 1 行の計算失敗で全体を止めない — ASIN だけは登録する。
            rec = {};
          }
          rec.asin = asin;
          records.push(rec);
        }
        const res = Q.importProductsWithKeepaData(records);
        return { added: res.added, total: res.total, computed: records.length };
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

      // on-demand 計算 (通知判定 flushDirty + main の最終再評価が使う — 常に最新)。
      case 'getProductStats':
        return Q.getProductStats(payload.asin);

      case 'getProductStatsBatch':
        return Q.getProductStatsBatch(payload.asins || []);

      // 事前計算済み統計を読む高速経路 (2026-06)。表示/フィルタ/並び替えが使う。
      // 表に無い分は遅延計算して保存する。値は on-demand と同一。
      case 'getProductStatsTable':
        return Q.getProductStatsFromTable(payload.asin);

      case 'getProductStatsBatchTable':
        return Q.getProductStatsBatchFromTable(payload.asins || []);

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
        // 個別設定価格 (slotIndex < 0) は FNM 通知とは独立した cooldown
        // バケット (= 「個別」) で管理する。これにより FNM と個別が
        // 同じ ASIN で同時期に発火しても互いに 60 分間ブロックしない。
        const isIndividual = typeof payload.slotIndex === 'number' && payload.slotIndex < 0;
        const key = isIndividual
          ? `indiv:${payload.asin}`
          : `${ctx}:${payload.asin}`;
        const last = fnmNotifLastFired.get(key) || 0;
        if (Date.now() - last < FNM_NOTIF_COOLDOWN_MS) {
          return { ok: false, skipped: 'cooldown' };
        }
        // Pull the latest persisted product row (product passed in from
        // the renderer is from its in-memory cache; the DB version is
        // authoritative and cheaper to read here than to ship through IPC).
        const dbProduct = Q.getProduct(payload.asin) || payload.product || {};
        let stats = null;
        try { stats = Q.getProductStats(payload.asin); } catch { stats = null; }

        // ★ 2026-06 fix: FNM スロット通知は main で最終再評価する。renderer の
        // 古い条件キャッシュや多重起動による誤通知をここで弾く。個別設定価格
        // (slotIndex < 0) は価格閾値判定なので対象外 (再評価しない)。
        if (!isIndividual && typeof payload.slotIndex === 'number' && payload.slotIndex >= 0) {
          if (!revalidateFnmSlot(ctx, payload.slotIndex, stats)) {
            return { ok: false, skipped: 'revalidate' };
          }
        }
        // 送信を確定したのでここで cooldown をセット (弾いた通知は cooldown を
        // 消費しない = 次の正当な検知をブロックしない)。
        fnmNotifLastFired.set(key, Date.now());
        // 通知ヒット総回数 +1 / 最新通知日時を更新 (2026-06 spec 項目29)。
        // cooldown/再評価を通過した = 実際に送信する通知のみカウントする。
        try { Q.recordNotificationHit(payload.asin, Date.now()); } catch { /* best-effort */ }
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

      // ── Keepa API 定期更新 (spec 項目8) ──────────────
      // 「今すぐ更新」: 1 バッチを即時実行して結果を返す。
      case 'keepaRefreshNow':
        return await keepaRefresh.runOnce();

      // ステータス (設定有無 / トークン残見積り / キュー件数 / 直近結果)。
      case 'getKeepaStatus':
        return keepaRefresh.getStatus();

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
          // ソフトボット・ブロックの自動再開時刻 (ms)。> 0 ならブロック中で、
          // renderer がブロッキングモーダルにカウントダウン表示する。
          blockedUntil:  scheduler.getBlockedUntil(),
          // 現サイクル開始時刻 (ms)。フィルタ実行時に「今サイクルで再取得済みの
          // 商品 (last_observed_at >= これ) だけを評価」するため renderer が使う
          // (項目6: クロール開始直後の未再取得商品の古いデータ誤ヒット防止)。
          cycleStartedAt: scheduler.getCycleStartedAt(),
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

      // ── クロール ↔ 再計算 の排他制御 (2026-06 client要望) ──────────
      // 「更新」ボタン押下時: クロールを即停止 → 返ったら renderer が再計算。
      case 'pauseCrawlForRecalc':
        await scheduler.pauseForRecalc();
        return { ok: true };

      // 「更新」の再計算が終わったらクロール再開。
      case 'resumeCrawl':
        scheduler.resumeCrawl();
        return { ok: true };

      // 周期完了後の再計算が終わったと renderer が通知 → scheduler が次周期へ進む。
      case 'cycleRecalcDone':
        scheduler.notifyRecalcDone();
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

      // アプリのバージョン (package.json の version) — ヘッダー表示用。
      case 'getVersion':
        return { version: app.getVersion() };

      // アプリ内ログ (2026-06 client要望) — 監視クロールの動作履歴を返す。
      case 'getAppLog':
        return appLog.getLog(payload && payload.limit);

      // Amazon ログアウト (client request) — ログインセッションを破棄し、
      // 別アカウントでのログイン / パスワード変更後の再ログインを可能にする。
      // 未認証のままクロールを続けても CAPTCHA を誘発するだけなので、
      // 監視中であれば停止する。
      case 'logout': {
        const ok = await logout();
        try { if (scheduler.isRunning()) scheduler.stop(); } catch { /* noop */ }
        return { ok };
      }

      case 'solveCaptcha':
        if (callbacks.openCaptchaSolve) callbacks.openCaptchaSolve();
        return { ok: true };

      // 「Amazonが返したページを確認」(生ページ表示) は B10 で撤去 — 検索URL/まとめ
      // 検索が露出し内部アルゴリズム漏洩につながるため、IPC 経路ごと削除した。

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

      // ── クロール診断モーダル用データ ──────────────────────────
      // モーダル表示時に呼ばれ、(a) 直近 sinceMs 以降のページ時間サンプル
      // 全件 と (b) 同期間内のブロックイベントを併せて返す。フロント側
      // でグラフ + 縦線マーカーとして描画する。
      case 'getCrawlDiagnostics': {
        const since = payload.sinceMs || (Date.now() - 24 * 3600 * 1000);
        return {
          timings: Q.getPageTimingsSince(since),
          cycles:  Q.getCycleTimingsSince(since),
          blocks:  Q.getBlockEventsSince(since),
        };
      }

      // 直近 1 周期の所要時間 — ヘッダーバッジの初期表示用。
      case 'getLastCycleTime':
        return Q.getLastCycleTiming();

      // 個別設定価格の保存 (2026-05)。空白入力なら null で渡され、DB 上も
      // NULL になって「通常通り FNM 通知ロジックに従う」状態に戻る。
      case 'setNotifyPrice': {
        const v = Q.setNotifyPrice(payload.asin, payload.price);
        return { ok: true, value: v };
      }

      // ── サイト比較: open Keepa + Amazon **product detail** pages in
      // the user's default browser. Routed through shell.openExternal
      // so the real Chrome / Edge (or whatever default browser) handles
      // them — embedding in an in-app BrowserWindow trips Keepa's
      // anti-bot check because Electron's webContents has a different
      // fingerprint. Modern browsers reuse the existing window and add
      // each URL as a new tab, satisfying the "1 window, multiple tabs"
      // intent.
      //
      // ② is the Amazon product DETAIL page (/dp/...?th=1), NOT the
      // search page (/s?k=...) — the search page lists multiple matches
      // and is one extra click away from the detail page the user
      // actually wants. `th=1` forces the canonical variant view so
      // multi-variant items don't bounce to a parent ASIN.
      case 'openCompareTabs': {
        const asin = String(payload.asin || '').toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, error: 'INVALID_ASIN' };
        await shell.openExternal(`https://keepa.com/#!product/5-${asin}`);
        await shell.openExternal(`https://www.amazon.co.jp/dp/${asin}/?th=1`);
        return { ok: true };
      }

      // ── 商品画像クリック: Amazon 商品ページ (/dp/<ASIN>) を既定ブラウザ
      // で開く。openCompareTabs と同じく shell.openExternal 経由なので、
      // アプリ内 BrowserWindow に埋め込まず実ブラウザで表示される。
      case 'openProductPage': {
        const asin = String(payload.asin || '').toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, error: 'INVALID_ASIN' };
        await shell.openExternal(`https://www.amazon.co.jp/dp/${asin}`);
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
