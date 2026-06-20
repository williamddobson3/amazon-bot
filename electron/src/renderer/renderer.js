'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Init ────────────────────────────────────────────────────
//
// CRITICAL: set up all click/event handlers SYNCHRONOUSLY before any
// async call. If an async call (like refreshStatus → window.api.invoke)
// throws because the IPC bridge isn't ready yet, we must not let that
// prevent UI handlers from being registered — otherwise buttons render
// but are unclickable.

document.addEventListener('DOMContentLoaded', () => {
  // 1. Synchronous UI setup — always succeeds, no IPC needed.
  setupProductControls();
  setupDiscordControls();
  setupKeepaControls();
  // setupScrapeToggle removed — per spec the only crawl start button
  // is 監視スタート in the bulk toolbar (which sends the user's
  // ✅checked subset to startScraping). The header now just shows
  // status + item count.
  setupSessionControls();
  setupLoginGate();
  setupChartModal();
  setupHistoryModal();
  setupCrawlDiagnosticsModal();
  setupLogDock();
  setupNotifyPriceModals();

  window.addEventListener('resize', () => renderVisible());

  // 2. Async data loading — best-effort, errors don't break the UI.
  (async () => {
    // アプリのバージョンをヘッダーに表示 (client要望)。
    try {
      const v = await window.api.invoke('getVersion');
      const el = $('#header-version');
      if (el && v && v.version) el.textContent = `v${v.version}`;
    } catch (e) { console.warn('init version:', e); }
    try { await checkInitialLoginGate(); } catch (e) { console.warn('init loginGate:', e); }
    try { await refreshStatus(); }     catch (e) { console.warn('init refreshStatus:', e); }
    try { await loadFnmStateCache(); } catch (e) { console.warn('init fnmCache:', e); }
    // 監視グラフの期間設定を loadProducts より前に読み込む。loadProducts
    // → renderHeader が動く時点で sparklineDays が確定している必要がある。
    try { await loadSparklinePref(); } catch (e) { console.warn('init sparklinePref:', e); }
    // FBA利益額/ROE 列の平均期間 (項目7-2) — renderHeader 前に確定させる。
    try { await loadProfitPref(); } catch (e) { console.warn('init profitPref:', e); }
    // 列の並び順 (項目5) — 早めに当てて、保存済みの並びで初回描画する。
    try { await loadColumnOrderPref(); } catch (e) { console.warn('init columnOrderPref:', e); }
    // 「最小値ゼロ」設定 — 詳細グラフモーダル展開時に反映される。
    try { await loadChartMinZeroPref(); } catch (e) { console.warn('init chartMinZeroPref:', e); }
    // 並び替え設定 — loadProducts より前に当てておくと、初回描画時から
    // 保存された順序になる (一瞬登録順 → 並び替え順、のチラつきを防ぐ)。
    try { await loadSortPref(); }      catch (e) { console.warn('init sortPref:', e); }
    try { await loadProducts(); }      catch (e) { console.warn('init loadProducts:', e); }
    // 起動時に保存された FNM 条件 / 並び替えを 1 回だけ全件で確定して表示する。
    // recomputeFilterAndSortAndRender(true) が「条件合致探索 + 並び替え + 全件 stats
    // ロード + スピナー + 単一実行ガード」をまとめて行い、_statsFullyLoaded を立てる。
    // 起動時は監視クロール未開始 (アイドル) なのでここでの全件計算は問題なく、以降の
    // 周期完了は差分のみの高速更新になる (2026-06 client報告: スピナー出っぱなし対策)。
    try {
      await recomputeFilterAndSortAndRender(true);
    } catch (e) { console.warn('init recompute:', e); }
    try { await loadDiscord(); }       catch (e) { console.warn('init loadDiscord:', e); }
    try { await loadKeepaApiKey(); }   catch (e) { console.warn('init loadKeepaApiKey:', e); }
    // 直近 1 周期の所要時間バッジ — DB に履歴があれば起動直後に出す。
    // 周期完了イベントが来たら CYCLE_COMPLETE 経路で上書きされる。
    try { await loadLastCycleTimeBadge(); } catch (e) { console.warn('init lastCycle:', e); }
  })();

  setInterval(() => { refreshStatus().catch(() => {}); }, 5000);
  // Independent 1 s tick for the cycle-rest countdown — updates the
  // ring + label visually without hammering IPC. The absolute
  // `nextCycleAt` timestamp from refreshStatus is the source of truth;
  // in between polls we just recompute remaining locally.
  setInterval(() => { renderCycleTimer(); }, 1000);
});

// ── Push events from main process ───────────────────────────

window.api.onPriceUpdate((data) => {
  handleIncomingPriceUpdate(data.asin, data.data, data.updatedAt);
});

window.api.onCycleProgress((p) => {
  showCycleProgress(p);
});

window.api.onCycleComplete((c) => {
  hideCycleProgress();
  // クリーンな周期完了 = ブロックが解消した、ということ。ブロックモーダルが
  // 出ていれば閉じる (自動再開が成功したケースを拾う)。
  hideCaptchaModal();
  // 直近周期の所要時間バッジを更新 — c.elapsedSec は scheduler が
  // CYCLE_COMPLETE に積んでいる。最初の周期が完了するまでは非表示。
  if (c && typeof c.elapsedSec === 'number') {
    updateLastCycleTimeBadge(c.elapsedSec * 1000);
  }
  // ★ client要望 (2026-06, 案A): 周期完了後のアイドル時間に、DB に保存されている
  // 最新値で再計算 → スナップショットを作り直し → UI を更新する。
  //   ・pauseCrawl=false: scheduler は周期完了後、次周期を始めずに cycleRecalcDone を
  //     待って待機している (= クロールはアイドル)。よってここで pause/resume は不要で、
  //     再計算が終わったら cycleRecalcDone で次周期 (休止) を解放する。
  //   ・forceAll=true: reloadProductsFromDb が商品行を DB から読み直し、全件 stats を
  //     事前計算済みテーブルから取り直して「DB の最新値」でスナップショットを固める。
  //   ・quiet=false (client要望 2026-06): 周期完了の更新中も全画面スピナーを表示し、
  //     「数値を最新化中／少々お待ちを」と明示する。これによりインターバル中の一瞬の
  //     停止が「フリーズ」ではなく「更新処理」だとユーザーに伝わる。更新ボタンも
  //     再計算中はグレーになる (= 4契機共通の進行中インジケータ)。
  //   ・スクレイプ中 (周期内) は従来どおりスナップショットのまま固定。表示が動くのは
  //     この「周期完了のアイドル時」と「更新 / 監視ストップ」押下時のみ。
  // 再計算が _recalcRunning ガードでスキップされても finally で必ず cycleRecalcDone を
  // 送るので、scheduler が待機し続けて固まることはない。
  recomputeFilterAndSortAndRender(true, false, false)
    .catch((e) => console.warn('cycle-complete refresh:', e))
    .finally(() => { window.api.invoke('cycleRecalcDone').catch(() => {}); });
});

window.api.onCaptchaPause((p) => {
  showCaptchaModal(p);
});

window.api.onCaptchaResume(() => {
  hideCaptchaModal();
});

window.api.onCircuitBreaker((state) => {
  if (state && state.active) {
    showCircuitBanner(state);
  } else {
    hideCircuitBanner();
  }
});

// Main process pushes this when sign-in completes inside the login
// window. One-way: we only react to loggedIn=true. A sign-out later
// in the session doesn't re-show the gate.
window.api.onLoginState((state) => {
  if (state && state.loggedIn) {
    hideLoginGate();
    updateLoginButton(true);
  }
});

// ── Status ──────────────────────────────────────────────────

async function refreshStatus() {
  const status = await window.api.invoke('getStatus');
  if (!status) return;
  // 現サイクル開始時刻を同期 (フィルタ実行のフレッシュ判定に使う)。停止中は 0。
  crawlCycleStartedAt = (status.running && status.cycleStartedAt > 0) ? status.cycleStartedAt : 0;

  const dot  = $('#status-indicator');
  const text = $('#status-text');
  const cnt  = $('#product-count');

  if (status.running) {
    dot.className  = 'status-dot online';
    if (status.paused) {
      text.textContent = 'Paused (CAPTCHA)';
    } else if (status.circuitBreaker && status.circuitBreaker.active) {
      text.textContent = 'Running (reduced)';
    } else {
      text.textContent = `Running${status.restrictionCount != null ? ` (${status.restrictionCount} 件)` : ''}`;
    }
  } else {
    dot.className  = 'status-dot offline';
    text.textContent = 'Stopped';
  }
  cnt.textContent = `${status.productCount} items`;

  // The bulk toolbar swaps between the 4-button action set and a
  // single 監視ストップ button depending on whether the scheduler is
  // running. Re-render whenever status changes so a 監視スタート →
  // running transition (or remote stop) updates the UI immediately.
  if (lastKnownRunning !== status.running) {
    const justStopped = lastKnownRunning === true && status.running === false;
    lastKnownRunning = status.running;
    renderBulkToolbar();
    // ★ クロール停止時、凍結中だった表示を「更新」ボタン相当で1回だけ最新化する
    // (client報告: クロール中は v1.0.17 でライブ再描画を止めて静止スナップショット
    // にしているため、停止後も再描画トリガが無く古い値・古い並び順のまま残り、
    // 再起動して初めて最新値に変わる、という現象が起きていた。停止＝データ確定なので、
    // ここで全候補の stats を取り直して 絞り込み + 並び替え + 描画を最新化する。
    // 値と並び順を同時に更新するので整合する。crawlCycleStartedAt は上で 0)。
    if (justStopped) {
      recomputeFilterAndSortAndRender().catch((e) => console.warn('post-stop refresh:', e));
    }
  }

  // Reconcile circuit banner with latest persistent state (handles reload).
  if (status.circuitBreaker && status.circuitBreaker.active) {
    showCircuitBanner(status.circuitBreaker);
  } else {
    hideCircuitBanner();
  }

  // ソフトボット・ブロック状態をモーダルへ反映 (2026-06 client要望で改定)。
  // モーダルを出すのは「自動再開までのカウントダウン中」(blockedUntil が未来) だけ。
  // 再開フェーズに入る (blockedUntil=0) と、クロールはバックグラウンドで普通に
  // 回るので、モーダルは閉じて通常の監視画面 (アプリリスト) に戻す。停止中も閉じる。
  // → 「再開中…のまま固まって見える」状態を作らない。
  if (status.running && status.blockedUntil && status.blockedUntil > Date.now()) {
    captchaModalUntil = status.blockedUntil;   // カウントダウンを正に同期
    if (!captchaModalShown) showCaptchaModal({ until: status.blockedUntil });
  } else {
    hideCaptchaModal();
  }

  // Cache rest-period info for the 1-second countdown ticker.
  if (status.running && !status.paused && status.nextCycleAt > 0 && status.currentRestMs > 0) {
    cachedRest = { nextCycleAt: status.nextCycleAt, totalMs: status.currentRestMs };
  } else {
    cachedRest = null;
  }
  renderCycleTimer();
}

// ── Cycle-rest countdown ───────────────────────────────────
//
// Populated by refreshStatus every 5 s; decremented visually every 1 s.
// No IPC cost per tick — we just recompute `remaining` from the last-
// known absolute `nextCycleAt` timestamp.

let cachedRest = null;
let lastKnownRunning = null;   // tracked so renderBulkToolbar swaps on transition
// 現サイクル開始時刻 (ms)。getStatus から refreshStatus で同期。> 0 ならクロール
// 実行中で、フィルタ実行時は「今サイクルで再取得済み (last_observed_at >= これ)」
// の商品だけを評価する (項目6: 未再取得商品の古いデータ誤ヒット防止)。0 = 停止中。
let crawlCycleStartedAt = 0;

function renderCycleTimer() {
  const timer = $('#cycle-timer');
  if (!timer) return;
  if (!cachedRest) { timer.classList.add('hidden'); return; }

  const remaining = cachedRest.nextCycleAt - Date.now();
  if (remaining <= 0) { timer.classList.add('hidden'); return; }

  // Fill drains clockwise: full ring at start (dashoffset 0) → empty
  // at end (dashoffset 100). Matches the "how much time is left"
  // reading convention for circular countdowns.
  const elapsed = cachedRest.totalMs - remaining;
  const progress = Math.min(1, Math.max(0, elapsed / cachedRest.totalMs));
  const fg = timer.querySelector('.cycle-timer-fg');
  if (fg) fg.style.strokeDashoffset = String(progress * 100);

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const text = $('#cycle-timer-text');
  if (text) text.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  timer.classList.remove('hidden');
}

// setupScrapeToggle removed — header has no Start/Stop button per spec.

// ── Product management (tabular viewer) ────────────────────
//
// 21-column tabular viewer per client spec, matching ビューアー sheet
// in the spec-diagram xlsx. Rows are virtualized — only visible
// `<tr>` elements are kept in the DOM. Stats (5 moving averages +
// other-sellers diff) are fetched lazily for visible rows.

const ROW_HEIGHT = 72;          // per-row pixel height — must match CSS
const SCROLL_BUFFER = 6;

let allProducts = [];
let filtered = [];
let productIndex = new Map();
const visibleRows = new Map();   // asin → <tr> currently in DOM
const statsCache  = new Map();   // asin → { latestEffective, avg{N}d, ... }
const dirtyAsins = new Set();
let flushScheduled = false;
// FNM 評価キャッシュの再読込タイミング (2026-06 fix)。クロール中の通知判定が
// 常に最新の保存条件を使うよう、flushDirty 内で一定間隔ごとに再読込する。
// これにより、フィルタ条件を編集したら（アプリ再起動なしで）すぐ反映され、
// 古い条件のまま誤通知が飛び続ける事故を防ぐ。
let lastFnmCacheReload = 0;
const FNM_CACHE_TTL_MS = 10_000;   // 10 秒
let currentSearch = '';

// 並び替え状態 (2026-05) — `currentSort` が '' の時はソートしない
// (DB の返却順 = 登録順)。`currentSortDir` は 'asc' / 'desc'。
// drop_* 系のソートは statsCache に依存するため、選択時に
// ensureStatsForSort() が走って全候補の stats を一括取得する。
let currentSort    = '';
let currentSortDir = 'desc';

// View mode + filters
let viewMode = 'active';        // 'active' | 'trash'
let groupFilter = '';            // '' = all, '0' = ungrouped, '<id>' = specific group
const selected = new Set();      // asins with checkbox ticked

// Cached groups list for the selector + modal.
let cachedGroups = [];

function setupProductControls() {
  $('#btn-add').addEventListener('click', onAddClick);
  setupCsvImportModal();
  $('#product-search').addEventListener('input', async () => {
    currentSearch = $('#product-search').value.toLowerCase();
    await applyFilter();
    $('#product-list').scrollTop = 0;
    renderVisible();
  });

  // 並び替えセレクタ — 変更時に永続化 + performUserSort を 1 回呼ぶ。
  // 「並び替えなし」を選んだ場合は方向ボタンを disabled にし、選択中の
  // キーに合わせて「新しい順 / 多い順 / 大きい順」のラベルを切り替える。
  // performUserSort は、スクレイプ中は「凍結スナップショットを並べ替えるだけ」
  // (値そのまま・DB アクセスなし・スピナーなし)、停止中は確定評価 (stats 最新化 +
  // スピナー) に分岐する (client spec: スクレイプ中は値を変えず順序のみ)。
  $('#sort-selector').addEventListener('change', async (e) => {
    currentSort = e.target.value || '';
    updateSortDirButton();
    saveSortPref();
    await performUserSort();
  });

  // 方向ボタン — desc/asc トグル。並び替えなし時は disabled。
  // 方向は2ボタン (▲=昇順/低い順, ▼=降順/高い順)。トグルではなく、押した方の方向を
  // 直接選択する。★ 同じ方向でも毎回再ソートする (2026-06 fix): 値が更新された後に
  // 押し直して並び順を最新化できるようにするため。以前は「既にその方向なら no-op」に
  // していたため、表示値が変わっても並び順が古いまま直せなかった。
  const setSortDir = async (dir) => {
    if (!currentSort) return;     // キー未選択時は何もしない (ボタンは disabled)
    currentSortDir = dir;
    updateSortDirButton();
    saveSortPref();
    await performUserSort();
  };
  $('#sort-dir-desc').addEventListener('click', () => setSortDir('desc'));
  $('#sort-dir-asc').addEventListener('click', () => setSortDir('asc'));

  // 列配置初期化 — restore the default column order (項目5).
  { const rc = $('#btn-reset-columns'); if (rc) rc.addEventListener('click', resetColumnOrder); }

  // ASIN-add modal trigger.
  $('#btn-asin-add').addEventListener('click', () => {
    $('#asin-input').value = '';
    $('#add-status').classList.add('hidden');
    $('#asin-add-modal').classList.remove('hidden');
    $('#asin-input').focus();
  });
  $('#asin-add-close').addEventListener('click', () => {
    $('#asin-add-modal').classList.add('hidden');
  });
  $('#asin-add-modal').addEventListener('click', (e) => {
    if (e.target.id === 'asin-add-modal') $('#asin-add-modal').classList.add('hidden');
  });

  // フィルタ・通知・メンテナンス設定 modal trigger.
  $('#btn-fnm-settings').addEventListener('click', openFnmModal);
  $('#fnm-close').addEventListener('click', closeFnmModal);
  $('#fnm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'fnm-modal') closeFnmModal();
  });
  // Tab switching removed — only the filter pane exists now. Each
  // custom-filter slot carries its own 通知 / 自動ゴミ捨て toggles, so
  // 自動メンテナンス & 通知設定 tabs are no longer needed.
  $('#fnm-save').addEventListener('click', saveFnmConditions);
  // ヘッダー右上にも同じ「条件を保存」ボタンを配置 (client request)。同一処理。
  { const hs = $('#fnm-save-header'); if (hs) hs.addEventListener('click', saveFnmConditions); }

  // v2 action bar — top-of-pane buttons.
  $('#fnm-select-all')   ?.addEventListener('click', () => fnmSelectAll(true));
  $('#fnm-deselect-all') ?.addEventListener('click', () => fnmSelectAll(false));
  $('#fnm-apply')        ?.addEventListener('click', fnmExecute);
  $('#fnm-reset')        ?.addEventListener('click', fnmReset);

  // v2 slot actions (custom + preset). Delegated because slot DOM is
  // re-rendered on every tab switch / save / apply.
  document.addEventListener('click', (e) => {
    const cs = e.target.closest('[data-fnm-custom-save]');
    if (cs) { onCustomSave(parseInt(cs.dataset.fnmCustomSave, 10)); return; }
    const ca = e.target.closest('[data-fnm-custom-apply]');
    if (ca) { onCustomApply(parseInt(ca.dataset.fnmCustomApply, 10)); return; }
    const pa = e.target.closest('[data-fnm-preset-apply]');
    if (pa) { onPresetApply(parseInt(pa.dataset.fnmPresetApply, 10)); return; }
  });
  // Per-slot toggles for 通知 / 自動ゴミ捨て (custom only). The toggles
  // appear in the slot template after the slot has been saved at
  // least once. Changes persist immediately so the next price-update
  // cycle picks them up without requiring 条件を保存.
  document.addEventListener('change', (e) => {
    const tn = e.target.closest('[data-fnm-custom-notif]');
    if (tn) { onCustomToggle(parseInt(tn.dataset.fnmCustomNotif, 10), 'notif', tn.checked); return; }
    const tt = e.target.closest('[data-fnm-custom-trash]');
    if (tt) { onCustomToggle(parseInt(tt.dataset.fnmCustomTrash, 10), 'trash', tt.checked); return; }
  });

  // Group selector — refetch when changed.
  $('#group-selector').addEventListener('change', async (e) => {
    groupFilter = e.target.value;
    await loadProducts();
  });
  $('#btn-manage-groups').addEventListener('click', openGroupModal);

  // 「並び替えやフィルタ設定で最新状態に更新」ボタン (2026-05) —
  // ユーザーが明示的に押したときだけ、フィルタ条件合致探索と並び替えの
  // 凍結スナップショットを最新の statsCache / 監視データで作り直す。
  // クロール中に裏で勝手に走る再評価を完全に停止しているため、結果が
  // 古くなったと感じたらここを押す導線。
  const refreshBtn = $('#btn-refresh-filter-sort');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      // 「更新」: recomputeFilterAndSortAndRender(pauseCrawl=true) がクロールの
      // 一時停止 → 再計算 (スピナー) → 再開 まで面倒を見る (client要望)。
      await recomputeFilterAndSortAndRender();
    });
  }

  // Trash toggle — flips view mode and reloads. The FNM-settings
  // button's label tracks the active context so the user knows
  // which set of rules they'll be editing.
  $('#btn-toggle-trash').addEventListener('click', async () => {
    viewMode = viewMode === 'active' ? 'trash' : 'active';
    $('#btn-toggle-trash').classList.toggle('active', viewMode === 'trash');
    $('#btn-toggle-trash-label').textContent =
      viewMode === 'trash' ? '監視リストに戻る' : 'ゴミ箱商品閲覧';
    const fnmBtn = $('#btn-fnm-settings');
    if (fnmBtn) {
      fnmBtn.textContent = viewMode === 'trash'
        ? 'ゴミ箱用フィルタ・通知・メンテナンス設定'
        : 'フィルタ・通知・メンテナンス設定';
    }
    selected.clear();
    renderHeader();
    // active ⇔ trash で FNM 評価対象集団が変わるため snapshot を作り直す。
    filterAsinSnapshot = null;
    await loadProducts();
    await recomputeFilterAndSortAndRender();
  });

  // Bulk toolbar — clear-selection button.
  $('#bulk-clear').addEventListener('click', () => {
    selected.clear();
    renderBulkToolbar();
    for (const tr of visibleRows.values()) {
      const inner = tr.querySelector('input[data-bulk]');
      if (inner) inner.checked = false;
      tr.classList.remove('row-selected');
    }
    const headBtn = $('#viewer-header-checkbox');
    if (headBtn) headBtn.classList.remove('active');
  });

  const container = $('#product-list');
  container.addEventListener('click', onListClick);
  container.addEventListener('change', onListChange);
  container.addEventListener('scroll', renderVisible, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => renderVisible()).observe(container);
  }

  // Group modal handlers (v2: bulk rename).
  $('#group-modal-close').addEventListener('click', closeGroupModal);
  $('#group-modal').addEventListener('click', (e) => {
    if (e.target.id === 'group-modal') closeGroupModal();
  });
  $('#group-save-all') ?.addEventListener('click', onSaveAllGroupNames);

  // Row-level group picker (登録 / 変更 buttons in the グループ column).
  $('#row-group-close') ?.addEventListener('click', closeRowGroupModal);
  $('#row-group-modal') ?.addEventListener('click', (e) => {
    if (e.target.id === 'row-group-modal') closeRowGroupModal();
  });
  $('#row-group-list') ?.addEventListener('click', onRowGroupPick);
}

async function onAddClick() {
  const raw = $('#asin-input').value;
  const asins = raw.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (asins.length === 0) return;

  const btn = $('#btn-add');
  btn.disabled = true;
  try {
    const result = await window.api.invoke('addProducts', { asins });
    $('#asin-input').value = '';
    showAddStatus(`${result.added} added (${result.total} submitted)`, 'success');
    await loadProducts();
    await refreshStatus();
    // Close the modal after a short delay so the user sees the success line.
    setTimeout(() => $('#asin-add-modal').classList.add('hidden'), 800);
  } catch (err) {
    showAddStatus(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── CSV import — 監視対象のASINの追加インポート ────────────
//
// Spec rules (see client image):
//   1. Find the column whose row 1 contains "ASIN" (case-insensitive).
//   2. Read that column from row 2 to the last row.
//   3. Skip blank rows; read until the actual last non-blank row.
//   4. Within the CSV, dedupe — keep the first occurrence only.
//   5. ASINs already present in the viewer are silently skipped.
//   6. Preserve CSV order in the viewer (handled by addProducts on the
//      backend via incrementing added_at).

let csvImportFile = null;        // currently-picked File or null

function setupCsvImportModal() {
  $('#btn-csv-import').addEventListener('click', openCsvImportModal);
  $('#csv-import-close').addEventListener('click', closeCsvImportModal);
  $('#csv-import-modal').addEventListener('click', (e) => {
    if (e.target.id === 'csv-import-modal') closeCsvImportModal();
  });
  $('#csv-file-input').addEventListener('change', onCsvFilePick);
  $('#btn-csv-run').addEventListener('click', runCsvImport);
}

function openCsvImportModal() {
  csvImportFile = null;
  $('#csv-file-input').value = '';
  $('#csv-file-name').textContent = '選択されていません';
  $('#btn-csv-run').disabled = true;
  $('#csv-import-status').classList.add('hidden');
  $('#csv-import-modal').classList.remove('hidden');
}

function closeCsvImportModal() {
  $('#csv-import-modal').classList.add('hidden');
  csvImportFile = null;
}

function onCsvFilePick(e) {
  const file = e.target.files[0];
  if (!file) {
    csvImportFile = null;
    $('#csv-file-name').textContent = '選択されていません';
    $('#btn-csv-run').disabled = true;
    return;
  }
  csvImportFile = file;
  $('#csv-file-name').textContent = file.name;
  $('#btn-csv-run').disabled = false;
  $('#csv-import-status').classList.add('hidden');
}

// Keepa CSV の列名→パラメータ名マップ。main から一度だけ取得しキャッシュ。
let keepaColumnMapCache = null;
async function getKeepaColumnMap() {
  if (keepaColumnMapCache) return keepaColumnMapCache;
  try {
    keepaColumnMapCache = (await window.api.invoke('getKeepaColumnMap')) || {};
  } catch {
    keepaColumnMapCache = {};
  }
  return keepaColumnMapCache;
}

async function runCsvImport() {
  if (!csvImportFile) return;
  const btn = $('#btn-csv-run');
  btn.disabled = true;

  let records, mappedColumns;
  try {
    const text = await csvImportFile.text();
    const rows = parseCsv(text);
    const columnMap = await getKeepaColumnMap();
    const extracted = extractKeepaRecordsFromCsvRows(rows, columnMap);
    records = extracted.records;
    mappedColumns = extracted.mappedColumns;
  } catch (err) {
    showCsvStatus(`読み込みに失敗しました: ${err.message}`, 'error');
    btn.disabled = false;
    return;
  }

  if (records.length === 0) {
    showCsvStatus('「ASIN」列が見つからない、または有効なASINがありません', 'error');
    btn.disabled = false;
    return;
  }

  let result;
  let msg;
  if (mappedColumns > 0) {
    // Keepa エクスポート — ASIN 以外の列も取り込み、手数料等を計算して保存。
    // 既存 ASIN は最新のインポート値で更新される (= 上書き)。
    result = await window.api.invoke('importProductsWithKeepaData', { rows: records });
    const added   = result?.added || 0;
    const updated = (result?.total ?? records.length) - added;
    msg = `${added} 件を新規追加`
        + (updated > 0 ? `、${updated} 件を更新` : '')
        + `（${mappedColumns} 列のインポートデータを取り込み）`;
  } else {
    // 通常の ASIN だけの CSV — 従来どおり追加のみ。
    const existing = new Set(allProducts.map((p) => p.asin));
    const toAdd = records.map((r) => r.asin).filter((a) => !existing.has(a));
    result = await window.api.invoke('addProducts', { asins: toAdd });
    const added = result?.added || 0;
    const skipped = records.length - added;
    msg = `${added} 件追加しました`
        + (skipped > 0 ? ` (重複/既存 ${skipped} 件は無視)` : '');
  }
  showCsvStatus(msg, 'success');

  await loadProducts();
  await refreshStatus();

  setTimeout(() => closeCsvImportModal(), 1600);
  btn.disabled = false;
}

function showCsvStatus(text, type) {
  const el = $('#csv-import-status');
  el.textContent = text;
  el.className = `asin-status ${type}`;
  el.classList.remove('hidden');
}

// Minimal CSV/TSV parser. Handles quoted fields with embedded delimiters
// and escaped double-quotes (RFC-4180). Returns rows[col]; trailing
// blank lines are kept (caller can ignore them).
//
// 区切り文字は自動判定する: Keepa / Excel のエクスポートはロケールや設定で
// **タブ・セミコロン・カンマ**のいずれもあり得る。日本語 Keepa の標準は
// タブ区切りだが、フィールド内 (バリエーションASIN のカンマ連結や「1,936」
// の桁区切り、画像URLのセミコロン連結) に区切り候補文字を含むため、
// 区切りを固定すると全列が崩れる。そこで **ヘッダー行(列名のみで区切り
// 候補文字を含まない)** での出現数が最も多い文字を区切りとみなす。
// 先頭の BOM(﻿) も除去する (UTF-8 BOM 付きで保存された場合の対策)。
function parseCsv(text) {
  const rows = [];
  const norm = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const nl = norm.indexOf('\n');
  const firstLine = nl >= 0 ? norm.slice(0, nl) : norm;
  const counts = {
    '\t': (firstLine.match(/\t/g) || []).length,
    ';':  (firstLine.match(/;/g)  || []).length,
    ',':  (firstLine.match(/,/g)  || []).length,
  };
  // 最多の区切り候補を採用 (同数時は タブ > セミコロン > カンマ の優先)。
  // どれも 0 なら 1 列のみ(=ASIN だけのリスト等) としてカンマ扱い。
  let delim = ',', best = 0;
  for (const d of ['\t', ';', ',']) { if (counts[d] > best) { best = counts[d]; delim = d; } }
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (inQ) {
      if (ch === '"') {
        if (norm[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else { cur += ch; }
    }
  }
  // Tail row (file might or might not end with newline).
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

// Find the column whose row 1 cell == "ASIN" (case-insensitive,
// trimmed), then walk that column from row 2 to the last row,
// keeping only valid 10-char alphanum ASINs. Dedupes within the CSV
// by keeping the first occurrence. Blank rows are skipped silently.
function extractAsinsFromCsvRows(rows) {
  if (!rows || rows.length === 0) return [];
  const header = rows[0] || [];
  const colIdx = header.findIndex(
    (cell) => String(cell || '').trim().toUpperCase() === 'ASIN'
  );
  if (colIdx < 0) return [];

  const seen = new Set();
  const out  = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = String((rows[r] || [])[colIdx] || '').trim().toUpperCase();
    if (!cell) continue;
    if (!/^[A-Z0-9]{10}$/.test(cell)) continue;
    if (seen.has(cell)) continue;       // dedupe within CSV
    seen.add(cell);
    out.push(cell);
  }
  return out;
}

// Keepa エクスポート CSV から、ASIN ごとに「パラメータ名→セル値」マップを
// 抽出する (2026-06 spec 項目7)。columnMap は main の KEEPA_CSV_COLUMN_MAP
// (日本語列名 → パラメータ名)。ヘッダーの空白ゆれに強くするため、列名は
// 連続空白を 1 つに畳んで照合する。
//
// 戻り値:
//   records       [{ asin, params: { paramName: cellValue, ... } }, ...]
//   mappedColumns ヘッダー中でマップに一致した列数 (0 = ただの ASIN リスト)
function extractKeepaRecordsFromCsvRows(rows, columnMap) {
  const empty = { records: [], mappedColumns: 0 };
  if (!rows || rows.length === 0) return empty;
  const header = rows[0] || [];
  // 列名照合用の正規化: BOM 除去 + NFKC (全角→半角: 「紹介料％」の全角％、
  // 全角スペース、全角英字 等を吸収) + 連続空白畳み + トリム。これにより
  // ロケールや手編集による列名の表記ゆれに強くなる。
  const norm = (s) => String(s == null ? '' : s)
    .replace(/﻿/g, '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  // 正規化したマップ (列名の前後/連続空白を吸収)。
  const normMap = {};
  for (const k of Object.keys(columnMap || {})) normMap[norm(k)] = columnMap[k];

  const asinIdx = header.findIndex((c) => norm(c).toUpperCase() === 'ASIN');
  if (asinIdx < 0) return empty;

  // 各ヘッダー列 → パラメータ名 (無ければ null)。
  const colParam = header.map((cell) => normMap[norm(cell)] || null);
  const mappedColumns = colParam.filter(Boolean).length;

  const seen = new Set();
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const asin = String(row[asinIdx] || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    if (seen.has(asin)) continue;       // CSV 内重複は先勝ち
    seen.add(asin);
    const params = {};
    for (let c = 0; c < colParam.length; c++) {
      if (colParam[c]) params[colParam[c]] = row[c] != null ? row[c] : '';
    }
    records.push({ asin, params });
  }
  return { records, mappedColumns };
}

function showAddStatus(text, type) {
  const el = $('#add-status');
  el.textContent = text;
  el.className = `asin-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

async function loadProducts() {
  let result;
  if (viewMode === 'trash') {
    result = await window.api.invoke('getTrashedProducts');
  } else {
    const opts = {};
    if (groupFilter !== '') opts.groupId = groupFilter === '0' ? 0 : Number(groupFilter);
    result = await window.api.invoke('getProducts', opts);
  }
  if (!Array.isArray(result)) result = [];
  allProducts = result;
  productIndex = new Map();
  for (let i = 0; i < allProducts.length; i++) {
    productIndex.set(allProducts[i].asin, i);
  }
  statsCache.clear();
  _statsFullyLoaded = false;   // キャッシュを捨てたので次回は全件ロードが必要
  await refreshGroups();
  renderHeader();
  await applyFilter();
  // グループ切替・インポート等でリストを作り直したときも、クロール中なら
  // 「今この瞬間」の値で凍結してから描画する (client要望 C)。
  await captureViewSnapshot();
  renderVisible();
  renderBulkToolbar();
}

// DB から商品行を読み直して allProducts/productIndex/statsCache を最新化する軽量版
// (loadProducts からグループ/ヘッダ再描画・スナップショット作成・描画を除いたもの)。
// ★ 確定評価 (更新 / 監視ストップ / 起動 / フィルタ実行) の冒頭で呼び、スナップショットを
// 「DB に保存されている最新値」で作る (client spec)。これで Keepa 定期更新で DB の列
// (ランキング/出品数/180日BuyBox→平均) だけが変わっていても最新化され、各列と FBA利益額/
// ROE が必ず整合する (旧: メモリ上の古いインポート列のまま再計算 → 停止前後で食い違い)。
async function reloadProductsFromDb() {
  let result;
  if (viewMode === 'trash') {
    result = await window.api.invoke('getTrashedProducts');
  } else {
    const opts = {};
    if (groupFilter !== '') opts.groupId = groupFilter === '0' ? 0 : Number(groupFilter);
    result = await window.api.invoke('getProducts', opts);
  }
  if (!Array.isArray(result)) result = [];
  allProducts = result;
  productIndex = new Map();
  for (let i = 0; i < allProducts.length; i++) productIndex.set(allProducts[i].asin, i);
  statsCache.clear();
  _statsFullyLoaded = false;   // キャッシュを捨てたので全件ロードが必要
}

async function refreshGroups() {
  // Backfill: guarantees the groups table has 20 stable slots so the
  // dropdown / rename modal / per-row picker can index by slot # safely.
  try { await window.api.invoke('ensureGroupSlots', { count: 20 }); }
  catch { /* non-fatal — fall back to whatever exists */ }
  try {
    cachedGroups = await window.api.invoke('getGroups');
    if (!Array.isArray(cachedGroups)) cachedGroups = [];
  } catch { cachedGroups = []; }

  // Per v3 spec: dropdown lists すべて(N), 登録なし(N), then exactly 20
  // group slots labeled "No.X 名前(count)" (or "No.X(count)" if no name
  // assigned to that slot). Slot index is derived from the cached
  // groups order (insertion order = id ascending), NOT the stored name.
  const sel = $('#group-selector');
  if (!sel) return;
  const cur = sel.value;

  let totalAll = allProducts.length;
  try {
    const stats = await window.api.invoke('getProductCount');
    if (typeof stats === 'number') totalAll = stats;
  } catch { /* keep fallback */ }
  const groupedCount = cachedGroups.reduce((s, g) => s + (g.member_count || 0), 0);
  const unassigned   = Math.max(0, totalAll - groupedCount);

  const slots = cachedGroups.slice(0, 20).map((g, i) => {
    const slotNo = i + 1;
    const name   = (g.name || '').trim();
    const count  = g.member_count || 0;
    const label  = name
      ? `No.${slotNo} ${escapeHtml(name)}(${count})`
      : `No.${slotNo}(${count})`;
    return `<option value="${g.id}">${label}</option>`;
  }).join('');

  sel.innerHTML = `
    <option value="">すべて(${totalAll})</option>
    <option value="0">登録なし(${unassigned})</option>
    ${slots}
  `;
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// True when the filter has at least one condition that requires
// per-product stats — 実質BuyBox価格の下落率 (全 dropRate 行) と
// 出品者数の N日平均 (mpCount d7/d30/d90/d180)。「現在の出品者数」は
// product.last_mp_count を直接見るので stats 不要 = ここでは数えない。
function filterNeedsStats(state) {
  if (!state) return false;
  if (state.dropRate) {
    for (const k of ['instant', 'd1', 'd7', 'd30', 'd90', 'd180', 'd7m180']) {
      if (state.dropRate[k] && state.dropRate[k].enabled) return true;
    }
  }
  // 全出品数(内訳) mpCount は項目17 で撤去 — stats 起動条件にも数えない。
  // 範囲フィルタの avgEff* (1日〜180日平均実質BuyBox価格) も stats 必須。
  if (rangesNeedStats(state)) return true;
  return false;
}

// stats 依存フィルタを評価する直前に、対象商品全件分の stats を
// バッチ IPC でまとめて取得し statsCache を埋める。
//
// これが無いと passesAllConditions が「画面に表示済みの行だけ遅延
// ロードされた不完全な statsCache」を参照してしまい、stats 未取得の
// 商品が一律 false 扱い → 「スクロール位置や監視サイクルのタイミング
// 次第でヒット商品がころころ増減する」非決定的バグになる (2026-05 fix)。
// 全候補の stats を先に揃えることでフィルタ結果を確定的にする。
// 大量の ASIN の stats をチャンク分割で取得する (2026-06, client報告: 監視
// インターバル中／停止後／周期完了時の「更新」でアプリがフリーズ=応答なしに
// なる対策)。1 万件超を 1 回の IPC で取ると main プロセスが数十秒間 同期 DB
// クエリでブロックされ、その間 OS から「応答なし」と判定される。~200 件ずつに
// 分け、各チャンクの後に main のイベントループを 1 周回す猶予を入れることで、
// 合計時間は同程度でも main が長時間固まらず、応答なしにならない。
const STATS_FETCH_CHUNK = 200;
async function fetchStatsInChunks(asins) {
  for (let i = 0; i < asins.length; i += STATS_FETCH_CHUNK) {
    const chunk = asins.slice(i, i + STATS_FETCH_CHUNK);
    try {
      // 事前計算済み統計の高速経路を読む (2026-06): 全件 ~190 万行を都度走査
      // する代わりに product_stats 表を読むだけ (~1 秒)。値は従来と同一。
      const batch = await window.api.invoke('getProductStatsBatchTable', { asins: chunk });
      if (batch && typeof batch === 'object') {
        for (const a of chunk) statsCache.set(a, batch[a] || {});
      }
    } catch { /* このチャンクは据え置き — 取得済み分はそのまま使う */ }
    // 次チャンク前に main / renderer のイベントループへ制御を返す (応答なし防止)。
    if (i + STATS_FETCH_CHUNK < asins.length) await new Promise((r) => setTimeout(r, 0));
  }
}

async function ensureStatsLoaded(products, state, force = false) {
  if (!filterNeedsStats(state)) return;
  const missing = [];
  for (const p of products) {
    // `null` は fetchStatsFor が立てる in-flight プレースホルダ。
    // 未取得と同義なので再取得対象に含める。
    // force=true (フィルタ実行 / 更新ボタンの「確定評価」) のときは、
    // statsCache に「存在するが古い」値が残っていても必ず最新を取り直す。
    // 監視クロール中はクロールで価格が動くたびに平均(stats)が変わるため、
    // 確定評価のタイミングで全候補を最新化しておかないと、古い平均で
    // 過大な下落率が出て条件を満たさない商品が誤ヒットする (client report 項目2)。
    if (force || statsCache.get(p.asin) == null) missing.push(p.asin);
  }
  if (missing.length === 0) return;
  // チャンク分割取得で main を長時間ブロックしない (応答なし防止)。IPC 失敗時は
  // 据え置き — passesAllConditions は未取得エントリを非マッチ扱い (= 安全側)。
  await fetchStatsInChunks(missing);
}

// ── 並び替え (2026-05) ─────────────────────────────────────────
//
// 各キーは「行 → 比較に使う数値」を返す抽出関数として表現する。
// 抽出関数が null/undefined/NaN を返した行は方向に関係なく必ず末尾に
// 寄せる (= 「値の無い行は最下行」)。これは「下落率を大きい順で並べた
// 時に、stats 未取得の商品が降順先頭に紛れ込む」事故を防ぐため。
//
// drop_* 系の式:
//   実質価格 (latestEffective) と参照値 (1個前の実質 or N日平均実質) を
//   使い、(参照 − latest) / 参照 * 100 を「下落率(%)」とする。
//   - 値が下がっていれば正、上がっていれば負。
//   - 「大きい順 (desc)」を選ぶと、最もお買い得な商品が先頭にくる。
const SORT_EXTRACTORS = {
  added_at:          (p) => p.added_at,
  last_observed_at:  (p) => p.last_observed_at,
  // 通知履歴 (2026-06 spec 項目29/30)。通知なし経過日数は last_notified_at から算出。
  notify_last:       (p) => p.last_notified_at,
  notify_count:      (p) => p.notify_hit_count,
  notify_gap:        (p) => (p.last_notified_at != null
                               ? Math.floor((Date.now() - p.last_notified_at) / 86_400_000) : null),
  price:             (p) => p.last_price,
  points:            (p) => p.last_points,
  shipping_fee:      (p) => p.last_shipping_fee,
  mp_price:          (p) => p.last_mp_price,
  mp_count:          (p) => p.last_mp_count,
  // 月間販売数 — 監視/取込のうち取得日時が新しい方 (pickMonthlySales、項目3。表示と一致)。
  monthly_sales:     (p) => pickMonthlySales(p),
  // ── Keepa インポート/計算列 (2026-06 spec 項目9) ──────────────────
  imp_sellers:           (p) => p.imp_sellers,
  imp_rank:              (p) => p.imp_rank,
  imp_rank_drop_30d:     (p) => p.imp_rank_drop_30d,
  size_kubun:            (p) => sizeKubunRank(p.size_kubun),
  amazon_fee:            (p) => p.amazon_fee,
  fba_fee:               (p) => p.fba_fee,
  inventory_storage_fee: (p) => p.inventory_storage_fee,
  // Ama本体価格 / Ama本体出品割合 (2026-06 spec 項目14/15/16)。割合は stats 依存。
  amazon_current:        (p) => p.imp_amazon_current,
  amazon_ratio:          (p, stats) => (stats ? stats.amazonListingRatio30d : null),
  // ── 利益指標 (2026-06 spec 項目7-2/7-3) — stats(avg30d/latestEff) 依存 ──
  // ★ stats を第2引数で受け取る (2026-06 fix): 並び替えの値は applySort が渡す
  // 「表示と同一ソース」(クロール中=凍結スナップショット / 停止中=ライブ) の stats
  // で計算する。statsCache を直接引くと、表示は凍結値・並び替えはライブ値、という
  // 食い違いになり「スクレイプ中に並び替えると順序がバラバラ」になっていた (真因)。
  profit_amt: (p, stats) => profitAmount(p, stats),
  profit_roe: (p, stats) => profitRoe(p, stats),
  drop_instant: (p, stats) => {
    if (!stats) return null;
    const latest = stats.latestEffective;
    const prev   = stats.prevEffective;
    if (latest == null || prev == null || prev === 0) return null;
    return ((prev - latest) / prev) * 100;
  },
  drop_1d:   (p, stats) => dropPctVsAvg(stats, 'avg1d'),
  drop_7d:   (p, stats) => dropPctVsAvg(stats, 'avg7d'),
  drop_30d:  (p, stats) => dropPctVsAvg(stats, 'avg30d'),
  drop_90d:  (p, stats) => dropPctVsAvg(stats, 'avg90d'),
  drop_180d: (p, stats) => dropPctVsAvg(stats, 'avg180d'),
};

// 下落率(%) = (N日平均実質 − 最新実質) / N日平均実質 × 100。
// stats は applySort が渡す「表示と同一ソース」の stats (クロール中=凍結 / 停止中=ライブ)。
function dropPctVsAvg(stats, avgKey) {
  if (!stats) return null;
  const latest = stats.latestEffective;
  const avg    = stats[avgKey];
  if (latest == null || avg == null || avg === 0) return null;
  return ((avg - latest) / avg) * 100;
}

// サイズ区分(文字列)を並び替え用の数値順位に変換する (2026-06 spec 項目9)。
// applySort は数値前提のため、区分名を 小型<標準<大型<特大型 の序列 + 番号
// にマップする。先頭に付く「クリックポスト,」「ネコポス,」は順位に影響させ
// ない。「不明」や空は null = 最下行。
function sizeKubunRank(s) {
  if (!s) return null;
  const str = String(s);
  if (str.indexOf('不明') >= 0) return null;
  const m = str.match(/(特大型|大型|標準|小型)(\d*)/);
  if (!m) return null;
  const base = { '小型': 100, '標準': 200, '大型': 300, '特大型': 400 }[m[1]];
  const n = m[2] ? parseInt(m[2], 10) : 0;
  return base + n;
}

// stats に依存するソートキーの集合 — applyFilter 内で
// ensureStatsForSort() を呼ぶかどうかの判定に使う。
const SORT_KEYS_NEED_STATS = new Set([
  'drop_instant', 'drop_1d', 'drop_7d', 'drop_30d', 'drop_90d', 'drop_180d',
  'profit_amt', 'profit_roe',
  // Ama本体出品割合 は getProductStats 由来 (項目15)。
  'amazon_ratio',
]);

// ── FBA利益額 / ROE利益率 の期間バリエーション (2026-06 spec 項目7/8) ──────
// 列ヘッダーで選択する期間 (profitDays) とは独立に、フィルタ設定と列並び替えで
// 「瞬間 / 1日 / 7日 / 30日 / 90日 / 180日」をそれぞれ個別に選べるようにする。
//   sfx : sort キーのサフィックス (profit_amt_<sfx> / profit_roe_<sfx>)
//   fA/fR: フィルタ (RANGE_ROWS) キー名 (state.ranges のキー)
//   days: profitAmountForDays に渡す期間 (0 = 瞬間)
//   label: UI ラベル
const PROFIT_PERIODS = [
  { sfx: 'instant', days: 0,   fA: 'profitAmtInstant', fR: 'profitRoeInstant', label: '瞬間'     },
  { sfx: '1d',      days: 1,   fA: 'profitAmt1d',      fR: 'profitRoe1d',      label: '1日平均'  },
  { sfx: '7d',      days: 7,   fA: 'profitAmt7d',      fR: 'profitRoe7d',      label: '7日平均'  },
  { sfx: '30d',     days: 30,  fA: 'profitAmt30d',     fR: 'profitRoe30d',     label: '30日平均' },
  { sfx: '90d',     days: 90,  fA: 'profitAmt90d',     fR: 'profitRoe90d',     label: '90日平均' },
  { sfx: '180d',    days: 180, fA: 'profitAmt180d',    fR: 'profitRoe180d',    label: '180日平均' },
];
// 期間別キーの登録は SORT_DIR_LABELS の定義より後で行う (下記参照) — const の
// 一時的デッドゾーンを避けるため、ここでは PROFIT_PERIODS の定義のみ。

// 並び替えキーごとの「降順 / 昇順」の日本語ラベル。日時は新しい/古い、
// 件数系は多い/少ない、それ以外 (価格・%等) は大きい/小さい。
const SORT_DIR_LABELS = {
  added_at:         { desc: '新しい順', asc: '古い順' },
  last_observed_at: { desc: '新しい順', asc: '古い順' },
  // 通知履歴 (項目29/30)。経過日数は「長い順=久しく通知なし」。
  notify_last:      { desc: '新しい順', asc: '古い順' },
  notify_count:     { desc: '多い順',   asc: '少ない順' },
  notify_gap:       { desc: '長い順',   asc: '短い順' },
  mp_count:         { desc: '多い順',   asc: '少ない順' },
  monthly_sales:    { desc: '多い順',   asc: '少ない順' },
  // 利益指標 (2026-06 spec 項目7) — 利益額/利益率は大きいほど良い。
  profit_amt:        { desc: '高い順',   asc: '低い順' },
  profit_roe:        { desc: '高い順',   asc: '低い順' },
  // Keepa インポート/計算列 (2026-06 spec 項目9)
  imp_sellers:       { desc: '多い順',   asc: '少ない順' },
  imp_rank:          { desc: '下位順',   asc: '上位順' },   // ランキングは小さいほど上位
  imp_rank_drop_30d: { desc: '多い順',   asc: '少ない順' },
  size_kubun:        { desc: '大きい順', asc: '小さい順' },
  // Ama本体価格 / Ama本体出品割合 (項目14/15/16)。割合は高いほど Amazon本体が多く出品。
  amazon_current:    { desc: '高い順',   asc: '低い順' },
  amazon_ratio:      { desc: '高い順',   asc: '低い順' },
  // デフォルト (価格、ポイント、送料、下落率%、他の出品価格、各手数料)
  _default:         { desc: '大きい順', asc: '小さい順' },
};

function sortDirLabel(key, dir) {
  const m = SORT_DIR_LABELS[key] || SORT_DIR_LABELS._default;
  return m[dir] || (dir === 'desc' ? '降順' : '昇順');
}

// 期間別の FBA利益額 / ROE利益率 並び替えキーを自動登録する (2026-06 spec 項目8)。
// 12 キー = 6 期間 (瞬間/1/7/30/90/180) × 2 指標。利益指標は stats 依存なので
// SORT_KEYS_NEED_STATS にも入れて ensureStatsForSort を起動させる。
// SORT_EXTRACTORS / SORT_DIR_LABELS / SORT_KEYS_NEED_STATS の定義後に実行する
// こと (const の一時的デッドゾーン回避)。profitAmountForDays は関数宣言で巻き
// 上げ済みのため、呼び出し時 (並び替え時) に解決され問題ない。
for (const pp of PROFIT_PERIODS) {
  const amtKey = 'profit_amt_' + pp.sfx;
  const roeKey = 'profit_roe_' + pp.sfx;
  SORT_EXTRACTORS[amtKey] = (p, stats) => profitAmountForDays(p, stats, pp.days);
  SORT_EXTRACTORS[roeKey] = (p, stats) => profitRoeForDays(p, stats, pp.days);
  SORT_DIR_LABELS[amtKey] = { desc: '高い順', asc: '低い順' };
  SORT_DIR_LABELS[roeKey] = { desc: '高い順', asc: '低い順' };
  SORT_KEYS_NEED_STATS.add(amtKey);
  SORT_KEYS_NEED_STATS.add(roeKey);
}

// 並び替えに必要な stats を一括取得 (drop_* キーのみ)。filtered の
// 全件分の stats を 1 回の IPC でまとめて埋め、applySort が確定的に
// 走れるようにする。stats 未取得行は最下行 (null) になるので、これを
// 省略しても落ちはしないがソート結果がブレる。
async function ensureStatsForSort(items, force = true) {
  // force=true (更新 / 並び替え / 停止 / フィルタ実行 = ユーザーの確定評価): 並び替え
  // キーが stats 依存でなくても、FBA利益額 / ROE / 各平均列を最新DB値へ更新するため
  // filtered 全行を取り直す (option A, 2026-06 client要望)。
  // force=false (周期完了の自動更新): 従来どおり stats 依存ソートのときだけ + 差分のみ。
  if (!force && !SORT_KEYS_NEED_STATS.has(currentSort)) return;
  // 確定評価 (並び替えセレクタ / 方向ボタン / 更新ボタン) では、statsCache に
  // 「存在するが古い」値が残っていても全件を最新化してから並べる。以前は未取得
  // 行のみ取得していたため、監視クロール中は一部商品が古い平均のまま並び順に
  // 使われ、表示値と並び順がずれて「順番通りに並ばない」状態になっていた
  // (client報告 項目3: FBA利益額/ROE利益率の高い順・低い順が崩れる)。
  // これは下落率(drop_*)の並び替えにも同様に効く。連続再評価はしない —
  // ユーザーが並び替えを操作した瞬間 (= この関数を呼ぶ時) のみ最新化する。
  let asins = items.map((p) => p.asin);
  // force=false (周期完了の自動更新): statsCache に既に在る商品は再取得しない
  // = 今周期で変化した(無効化された)分だけ取り直す → 高速。force=true (並び替え
  // 操作 / 更新 / 停止 / フィルタ実行) は従来どおり全件最新化。
  if (!force) asins = asins.filter((a) => !statsCache.has(a));
  if (asins.length === 0) return;
  const selEl = $('#sort-selector');
  if (selEl) selEl.classList.add('sort-loading');
  try {
    await fetchStatsInChunks(asins);     // チャンク分割で応答なしを防ぐ
  } catch { /* IPC 失敗時は既存キャッシュのまま (取得済み行はそのまま並ぶ) */ }
  if (selEl) selEl.classList.remove('sort-loading');
}

// 行の「並び替え/表示に使う値ソース」を返す (2026-06 client spec)。
// ★ 並び替えは必ず「表示しているのと同じ値」で行う:
//   ・クロール中 (frozenRow あり): 押下時に凍結したスナップショット (product+stats)。
//   ・停止中/アイドル: ライブの正本 (allProducts[productIndex] + statsCache)。
// updateRow / updateRowStats も同じ frozenRow→snapshot / else→allProducts の解決を
// しているので、これで並び順と画面の数値が必ず一致する。以前は表示=凍結スナップショット・
// 並び替え=ライブ値、という別ソースだったため「スクレイプ中に並び替えると順序がバラバラ」
// になっていた (client報告 真因)。停止中は両者ライブで一致するので従来通り正しく並ぶ。
function rowValueSource(asin) {
  const fz = frozenRow(asin);
  if (fz) return { prod: fz.product, stats: fz.stats };
  const idx = productIndex.get(asin);
  return { prod: (idx != null ? allProducts[idx] : null), stats: statsCache.get(asin) };
}

// 配列をその場で並び替える。null/NaN は方向に関わらず必ず末尾。
// 並び替え値は rowValueSource で「表示と同一ソース」(クロール中=凍結スナップショット /
// 停止中=ライブ) から取り、商品フィールドと stats を抽出関数へ渡す。
function applySort(items) {
  if (!currentSort) return items;
  const get = SORT_EXTRACTORS[currentSort];
  if (!get) return items;
  const mult = currentSortDir === 'asc' ? 1 : -1;
  const decorated = items.map((item, i) => {
    const src = rowValueSource(item.asin);
    const v = get(src.prod, src.stats);
    const hasValue = v != null && Number.isFinite(v);
    return { p: item, i, v: hasValue ? v : null, hasValue };
  });
  decorated.sort((a, b) => {
    // 値なし行は常に末尾。
    if (!a.hasValue && !b.hasValue) return a.i - b.i;
    if (!a.hasValue) return 1;
    if (!b.hasValue) return -1;
    if (a.v === b.v) return a.i - b.i;     // 安定化
    return (a.v - b.v) * mult;
  });
  return decorated.map((d) => d.p);
}

// ── 並び順スナップショット (2026-05) ─────────────────────────────
//
// ユーザーが並び替えボタン / セレクタをクリックした瞬間に「現在の並び」
// を ASIN → rank の Map として凍結する。以降の applyFilter (検索変更・
// グループ変更・cycle complete 等) では IPC / シマー無しで rank 順を
// 再適用するだけ — クロール中に並びがチラつく / セレクタが点滅する
// 問題への対策。`null` = 未スナップショット (= DB の自然順)。
//
// 「ボタンをクリックしたタイミングのみ並びに反映」の挙動はここで実現
// している。currentSort/Dir はあくまで「ユーザーが何を選んでいるか」
// の状態保持で、実際の表示順は sortedAsinRank が決める。
let sortedAsinRank = null;     // Map<asin, number> | null

// ── 表示値の凍結スナップショット (2026-06, client要望 C) ───────────
//
// クライアント要件は3つあり、すべて両立する:
//   (1) フィルタ実行/更新/並び替えボタンを押した「その瞬間の最新データ」で
//       絞り込み・並び替え・各列の値を確定する。
//   (2) 押した後は監視クロールが進んでも、表示が勝手に入れ替わらない（重く
//       なるリアルタイム更新はしない = スナップショット）。
//   (3) クロール中でも全商品を最新データで評価する（除外しない = 旧仕様の
//       「再取得済みのみ評価」をやめる）。
//
// (1)+(2) を満たすには「並び順」だけでなく「各行の表示値 (商品フィールド +
// stats)」も同じ瞬間に凍結する必要がある。従来は並び順 (sortedAsinRank) と
// フィルタ集合 (filterAsinSnapshot) だけ凍結し、値はライブ (allProducts /
// statsCache) を読んでいたため、スクロール再描画で値だけが新しくなり、凍結
// された並び順・利益額と食い違って見えていた (= 並び順崩れ / 利益額不一致の
// 真因)。そこでボタン押下時に行ごとの {商品フィールド, stats} を丸ごとコピー
// して凍結し、クロール中の描画はこの凍結値だけを読む。ライブな allProducts /
// statsCache は通知判定 (flushDirty) 用に裏で更新し続ける（通知は止めない）。
let viewSnapshot = new Map();   // asin -> { product:{...}, stats:{...}|null }

// クロール中のみ凍結スナップショットを返す。停止中・未作成時は null
// (= ライブ値で描画)。停止中はライブ更新が来ないので最後の確定値と一致する。
function frozenRow(asin) {
  if (crawlCycleStartedAt <= 0) return null;
  return viewSnapshot.get(asin) || null;
}

// 現在の filtered (= ボタン押下で確定した表示対象) の商品フィールドと stats を
// 丸ごとコピーして凍結する。並び替え・絞り込み・stats 取得が済んだ「描画直前」
// に呼ぶことで、並び順・値・フィルタ結果がすべて同一スナップショットになる。
async function captureViewSnapshot() {
  // スナップショットはクロール中の描画でのみ参照される (frozenRow は停止中 null)。
  // 停止中に作っても使われないので、欠損 stats の一括取得 (重い) はクロール中だけ
  // 行う — 起動時など停止中の確定では余計な IPC を発生させない。クロール中は
  // 利益額/平均列まで凍結するため未取得分を揃えてから固める。
  if (crawlCycleStartedAt > 0) {
    const missing = filtered.filter((p) => !statsCache.has(p.asin)).map((p) => p.asin);
    if (missing.length) {
      await fetchStatsInChunks(missing);   // チャンク分割で応答なしを防ぐ
    }
  }
  const snap = new Map();
  for (const p of filtered) {
    const s = statsCache.get(p.asin);
    snap.set(p.asin, { product: { ...p }, stats: s ? { ...s } : null });
  }
  viewSnapshot = snap;
}

// ── フィルタ条件合致探索のスナップショット (2026-05) ──────────────
//
// FNM フィルタ条件 (価格・ポイント・avg・下落率 等) は stats に依存する
// ため、毎周期で全件再評価すると重く、また statsCache が更新途中の
// タイミングで結果がブレる。そこでユーザーが明示的に「更新」した時だけ
// 全件評価して結果 (= 一致 ASIN の集合) を凍結し、applyFilter は集合
// チェックだけで絞り込む方式に変更。
//
// 更新タイミング:
//   1. FNM 「適用」ボタン (fnmExecute)
//   2. ヘッダーの「並び替えやフィルタ設定で最新状態に更新」ボタン
//   3. 起動時 (保存された条件が有効ならその時点で 1 回だけ評価)
//   4. ビュー切替 (active ⇔ trash) — 評価対象集団が変わるため
let filterAsinSnapshot = null;          // Set<asin> | null
// 再評価中フラグ — 同時複数呼出しを排除。
let _filterRecomputeRunning = false;

// 既存の rank map に従って配列を並び替える。rank に無い ASIN (= スナップ
// ショット後に追加された商品) は元の順序で末尾に寄せる。Array.sort は
// 安定化されているので、未ランク行同士の相対順序は崩れない。
function reapplyRankOrder(arr) {
  if (!sortedAsinRank) return;
  const ranks = sortedAsinRank;
  arr.sort((a, b) => {
    const ra = ranks.get(a.asin);
    const rb = ranks.get(b.asin);
    if (ra == null && rb == null) return 0;     // 両方未ランク → 元順維持
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}

// ユーザー操作で並び替えを実行 → rank map を更新 → 再描画。
// 並び替えクリック (= ボタン / セレクタ change) の経路でのみ呼ぶ。
// `applyFilter` 内では呼ばない (= クロール中のシマー / 点滅対策)。
async function applySortNow(forceAll = true, recapture = true) {
  // まず検索・FNM で絞り込みを最新化。スナップショットが空の状態で
  // 走るので、ここでは rank reorder は no-op。
  await applyFilter();

  // ★ 2契機の動作を分ける (2026-06 client spec):
  //   recapture=true  … 確定評価 (更新 / 監視ストップ / 起動 / フィルタ実行)。表示対象
  //     全行の stats を最新DB値へ取り直し (option A: 並び替えキーに関わらず FBA利益額/
  //     ROE/各平均を更新)、値を「今この瞬間」で凍結 (captureViewSnapshot) してから
  //     並べ替える。★ 凍結を applySort より前に行うことで、クロール中(=更新)でも
  //     applySort が読む値ソース (frozenRow→スナップショット) が最新になり、並び順と
  //     表示値が必ず一致する。
  //   recapture=false … スクレイプ中の並び替え操作 (▲▼/セレクタ)。値は一切触らず
  //     (DB取得・stats再取得・凍結し直しなし)、現在のスナップショット値で順序だけ
  //     変える。これで「スクレイプ中は値を変えず順序のみ」(client spec) を満たす。
  if (recapture) {
    await ensureStatsForSort(filtered, forceAll);
    await captureViewSnapshot();
  }

  if (!currentSort) {
    // 「並び替えなし」を選択 — スナップショット解除 → DB 順に戻して再描画。
    sortedAsinRank = null;
    $('#product-list').scrollTop = 0;
    renderVisible();
    return;
  }

  // 新しい並び順を計算して rank map を凍結。値は rowValueSource (= 表示と同一ソース)。
  filtered = applySort(filtered);
  sortedAsinRank = new Map();
  filtered.forEach((p, i) => sortedAsinRank.set(p.asin, i));

  $('#product-list-count').textContent = `${filtered.length} items`;
  const meta = $('#group-filter-count');
  if (meta) meta.textContent = `${filtered.length} 件表示`;
  const body = $('#viewer-tbody');
  if (body) body.style.height = `${filtered.length * ROW_HEIGHT}px`;
  $('#product-list').scrollTop = 0;
  renderVisible();
}

// 並び替え操作 (セレクタ変更 / ▲▼ ボタン) の共通処理 (2026-06 client spec)。
//   スクレイプ中 (crawlCycleStartedAt>0): 表示中の凍結スナップショットを「並べ替える
//     だけ」。DB アクセス・stats 再取得・クロール一時停止・スピナーは一切なし。値は
//     変えず順序のみ (= 押下時のスナップショット値で並べ替え、表示と完全一致)。
//   停止中: 従来どおり確定評価 (runUserRecalc でスピナー + stats を最新化して並べ替え)。
//     停止中はライブ値が安定しており、表示=並び替え=ライブで一致するため正しく並ぶ。
async function performUserSort() {
  if (_recalcRunning) return;     // 確定評価 (更新/停止) の最中は触らない
  if (crawlCycleStartedAt > 0) {
    await applySortNow(false, false);                      // 軽量リオーダ (値そのまま)
  } else {
    await runUserRecalc(() => applySortNow(true, true));   // 停止中: 確定評価
  }
}

// ── フィルタスナップショット再評価 ─────────────────────────────
//
// 全候補商品を集めて (search 絞り込み前)、FNM 条件が 1 つでも有効なら
// stats を全件分一括取得 → passesAllConditions で評価 → 結果 ASIN を
// Set に凍結。条件が空 (全 unchecked) なら snapshot = null にして
// 「絞り込みなし」状態に戻す。
// ── 再計算中のブロッキングスピナー (2026-06 client要望) ───────────────
// 値の再計算中は画面中央にスピナーを出し、その間ユーザーが他の操作をできない
// ようにする (オーバーレイが全面を覆ってクリックを遮断)。クロールと再計算は
// scheduler 側で排他制御されるため、スピナーは「クロールが止まっている再計算中」に
// だけ出る (= スクレイプ中には出ない)。ネスト呼び出しに対応するため参照カウント。
let _recalcOverlayCount = 0;
function showRecalcOverlay() {
  _recalcOverlayCount++;
  const el = $('#recalc-overlay');
  if (el) el.classList.remove('hidden');
}
function hideRecalcOverlay() {
  _recalcOverlayCount = Math.max(0, _recalcOverlayCount - 1);
  if (_recalcOverlayCount === 0) {
    const el = $('#recalc-overlay');
    if (el) el.classList.add('hidden');
  }
}

async function recomputeFilterSnapshot(forceAll = true, quiet = false) {
  if (_filterRecomputeRunning) return;
  _filterRecomputeRunning = true;
  if (!quiet) showRecalcOverlay();   // quiet=周期完了の自動更新 → スピナーを出さない
  // 更新ボタンのグレー/青は呼び出し側 (recomputeFilterAndSortAndRender /
  // runUserRecalc) が setRefreshBtnRecalcing/Ready で一括管理するので、ここでは触らない。
  try {
    const fnmStates = (viewMode === 'trash' ? fnmStateCache.trash : fnmStateCache.active).filter;
    if (!hasAnyConditionEnabled(fnmStates)) {
      filterAsinSnapshot = null;
      return;
    }
    // 評価対象は現在ビュー (active or trash) の全商品。検索クエリは
    // 評価に絡めない — 検索は applyFilter 内で snapshot とは独立に
    // 絞り込まれる。
    // ★ クロール中も「全商品」を最新データで評価する (2026-06, client要望 C / 項目B)。
    //
    // 旧仕様は「今サイクルで再取得済みの商品だけ」を評価していた (誤ヒット対策)。
    // しかしクロール開始直後はまだ数件しか再取得が済んでおらず、表示値が条件に
    // 合致している商品（=値が変わっていない商品）まで除外され、ほぼヒットしない、
    // という別の不具合になっていた。クライアントの要件は「ボタンを押した時点の
    // 最新データで、合致する商品が（クロール前と同じように）すべてヒットする」
    // こと。そこで除外をやめて全商品を評価する。
    //   ※ 旧仕様が防いでいた「瞬間下落率の誤ヒット」は、別途 getProductStats 側で
    //     瞬間下落の基準を直近12時間以内の観測に限定済み (= 監視ギャップを跨いだ
    //     古い基準で誤判定しない) なので、全件評価しても誤ヒットは再発しない。
    const candidates = allProducts;
    // forceAll=true (フィルタ実行 / 更新ボタン / 起動 / 停止 / ビュー切替): 全候補の
    // stats を最新で取り直してから判定。forceAll=false (周期完了の自動更新): 今周期
    // で変化した(= statsCache が無効化された)商品だけ取り直す → 高速。変化していない
    // 商品はキャッシュ値で判定 (値が変わっていないので結果は同じ)。
    await ensureStatsLoaded(candidates, fnmStates, forceAll);
    refreshNewestObserved();   // 「未取得期間」フィルタ (項目4) の基準を最新化してから評価
    const matched = new Set();
    for (const p of candidates) {
      if (passesAllConditions(p, fnmStates)) matched.add(p.asin);
    }
    filterAsinSnapshot = matched;
  } catch (e) {
    console.warn('[filter-snapshot] recompute failed:', e.message);
  } finally {
    _filterRecomputeRunning = false;
    if (!quiet) hideRecalcOverlay();
  }
}

// 「並び替えやフィルタ設定で最新状態に更新」相当の総合再評価。FNM 適用
// 時とヘッダーの更新ボタンクリック時に呼ばれる。フィルタスナップショット
// → 並び替え → 描画を一括でやり直す。
// 全件 stats が一度キャッシュに載ったか。周期完了の再計算では、未ロードなら
// 全件、ロード済みなら「今周期で変化した(無効化された)商品」だけ取り直す。
let _statsFullyLoaded = false;
// 再計算の単一実行ガード (2026-06 client報告: スピナーが出っぱなしになる)。
// 周期完了が高頻度に発生 (= 監視対象が少なく1周期が短い) すると、49秒級の
// 再計算が重なって走り続け、スピナーが常時表示されてしまう。実行中は新規の
// 再計算トリガを無視し、1 度に 1 つだけ走らせる。
let _recalcRunning = false;
// quiet=true (周期完了のアイドル自動更新, 案A): 全画面ブロッキングのスピナーと
// 最低表示時間 (500ms) を出さず、値・並び順だけ静かに最新化する。更新ボタンの
// グレー/青インジケータと単一実行ガードは維持する (= 4契機共通の進行中表示)。
// quiet=false (更新ボタン / 監視停止 / 起動 / フィルタ実行 = ユーザー確定評価):
// 従来どおりスピナーを出して操作をブロックする。
async function recomputeFilterAndSortAndRender(forceAll = true, pauseCrawl = true, quiet = false) {
  if (_recalcRunning) return;        // 既に再計算中 — 重複起動しない
  _recalcRunning = true;
  armRecalcWatchdog();               // 万一詰まっても必ず状態が戻る保険
  setRefreshBtnRecalcing();          // 再計算中はボタンをグレー (disabled) に
  // 先にスピナーを出し、確実に 1 フレーム「描画させてから」一時停止 + 重い処理に入る
  // (2026-06 client報告: スピナーが見えない)。原因は (1) 押下直後ではなく一時停止
  // 後に出していた、(2) setTimeout(0) では描画前に同期処理でブロックされ得たこと。
  // showRecalcOverlay() → 二重 requestAnimationFrame で 1 フレーム確実に描画する。
  if (!quiet) showRecalcOverlay();
  const _shownAt = Date.now();
  try {
    if (!quiet) await paintFrame();
    // クロールと再計算を絶対に重ねない (client要望)。停止中は pauseForRecalc /
    // resumeCrawl は no-op。クロール中 (更新ボタン) はここでスクレイプを一時停止し、
    // DB の最新値を綺麗な断面で読む。周期完了 (quiet) は scheduler が既に待機中なので
    // pauseCrawl=false で呼ばれ、ここは no-op。
    if (pauseCrawl) await window.api.invoke('pauseCrawlForRecalc').catch(() => {});
    // ★ client spec (2026-06): 確定評価は「DB に保存されている最新値」でスナップショットを
    // 作り直す。商品行 (価格・Keepa インポート列) を DB から読み直してから stats を取り直す
    // ことで、各列と FBA利益額/ROE が必ず整合する (= クライアントの検算と合う)。
    await reloadProductsFromDb();
    await recomputeFilterSnapshot(forceAll, quiet);
    // 常に applySortNow を通す (client要望)。recapture=true: 最新DB値で凍結 → 並べ替え。
    await applySortNow(forceAll, true);
    if (forceAll) _statsFullyLoaded = true;
  } finally {
    if (!quiet) {
      // 高速な再計算でも視認できるよう、最低 500ms はスピナーを表示する。
      const _elapsed = Date.now() - _shownAt;
      if (_elapsed < 500) await new Promise((r) => setTimeout(r, 500 - _elapsed));
      hideRecalcOverlay();
    }
    clearRecalcWatchdog();
    _recalcRunning = false;
    setRefreshBtnReady();            // 再計算完了 → ボタンを青 (enabled) に戻す
    if (pauseCrawl) window.api.invoke('resumeCrawl').catch(() => {});
  }
}

// スピナー等のDOM変更を確実に 1 フレーム描画させてから次へ進む。
// 表示中は二重 requestAnimationFrame で 1 フレーム確実に描画する。
// ★ ただし requestAnimationFrame はウィンドウが非表示/最小化/バックグラウンドだと
// Chromium が発火を止めるため、二重 rAF だけだと「永久に解決しない」→ 再計算が始まらず
// _recalcRunning が立ちっぱなしになり、以後の「更新」もすべて無視される & クロール一時停止
// も解除されない (client報告: 更新しても再計算されない)。そこでタイマーでフォールバックして
// 必ず解決させる (どちらか早い方)。
function paintFrame() {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 150);   // rAF が来ないとき (非表示等) のフォールバック — ハング防止
  });
}

// ユーザー操作 (並び替え変更 等) からの再計算を、スピナー表示 + クロール一時停止
// つきで実行する共通ヘルパ。スピナーを先に描画 → クロール停止 → fn 実行 →
// 最低表示時間を確保してから閉じる。重複実行はガードする。
async function runUserRecalc(fn) {
  if (_recalcRunning) return;
  _recalcRunning = true;
  armRecalcWatchdog();
  setRefreshBtnRecalcing();          // 再計算中はボタンをグレー (disabled) に
  showRecalcOverlay();
  const t = Date.now();
  try {
    await paintFrame();
    await window.api.invoke('pauseCrawlForRecalc').catch(() => {});
    await fn();
  } finally {
    const e = Date.now() - t;
    if (e < 500) await new Promise((r) => setTimeout(r, 500 - e));
    hideRecalcOverlay();
    clearRecalcWatchdog();
    _recalcRunning = false;
    setRefreshBtnReady();            // 再計算完了 → ボタンを青 (enabled) に戻す
    window.api.invoke('resumeCrawl').catch(() => {});
  }
}

async function applyFilter() {
  if (!currentSearch) {
    // ★ allProducts の「コピー」を使う (2026-06 fix)。直後の reapplyRankOrder /
    // applySort は filtered を「その場で」並び替える (arr.sort) ため、ここで
    // filtered = allProducts (同一参照) にすると allProducts 自体が並び替えられて
    // しまい、productIndex (asin→元の添字) と食い違う。すると updateRow/updateRowStats
    // の再解決 allProducts[productIndex.get(asin)] が「隣の商品」を返し、ASIN列は
    // 正しいのに各データ列だけが 1 行ズレて表示される (client報告: B0GJ8YSRB3 の行に
    // B0F9KF5Q1C の ¥7,968 が出る)。コピーを並べ替えれば allProducts/productIndex は
    // 常に一致したまま。検索あり/FNM 絞り込みの枝は既に新配列なので影響なし。
    filtered = allProducts.slice();
  } else {
    filtered = allProducts.filter(
      (p) => p.asin.toLowerCase().includes(currentSearch) ||
             (p.title || '').toLowerCase().includes(currentSearch)
    );
  }

  // FNM フィルタ条件の絞り込みは「凍結されたスナップショット」を使う
  // (2026-05 client request)。クロール中に passesAllConditions を毎周期
  // 走らせると stats のバッチ取得 + 全件評価で固まる + 結果がブレるため、
  // フィルタ評価はユーザーが「更新ボタン」「FNM 適用ボタン」を押した
  // 時にだけ recomputeFilterSnapshot() で走らせ、その結果 (= 一致 ASIN
  // 集合) を filterAsinSnapshot に保存する。ここでは集合に含まれる行
  // だけ残す。スナップショットが未作成 (null) なら絞り込みなし。
  if (filterAsinSnapshot) {
    const snap = filterAsinSnapshot;
    filtered = filtered.filter((p) => snap.has(p.asin));
  }

  // 並び順は applyFilter 内では再計算しない (2026-05 fix)。クロール
  // 完了ごとに ensureStatsForSort が走るとセレクタが点滅・フリーズする
  // ため、並び替えはユーザーがボタン / セレクタを操作した applySortNow
  // 経由でのみ更新する。ここではその時凍結された rank map に従って
  // ASIN を並べ直すだけ (IPC なし・シマーなし)。スナップショットが
  // 無い (= currentSort = '' / 起動直後) 場合は DB 順のまま。
  if (sortedAsinRank) reapplyRankOrder(filtered);
  $('#product-list-count').textContent = `${filtered.length} items`;
  // The new "N 件表示" label below the group dropdown — same value,
  // different placement so the dropdown and its current count read as
  // a paired control.
  const meta = $('#group-filter-count');
  if (meta) meta.textContent = `${filtered.length} 件表示`;
  const body = $('#viewer-tbody');
  const empty = $('#viewer-empty');
  if (filtered.length === 0) {
    if (body) {
      body.innerHTML = '';
      body.style.height = '0px';
    }
    visibleRows.clear();
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  if (body) body.style.height = `${filtered.length * ROW_HEIGHT}px`;
}

function renderVisible() {
  const container = $('#product-list');
  const tbody = $('#viewer-tbody');
  if (filtered.length === 0) return;

  const viewportH = container.clientHeight;
  const scrollTop = container.scrollTop;

  let startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - SCROLL_BUFFER);
  let endIdx = Math.min(filtered.length - 1, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + SCROLL_BUFFER);

  const shouldExist = new Set();
  const needStats = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const row = filtered[i];
    shouldExist.add(row.asin);
    let tr = visibleRows.get(row.asin);
    if (!tr) {
      tr = createRow(row);
      tbody.appendChild(tr);
      visibleRows.set(row.asin, tr);
    }
    tr.style.top = `${i * ROW_HEIGHT}px`;
    updateRow(tr, row);
    // クロール中の凍結行は snapshot の stats で描画済みなので新規 fetch しない。
    // (ここで fetch すると最新 stats が混ざり、凍結した並び順・利益額とずれて
    //  「スクロールすると値が動く / 順番と合わない」状態に戻ってしまう。)
    if (!frozenRow(row.asin) && !statsCache.has(row.asin)) needStats.push(row.asin);
  }
  for (const [asin, tr] of visibleRows) {
    if (!shouldExist.has(asin)) {
      // Tear down the Sparkline instance attached to this row's
      // canvas so its ResizeObserver doesn't outlive the DOM node.
      const canvas = tr.querySelector('.cell-keepa canvas[data-spark-asin]');
      if (canvas) {
        const chart = sparklineCharts.get(canvas);
        if (chart && typeof chart.destroy === 'function') chart.destroy();
      }
      tr.remove();
      visibleRows.delete(asin);
    }
  }
  // Lazy-fetch stats for newly-visible rows; updates the cells once they arrive.
  for (const asin of needStats) fetchStatsFor(asin);
}

async function fetchStatsFor(asin) {
  if (statsCache.has(asin)) return;
  // Mark as in-flight so concurrent scrolls don't double-fetch.
  statsCache.set(asin, null);
  try {
    // 表示用の遅延取得 — 事前計算済み統計の高速経路 (2026-06)。値は従来と同一。
    const stats = await window.api.invoke('getProductStatsTable', { asin });
    statsCache.set(asin, stats || {});
    const tr = visibleRows.get(asin);
    if (tr) updateRowStats(tr, stats || {});
    // 旧仕様では stats が届くたびに mpCount 系フィルタを再評価していた
    // が、クロール中に絶えず走って固まる原因だったため停止 (2026-05)。
    // 結果が古くなったら refresh ボタン (= recomputeFilterAndSortAndRender)
    // をユーザーが押す導線に切替。ボタンに dirty クラスを付けて気付かせる。
    markRefreshButtonDirty();
  } catch (e) {
    statsCache.delete(asin);
  }
}

// ── 更新ボタンの状態 (2026-06 client spec) ─────────────────────────────
// ボタンの有効/無効は「再計算が進行中か否か」だけで決まる:
//   再計算中    → disabled (グレー)。押せない (4経路すべて: 更新 / 起動 / 監視停止 /
//                 周期完了 の再計算中はグレー)。
//   再計算なし  → enabled (青)。いつでも 更新 / 並び替え / フィルタ を開始できる。
// 旧ロジック (完了時に disabled、データ到着で enable) は逆だったので廃止した。
function setRefreshBtnRecalcing() {
  const btn = $('#btn-refresh-filter-sort');
  if (btn) { btn.classList.add('refreshing'); btn.classList.remove('dirty'); btn.disabled = true; }
}
function setRefreshBtnReady() {
  const btn = $('#btn-refresh-filter-sort');
  if (btn) { btn.classList.remove('refreshing', 'dirty'); btn.disabled = false; }
}
// 旧 API。ボタン状態は再計算の開始/終了だけで切り替えるので、データ到着では何も
// しない (no-op)。呼び出し側 (handleIncomingPriceUpdate / fetchStatsFor) は残置。
function markRefreshButtonDirty() { /* no-op — button state is recalc-driven now */ }

// ── 再計算の安全ウォッチドッグ (2026-06) ───────────────────────────────
// 万一どこかの await が解決せず再計算が完了しないと、_recalcRunning が立ちっぱなしに
// なって以後の更新/停止後再計算がすべて握り潰され、スピナー/白いボタンが残り、クロール
// 一時停止も解除されない (client報告: たまにスクレイプが始まらない/値が更新されない)。
// 一定時間で強制的に状態をリセットし、オーバーレイを消し、ボタンを clean にし、
// クロールを再開させる。通常 (事前計算済み統計で ~1 秒) は決して発火しない保険。
let _recalcWatchdog = null;
const RECALC_WATCHDOG_MS = 60_000;
function armRecalcWatchdog() {
  if (_recalcWatchdog) clearTimeout(_recalcWatchdog);
  _recalcWatchdog = setTimeout(() => {
    _recalcWatchdog = null;
    if (!_recalcRunning) return;
    console.warn('[recalc] watchdog fired — force-resetting stuck recalc state');
    _recalcRunning = false;
    _recalcOverlayCount = 0;
    const ov = $('#recalc-overlay'); if (ov) ov.classList.add('hidden');
    setRefreshBtnReady();
    window.api.invoke('resumeCrawl').catch(() => {});   // クロールを止めっぱなしにしない
  }, RECALC_WATCHDOG_MS);
}
function clearRecalcWatchdog() {
  if (_recalcWatchdog) { clearTimeout(_recalcWatchdog); _recalcWatchdog = null; }
}

function createRow(row) {
  const div = document.createElement('div');
  div.className = 'viewer-row virtual';
  div.dataset.asin = row.asin;
  div.style.height = `${ROW_HEIGHT}px`;
  div.innerHTML = viewMode === 'active' ? activeRowHtml(row) : trashRowHtml(row);
  // Product thumbnails (Amazon CDN) are loaded directly by the
  // browser. We just monitor load/error to flip CSS classes for the
  // shimmer → image transition.
  for (const img of div.querySelectorAll('.cell-thumb img')) {
    if (!img.getAttribute('src')) { img.classList.add('error'); continue; }
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded');
    } else {
      img.addEventListener('load',  () => img.classList.add('loaded'),  { once: true });
      img.addEventListener('error', () => img.classList.add('error'),   { once: true });
    }
  }

  // Inline price-history sparkline rendered from our own observation
  // data — replaces the old Keepa thumbnail. No external network, no
  // rate limits. Lazy-fetches the series via IPC the first time the
  // row is created, caches per-ASIN so re-renders on scroll are free.
  for (const canvas of div.querySelectorAll('.cell-keepa canvas[data-spark-asin]')) {
    loadSparkline(canvas, canvas.dataset.sparkAsin);
  }

  return div;
}

// Renderer-side caches for sparkline series + Sparkline instances.
// The series cache survives row recreation (scroll-out → scroll-in)
// so we don't re-IPC. The chart cache is keyed on the canvas element
// itself so we don't allocate new Sparkline objects on every render.
// Cache is purged whenever the user changes the sparkline period
// (changeSparklinePeriod) so a re-fetch fires for every visible row.
const sparklineCache = new Map();             // asin → series array
const sparklineCharts = new WeakMap();        // canvas → Sparkline

// 監視グラフ列の期間選択。列ヘッダーをクリックして 1日/7日/30日/
// 90日/180日/全期間 を切り替えられる。null = 全期間。設定 key
// `viewer.sparklineDays` に "1" / "7" / "30" / "90" / "180" / "all"
// として永続化。デフォルトは「直近7日」(クライアント要望 2026-06)。
let sparklineDays = 7;
// 縦軸最小値ゼロ固定 (項目24)。期間とは独立した ON/OFF。設定 key
// `viewer.sparklineMinZero` ('1'/'0') に永続化。デフォルト ON
// (= 直近7日・ゼロ固定がデフォルト、クライアント要望 2026-06)。
let sparklineMinZero = true;
const SPARKLINE_PERIOD_OPTS = [
  { days: 1,    label: '直近1日'   },
  { days: 7,    label: '直近7日'   },
  { days: 30,   label: '直近30日'  },
  { days: 90,   label: '直近90日'  },
  // 直近180日 は項目27 (保持期間 180→90) で削除。監視データは 90 日までしか残さない。
  { days: null, label: '全期間'    },
];
function sparklinePeriodLabel(days = sparklineDays) {
  const opt = SPARKLINE_PERIOD_OPTS.find((o) => o.days === days);
  return opt ? opt.label : '直近30日';
}
async function loadSparklinePref() {
  try {
    const v = await window.api.invoke('getSetting', { key: 'viewer.sparklineDays' });
    if (v === 'all') sparklineDays = null;
    else if (v != null && /^\d+$/.test(v)) sparklineDays = parseInt(v, 10);
    // 項目27: 直近180日は廃止。旧設定が 180 のままなら 90 に丸める。
    if (sparklineDays === 180) sparklineDays = 90;
    const z = await window.api.invoke('getSetting', { key: 'viewer.sparklineMinZero' });
    if (z != null) sparklineMinZero = (z === '1');
  } catch { /* fall back to default */ }
}
async function saveSparklinePref() {
  try {
    await window.api.invoke('setSetting', {
      key:   'viewer.sparklineDays',
      value: sparklineDays == null ? 'all' : String(sparklineDays),
    });
    await window.api.invoke('setSetting', {
      key:   'viewer.sparklineMinZero',
      value: sparklineMinZero ? '1' : '0',
    });
  } catch { /* non-fatal — in-memory state still reflects the choice */ }
}

// ── FBA利益額 / ROE利益率 の平均期間選択 (2026-06 spec 項目7-2 追記) ──────
// 列ヘッダーをクリックして 1/7/30/90/180 日平均を切り替える (監視グラフの
// 期間選択と同じ操作感)。両列で共通の期間を使い、設定 key `viewer.profitDays`
// に永続化。profitAmount/profitRoe が参照する。
let profitDays = 30;
// 0 = 瞬間 (1個前監視実質価格を基準にした利益)。1/7/30/90/180 = N日平均実質を基準。
// (2026-06 spec 項目7: 期間選択に「瞬間」を追加)
const PROFIT_PERIOD_OPTS = [0, 1, 7, 30, 90, 180];
function profitPeriodLabel(days = profitDays) {
  return days === 0 ? '瞬間' : `${days}日平均`;
}
async function loadProfitPref() {
  try {
    const v = await window.api.invoke('getSetting', { key: 'viewer.profitDays' });
    if (v != null && /^\d+$/.test(v) && PROFIT_PERIOD_OPTS.includes(parseInt(v, 10))) {
      profitDays = parseInt(v, 10);
    }
  } catch { /* fall back to default 30 */ }
}
async function saveProfitPref() {
  try {
    await window.api.invoke('setSetting', { key: 'viewer.profitDays', value: String(profitDays) });
  } catch { /* non-fatal */ }
}

// ── 「最小値ゼロ」チェック (2026-06) の永続化 / 復元 ─────────
// 価格グラフと出品者数グラフそれぞれ独立に保存。デフォルトは ON。
const chartMinZeroPref = { price: true, count: true };

async function loadChartMinZeroPref() {
  try {
    const p = await window.api.invoke('getSetting', { key: 'chart.minZero.price' });
    const c = await window.api.invoke('getSetting', { key: 'chart.minZero.count' });
    // 未保存 (null) → デフォルト ON。'0' のときだけ OFF。
    if (p != null) chartMinZeroPref.price = p !== '0';
    if (c != null) chartMinZeroPref.count = c !== '0';
  } catch { /* fall back to defaults */ }
}

async function saveChartMinZeroPref(which, on) {
  chartMinZeroPref[which] = !!on;
  try {
    await window.api.invoke('setSetting', {
      key:   `chart.minZero.${which}`,
      value: on ? '1' : '0',
    });
  } catch { /* non-fatal — in-memory state still reflects the choice */ }
}

// ── 並び替え設定 (2026-05) の永続化 / 復元 ──────────────────────
async function loadSortPref() {
  try {
    let k = await window.api.invoke('getSetting', { key: 'viewer.sortKey' });
    const d = await window.api.invoke('getSetting', { key: 'viewer.sortDir' });
    // 旧「FBA利益額(平均) / ROE利益率(平均)」(profitDays 追従) は項目8で期間別
    // キーへ置き換えたため、保存済みの旧キーは 30日平均の期間別キーへ移行する
    // (セレクタに該当 option が無くなるため)。
    if (k === 'profit_amt') k = 'profit_amt_30d';
    else if (k === 'profit_roe') k = 'profit_roe_30d';
    if (k && SORT_EXTRACTORS[k]) currentSort = k;
    if (d === 'asc' || d === 'desc') currentSortDir = d;
  } catch { /* fall back to defaults */ }
  // セレクタ要素は setupProductControls で既に存在しているはず。値を
  // 反映してから方向ボタンのラベル / disabled を更新。
  const sel = $('#sort-selector');
  if (sel) sel.value = currentSort;
  updateSortDirButton();
}
async function saveSortPref() {
  try {
    await window.api.invoke('setSetting', { key: 'viewer.sortKey', value: currentSort });
    await window.api.invoke('setSetting', { key: 'viewer.sortDir', value: currentSortDir });
  } catch { /* non-fatal */ }
}

// 方向ボタンのラベルを「並び替えキー × 方向」に応じて更新。
// 並び替えなし時は disabled にして「無効」を表現。
function updateSortDirButton() {
  const desc = $('#sort-dir-desc');
  const asc  = $('#sort-dir-asc');
  if (!desc || !asc) return;
  const enabled = !!currentSort;
  desc.disabled = !enabled;
  asc.disabled  = !enabled;
  // ツールチップはキー依存ラベル (高い順/低い順・新しい順/古い順・多い順/少ない順)。
  desc.title = enabled ? sortDirLabel(currentSort, 'desc') : '降順';
  asc.title  = enabled ? sortDirLabel(currentSort, 'asc')  : '昇順';
  // アクティブな方向 (currentSortDir) をハイライト。
  desc.classList.toggle('active', enabled && currentSortDir === 'desc');
  asc.classList.toggle('active', enabled && currentSortDir === 'asc');
}

// Open / close the period-picker dropdown anchored under the sparkline
// column header. Clicking an item: persists the choice, purges the
// per-asin series cache, re-renders the header label, then triggers a
// reload of every visible sparkline so they redraw using the new range.
// Outside-click closes the menu.
function toggleSparklineDropdown(headerEl) {
  const existing = document.getElementById('sparkline-period-dropdown');
  if (existing) { existing.remove(); return; }

  const rect = headerEl.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.id = 'sparkline-period-dropdown';
  dd.className = 'sparkline-dropdown';
  // Anchor right-aligned to the header so the menu doesn't drift off-
  // screen when the header is near the viewport edge.
  dd.style.left = `${Math.max(8, rect.left)}px`;
  dd.style.top  = `${rect.bottom + 4}px`;
  // 通常ブロック → ゼロ固定ブロック (項目24)。各期間 × {通常, 縦軸ゼロ固定}。
  const optBtn = (o, zero) => {
    const key = (o.days == null) ? 'all' : String(o.days);
    const active = (o.days === sparklineDays && zero === sparklineMinZero) ? 'active' : '';
    const suffix = zero ? '（縦軸最小値をゼロ固定）' : '';
    return `<button type="button" class="${active}" data-spark-days="${key}" data-spark-zero="${zero ? 1 : 0}">${o.label}監視グラフ${suffix}</button>`;
  };
  dd.innerHTML =
    SPARKLINE_PERIOD_OPTS.map((o) => optBtn(o, false)).join('') +
    '<div class="sparkline-dropdown-sep"></div>' +
    SPARKLINE_PERIOD_OPTS.map((o) => optBtn(o, true)).join('');
  document.body.appendChild(dd);

  dd.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-spark-days]');
    if (!btn) return;
    const v = btn.dataset.sparkDays;
    sparklineDays = (v === 'all') ? null : parseInt(v, 10);
    sparklineMinZero = btn.dataset.sparkZero === '1';
    saveSparklinePref();
    sparklineCache.clear();
    renderHeader();
    refreshAllSparklines();
    dd.remove();
  });

  // Close on outside click. Defer attachment by one tick so the
  // header click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!dd.isConnected) {
        document.removeEventListener('mousedown', onDoc);
        return;
      }
      if (!dd.contains(ev.target) && !headerEl.contains(ev.target)) {
        dd.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

// Re-render every visible row's sparkline. Called after the user picks
// a new period so charts swap to the new range without scrolling away.
function refreshAllSparklines() {
  for (const [asin, tr] of visibleRows) {
    const canvas = tr.querySelector('.cell-keepa canvas[data-spark-asin]');
    if (canvas) loadSparkline(canvas, asin);
  }
}

// FBA利益額 / ROE利益率 の平均期間ドロップダウン (2026-06 spec 項目7-2)。
// 監視グラフの toggleSparklineDropdown と同じ作り。両列共通の profitDays を
// 切り替え、ヘッダー再描画 + 表示中行の利益セル再計算を行う。
function toggleProfitDropdown(headerEl) {
  const existing = document.getElementById('profit-period-dropdown');
  if (existing) { existing.remove(); return; }

  const rect = headerEl.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.id = 'profit-period-dropdown';
  dd.className = 'sparkline-dropdown';   // 同じスタイルを流用
  dd.style.left = `${Math.max(8, rect.left)}px`;
  dd.style.top  = `${rect.bottom + 4}px`;
  dd.innerHTML = PROFIT_PERIOD_OPTS.map((d) => {
    const cls = (d === profitDays) ? 'active' : '';
    return `<button type="button" class="${cls}" data-profit-days="${d}">${profitPeriodLabel(d)}</button>`;
  }).join('');
  document.body.appendChild(dd);

  dd.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-profit-days]');
    if (!btn) return;
    profitDays = parseInt(btn.dataset.profitDays, 10);
    saveProfitPref();
    renderHeader();           // 両列ヘッダーのラベル (N日平均) を更新
    rerenderAllProfitCells(); // 表示中行の利益額/利益率を新しい期間で再計算
    dd.remove();
  });

  setTimeout(() => {
    const onDoc = (ev) => {
      if (!dd.isConnected) { document.removeEventListener('mousedown', onDoc); return; }
      if (!dd.contains(ev.target) && !headerEl.contains(ev.target)) {
        dd.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

// 表示中の全行について平均列 + FBA利益額/ROE利益率セルを再描画。期間変更時に呼ぶ。
// ★ 利益セルだけでなく行全体 (updateRowStats) を同一 stats で再描画する。
// 利益セルだけを別途描き直すと、その間に statsCache が更新 (sort/filter の
// ensureStats* は行を再描画しない) されていた場合、「平均列が表示する平均」と
// 「利益額が使う平均」がずれ、利益額 = 平均 − 最新実質 − 各手数料 の関係が
// 画面上で成り立たなくなる (client報告 項目4)。同一 stats で一括描画して整合させる。
function rerenderAllProfitCells() {
  for (const [asin, tr] of visibleRows) {
    // クロール中は凍結スナップショット (商品 + stats) で再計算し、表示の整合を保つ。
    const fz = frozenRow(asin);
    if (fz) {
      if (fz.stats) updateRowStats(tr, fz.stats, fz.product);
      continue;
    }
    const stats = statsCache.get(asin);
    if (stats) updateRowStats(tr, stats);
  }
}

async function loadSparkline(canvas, asin) {
  if (!asin) return;
  let series = sparklineCache.get(asin);
  if (!series) {
    try {
      series = await window.api.invoke('getSparklineSeries', { asin, days: sparklineDays });
    } catch {
      series = [];
    }
    if (!Array.isArray(series)) series = [];
    sparklineCache.set(asin, series);
  }
  // NB: don't gate on `canvas.isConnected` — when the cache hits
  // synchronously, the row hasn't been appended to tbody yet (createRow
  // calls this BEFORE the caller appendChilds), so isConnected would
  // be false and the Sparkline would never be created. Letting it run
  // unconditionally is safe: the Sparkline's ResizeObserver + rAF
  // bootstrap handle the deferred-mount case by triggering a redraw
  // once the canvas actually has CSS dimensions.
  let chart = sparklineCharts.get(canvas);
  if (!chart) {
    chart = new window.Sparkline(canvas, { color: '#fbbf24' });
    sparklineCharts.set(canvas, chart);
  }
  // 期間が指定されているとき (1/7/30/90/180 日) は X 軸を [now − Nd, now]
  // で固定。データが期間より短くてもレンジを縮めず、空白として描画する
  // (= 詳細グラフと同じ挙動)。「全期間」(sparklineDays === null) の時は
  // null を渡して従来通りデータ extent でフィットさせる。
  const now  = Date.now();
  const xMin = (sparklineDays != null) ? now - sparklineDays * 86_400_000 : null;
  const xMax = (sparklineDays != null) ? now : null;
  chart.setData(series, xMin, xMax, sparklineMinZero);   // 項目24: 縦軸ゼロ固定
}

// Group cell contents — always shows サイト比較 button on the left;
// then either the group name + 変更 (assigned) or just 登録 (unassigned).
function groupCellInner(asin, groupName) {
  const compareBtn = `<button type="button" class="row-mini-btn row-compare-btn" data-compare="${asin}" title="Keepa と Amazon 商品ページを新しいタブで開く">サイト比較</button>`;
  if (groupName) {
    return `${compareBtn}`
      + `<span class="row-group-name" title="${escapeHtml(groupName)}">${escapeHtml(groupName)}</span>`
      + `<button type="button" class="row-mini-btn row-group-edit-btn" data-group-edit="${asin}" title="グループを変更">変更</button>`;
  }
  return `${compareBtn}`
    + `<button type="button" class="row-mini-btn row-group-add-btn" data-group-edit="${asin}" title="グループに登録">登録</button>`;
}

// 月間販売数の「最新取得値」を返す (2026-06 spec 項目3)。Amazon 監視クロール値
// (last_monthly_sales / last_monthly_sales_at) と Keepa/CSV 取込値
// (imp_monthly_sales / imported_at) のうち、値があって取得日時が新しい方。
// ※ src/shared/monthly-sales.js の pickMonthlySales と同じロジック。main プロセス
//   (queries.js / notifier.js) と一致させること (片方だけ変更しない)。
function pickMonthlySales(row) {
  if (!row) return null;
  const liveVal = row.last_monthly_sales, liveTs = row.last_monthly_sales_at;
  const impVal  = row.imp_monthly_sales,  impTs  = row.imported_at;
  const liveHas = liveVal != null, impHas = impVal != null;
  if (liveHas && impHas) return ((liveTs || 0) >= (impTs || 0)) ? liveVal : impVal;
  if (liveHas) return liveVal;
  if (impHas)  return impVal;
  return null;
}

// 月間販売数の表示テキスト。pickMonthlySales が選んだ「最新取得値」(項目3)。
// 監視値も Keepa monthlySold/CSV「先月の購入」も Amazon の「○○+ 買われました
// (過去1か月)」という「○○以上」のまるめ値なので、値があれば常に末尾に「+」を
// 付ける (例: 50→「50+」、100→「100+」)。
function monthlySalesText(row) {
  const ms = pickMonthlySales(row);
  if (ms == null) return '';
  return Number(ms).toLocaleString('ja-JP') + '+';
}

// ── 商品名 3行トランケート (client要望) ────────────────────────────────
// 「3行を超える分は overflow:hidden で隠すのではなく、文字列ごと削除する」。
// canvas で実フォントの文字幅を測り、商品名セル幅(220px相当)で3行に折り返した
// 結果の3行ぶんだけを残し、末尾に「…」を付ける。余剰文字は戻り値に含めない
// (= セルの DOM テキストから消える)。可視行のみ描画する仮想リストなので、
// タイトル文字列でメモ化すれば十分高速。フォントは実 .cell-title から取得して
// 測定ズレを防ぐ。CSS 側の固定高さ clip は保険として残す。
let _titleMeasureCtx = null;
let _titleFontStr = null;
const _titleTruncCache = new Map();
const TITLE_MAX_W = 214;   // 列240px − 左右padding(20px) − 安全余白。やや狭めに
                           // 測ることで「…」が必ず3行内に収まる(安全側)。
function _ensureTitleMeasure() {
  if (!_titleMeasureCtx) {
    _titleMeasureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!_titleFontStr) {
    const probe = document.createElement('div');
    probe.className = 'cell-title';
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:-9999px;';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    _titleFontStr = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
    document.body.removeChild(probe);
  }
}
function truncateTitleTo3Lines(raw) {
  const t = String(raw == null ? '' : raw);
  if (!t) return '';
  const cached = _titleTruncCache.get(t);
  if (cached !== undefined) return cached;
  let result;
  try {
    _ensureTitleMeasure();
    const ctx = _titleMeasureCtx;
    ctx.font = _titleFontStr;
    const maxW = TITLE_MAX_W;
    const fits = (s) => ctx.measureText(s).width <= maxW;
    const lines = [];
    let cur = '';
    let truncated = false;
    // 空白優先で折り返し、長い語/連続CJKは文字単位で割る (CSS word-break:break-word 相当)。
    const tokens = t.split(/(\s+)/);
    outer:
    for (const token of tokens) {
      if (token === '') continue;
      if (cur === '' && /^\s+$/.test(token)) continue;   // 行頭の空白は捨てる
      if (fits(cur + token)) { cur += token; continue; }
      if (cur !== '') {
        lines.push(cur); cur = '';
        if (lines.length >= 3) { truncated = true; break; }
      }
      for (const ch of token) {                            // token を1文字ずつ
        if (cur === '' && /\s/.test(ch)) continue;
        if (cur !== '' && !fits(cur + ch)) {
          lines.push(cur); cur = '';
          if (lines.length >= 3) { truncated = true; break outer; }
        }
        cur += ch;
      }
    }
    if (!truncated) {
      result = t;                                          // 3行以内 → そのまま
    } else {
      let last = lines[2];
      while (last && !fits(last + '…')) last = last.slice(0, -1);
      result = ((lines[0] || '') + (lines[1] || '') + last).replace(/\s+$/, '') + '…';
    }
  } catch {
    result = t;                                            // 測定不可時は無加工 (CSS clip が保険)
  }
  _titleTruncCache.set(t, result);
  return result;
}

// 共通データ列 (商品写真〜在庫保管料) のセル HTML。activeRowHtml /
// trashRowHtml で共用 (両ビューで列8以降は同一)。先頭の固定3列 + 通知履歴3列
// + 登録日時 だけが active(グループ/最新取得/通知3/登録) と
// trash(サイト比較/ゴミ捨て/通知3/最新取得) で異なる。列順は spec デフォルト並び。
function commonRowCellsHtml(row) {
  const imgSrc  = row.image_url ? escapeHtml(row.image_url) : '';
  const intStr  = (v) => (v != null ? Number(v).toLocaleString('ja-JP') : '');
  const yenStr  = (v) => (v != null ? '¥' + Number(v).toLocaleString() : '');
  const kubun   = row.size_kubun ? escapeHtml(row.size_kubun) : '';
  const cond    = escapeHtml(row.last_mp_condition || '');
  return `
    <div class="cell-thumb">${imgSrc ? `<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${imgSrc}" alt="" data-product-link="${row.asin}" title="クリックで Amazon 商品ページを開く">` : ''}</div>
    <div class="cell-title" data-f="title" title="${escapeHtml(row.title || '')}">${escapeHtml(truncateTitleTo3Lines(row.title))}</div>
    <div class="cell-asin"><span class="asin-copy" data-copy-asin="${row.asin}" title="クリックで ASIN をコピー">${row.asin}</span></div>
    <div class="cell-imp-rank" data-f="impRank">${intStr(row.imp_rank)}</div>
    <div class="cell-monthly-sales" data-f="monthlySales">${monthlySalesText(row)}</div>
    <div class="cell-imp-rankdrop" data-f="impRankDrop">${intStr(row.imp_rank_drop_30d)}</div>
    <div class="cell-allcount">
      <span class="ac-count" data-f="mpCount">${row.last_mp_count != null ? row.last_mp_count : ''}</span>
      <span class="ac-cond" data-f="mpCondition" title="${cond}">${cond}</span>
    </div>
    <div class="cell-imp-sellers" data-f="impSellers">${intStr(row.imp_sellers)}</div>
    <div class="cell-profit" data-stat="profitAmt"><span class="profit-val">—</span></div>
    <div class="cell-profit" data-stat="profitRoe"><span class="profit-val">—</span></div>
    <div class="cell-keepa"><canvas data-spark-asin="${row.asin}" data-chart-for="${row.asin}" title="クリックで監視グラフ詳細を開く"></canvas></div>
    <div class="cell-effective" data-f="effective"><span class="eff-val">—</span></div>
    <div class="cell-notify-price"><input type="number" class="notify-price-input" data-notify-asin="${row.asin}" min="0" step="1" placeholder="—" value="${row.notify_price != null ? row.notify_price : ''}" title="この値を最新実質BuyBox価格が下回ったら「『個別設定価格』の商品検知」通知を発火"></div>
    <div class="cell-avg" data-stat="avg1d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg7d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg30d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg90d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg180d"><span class="avg-val">—</span></div>
    <div class="cell-amazon" data-f="amazonCurrent">${row.imp_amazon_current != null ? '¥' + Number(row.imp_amazon_current).toLocaleString() : ''}</div>
    <div class="cell-amazon-ratio" data-stat="amazonRatio"><span class="amzr-val">—</span></div>
    <div class="cell-avg" data-stat="other"><span class="avg-val">${row.last_mp_price != null ? '¥' + Number(row.last_mp_price).toLocaleString() : '—'}</span></div>
    <div class="cell-price" data-f="price">${row.last_price != null ? '¥' + Number(row.last_price).toLocaleString() : '—'}</div>
    <div class="cell-points" data-f="points">${row.last_points != null ? row.last_points + ' pt' : '—'}</div>
    <div class="cell-shipping" data-f="shippingFee">${row.last_shipping_fee != null && row.last_shipping_fee >= 1 ? '¥' + Number(row.last_shipping_fee).toLocaleString() : ''}</div>
    <div class="cell-delivery" data-f="delivery" title="${escapeHtml(row.last_delivery || '')}">${escapeHtml(row.last_delivery || '')}</div>
    <div class="cell-size-kubun" data-f="sizeKubun" title="${kubun}">${kubun}</div>
    <div class="cell-fee" data-f="amazonFee">${yenStr(row.amazon_fee)}</div>
    <div class="cell-fee" data-f="fbaFee">${yenStr(row.fba_fee)}</div>
    <div class="cell-fee" data-f="storageFee">${yenStr(row.inventory_storage_fee)}</div>
  `;
}

// 共通データ列のヘッダー (商品写真〜在庫保管料)。active / trash で共用。
// 列順は commonRowCellsHtml と完全一致させること。
function commonHeaderHtml() {
  return `
      <div data-col="thumb">商品写真</div>
      <div data-col="title">商品名</div>
      <div data-col="asin">ASIN</div>
      <div data-col="impRank">ランキング<span class="col-sub">(取込)</span></div>
      <div data-col="monthlySales">月間販売数<span class="col-sub">(Amazon表記)</span></div>
      <div data-col="impRankDrop">30日ランク変動<span class="col-sub">(取込)</span></div>
      <div data-col="allCount">全出品数<span class="col-sub">(内訳)</span></div>
      <div data-col="impSellers">新品出品数<span class="col-sub">(取込)</span></div>
      <div data-col="profitAmt" class="profit-period-header" id="profit-period-amt" title="期間を選択 (瞬間/1/7/30/90/180日)">FBA利益額<span class="col-sub">(${profitPeriodLabel()} ▾)</span></div>
      <div data-col="profitRoe" class="profit-period-header" id="profit-period-roe" title="期間を選択 (瞬間/1/7/30/90/180日)">ROE利益率<span class="col-sub">(${profitPeriodLabel()} ▾)</span></div>
      <div data-col="sparkline" class="sparkline-header" id="sparkline-period-header" title="期間を選択 (縦軸ゼロ固定の有無も選べます)">${sparklinePeriodLabel()}<span class="col-sub">${sparklineMinZero ? 'ゼロ固定' : '監視グラフ'} ▾</span></div>
      <div data-col="effective">最新実質<span class="col-sub">BuyBox価格</span></div>
      <div data-col="notifyPrice">通知価格<span class="col-sub">(個別設定)</span></div>
      <div data-col="avg1d">1日平均<span class="col-sub">実質BuyBox</span></div>
      <div data-col="avg7d">7日平均<span class="col-sub">実質BuyBox</span></div>
      <div data-col="avg30d">30日平均<span class="col-sub">実質BuyBox</span></div>
      <div data-col="avg90d">90日平均<span class="col-sub">実質BuyBox</span></div>
      <div data-col="avg180d">180日平均<span class="col-sub">実質BuyBox</span></div>
      <div data-col="amazonCurrent">Ama本体<span class="col-sub">価格</span></div>
      <div data-col="amazonRatio">Ama本体出品割合<span class="col-sub">(直近30日)</span></div>
      <div data-col="other">他の出品<span class="col-sub">価格</span></div>
      <div data-col="price">BuyBox<span class="col-sub">価格</span></div>
      <div data-col="points">ポイント</div>
      <div data-col="shipping">送料</div>
      <div data-col="delivery">発送情報</div>
      <div data-col="sizeKubun">サイズ区分</div>
      <div data-col="amazonFee">Amazon<span class="col-sub">販売手数料</span></div>
      <div data-col="fbaFee">FBA<span class="col-sub">販売手数料</span></div>
      <div data-col="storageFee">在庫<span class="col-sub">保管料</span></div>
  `;
}

// 通知履歴の3セル (2026-06 spec 項目29) — 最新取得日時(固定列) と 登録日時 の間。
// 最新通知日時 / 通知ヒット総回数 / 通知なし経過日数。active/trash 両ビュー共通。
// 通知なし経過日数 = floor((今 − 最新通知日時) / 日)。未通知は「—」。
function notifyCellsHtml(row) {
  const last  = row.last_notified_at ? formatJpDateTime(row.last_notified_at) : '—';
  const count = row.notify_hit_count != null ? row.notify_hit_count : 0;
  let gap = '—';
  if (row.last_notified_at) {
    gap = `${Math.floor((Date.now() - row.last_notified_at) / 86_400_000)}日`;
  }
  return `
    <div class="cell-time" data-f="notifyLast">${last}</div>
    <div class="cell-notify-count" data-f="notifyCount">${count}</div>
    <div class="cell-time" data-f="notifyGap">${gap}</div>
  `;
}

function activeRowHtml(row) {
  const checked = selected.has(row.asin) ? 'checked' : '';
  const groupName = (cachedGroups.find((g) => g.id === row.group_id) || {}).name || '';
  const lastUpdated = row.last_observed_at ? formatJpDateTime(row.last_observed_at) : '—';
  const added = row.added_at ? formatJpDateTime(row.added_at) : '—';
  // 固定列 (グループ / 最新取得日時) + 通知履歴3列 + 登録日時、その後は共通データ列。
  // The price-history canvas is rendered by loadSparkline (see createRow).
  return `
    <div class="cell-check"><input type="checkbox" data-bulk="${row.asin}" ${checked}></div>
    <div class="cell-group" title="${escapeHtml(groupName)}">${groupCellInner(row.asin, groupName)}</div>
    <div class="cell-time">${lastUpdated}</div>
    ${notifyCellsHtml(row)}
    <div class="cell-time">${added}</div>
    ${commonRowCellsHtml(row)}
  `;
}

function trashRowHtml(row) {
  const checked = selected.has(row.asin) ? 'checked' : '';
  const trashed = row.trashed_at ? formatJpDateTime(row.trashed_at) : '—';
  const lastUpdated = row.last_observed_at ? formatJpDateTime(row.last_observed_at) : '—';
  // 固定列 (サイト比較 / ゴミ捨て日時) + 通知履歴3列 + 最新取得日時、その後は共通データ列。
  return `
    <div class="cell-check"><input type="checkbox" data-bulk="${row.asin}" ${checked}></div>
    <div class="cell-actions"><button type="button" class="row-mini-btn row-compare-btn" data-compare="${row.asin}" title="Keepa と Amazon 商品ページを新しいタブで開く">サイト比較</button></div>
    <div class="cell-time">${trashed}</div>
    ${notifyCellsHtml(row)}
    <div class="cell-time">${lastUpdated}</div>
    ${commonRowCellsHtml(row)}
  `;
}

// Refresh the cells that can change between renders. Most cells are
// data-f tagged and updated through the `set` helper; the group cell
// is special because its content depends on a JOIN with `cachedGroups`
// that updateRow has to compute itself. Without this, assigning a
// product to a group via the bulk toolbar wouldn't visually update
// the row's group column until the user scrolled it out of view and
// back in (forcing recreation).
function updateRow(tr, row) {
  // 監視クロール中は、ボタン押下時点の凍結スナップショットの商品フィールドで
  // 描画する (client要望 C)。これで BuyBox価格・ポイント・送料・各手数料が
  // クロールで動いても、確定した並び順・利益額と整合したまま固定される。
  const fz = frozenRow(row.asin);
  if (fz) {
    row = fz.product;
  } else {
    // クロール停止中/アイドル時は、渡された `row` (filtered[] 参照) ではなく
    // allProducts の正本オブジェクトに解決し直す (2026-06 fix)。filtered は
    // loadProducts による配列差し替えで古い参照を持つことがあり、その場合
    // 最新実質BuyBox列 (この row 由来) と FBA利益額 (updateRowStats が引く
    // allProducts[productIndex] 由来) が別々の価格になって食い違う (client報告:
    // 監視ストップ後に 最新実質=5000 なのに FBA は別価格=4718 で計算され 273 に化ける)。
    // 同一の正本オブジェクトに統一することで、全セルが必ず整合する。
    const _idx = productIndex.get(row.asin);
    if (_idx != null && allProducts[_idx]) row = allProducts[_idx];
  }
  const set = (sel, val) => {
    const el = tr.querySelector(sel);
    if (el && el.textContent !== val) el.textContent = val;
  };
  // For cells whose text wraps or truncates (title, condition,
  // delivery, group), keep the `title` attribute in sync so the
  // hover tooltip always shows the full current value.
  const setWithTip = (sel, val) => {
    const el = tr.querySelector(sel);
    if (!el) return;
    if (el.textContent !== val) el.textContent = val;
    if (el.getAttribute('title') !== val) el.setAttribute('title', val);
  };
  // 商品名: セル表示は3行トランケート (余剰は削除)、tooltip は全文 (client要望)。
  {
    const el = tr.querySelector('[data-f="title"]');
    if (el) {
      const full = row.title || '';
      const disp = truncateTitleTo3Lines(full);
      if (el.textContent !== disp) el.textContent = disp;
      if (el.getAttribute('title') !== full) el.setAttribute('title', full);
    }
  }
  setWithTip('[data-f="mpCondition"]', row.last_mp_condition || '');
  setWithTip('[data-f="delivery"]',    row.last_delivery || '');
  set('[data-f="mpCount"]',     row.last_mp_count != null ? String(row.last_mp_count) : '');
  // 「過去1か月で○○点以上購入されました」 — Amazon 表記の月間販売目安。
  // 監視データ優先、無ければ Keepa インポート値 (2026-06 spec)。
  set('[data-f="monthlySales"]', monthlySalesText(row));
  // Keepa インポート/計算列 (2026-06 spec 項目7) — 再インポートで既に画面に
  // 出ている行 (createRow を経ない行) も更新されるよう、ここで差分反映する。
  // commonRowCellsHtml と同じ整形。set/setWithTip は textContent なので
  // size_kubun を escapeHtml しない (二重エスケープ防止)。
  {
    const intStr = (v) => (v != null ? Number(v).toLocaleString('ja-JP') : '');
    const yenStr = (v) => (v != null ? '¥' + Number(v).toLocaleString() : '');
    set('[data-f="impSellers"]',  intStr(row.imp_sellers));
    set('[data-f="impRank"]',     intStr(row.imp_rank));
    set('[data-f="impRankDrop"]', intStr(row.imp_rank_drop_30d));
    setWithTip('[data-f="sizeKubun"]', row.size_kubun || '');
    set('[data-f="amazonFee"]',   yenStr(row.amazon_fee));
    set('[data-f="fbaFee"]',      yenStr(row.fba_fee));
    set('[data-f="storageFee"]',  yenStr(row.inventory_storage_fee));
  }
  set('[data-f="price"]',       row.last_price != null ? '¥' + Number(row.last_price).toLocaleString() : '—');
  set('[data-f="points"]',      row.last_points != null ? row.last_points + ' pt' : '—');
  // 送料 — 1円以上の場合のみ表示 (送料無し=空欄)。BuyBox 価格には既に
  // 加算済みなので、ここはあくまで「送料が幾らだったか」の独立表示。
  set('[data-f="shippingFee"]',
      row.last_shipping_fee != null && row.last_shipping_fee >= 1
        ? '¥' + Number(row.last_shipping_fee).toLocaleString()
        : '');
  // 最新実質BuyBox価格 = BuyBox価格 − ポイント + 送料 (2026-05 fix)。
  // BuyBox列は Amazon 表示そのままの基本価格、送料は別列に独立表示する
  // 仕様のため、実質価格はここで送料を加算する必要がある。
  const latestEff = (row.last_price != null)
    ? row.last_price - (row.last_points || 0) + (row.last_shipping_fee || 0)
    : null;
  // 瞬間下落率 (latest vs 1個前の観測) の差額・%表示。prev は stats
  // 由来なので、PRICE_UPDATE 直後で statsCache が空のサイクルでは
  // 値だけ表示し、fetchStatsFor 完了後に updateRowStats が再描画する。
  const cachedStats = fz ? fz.stats : statsCache.get(row.asin);
  const prevEff = (cachedStats && cachedStats.prevEffective != null)
    ? cachedStats.prevEffective : null;
  renderEffectiveCell(tr, latestEff, prevEff);

  // Group cell — only present in the active view (trash view's
  // column 2 is サイト起動). Refresh its name from cachedGroups
  // every time so a freshly-assigned group shows up immediately.
  const groupCell = tr.querySelector('.cell-group');
  if (groupCell) {
    const grp = cachedGroups.find((g) => g.id === row.group_id);
    const name = grp ? grp.name : '';
    const desired = groupCellInner(row.asin, name);
    if (groupCell.innerHTML !== desired) groupCell.innerHTML = desired;
    if (groupCell.getAttribute('title') !== name) groupCell.setAttribute('title', name);
  }

  // Selection class
  tr.classList.toggle('row-selected', selected.has(row.asin));

  // stats が無くても updateRowStats は必ず呼ぶ (2026-06 client報告)。商品セル
  // (手数料・最新実質) を更新したのに利益額セルだけ古い値が残る = 「列と利益額が
  // 合わない」状態を防ぐため。stats 未取得時は平均・利益額が「—」になり、古い
  // 数値を残さない。クロール中は凍結 stats + 凍結商品で計算し、表示値と並び順を
  // 完全に一致させる (client要望 C)。
  const stats = fz ? fz.stats : statsCache.get(row.asin);
  // 上で解決した同一の `row` (凍結 or allProducts 正本) を渡し、最新実質列と
  // FBA利益額/平均を必ず同じ商品オブジェクトから描く (= 食い違い防止)。
  updateRowStats(tr, stats || {}, row);
}

// Render the 最新実質BuyBox価格 cell as a 3-line stack mirroring the
// avg-cell layout: latest value, 変動価格 (latest − 1個前), 変動率 (%).
// prevEff comes from stats.prevEffective. When it's missing (single
// observation, or stats not loaded yet) only the value line is shown.
// Coloring uses the buyer-perspective convention shared with avg cells:
//   price dropped (latest < prev) → blue (お得)
//   price rose    (latest > prev) → red  (割高)
//   no change                     → grey
function renderEffectiveCell(tr, latestEff, prevEff) {
  const cell = tr.querySelector('[data-f="effective"]');
  if (!cell) return;
  if (latestEff == null || !isFinite(latestEff)) {
    cell.innerHTML = '<span class="eff-val">—</span>';
    return;
  }
  let diffHtml = '';
  let pctHtml  = '';
  if (prevEff != null && isFinite(prevEff) && prevEff !== 0) {
    const diff = Math.round(latestEff - prevEff);
    const pct  = ((latestEff - prevEff) / prevEff) * 100;
    const cls  = diff < 0 ? 'pos' : (diff > 0 ? 'neg' : 'flat');
    const sign = diff > 0 ? '+' : '';
    const rounded = Math.round(pct);
    const psign   = rounded > 0 ? '+' : '';
    diffHtml = `<span class="eff-diff ${cls}">${sign}${diff}</span>`;
    pctHtml  = `<span class="eff-pct ${cls}">(${psign}${rounded}%)</span>`;
  }
  cell.innerHTML =
    `<span class="eff-val">¥${Number(Math.round(latestEff)).toLocaleString()}</span>${diffHtml}${pctHtml}`;
}

// prodOverride: 監視クロール中の凍結商品 (手数料が凍結値) を渡すと、利益額/ROE を
// その凍結商品 + 凍結 stats で計算する。省略時はライブ allProducts を引く。
function updateRowStats(tr, stats, prodOverride) {
  const renderAvg = (cellSel, val, diff, flip) => {
    const cell = tr.querySelector(cellSel);
    if (!cell) return;
    if (val == null) {
      cell.classList.add('empty');
      cell.innerHTML = '<span class="avg-val">—</span>';
      return;
    }
    cell.classList.remove('empty');
    let diffHtml = '';
    let pctHtml  = '';
    if (diff != null) {
      // stats.avgNdDiff / otherSellersDiff は queries.js が「基準値 − 最新実質」
      // で出している。表示の符号規約:
      //   flip=true (〇日平均, B15 client要望): その符号のまま表示する。
      //     = 平均が最新実質より高ければ「+ かつ赤 (pos)」、低ければ「− かつ青 (neg)」。
      //       通知の下落率と同じ向き (値が下がった = プラス = 赤)。
      //   flip=false (他の出品): 従来どおり「最新 − 基準 (=-diff)」で表示。
      // 通知側 (notifier.js / chart-render.html) は元の diff をそのまま使う仕様の
      // ため、IPC レイヤ (queries.js) は触らない (表示専用の符号反転)。
      const displayDiff = flip ? diff : -diff;
      // 色: プラス→pos(赤) / マイナス→neg(青)。flip 無しは符号が逆なので色条件も逆。
      const cls = flip
        ? (displayDiff > 0 ? 'pos' : (displayDiff < 0 ? 'neg' : 'flat'))
        : (displayDiff < 0 ? 'pos' : (displayDiff > 0 ? 'neg' : 'flat'));
      const sign = displayDiff > 0 ? '+' : '';
      diffHtml = `<span class="avg-diff ${cls}">${sign}${displayDiff}</span>`;
      // % 表記も同じ符号・色で「displayDiff ÷ 基準 × 100」。
      if (val !== 0) {
        const pct  = (displayDiff / val) * 100;
        const rounded = Math.round(pct);
        const psign = rounded > 0 ? '+' : '';
        pctHtml = `<span class="avg-pct ${cls}">(${psign}${rounded}%)</span>`;
      }
    }
    cell.innerHTML =
      `<span class="avg-val">¥${Number(val).toLocaleString()}</span>${diffHtml}${pctHtml}`;
  };
  // 〇日平均 (B15): 符号反転 (平均>最新→赤字プラス)。他の出品は従来の符号を維持。
  renderAvg('[data-stat="avg1d"]',   stats.avg1d,   stats.avg1dDiff,   true);
  renderAvg('[data-stat="avg7d"]',   stats.avg7d,   stats.avg7dDiff,   true);
  renderAvg('[data-stat="avg30d"]',  stats.avg30d,  stats.avg30dDiff,  true);
  renderAvg('[data-stat="avg90d"]',  stats.avg90d,  stats.avg90dDiff,  true);
  renderAvg('[data-stat="avg180d"]', stats.avg180d, stats.avg180dDiff, true);
  renderAvg('[data-stat="other"]',   stats.otherSellersPrice, stats.otherSellersDiff, false);

  // Ama本体出品割合(直近30日) (2026-06 spec 項目15)。stats.amazonListingRatio30d は
  // 監視点 2 点未満のとき null (= ⑤「2点以上で表示」) → 「—」表示。
  const amzrCell = tr.querySelector('[data-stat="amazonRatio"]');
  if (amzrCell) {
    const r = stats.amazonListingRatio30d;
    amzrCell.innerHTML = (r == null || !isFinite(r))
      ? '<span class="amzr-val">—</span>'
      : `<span class="amzr-val">${Math.round(r)}%</span>`;
  }

  // FBA利益額 / ROE利益率 (2026-06 spec 項目7-2)。平均期間はヘッダーで選択
  // (profitDays = 1/7/30/90/180)。商品行の last_price/手数料 + stats(avg{N}d) で算出。
  let prod = prodOverride;
  if (!prod) {
    const pidx = productIndex.get(tr.dataset.asin);
    prod = pidx != null ? allProducts[pidx] : null;
  }
  // 最新実質BuyBox価格 cell — 値は商品行由来 (effectiveOf) にして利益額と完全に
  // 同一ソースにする。瞬間変動 (diff/%) の基準 prevEffective だけ stats から取る。
  renderEffectiveCell(tr, effectiveOf(prod), stats.prevEffective);

  renderProfitCell(tr, '[data-stat="profitAmt"]', profitAmount(prod, stats), 'yen');
  renderProfitCell(tr, '[data-stat="profitRoe"]', profitRoe(prod, stats),   'pct');
}

// FBA利益額(N日平均) (2026-06 spec 項目7-2):
//   利益額 = N日平均実質BuyBox − 最新実質BuyBox − Amazon販売手数料
//            − FBA販売手数料 − 在庫保管料
// N は profitDays (ヘッダーで選択した平均期間 1/7/30/90/180)。該当平均が未蓄積
// ・最新実質・各手数料のいずれかが欠損なら null (= 表示「—」)。手数料は
// import/計算列由来 (amazon_fee 等)。avg90/180 は監視データが貯まるまで
// import 値で補完される (= 各平均列の表示と同一ソース)。
// 「最新実質BuyBox価格」= last_price − ポイント + 送料。表示列・FBA利益額・ROE は
// すべてこの「商品行由来」の値で統一する (2026-06 client報告)。stats.latestEffective
// も同じ式だが、stats の取得タイミング次第で商品行 (列表示) とズレ得たため、利益
// 計算には使わない。これで「FBA利益額 = N日平均 − 最新実質 − 各手数料」が画面の
// 列の値と常に一致する (= クライアントの検算と必ず合う)。
function effectiveOf(p) {
  if (!p || p.last_price == null) return null;
  return p.last_price - (p.last_points || 0) + (p.last_shipping_fee || 0);
}
// ★ Guard #3 (2026-06 client要望): 最新実質が N日平均の極端に小さい割合のときは、
// 価格の誤読が疑われる (例: ¥759,155 の商品が ¥4,541 に化けると最新実質が平均の
// 0.6% → ROE が +15,060% に爆発し、ROE 並び替えの上位を汚染する)。そのような行は
// FBA利益額/ROE を出さず「—」にして、並び替えでも最下段に落とす。Guard #1 が DB 側で
// 大半を止めるので、これは「初回読取で基準が無い」等のすり抜けに対する最終防御。
const PROFIT_EFF_SANITY = 0.2;   // 最新実質 < 基準 × 0.2 は誤読疑い → 利益指標を出さない
// 利益額計算の「基準値」(= 平均実質 or 瞬間の 1個前実質) を期間から取り出す。
//   days === 0 (瞬間)  → stats.prevEffective (1個前監視実質価格、12h gap 制限つき)
//   days === N (平均)  → stats['avg'+N+'d']
// (2026-06 spec 項目7/8: 期間に「瞬間」を追加し、フィルタ/並び替えで各期間を独立選択)
function profitReference(stats, days) {
  if (!stats) return null;
  if (days === 0) return stats.prevEffective ?? null;
  const v = stats['avg' + days + 'd'];
  return v == null ? null : v;
}
// FBA利益額(期間) = 基準実質 − 最新実質 − Amazon販売手数料 − FBA販売手数料 − 在庫保管料。
//   瞬間: 基準 = 1個前監視実質価格 (spec 項目7 の式)。
//   N日平均: 基準 = N日平均実質。
// 基準/最新実質/各手数料のいずれかが欠損なら null (= 「—」)。手数料は import/計算列由来。
function profitAmountForDays(p, stats, days) {
  if (!p || !stats) return null;
  const ref = profitReference(stats, days);
  const eff = effectiveOf(p);
  if (ref == null || eff == null) return null;
  if (eff <= 0 || eff < ref * PROFIT_EFF_SANITY) return null;   // 価格誤読の疑い → 「—」
  const af = p.amazon_fee, ff = p.fba_fee, sf = p.inventory_storage_fee;
  if (af == null || ff == null || sf == null) return null;
  return ref - eff - af - ff - sf;
}
// ROE利益率(期間) = 利益額 ÷ 最新実質BuyBox × 100。
function profitRoeForDays(p, stats, days) {
  const amt = profitAmountForDays(p, stats, days);
  const eff = effectiveOf(p);
  if (amt == null || eff == null || eff === 0) return null;
  return (amt / eff) * 100;
}
// 列表示用 — ヘッダーで選択中の期間 (profitDays) を使う。
function profitAmount(p, stats) { return profitAmountForDays(p, stats, profitDays); }
function profitRoe(p, stats)    { return profitRoeForDays(p, stats, profitDays); }
// 利益セルの描画。クライアント仕様 (項目7-2): プラス→赤字, マイナス→青字。
// ※ 価格セルの「値下がり=青」とは逆 — 利益の符号そのもので着色する。
function renderProfitCell(tr, sel, val, kind) {
  const cell = tr.querySelector(sel);
  if (!cell) return;
  if (val == null || !isFinite(val)) {
    cell.innerHTML = '<span class="profit-val">—</span>';
    return;
  }
  const rounded = Math.round(val);
  const cls = rounded > 0 ? 'profit-pos' : (rounded < 0 ? 'profit-neg' : 'profit-zero');
  const text = (kind === 'pct')
    ? `${rounded > 0 ? '+' : ''}${rounded}%`
    : `${rounded < 0 ? '-' : ''}¥${Math.abs(rounded).toLocaleString()}`;
  cell.innerHTML = `<span class="profit-val ${cls}">${text}</span>`;
}

function formatJpDateTime(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${mo}/${da} ${h}:${mi}`;
}

function onListClick(e) {
  // Explicit action buttons take priority.
  const chartBtn = e.target.closest('[data-chart-for]');
  if (chartBtn) { openChartModal(chartBtn.dataset.chartFor); return; }

  // ASIN セルクリック — クリップボードへコピーのみ。Amazon 商品ページは
  // 開かない (商品画像クリックの方で開く動線に役割分担)。監視リスト・
  // ゴミ箱リスト両方の cell-asin span に data-copy-asin を付与している
  // ので、両ビューで完全に同じ挙動。
  const copyTarget = e.target.closest('[data-copy-asin]');
  if (copyTarget) {
    copyAsinToClipboard(copyTarget);
    return;
  }

  // 商品画像クリック — Amazon 商品ページを既定ブラウザで開く。
  // 監視リスト・ゴミ箱リスト両方の cell-thumb img に data-product-link
  // を付与しているので、両ビューで同じ挙動。
  const productLink = e.target.closest('[data-product-link]');
  if (productLink) {
    window.api.invoke('openProductPage', { asin: productLink.dataset.productLink });
    return;
  }

  // サイト比較 — open Keepa + Amazon search in default browser tabs.
  const compareBtn = e.target.closest('[data-compare]');
  if (compareBtn) {
    window.api.invoke('openCompareTabs', { asin: compareBtn.dataset.compare });
    return;
  }

  // 登録 / 変更 — open the row-level group picker.
  const groupEditBtn = e.target.closest('[data-group-edit]');
  if (groupEditBtn) {
    openRowGroupModal(groupEditBtn.dataset.groupEdit);
    return;
  }

  // ASIN/Amazon link → let browser handle.
  if (e.target.closest('a')) return;

  // 監視グラフ列ヘッダー — クリックで期間選択ドロップダウンを開閉。
  const sparkHdr = e.target.closest('#sparkline-period-header');
  if (sparkHdr) {
    e.stopPropagation();
    toggleSparklineDropdown(sparkHdr);
    return;
  }

  // FBA利益額 / ROE利益率 列ヘッダー — クリックで平均期間ドロップダウン (項目7-2)。
  const profitHdr = e.target.closest('.profit-period-header');
  if (profitHdr) {
    e.stopPropagation();
    toggleProfitDropdown(profitHdr);
    return;
  }

  // Header "すべて" button — toggle select/deselect all filtered rows.
  const headBtn = e.target.closest('#viewer-header-checkbox');
  if (headBtn) {
    const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.asin));
    if (allSelected) {
      for (const p of filtered) selected.delete(p.asin);
    } else {
      for (const p of filtered) selected.add(p.asin);
    }
    for (const tr of visibleRows.values()) {
      const inner = tr.querySelector('input[data-bulk]');
      const isOn = selected.has(tr.dataset.asin);
      if (inner) inner.checked = isOn;
      tr.classList.toggle('row-selected', isOn);
    }
    headBtn.classList.toggle('active', !allSelected);
    renderBulkToolbar();
    return;
  }
}

// Checkbox state changes — both row checkboxes and the header "all"
// checkbox flow through here.
function onListChange(e) {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement)) return;

  const asin = cb.dataset.bulk;
  if (asin) {
    if (cb.checked) selected.add(asin); else selected.delete(asin);
    const tr = visibleRows.get(asin);
    if (tr) tr.classList.toggle('row-selected', cb.checked);
    renderBulkToolbar();
    return;
  }

  // 個別設定価格 (2026-05): notify-price-input の値変更を即時 IPC で永続化。
  // 空入力 → null として保存 (= 「未設定 = FNM 通知に従う」状態に戻る)。
  const notifyAsin = cb.dataset.notifyAsin;
  if (notifyAsin) {
    const raw = cb.value.trim();
    window.api.invoke('setNotifyPrice', { asin: notifyAsin, price: raw === '' ? null : raw })
      .then((res) => {
        // メモリ上の allProducts 行も同期 — 次の flushDirty で参照する。
        const idx = productIndex.get(notifyAsin);
        if (idx != null) allProducts[idx].notify_price = res?.value ?? null;
      })
      .catch((err) => console.warn('[notify-price] save failed:', err.message));
  }
}

// ── Header rendering ──────────────────────────────────────
//
// ── Column reordering (2026-06 spec 項目5) ──────────────────────────
//
// Columns 1–3 (チェック / グループ / 最新取得日時) are sticky-fixed and never
// move. Columns 4–36 (最新通知日時/通知ヒット総回数/通知なし経過日数 + 登録日時 +
// 商品写真〜在庫保管料) can be dragged left/right by their header to reorder.
// We do NOT reorder the DOM — that would break the virtualized row recycling
// and the data-f / data-stat update hooks. Instead we reorder VISUALLY via the
// CSS-grid `order` property plus a matching grid-template-columns, injected as
// a <style>. The saved order (viewer.columnOrder) is a permutation of the
// movable column ids and applies to both the active and trash views.
const FIXED_COL_WIDTHS = ['64px', '230px', '100px']; // sticky cols 1–3
// pos = the column's DEFAULT 1-based position in the grid (nth-child), which
// never changes (the DOM stays put); width must mirror styles.css .viewer-row.
const MOVABLE_COLUMNS = [
  // 通知履歴3列 (2026-06 spec 項目29) — 最新取得日時(固定列3) と 登録日時 の間。
  { id: 'notifyLast',   pos: 4,  width: '110px' }, // 最新通知日時
  { id: 'notifyCount',  pos: 5,  width: '88px'  }, // 通知ヒット総回数
  { id: 'notifyGap',    pos: 6,  width: '96px'  }, // 通知なし経過日数
  { id: 'regdate',      pos: 7,  width: '100px' }, // 登録日時 / (trash) 最新取得日時
  { id: 'thumb',        pos: 8,  width: '76px'  }, // 商品写真
  { id: 'title',        pos: 9,  width: '240px' }, // 商品名
  { id: 'asin',         pos: 10, width: '100px' }, // ASIN
  { id: 'impRank',      pos: 11, width: '96px'  }, // ランキング(取込)
  { id: 'monthlySales', pos: 12, width: '100px' }, // 月間販売数
  { id: 'impRankDrop',  pos: 13, width: '104px' }, // 30日ランク変動(取込)
  { id: 'allCount',     pos: 14, width: '112px' }, // 全出品数(内訳)
  { id: 'impSellers',   pos: 15, width: '88px'  }, // 新品出品数(取込)
  { id: 'profitAmt',    pos: 16, width: '112px' }, // FBA利益額
  { id: 'profitRoe',    pos: 17, width: '104px' }, // ROE利益率
  { id: 'sparkline',    pos: 18, width: '100px' }, // 監視グラフ
  { id: 'effective',    pos: 19, width: '96px'  }, // 最新実質BuyBox価格
  { id: 'notifyPrice',  pos: 20, width: '90px'  }, // 通知価格(個別設定)
  { id: 'avg1d',        pos: 21, width: '120px' }, // 1日平均
  { id: 'avg7d',        pos: 22, width: '120px' }, // 7日平均
  { id: 'avg30d',       pos: 23, width: '120px' }, // 30日平均
  { id: 'avg90d',       pos: 24, width: '120px' }, // 90日平均
  { id: 'avg180d',      pos: 25, width: '120px' }, // 180日平均
  { id: 'amazonCurrent', pos: 26, width: '96px'  }, // Ama本体価格 (項目14)
  { id: 'amazonRatio',  pos: 27, width: '110px' }, // Ama本体出品割合(直近30日) (項目15)
  { id: 'other',        pos: 28, width: '120px' }, // 他の出品価格
  { id: 'price',        pos: 29, width: '90px'  }, // BuyBox価格
  { id: 'points',       pos: 30, width: '62px'  }, // ポイント
  { id: 'shipping',     pos: 31, width: '70px'  }, // 送料
  { id: 'delivery',     pos: 32, width: '160px' }, // 発送情報
  { id: 'sizeKubun',    pos: 33, width: '150px' }, // サイズ区分
  { id: 'amazonFee',    pos: 34, width: '104px' }, // Amazon販売手数料
  { id: 'fbaFee',       pos: 35, width: '96px'  }, // FBA販売手数料
  { id: 'storageFee',   pos: 36, width: '96px'  }, // 在庫保管料
];
const DEFAULT_COL_ORDER = MOVABLE_COLUMNS.map((c) => c.id);
let columnOrder = DEFAULT_COL_ORDER.slice();
let dragColId = null;

function colById(id) { return MOVABLE_COLUMNS.find((c) => c.id === id); }

// Keep only known ids (no dupes), then append any columns missing from the
// saved order in their default slot — so a future new column still appears
// even if an older saved order predates it.
function normalizeColumnOrder(order) {
  const seen = new Set();
  const out = [];
  for (const id of (Array.isArray(order) ? order : [])) {
    if (colById(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  for (const c of MOVABLE_COLUMNS) if (!seen.has(c.id)) out.push(c.id);
  return out;
}

// Realize the current columnOrder: inject grid-template-columns (3 fixed
// widths + movable widths in visual order) and per-cell `order` so the
// (unchanged) DOM lays out in that order. Applies to header + every row.
function applyColumnOrder() {
  const widths = FIXED_COL_WIDTHS.concat(columnOrder.map((id) => colById(id).width));
  let rules = `.viewer-row{grid-template-columns:${widths.join(' ')};}`;
  // Fixed sticky cols keep slots 1–3; movable cols follow in visual order.
  rules += '.viewer-row>div:nth-child(1){order:1;}';
  rules += '.viewer-row>div:nth-child(2){order:2;}';
  rules += '.viewer-row>div:nth-child(3){order:3;}';
  columnOrder.forEach((id, i) => {
    rules += `.viewer-row>div:nth-child(${colById(id).pos}){order:${4 + i};}`;
  });
  let styleEl = document.getElementById('viewer-col-order');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'viewer-col-order';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = rules;
}

async function loadColumnOrderPref() {
  try {
    const v = await window.api.invoke('getSetting', { key: 'viewer.columnOrder' });
    if (v) columnOrder = normalizeColumnOrder(JSON.parse(v));
  } catch (e) { console.warn('loadColumnOrderPref:', e); }
  applyColumnOrder();
}

function saveColumnOrderPref() {
  window.api.invoke('setSetting', {
    key: 'viewer.columnOrder', value: JSON.stringify(columnOrder),
  }).catch((e) => console.warn('saveColumnOrderPref:', e));
}

// 「列配置初期化」 — restore the default order (non-destructive).
function resetColumnOrder() {
  columnOrder = DEFAULT_COL_ORDER.slice();
  applyColumnOrder();
  saveColumnOrderPref();
}

// Attach HTML5 drag handlers to the movable header cells (those carrying
// data-col). Called at the end of every renderHeader() since the header
// innerHTML is replaced on view flips / label refreshes.
function addColumnDragHandlers() {
  const thead = $('#viewer-thead');
  if (!thead) return;
  thead.querySelectorAll('div[data-col]').forEach((cell) => {
    cell.setAttribute('draggable', 'true');
    cell.addEventListener('dragstart', onColDragStart);
    cell.addEventListener('dragover',  onColDragOver);
    cell.addEventListener('dragleave', onColDragLeave);
    cell.addEventListener('drop',      onColDrop);
    cell.addEventListener('dragend',   onColDragEnd);
  });
}
function clearColDropMarkers() {
  const thead = $('#viewer-thead');
  if (!thead) return;
  thead.querySelectorAll('.col-drop-before, .col-drop-after')
    .forEach((el) => el.classList.remove('col-drop-before', 'col-drop-after'));
}
function onColDragStart(e) {
  dragColId = e.currentTarget.dataset.col;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragColId); } catch (_) { /* noop */ }
  e.currentTarget.classList.add('col-dragging');
}
function onColDragOver(e) {
  if (!dragColId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const cell = e.currentTarget;
  clearColDropMarkers();
  if (cell.dataset.col === dragColId) return;
  const rect = cell.getBoundingClientRect();
  const after = (e.clientX - rect.left) > rect.width / 2;
  cell.classList.add(after ? 'col-drop-after' : 'col-drop-before');
}
function onColDragLeave(e) {
  e.currentTarget.classList.remove('col-drop-before', 'col-drop-after');
}
function onColDrop(e) {
  if (!dragColId) return;
  e.preventDefault();
  const cell = e.currentTarget;
  const targetId = cell.dataset.col;
  const after = cell.classList.contains('col-drop-after');
  clearColDropMarkers();
  if (targetId && targetId !== dragColId) {
    const from = columnOrder.indexOf(dragColId);
    if (from !== -1) columnOrder.splice(from, 1);
    let to = columnOrder.indexOf(targetId);
    if (after) to += 1;
    columnOrder.splice(to, 0, dragColId);
    applyColumnOrder();
    saveColumnOrderPref();
  }
}
function onColDragEnd() {
  clearColDropMarkers();
  const thead = $('#viewer-thead');
  const d = thead && thead.querySelector('.col-dragging');
  if (d) d.classList.remove('col-dragging');
  dragColId = null;
}

// The header columns differ between active and trash views (trash
// adds a "ゴミ捨て日時" column and a "サイト起動" link, drops the
// per-row group cell). Re-render whenever view mode flips.

function renderHeader() {
  const thead = $('#viewer-thead');
  if (!thead) return;
  const headerCb = '<button type="button" id="viewer-header-checkbox" class="header-select-all" title="すべて選択 / 解除">すべて</button>';
  // 36 cells — must match the .viewer-row grid-template-columns.
  // 先頭の固定列 (3) + 通知履歴3列 + 登録日時 が active/trash で異なり、列8以降
  // (商品写真〜在庫保管料) は commonHeaderHtml() で共通。列順は spec デフォルト並び。
  // 通知履歴3列ヘッダー (項目29) — active/trash 共通。data-col で並び替え対象。
  const notifyHeaders = `
      <div data-col="notifyLast">最新通知日時</div>
      <div data-col="notifyCount">通知ヒット<span class="col-sub">総回数</span></div>
      <div data-col="notifyGap">通知なし<span class="col-sub">経過日数</span></div>`;
  if (viewMode === 'trash') {
    thead.innerHTML = `
      <div class="cell-check">${headerCb}</div>
      <div>サイト起動</div>
      <div>ゴミ捨て日時</div>
      ${notifyHeaders}
      <div data-col="regdate">最新取得日時</div>
      ${commonHeaderHtml()}
    `;
  } else {
    thead.innerHTML = `
      <div class="cell-check">${headerCb}</div>
      <div>グループ</div>
      <div>最新取得日時</div>
      ${notifyHeaders}
      <div data-col="regdate">登録日時</div>
      ${commonHeaderHtml()}
    `;
  }
  // Make the movable header cells (col 4–31) drag-reorderable.
  addColumnDragHandlers();
}

// ── Bulk toolbar ──────────────────────────────────────────
//
// Visible only when at least one row is selected. Action buttons differ
// between active and trash views — active offers Trash + Group + Export
// + Start; trash offers Restore + Permanent-delete + Start.

function renderBulkToolbar() {
  const toolbar = $('#bulk-toolbar');
  if (!toolbar) return;
  const n = selected.size;
  // Two distinct counts the user needs to see:
  //   total    = everything they've ✅ticked, regardless of filter
  //   visible  = the intersection with the current filter — this is the
  //              real working set for 監視スタート (which intersects
  //              selected ∩ filtered before sending to the scheduler)
  // When they differ, show "visible / total" so the user can spot a
  // pre-filter selection that would otherwise silently drag in hidden
  // products.
  const visibleSet = new Set(filtered.map((p) => p.asin));
  const visibleSelected = [...selected].filter((a) => visibleSet.has(a)).length;
  const countLabel = $('#bulk-selected-count');
  if (countLabel) {
    countLabel.textContent = (n === visibleSelected)
      ? String(n)
      : `${visibleSelected} / ${n}`;
  }
  const headBtn = $('#viewer-header-checkbox');
  if (headBtn) {
    const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.asin));
    headBtn.classList.toggle('active', allSelected);
  }
  const actions = $('#bulk-toolbar-actions');
  const head    = toolbar.querySelector('.bulk-toolbar-head');

  // While the scheduler is running, the spec says: hide the bulk-action
  // frame and show 「監視ストップ」 in its place. The selection counter
  // line is also hidden because no bulk action can run during a scrape.
  if (lastKnownRunning) {
    if (head) head.classList.add('hidden');
    actions.classList.add('bulk-toolbar-actions-stopmode');
    actions.innerHTML = `
      <button class="bulk-action-btn bulk-action-stop" data-bulk-action="stop">監視ストップ</button>
    `;
    actions.querySelector('[data-bulk-action]').addEventListener('click', () => onBulkAction('stop'));
    return;
  }

  // Stopped: render the normal frame.
  if (head) head.classList.remove('hidden');
  actions.classList.remove('bulk-toolbar-actions-stopmode');
  // Buttons are always rendered so users see what's available; they're
  // just disabled when nothing is checked. Two button sets — active vs.
  // trash view — match the operations available in each context.
  const dis = n === 0 ? 'disabled' : '';
  // 監視スタート has a tighter requirement: at least one ticked product
  // must also be visible (it scrapes the intersection, not the raw
  // selection). Disable it specifically when the intersection is empty
  // even if other tickbox-only actions remain available.
  const startDis = visibleSelected === 0 ? 'disabled' : '';
  // Tooltip hint when the start button would scrape fewer than the user
  // ticked — surfaces the filter intersection so it's not a surprise.
  const startTitle = (n > 0 && visibleSelected !== n)
    ? `title="フィルタ通過の ${visibleSelected} 件のみ scrape されます (✅選択 ${n} 件中)"`
    : '';
  if (viewMode === 'trash') {
    // Per spec image: trash bulk-action set is just 3 buttons —
    // 監視スタート (green) / 監視対象に戻す (blue) / 完全に削除 (red).
    // 完全削除 wipes the product AND all observation history; the
    // confirm dialog reflects that.
    actions.innerHTML = `
      <button class="bulk-action-btn bulk-action-start"   data-bulk-action="start"      ${startDis} ${startTitle}>監視スタート</button>
      <button class="bulk-action-btn bulk-action-amazon"  data-bulk-action="openAmazon" ${dis}>Amazon商品詳細サイト</button>
      <button class="bulk-action-btn bulk-action-restore" data-bulk-action="restore"    ${dis}>監視対象に戻す</button>
      <button class="bulk-action-btn bulk-action-harddel" data-bulk-action="hardDelete" ${dis}>完全に削除</button>
    `;
  } else {
    actions.innerHTML = `
      <button class="bulk-action-btn bulk-action-start"  data-bulk-action="start"      ${startDis} ${startTitle}>監視スタート</button>
      <button class="bulk-action-btn bulk-action-amazon" data-bulk-action="openAmazon" ${dis}>Amazon商品詳細サイト</button>
      <button class="bulk-action-btn bulk-action-group"  data-bulk-action="groupOpen"  ${dis}>グループ登録</button>
      <button class="bulk-action-btn bulk-action-notify-set"   data-bulk-action="notifyPriceSet"   ${dis}>通知価格の設定</button>
      <button class="bulk-action-btn bulk-action-notify-reset" data-bulk-action="notifyPriceReset" ${dis}>通知価格のリセット</button>
      <button class="bulk-action-btn bulk-action-export" data-bulk-action="export"     ${dis}>エクスポート</button>
      <button class="bulk-action-btn bulk-action-delete" data-bulk-action="trash"      ${dis}>削除</button>
    `;
  }

  // Wire buttons (data-bulk-action dispatched through onBulkAction).
  actions.querySelectorAll('[data-bulk-action]').forEach((btn) => {
    btn.addEventListener('click', () => onBulkAction(btn.dataset.bulkAction));
  });
}

async function onBulkAction(action) {
  // 'stop' is the one action that doesn't require any ✅checked
  // products — it's available only while the scheduler is running.
  if (action === 'stop') {
    await window.api.invoke('stopScraping');
    await refreshStatus();
    return;
  }

  const asins = [...selected];
  if (asins.length === 0) return;

  switch (action) {
    case 'start': {
      // 監視スタート honours BOTH the ✅check state AND the active
      // filter — the user's working set is "what they see AND what
      // they ticked". A check on a hidden product is treated as a
      // no-op so an old pre-filter selection doesn't silently drag
      // 2,372 products into the scrape rotation when the visible
      // filtered list is only 189.
      const visibleAsins = new Set(filtered.map((p) => p.asin));
      const startAsins = asins.filter((a) => visibleAsins.has(a));
      if (startAsins.length === 0) {
        alert('対象商品がありません。\n\n現在のフィルタ条件と ✅選択 の積集合が空です。\nフィルタを緩めるか、表示中の商品を ✅して下さい。');
        return;
      }
      await window.api.invoke('startScraping', { asins: startAsins });
      await refreshStatus();
      // Keep the selection so the user can see what's being scraped;
      // 監視ストップ will return them to the editing toolbar.
      break;
    }
    case 'groupOpen':
      // Re-uses the per-row group picker but in bulk mode — applies
      // the chosen group to every checked ASIN at once.
      openGroupPicker(asins);
      break;
    case 'trash':
      if (!confirm(`${asins.length} 件をゴミ箱に移動しますか?`)) return;
      await window.api.invoke('softDelete', { asins });
      selected.clear();
      await loadProducts();
      await refreshStatus();
      break;
    case 'restore':
      await window.api.invoke('restore', { asins });
      selected.clear();
      await loadProducts();
      await refreshStatus();
      break;
    case 'hardDelete':
      // Spec: 「完全削除はゴミ箱からも完全にデータ (全ての監視データ含
      // めて) を削除する操作」 — irreversible; warn explicitly.
      if (!confirm(
        `${asins.length} 件をゴミ箱から完全に削除しますか?\n` +
        `全ての監視データ (観測履歴・日次集計など) も削除され、復元できません。`
      )) return;
      await window.api.invoke('hardDelete', { asins });
      selected.clear();
      await loadProducts();
      await refreshStatus();
      break;
    case 'export':
      exportSelectedToCsv(asins);
      break;

    // 通知価格の一括設定 — モーダルを開いて、計算方式 + % 値を入力させる。
    // 実行ボタンで openNotifyPriceSetModal 内のロジックが各 ASIN に対し
    // 計算 → setNotifyPrice IPC → 行表示更新を行う。
    case 'notifyPriceSet':
      openNotifyPriceSetModal(asins);
      break;
    case 'notifyPriceReset':
      openNotifyPriceResetModal(asins);
      break;

    case 'openAmazon': {
      // ✅商品それぞれの Amazon 商品詳細サイトを既定ブラウザで一括起動。
      // 一度に大量のタブを開くと OS / ブラウザ側に負荷がかかるため、
      // クライアント仕様で 20 件に制限している。超過時はアラートのみ。
      const MAX_OPEN = 20;
      if (asins.length > MAX_OPEN) {
        alert(
          `✅している商品を${MAX_OPEN}個以下にしてください。\n\n` +
          `現在 ${asins.length} 件選択中です。\n` +
          `一度に開けるのは ${MAX_OPEN} 件までです。`
        );
        return;
      }
      // 並列で起動 — shell.openExternal は非ブロッキングなので
      // Promise.all で投げてもブラウザ側がタブを順次受け取る。
      await Promise.all(
        asins.map((asin) => window.api.invoke('openProductPage', { asin })),
      );
      break;
    }
  }
}

// CSV export — column set matches the spec's "エクスポート" list
// (No., KeepaグラフURL, 写真URL, 商品名, ASIN, 最新価格, ポイント, 実質最新価格, …).
async function exportSelectedToCsv(asins) {
  const rows = [['No.', 'KeepaグラフURL', '写真URL', '商品名', 'ASIN',
                 '最新BuyBox価格', 'ポイント', '実質最新BuyBox価格',
                 '出品者数', '状態', '発送情報', '他の出品価格',
                 '1日平均', '7日平均', '30日平均', '90日平均', '180日平均',
                 '最新取得日時', '登録日時', 'グループ']];
  let no = 1;
  for (const asin of asins) {
    const idx = productIndex.get(asin);
    if (idx == null) continue;
    const p = allProducts[idx];
    let stats = statsCache.get(asin);
    if (!stats) stats = await window.api.invoke('getProductStatsTable', { asin });
    const groupName = (cachedGroups.find((g) => g.id === p.group_id) || {}).name || '';
    const keepa = `https://graph.keepa.com/pricehistory.png?asin=${asin}&domain=co.jp&range=90`;
    // 実質最新価格 = BuyBox − ポイント + 送料 (2026-05 fix)。CSV エクスポート
    // でも UI と同じ式を使用する。送料が null の商品は加算なし。
    const eff = (p.last_price != null)
      ? p.last_price - (p.last_points || 0) + (p.last_shipping_fee || 0)
      : '';
    rows.push([
      no++, keepa, p.image_url || '', p.title || '', asin,
      p.last_price ?? '', p.last_points ?? '', eff,
      p.last_mp_count ?? '', p.last_mp_condition || '', p.last_delivery || '',
      p.last_mp_price ?? '',
      stats?.avg1d ?? '', stats?.avg7d ?? '', stats?.avg30d ?? '', stats?.avg90d ?? '', stats?.avg180d ?? '',
      p.last_observed_at ? new Date(p.last_observed_at).toISOString() : '',
      p.added_at ? new Date(p.added_at).toISOString() : '',
      groupName,
    ]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  // BOM + UTF-8 so Excel opens Japanese correctly.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `amazon-monitor-export-${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ── Group management modal ────────────────────────────────

async function openGroupModal() {
  await renderGroupList();
  $('#group-modal').classList.remove('hidden');
  $('#group-new-name').focus();
}

function closeGroupModal() {
  $('#group-modal').classList.add('hidden');
}

// ── Row-level group picker (per-product 登録 / 変更) ────────
//
// Opened from the per-row 登録/変更 button. Shows the cached group list
// plus a 未分類に戻す option; clicking an entry calls assignGroup for
// just this product, then refreshes the row.

let rowGroupTargetAsins = [];   // array — single-row picks pass [asin]

// Per-row entrypoint — keeps the original single-ASIN signature.
function openRowGroupModal(asin) {
  openGroupPicker([asin]);
}

// Bulk entrypoint — same modal but applies to N ASINs.
function openGroupPicker(asins) {
  rowGroupTargetAsins = Array.isArray(asins) ? asins.slice() : [];
  if (rowGroupTargetAsins.length === 0) return;

  // For a single target, highlight its current group; for bulk, only
  // highlight if every selected product shares the same group, else
  // leave nothing highlighted (mixed state).
  let currentGid;
  if (rowGroupTargetAsins.length === 1) {
    const product = allProducts.find((p) => p.asin === rowGroupTargetAsins[0]);
    currentGid = product ? product.group_id : null;
  } else {
    const gids = new Set(rowGroupTargetAsins.map((a) => {
      const p = allProducts.find((x) => x.asin === a);
      return p ? p.group_id : null;
    }));
    currentGid = gids.size === 1 ? [...gids][0] : Symbol('mixed');
  }

  const target = $('#row-group-target');
  if (rowGroupTargetAsins.length === 1) {
    target.textContent = `ASIN: ${rowGroupTargetAsins[0]}`;
  } else {
    target.textContent = `${rowGroupTargetAsins.length} 件の商品にグループを設定`;
  }

  const list = $('#row-group-list');
  if (list) {
    // The picker shows 「未分類」 + every group slot, labeled with its
    // No.X slot prefix. Empty-named slots are still selectable so the
    // user can stage products into a slot before naming it from the
    // グループ名設定 modal.
    const items = [
      `<li class="row-group-item ${currentGid == null ? 'current' : ''}" data-row-gid="0">未分類</li>`,
      ...cachedGroups.slice(0, 20).map((g, i) => {
        const slotNo = i + 1;
        const name   = (g.name || '').trim();
        const label  = name ? `No.${slotNo} ${escapeHtml(name)}` : `No.${slotNo}`;
        return `
          <li class="row-group-item ${g.id === currentGid ? 'current' : ''}" data-row-gid="${g.id}">
            ${label}
            <span class="row-group-count">${g.member_count || 0}</span>
          </li>
        `;
      }),
    ];
    list.innerHTML = items.join('');
  }
  $('#row-group-modal').classList.remove('hidden');
}

function closeRowGroupModal() {
  $('#row-group-modal').classList.add('hidden');
  rowGroupTargetAsins = [];
}

async function onRowGroupPick(e) {
  const li = e.target.closest('[data-row-gid]');
  if (!li || rowGroupTargetAsins.length === 0) return;
  const raw = li.dataset.rowGid;
  // value 0 → un-group (NULL); otherwise assign to that group id.
  const gid = raw === '0' ? null : Number(raw);
  const asins = rowGroupTargetAsins.slice();
  const wasBulk = asins.length > 1;
  closeRowGroupModal();
  await window.api.invoke('assignGroup', { asins, groupId: gid });
  if (wasBulk) selected.clear();
  await loadProducts();
}

// v3 spec: 20 group slots are always present (auto-created via
// ensureGroupSlots). The rename modal shows one row per slot, each
// row has a name input + member count + クリア button (which
// blanks the slot's name and un-assigns its products).
async function renderGroupList() {
  const list = $('#group-list');
  if (!list) return;
  // Make sure 20 slots exist before rendering (idempotent).
  try { await window.api.invoke('ensureGroupSlots', { count: 20 }); }
  catch { /* ignore */ }
  const groups = await window.api.invoke('getGroups');
  cachedGroups = Array.isArray(groups) ? groups : [];
  const items = cachedGroups.slice(0, 20).map((g, i) => `
    <li class="group-row" data-group-id="${g.id}">
      <span class="grp-num">No.${i + 1}</span>
      <input class="grp-input" type="text" value="${escapeHtml(g.name || '')}" data-grp-id="${g.id}" placeholder="(空き)">
      <span class="grp-count">${g.member_count || 0} 件</span>
      <button class="grp-del btn-link" data-grp-del="${g.id}" title="名前と所属商品をクリア">クリア</button>
    </li>
  `);
  list.innerHTML = items.join('');
  list.querySelectorAll('[data-grp-del]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onDeleteGroup(parseInt(b.dataset.grpDel, 10));
    });
  });
}

// Single 保存 button commits all 20 name edits at once. Each input is
// renamed only if the value actually changed; empty-string names are
// allowed (slot stays as "No.X" with no display name).
async function onSaveAllGroupNames() {
  const list = $('#group-list');
  if (!list) return;
  const renames = [];
  list.querySelectorAll('input[data-grp-id]').forEach((inp) => {
    const id   = parseInt(inp.dataset.grpId, 10);
    const cur  = cachedGroups.find((g) => g.id === id);
    const next = inp.value.trim();
    if (cur && next !== (cur.name || '')) renames.push({ id, name: next });
  });
  for (const r of renames) {
    await window.api.invoke('renameGroup', { id: r.id, name: r.name });
  }
  await renderGroupList();
  await refreshGroups();
}

async function onDeleteGroup(id) {
  const cur  = cachedGroups.find((g) => g.id === id);
  const name = (cur?.name || '').trim();
  const msg  = name
    ? `グループ「${name}」をクリアしますか?\n名前と所属商品の登録が解除されます。`
    : `この枠の所属商品を未分類に戻しますか?`;
  if (!confirm(msg)) return;
  await window.api.invoke('deleteGroup', { id });
  await renderGroupList();
  await refreshGroups();
  await loadProducts();
}

// ── FNM rule engine (v2) ────────────────────────────────────
//
// v2 spec moves from "20 free condition slots" to a structured filter
// state with three distinct sections:
//
//   1. mpCount    — 5 windows × {enabled, min, max}
//                   (現在 / 7日平均 / 30日平均 / 90日平均 / 180日平均)
//   2. keyword    — 4 fields × {enabled, query}
//                   (asin include, asin exclude, title include, title exclude)
//                   query syntax: "a b" → AND "a" AND "b"; "a、b" → "a" OR "b";
//                                 mixed "a b、c" → ("a" AND "b") OR "c"
//   3. legacy     — array of {enabled, min, max} for the v1 point-range
//                   catalog rules; still used for actual rule evaluation
//                   (auto-trash / notification triggers).
//
// One state shape covers all three FNM tabs (filter / maint / notif)
// and is also the shape stored in custom-filter slots and presets.

// Default empty filter state.
function emptyFnmState() {
  const range = () => ({ enabled: false, min: null, max: null });
  const kw    = () => ({ enabled: false, query: '' });
  return {
    mpCount: {
      current: range(), d7: range(), d30: range(), d90: range(), d180: range(),
    },
    // Spec: 実質BuyBox価格の N日平均下落率 = (avgN − latest) ÷ avgN × 100
    // Plus a delta row d7m180 = drop_7d − drop_180d.
    // Plus 'instant': 瞬間下落率 — uses the immediately previous
    // observation rather than an averaged window.
    dropRate: {
      instant: range(),
      d1: range(), d7: range(), d30: range(), d90: range(), d180: range(),
      d7m180: range(),
    },
    keyword: {
      asinInclude: kw(), asinExclude: kw(),
      titleInclude: kw(), titleExclude: kw(),
    },
    // 範囲フィルタ (2026-06 client spec): 日時 / 価格 / 月間販売数 などの
    // 絶対値範囲。下落率 (=パーセンテージ比較) や mpCount (出品者数) とは
    // 別カテゴリで「値そのものが範囲内」のチェックを行う。
    //   - 日時系 (addedAt, lastObservedAt): ms タイムスタンプ
    //   - 価格系 (price, shippingFee, effective, mpPrice, avgEff*): 円
    //   - 月間販売数 (monthlySales): 個数
    ranges: {
      addedAt:        range(),
      lastObservedAt: range(),
      price:          range(),
      shippingFee:    range(),
      effective:      range(),
      mpPrice:        range(),
      avgEff1d:       range(),
      avgEff7d:       range(),
      avgEff30d:      range(),
      avgEff90d:      range(),
      avgEff180d:     range(),
      monthlySales:   range(),
    },
    // OR グループ (B9): ランキング/月間販売数/30日ランク変動 を「いずれか1つでも
    // 合致で抽出」する OR 評価にするフラグ。既定 false (= 従来どおり AND)。
    rankGroupOr: false,
    legacy: new Array(20).fill(null).map(() => ({ enabled: false, min: null, max: null })),
  };
}

// ── Legacy condition catalog (price/points rules) ──────────
// Kept as v1: 2 defined entries, slots 3-20 are TBD placeholders.

const CONDITION_CATALOG = [
  {
    label:  'ポイントが',
    sep:    '〜',
    suffix: 'pt',
    step:   '1',
    evaluate(p, s) {
      if (p.last_points == null) return false;
      const min = (s.min == null || !isFinite(s.min)) ? -Infinity : s.min;
      const max = (s.max == null || !isFinite(s.max)) ?  Infinity : s.max;
      return p.last_points >= min && p.last_points <= max;
    },
  },
  {
    label:  'ポイント率(=ポイント÷最新BuyBox価格×100)が',
    sep:    '〜',
    suffix: '%',
    step:   '0.1',
    evaluate(p, s) {
      if (p.last_points == null || !p.last_price) return false;
      const rate = (p.last_points / p.last_price) * 100;
      const min = (s.min == null || !isFinite(s.min)) ? -Infinity : s.min;
      const max = (s.max == null || !isFinite(s.max)) ?  Infinity : s.max;
      return rate >= min && rate <= max;
    },
  },
];

// ── Keyword query parser ────────────────────────────────────
// "a b、c d、e" → [['a','b'], ['c','d'], ['e']]
// Outer = OR groups, inner = AND words.
function parseKeywordQuery(q) {
  if (!q) return [];
  const orGroups = String(q).split(/[、,]/);
  const out = [];
  for (const g of orGroups) {
    const words = g.split(/\s+/).map((w) => w.trim()).filter(Boolean);
    if (words.length > 0) out.push(words);
  }
  return out;
}

function matchesIncludeKeyword(text, query) {
  const groups = parseKeywordQuery(query);
  if (groups.length === 0) return true;
  const t = (text || '').toLowerCase();
  return groups.some((g) => g.every((w) => t.includes(w.toLowerCase())));
}

// "exclude" returns true if the text passes the filter (i.e. does not
// match the exclude query). An empty query passes everything.
function matchesExcludeKeyword(text, query) {
  const groups = parseKeywordQuery(query);
  if (groups.length === 0) return true;
  const t = (text || '').toLowerCase();
  // text is excluded if any OR-group fully matches.
  const blocked = groups.some((g) => g.every((w) => t.includes(w.toLowerCase())));
  return !blocked;
}

// ── Range helper ─────────────────────────────────────────────
function inRange(val, range) {
  if (val == null) return false;
  const min = (range.min == null || !isFinite(range.min)) ? -Infinity : range.min;
  const max = (range.max == null || !isFinite(range.max)) ?  Infinity : range.max;
  return val >= min && val <= max;
}

// ── Active-state detection ───────────────────────────────────
// True if the filter state contains at least one enabled control.
function hasAnyConditionEnabled(state) {
  if (!state || typeof state !== 'object') return false;
  // 全出品数(内訳) mpCount は項目17 で撤去 — 「有効な条件」として数えない。
  if (state.dropRate) {
    for (const k of ['instant', 'd1', 'd7', 'd30', 'd90', 'd180', 'd7m180']) {
      if (state.dropRate[k] && state.dropRate[k].enabled) return true;
    }
  }
  if (state.keyword) {
    for (const k of ['asinInclude', 'asinExclude', 'titleInclude', 'titleExclude']) {
      const v = state.keyword[k];
      if (v && v.enabled && v.query && v.query.trim() !== '') return true;
    }
  }
  // 範囲フィルタ — どれか 1 つでも enabled なら有効。
  if (state.ranges) {
    for (const row of RANGE_ROWS) {
      const v = state.ranges[row.key];
      if (v && v.enabled) return true;
    }
  }
  if (Array.isArray(state.legacy)) {
    for (let i = 0; i < state.legacy.length; i++) {
      if (state.legacy[i] && state.legacy[i].enabled && CONDITION_CATALOG[i]) return true;
    }
  }
  return false;
}

// AND-join: every checked control must pass for the product to qualify.
function passesAllConditions(product, state) {
  if (!state) return false;
  // mpCount: requires either statsCache mpCountAvgNd values or
  // product.last_mp_count for "current". Stats are populated lazily —
  // when missing we treat the row as not yet verifiable (false).
  const stats = statsCache.get(product.asin) || null;
  // 全出品数(内訳) の mpCount 条件は 2026-06 spec 項目17 で撤去。UI から削除し、
  // 旧保存状態に enabled が残っていても評価しない (= 完全に無効化)。
  if (state.dropRate) {
    // 下落率フィルタ評価用の実質価格も BuyBox − points + 送料 (2026-05 fix)。
    const latestEff = (product.last_price != null)
      ? (product.last_price - (product.last_points || 0) + (product.last_shipping_fee || 0))
      : null;
    for (const row of DROP_RATE_ROWS) {
      const r = state.dropRate[row.key];
      if (!r || !r.enabled) continue;
      const rate = computeDropRate(stats, latestEff, row.key);
      if (!inRange(rate, r)) return false;
    }
  }
  if (state.keyword) {
    const k = state.keyword;
    if (k.asinInclude.enabled  && !matchesIncludeKeyword(product.asin,    k.asinInclude.query))  return false;
    if (k.asinExclude.enabled  && !matchesExcludeKeyword(product.asin,    k.asinExclude.query))  return false;
    if (k.titleInclude.enabled && !matchesIncludeKeyword(product.title,   k.titleInclude.query)) return false;
    if (k.titleExclude.enabled && !matchesExcludeKeyword(product.title,   k.titleExclude.query)) return false;
  }
  // 範囲フィルタ (2026-06 client spec) — RANGE_ROWS の extract で値を
  // 取り出して inRange で min/max チェック。値が null (= 未取得 / 未設定)
  // なら inRange が false を返すので、未確定の商品は条件失敗扱い。
  if (state.ranges) {
    // OR グループ (B9): rankGroupOr が ON のとき、ランキング/月間販売数/30日ランク変動
    // は「有効な条件のうち1つでも一致」で通過 (他の範囲条件は AND のまま)。
    const orOn = !!state.rankGroupOr;
    let grpEnabled = false, grpMatched = false;
    for (const row of RANGE_ROWS) {
      const r = state.ranges[row.key];
      if (!r || !r.enabled) continue;
      const v = row.extract(product, stats);
      // ⑤「空白含む」(Ama本体出品割合): 値が空白 (null = 2点未満) の商品も通す。
      // includeBlank 既定 true。明示 false のときだけ空白を除外 (= inRange false)。
      const passes = (row.includeBlankOpt && v == null && r.includeBlank !== false)
        ? true
        : inRange(v, r);
      if (orOn && RANK_OR_GROUP_KEYS.includes(row.key)) {
        grpEnabled = true;
        if (passes) grpMatched = true;
      } else if (!passes) {
        return false;
      }
    }
    // OR グループに有効条件があり、どれも一致しなければ除外。
    if (orOn && grpEnabled && !grpMatched) return false;
  }
  if (Array.isArray(state.legacy)) {
    for (let i = 0; i < state.legacy.length; i++) {
      const s = state.legacy[i];
      if (!s || !s.enabled) continue;
      const cat = CONDITION_CATALOG[i];
      if (!cat) continue;
      if (!cat.evaluate(product, s)) return false;
    }
  }
  return true;
}

// ── Migration + parsing ──────────────────────────────────────
// Older saved state was a 20-element array of {enabled, min, max}.
// The new shape is the structured object emptyFnmState() returns.
// migration: legacy array → { ..., legacy: array } with empty mpCount/keyword.
function parseFnmState(raw) {
  try {
    const data = raw ? JSON.parse(raw) : null;
    if (!data) return emptyFnmState();
    if (Array.isArray(data)) {
      // v1 format — promote into legacy slot.
      const out = emptyFnmState();
      out.legacy = data.map((item) => {
        if (typeof item === 'boolean') return { enabled: item, min: null, max: null };
        if (item && typeof item === 'object') {
          return {
            enabled: !!item.enabled,
            min: typeof item.min === 'number' && isFinite(item.min) ? item.min : null,
            max: typeof item.max === 'number' && isFinite(item.max) ? item.max : null,
          };
        }
        return { enabled: false, min: null, max: null };
      });
      // Pad/truncate to 20.
      while (out.legacy.length < 20) out.legacy.push({ enabled: false, min: null, max: null });
      out.legacy = out.legacy.slice(0, 20);
      return out;
    }
    // Structured v2 — fill in any missing pieces with defaults.
    const out = emptyFnmState();
    if (data.mpCount) {
      for (const k of ['current', 'd7', 'd30', 'd90', 'd180']) {
        const src = data.mpCount[k];
        if (src && typeof src === 'object') {
          out.mpCount[k] = {
            enabled: !!src.enabled,
            min: typeof src.min === 'number' && isFinite(src.min) ? src.min : null,
            max: typeof src.max === 'number' && isFinite(src.max) ? src.max : null,
          };
        }
      }
    }
    if (data.dropRate) {
      for (const k of ['instant', 'd1', 'd7', 'd30', 'd90', 'd180', 'd7m180']) {
        const src = data.dropRate[k];
        if (src && typeof src === 'object') {
          out.dropRate[k] = {
            enabled: !!src.enabled,
            min: typeof src.min === 'number' && isFinite(src.min) ? src.min : null,
            max: typeof src.max === 'number' && isFinite(src.max) ? src.max : null,
          };
        }
      }
    }
    if (data.keyword) {
      for (const k of ['asinInclude', 'asinExclude', 'titleInclude', 'titleExclude']) {
        const src = data.keyword[k];
        if (src && typeof src === 'object') {
          out.keyword[k] = {
            enabled: !!src.enabled,
            query: typeof src.query === 'string' ? src.query : '',
          };
        }
      }
    }
    // 範囲フィルタ (2026-06 client spec)
    if (data.ranges && typeof data.ranges === 'object') {
      for (const row of RANGE_ROWS) {
        const src = data.ranges[row.key];
        if (src && typeof src === 'object') {
          out.ranges[row.key] = {
            enabled: !!src.enabled,
            min: typeof src.min === 'number' && isFinite(src.min) ? src.min : null,
            max: typeof src.max === 'number' && isFinite(src.max) ? src.max : null,
          };
          // ⑤「空白含む」(Ama本体出品割合のみ)。保存値が無ければ既定 true。
          if (row.includeBlankOpt) {
            out.ranges[row.key].includeBlank = (src.includeBlank === false) ? false : true;
          }
        }
      }
    }
    // OR グループ (B9) — ランキング/月間販売数/30日ランク変動 の OR 評価フラグ。
    out.rankGroupOr = !!data.rankGroupOr;
    if (Array.isArray(data.legacy)) {
      out.legacy = data.legacy.slice(0, 20).map((item) => ({
        enabled: !!(item && item.enabled),
        min: item && typeof item.min === 'number' && isFinite(item.min) ? item.min : null,
        max: item && typeof item.max === 'number' && isFinite(item.max) ? item.max : null,
      }));
      while (out.legacy.length < 20) out.legacy.push({ enabled: false, min: null, max: null });
    }
    return out;
  } catch {
    return emptyFnmState();
  }
}

// Module-level cache of the filter state per context (active / trash).
// Used by the viewer's applyFilter to narrow the displayed product list.
// Notification / auto-trash behaviour is NOT driven from here anymore —
// those moved to the per-slot toggles on fnmCustomCache.
const fnmStateCache = {
  active: { filter: emptyFnmState() },
  trash:  { filter: emptyFnmState() },
};
// Custom-slot caches — the applyPriceUpdates loop walks these to honour
// the per-slot 通知 / 自動ゴミ捨て toggles without an IPC per product.
const fnmCustomCache = {
  active: [],
  trash:  [],
};

async function loadFnmStateCache() {
  const get = (k) => window.api.invoke('getSetting', { key: k });
  const [af, tf, ac, tc] = await Promise.all([
    get('fnm.filter'),
    get('trashFnm.filter'),
    get('fnm.customFilters'),
    get('trashFnm.customFilters'),
  ]);
  fnmStateCache.active.filter = parseFnmState(af);
  fnmStateCache.trash.filter  = parseFnmState(tf);
  fnmCustomCache.active = parseSlotArray(ac, 14);
  fnmCustomCache.trash  = parseSlotArray(tc, 14);
}

// Debounced product-list reload after an auto-action (auto-trash,
// auto-permanent-delete) so that multiple events within a short
// burst coalesce into a single getProducts IPC.
let pendingReloadTimer = null;
function scheduleAutoReload() {
  if (pendingReloadTimer) return;
  pendingReloadTimer = setTimeout(() => {
    pendingReloadTimer = null;
    loadProducts().catch(() => {});
  }, 800);
}

// ── フィルタ・通知・メンテナンス設定 (v2 modal) ─────────────────
//
// Modal layout: header → tabs → 2-pane body
//   LEFT pane (always present)
//     • action bar (全選択 / 全解除 / フィルタ実行 / リセット)
//     • 出品者数 ranges (5 windows)
//     • キーワード検索 (4 fields)
//     • Legacy point/points-rate conditions
//   RIGHT pane (filter tab only)
//     • おススメフィルタ ①② presets
//     • カスタムフィルタ ①〜⑭ user-defined slots
//
// Context-aware: opens against active or trash settings depending
// on the current viewMode. Persistence keys differ per context.

// Per-spec simplification (2026-05): 自動メンテナンス & 通知設定 tabs
// removed. The filter pane is the only tab and stores a single state
// per context. Notification and auto-trash behaviour comes exclusively
// from saved カスタムフィルタ slots, which carry their own toggles —
// allowing multiple independent rules to fire in parallel.
let fnmContext = 'active';
let fnmState = {
  filter: emptyFnmState(),
};
let fnmCustomFilters = [];   // 14 slots: { name, state, notifEnabled, autoTrashEnabled, savedAt }
let fnmPresets       = [];   // 2 slots:  { name, state }

const FNM_CONTEXT = {
  active: {
    title:       'フィルタ・通知・メンテナンス設定',
    headerTitle: '絞り込み検索',
    desc:        '「フィルタ実行」を押すと、左枠で✓を入れた各種条件を全て満たす商品のみ表示します。',
    keys: {
      filter:  'fnm.filter',
      custom:  'fnm.customFilters',
      presets: 'fnm.presets',
    },
  },
  trash: {
    title:       'ゴミ箱用フィルタ・通知・メンテナンス設定',
    headerTitle: 'ゴミ箱商品の絞り込み検索',
    desc:        '「フィルタ実行」を押すと、左枠で✓を入れた各種条件を全て満たすゴミ箱商品のみ表示します。',
    keys: {
      filter:  'trashFnm.filter',
      custom:  'trashFnm.customFilters',
      presets: 'trashFnm.presets',
    },
  },
};

// 「全出品数(内訳)」列 (= 旧 出品者数) のフィルタ行 (2026-06 spec 項目7-1)。
const MP_COUNT_ROWS = [
  { key: 'current', label: '現在の全出品数' },
  { key: 'd7',      label: '7日 平均の全出品数' },
  { key: 'd30',     label: '30日 平均の全出品数' },
  { key: 'd90',     label: '90日 平均の全出品数' },
  { key: 'd180',    label: '180日 平均の全出品数' },
];

const KEYWORD_ROWS = [
  { key: 'asinInclude',  label: 'ASINキーワード検索' },
  { key: 'asinExclude',  label: 'ASINキーワード除外検索' },
  { key: 'titleInclude', label: 'Amazon商品名キーワード検索' },
  { key: 'titleExclude', label: 'Amazon商品名キーワード除外検索' },
];

// 「直近でデータ取得できなかった期間」フィルタ (2026-06 spec 項目4) の基準値。
// 全商品の中で最も新しい last_observed_at (ms)。該当商品の last_observed_at が
// この基準から何日古いか = 在庫切れ等で再取得できていない経過日数。グローバル
// 集計なので per-row の extract には持たせず、評価パス直前に refreshNewestObserved()
// で更新して staleDaysOf() が参照する (recomputeFilterSnapshot / flushDirty が呼ぶ)。
// クロール停止中は基準も止まる = 経過日数は伸びない (クライアント定義どおり「相対」)。
let newestObservedAt = 0;
function refreshNewestObserved() {
  let mx = 0;
  for (const p of allProducts) {
    const t = p.last_observed_at;
    if (t != null && t > mx) mx = t;
  }
  newestObservedAt = mx;
}
function staleDaysOf(p) {
  if (newestObservedAt <= 0 || !p || p.last_observed_at == null) return null;
  const diff = newestObservedAt - p.last_observed_at;
  return diff > 0 ? Math.floor(diff / 86_400_000) : 0;
}

// 「いずれか一つの条件でも合致すれば抽出」OR グループ (2026-06 client B9)。
// この3キー (ランキング(取込)/月間販売数/30日ランク変動(取込)) は通常 AND だが、
// state.rankGroupOr が true のときは「有効な条件のうち1つでも一致すれば通過」の
// OR 評価にする (他の範囲条件は従来どおり AND)。RANGE_ROWS 上で連続している前提。
const RANK_OR_GROUP_KEYS = ['impRank', 'monthlySales', 'impRankDrop'];

// 範囲フィルタ (2026-06 client spec) — 絶対値の min/max 範囲指定。
// `kind` がインプット種類 / 単位 / 値抽出方法を決める。
//   - datetime: <input type="datetime-local">, ms timestamp で比較
//   - yen:      <input type="number">, 円 (整数)
//   - count:    <input type="number">, 個数 (整数)
// `extract(product, stats)` は対象行から評価対象値を取り出す関数。
const RANGE_ROWS = [
  { key: 'addedAt',        label: '登録日時',                     kind: 'datetime', suffix: '',  step: '1',
    extract: (p) => p.added_at },
  { key: 'lastObservedAt', label: '最新取得日時',                 kind: 'datetime', suffix: '',  step: '1',
    extract: (p) => p.last_observed_at },
  // 直近でデータ取得できなかった期間 (項目4) — 全商品で最も新しい「最新取得日時」を
  // 基準に、該当商品が何日古いか (在庫切れ等の未取得期間)。staleDaysOf がグローバル
  // 基準 newestObservedAt を参照する (評価前に refreshNewestObserved() で更新済み)。
  { key: 'staleDays',      label: '直近でデータ取得できなかった期間', kind: 'count',  suffix: '日', step: '1',
    extract: (p) => staleDaysOf(p) },
  // 通知履歴 (2026-06 spec 項目29/30) — 最新通知日時 / 通知ヒット総回数 / 通知なし経過日数。
  { key: 'notifyLast',     label: '最新通知日時',                 kind: 'datetime', suffix: '',  step: '1',
    extract: (p) => p.last_notified_at },
  { key: 'notifyCount',    label: '通知ヒット総回数',             kind: 'count',    suffix: '回', step: '1',
    extract: (p) => p.notify_hit_count },
  { key: 'notifyGap',      label: '通知なし経過日数',             kind: 'count',    suffix: '日', step: '1',
    extract: (p) => (p.last_notified_at != null
      ? Math.floor((Date.now() - p.last_notified_at) / 86_400_000) : null) },
  { key: 'price',          label: 'BuyBox価格',                   kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.last_price },
  { key: 'shippingFee',    label: '送料',                         kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.last_shipping_fee },
  { key: 'effective',      label: '最新実質BuyBox価格',           kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => (p.last_price != null)
      ? (p.last_price - (p.last_points || 0) + (p.last_shipping_fee || 0))
      : null },
  { key: 'avgEff1d',       label: '1日平均 実質BuyBox価格',       kind: 'yen',      suffix: '円', step: '1',
    extract: (p, s) => s ? s.avg1d   : null },
  { key: 'avgEff7d',       label: '7日平均 実質BuyBox価格',       kind: 'yen',      suffix: '円', step: '1',
    extract: (p, s) => s ? s.avg7d   : null },
  { key: 'avgEff30d',      label: '30日平均 実質BuyBox価格',      kind: 'yen',      suffix: '円', step: '1',
    extract: (p, s) => s ? s.avg30d  : null },
  { key: 'avgEff90d',      label: '90日平均 実質BuyBox価格',      kind: 'yen',      suffix: '円', step: '1',
    extract: (p, s) => s ? s.avg90d  : null },
  { key: 'avgEff180d',     label: '180日平均 実質BuyBox価格',     kind: 'yen',      suffix: '円', step: '1',
    extract: (p, s) => s ? s.avg180d : null },
  // Ama本体価格 / Ama本体出品割合(直近30日) (2026-06 spec 項目14/15/16)。
  { key: 'amazonCurrent',  label: 'Ama本体価格',                  kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.imp_amazon_current },
  // 割合は stats 依存 (2点未満は null)。includeBlankOpt: 「空白含む」チェック
  // ボックス付き (⑤) — ON(既定) なら値が空白(2点未満)の商品も範囲条件を通す。
  { key: 'amazonRatio',    label: 'Ama本体出品割合(直近30日)',    kind: 'count',    suffix: '%', step: '1',
    extract: (p, s) => (s ? s.amazonListingRatio30d : null), includeBlankOpt: true },
  { key: 'mpPrice',        label: '他の出品価格',                 kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.last_mp_price },
  // ── ランキング(取込) → 月間販売数 → 30日ランク変動(取込) の並び (2026-06 spec 項目10) ──
  { key: 'impRank',       label: 'ランキング(取込)',             kind: 'count',    suffix: '位', step: '1',
    extract: (p) => p.imp_rank },
  { key: 'monthlySales',   label: '月間販売数',                   kind: 'count',    suffix: '個', step: '1',
    // 監視/取込のうち取得日時が新しい方 (pickMonthlySales、項目3)。
    // 表示(monthlySalesText)・並び替え(SORT_EXTRACTORS)と同一ソース (項目6)。
    extract: (p) => pickMonthlySales(p) },
  { key: 'impRankDrop',   label: '30日ランク変動(取込)',         kind: 'count',    suffix: '',  step: '1',
    extract: (p) => p.imp_rank_drop_30d },
  { key: 'impSellers',    label: '新品出品数(取込)',             kind: 'count',    suffix: '',  step: '1',
    extract: (p) => p.imp_sellers },
  // FBA利益額 / ROE利益率 — 期間別 (瞬間/1/7/30/90/180、項目8)。stats 依存。
  // profitAmountForDays / profitRoeForDays は基準が欠損なら null → inRange が
  // false を返すので、未確定の商品は条件失敗扱い (安全側)。
  ...PROFIT_PERIODS.flatMap((pp) => [
    { key: pp.fA, label: `FBA利益額(${pp.label})`, kind: 'yen',   suffix: '円', step: '1',
      extract: (p, s) => profitAmountForDays(p, s, pp.days) },
    { key: pp.fR, label: `ROE利益率(${pp.label})`, kind: 'count', suffix: '%', step: '1',
      extract: (p, s) => profitRoeForDays(p, s, pp.days) },
  ]),
  { key: 'amazonFee',     label: 'Amazon販売手数料',             kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.amazon_fee },
  { key: 'fbaFee',        label: 'FBA販売手数料',                kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.fba_fee },
  { key: 'storageFee',    label: '在庫保管料',                   kind: 'yen',      suffix: '円', step: '1',
    extract: (p) => p.inventory_storage_fee },
];

// 範囲フィルタが stats を必要とするかどうか (= avgEff* / 利益指標 が enabled なら true)。
// ensureStatsLoaded の起動条件 (filterNeedsStats) を補強するために使う。
function rangesNeedStats(state) {
  if (!state || !state.ranges) return false;
  const keys = [
    'avgEff1d', 'avgEff7d', 'avgEff30d', 'avgEff90d', 'avgEff180d',
    // 期間別 FBA利益額 / ROE利益率 (項目8) も stats 依存。
    ...PROFIT_PERIODS.flatMap((pp) => [pp.fA, pp.fR]),
    // Ama本体出品割合 (項目15) も stats 依存。
    'amazonRatio',
  ];
  return keys.some((k) => state.ranges[k] && state.ranges[k].enabled);
}

// 下落率 conditions per spec. Each row corresponds to a window length
// (or, for d7m180, the difference between the 7-day and 180-day drop).
// `formula` is a sub-label shown beneath the row label.
// 'instant' (新規, v3 仕様) は他と異なり 1 個前の観測値との瞬間比較。
const DROP_RATE_ROWS = [
  { key: 'instant', label: '実質BuyBox価格の瞬間下落率',     formula: '(1個前の監視価格－最新価格) ÷ 1個前の監視価格 × 100' },
  { key: 'd1',    label: '実質BuyBox価格の1日平均下落率',   formula: '(1日平均価格－最新価格) ÷ 1日平均価格 × 100' },
  { key: 'd7',    label: '実質BuyBox価格の7日平均下落率',   formula: '(7日平均価格－最新価格) ÷ 7日平均価格 × 100' },
  { key: 'd30',   label: '実質BuyBox価格の30日平均下落率',  formula: '(30日平均価格－最新価格) ÷ 30日平均価格 × 100' },
  { key: 'd90',   label: '実質BuyBox価格の90日平均下落率',  formula: '(90日平均価格－最新価格) ÷ 90日平均価格 × 100' },
  { key: 'd180',  label: '実質BuyBox価格の180日平均下落率', formula: '(180日平均価格－最新価格) ÷ 180日平均価格 × 100' },
  { key: 'd7m180', label: '実質BuyBox価格の7日平均下落率－180日平均下落率', formula: '7日下落率 － 180日下落率 (パーセントポイント差)' },
];

// Drop rate fallback chain. When a window's average is null (insufficient
// data accumulated), we fall back to a shorter window per spec:
// 「平均期間分のデータが溜まっていない場合は、それより少ない平均期間
// の値を使用してフィルタ設定値と比較する。１日分のデータも溜まって
// いない場合は、全監視データの平均価格を使用」.
const DROP_RATE_FALLBACK = {
  d180: ['avg180d', 'avg90d', 'avg30d', 'avg7d', 'avg1d', 'avgAll'],
  d90:  ['avg90d',  'avg30d', 'avg7d',  'avg1d',  'avgAll'],
  d30:  ['avg30d',  'avg7d',  'avg1d',  'avgAll'],
  d7:   ['avg7d',   'avg1d',  'avgAll'],
  d1:   ['avg1d',   'avgAll'],
};

// Hard-coded おススメフィルタ presets. These are NOT user-editable —
// they're suggested condition sets the dev ships with the app. Pressing
// 「適用」 copies the recommended state into the left-pane filter; the
// user can then tweak and save to a custom slot. `notes` (配列) は ※
// 注記で、カードに必ず表記する (クライアント要望 項目18)。
//   ① 瞬間下落率 ≥1% + 30日ランク変動 ≥10 + 新品出品数 ≥2 + FBA利益額(7/30/90日) ≥100円
//   ② ① から瞬間下落率を除いた版 (ランク・出品数・利益で絞る)
//   ③ 自動ゴミ捨て用: 通知なし経過日数 ≥60日 (カスタム保存+自動ゴミ捨て推奨)
// range キーは RANGE_ROWS と一致させること: 30日ランク変動=impRankDrop /
// 新品出品数=impSellers / FBA利益額(N日平均)=profitAmt{7,30,90}d / 通知なし経過日数=notifyGap。
const PROFIT_FILTER_RULES = [
  { label: 'FBA利益額(7日平均)',  range: '100〜 円' },
  { label: 'FBA利益額(30日平均)', range: '100〜 円' },
  { label: 'FBA利益額(90日平均)', range: '100〜 円' },
];
const FBA_PROFIT_NOTE = '※FBA利益額(○○日平均)：○○日平均価格で売れた場合の利益';
function buildProfitFilterRanges(s) {
  s.ranges.profitAmt7d  = { enabled: true, min: 100, max: null };
  s.ranges.profitAmt30d = { enabled: true, min: 100, max: null };
  s.ranges.profitAmt90d = { enabled: true, min: 100, max: null };
}
const RECOMMENDED_PRESETS = [
  {
    name:  'おススメフィルタ①',
    notes: [FBA_PROFIT_NOTE],
    rules: [
      { label: '実質BuyBox価格の瞬間下落率', range: '1〜 %' },
      { label: '30日ランク変動(取込)',       range: '10〜 個' },
      { label: '新品出品数(取込)',           range: '2〜 人' },
      ...PROFIT_FILTER_RULES,
    ],
    build: () => {
      const s = emptyFnmState();
      s.dropRate.instant   = { enabled: true, min: 1,  max: null };
      s.ranges.impRankDrop = { enabled: true, min: 10, max: null };
      s.ranges.impSellers  = { enabled: true, min: 2,  max: null };
      buildProfitFilterRanges(s);
      return s;
    },
  },
  {
    name:  'おススメフィルタ②',
    notes: [FBA_PROFIT_NOTE],
    rules: [
      { label: '30日ランク変動(取込)', range: '10〜 個' },
      { label: '新品出品数(取込)',     range: '2〜 人' },
      ...PROFIT_FILTER_RULES,
    ],
    build: () => {
      const s = emptyFnmState();
      s.ranges.impRankDrop = { enabled: true, min: 10, max: null };
      s.ranges.impSellers  = { enabled: true, min: 2,  max: null };
      buildProfitFilterRanges(s);
      return s;
    },
  },
  {
    name:  'おススメフィルタ③（自動ゴミ捨て）',
    notes: [
      '※通知なし経過日数：直近の通知日から現在までの経過日数',
      '※カスタムフィルタに保存して自動ゴミ捨てを有効にすることを推奨',
    ],
    rules: [
      { label: '通知なし経過日数', range: '60〜 日間' },
    ],
    build: () => {
      const s = emptyFnmState();
      s.ranges.notifyGap = { enabled: true, min: 60, max: null };
      return s;
    },
  },
];

// Compute the drop rate (%) for the given window using the spec's
// fallback chain. Returns null if no average data exists at any level.
function computeDropRate(stats, latestEffective, key) {
  if (latestEffective == null || !isFinite(latestEffective)) return null;
  if (key === 'd7m180') {
    const r7   = computeDropRate(stats, latestEffective, 'd7');
    const r180 = computeDropRate(stats, latestEffective, 'd180');
    return (r7 == null || r180 == null) ? null : (r7 - r180);
  }
  if (key === 'instant') {
    // 仕様: (1個前の監視価格 − 最新価格) ÷ 1個前の監視価格 × 100。
    // フォールバック無し — 1個前の観測が存在しない (= 観測 1 件のみ) や
    // 値が 0 の場合は比較不能なので null を返し、評価器側では未判定 (=
    // 条件不一致) として扱う。
    const prev = stats ? stats.prevEffective : null;
    if (prev == null || !isFinite(prev) || prev === 0) return null;
    return ((prev - latestEffective) / prev) * 100;
  }
  const chain = DROP_RATE_FALLBACK[key] || [];
  for (const k of chain) {
    const v = stats ? stats[k] : null;
    if (v != null && isFinite(v) && v !== 0) {
      return ((v - latestEffective) / v) * 100;
    }
  }
  return null;
}

async function openFnmModal() {
  fnmContext = (viewMode === 'trash') ? 'trash' : 'active';
  const ctx = FNM_CONTEXT[fnmContext];

  // Update modal chrome to reflect context.
  $('#fnm-modal-title').textContent = ctx.headerTitle;

  // Load only filter state + slots + Discord URL. The maint/notif tab
  // settings keys (fnm.maint, fnm.notif, trashFnm.permaDelete, etc.)
  // are deliberately NOT read — those tabs are gone, replaced by the
  // per-custom-slot 通知 / 自動ゴミ捨て toggles.
  const [f, custom, presets] = await Promise.all([
    window.api.invoke('getSetting', { key: ctx.keys.filter }),
    window.api.invoke('getSetting', { key: ctx.keys.custom }),
    window.api.invoke('getSetting', { key: ctx.keys.presets }),
    loadDiscord(),
    loadKeepaApiKey(),
  ]);
  fnmState.filter  = parseFnmState(f);
  fnmCustomFilters = parseSlotArray(custom, 14);
  fnmPresets       = parseSlotArray(presets, 2);

  renderFnmTab();
  $('#fnm-modal').classList.remove('hidden');
}

function closeFnmModal() {
  $('#fnm-modal').classList.add('hidden');
}

// Slot array used by custom-filter and preset storage.
//   [{ name: 'カスタムフィルタ1', state: <FnmState>|null }, ...]
function parseSlotArray(raw, length) {
  const out = [];
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  for (let i = 0; i < length; i++) {
    const src = parsed && parsed[i] ? parsed[i] : null;
    out.push({
      name: src && typeof src.name === 'string' && src.name.trim()
        ? src.name
        : (length === 14 ? `カスタムフィルタ${i + 1}` : `おススメフィルタ${i + 1}`),
      state: src && src.state ? parseFnmState(JSON.stringify(src.state)) : null,
      // Per-slot toggles (custom slots only; presets ignore them).
      // Enabled only after the slot has been saved at least once
      // (state != null). Toggles drive evaluator behaviour:
      //   notifEnabled    → fire Discord on every match
      //   autoTrashEnabled → soft-delete the matching product
      notifEnabled:     !!(src && src.notifEnabled),
      autoTrashEnabled: !!(src && src.autoTrashEnabled),
      savedAt:          src && typeof src.savedAt === 'number' ? src.savedAt : null,
    });
  }
  return out;
}

// switchFnmTab kept as a no-op shim because a few internal callers
// (preset/custom apply/save) still invoke it. Behaviour is now: there
// is only ever the filter tab, so any tab name resolves to filter.
function switchFnmTab(_name) {
  renderFnmTab();
}

// Render the FNM modal body — only the filter pane exists now.
function renderFnmTab() {
  const ctx = FNM_CONTEXT[fnmContext];
  $('#fnm-tab-desc').textContent = ctx.desc;
  const state = fnmState.filter;

  renderMpCountGrid(state);
  renderDropRateGrid(state);
  renderRangesGrid(state);
  renderKeywordGrid(state);
  renderLegacyConditions(state);

  // Right pane (presets + custom slots) is always shown — filter pane
  // is the only pane now.
  const right = $('#fnm-right-pane');
  if (right) {
    if (true) {
      right.classList.remove('hidden');
      renderPresetSlots();
      renderCustomSlots();
    } else {
      right.classList.add('hidden');
    }
  }

  // Discord webhook section is always visible — its URL is now an
  // app-level setting consumed by every custom-filter slot whose 通知
  // toggle is ON, not a per-tab setting.
  const discord = $('#fnm-discord-section');
  if (discord) discord.classList.remove('hidden');
}

function renderMpCountGrid(state) {
  const grid = $('#fnm-mpcount-grid');
  if (!grid) return;
  grid.innerHTML = MP_COUNT_ROWS.map((row) => {
    const r = state.mpCount[row.key];
    return `
      <label class="fnm-range-row">
        <input type="checkbox" data-fnm-mp="${row.key}" ${r.enabled ? 'checked' : ''}>
        <span class="fnm-range-label">${escapeHtml(row.label)}</span>
        <input type="number" class="fnm-cond-input" data-fnm-mp-min="${row.key}" placeholder="最小" value="${r.min ?? ''}">
        <span class="fnm-range-sep">〜</span>
        <input type="number" class="fnm-cond-input" data-fnm-mp-max="${row.key}" placeholder="最大" value="${r.max ?? ''}">
        <span class="fnm-range-suffix">人</span>
      </label>
    `;
  }).join('');
}

function renderDropRateGrid(state) {
  const grid = $('#fnm-droprate-grid');
  if (!grid) return;
  grid.innerHTML = DROP_RATE_ROWS.map((row) => {
    const r = (state.dropRate && state.dropRate[row.key]) || { enabled: false, min: null, max: null };
    return `
      <div class="fnm-droprate-row">
        <label class="fnm-range-row">
          <input type="checkbox" data-fnm-dr="${row.key}" ${r.enabled ? 'checked' : ''}>
          <span class="fnm-range-label">${escapeHtml(row.label)}</span>
          <input type="number" step="0.1" class="fnm-cond-input" data-fnm-dr-min="${row.key}" placeholder="最小" value="${r.min ?? ''}">
          <span class="fnm-range-sep">〜</span>
          <input type="number" step="0.1" class="fnm-cond-input" data-fnm-dr-max="${row.key}" placeholder="最大" value="${r.max ?? ''}">
          <span class="fnm-range-suffix">%</span>
        </label>
        <div class="fnm-droprate-formula">※ ${escapeHtml(row.formula)}</div>
      </div>
    `;
  }).join('');
}

// 範囲フィルタ (2026-06 client spec) — 12 行の絶対値範囲設定。
// 種別ごとに区切り線を入れて視覚グループ化。kind により入力タイプを切替。
function renderRangesGrid(state) {
  const grid = $('#fnm-ranges-grid');
  if (!grid) return;
  const ranges = state.ranges || {};
  // グループ境界 (= 区切り線を入れる先頭 key) のセット。
  // 順序: 日時 → 価格 → 平均実質BuyBox → mp価格 → 月間販売数
  const groupStartKeys = new Set(['price', 'avgEff1d', 'mpPrice', 'impRank', 'profitAmtInstant', 'amazonFee']);
  // 1 行分の HTML。OR グループ内の行はラッパ側に区切り線があるので group-start を付けない。
  const rowHtml = (row) => {
    const r = ranges[row.key] || { enabled: false, min: null, max: null };
    const grpCls = (groupStartKeys.has(row.key) && !RANK_OR_GROUP_KEYS.includes(row.key))
      ? ' fnm-range-group-start' : '';
    const inputType = row.kind === 'datetime' ? 'datetime-local' : 'number';
    // 日時の場合は ms timestamp ⇔ "YYYY-MM-DDTHH:mm" 変換が必要。
    const minVal = row.kind === 'datetime' ? msToLocalDateTime(r.min) : (r.min ?? '');
    const maxVal = row.kind === 'datetime' ? msToLocalDateTime(r.max) : (r.max ?? '');
    // ⑤「空白含む」チェックボックス (Ama本体出品割合のみ)。既定 ON (値が空白=2点
    // 未満の商品も範囲条件を通す)。r.includeBlank が明示 false のときだけ OFF。
    const blankBox = row.includeBlankOpt
      ? `<label class="fnm-range-blank"><input type="checkbox" data-fnm-rng-blank="${row.key}" ${r.includeBlank === false ? '' : 'checked'}>空白含む</label>`
      : '';
    return `
      <label class="fnm-range-row${grpCls}">
        <input type="checkbox" data-fnm-rng="${row.key}" ${r.enabled ? 'checked' : ''}>
        <span class="fnm-range-label">${escapeHtml(row.label)}</span>
        <input type="${inputType}" step="${row.step}" class="fnm-cond-input" data-fnm-rng-min="${row.key}" placeholder="最小" value="${escapeHtml(String(minVal))}">
        <span class="fnm-range-sep">〜</span>
        <input type="${inputType}" step="${row.step}" class="fnm-cond-input" data-fnm-rng-max="${row.key}" placeholder="最大" value="${escapeHtml(String(maxVal))}">
        <span class="fnm-range-suffix">${escapeHtml(row.suffix)}</span>
        ${blankBox}
      </label>
    `;
  };
  // OR グループ (B9): ランキング/月間販売数/30日ランク変動 を ✅ボックス付きで囲む。
  const orGroupHtml = () => `
    <div class="fnm-or-group">
      <label class="fnm-or-toggle" title="チェックすると、この3条件のいずれか1つでも合致した商品を抽出します">
        <input type="checkbox" data-fnm-rank-or ${state.rankGroupOr ? 'checked' : ''}>
        <span>いずれか一つの条件でも<br>合致すれば抽出する</span>
      </label>
      <div class="fnm-or-rows">
        ${RANK_OR_GROUP_KEYS.map((k) => rowHtml(RANGE_ROWS.find((rr) => rr.key === k))).join('')}
      </div>
    </div>
  `;
  let html = '';
  for (const row of RANGE_ROWS) {
    if (row.key === RANK_OR_GROUP_KEYS[0]) { html += orGroupHtml(); continue; }  // 3行をまとめて描画
    if (RANK_OR_GROUP_KEYS.includes(row.key)) continue;                          // 既に描画済み
    html += rowHtml(row);
  }
  grid.innerHTML = html;
}

// ms timestamp → "YYYY-MM-DDTHH:mm" (datetime-local input value 形式)。
// null/不正値は空文字。タイムゾーンはローカル (UTC でなく端末時刻)。
function msToLocalDateTime(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// datetime-local input value ("YYYY-MM-DDTHH:mm") → ms timestamp。
// 空文字 / 不正値は null。
function localDateTimeToMs(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s);
  return isFinite(t) ? t : null;
}

function renderKeywordGrid(state) {
  const grid = $('#fnm-keyword-grid');
  if (!grid) return;
  grid.innerHTML = KEYWORD_ROWS.map((row) => {
    const k = state.keyword[row.key];
    return `
      <label class="fnm-keyword-row">
        <input type="checkbox" data-fnm-kw="${row.key}" ${k.enabled ? 'checked' : ''}>
        <span class="fnm-keyword-label">${escapeHtml(row.label)}</span>
        <input type="text" class="fnm-keyword-input" data-fnm-kw-q="${row.key}"
               value="${escapeHtml(k.query || '')}" placeholder="単語1 単語2、単語3">
      </label>
    `;
  }).join('');
}

function renderLegacyConditions(state) {
  const list = $('#fnm-cond-list');
  if (!list) return;
  list.innerHTML = state.legacy.map((slot, i) => {
    const cat = CONDITION_CATALOG[i];
    const checked = slot && slot.enabled ? 'checked' : '';
    if (!cat) return '';   // Skip TBD slots — keep UI clean per v2.
    const minVal = (slot.min != null) ? slot.min : '';
    const maxVal = (slot.max != null) ? slot.max : '';
    return `
      <li>
        <input type="checkbox" data-fnm-idx="${i}" ${checked}>
        <span class="fnm-cond-text">${escapeHtml(cat.label)}</span>
        <input type="number" class="fnm-cond-input" data-fnm-idx="${i}"
               data-fnm-param="min" step="${cat.step}" placeholder="最小"
               value="${minVal}">
        <span class="fnm-cond-suffix">${escapeHtml(cat.suffix)}</span>
        <span class="fnm-cond-sep">〜</span>
        <input type="number" class="fnm-cond-input" data-fnm-idx="${i}"
               data-fnm-param="max" step="${cat.step}" placeholder="最大"
               value="${maxVal}">
        <span class="fnm-cond-suffix">${escapeHtml(cat.suffix)}</span>
      </li>
    `;
  }).join('');
}

function renderPresetSlots() {
  const list = $('#fnm-preset-list');
  if (!list) return;
  // Recommended presets are dev-shipped (RECOMMENDED_PRESETS) — not the
  // user-saved fnmPresets array. Each slot shows its full condition
  // list inline so the user knows exactly what 適用 will write into
  // the left pane.
  list.innerHTML = RECOMMENDED_PRESETS.map((preset, i) => {
    const rulesHtml = preset.rules.map((r) => `
      <li class="fnm-preset-rule">
        <span class="fnm-preset-rule-label">${escapeHtml(r.label)}</span>
        <span class="fnm-preset-rule-range">${escapeHtml(r.range)}</span>
      </li>
    `).join('');
    // ※ 注記は複数行可 (項目18) — 各行を独立した .fnm-preset-note で表記。
    const noteHtml = Array.isArray(preset.notes)
      ? preset.notes.map((n) => `<div class="fnm-preset-note">${escapeHtml(n)}</div>`).join('')
      : '';
    return `
      <div class="fnm-slot fnm-slot-preset">
        <div class="fnm-slot-title">${escapeHtml(preset.name)}</div>
        <div class="fnm-slot-foot">以下の<b><u>全てが一致</u></b>した商品</div>
        <ul class="fnm-preset-rules">${rulesHtml}</ul>
        ${noteHtml}
        <div class="fnm-slot-actions">
          <button class="btn btn-warn btn-sm" data-fnm-preset-apply="${i}">適用</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderCustomSlots() {
  const list = $('#fnm-custom-list');
  if (!list) return;
  // Auto-delete toggle's wording differs per context per spec:
  //   active → 「自動ゴミ捨て」 (softDelete to trash)
  //   trash  → 「自動完全削除」 (hardDelete — wipes data permanently)
  // Underlying flag (autoTrashEnabled) is the same; the action chosen
  // by the evaluator depends on which fnmCustomCache it walks.
  const trashCtx  = fnmContext === 'trash';
  const trashWord = trashCtx ? '自動完全削除' : '自動ゴミ捨て';

  list.innerHTML = fnmCustomFilters.map((slot, i) => {
    const circleNum = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭'[i] || String(i + 1);
    const saved   = !!slot.state;
    const notif   = !!slot.notifEnabled;
    const autoT   = !!slot.autoTrashEnabled;
    // Toggles + 適用 only render once the slot has been saved at least
    // once. Until then the slot has no condition state to apply or to
    // trigger off, so the chrome would mislead the user.
    return `
      <div class="fnm-slot fnm-slot-custom ${saved ? 'is-saved' : 'is-empty'}">
        <div class="fnm-slot-title">カスタムフィルタ${circleNum}</div>
        ${saved ? `
          <div class="fnm-slot-toggles">
            <label class="fnm-slot-toggle">
              <input type="checkbox" data-fnm-custom-notif="${i}" ${notif ? 'checked' : ''}>
              <span>通知 ${notif ? '有効' : '無効'}</span>
            </label>
            <label class="fnm-slot-toggle">
              <input type="checkbox" data-fnm-custom-trash="${i}" ${autoT ? 'checked' : ''}>
              <span>${trashWord} ${autoT ? '有効' : '無効'}</span>
            </label>
          </div>
        ` : ''}
        <input class="fnm-slot-name" type="text" value="${escapeHtml(slot.name)}" data-fnm-custom-name="${i}">
        <div class="fnm-slot-actions">
          <button class="btn btn-cyan btn-sm" data-fnm-custom-save="${i}">保存</button>
          ${saved ? `<button class="btn btn-warn btn-sm" data-fnm-custom-apply="${i}">適用</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Snapshot the current tab's state from the DOM into fnmState[currentTab].
function captureFnmTabState() {
  const out = emptyFnmState();
  // mpCount
  for (const row of MP_COUNT_ROWS) {
    const cb  = document.querySelector(`[data-fnm-mp="${row.key}"]`);
    const min = document.querySelector(`[data-fnm-mp-min="${row.key}"]`);
    const max = document.querySelector(`[data-fnm-mp-max="${row.key}"]`);
    out.mpCount[row.key] = {
      enabled: !!(cb && cb.checked),
      min: numOrNull(min ? min.value : ''),
      max: numOrNull(max ? max.value : ''),
    };
  }
  // dropRate
  for (const row of DROP_RATE_ROWS) {
    const cb  = document.querySelector(`[data-fnm-dr="${row.key}"]`);
    const min = document.querySelector(`[data-fnm-dr-min="${row.key}"]`);
    const max = document.querySelector(`[data-fnm-dr-max="${row.key}"]`);
    out.dropRate[row.key] = {
      enabled: !!(cb && cb.checked),
      min: numOrNull(min ? min.value : ''),
      max: numOrNull(max ? max.value : ''),
    };
  }
  // keyword
  for (const row of KEYWORD_ROWS) {
    const cb = document.querySelector(`[data-fnm-kw="${row.key}"]`);
    const q  = document.querySelector(`[data-fnm-kw-q="${row.key}"]`);
    out.keyword[row.key] = {
      enabled: !!(cb && cb.checked),
      query: q ? q.value : '',
    };
  }
  // ranges (2026-06 client spec) — kind に応じて値をパース。
  // datetime は ms timestamp に正規化、number は parseFloat。
  for (const row of RANGE_ROWS) {
    const cb  = document.querySelector(`[data-fnm-rng="${row.key}"]`);
    const min = document.querySelector(`[data-fnm-rng-min="${row.key}"]`);
    const max = document.querySelector(`[data-fnm-rng-max="${row.key}"]`);
    const enabled = !!(cb && cb.checked);
    const parse = (v) => row.kind === 'datetime' ? localDateTimeToMs(v) : numOrNull(v);
    const entry = {
      enabled,
      min: parse(min ? min.value : ''),
      max: parse(max ? max.value : ''),
    };
    // ⑤「空白含む」(Ama本体出品割合のみ)。チェックボックス未描画時は既定 true。
    if (row.includeBlankOpt) {
      const bb = document.querySelector(`[data-fnm-rng-blank="${row.key}"]`);
      entry.includeBlank = bb ? !!bb.checked : true;
    }
    out.ranges[row.key] = entry;
  }
  // OR グループ (B9) — 「いずれか一つの条件でも合致すれば抽出」チェックボックス。
  const orCb = document.querySelector('[data-fnm-rank-or]');
  out.rankGroupOr = !!(orCb && orCb.checked);
  // legacy
  out.legacy = new Array(20).fill(null).map(() => ({ enabled: false, min: null, max: null }));
  document.querySelectorAll('#fnm-cond-list input[type="checkbox"][data-fnm-idx]').forEach((cb) => {
    const i = parseInt(cb.dataset.fnmIdx, 10);
    if (i >= 0 && i < 20) out.legacy[i].enabled = cb.checked;
  });
  document.querySelectorAll('#fnm-cond-list input[type="number"][data-fnm-param]').forEach((inp) => {
    const i = parseInt(inp.dataset.fnmIdx, 10);
    if (i < 0 || i >= 20) return;
    out.legacy[i][inp.dataset.fnmParam] = numOrNull(inp.value);
  });
  fnmState.filter = out;
}

function numOrNull(s) {
  const t = String(s == null ? '' : s).trim();
  if (t === '') return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

// ── Action bar handlers ─────────────────────────────────────
function fnmSelectAll(checked) {
  document.querySelectorAll(
    // 全出品数(内訳) mpcount は項目17 で撤去。
    '#fnm-droprate-grid input[type="checkbox"], ' +
    // ranges は「有効化」チェックボックス (data-fnm-rng) のみ対象。⑤「空白含む」
    // (data-fnm-rng-blank) は条件の有効/無効ではなくサブオプションなので、
    // 全選択/全解除では触らない (誤って既定の含む設定を外さないため)。
    '#fnm-ranges-grid input[type="checkbox"][data-fnm-rng], ' +
    '#fnm-keyword-grid input[type="checkbox"], ' +
    '#fnm-cond-list input[type="checkbox"]'
  ).forEach((cb) => { cb.checked = checked; });
}

// 「リセット」 — per spec: clears every filter condition AND runs
// フィルタ実行 immediately, so the viewer refreshes back to "全商品
// 表示" in a single click. Distinct from 「全解除」 (which only
// unchecks boxes in the modal without applying).
async function fnmReset() {
  fnmState.filter = emptyFnmState();
  renderFnmTab();
  // Persist the cleared state and refresh the viewer table — exactly
  // what フィルタ実行 does, just with the post-clear state.
  await persistFnmCurrent();
  await loadFnmStateCache();
  // 条件が空になるので snapshot は null に戻る。並び順は保持しつつ全表示。
  await recomputeFilterAndSortAndRender();
  // クライアント要望 (2026-05): 全商品表示完了の通知メッセージを前面に出す。
  // alert() は OS ネイティブのモーダルダイアログ — フォーカスを奪うので
  // ユーザーが結果を確実に確認できる。
  alert(`全商品（${filtered.length} 個）を表示しました。`);
}

// "Filter execute" — capture current pane state and immediately apply
// it to the visible product list. Persists the same state automatically.
// 2026-05: 条件合致探索を「適用」クリック時に明示的に走らせる経路。
// applyFilter は snapshot 参照のみなので、ここで recompute を呼ぶことで
// stats 一括取得 + 全件評価 → 凍結が起きる。
async function fnmExecute() {
  captureFnmTabState();
  await persistFnmCurrent();
  await loadFnmStateCache();
  await recomputeFilterAndSortAndRender();
  // クライアント要望 (2026-05): ヒット件数を前面メッセージで通知。
  // 0 件の場合も同じ書式で出すことで「条件が厳しすぎる」ことに気付ける。
  alert(`${filtered.length} 個の商品がヒットしました。`);
}

// Persist filter + custom slots + presets. The maint/notif tabs are
// gone, so only the single filter state needs saving here.
async function persistFnmCurrent() {
  const keys = FNM_CONTEXT[fnmContext].keys;
  await Promise.all([
    window.api.invoke('setSetting', { key: keys.filter,  value: JSON.stringify(fnmState.filter) }),
    window.api.invoke('setSetting', { key: keys.custom,  value: JSON.stringify(fnmCustomFilters) }),
    window.api.invoke('setSetting', { key: keys.presets, value: JSON.stringify(fnmPresets) }),
  ]);
}

async function saveFnmConditions() {
  captureFnmTabState();
  await persistFnmCurrent();
  await loadFnmStateCache();
  await applyFilter();
  renderVisible();
  closeFnmModal();
}

// Custom filter slot: save current filter pane → slot[i].state.
async function onCustomSave(i) {
  // Filter pane is the only pane now; just snapshot it.
  captureFnmTabState();
  // Capture the user-edited name input alongside the state. Existing
  // toggle values carry over so a re-save doesn't reset them.
  const nameInput = document.querySelector(`[data-fnm-custom-name="${i}"]`);
  const prev = fnmCustomFilters[i] || {};
  fnmCustomFilters[i] = {
    name: nameInput ? nameInput.value : `カスタムフィルタ${i + 1}`,
    state: JSON.parse(JSON.stringify(fnmState.filter)),
    notifEnabled:     !!prev.notifEnabled,
    autoTrashEnabled: !!prev.autoTrashEnabled,
    savedAt:          Date.now(),
  };
  await persistCustomSlots();
  renderCustomSlots();
}

// Persist all 14 custom slots through the existing settings IPC. Uses
// the same key the FNM modal already uses for save/load, so no new
// migrations or schema changes are required.
async function persistCustomSlots() {
  const ctx = FNM_CONTEXT[fnmContext];
  await window.api.invoke('setSetting', {
    key:   ctx.keys.custom,
    value: JSON.stringify(fnmCustomFilters),
  });
  // Mirror into the evaluator cache so the next price-update tick uses
  // the latest toggles without re-reading from settings storage.
  fnmCustomCache[fnmContext] = parseSlotArray(JSON.stringify(fnmCustomFilters), 14);
}

// Toggle 通知 / 自動ゴミ捨て on a saved slot. Persists immediately so
// the evaluator (running on every push update) sees the latest flags
// without the user having to click 条件を保存.
async function onCustomToggle(i, kind, on) {
  const slot = fnmCustomFilters[i];
  if (!slot || !slot.state) return;        // toggles only matter post-save
  if (kind === 'notif') slot.notifEnabled    = !!on;
  if (kind === 'trash') slot.autoTrashEnabled = !!on;
  await persistCustomSlots();
  renderCustomSlots();
}

function onCustomApply(i) {
  const slot = fnmCustomFilters[i];
  if (!slot || !slot.state) return;
  fnmState.filter = parseFnmState(JSON.stringify(slot.state));
  renderFnmTab();
}

function onPresetApply(i) {
  // Recommended presets are dev-shipped, not user-saved — pull straight
  // from RECOMMENDED_PRESETS so any user edits to fnmPresets in storage
  // can never override the documented spec values.
  const preset = RECOMMENDED_PRESETS[i];
  if (!preset) return;
  fnmState.filter = preset.build();
  renderFnmTab();
}

// ── 通知履歴 modal ─────────────────────────────────────────
//
// Replaces the old History tab. Triggered by the 通知履歴 button in
// the top toolbar. Refreshes the notification list every open so
// the user sees current data without manual refresh.

function setupHistoryModal() {
  const btn = $('#btn-notif-history');
  if (btn) btn.addEventListener('click', openHistoryModal);
  const close = $('#history-close');
  if (close) close.addEventListener('click', closeHistoryModal);
  const modal = $('#history-modal');
  if (modal) modal.addEventListener('click', (e) => {
    // バックドロップクリックでクローズ。
    if (e.target.id === 'history-modal') { closeHistoryModal(); return; }
    // 履歴行内の商品ページリンクをクリック → Amazon を既定ブラウザで開く。
    const pl = e.target.closest('[data-product-link]');
    if (pl) {
      window.api.invoke('openProductPage', { asin: pl.dataset.productLink });
      return;
    }
    // ASIN をクリック → クリップボードへコピー。
    const ca = e.target.closest('[data-copy-asin]');
    if (ca) copyAsinToClipboard(ca);
  });
}

async function openHistoryModal() {
  await loadNotifications();
  $('#history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  $('#history-modal').classList.add('hidden');
}

// ── 通知価格の一括設定 / リセット modal (2026-05) ────────────
//
// 一括操作の「通知価格の設定」「通知価格のリセット」から開く。
// 設定モーダルは 2 種類の計算方式 (BuyBox 価格の N% 以下 / 利益率 N%
// 以上) から選んで、各商品の notify_price を一括更新する。
// リセットモーダルは選択商品の notify_price を全て NULL に戻す。

function setupNotifyPriceModals() {
  // 設定 modal — 閉じる + 実行ボタン
  const setClose = $('#notify-price-set-close');
  if (setClose) setClose.addEventListener('click', closeNotifyPriceSetModal);
  const setModal = $('#notify-price-set-modal');
  if (setModal) setModal.addEventListener('click', (e) => {
    if (e.target.id === 'notify-price-set-modal') closeNotifyPriceSetModal();
  });
  const setExec = $('#notify-set-execute');
  if (setExec) setExec.addEventListener('click', executeNotifyPriceSet);

  // リセット modal
  const resetClose = $('#notify-price-reset-close');
  if (resetClose) resetClose.addEventListener('click', closeNotifyPriceResetModal);
  const resetModal = $('#notify-price-reset-modal');
  if (resetModal) resetModal.addEventListener('click', (e) => {
    if (e.target.id === 'notify-price-reset-modal') closeNotifyPriceResetModal();
  });
  const resetExec = $('#notify-reset-execute');
  if (resetExec) resetExec.addEventListener('click', executeNotifyPriceReset);
}

let _notifyPriceSetAsins   = [];   // モーダル展開時にスナップショット
let _notifyPriceResetAsins = [];

function openNotifyPriceSetModal(asins) {
  _notifyPriceSetAsins = asins.slice();
  const summary = $('#notify-set-summary');
  if (summary) summary.textContent = `${asins.length} 件選択中`;
  $('#notify-price-set-modal').classList.remove('hidden');
}
function closeNotifyPriceSetModal() {
  $('#notify-price-set-modal').classList.add('hidden');
  _notifyPriceSetAsins = [];
}

function openNotifyPriceResetModal(asins) {
  _notifyPriceResetAsins = asins.slice();
  const summary = $('#notify-reset-summary');
  if (summary) summary.textContent = `${asins.length} 件選択中`;
  $('#notify-price-reset-modal').classList.remove('hidden');
}
function closeNotifyPriceResetModal() {
  $('#notify-price-reset-modal').classList.add('hidden');
  _notifyPriceResetAsins = [];
}

async function executeNotifyPriceSet() {
  const asins = _notifyPriceSetAsins.slice();
  if (asins.length === 0) { closeNotifyPriceSetModal(); return; }
  const mode = document.querySelector('input[name="notify-set-mode"]:checked')?.value || 'effective-drop-pct';
  const valEl = document.querySelector(`.notify-set-val[data-mode="${mode}"]`);
  const pct = parseFloat(valEl?.value);
  if (!isFinite(pct) || pct <= 0) {
    alert('有効な数値を入力してください (1 以上)。');
    return;
  }

  // 各商品ごとに計算式を適用:
  //  - effective-drop-pct (2026-06 client spec):
  //      base = 最新実質BuyBox価格 (= last_price − last_points + last_shipping_fee)
  //      notify_price = base × (100 − pct) / 100
  //      (例: 最新実質=¥3,000, pct=20 → notify_price=¥2,400
  //           = 実質価格から 20% 下落したら通知)
  //
  //  - profit-margin (※ 詳細仕様後日):
  //      暫定で「last_price × (100 − pct) / 100」のままにしておく。
  //      正式仕様 (Amazon 販売手数料・FBA 手数料・在庫保管料 など) は
  //      Keepa API インポート案件と合わせて別途実装。
  let updated = 0;
  let skipped = 0;
  const failures = [];
  for (const asin of asins) {
    const idx = productIndex.get(asin);
    if (idx == null) { skipped++; continue; }
    const product = allProducts[idx];
    let np;
    if (mode === 'effective-drop-pct') {
      // 最新実質BuyBox価格 = price − points + shipping (= リスト「最新実質
      // BuyBox価格」セルと完全同一の式)。
      const lp = product.last_price;
      if (lp == null || !isFinite(lp) || lp <= 0) { skipped++; continue; }
      const eff = lp - (product.last_points || 0) + (product.last_shipping_fee || 0);
      if (!isFinite(eff) || eff <= 0) { skipped++; continue; }
      np = Math.round(eff * (100 - pct) / 100);
    } else {
      // profit-margin (暫定計算 — 後日仕様変更予定)
      const lp = product.last_price;
      if (lp == null || !isFinite(lp) || lp <= 0) { skipped++; continue; }
      np = Math.round(lp * (100 - pct) / 100);
    }
    if (!isFinite(np) || np <= 0) { skipped++; continue; }
    try {
      await window.api.invoke('setNotifyPrice', { asin, price: np });
      product.notify_price = np;
      // 該当行が描画済みなら input フィールドを即時更新。
      const tr = visibleRows.get(asin);
      if (tr) {
        const inp = tr.querySelector(`.notify-price-input[data-notify-asin="${asin}"]`);
        if (inp) inp.value = np;
      }
      updated++;
    } catch (e) {
      failures.push(`${asin}: ${e.message}`);
    }
  }

  closeNotifyPriceSetModal();
  let msg = `通知価格を一括設定しました。\n\n更新: ${updated} 件 / 対象: ${asins.length} 件`;
  if (skipped > 0)         msg += `\nスキップ: ${skipped} 件 (BuyBox 価格未取得)`;
  if (failures.length > 0) msg += `\n失敗: ${failures.length} 件`;
  alert(msg);
}

async function executeNotifyPriceReset() {
  const asins = _notifyPriceResetAsins.slice();
  if (asins.length === 0) { closeNotifyPriceResetModal(); return; }
  let updated = 0;
  const failures = [];
  for (const asin of asins) {
    try {
      await window.api.invoke('setNotifyPrice', { asin, price: null });
      const idx = productIndex.get(asin);
      if (idx != null) allProducts[idx].notify_price = null;
      const tr = visibleRows.get(asin);
      if (tr) {
        const inp = tr.querySelector(`.notify-price-input[data-notify-asin="${asin}"]`);
        if (inp) inp.value = '';
      }
      updated++;
    } catch (e) {
      failures.push(`${asin}: ${e.message}`);
    }
  }
  closeNotifyPriceResetModal();
  let msg = `通知価格を一括リセットしました。\n\n更新: ${updated} 件 / 対象: ${asins.length} 件`;
  if (failures.length > 0) msg += `\n失敗: ${failures.length} 件`;
  alert(msg);
}

// ── クロール診断モーダル (2026-05) ──────────────────────────────
//
// ヘッダーの「📊 診断」ボタンから開く。1 ページ取得時間 (page_timings
// テーブル) を折れ線、ブロックイベント (block_events) を縦線マーカーで
// 同じ X 軸 (時刻) 上に重ねて表示する。
//
// 描画は Canvas2D で自前 — TimeSeriesChart クラスを再利用しても良いが、
// 1 系列 + マーカーだけのシンプルなビューなのでオーバースペック。
// pixelRatio 対応で高 DPI ディスプレイでも綺麗に出る。

function setupCrawlDiagnosticsModal() {
  const btn = $('#btn-crawl-diagnostics');
  if (btn) btn.addEventListener('click', openCrawlDiagnosticsModal);
  const close = $('#crawl-diagnostics-close');
  if (close) close.addEventListener('click', closeCrawlDiagnosticsModal);
  const modal = $('#crawl-diagnostics-modal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target.id === 'crawl-diagnostics-modal') closeCrawlDiagnosticsModal();
  });
  const sel = $('#crawl-diag-range');
  if (sel) sel.addEventListener('change', loadCrawlDiagnostics);
  const refresh = $('#crawl-diag-refresh');
  if (refresh) refresh.addEventListener('click', loadCrawlDiagnostics);
}

async function openCrawlDiagnosticsModal() {
  $('#crawl-diagnostics-modal').classList.remove('hidden');
  await loadCrawlDiagnostics();
}

function closeCrawlDiagnosticsModal() {
  $('#crawl-diagnostics-modal').classList.add('hidden');
}

// ── 左下ログドック (2026-06 client要望) ────────────────────────────────
// 常時表示の小型ログ盤。最小化=アイコンのみ / 最大化=左下に小型ダッシュボード。
let logDockTimer = null;
function setupLogDock() {
  const icon = $('#log-dock-icon');
  if (icon) icon.addEventListener('click', expandLogDock);
  const min = $('#log-dock-min');
  if (min) min.addEventListener('click', collapseLogDock);
  const refresh = $('#log-dock-refresh');
  if (refresh) refresh.addEventListener('click', loadAppLog);
  collapseLogDock();   // 既定は最小化 (アイコンのみ)。
}

function expandLogDock() {
  const dock = $('#log-dock');
  if (!dock) return;
  dock.classList.remove('collapsed');
  loadAppLog();
  // 最大化中だけ 3 秒ごとに自動更新。
  if (logDockTimer) clearInterval(logDockTimer);
  logDockTimer = setInterval(() => {
    const d = $('#log-dock');
    if (d && !d.classList.contains('collapsed')) loadAppLog();
  }, 3000);
}

function collapseLogDock() {
  const dock = $('#log-dock');
  if (dock) dock.classList.add('collapsed');
  if (logDockTimer) { clearInterval(logDockTimer); logDockTimer = null; }
}

async function loadAppLog() {
  const list = $('#log-dock-list');
  if (!list) return;
  let entries = [];
  try {
    entries = await window.api.invoke('getAppLog', { limit: 300 });
  } catch (e) {
    list.textContent = 'ログの取得に失敗しました: ' + e.message;
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    list.textContent = 'まだログがありません。';
    return;
  }
  // 末尾(最新)が見えるよう古い順で並べ、行ごとに時刻+レベル+本文。
  const fmtTime = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  // スクロール位置が最下部付近なら、更新後も最下部へ追従する。
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
  list.innerHTML = entries.map((e) => {
    const lv = (e.level === 'warn' || e.level === 'error') ? e.level : 'info';
    return `<div class="app-log-row app-log-${lv}">`
      + `<span class="app-log-time">${fmtTime(e.t)}</span>`
      + `<span class="app-log-msg">${escapeHtml(e.message || '')}</span></div>`;
  }).join('');
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

async function loadCrawlDiagnostics() {
  const rangeMs = parseInt($('#crawl-diag-range').value, 10) || 86_400_000;
  const sinceMs = Date.now() - rangeMs;
  let data = { timings: [], cycles: [], blocks: [] };
  try {
    data = await window.api.invoke('getCrawlDiagnostics', { sinceMs });
  } catch (e) {
    console.warn('[crawl-diag] fetch failed:', e.message);
  }
  renderCrawlDiagnosticsSummary(data, rangeMs);
  drawCrawlDiagnosticsChart(data, sinceMs, Date.now());
  renderCrawlDiagnosticsCycleSummary(data, rangeMs);
  drawCrawlDiagnosticsCycleChart(data, sinceMs, Date.now());
  renderCrawlDiagnosticsBlockList(data.blocks || []);
}

function renderCrawlDiagnosticsSummary(data, rangeMs) {
  const t = data.timings || [];
  const b = data.blocks  || [];
  const el = $('#crawl-diag-summary');
  if (!el) return;
  if (t.length === 0) {
    el.innerHTML = `この期間にクロールデータがありません (期間: ${formatRangeLabel(rangeMs)})`;
    return;
  }
  // B13: サンプル数 / 平均 / 最小 / 最大 の時間表記は削除し、期間とアクセス調整回数のみ。
  el.innerHTML =
    `期間: <strong>${formatRangeLabel(rangeMs)}</strong> | ` +
    `アクセス調整回数: <strong>${b.length}</strong> 回`;
}

function fmtDuration(ms) {
  if (!isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60)  return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}分${r}秒`;
}

function formatRangeLabel(ms) {
  const h = ms / 3_600_000;
  if (h < 24) return `直近 ${Math.round(h)} 時間`;
  return `直近 ${Math.round(h / 24)} 日`;
}

function drawCrawlDiagnosticsChart(data, fromMs, toMs) {
  const canvas = $('#crawl-diag-canvas');
  const empty  = $('#crawl-diag-empty');
  if (!canvas) return;
  const timings = data.timings || [];
  const blocks  = data.blocks  || [];

  if (timings.length === 0) {
    if (empty) empty.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (empty) empty.classList.add('hidden');

  // HiDPI 対応 — CSS サイズと DPR を考慮した実描画解像度に合わせる。
  const dpr   = window.devicePixelRatio || 1;
  const cssW  = canvas.clientWidth  || 820;
  const cssH  = canvas.clientHeight || 320;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { top: 18, right: 18, bottom: 36, left: 64 };
  const plotW = cssW - pad.left - pad.right;
  const plotH = cssH - pad.top  - pad.bottom;

  // B14: 1ページ取得時間 ≒ 約45商品 ぶんなので、縦軸は切りの良い 50 で割って
  // 「1商品あたりの取得時間」に換算して表示する (曲線の形は同じ、目盛りが /50)。
  const PER_PAGE_PRODUCTS = 50;
  const perProductMs = (t) => t.elapsed_ms / PER_PAGE_PRODUCTS;

  // Y 軸範囲 — 1商品あたり時間の最大に少し余白を持たせて切り上げ。
  const maxMs = Math.max(...timings.map(perProductMs), 20);
  const yMax  = niceCeil(maxMs * 1.1);
  const yMin  = 0;

  const xFor = (t) => pad.left + ((t - fromMs) / (toMs - fromMs)) * plotW;
  const yFor = (v) => pad.top  + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // 背景グリッド + Y 軸メモリ。
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle   = 'rgba(255,255,255,0.55)';
  ctx.font        = '10px sans-serif';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';
  const tickCount = 5;
  for (let i = 0; i <= tickCount; i++) {
    const v = yMin + ((yMax - yMin) * i) / tickCount;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtDuration(v), pad.left - 6, y);
  }

  // X 軸時刻ラベル (4 等分)。
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const t = fromMs + ((toMs - fromMs) * i) / 4;
    const x = xFor(t);
    ctx.fillText(formatChartTime(t, toMs - fromMs), x, pad.top + plotH + 4);
  }

  // ブロックイベント縦線マーカー (折れ線の下に重ねる)。
  for (const b of blocks) {
    const x = xFor(b.occurred_at);
    if (x < pad.left || x > pad.left + plotW) continue;
    ctx.strokeStyle = 'rgba(248,113,113,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    // 上端に小さい三角アイコン。
    ctx.fillStyle = 'rgba(248,113,113,0.9)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top - 2);
    ctx.lineTo(x - 4, pad.top + 5);
    ctx.lineTo(x + 4, pad.top + 5);
    ctx.closePath();
    ctx.fill();
  }

  // 折れ線 (page elapsed)。
  ctx.strokeStyle = '#ffa500';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < timings.length; i++) {
    const x = xFor(timings[i].recorded_at);
    const y = yFor(perProductMs(timings[i]));
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ドット (短期間表示時のみ点を見せる — 100 サンプル以下なら全部、それ
  // 以上ならスキップ描画にして CPU を節約)。
  if (timings.length <= 200) {
    ctx.fillStyle = '#ffa500';
    for (const t of timings) {
      const x = xFor(t.recorded_at);
      const y = yFor(perProductMs(t));
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 軸外周。
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
}

// ── 1 周期合計時間 (棒グラフ) ──────────────────────────────────
//
// 1 周期 = scheduler の runOneCycle 1 回 (= 全監視商品をひと通りスクレイプ
// する所要時間)。データ点数が少ない (1 時間ごとに数回程度) ので棒グラフが
// 読みやすい。1 本のバー = 1 周期。X 軸は時刻、ホバー無しでもバー上端に
// 時間ラベルを直接乗せる。

function renderCrawlDiagnosticsCycleSummary(data, rangeMs) {
  const cycles = data.cycles || [];
  const el = $('#crawl-diag-cycle-summary');
  if (!el) return;
  if (cycles.length === 0) {
    el.innerHTML = `この期間に完了した周期がありません (期間: ${formatRangeLabel(rangeMs)})`;
    return;
  }
  const elapsed = cycles.map((c) => c.elapsed_ms);
  const sum = elapsed.reduce((a, b) => a + b, 0);
  const avg = sum / elapsed.length;
  const max = Math.max(...elapsed);
  const min = Math.min(...elapsed);
  el.innerHTML =
    `周期数: <strong>${cycles.length}</strong> | ` +
    `平均: <strong>${fmtDuration(avg)}</strong> | ` +
    `最小: <strong>${fmtDuration(min)}</strong> | ` +
    `最大: <strong>${fmtDuration(max)}</strong>`;
}

function drawCrawlDiagnosticsCycleChart(data, fromMs, toMs) {
  const canvas = $('#crawl-diag-cycle-canvas');
  const empty  = $('#crawl-diag-cycle-empty');
  if (!canvas) return;
  const cycles = data.cycles || [];
  const blocks = data.blocks || [];

  if (cycles.length === 0) {
    if (empty) empty.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (empty) empty.classList.add('hidden');

  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth  || 820;
  const cssH = canvas.clientHeight || 220;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { top: 22, right: 18, bottom: 36, left: 64 };
  const plotW = cssW - pad.left - pad.right;
  const plotH = cssH - pad.top  - pad.bottom;

  const maxMs = Math.max(...cycles.map((c) => c.elapsed_ms), 60_000);
  const yMax  = niceCeil(maxMs * 1.15);
  const yMin  = 0;

  const xFor = (t) => pad.left + ((t - fromMs) / (toMs - fromMs)) * plotW;
  const yFor = (v) => pad.top  + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // グリッド + Y 軸ラベル。
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle   = 'rgba(255,255,255,0.55)';
  ctx.font        = '10px sans-serif';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = yMin + ((yMax - yMin) * i) / tickCount;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtDuration(v), pad.left - 6, y);
  }

  // X 軸時刻ラベル。
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const t = fromMs + ((toMs - fromMs) * i) / 4;
    const x = xFor(t);
    ctx.fillText(formatChartTime(t, toMs - fromMs), x, pad.top + plotH + 4);
  }

  // ブロックマーカー縦線 (棒グラフの裏に薄く重ねる)。
  for (const b of blocks) {
    const x = xFor(b.occurred_at);
    if (x < pad.left || x > pad.left + plotW) continue;
    ctx.strokeStyle = 'rgba(248,113,113,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
  }

  // 棒幅 — 隣のバーと被らないように、最小間隔の 60% を目安に決定。
  // バー数が少なければ最大 24px に切り上げ、多ければ最小 3px まで縮める。
  let barW = 14;
  if (cycles.length >= 2) {
    let minGap = Infinity;
    for (let i = 1; i < cycles.length; i++) {
      const gap = Math.abs(xFor(cycles[i].recorded_at) - xFor(cycles[i - 1].recorded_at));
      if (gap < minGap) minGap = gap;
    }
    barW = Math.max(3, Math.min(24, minGap * 0.6));
  }

  // バー本体。
  for (const c of cycles) {
    const x = xFor(c.recorded_at);
    if (x < pad.left - barW || x > pad.left + plotW + barW) continue;
    const yTop = yFor(c.elapsed_ms);
    const h    = (pad.top + plotH) - yTop;
    ctx.fillStyle = 'rgba(91,158,255,0.85)';
    ctx.fillRect(x - barW / 2, yTop, barW, h);
    // 上端ラベル — バーが狭くてもキリ良く描けるよう常にバーの上に出す。
    if (barW >= 8) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtDuration(c.elapsed_ms), x, yTop - 2);
    }
  }

  // 軸外周。
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
}

// 1000, 2000, 5000, 10000... のキリの良い上限値に丸める。
function niceCeil(n) {
  if (n <= 0) return 1000;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const r = n / base;
  let step;
  if (r <= 1)       step = 1;
  else if (r <= 2)  step = 2;
  else if (r <= 5)  step = 5;
  else              step = 10;
  return step * base;
}

function formatChartTime(ms, rangeMs) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  // 24 時間以下なら "HH:mm"、それ以上なら "M/D HH:mm"。
  if (rangeMs <= 24 * 3_600_000) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCrawlDiagnosticsBlockList(blocks) {
  const el = $('#crawl-diag-blocks-list');
  if (!el) return;
  if (!blocks || blocks.length === 0) {
    el.innerHTML = '<div class="cd-block-empty">この期間にアクセス調整イベントは発生していません</div>';
    return;
  }
  // 新しいものを上に。
  const rows = [...blocks].reverse().slice(0, 100).map((b) => {
    const t = formatJpDateTime(b.occurred_at);
    return `<div class="cd-block-row">
      <span>${escapeHtml(t)}</span>
      <span class="cd-block-type">${escapeHtml(b.block_type || '?')}</span>
      <span>${escapeHtml(b.source || '')}</span>
      <span>streak ${b.streak ?? 0}</span>
    </div>`;
  });
  el.innerHTML = rows.join('');
}

// ── Live update pipeline ────────────────────────────────────

function handleIncomingPriceUpdate(asin, data, updatedAt) {
  const idx = productIndex.get(asin);
  if (idx == null) { loadProducts(); return; }
  const row = allProducts[idx];
  if (data) {
    if (data.title) row.title = data.title;
    if (data.imageUrl) row.image_url = data.imageUrl;
    row.last_price       = data.price ?? null;
    row.last_points      = data.points ?? null;
    row.last_delivery    = data.delivery ?? null;
    row.last_mp_price    = data.mpPrice ?? null;
    row.last_mp_count    = data.mpCount ?? null;
    row.last_mp_condition = data.mpCondition ?? null;
    // 月間販売数は DB 側で COALESCE(?, last_monthly_sales) により直近の良い値を
    // 保持する仕様 (2026-06)。メモリキャッシュも同じく、値が取れた時だけ上書き
    // し、null では既存値を消さない (DB と表示の一時的な乖離を防ぐ)。
    // 値が取れた時だけ上書き + 取得日時を更新 (項目3: 最新取得値判定用)。null
    // では既存値も日時も消さない (DB の COALESCE / CASE と同じ「直近の良い値維持」)。
    if (data.monthlySales != null) {
      row.last_monthly_sales = data.monthlySales;
      row.last_monthly_sales_at = updatedAt;
    }
    row.last_shipping_fee = data.shippingFee ?? null;
    // Amazon販売手数料は main 側が「最新BuyBox価格 × 最新紹介料% × 1.1」で
    // 再計算して同梱する (2026-06 client要望)。価格に追従させるためメモリ値も
    // 更新する。これで BuyBox価格列・Amazon販売手数料列・利益計算・並び替え・
    // フィルタがすべて最新価格基準で整合する (列ごとの食い違いを防ぐ)。null
    // (紹介料%欠落) の場合はインポート時の確定値を維持する。
    if (data.amazonFee != null) row.amazon_fee = data.amazonFee;
    row.last_observed_at = updatedAt;
    row.last_error       = null;
  }
  // ★ 価格が変わった瞬間に stats / sparkline キャッシュを無効化する (2026-06 fix)。
  //
  // これをしないと、product.last_price は即時更新されるのに statsCache
  // (平均・1個前価格 = prevEffective / avgNd) が古いまま残り、フィルタ評価
  // (passesAllConditions) や下落率計算が「最新価格(新) ÷ 平均(古)」という
  // 不整合な組み合わせになる。結果、監視クロール中にフィルタ実行すると、
  // 実際は横ばいの商品でも (古い高い平均 − 新しい価格) で過大な下落率が出て
  // 大量に誤ヒットし、ビューアの BuyBox価格列(新) と 最新実質/平均列(古) も
  // 食い違って見える (client report 項目2)。
  //
  // flushDirty も同じ delete をするが、それは requestAnimationFrame 経由で
  // 遅延し、フィルタ実行の同期評価ループに rAF がブロックされて間に合わない
  // ことがある。ここで即時に消すことで、次に読む側 (ensureStatsLoaded /
  // flushDirty / fetchStatsFor) が必ず最新を取り直し、常に整合した stats で
  // 評価される。
  statsCache.delete(asin);
  sparklineCache.delete(asin);

  dirtyAsins.add(asin);
  if (!flushScheduled) { flushScheduled = true; requestAnimationFrame(flushDirty); }
  // 新しい監視データが入ったので、現在の snapshot は古くなった可能性あり。
  // ユーザーに refresh ボタンを目立たせて「更新できますよ」とお知らせする。
  markRefreshButtonDirty();
}

async function flushDirty() {
  flushScheduled = false;
  // 評価に使う FNM 条件キャッシュを一定間隔で最新の保存値に同期する。
  // モーダル保存時 (persistCustomSlots) にも同期しているが、ここでも周期的に
  // 再読込することで「編集したのに古い条件で発火し続ける」状態を防ぐ。
  if (Date.now() - lastFnmCacheReload > FNM_CACHE_TTL_MS) {
    lastFnmCacheReload = Date.now();
    try { await loadFnmStateCache(); } catch { /* 失敗時は前回値のまま */ }
  }
  let triggeredAutoAction = false;
  // Snapshot — async ループ中に新しい PRICE_UPDATE が積まれても、この
  // フレームで処理する集合は固定。新規分は次フレームで別 flushDirty が
  // 走るので拾い漏れない (handleIncomingPriceUpdate が flushScheduled を
  // 監視している)。
  const asinsThisTick = Array.from(dirtyAsins);
  dirtyAsins.clear();

  // 「未取得期間」フィルタ (項目4) を通知判定でも使えるよう、基準 (全商品で最も
  // 新しい最新取得日時) をこのティックの先頭で最新化する。passesAllConditions 内の
  // staleDaysOf がこれを参照する。
  refreshNewestObserved();

  for (const asin of asinsThisTick) {
    const idx = productIndex.get(asin);
    if (idx == null) continue;
    const product = allProducts[idx];
    // Stats and sparkline series both go stale on a fresh observation.
    statsCache.delete(asin);
    sparklineCache.delete(asin);

    // ★ フィルタ判定 (passesAllConditions) には stats.prevEffective や
    // stats.avg{N}d が必須。スクレイプ直後の statsCache はちょうど消した
    // ばかりなので、ここで同期的に再取得しておかないと dropRate 系条件が
    // 常に null → inRange(null) が常に false → 通知が一切発火しない、
    // という致命バグになる (2026-05 fix)。
    //   - fetchStatsFor は has() 早期リターンや WeakMap 排他があり、ここの
    //     文脈には合わないので IPC を直接呼ぶ。
    //   - 取得失敗時は空オブジェクトでキャッシュし、次サイクルで再試行。
    let freshStats = null;
    try {
      freshStats = await window.api.invoke('getProductStats', { asin });
    } catch { freshStats = null; }
    statsCache.set(asin, freshStats || {});

    // 個別設定価格 (2026-05): products.notify_price が設定されている商品は
    // FNM 評価より優先して「最新実質BuyBox価格 < notify_price」をチェック。
    // 一致したら専用タイトル「『個別設定価格』の商品検知」で通知発火し、
    // 当ティックの FNM 評価はスキップする (= 個別優先の挙動)。
    // 一致しなかった場合は通常通り FNM スロットを順に評価する。
    let skipFnmThisTick = false;
    const indivPrice = product.notify_price;
    const latestEff  = (product.last_price != null)
      ? product.last_price - (product.last_points || 0) + (product.last_shipping_fee || 0)
      : null;
    if (indivPrice != null && latestEff != null && latestEff < indivPrice) {
      // notifier.js が `「{slotName}」の商品検知` 形式で author 行を組み立てる
      // ため、ここではラップ前の「個別設定価格」だけを渡す。
      // 結果: Discord の表題が「「個別設定価格」の商品検知」になる。
      // ★ 個別設定価格はユーザーが商品ごとに明示的にセットしているので、
      // viewer フィルタの絞り込みとは無関係に常に発火する (gate しない)。
      window.api.invoke('fireFnmNotification', {
        asin, context: 'active', product,
        slotIndex: -1,
        slotName:  '個別設定価格',
      }).catch(() => {});
      skipFnmThisTick = true;     // 行表示の更新は行うが FNM スロットは見ない
    }

    // ★ 旧「viewer フィルタ snapshot ゲート」は撤去 (2026-06 fix)
    //
    // 以前は「viewer の絞り込み結果 (filterAsinSnapshot) に含まれる ASIN のみ
    // 通知発火」というゲートで誤通知を抑えていた。しかしこのゲートは:
    //   - 通知発火を「左ペイン viewer フィルタ」に縛るため、スロットの通知
    //     ON/OFF や条件変更が即時に反映されず、「更新」ボタンで snapshot を
    //     作り直すまで通知が来ない (= クライアント報告の取りこぼし)。
    //   - そもそも誤通知の真因 (stats のタイミングずれ) を塞ぐ対策ではない。
    //
    // 誤通知の真因は別途すべて修正済み:
    //   1) scheduler が観測を DB に確定させてから PRICE_UPDATE を送る、
    //   2) 瞬間下落率の基準を連続観測 (12h 以内) に限定、
    //   3) **main プロセスで発火直前に「現在保存中のスロット条件 + 最新
    //      stats」で再評価する authoritative バックストップ** (ipc-handlers
    //      の fireFnmNotification / fnm-eval)。
    //
    // よって通知は「スロット自身の条件 (fnmCustomCache) を最新 stats で
    // 評価し、main の再評価を通過したもの」だけが飛ぶ。viewer フィルタとは
    // 独立し、ON/OFF・条件変更は即時に反映される。filterAsinSnapshot は
    // viewer の「表示」絞り込み (applyFilter) 専用として引き続き使う。

    // FNM evaluation is now done entirely through saved カスタムフィルタ
    // slots. Each slot carries its own 通知 (Discord) and 自動ゴミ捨て
    // (auto soft-delete) toggles, so multiple independent rules can run
    // in parallel — replacing the old maint/notif tabs.
    //
    // We walk the active-context slots first; if any auto-trashes the
    // product we then cross-check the trash-context slots so 自動完全
    // 削除 still works on the same tick (the trashed product becomes a
    // trash-context candidate).
    let trashedThisTick = false;
    if (skipFnmThisTick) {
      // 個別設定価格が発火済み (個別優先) → 当ティックは FNM スロット評価を
      // スキップ。
    } else
    for (let si = 0; si < fnmCustomCache.active.length; si++) {
      const slot = fnmCustomCache.active[si];
      if (!slot.state) continue;
      if (!slot.notifEnabled && !slot.autoTrashEnabled) continue;
      if (!hasAnyConditionEnabled(slot.state)) continue;
      if (!passesAllConditions(product, slot.state)) continue;
      if (slot.notifEnabled) {
        window.api.invoke('fireFnmNotification', {
          asin, context: 'active', product,
          slotIndex: si,
          slotName:  slot.name || `カスタムフィルタ${si + 1}`,
        }).catch(() => {});
      }
      if (slot.autoTrashEnabled) {
        window.api.invoke('softDelete', { asins: [asin] }).catch(() => {});
        triggeredAutoAction = true;
        trashedThisTick = true;
        break;       // Trashed — no further active slot matters
      }
    }
    if (trashedThisTick) {
      // Cascade into trash-context slots (their 自動ゴミ捨て toggle is
      // semantically 完全削除 in the trash view, executed via hardDelete).
      for (let si = 0; si < fnmCustomCache.trash.length; si++) {
        const slot = fnmCustomCache.trash[si];
        if (!slot.state) continue;
        if (!slot.notifEnabled && !slot.autoTrashEnabled) continue;
        if (!hasAnyConditionEnabled(slot.state)) continue;
        if (!passesAllConditions(product, slot.state)) continue;
        if (slot.notifEnabled) {
          window.api.invoke('fireFnmNotification', {
            asin, context: 'trash', product,
            slotIndex: si,
            slotName:  slot.name || `カスタムフィルタ${si + 1}`,
          }).catch(() => {});
        }
        if (slot.autoTrashEnabled) {
          window.api.invoke('hardDelete', { asins: [asin] }).catch(() => {});
          break;
        }
      }
      continue;       // Skip the row-update for a trashed product
    }

    const tr = visibleRows.get(asin);
    if (!tr) continue;
    // ★ 監視クロール中 (crawlCycleStartedAt > 0) は、表示中の行を「ライブ再描画」
    // しない (2026-06, client報告 項目1/2)。リストは「更新」ボタン / 並び替え /
    // フィルタ実行を押した時点の静止スナップショットとして凍結する。
    //   理由: クロール中に各行の値 (平均・最新実質・FBA利益額・ROE 等) がライブで
    //   動くと、凍結された並び順と食い違って「順番がバラバラ」に見え、また平均値が
    //   刻々変わるため「利益計算が合わない」ように見える (実際は各時点で整合)。
    //   上の statsCache 更新・通知判定は実行済みなので、通知とデータ鮮度は維持される。
    //   markRefreshButtonDirty() で「更新」ボタンを点灯させ、押せば最新表示に切替。
    //   クロール停止中 (=0) の積み残し flush は通常どおり描画する。
    if (crawlCycleStartedAt > 0) continue;
    updateRow(tr, product);
    // updateRow が statsCache を読んで cell-effective の差額/% を描画する。
    // freshStats はループ先頭で IPC 取得済みでキャッシュ済みなので
    // fetchStatsFor を再呼び出ししない (二重 IPC 防止)。
    if (freshStats) updateRowStats(tr, freshStats);
    const canvas = tr.querySelector('.cell-keepa canvas[data-spark-asin]');
    if (canvas) loadSparkline(canvas, asin);
  }
  if (triggeredAutoAction) scheduleAutoReload();
}

// ── Cycle progress ──────────────────────────────────────────

function showCycleProgress(p) {
  const ring = $('#cycle-progress');
  const counts = $('#cycle-progress-counts');
  ring.classList.remove('hidden');
  counts.classList.remove('hidden');
  counts.textContent = `${p.done} / ${p.total}`;
  const pct = p.total > 0 ? (p.done / p.total * 100) : 0;
  $('#cycle-progress-fg').style.strokeDashoffset = (100 - pct).toFixed(2);
  $('#cycle-progress-pct').textContent = `${Math.round(pct)}%`;
  ring.title = `最新データ取得の進捗 — wave ${p.wave || 1}`;
}

function hideCycleProgress() {
  $('#cycle-progress').classList.add('hidden');
  $('#cycle-progress-counts').classList.add('hidden');
}

// ── 監視周期バッジ (2026-05) ─────────────────────────────────
//
// ヘッダーの「監視周期 : ○○分」表示。CYCLE_COMPLETE が来るたびに更新、
// 起動時は DB から直近 1 件を取って復元する。表記は「X分Y秒」が原則
// だが、1 分未満なら「X秒」、1 時間以上なら「X時間Y分」に切替。

function formatCycleDurationJp(ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const totalMin = Math.floor(totalSec / 60);
  const sec      = totalSec % 60;
  if (totalMin < 60) {
    return sec === 0 ? `${totalMin}分` : `${totalMin}分${sec}秒`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

function updateLastCycleTimeBadge(elapsedMs) {
  const el = $('#last-cycle-time');
  if (!el) return;
  if (elapsedMs == null || !isFinite(elapsedMs) || elapsedMs <= 0) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = `監視周期 : ${formatCycleDurationJp(elapsedMs)}`;
  el.classList.remove('hidden');
}

async function loadLastCycleTimeBadge() {
  try {
    const row = await window.api.invoke('getLastCycleTime');
    if (row && row.elapsed_ms) {
      updateLastCycleTimeBadge(row.elapsed_ms);
    }
  } catch { /* 起動直後で DB 未対応列の可能性、無視 */ }
}

// ── ソフトボット (ロボット認証) ブロッキングモーダル ─────────────
//
// Amazon のボット検知で商品ページの代わりに確認ページが返ると、main の
// scheduler がクロールを一時停止して blockedUntil を立てる (getStatus 経由で
// 同期)。ここではその状態を全画面モーダルで明示し、①待つ(自動再開) ②再ログイン
// ③手動認証 の3つの解決手段を提示する。show は onCaptchaPause で即時、hide は
// onCaptchaResume / クリーンな onCycleComplete / 監視停止 で行う。カウントダウンの
// 時刻は getStatus.blockedUntil を正として refreshStatus で同期する。
let captchaCountdownTimer = null;
let captchaModalUntil = 0;       // 自動再開の絶対時刻 (ms)
let captchaModalShown = false;

function showCaptchaModal(p) {
  p = p || {};
  // 自動再開時刻: scheduler の blockedUntil 優先、無ければ pause 期限 / 既定10分。
  const fallback = Date.now() + 10 * 60 * 1000;
  captchaModalUntil = p.until || p.pausedUntil || captchaModalUntil || fallback;
  // 理由テキスト (内部挙動の露出) は B10 で撤去 — p.reason は表示しない。
  const modal = $('#captcha-modal');
  if (modal) modal.classList.remove('hidden');
  captchaModalShown = true;
  updateCaptchaCountdown();
  if (captchaCountdownTimer) clearInterval(captchaCountdownTimer);
  captchaCountdownTimer = setInterval(updateCaptchaCountdown, 1000);
  // Solve / Login ボタンの click は setupSessionControls() で1回だけ束ねる。
}

function updateCaptchaCountdown() {
  const el = $('#captcha-modal-countdown');
  if (!el) return;
  const rem = captchaModalUntil - Date.now();
  if (rem <= 0) { el.textContent = '0:00'; return; }
  const m = Math.floor(rem / 60000);
  const s = Math.ceil((rem % 60000) / 1000);
  el.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function hideCaptchaModal() {
  if (!captchaModalShown) return;
  captchaModalShown = false;
  captchaModalUntil = 0;
  const modal = $('#captcha-modal');
  if (modal) modal.classList.add('hidden');
  if (captchaCountdownTimer) { clearInterval(captchaCountdownTimer); captchaCountdownTimer = null; }
}

// ── Circuit-breaker banner ──────────────────────────────────

let circuitCountdownTimer = null;
let circuitActiveUntil = 0;

function showCircuitBanner(state) {
  circuitActiveUntil = state.until || 0;
  $('#circuit-banner').classList.remove('hidden');
  updateCircuitCountdown();
  if (circuitCountdownTimer) clearInterval(circuitCountdownTimer);
  circuitCountdownTimer = setInterval(updateCircuitCountdown, 60_000);
}

function updateCircuitCountdown() {
  const rem = circuitActiveUntil - Date.now();
  if (rem <= 0) { hideCircuitBanner(); return; }
  const h = Math.floor(rem / 3_600_000);
  const m = Math.floor((rem % 3_600_000) / 60_000);
  $('#circuit-remaining').textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function hideCircuitBanner() {
  $('#circuit-banner').classList.add('hidden');
  if (circuitCountdownTimer) { clearInterval(circuitCountdownTimer); circuitCountdownTimer = null; }
}

// ── Login gate ──────────────────────────────────────────────
//
// Shown on startup when the user has no valid `at-main` cookie for
// amazon.co.jp. Hidden once sign-in is detected (or once the user
// explicitly chooses to continue without signing in).

async function checkInitialLoginGate() {
  const state = await window.api.invoke('checkLoginStatus');
  const loggedIn = !!(state && state.loggedIn);
  if (loggedIn) hideLoginGate(); else showLoginGate();
  updateLoginButton(loggedIn);
}

// Reflect login state in the header button so the user has visual
// confirmation that their session is persisted. Still clickable either
// way — re-opening the login window is how you switch accounts.
function updateLoginButton(loggedIn) {
  const btn = $('#btn-login');
  if (btn) {
    if (loggedIn) {
      btn.textContent = '✓ Signed in';
      btn.classList.add('logged-in');
      btn.title = 'Signed in to Amazon — click to switch account';
    } else {
      btn.textContent = 'Login';
      btn.classList.remove('logged-in');
      btn.title = 'Sign in to Amazon — a logged-in session significantly reduces CAPTCHA rate';
    }
  }
  // ログアウトボタンはログイン中のみ表示 (未ログイン時は不要)。
  const logoutBtn = $('#btn-logout');
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !loggedIn);
}

function showLoginGate() {
  $('#login-gate').classList.remove('hidden');
}

function hideLoginGate() {
  $('#login-gate').classList.add('hidden');
}

function setupLoginGate() {
  $('#btn-login-gate').addEventListener('click', () => {
    window.api.invoke('openLogin').catch((e) => console.warn('openLogin:', e));
  });
  $('#btn-skip-login').addEventListener('click', () => {
    // User explicitly accepts the higher CAPTCHA risk. Dismissing the
    // gate doesn't auto-start the scheduler — they have to click Start
    // in the header, which signals deliberate intent to scrape without
    // an authenticated session.
    hideLoginGate();
  });
}

// ── Session controls (Login + Circuit-clear + CAPTCHA solve) ──

function setupSessionControls() {
  const loginBtn = $('#btn-login');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      window.api.invoke('openLogin').catch((e) => console.warn('openLogin:', e));
    });
  }

  // ログアウト (client request) — 確認後にセッション破棄。別アカウントログイン
  // やパスワード変更後の再ログイン用。成功したらログインゲートを再表示。
  const logoutBtn = $('#btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const ok = window.confirm(
        'Amazon からログアウトします。\n' +
        '（別アカウントでログインしたい場合や、パスワード変更後の再ログイン時にご利用ください）\n\n' +
        'よろしいですか？'
      );
      if (!ok) return;
      logoutBtn.disabled = true;
      try {
        const res = await window.api.invoke('logout').catch(() => ({ ok: false }));
        if (res && res.ok) {
          updateLoginButton(false);   // ボタン状態 + ログアウトボタン非表示
          showLoginGate();            // 再ログインを促す
          await refreshStatus();      // 監視停止状態を反映
        } else {
          window.alert('ログアウトに失敗しました。もう一度お試しください。');
        }
      } finally {
        logoutBtn.disabled = false;
      }
    });
  }

  const clearBtn = $('#circuit-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await window.api.invoke('clearCircuitBreaker').catch(() => {});
      hideCircuitBanner();
      await refreshStatus();
    });
  }

  // 「手動でロボット認証を解除」ボタンは 2026-06 client要望で撤去 (ブラウザ側には
  // 認証画面が出ず実効性が無かったため)。solveCaptcha 配線も削除。

  // ブロックモーダルの「Amazonにサインインして解除」— ログイン窓を開く。
  // main 側 onLoginSuccess がブロック中なら liftPause + resumeFromBlock する。
  // 「Amazonにサインインしてアクセス可能な上限を拡大」(旧: サインインして解除)。
  const captchaLoginBtn = $('#captcha-modal-login');
  if (captchaLoginBtn) {
    captchaLoginBtn.addEventListener('click', () => {
      window.api.invoke('openLogin').catch((e) => console.warn('openLogin:', e));
    });
  }
  // 「Amazonが返したページを確認」ボタンは B10 で撤去 (URL/まとめ検索が露出し
  // 内部アルゴリズム漏洩につながるため)。viewBlockedPage を呼ぶ UI 経路は無し。
}

// ── Chart modal ─────────────────────────────────────────────
//
// Opens when a product card is clicked. Renders four stacked line
// charts (price / effective price / MP price / MP offer count) over
// a user-selectable time window, with click-to-configure axes.

// Time-window preset → { fromMs, toMs } relative to now.
// Note: 'all' is handled out-of-band by resolveAllPeriodRange() since
// it needs an IPC round-trip to read the per-product observation span.
// The fallback here is only used if that resolver is not invoked.
function periodToRange(period) {
  const now = Date.now();
  const day = 86_400_000;
  switch (period) {
    case '1d':  return { from: now -   1 * day, to: now };
    case '1w':  return { from: now -   7 * day, to: now };
    case '1m':  return { from: now -  30 * day, to: now };
    case '3m':  return { from: now -  90 * day, to: now };
    case '6m':  return { from: now - 180 * day, to: now };
    case '1y':  return { from: now - 365 * day, to: now };
    case 'all': return { from: now - 10 * 365 * day, to: now };
    default:    return { from: now -   7 * day, to: now };
  }
}

// 「全期間」resolver — asks the backend for the per-product observation
// span (raw + daily union). Falls back to "last 7 days" if the product
// has no observations yet so the chart still has a sane axis to draw.
async function resolveAllPeriodRange(asin) {
  if (!asin) return periodToRange('1w');
  try {
    const span = await window.api.invoke('getObservationSpan', { asin });
    if (span && span.firstAt && span.lastAt && span.lastAt > span.firstAt) {
      return { from: span.firstAt, to: span.lastAt };
    }
    // Single observation — degenerate range. Pad ±1 hour so the line
    // and dot draw with breathing room rather than collapsing to one X.
    if (span && span.firstAt) {
      const t = span.firstAt;
      return { from: t - 3_600_000, to: t + 3_600_000 };
    }
  } catch (e) {
    console.warn('resolveAllPeriodRange:', e);
  }
  return periodToRange('1w');
}

// 監視グラフ — series colors / point shapes per spec image 3.
// 実質価格 = magenta dots + step line; 他の出品価格 = black squares;
// 出品者数 = blue triangles on the bottom chart.
const COLOR_EFFECTIVE   = '#FF1493';   // magenta — 実質価格
const COLOR_OTHER       = '#D1D5DB';   // light gray (spec asks black,
                                       //   adapted for dark theme)
const COLOR_SELLERS     = '#1E90FF';   // blue — 出品者数
const COLOR_AMAZON      = '#FF9900';   // orange — Ama本体価格 (項目14)
const COLOR_IMP_SELLERS = '#34d399';   // green — 新品出品数(取込) 単一点 (項目9)

// Average-period radio → metadata used to render the dashed line and
// label values. The selected entry is the only average drawn.
const AVG_PERIODS = [
  { key: 'avg1d',   label: '1日平均'   },
  { key: 'avg7d',   label: '7日平均'   },
  { key: 'avg30d',  label: '30日平均'  },
  { key: 'avg90d',  label: '90日平均'  },
  { key: 'avg180d', label: '180日平均' },
];

let priceChart   = null;             // top chart (price + average)
let countChart   = null;             // bottom chart (出品者数)
let currentChartAsin = null;
let currentPeriod    = '1w';         // default 7-day per spec
let currentAvgKey    = 'avg7d';      // default 7-day average per spec
let lastChartData    = null;         // cached IPC response for re-render
let currentXFrom = 0;
let currentXTo   = 0;

// ASIN をクリップボードにコピー + 視覚フィードバック (1.2 秒だけ
// 「コピーしました」表示)。ビューア表のセルと詳細グラフモーダル両方の
// `[data-copy-asin]` 要素から共通で呼ばれる。
//
// 復元値は `el.dataset.copyAsin` から引く (textContent ではない)。
// textContent を毎回参照すると、1.2 秒の表示中にダブルクリックされた
// 場合に「コピーしました」自身を `orig` として記憶 → タイマー満了で
// 「コピーしました」に戻る → 永遠に ASIN が消える、というバグになる
// (2026-05 fix)。data-copy-asin は createRow / 通知履歴描画時にセット
// されてから一度も書き換えられないため、必ず元の ASIN を保持している。
async function copyAsinToClipboard(el) {
  const asin = el.dataset.copyAsin || el.textContent.trim();
  if (!asin) return;
  try {
    await navigator.clipboard.writeText(asin);
  } catch (err) {
    console.warn('[copy-asin] clipboard write failed:', err.message);
    return;
  }
  el.textContent = 'コピーしました';
  el.classList.add('asin-copy-flash');
  if (el._asinCopyTimer) clearTimeout(el._asinCopyTimer);
  el._asinCopyTimer = setTimeout(() => {
    // 復元は必ず data-copy-asin から — el.textContent からだとループする。
    el.textContent = el.dataset.copyAsin || asin;
    el.classList.remove('asin-copy-flash');
    el._asinCopyTimer = null;
  }, 1200);
}

function setupChartModal() {
  $('#chart-modal-close').addEventListener('click', closeChartModal);

  // Backdrop click (on the overlay itself, not the card) closes.
  $('#chart-modal').addEventListener('click', (e) => {
    if (e.target.id === 'chart-modal') closeChartModal();
  });

  // 詳細グラフモーダルのヘッダーに表示している ASIN もクリックで
  // クリップボードへコピー。openChartModal 側で data-copy-asin / title
  // / asin-copy クラスを毎回付け直している。
  $('#chart-modal-asin').addEventListener('click', (e) => {
    const t = e.target.closest('[data-copy-asin]');
    if (t) copyAsinToClipboard(t);
  });

  // 詳細グラフモーダルの商品名クリックで Amazon 商品ページを開く。
  // openChartModal で data-product-link / title-link クラスを毎回設定。
  $('#chart-modal-name').addEventListener('click', (e) => {
    const t = e.target.closest('[data-product-link]');
    if (t) {
      window.api.invoke('openProductPage', { asin: t.dataset.productLink });
    }
  });

  // 表示期間 radios — drives both charts' X axis.
  document.querySelectorAll('input[name="chart-period"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      currentPeriod = radio.value;
      // 「全期間」: per spec, X-axis should span the actual oldest →
      // newest observation for THIS product, not a hardcoded 10-year
      // window. Fetch the real span from the backend (raw observations
      // ∪ daily aggregates).
      if (currentPeriod === 'all') {
        const span = await resolveAllPeriodRange(currentChartAsin);
        currentXFrom = span.from;
        currentXTo   = span.to;
      } else {
        const range = periodToRange(currentPeriod);
        currentXFrom = range.from;
        currentXTo   = range.to;
      }
      await loadChartData();
    });
  });

  // 平均期間 radios — pick which of the 5 averages renders dashed.
  document.querySelectorAll('input[name="chart-avg"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      currentAvgKey = radio.value;
      if (lastChartData) renderMonitoringCharts();
    });
  });

  // オートレンジ checkboxes — per chart.
  $('#chart-autorange-price').addEventListener('change', (e) => {
    if (priceChart) priceChart.setAutoRange(e.target.checked);
  });
  $('#chart-autorange-count').addEventListener('change', (e) => {
    if (countChart) countChart.setAutoRange(e.target.checked);
  });

  // 最小値ゼロ checkboxes (2026-06 client spec) — per chart.
  // 設定変更を保存して、次回モーダルを開いた時にも復元する。
  $('#chart-minzero-price').addEventListener('change', (e) => {
    if (priceChart) priceChart.setMinZero(e.target.checked);
    saveChartMinZeroPref('price', e.target.checked);
  });
  $('#chart-minzero-count').addEventListener('change', (e) => {
    if (countChart) countChart.setMinZero(e.target.checked);
    saveChartMinZeroPref('count', e.target.checked);
  });

  // Axis editor buttons (the editor itself gets shown on demand).
  $('#axis-editor-cancel').addEventListener('click', hideAxisEditor);
  $('#axis-editor').addEventListener('click', (e) => {
    if (e.target.id === 'axis-editor') hideAxisEditor();
  });

  // Escape closes whichever overlay is on top.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#axis-editor').classList.contains('hidden')) hideAxisEditor();
    else if (!$('#chart-modal').classList.contains('hidden')) closeChartModal();
  });
}

async function openChartModal(asin) {
  currentChartAsin = asin;
  const product = allProducts.find((p) => p.asin === asin);
  // ASIN ヘッダーはクリックでクリップボードへコピー。属性を毎回再設定
  // しないと、コピー後の「コピーしました」表示が残ったまま次回開いた
  // ときに上書きされない可能性があるため、確実に同期する。
  const asinEl = $('#chart-modal-asin');
  asinEl.textContent = asin;
  asinEl.setAttribute('data-copy-asin', asin);
  asinEl.setAttribute('title', 'クリックで ASIN をコピー');
  asinEl.classList.add('asin-copy');
  // 商品名はクリックで Amazon 商品ページを開く (cell の商品名と同じ挙動)。
  const nameEl = $('#chart-modal-name');
  nameEl.textContent = (product && product.title) || '(title unknown)';
  nameEl.setAttribute('data-product-link', asin);
  nameEl.setAttribute('title', 'クリックで Amazon 商品ページを開く');
  nameEl.classList.add('title-link');
  $('#chart-modal').classList.remove('hidden');

  // Reset to spec defaults on every open: 7-day window, 7-day average,
  // auto-range ON for both charts.
  currentPeriod = '1w';
  currentAvgKey = 'avg7d';
  document.querySelectorAll('input[name="chart-period"]').forEach((r) => {
    r.checked = (r.value === currentPeriod);
  });
  document.querySelectorAll('input[name="chart-avg"]').forEach((r) => {
    r.checked = (r.value === currentAvgKey);
  });
  $('#chart-autorange-price').checked = true;
  $('#chart-autorange-count').checked = true;
  // 最小値ゼロ (2026-06): デフォルトは ON。ユーザーが OFF にした設定は
  // settings に保存されるので、それを復元する (未保存なら ON のまま)。
  $('#chart-minzero-price').checked = chartMinZeroPref.price;
  $('#chart-minzero-count').checked = chartMinZeroPref.count;

  const range = periodToRange(currentPeriod);
  currentXFrom = range.from;
  currentXTo   = range.to;

  // Pre-fetch stats so the top stats table populates immediately on
  // open, instead of showing "—" until a row scroll loads them later.
  // fetchStatsFor is a no-op if statsCache already has the entry.
  fetchStatsFor(asin).catch(() => {});

  await loadChartData();
}

function closeChartModal() {
  $('#chart-modal').classList.add('hidden');
  hideAxisEditor();
  if (priceChart) { priceChart.destroy(); priceChart = null; }
  if (countChart) { countChart.destroy(); countChart = null; }
  lastChartData = null;
  currentChartAsin = null;
}

async function loadChartData() {
  if (!currentChartAsin) return;
  const from = currentXFrom;
  const to   = currentXTo;
  let data;
  try {
    data = await window.api.invoke('getMonitoringChartData', {
      asin: currentChartAsin, from, to,
    });
  } catch (e) {
    console.warn('getMonitoringChartData:', e);
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  lastChartData = data;
  renderMonitoringCharts();
}

// Render both charts from the cached IPC response. Re-runnable when the
// average radio changes (no refetch needed) or after the user clicks
// either axis (range change → may need refetch handled by caller).
function renderMonitoringCharts() {
  const data   = lastChartData || {};
  const priceCanvas = document.querySelector('#monitoring-chart-canvas');
  const countCanvas = document.querySelector('#seller-count-canvas');
  if (!priceCanvas || !countCanvas) return;

  if (!priceChart) {
    priceChart = new window.TimeSeriesChart(priceCanvas, {
      yFormatter: (v) => `¥${Number(Math.round(v)).toLocaleString()}`,
      autoRange:  $('#chart-autorange-price').checked,
      minZero:    $('#chart-minzero-price').checked,
    });
    priceChart.onAxisClick((axis, info) => {
      if (axis === 'y') {
        showAxisEditor(priceChart, { key: 'price', label: '価格 [円]' }, 'y', info);
      } else {
        // X-axis edit applies to both charts. The shared editor
        // re-runs loadChartData() so a wider window can re-fetch.
        showAxisEditor(null, { key: 'shared-x', label: '日時' }, 'x', info);
      }
    });
  } else {
    priceChart.setAutoRange($('#chart-autorange-price').checked);
    priceChart.setMinZero($('#chart-minzero-price').checked);
  }
  if (!countChart) {
    countChart = new window.TimeSeriesChart(countCanvas, {
      yFormatter: (v) => `${Math.round(v)}`,
      autoRange:  $('#chart-autorange-count').checked,
      minZero:    $('#chart-minzero-count').checked,
      // 出品者数 is an integer count; clamp the auto-range tick floor
      // to 1 so the labels never fall to 0.5-person increments
      // (which would render as duplicate "12,12,11,11,…" rounded
      // labels for narrow value ranges).
      minTick: 1,
    });
    countChart.onAxisClick((axis, info) => {
      if (axis === 'y') {
        showAxisEditor(countChart, { key: 'count', label: '出品者数 [人]' }, 'y', info);
      } else {
        showAxisEditor(null, { key: 'shared-x', label: '日時' }, 'x', info);
      }
    });
  } else {
    countChart.setAutoRange($('#chart-autorange-count').checked);
    countChart.setMinZero($('#chart-minzero-count').checked);
  }

  // Top chart: 実質価格 + 他の出品価格 + the chosen average (dashed).
  const priceSeries = [
    {
      color:      COLOR_EFFECTIVE,
      lineWidth:  2,
      points:     data.effective || [],
      stepLine:   true,
      pointShape: 'circle',
      markerSize: 4,
    },
    {
      color:      COLOR_OTHER,
      lineWidth:  1.6,
      points:     data.otherSellers || [],
      stepLine:   true,
      pointShape: 'square',
      markerSize: 3.5,
    },
    // Ama本体価格 (項目14) — オレンジのドットのみ (疎なデータ、連結線なし)。
    {
      color:      COLOR_AMAZON,
      points:     data.amazon || [],
      dotsOnly:   true,
      pointShape: 'circle',
      markerSize: 4,
    },
    {
      color:      COLOR_EFFECTIVE,
      lineWidth:  1.4,
      points:     data[currentAvgKey] || [],
      dashed:     true,
      pointShape: null,
      showDots:   false,
    },
  ];
  priceChart.setSeries(priceSeries, currentXFrom, currentXTo);

  // Bottom chart: 出品者数 only.
  const countSeries = [{
    color:      COLOR_SELLERS,
    lineWidth:  1.8,
    points:     data.sellerCount || [],
    stepLine:   true,
    pointShape: 'triangle',
    markerSize: 4.5,
  }];
  // 新品出品数(取込) (項目9) — 他の出品価格と同じく「最新1点のみ」を右端に
  // プロット。imp_sellers は 1 スカラなので currentXTo (= 今) に 1 点だけ置く。
  if (data.impSellers != null) {
    countSeries.push({
      color:      COLOR_IMP_SELLERS,
      points:     [{ t: currentXTo, v: data.impSellers }],
      dotsOnly:   true,
      pointShape: 'diamond',
      markerSize: 5,
    });
  }
  countChart.setSeries(countSeries, currentXFrom, currentXTo);

  updateLegendValues(data);
  renderChartStatsTable(data);
}

// Populate the 4-row × 7-col stats table at the top of the chart modal.
// Mirrors the Discord notification image so the in-app view and the
// Discord view show the same headline numbers in the same layout.
// Latest effective price is taken from the last point of the
// `effective` series (which getMonitoringChartData computes already);
// averages and diffs come from getProductStats via statsCache.
function renderChartStatsTable(data) {
  const grid = $('#chart-stats-table');
  if (!grid) return;
  // Latest effective: last point of the effective series.
  const eff = Array.isArray(data.effective) && data.effective.length > 0
    ? data.effective[data.effective.length - 1].v
    : null;
  // Pull stats from the cache (populated lazily by fetchStatsFor).
  // Fall back to recomputing diffs from the chart series if stats
  // haven't loaded yet for this ASIN.
  const stats = statsCache.get(currentChartAsin) || {};
  const lastOf = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr[arr.length - 1].v : null;
  const avgOrSeriesLast = (statKey, seriesKey) =>
    (stats[statKey] != null) ? stats[statKey] : lastOf(data[seriesKey]);
  const avgs = {
    avg1d:   avgOrSeriesLast('avg1d',   'avg1d'),
    avg7d:   avgOrSeriesLast('avg7d',   'avg7d'),
    avg30d:  avgOrSeriesLast('avg30d',  'avg30d'),
    avg90d:  avgOrSeriesLast('avg90d',  'avg90d'),
    avg180d: avgOrSeriesLast('avg180d', 'avg180d'),
  };
  const diff = (avg) => (avg == null || eff == null) ? null : (avg - eff);
  const pct  = (avg) => {
    if (avg == null || !isFinite(avg) || avg === 0 || eff == null) return null;
    return (avg - eff) / avg * 100;
  };
  // 実質最新価格列の 差額 / 下落率 は 「1 個前の監視価格との比較」 =
  // 瞬間下落価格 / 瞬間下落率 を表示する (クライアント要望、2026-05)。
  //   瞬間下落価格 = 1個前 − 最新   (正値なら「価格が下がった」)
  //   瞬間下落率   = 瞬間下落価格 ÷ 1個前 × 100
  // prev が無い (観測 1 件のみの新規商品) 場合は diff/pct 共に null →
  // フォーマッタが '—' を返すので「—」表示にフォールバック。
  const prevEff = (stats && stats.prevEffective != null) ? stats.prevEffective : null;
  const instantDiff = (prevEff != null && eff != null) ? (prevEff - eff) : null;
  const instantPct  = (instantDiff != null && prevEff != null && prevEff !== 0)
                        ? (instantDiff / prevEff) * 100 : null;
  const cols = [
    { hdr: '実質最新価格', val: eff,         diff: instantDiff,        pct: instantPct },
    { hdr: '1日平均',      val: avgs.avg1d,   diff: diff(avgs.avg1d),   pct: pct(avgs.avg1d) },
    { hdr: '7日平均',      val: avgs.avg7d,   diff: diff(avgs.avg7d),   pct: pct(avgs.avg7d) },
    { hdr: '30日平均',     val: avgs.avg30d,  diff: diff(avgs.avg30d),  pct: pct(avgs.avg30d) },
    { hdr: '90日平均',     val: avgs.avg90d,  diff: diff(avgs.avg90d),  pct: pct(avgs.avg90d) },
    { hdr: '180日平均',    val: avgs.avg180d, diff: diff(avgs.avg180d), pct: pct(avgs.avg180d) },
  ];
  const fmtYen  = (v) => (v == null || !isFinite(v)) ? '—' : '¥' + Math.round(v).toLocaleString('ja-JP');
  const fmtDiff = (d) => (d == null || !isFinite(d)) ? '—' : '¥' + (d > 0 ? '+' : '') + Math.round(d).toLocaleString('ja-JP');
  const fmtPct  = (p) => (p == null || !isFinite(p)) ? '—' : (p > 0 ? '+' : '') + p.toFixed(1) + '%';
  const sign = (n) => (n == null || !isFinite(n)) ? 'flat' : (n > 0 ? 'pos' : (n < 0 ? 'neg' : 'flat'));

  const cells = [];
  // Row 1 — header row
  cells.push('<div class="chart-stats-cell header"></div>');
  for (const c of cols) cells.push(`<div class="chart-stats-cell header">${c.hdr}</div>`);
  // Row 2 — 価格
  cells.push('<div class="chart-stats-cell label">価格</div>');
  for (const c of cols) cells.push(`<div class="chart-stats-cell value-price">${fmtYen(c.val)}</div>`);
  // Row 3 — 差額 (実質最新列は瞬間下落価格、それ以外は平均との差額)
  cells.push('<div class="chart-stats-cell label">差額</div>');
  for (const c of cols) {
    cells.push(`<div class="chart-stats-cell ${sign(c.diff)}">${fmtDiff(c.diff)}</div>`);
  }
  // Row 4 — 下落率 (実質最新列は瞬間下落率、それ以外は平均下落率)
  cells.push('<div class="chart-stats-cell label">下落率</div>');
  for (const c of cols) {
    cells.push(`<div class="chart-stats-cell ${sign(c.diff)}">${fmtPct(c.pct)}</div>`);
  }

  // Row 5/6 — 利益額 (FBA利益額) / 利益率 (ROE利益率) (2026-06 spec 項目11)。
  // 各列の基準実質 (実質最新列=瞬間=1個前実質、他列=N日平均実質) と最新実質 eff・
  // 各手数料から、リストの FBA利益額/ROE 列と同じ式で算出する:
  //   利益額 = 基準実質 − 最新実質 − Amazon販売手数料 − FBA販売手数料 − 在庫保管料
  //   利益率 = 利益額 ÷ 最新実質 × 100
  // 着色は利益の符号 (プラス→赤=pos / マイナス→青=neg) — リストの利益セルと統一。
  const prodForFees = productIndex.has(currentChartAsin)
    ? allProducts[productIndex.get(currentChartAsin)] : null;
  const af = prodForFees ? prodForFees.amazon_fee : null;
  const ff = prodForFees ? prodForFees.fba_fee : null;
  const sf = prodForFees ? prodForFees.inventory_storage_fee : null;
  // 列順 (実質最新/1日/7日/30日/90日/180日) に対応する基準実質。
  const refs = [prevEff, avgs.avg1d, avgs.avg7d, avgs.avg30d, avgs.avg90d, avgs.avg180d];
  const PROFIT_SANITY = 0.2;
  const amtFromRef = (ref) => {
    if (ref == null || eff == null) return null;
    if (eff <= 0 || eff < ref * PROFIT_SANITY) return null;
    if (af == null || ff == null || sf == null) return null;
    return ref - eff - af - ff - sf;
  };
  const roeFromRef = (ref) => {
    const amt = amtFromRef(ref);
    if (amt == null || eff == null || eff === 0) return null;
    return (amt / eff) * 100;
  };
  const fmtAmt = (v) => (v == null || !isFinite(v))
    ? '—'
    : '¥' + (v < 0 ? '-' : '') + Math.abs(Math.round(v)).toLocaleString('ja-JP');
  const fmtRoe = (v) => (v == null || !isFinite(v))
    ? '—'
    : (v > 0 ? '+' : '') + Math.round(v) + '%';
  cells.push('<div class="chart-stats-cell label">利益額</div>');
  for (const ref of refs) {
    const v = amtFromRef(ref);
    cells.push(`<div class="chart-stats-cell ${sign(v)}">${fmtAmt(v)}</div>`);
  }
  cells.push('<div class="chart-stats-cell label">利益率</div>');
  for (const ref of refs) {
    const v = roeFromRef(ref);
    cells.push(`<div class="chart-stats-cell ${sign(v)}">${fmtRoe(v)}</div>`);
  }

  grid.innerHTML = cells.join('');
}

// Refresh the latest-value labels in the right-side legend rows.
function updateLegendValues(data) {
  const set = (key, val, formatter) => {
    const el = document.querySelector(`[data-value="${key}"]`);
    if (!el) return;
    el.textContent = (val == null || !isFinite(val)) ? '—' : formatter(val);
  };
  const yen = (v) => `¥${Math.round(v).toLocaleString()}`;
  const num = (v) => `${Math.round(v)} 人`;
  const last = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr[arr.length - 1].v : null;
  set('effective',    last(data.effective),    yen);
  set('otherSellers', last(data.otherSellers), yen);
  set('amazon',       last(data.amazon),       yen);   // Ama本体価格 (項目14)
  set('sellerCount',  last(data.sellerCount),  num);
  set('impSellers',   data.impSellers,         num);   // 新品出品数(取込) (項目9, スカラ)
  // 月間売行き個数 (項目B5) — 通知本文と同じ整形済み文字列 (data.salesLine)。
  // 月間販売数あり→「+N個」、無ければ 30日ランク変動(取込)→「N個」、両方無し→「—」。
  // 整形は main 側 (formatSalesCountLine) で実施済みなので、そのまま表示する。
  const salesEl = document.querySelector('[data-value="monthlySales"]');
  if (salesEl) salesEl.textContent = data.salesLine || '—';
  for (const a of AVG_PERIODS) {
    set(a.key, last(data[a.key]), yen);
  }
}

// ── Axis editor ─────────────────────────────────────────────

let axisEditorApply = null;  // currently-bound Apply handler

function showAxisEditor(chart, cfg, axis, info) {
  const title  = $('#axis-editor-title');
  const fields = $('#axis-editor-fields');
  const editor = $('#axis-editor');

  if (axis === 'y') {
    title.textContent = `縦軸設定 — ${labelForChart(cfg.key)}`;
    fields.innerHTML = `
      <label>最小値<input type="number" data-field="min" value="${Math.round(info.min)}"></label>
      <label>最大値<input type="number" data-field="max" value="${Math.round(info.max)}"></label>
      <label>目盛間隔<input type="number" data-field="tick" min="1" value="${Math.max(1, Math.round(info.tick))}"></label>
    `;
    axisEditorApply = () => {
      const min  = parseFloat(fields.querySelector('[data-field="min"]').value);
      const max  = parseFloat(fields.querySelector('[data-field="max"]').value);
      const tick = parseFloat(fields.querySelector('[data-field="tick"]').value);
      if (!isFinite(min) || !isFinite(max) || max <= min) return;
      // Manual Y values disable auto-range — keep the toggle in sync.
      if (chart === priceChart) $('#chart-autorange-price').checked = false;
      if (chart === countChart) $('#chart-autorange-count').checked = false;
      chart.setAutoRange(false);
      chart.setYAxis({ min, max, tick: (isFinite(tick) && tick > 0) ? tick : null });
      hideAxisEditor();
    };
  } else {
    title.textContent = `横軸設定 — ${labelForChart(cfg.key)}`;
    // Datetime-local lets the user pick H:MM granularity per spec
    // requirement #4 ("一番古い日と最近の日を詳細指定").
    const iso = (ms) => {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    fields.innerHTML = `
      <label>開始日時<input type="datetime-local" data-field="from" value="${iso(info.min)}"></label>
      <label>終了日時<input type="datetime-local" data-field="to"   value="${iso(info.max)}"></label>
    `;
    axisEditorApply = async () => {
      const fromStr = fields.querySelector('[data-field="from"]').value;
      const toStr   = fields.querySelector('[data-field="to"]').value;
      const fromMs  = Date.parse(fromStr);
      const toMs    = Date.parse(toStr);
      if (!isFinite(fromMs) || !isFinite(toMs) || toMs <= fromMs) return;

      // Shared-X edit applies to both charts. Refetch from backend so
      // the new window has correctly-trimmed series + rolling averages.
      if (cfg.key === 'shared-x') {
        // Clear any active period radio — user picked a custom range.
        document.querySelectorAll('input[name="chart-period"]').forEach((r) => r.checked = false);
        currentXFrom = fromMs;
        currentXTo   = toMs;
        hideAxisEditor();
        await loadChartData();
      } else if (chart) {
        chart.setXRange(fromMs, toMs);
        hideAxisEditor();
      }
    };
  }
  $('#axis-editor-apply').onclick = () => axisEditorApply && axisEditorApply();
  editor.classList.remove('hidden');
  fields.querySelector('input')?.focus();
}

function hideAxisEditor() {
  $('#axis-editor').classList.add('hidden');
  axisEditorApply = null;
}

function labelForChart(key) {
  return {
    price:    '価格 [円]',
    count:    '出品者数 [人]',
    'shared-x': '日時 (両グラフ共通)',
    netPrice: '価格 − ポイント (円)',
    mpPrice:  '第二価格 (円)',
    mpCount:  '新品出品者数',
  }[key] || key;
}

// ── Discord ─────────────────────────────────────────────────
// (The Alerts UI and its 4-rule conditions builder were removed —
// rule logic now lives in the FNM-settings modal with 20 conditions
// per spec. The conditions table + scheduler/evaluator pipeline are
// still in place for any pre-existing rules to keep firing until the
// FNM rule engine is wired in once the client finalises conditions.)

function setupDiscordControls() {
  $('#btn-save-discord').addEventListener('click', async () => {
    const url = $('#discord-url').value.trim();
    if (!url) return;
    await window.api.invoke('setDiscordWebhook', { url });
    showDiscordStatus('Webhook saved', 'success');
  });
  $('#btn-test-discord').addEventListener('click', async () => {
    const url = $('#discord-url').value.trim();
    if (!url) return;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Amazon 価格モニター', content: '✅ テスト通知' }),
      });
      showDiscordStatus(resp.ok ? 'Test sent!' : `Error: ${resp.status}`, resp.ok ? 'success' : 'error');
    } catch (err) {
      showDiscordStatus(`Error: ${err.message}`, 'error');
    }
  });
}

async function loadDiscord() {
  const result = await window.api.invoke('getDiscordWebhook');
  if (result?.url) $('#discord-url').value = result.url;
}

function showDiscordStatus(msg, type) {
  const el = $('#discord-status');
  el.textContent = msg;
  el.className = type;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── Keepa API キー (2026-06 spec 項目8) ──────────────────────
// インポート情報の定期自動更新で使う API キーを settings テーブル
// (key: keepaApiKey) に保存する。Discord webhook と同じ app レベル設定で、
// 「フィルタ・通知・メンテナンス設定」モーダル内に入力欄がある。実際の
// API 呼び出し (定期更新ジョブ) は別途 (詳細仕様待ち) 実装する。
function setupKeepaControls() {
  const saveBtn = $('#btn-save-keepa');
  const toggleBtn = $('#btn-toggle-keepa');
  const input = $('#keepa-api-key');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const key = (input?.value || '').trim();
      try {
        await window.api.invoke('setSetting', { key: 'keepaApiKey', value: key });
        showKeepaStatus(key ? 'API キーを保存しました' : 'API キーをクリアしました', 'success');
      } catch (err) {
        showKeepaStatus(`保存に失敗しました: ${err.message}`, 'error');
      }
    });
  }
  // 伏せ字 ⇔ 平文 の切替（入力確認用）。
  if (toggleBtn && input) {
    toggleBtn.addEventListener('click', () => {
      const masked = input.type === 'password';
      input.type = masked ? 'text' : 'password';
      toggleBtn.textContent = masked ? '隠す' : '表示';
    });
  }
  // 今すぐ更新 — 1 バッチを即時実行 (低頻度の定期更新を待たずに試せる)。
  const refreshBtn = $('#btn-keepa-refresh-now');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      showKeepaStatus('更新中…', 'success');
      try {
        const r = await window.api.invoke('keepaRefreshNow');
        if (!r) { showKeepaStatus('結果を取得できませんでした', 'error'); }
        else if (r.error)        { showKeepaStatus(`エラー: ${r.error}`, 'error'); }
        else if (r.skipped === 'no-key')        { showKeepaStatus('API キーが未設定です', 'error'); }
        else if (r.skipped === 'no-tokens')     { showKeepaStatus(`トークン不足（残り約 ${r.tokensEst ?? '?'}）。しばらく待って再試行してください`, 'error'); }
        else if (r.skipped === 'nothing-stale') { showKeepaStatus('更新対象はありません（全て最新）', 'success'); }
        else {
          const left = r.tokensLeft != null ? `／残トークン ${r.tokensLeft}` : '';
          showKeepaStatus(`${r.refreshed} 件を更新${r.missing ? `（${r.missing} 件は取得不可）` : ''}${left}`, 'success');
          // 反映を画面へ。
          await loadProducts();
        }
      } catch (err) {
        showKeepaStatus(`更新に失敗しました: ${err.message}`, 'error');
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }
}

async function loadKeepaApiKey() {
  try {
    const val = await window.api.invoke('getSetting', { key: 'keepaApiKey' });
    const input = $('#keepa-api-key');
    if (input && typeof val === 'string') input.value = val;
  } catch { /* 失敗時は空のまま */ }
}

function showKeepaStatus(msg, type) {
  const el = $('#keepa-status');
  if (!el) return;
  el.textContent = msg;
  el.className = type;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── Notifications ───────────────────────────────────────────

async function loadNotifications() {
  const notifs = await window.api.invoke('getNotifications');
  const container = $('#notification-list');
  if (!Array.isArray(notifs) || notifs.length === 0) {
    container.innerHTML = '<div class="empty-message">通知履歴はまだありません</div>';
    return;
  }
  container.innerHTML = notifs.map((n) => {
    const time = formatJpDateTime(n.sent_at);
    // スロット名は保存値を優先。古い通知 (列追加前) には slot_name が
    // 無いので、代替表示を出す。
    const slot = n.slot_name
      || (n.condition_id != null ? `Condition #${n.condition_id}` : 'フィルタ');
    const ctxBadge = n.context === 'trash'
      ? '<span class="notif-ctx notif-ctx-trash">ゴミ箱</span>'
      : '<span class="notif-ctx notif-ctx-active">監視リスト</span>';
    const discordBadge = n.discord_sent
      ? '<span class="notif-discord notif-discord-ok">Discord 送信済</span>'
      : '<span class="notif-discord notif-discord-skip">Discord 未送信</span>';
    const url = `https://www.amazon.co.jp/dp/${n.asin}`;
    const titleLine = n.title
      ? `<div class="notif-title" title="${escapeHtml(n.title)}">${escapeHtml(n.title)}</div>`
      : '';
    return `
      <div class="notif-item">
        <div class="notif-head">
          <span class="notif-time">${time}</span>
          <span class="notif-slot">${escapeHtml(slot)}</span>
          ${ctxBadge}
          ${discordBadge}
        </div>
        ${titleLine}
        <div class="notif-asin-row">
          <span class="notif-asin-label">ASIN:</span>
          <span class="asin-copy" data-copy-asin="${n.asin}" title="クリックで ASIN をコピー">${n.asin}</span>
        </div>
        <div class="notif-link-row">
          <span class="title-link notif-link" data-product-link="${n.asin}" title="クリックで Amazon 商品ページを開く">${url}</span>
        </div>
      </div>
    `;
  }).join('');
}
