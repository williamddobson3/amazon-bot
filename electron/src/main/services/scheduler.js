'use strict';

const {
  getActiveAsins,
  resetCycleSeen,
  updateProductAfterScrape,
  insertObservationsBatch,
  refreshProductStatsBatch,
  getPriceBaselines,
  insertPageTiming,
  pruneOldPageTimings,
  insertCycleTiming,
  pruneOldCycleTimings,
  getReferralPctMap,
  insertBlockEvent,
} = require('../db/queries');
const appLog = require('./app-log');
// Amazon販売手数料を「最新BuyBox価格 × 最新紹介料% × 1.1」で毎クロール再計算
// するためのプラム配管 (機密の計算式は Rust 内、2026-06 client要望)。
const fee = require('./fee-calc');
// Crawl execution moved out of process — `crawler-bridge.js` drives a
// compiled Rust sidecar (electron/crawler/) which owns HTTP fetch +
// HTML parse + the 135→45 coverage loop. Same `runCoverage(asins, opts)`
// shape so this scheduler barely changes.
const { runCoverage } = require('./crawler-bridge');
// Legacy `conditions`-table evaluator removed (2026-05). All notification
// logic now lives in the FNM custom-filter slot path. The old evaluator
// silently fired notifications for any leftover conditions row, which
// is dangerous for an app that intentionally surfaces only the FNM UI.

let running = false;
let cycleTimer = null;
let mainWindow = null;
let cycleCount = 0;
// 現サイクルの開始時刻 (ms)。フィルタ実行時に「今サイクルで再取得済み (=
// last_observed_at >= これ) の商品だけを評価する」ために renderer へ公開する
// (2026-06, client報告 項目6: クロール開始直後にフィルタ実行すると、まだ再取得
// されていない商品が前サイクルの古い瞬間下落でヒットしてしまうのを防ぐ)。
let cycleStartedAt = 0;
// クロール診断: 直前の progress イベント時刻を保持し、本イベントとの差で
// 「1 ページ取得時間」を算出する。サイクル開始時に 0 にリセットして、
// 初回 progress では計測しない (= 比較対象が無いため)。
let lastProgressMs = 0;
// Per-spec: 監視スタート acts on the user's ✅checked subset only.
// `restrictAsins` (Set<string>|null) holds that subset for the current
// run. Null means "scrape every active product" — used when the
// scheduler is launched without a restriction (e.g., post-login auto-
// start at boot).
let restrictAsins = null;
// AbortController fired by stop() to interrupt:
//   - the current rate-limit / CAPTCHA-pause sleep in awaitFetchSlot
//   - the in-flight HTTP fetch in fetchPage
// so 監視ストップ halts work mid-batch instead of waiting for the
// current request to finish.
let cycleAbort = null;

// Rest-period telemetry exposed to the renderer so it can show a
// countdown between cycles. `nextCycleAt` is an absolute timestamp;
// `currentRestMs` is the full rest duration (used by the UI to draw
// the circular progress ring).
let nextCycleAt   = 0;
let currentRestMs = 0;

// ソフトボット検知 (ブロック) でクロールを一時停止したとき、自動再開する
// 絶対時刻 (ms)。0 = ブロックされていない。UI のブロッキングモーダルが
// この時刻でカウントダウンを表示し、到達すると runLoop が自動リトライする
// (2026-06 client要望)。早期解除は resumeFromBlock() で行う。
let blockedUntil  = 0;
// 段階的バックオフ (2026-06 client提案): 連続でソフトブロックされるほど待機を
// 延ばす。1分→3分→5分→10分 (以降は10分上限)。クリーンに1周完了したら
// softBlockStreak をリセットして 1 分に戻す。
const SOFT_BLOCK_PAUSE_LADDER_MS = [1, 3, 5, 10].map((m) => m * 60 * 1000);
let softBlockStreak = 0;   // 連続ソフトブロック回数 (クリーン周期でリセット)

// ソフトボット検知 (classify_block が拾えない確認ページ/空ページ等)。ページ自体は
// 取得できる (HTTP 200) のに商品カードが 1 件も無いページが連続したら、Amazon が
// 非商品ページ (Akamai インターステーシャル等) を返している疑いとみなす。
// 2026-06 client要望で判定を2段階に緩和:
//   ・LOG 閾値 (3連続): 「疑い」をアプリ内ログに残すだけ。クロールは中断しない
//     (一時的な0件で無駄に止めない = 誤検知での停止を減らす)。
//   ・ABORT 閾値 (15連続, 旧5から緩和): ここで初めてサイクルを中断しモーダル表示。
const SOFT_BLOCK_LOG_LIMIT       = 3;
const SOFT_BLOCK_EMPTY_PAGE_LIMIT = 15;
let consecutiveEmptyPages = 0;
let softBlockTripped = false;
let softBlockLogged  = false;   // このサイクルで「疑い」を既にログしたか (重複防止)

const { PUSH, REST_MIN_MS, REST_MAX_MS } = require('../../shared/constants');

// ── クロール ↔ 再計算 の排他制御 (2026-06 client要望) ─────────────────
// クロール (スクレイプ) と renderer の値再計算を「絶対に同時に走らせない」。
//   ・周期完了後: 次の周期を始める前に renderer の再計算完了 (notifyRecalcDone)
//     を待つ。これでスクレイプと再計算が重ならず、表示値・通知が常に整合する。
//   ・「更新」ボタン: pauseForRecalc でクロールを即停止 (abort) → renderer 再計算
//     → resumeCrawl で再開。
//   ・「監視ストップ」: stop() で完全停止 → renderer が再計算 (重なりなし)。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let paused = false;              // 「更新」のための一時停止 (再計算中はスクレイプしない)
let crawlActive = false;         // runCoverage 実行中 (= スクレイプ中) か
let loopGen = 0;                 // runLoop の世代 — 古い周回を確実に無効化する
let _recalcDoneResolve = null;   // 周期完了後の「再計算完了」待ちの resolver
const RECALC_WAIT_TIMEOUT_MS = 10 * 60 * 1000;  // renderer 異常時にハングしない安全弁
// 安全ラッチ: pauseForRecalc で止めたクロールが、renderer の異常 (resumeCrawl が
// 来ない/再計算ハング) で永久に止まりっぱなしにならないよう、一定時間で自動再開する。
// 事前計算済み統計の導入で再計算は ~1 秒なので通常これは発火しない (純粋な保険)。
let pauseWatchdog = null;
const PAUSE_WATCHDOG_MS = 45 * 1000;   // 事前計算済み統計で再計算は ~1 秒なので、詰まり検知は短くてよい

// ── 価格サニティチェック (Guard #1, 2026-06 client要望) ──────────────────
// 検索ページのスクレイプは高額・多バリエーション・第三者出品の商品で、たまに BuyBox
// 以外の数字 (分割払い/他の出品/クーポン等) を価格として誤読する。誤読は「商品の基準
// 価格 (直近7日平均) から極端に外れた値」になるので、その読み取りは採用せず前回の良い
// 値を保持する。これで誤読が DB に入って ROE が +15,060% 等に化けるのを根本で止める。
// price=null (BuyBox も他の出品も取れず) も「欠損」として採用しない (前回値を保持)。
// 閾値は調整可能。
const PRICE_SANITY_LOW = 0.2;    // 基準の 20% 未満は誤読扱い (採用しない)
const PRICE_SANITY_HIGH = 5;     // 基準の 5 倍超も誤読扱い
function isPlausiblePrice(price, baseline) {
  if (price == null) return false;                        // 欠損 → 前回の良い値を保持
  if (baseline == null || baseline <= 0) return true;     // 基準なし (初回等) → 判定不能、採用
  if (price < baseline * PRICE_SANITY_LOW) return false;  // 安すぎ (誤読)
  if (price > baseline * PRICE_SANITY_HIGH) return false; // 高すぎ (誤読)
  return true;
}

function setMainWindow(win) {
  mainWindow = win;
}

function pushToRenderer(channel, data) {
  // `BrowserWindow.isDestroyed()` だけでは不十分 — ウィンドウは生きていても
  // renderer の WebFrame が disposed 状態 (リロード途中・アプリ終了直前・
  // DevTools 開閉のタイミング等) のことがあり、その間に send() を呼ぶと
  // 「Render frame was disposed before WebFrameMain could be accessed」で
  // throw する。webContents の破棄状態も併せて確認 + 念のため try/catch。
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send(channel, data);
  } catch (err) {
    // frame disposed タイミングでのみ起きる過渡的エラー。スクレイプ自体は
    // 問題なく続いているのでスタックを吐き続けないよう静かに飲み込む。
    if (!/disposed|destroyed/i.test(err.message)) {
      console.warn(`[scheduler] pushToRenderer(${channel}) failed: ${err.message}`);
    }
  }
}

async function runOneCycle() {
  if (!running) return;
  // The sidecar self-protects when in a CAPTCHA pause — a Crawl
  // command issued mid-pause returns `paused: true` at the first batch
  // boundary with zero pages fetched. No need for a JS-side gate.

  const allActive = getActiveAsins();
  // Intersect with the user's restriction set if one was supplied via
  // 監視スタート. Trashing a product mid-run automatically drops it
  // from `getActiveAsins`, so the intersection naturally re-narrows
  // every cycle without us tracking trash events here.
  const asins = restrictAsins
    ? allActive.filter((a) => restrictAsins.has(a))
    : allActive;
  if (asins.length === 0) {
    console.info(
      `[scheduler] no products to scrape ` +
      `(active=${allActive.length}, restricted=${restrictAsins ? restrictAsins.size : 'all'}) — sleeping`
    );
    return;
  }

  cycleCount++;
  // サイクル開始でページ時間計測リセット — 周期またぎの大きな間隔
  // (= rest 時間) を「1 ページ時間」として記録しないため。
  lastProgressMs = 0;
  console.info(`[scheduler] cycle #${cycleCount} starting (${asins.length} products)`);

  // Warmup (organic-traffic seeding) is now done inside the sidecar's
  // Fetcher on its first crawl — no explicit call needed here.

  // Reset the cycle_seen flag on all products so the coverage loop can
  // track which ones were found this time around.
  resetCycleSeen();

  const startMs = Date.now();
  // この時刻以降に last_observed_at が付いた商品 = 今サイクルで再取得済み。
  cycleStartedAt = startMs;
  // ソフトボット検知カウンタをサイクル毎にリセット。
  consecutiveEmptyPages = 0;
  softBlockTripped = false;
  softBlockLogged = false;
  appLog.log('info', `監視クロール 周期${cycleCount} を開始 (対象 ${asins.length} 件)`);

  crawlActive = true;            // スクレイプ中 — pauseForRecalc がアイドル待ちに使う
  const result = await runCoverage(asins, {
    signal: cycleAbort ? cycleAbort.signal : undefined,
    // Block events are surfaced globally by the bridge (which fires
    // `onClientPause` in index.js), so no per-call onBlock is needed.
    onPageResult: (results, page, totalPages) => {
      const now = Date.now();
      const observations = [];
      // Guard #1: ページ内各商品の基準価格を取得。極端に外れた/欠損の読み取りは不採用に
      // し、dropped に入れた ASIN は 商品更新 / 観測挿入 / 統計更新 / 通知 を全てスキップ
      // する (= 前回の良い値を保持)。
      const baselines = getPriceBaselines(results.map((r) => r.asin));
      const dropped = new Set();

      // ──────────────────────────────────────────────────────────
      // フェーズ 1: products テーブル更新 + observations 配列構築。
      // ここでは renderer に通知しない (= 通知側評価がまだ古い stats
      // を引かないようにするため)。
      //
      // 2026-06 fix:
      //   旧仕様では「updateProductAfterScrape → observations.push →
      //   pushToRenderer」を 1 商品ごとに繰り返し、ページ終了後に
      //   insertObservationsBatch を実行していた。すると renderer の
      //   flushDirty が getPreviousEffectivePrice を呼ぶタイミングで
      //   「新しい観測がまだ observations テーブルに入っていない」
      //   状態が発生し、OFFSET 1 が「本来 1 つ前のはずだった行」では
      //   なく「もっと古い昔の行」を返してしまっていた。
      //   結果 prevEffective が異常に高い (or 低い) 値になり、瞬間下落率
      //   が見かけ上 15% 以上になり「条件未達なのに通知発火」となる
      //   誤通知の真因。
      //
      // 修正: DB 書き込み (products + observations の両方) を全件完了
      // させてから renderer に push する。これで renderer 側の評価で
      // 見える DB 状態は常に「最新観測込みで整合」になる。
      // ──────────────────────────────────────────────────────────
      // 紹介料% (imp_referral_pct) をこのページ分まとめて引いておく。
      // Amazon販売手数料の再計算 (= 最新価格 × 紹介料% × 1.1) に使う。
      const pctMap = getReferralPctMap(results.map((r) => r.asin));

      for (const r of results) {
        // BuyBox fallback: when Amazon doesn't show a BuyBox price for
        // this ASIN (e.g., 出品者数 ≥ 1 but no Featured Offer), fall
        // back to the lowest other-seller price so charts / 平均 / 下落率
        // don't go blank. The substitution happens here (single source
        // of truth) so updateProductAfterScrape, the observation row,
        // the renderer push, and downstream evaluators all see the same
        // effective BuyBox value.
        //
        // EXCEPTION (2026-05 client spec): if 他の出品 contains "中古"
        // (mpCondition = "中古品" or "新品と中古品"), do NOT fall back —
        // mpPrice in that case is often a used-item price which would
        // distort the BuyBox history. Leave r.price as null so the
        // BuyBox column stays empty for this scrape. mpPrice itself is
        // still preserved separately in the 他の出品価格 column.
        const otherHasUsed = typeof r.mpCondition === 'string' && r.mpCondition.includes('中古');
        if (r.price == null && r.mpPrice != null && !otherHasUsed) {
          r.price = r.mpPrice;
          r.priceFromMp = true;       // diagnostic flag — consumers can detect the substitution
        }

        // ★ Guard #1 (価格サニティチェック): フォールバック適用後の価格が基準から極端に
        // 外れている (誤読の疑い) か、価格が取れていない (欠損) 場合は、このスクレイプ結果を
        // 採用しない = 前回の良い値を DB に保持する。これが ROE +15,060% / 「—」の根本対策。
        if (!isPlausiblePrice(r.price, baselines[r.asin])) {
          dropped.add(r.asin);
          continue;
        }

        // Amazon販売手数料を「最新の BuyBox価格 (= r.price, 実質価格ではない素の
        // BuyBox 価格) × 最新の紹介料% (imp_referral_pct) × 1.1」で再計算する
        // (2026-06 client要望)。インポート時に確定した値は価格更新に追従しない
        // ため、価格が変わるこのタイミングで上書きする。紹介料% / 価格が無い商品
        // は null → updateProductAfterScrape 側でインポート値を維持する。機密の
        // 計算式は Rust 内 (fee.computeLiveAmazonFee → computeFees)。
        const liveAmazonFee = fee.computeLiveAmazonFee(r.price, pctMap[r.asin]);
        // PRICE_UPDATE で renderer のメモリ値 (allProducts[].amazon_fee) も
        // 同じ値に更新するため、結果オブジェクトに載せて持ち回る。
        r.amazonFee = liveAmazonFee;

        // Update the product's "last known" snapshot.
        updateProductAfterScrape({
          asin:         r.asin,
          title:        r.title,
          imageUrl:     r.imageUrl,
          price:        r.price,
          points:       r.points,
          delivery:     r.delivery,
          mpPrice:      r.mpPrice,
          mpCount:      r.mpCount,
          mpCondition:  r.mpCondition,
          monthlySales: r.monthlySales,
          shippingFee:  r.shippingFee,
          amazonFee:    liveAmazonFee,
          observedAt:   now,
        });

        // Queue an observation row.
        observations.push({
          asin:         r.asin,
          observedAt:   now,
          price:        r.price,
          points:       r.points,
          delivery:     r.delivery,
          imageUrl:     r.imageUrl,
          mpPrice:      r.mpPrice,
          mpCount:      r.mpCount,
          mpCondition:  r.mpCondition,
          monthlySales: r.monthlySales,
          shippingFee:  r.shippingFee,
        });
      }

      if (dropped.size > 0) {
        console.info(`[scheduler] price-guard: dropped ${dropped.size} implausible/missing read(s) — kept last good value`);
      }

      // フェーズ 2: 観測を全件 DB に同期書込 (1 トランザクション)。
      // ここまで完了させてから renderer へ通知する。
      if (observations.length > 0) {
        insertObservationsBatch(observations);
      }

      // フェーズ 2.5: このページ分の事前計算済み統計を更新する (2026-06 client要望)。
      // 観測を書き込んだ「今」に、変化した商品だけ getProductStats を再計算して
      // product_stats 表へ upsert する。これで「更新/周期完了/フィルタ・並び替え」の
      // 再計算は 190 万行を都度走査せず表を読むだけ (~1 秒) で済み、クロールを長く
      // 止めなくなる。値は getProductStats と同一なので表示は変わらない。統計の
      // 失敗はスクレイプを止めない (best-effort)。
      try {
        // 不採用 (dropped) の商品は更新していないので統計も再計算しない。
        refreshProductStatsBatch(
          results.filter((r) => !dropped.has(r.asin)).map((r) => r.asin), now);
      } catch (e) {
        console.warn(`[scheduler] product_stats refresh failed: ${e.message}`);
      }

      // フェーズ 3: renderer へ価格更新を一斉プッシュ。これで renderer
      // 側の flushDirty が getProductStats を呼んだ瞬間、必ず新しい観測が
      // observations テーブルに入った状態で評価される。
      // (Legacy condition evaluator removed — FNM custom-filter slots
      // in the renderer side now own all notification firing.)
      for (const r of results) {
        if (dropped.has(r.asin)) continue;   // 不採用は通知しない (表示は前回値のまま)
        pushToRenderer(PUSH.PRICE_UPDATE, {
          asin: r.asin,
          data: r,
          updatedAt: now,
        });
      }

      // ソフトボット検知: 商品カードが 1 件も無いページ (= 確認ページ/空ページの
      // 疑い) が連続したら、classify_block が拾えない種類のブロックとみなして
      // サイクルを中断する。runLoop 側でブロック状態に入り、原因モーダルを出す。
      // results.length は「ページ上の全商品カード数」なので、対象 ASIN が
      // ヒットしなくても sponsored/関連商品が出ていれば 0 にはならない = 0 は
      // 純粋に非商品ページのシグナル (誤検知しにくい)。
      if (results.length === 0) {
        consecutiveEmptyPages++;
        // 段階1 (req4): 短い0件連続は「疑い」としてログに残すだけ。中断しない。
        if (!softBlockLogged && consecutiveEmptyPages >= SOFT_BLOCK_LOG_LIMIT) {
          softBlockLogged = true;
          appLog.log('warn',
            `商品0件のページが ${consecutiveEmptyPages} 回連続 — ソフトブロックの疑い ` +
            `(一時的な可能性があるため、まだ中断せず継続します)`);
        }
        // 段階2 (req5): 長く続いた時だけサイクルを中断しモーダル表示 (閾値 5→15 に緩和)。
        if (!softBlockTripped && consecutiveEmptyPages >= SOFT_BLOCK_EMPTY_PAGE_LIMIT) {
          softBlockTripped = true;
          appLog.log('warn',
            `商品0件のページが ${SOFT_BLOCK_EMPTY_PAGE_LIMIT} 回連続 — ソフトブロックと判断し ` +
            `サイクルを中断します`);
          if (cycleAbort) { try { cycleAbort.abort(); } catch { /* used signal */ } }
        }
      } else {
        consecutiveEmptyPages = 0;
      }
    },

    onProgress: (progress) => {
      // クロール診断: 1 ページごとの実所要時間を計測。各 progress イベント
      // 間のウォールクロック差を「直前ページから本ページ完了までの時間」
      // として記録する。サイクル初回 (lastProgressMs == 0) はスキップ。
      const now = Date.now();
      if (lastProgressMs > 0 && progress && progress.page != null) {
        const elapsedMs = now - lastProgressMs;
        try {
          insertPageTiming({
            recordedAt: now,
            cycle:      cycleCount,
            page:       progress.page,
            totalPages: progress.total_pages ?? progress.totalPages ?? null,
            elapsedMs,
          });
        } catch (e) {
          // 計測失敗してもクロール本体は止めない。
          console.warn(`[scheduler] page timing insert failed: ${e.message}`);
        }
      }
      lastProgressMs = now;
      pushToRenderer(PUSH.CYCLE_PROGRESS, progress);
    },
  });
  crawlActive = false;          // スクレイプ完了/中断 — クロールはアイドル

  // 古い診断データを定期的に削除 (7 日より古いものはモーダルでも表示
  // しないので保持しない)。cycle 完了時に 1 回呼べば十分。
  try {
    pruneOldPageTimings(Date.now() - 7 * 86_400_000);
    pruneOldCycleTimings(Date.now() - 7 * 86_400_000);
  } catch { /* swallow — pruning失敗は致命ではない */ }

  const elapsedMs  = Date.now() - startMs;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  console.info(
    `[scheduler] cycle #${cycleCount} done in ${elapsedSec}s — ` +
    `${result.found}/${result.total} found, ${result.missed} missed, ` +
    `${result.pages} pages, ${result.errors} errors`
  );

  // 周期合計時間を診断テーブルに記録 — モーダルの 2 つ目の棒グラフ用。
  // 早期中断 (CAPTCHA → paused / ユーザー停止 → aborted) や 0 ページ
  // 処理の周期は「完了していない」ので除外する。これらを含めると棒
  // グラフに極端に短いバーが混ざり、平均値や見た目が壊れる (2026-05 fix)。
  const isPartialCycle =
    result.aborted === true ||
    result.paused  === true ||
    (result.pages ?? 0) === 0;
  if (isPartialCycle) {
    console.info(
      `[scheduler] skipping cycle_timing insert (partial cycle: ` +
      `aborted=${!!result.aborted}, paused=${!!result.paused}, pages=${result.pages ?? 0})`
    );
  } else {
    try {
      insertCycleTiming({
        recordedAt: Date.now(),
        cycle:      cycleCount,
        totalPages: result.pages ?? null,
        found:      result.found ?? null,
        missed:     result.missed ?? null,
        errors:     result.errors ?? null,
        elapsedMs:  Math.round(elapsedMs),
      });
    } catch (e) {
      console.warn(`[scheduler] cycle timing insert failed: ${e.message}`);
    }
  }

  // 周期が「正常完了」したときだけ CYCLE_COMPLETE を送る。停止/更新/CAPTCHA で
  // 中断された場合は送らない — 中断時は renderer 側 (監視停止/更新の経路) が再計算を
  // 駆動するため、二重発火 + runLoop の待機解除の取り違えを防ぐ。
  if (running && !paused && !result.aborted && !result.paused) {
    appLog.log('info',
      `周期${cycleCount} 完了 — 取得 ${result.found ?? 0}/${result.total ?? 0} 件 ` +
      `(${result.pages ?? 0}ページ, ${elapsedSec}秒)`);
    pushToRenderer(PUSH.CYCLE_COMPLETE, {
      cycle: cycleCount,
      ...result,
      elapsedSec: parseFloat(elapsedSec),
    });
  } else if (result.aborted) {
    appLog.log('warn', `周期${cycleCount} は中断されました (取得 ${result.found ?? 0} 件)`);
  }
  return result;
}

// 周期ループ (モジュールスコープ — pause/resume から再起動できるようにした)。
// 1 周期スクレイプ → 周期完了なら renderer の再計算完了を待ってから休止 → 次周期。
// 「再計算が終わるまで次のスクレイプを始めない」= クロールと再計算を重ねない。
async function runLoop() {
  const gen = ++loopGen;          // この周回の世代。新しい runLoop が始まれば無効化される。
  cycleTimer = null;
  if (!running || paused) return;
  // Clear rest telemetry — cycle is active now, not resting.
  nextCycleAt   = 0;
  currentRestMs = 0;
  // 周期完了後の「再計算完了」待ち promise を、CYCLE_COMPLETE 送信より前に用意する
  // (renderer の notifyRecalcDone を取りこぼさないため)。
  const recalcDone = new Promise((resolve) => { _recalcDoneResolve = resolve; });
  const result = await runOneCycle();   // スクレイプ + 正常完了時のみ CYCLE_COMPLETE 送信
  if (gen !== loopGen || !running || paused) { _recalcDoneResolve = null; return; }

  // ── ソフトボット検知 (ブロック) — クロールを止め、10 分後に自動再開 ──
  // ブロックされた周期は CYCLE_COMPLETE を送らない (= renderer の再計算完了
  // 通知が来ない) ため、従来はこの後の recalc 待ちで最大 10 分「無音フリーズ」
  // していた (client報告: 周期完了直後に監視番号もスリープ残り時間も出ない真因)。
  // 代わりにここで明示的にブロック状態へ入り、blockedUntil を立てて (UI の
  // ブロッキングモーダルがカウントダウン表示)、10 分後に runLoop を自動リトライ
  // する。早期解除は resumeFromBlock() (再ログイン / 手動認証解除 / pause 期限
  // 切れ) で行う。
  // classifiedBlock = Rust の classify_block が CAPTCHA/dog/login 等を検知 (= 既に
  //   onClientPause → CAPTCHA_PAUSE でモーダル表示済み)。
  // softBlock = classify_block が拾えない確認ページ/空ページ。連続空ページで
  //   中断した (softBlockTripped) か、サイクルが「ページは取れたが取得 0 件」で
  //   終わった場合。Rust から Event::Block が出ないので、ここでモーダルを出す。
  const classifiedBlock = !!(result && result.paused);
  const softBlock = !classifiedBlock && !!result && (
    softBlockTripped ||
    (!result.aborted && (result.pages || 0) > 0 && (result.found || 0) === 0)
  );
  if (running && !paused && (classifiedBlock || softBlock)) {
    _recalcDoneResolve = null;
    // ソフトブロックでサイクルを abort した場合、cycleAbort は使用済みなので
    // 次サイクル (自動再開/早期再開) 用に作り直す (即 abort されないように)。
    if (softBlockTripped) cycleAbort = new AbortController();
    // 段階的バックオフ (req6): 連続回数に応じて 1→3→5→10 分。
    const ladderIdx = Math.min(softBlockStreak, SOFT_BLOCK_PAUSE_LADDER_MS.length - 1);
    const pauseMs = SOFT_BLOCK_PAUSE_LADDER_MS[ladderIdx];
    softBlockStreak += 1;
    blockedUntil  = Date.now() + pauseMs;
    nextCycleAt   = 0;     // 通常の「周期間スリープ」ではない — モーダルが時刻を持つ
    currentRestMs = 0;
    if (softBlock) {
      // Rust の Event::Block が出ない種類のブロック — ここで明示的にモーダルを出す。
      pushToRenderer(PUSH.CAPTCHA_PAUSE, {
        source: 'amazon',
        reason: 'Amazonが商品ページの代わりに確認ページを返している可能性があります（商品の取得が0件）。',
        pausedUntil: blockedUntil,
        solveUrl: null,
        soft: true,
      });
      // ブロック発生履歴に残す (req4: 「ブロック発生履歴が常に空」への対応)。
      try {
        insertBlockEvent({ type: 'SOFT_BLOCK', source: 'amazon', streak: softBlockStreak });
      } catch (e) { console.warn('[scheduler] block-event log failed:', e.message); }
    }
    appLog.log('warn',
      `${softBlock ? 'ソフト' : ''}ブロックを検知 — クロールを一時停止します ` +
      `(${Math.round(pauseMs / 60000)}分後に自動再開 / 連続${softBlockStreak}回目)`);
    if (cycleTimer) clearTimeout(cycleTimer);
    cycleTimer = setTimeout(() => {
      blockedUntil = 0;
      // 再開フェーズに入ったらモーダルを閉じ、通常の監視画面に戻す (req3)。
      // クロールはこの後バックグラウンドで普通に回る。
      appLog.log('info', '一時停止が明けたため、監視クロールを再開します');
      pushToRenderer(PUSH.CAPTCHA_RESUME, {});
      runLoop();
    }, pauseMs);
    return;
  }
  // クリーン完了 (= ブロックされなかった) — 連続ソフトブロックのカウンタを戻す (req6)。
  if (softBlockStreak > 0) {
    appLog.log('info', '監視クロールが正常に1周完了 — ブロック連続カウンタをリセット');
    softBlockStreak = 0;
  }

  const cycleEndMs = Date.now();
  // renderer が再計算を完了するまで待つ (= ここでスクレイプは止まっている)。
  // renderer 異常時に固まらないよう安全タイムアウト付き。
  await Promise.race([recalcDone, sleep(RECALC_WAIT_TIMEOUT_MS)]);
  if (gen !== loopGen || !running || paused) return;
  _recalcDoneResolve = null;
  // 「再計算が完了してから次周期へ」。ただし最低 1〜2 分の休止は確保する:
  // 商品数が少なく再計算が短ければ残りの休止時間を待ち、再計算が長ければ完了済みなので
  // 直ちに次周期へ進む (gap = max(再計算時間, 1〜2 分))。
  const restMs = REST_MIN_MS + Math.floor(Math.random() * (REST_MAX_MS - REST_MIN_MS));
  const restRemaining = Math.max(0, restMs - (Date.now() - cycleEndMs));
  currentRestMs = restMs;
  nextCycleAt   = Date.now() + restRemaining;
  console.info(`[scheduler] recalc done; next cycle in ${Math.round(restRemaining / 1000)}s`);
  cycleTimer = setTimeout(runLoop, restRemaining);
}

// 「更新」ボタン経路: クロールを即停止して再計算を行うための一時停止。
// abort でスクレイプを止め、runCoverage が抜ける (crawlActive=false) のを待ってから
// 返す。これで再計算がスクレイプと重ならない。停止中は何もしない。
async function pauseForRecalc() {
  if (!running) return;
  paused = true;
  loopGen++;                      // 進行中の runLoop を無効化
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  if (cycleAbort) { try { cycleAbort.abort(); } catch { /* used signal */ } }
  // 安全ラッチ: resumeCrawl が来ないままになっても、一定時間で自動再開する。
  if (pauseWatchdog) clearTimeout(pauseWatchdog);
  pauseWatchdog = setTimeout(() => {
    pauseWatchdog = null;
    if (paused && running) {
      console.warn('[scheduler] recalc-pause watchdog fired — auto-resuming crawl');
      resumeCrawl();
    }
  }, PAUSE_WATCHDOG_MS);
  const t0 = Date.now();
  while (crawlActive && Date.now() - t0 < 30_000) await sleep(50);
}

// 「更新」の再計算完了後にクロールを再開する。
function resumeCrawl() {
  if (pauseWatchdog) { clearTimeout(pauseWatchdog); pauseWatchdog = null; }
  if (!paused) return;
  paused = false;
  if (!running) return;
  cycleAbort = new AbortController();   // 前の signal は abort 済みで再利用不可
  if (!cycleTimer) cycleTimer = setTimeout(runLoop, 0);
}

// 周期完了後の再計算が終わったと renderer から通知される。runLoop の待機を解く。
function notifyRecalcDone() {
  if (_recalcDoneResolve) { _recalcDoneResolve(); _recalcDoneResolve = null; }
}

// ソフトボット・ブロックからの早期再開。blockedUntil が立っているときだけ作用し、
// 自動再開待ちタイマーを解除して即リトライする (再ログイン / 手動認証解除 /
// フェッチャ pause の期限切れ から呼ばれる)。呼び出し側がフェッチャ側の pause を
// 先に解除 (liftPause) しておかないと、リトライ周期が即再ブロックされうる。
function resumeFromBlock() {
  if (!running || !blockedUntil) return false;
  blockedUntil = 0;
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  // 早期再開でもモーダルを閉じ通常画面へ戻す (req3)。
  appLog.log('info', '手動操作によりブロック待機を解除し、監視クロールを再開します');
  pushToRenderer(PUSH.CAPTCHA_RESUME, {});
  cycleTimer = setTimeout(runLoop, 0);
  return true;
}

// クロールがソフトボットでブロック中か (= 自動再開待ち)。
function isBlocked() {
  return running && blockedUntil > Date.now();
}

// ブロック自動再開の絶対時刻 (ms)。0 = ブロックされていない。UI のモーダルが
// カウントダウンに使う (getStatus 経由)。
function getBlockedUntil() {
  return (running && blockedUntil > Date.now()) ? blockedUntil : 0;
}

function start(opts = {}) {
  if (running) return;
  // `opts.asins` (array) restricts this run to a specific subset; an
  // empty array is treated as "no restriction" so a misuse doesn't
  // silently lock the scheduler into scraping nothing.
  if (Array.isArray(opts.asins) && opts.asins.length > 0) {
    restrictAsins = new Set(opts.asins.map((a) => String(a).toUpperCase()));
    console.info(`[scheduler] starting with ${restrictAsins.size}-asin restriction`);
  } else {
    restrictAsins = null;
    console.info('[scheduler] starting without restriction (all active products)');
  }
  // Fresh AbortController per run — once aborted, signals can't be
  // re-used, so the next start() needs a new one.
  cycleAbort = new AbortController();
  paused = false;
  running = true;
  softBlockStreak = 0;   // 監視開始でバックオフ連続カウンタをリセット。
  appLog.log('info', '監視を開始しました');
  runLoop();
}

function stop() {
  if (running) appLog.log('info', '監視を停止しました');
  running = false;
  paused = false;
  crawlActive = false;
  loopGen++;                  // 進行中の runLoop を無効化
  restrictAsins = null;
  nextCycleAt   = 0;
  currentRestMs = 0;
  blockedUntil  = 0;
  softBlockStreak = 0;
  // 停止中はフレッシュ判定を無効化 (= 全商品を評価対象に戻す)。
  cycleStartedAt = 0;
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  if (pauseWatchdog) { clearTimeout(pauseWatchdog); pauseWatchdog = null; }
  // Abort the in-flight fetch + any rate-limit sleep so 監視ストップ
  // halts work mid-batch instead of waiting for the current request to
  // finish. Null it so a stray re-stop doesn't crash on a used signal.
  if (cycleAbort) {
    cycleAbort.abort();
    cycleAbort = null;
  }
  // runLoop が再計算完了待ちで止まっていたら解放する (running=false なので即終了する)。
  if (_recalcDoneResolve) { _recalcDoneResolve(); _recalcDoneResolve = null; }
  console.info('[scheduler] stopped');
}

function getRestrictionCount() {
  return restrictAsins ? restrictAsins.size : null;
}

function isRunning() {
  return running;
}

// 現サイクルの開始時刻 (ms)。running 中のみ意味を持つ。0 = 未開始/停止中。
function getCycleStartedAt() {
  return cycleStartedAt;
}

// Returns null when the scheduler isn't resting — i.e. during an
// active cycle or when stopped. Otherwise returns the absolute
// timestamp the next cycle will start and the total rest duration
// so the UI can draw a proportionate countdown ring.
function getRestState() {
  if (!running || !nextCycleAt || nextCycleAt <= Date.now()) return null;
  return { nextCycleAt, restMs: currentRestMs };
}

module.exports = {
  start, stop, isRunning, setMainWindow, getRestState, getRestrictionCount, getCycleStartedAt,
  pauseForRecalc, resumeCrawl, notifyRecalcDone,
  resumeFromBlock, isBlocked, getBlockedUntil,
};
