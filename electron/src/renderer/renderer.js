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
  // setupScrapeToggle removed — per spec the only crawl start button
  // is 監視スタート in the bulk toolbar (which sends the user's
  // ✅checked subset to startScraping). The header now just shows
  // status + item count.
  setupSessionControls();
  setupLoginGate();
  setupChartModal();
  setupHistoryModal();

  window.addEventListener('resize', () => renderVisible());

  // 2. Async data loading — best-effort, errors don't break the UI.
  (async () => {
    try { await checkInitialLoginGate(); } catch (e) { console.warn('init loginGate:', e); }
    try { await refreshStatus(); }     catch (e) { console.warn('init refreshStatus:', e); }
    try { await loadFnmStateCache(); } catch (e) { console.warn('init fnmCache:', e); }
    // 監視グラフの期間設定を loadProducts より前に読み込む。loadProducts
    // → renderHeader が動く時点で sparklineDays が確定している必要がある。
    try { await loadSparklinePref(); } catch (e) { console.warn('init sparklinePref:', e); }
    try { await loadProducts(); }      catch (e) { console.warn('init loadProducts:', e); }
    try { await loadDiscord(); }       catch (e) { console.warn('init loadDiscord:', e); }
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
  loadProducts(); // refresh full list with final state
});

window.api.onCaptchaPause((p) => {
  showCaptchaBanner(p);
});

window.api.onCaptchaResume(() => {
  hideCaptchaBanner();
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

  const dot  = $('#status-indicator');
  const text = $('#status-text');
  const cnt  = $('#product-count');

  if (status.running) {
    dot.className  = 'status-dot online';
    if (status.paused) {
      text.textContent = 'Paused (CAPTCHA)';
    } else if (status.circuitBreaker && status.circuitBreaker.active) {
      text.textContent = 'Scraping (reduced)';
    } else {
      text.textContent = `Scraping${status.restrictionCount != null ? ` (${status.restrictionCount} 件)` : ''}`;
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
    lastKnownRunning = status.running;
    renderBulkToolbar();
  }

  // Reconcile circuit banner with latest persistent state (handles reload).
  if (status.circuitBreaker && status.circuitBreaker.active) {
    showCircuitBanner(status.circuitBreaker);
  } else {
    hideCircuitBanner();
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
let currentSearch = '';

// View mode + filters
let viewMode = 'active';        // 'active' | 'trash'
let groupFilter = '';            // '' = all, '0' = ungrouped, '<id>' = specific group
const selected = new Set();      // asins with checkbox ticked

// Cached groups list for the selector + modal.
let cachedGroups = [];

function setupProductControls() {
  $('#btn-add').addEventListener('click', onAddClick);
  setupCsvImportModal();
  $('#product-search').addEventListener('input', () => {
    currentSearch = $('#product-search').value.toLowerCase();
    applyFilter();
    $('#product-list').scrollTop = 0;
    renderVisible();
  });

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
    await loadProducts();
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

async function runCsvImport() {
  if (!csvImportFile) return;
  const btn = $('#btn-csv-run');
  btn.disabled = true;

  let asins;
  try {
    const text  = await csvImportFile.text();
    const rows  = parseCsv(text);
    asins = extractAsinsFromCsvRows(rows);
  } catch (err) {
    showCsvStatus(`読み込みに失敗しました: ${err.message}`, 'error');
    btn.disabled = false;
    return;
  }

  if (asins.length === 0) {
    showCsvStatus('「ASIN」列が見つからない、または有効なASINがありません', 'error');
    btn.disabled = false;
    return;
  }

  // Filter out ASINs already in the viewer (any state — active or
  // trashed). The backend's INSERT OR IGNORE would also skip them,
  // but doing it here keeps the "added" count honest in the UI.
  const existing = new Set(allProducts.map((p) => p.asin));
  const toAdd    = asins.filter((a) => !existing.has(a));

  const result = await window.api.invoke('addProducts', { asins: toAdd });
  const skipped = asins.length - (result?.added || 0);
  const msg = `${result?.added || 0} 件追加しました` +
              (skipped > 0 ? ` (重複/既存 ${skipped} 件は無視)` : '');
  showCsvStatus(msg, 'success');

  await loadProducts();
  await refreshStatus();

  setTimeout(() => closeCsvImportModal(), 1200);
  btn.disabled = false;
}

function showCsvStatus(text, type) {
  const el = $('#csv-import-status');
  el.textContent = text;
  el.className = `asin-status ${type}`;
  el.classList.remove('hidden');
}

// Minimal CSV parser. Handles quoted fields with embedded commas and
// escaped double-quotes (RFC-4180). Returns rows[col]; trailing
// blank lines are kept (caller can ignore them).
function parseCsv(text) {
  const rows = [];
  const norm = text.replace(/\r\n?/g, '\n');
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
      else if (ch === ',') { row.push(cur); cur = ''; }
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
  await refreshGroups();
  renderHeader();
  applyFilter();
  renderVisible();
  renderBulkToolbar();
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

function applyFilter() {
  if (!currentSearch) {
    filtered = allProducts;
  } else {
    filtered = allProducts.filter(
      (p) => p.asin.toLowerCase().includes(currentSearch) ||
             (p.title || '').toLowerCase().includes(currentSearch)
    );
  }

  // Apply FNM filter conditions (active vs trash context). When no
  // condition is enabled, the filter is treated as inactive — the
  // list is shown as-is. Only when at least one defined condition is
  // checked do we narrow the list to products that match all of
  // them (AND-joined per spec).
  const fnmStates = (viewMode === 'trash' ? fnmStateCache.trash : fnmStateCache.active).filter;
  if (hasAnyConditionEnabled(fnmStates)) {
    filtered = filtered.filter((p) => passesAllConditions(p, fnmStates));
  }
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
    if (!statsCache.has(row.asin)) needStats.push(row.asin);
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
    const stats = await window.api.invoke('getProductStats', { asin });
    statsCache.set(asin, stats || {});
    const tr = visibleRows.get(asin);
    if (tr) updateRowStats(tr, stats || {});
    // If an mpCount-window filter is active, the ASIN may now be
    // visible/hidden based on the just-arrived rolling averages.
    // Schedule one debounced re-evaluation per stats burst.
    scheduleFilterRecompute();
  } catch (e) {
    statsCache.delete(asin);
  }
}

let _filterRecomputeTimer = null;
function scheduleFilterRecompute() {
  const A = fnmStateCache.active;
  const T = fnmStateCache.trash;
  const ctx = viewMode === 'trash' ? T : A;
  // Only recompute if the active filter actually depends on mpCount
  // averages — current/last_mp_count is row-local and doesn't need this.
  const m = ctx.filter.mpCount;
  const needsRecompute =
    m && (m.d7.enabled || m.d30.enabled || m.d90.enabled || m.d180.enabled);
  if (!needsRecompute) return;
  if (_filterRecomputeTimer) return;
  _filterRecomputeTimer = setTimeout(() => {
    _filterRecomputeTimer = null;
    applyFilter();
    renderVisible();
  }, 200);
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
// として永続化。
let sparklineDays = 30;
const SPARKLINE_PERIOD_OPTS = [
  { days: 1,    label: '直近1日'   },
  { days: 7,    label: '直近7日'   },
  { days: 30,   label: '直近30日'  },
  { days: 90,   label: '直近90日'  },
  { days: 180,  label: '直近180日' },
  { days: null, label: '全期間'    },
];
function sparklinePeriodLabel(days = sparklineDays) {
  const opt = SPARKLINE_PERIOD_OPTS.find((o) => o.days === days);
  return opt ? opt.label : '直近30日';
}
async function loadSparklinePref() {
  try {
    const v = await window.api.invoke('getSetting', { key: 'viewer.sparklineDays' });
    if (v == null) return;
    if (v === 'all') sparklineDays = null;
    else if (/^\d+$/.test(v)) sparklineDays = parseInt(v, 10);
  } catch { /* fall back to default */ }
}
async function saveSparklinePref() {
  try {
    await window.api.invoke('setSetting', {
      key:   'viewer.sparklineDays',
      value: sparklineDays == null ? 'all' : String(sparklineDays),
    });
  } catch { /* non-fatal — in-memory state still reflects the choice */ }
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
  dd.innerHTML = SPARKLINE_PERIOD_OPTS.map((o) => {
    const key = (o.days == null) ? 'all' : String(o.days);
    const cls = (o.days === sparklineDays) ? 'active' : '';
    return `<button type="button" class="${cls}" data-spark-days="${key}">${o.label}監視グラフ</button>`;
  }).join('');
  document.body.appendChild(dd);

  dd.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-spark-days]');
    if (!btn) return;
    const v = btn.dataset.sparkDays;
    sparklineDays = (v === 'all') ? null : parseInt(v, 10);
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
  chart.setData(series, xMin, xMax);
}

// Group cell contents — always shows サイト比較 button on the left;
// then either the group name + 変更 (assigned) or just 登録 (unassigned).
function groupCellInner(asin, groupName) {
  const compareBtn = `<button type="button" class="row-mini-btn row-compare-btn" data-compare="${asin}" title="Keepa と Amazon検索を新しいタブで開く">サイト比較</button>`;
  if (groupName) {
    return `${compareBtn}`
      + `<span class="row-group-name" title="${escapeHtml(groupName)}">${escapeHtml(groupName)}</span>`
      + `<button type="button" class="row-mini-btn row-group-edit-btn" data-group-edit="${asin}" title="グループを変更">変更</button>`;
  }
  return `${compareBtn}`
    + `<button type="button" class="row-mini-btn row-group-add-btn" data-group-edit="${asin}" title="グループに登録">登録</button>`;
}

function activeRowHtml(row) {
  const checked = selected.has(row.asin) ? 'checked' : '';
  const groupName = (cachedGroups.find((g) => g.id === row.group_id) || {}).name || '';
  const lastUpdated = row.last_observed_at ? formatJpDateTime(row.last_observed_at) : '—';
  const added = row.added_at ? formatJpDateTime(row.added_at) : '—';
  const imgSrc = row.image_url ? escapeHtml(row.image_url) : '';
  // The price-history canvas is rendered by loadSparkline (see
  // createRow). The canvas starts blank, picks up a series once IPC
  // returns observations for this ASIN.
  return `
    <div class="cell-check"><input type="checkbox" data-bulk="${row.asin}" ${checked}></div>
    <div class="cell-group" title="${escapeHtml(groupName)}">${groupCellInner(row.asin, groupName)}</div>
    <div class="cell-time">${lastUpdated}</div>
    <div class="cell-time">${added}</div>
    <div class="cell-thumb">${imgSrc ? `<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${imgSrc}" alt="">` : ''}</div>
    <div class="cell-title" data-f="title" title="${escapeHtml(row.title || '')}">${escapeHtml(row.title || '')}</div>
    <div class="cell-asin"><a href="https://www.amazon.co.jp/dp/${row.asin}" target="_blank">${row.asin}</a></div>
    <div class="cell-condition" data-f="mpCondition" title="${escapeHtml(row.last_mp_condition || '')}">${escapeHtml(row.last_mp_condition || '')}</div>
    <div class="cell-delivery" data-f="delivery" title="${escapeHtml(row.last_delivery || '')}">${escapeHtml(row.last_delivery || '')}</div>
    <div class="cell-mpcount" data-f="mpCount">${row.last_mp_count != null ? row.last_mp_count : ''}</div>
    <div class="cell-keepa"><canvas data-spark-asin="${row.asin}" data-chart-for="${row.asin}" title="クリックで監視グラフ詳細を開く"></canvas></div>
    <div class="cell-price" data-f="price">${row.last_price != null ? '¥' + Number(row.last_price).toLocaleString() : '—'}</div>
    <div class="cell-points" data-f="points">${row.last_points != null ? row.last_points + ' pt' : '—'}</div>
    <div class="cell-effective" data-f="effective"><span class="eff-val">—</span></div>
    <div class="cell-avg" data-stat="avg1d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg7d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg30d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg90d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg180d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="other"><span class="avg-val">${row.last_mp_price != null ? '¥' + Number(row.last_mp_price).toLocaleString() : '—'}</span></div>
  `;
}

function trashRowHtml(row) {
  const checked = selected.has(row.asin) ? 'checked' : '';
  const trashed = row.trashed_at ? formatJpDateTime(row.trashed_at) : '—';
  const lastUpdated = row.last_observed_at ? formatJpDateTime(row.last_observed_at) : '—';
  const added = row.added_at ? formatJpDateTime(row.added_at) : '—';
  const imgSrc = row.image_url ? escapeHtml(row.image_url) : '';
  // Sparkline canvas rendered by loadSparkline; see active row.
  return `
    <div class="cell-check"><input type="checkbox" data-bulk="${row.asin}" ${checked}></div>
    <div class="cell-actions"><a href="https://www.amazon.co.jp/dp/${row.asin}" target="_blank" title="Amazonで開く">🔗</a></div>
    <div class="cell-time">${trashed}</div>
    <div class="cell-time">${lastUpdated}</div>
    <div class="cell-thumb">${imgSrc ? `<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${imgSrc}" alt="">` : ''}</div>
    <div class="cell-title" data-f="title" title="${escapeHtml(row.title || '')}">${escapeHtml(row.title || '')}</div>
    <div class="cell-asin">${row.asin}</div>
    <div class="cell-condition" title="${escapeHtml(row.last_mp_condition || '')}">${escapeHtml(row.last_mp_condition || '')}</div>
    <div class="cell-delivery" title="${escapeHtml(row.last_delivery || '')}">${escapeHtml(row.last_delivery || '')}</div>
    <div class="cell-mpcount">${row.last_mp_count != null ? row.last_mp_count : ''}</div>
    <div class="cell-keepa"><canvas data-spark-asin="${row.asin}" data-chart-for="${row.asin}" title="クリックで監視グラフ詳細を開く"></canvas></div>
    <div class="cell-price">${row.last_price != null ? '¥' + Number(row.last_price).toLocaleString() : '—'}</div>
    <div class="cell-points">${row.last_points != null ? row.last_points + ' pt' : '—'}</div>
    <div class="cell-effective" data-f="effective"><span class="eff-val">—</span></div>
    <div class="cell-avg" data-stat="avg1d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg7d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg30d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg90d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="avg180d"><span class="avg-val">—</span></div>
    <div class="cell-avg" data-stat="other"><span class="avg-val">${row.last_mp_price != null ? '¥' + Number(row.last_mp_price).toLocaleString() : '—'}</span></div>
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
  setWithTip('[data-f="title"]',       row.title || '');
  setWithTip('[data-f="mpCondition"]', row.last_mp_condition || '');
  setWithTip('[data-f="delivery"]',    row.last_delivery || '');
  set('[data-f="mpCount"]',     row.last_mp_count != null ? String(row.last_mp_count) : '');
  set('[data-f="price"]',       row.last_price != null ? '¥' + Number(row.last_price).toLocaleString() : '—');
  set('[data-f="points"]',      row.last_points != null ? row.last_points + ' pt' : '—');
  const latestEff = (row.last_price != null)
    ? row.last_price - (row.last_points || 0)
    : null;
  // 瞬間下落率 (latest vs 1個前の観測) の差額・%表示。prev は stats
  // 由来なので、PRICE_UPDATE 直後で statsCache が空のサイクルでは
  // 値だけ表示し、fetchStatsFor 完了後に updateRowStats が再描画する。
  const cachedStats = statsCache.get(row.asin);
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

  // Re-apply cached stats if we have them.
  const stats = statsCache.get(row.asin);
  if (stats) updateRowStats(tr, stats);
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

function updateRowStats(tr, stats) {
  const renderAvg = (cellSel, val, diff) => {
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
      // 「avg − latest」の符号で買い手目線の色分け:
      //   diff > 0 (= 平均より最新が安い) → 「お得」 → 青
      //   diff < 0 (= 平均より最新が高い) → 「割高」 → 赤
      //   diff = 0                       → グレー
      const cls  = diff > 0 ? 'pos' : (diff < 0 ? 'neg' : 'flat');
      const sign = diff > 0 ? '+' : '';
      diffHtml = `<span class="avg-diff ${cls}">${sign}${diff}</span>`;
      // 仕様式: (N日平均 − 最新) ÷ N日平均 × 100。avg は別途 val として
      // 渡されているのでローカルで計算、IPC は弄らない。
      if (val !== 0) {
        const pct  = (diff / val) * 100;
        const rounded = Math.round(pct);
        const psign = rounded > 0 ? '+' : '';
        pctHtml = `<span class="avg-pct ${cls}">(${psign}${rounded}%)</span>`;
      }
    }
    cell.innerHTML =
      `<span class="avg-val">¥${Number(val).toLocaleString()}</span>${diffHtml}${pctHtml}`;
  };
  renderAvg('[data-stat="avg1d"]',   stats.avg1d,   stats.avg1dDiff);
  renderAvg('[data-stat="avg7d"]',   stats.avg7d,   stats.avg7dDiff);
  renderAvg('[data-stat="avg30d"]',  stats.avg30d,  stats.avg30dDiff);
  renderAvg('[data-stat="avg90d"]',  stats.avg90d,  stats.avg90dDiff);
  renderAvg('[data-stat="avg180d"]', stats.avg180d, stats.avg180dDiff);
  renderAvg('[data-stat="other"]',   stats.otherSellersPrice, stats.otherSellersDiff);

  // 最新実質BuyBox価格 cell — 値 + 瞬間変動（diff/%）の 3 行表示。
  renderEffectiveCell(tr, stats.latestEffective, stats.prevEffective);
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
  }
}

// ── Header rendering ──────────────────────────────────────
//
// The header columns differ between active and trash views (trash
// adds a "ゴミ捨て日時" column and a "サイト起動" link, drops the
// per-row group cell). Re-render whenever view mode flips.

function renderHeader() {
  const thead = $('#viewer-thead');
  if (!thead) return;
  const headerCb = '<button type="button" id="viewer-header-checkbox" class="header-select-all" title="すべて選択 / 解除">すべて</button>';
  // 20 cells — must match the .viewer-row grid-template-columns.
  // The Keepa graph image is itself the chart trigger (click it to
  // open the time-series modal), so a separate 監視グラフ column would
  // be redundant.
  if (viewMode === 'trash') {
    thead.innerHTML = `
      <div class="cell-check">${headerCb}</div>
      <div>サイト起動</div>
      <div>ゴミ捨て日時</div>
      <div>最新取得日時</div>
      <div>商品写真</div>
      <div>商品名</div>
      <div>ASIN</div>
      <div>状態</div>
      <div>発送情報</div>
      <div>出品者数</div>
      <div class="sparkline-header" id="sparkline-period-header" title="期間を選択">${sparklinePeriodLabel()}<span class="col-sub">監視グラフ ▾</span></div>
      <div>BuyBox<span class="col-sub">価格</span></div>
      <div>ポイント</div>
      <div>最新実質<span class="col-sub">BuyBox価格</span></div>
      <div>1日平均<span class="col-sub">実質BuyBox</span></div>
      <div>7日平均<span class="col-sub">実質BuyBox</span></div>
      <div>30日平均<span class="col-sub">実質BuyBox</span></div>
      <div>90日平均<span class="col-sub">実質BuyBox</span></div>
      <div>180日平均<span class="col-sub">実質BuyBox</span></div>
      <div>他の出品<span class="col-sub">価格</span></div>
    `;
  } else {
    thead.innerHTML = `
      <div class="cell-check">${headerCb}</div>
      <div>グループ</div>
      <div>最新取得日時</div>
      <div>登録日時</div>
      <div>商品写真</div>
      <div>商品名</div>
      <div>ASIN</div>
      <div>状態</div>
      <div>発送情報</div>
      <div>出品者数</div>
      <div class="sparkline-header" id="sparkline-period-header" title="期間を選択">${sparklinePeriodLabel()}<span class="col-sub">監視グラフ ▾</span></div>
      <div>BuyBox<span class="col-sub">価格</span></div>
      <div>ポイント</div>
      <div>最新実質<span class="col-sub">BuyBox価格</span></div>
      <div>1日平均<span class="col-sub">実質BuyBox</span></div>
      <div>7日平均<span class="col-sub">実質BuyBox</span></div>
      <div>30日平均<span class="col-sub">実質BuyBox</span></div>
      <div>90日平均<span class="col-sub">実質BuyBox</span></div>
      <div>180日平均<span class="col-sub">実質BuyBox</span></div>
      <div>他の出品<span class="col-sub">価格</span></div>
    `;
  }
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
      <button class="bulk-action-btn bulk-action-restore" data-bulk-action="restore"    ${dis}>監視対象に戻す</button>
      <button class="bulk-action-btn bulk-action-harddel" data-bulk-action="hardDelete" ${dis}>完全に削除</button>
    `;
  } else {
    actions.innerHTML = `
      <button class="bulk-action-btn bulk-action-start"  data-bulk-action="start"      ${startDis} ${startTitle}>監視スタート</button>
      <button class="bulk-action-btn bulk-action-group"  data-bulk-action="groupOpen"  ${dis}>グループ登録</button>
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
    if (!stats) stats = await window.api.invoke('getProductStats', { asin });
    const groupName = (cachedGroups.find((g) => g.id === p.group_id) || {}).name || '';
    const keepa = `https://graph.keepa.com/pricehistory.png?asin=${asin}&domain=co.jp&range=90`;
    const eff = (p.last_price != null && p.last_points != null) ? p.last_price - p.last_points : (p.last_price ?? '');
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
  if (state.mpCount) {
    for (const k of ['current', 'd7', 'd30', 'd90', 'd180']) {
      if (state.mpCount[k] && state.mpCount[k].enabled) return true;
    }
  }
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
  if (state.mpCount) {
    const m = state.mpCount;
    if (m.current.enabled && !inRange(product.last_mp_count, m.current)) return false;
    const map = { d7: 'mpCountAvg7d', d30: 'mpCountAvg30d', d90: 'mpCountAvg90d', d180: 'mpCountAvg180d' };
    for (const [k, statKey] of Object.entries(map)) {
      if (m[k].enabled) {
        const v = stats ? stats[statKey] : null;
        if (!inRange(v, m[k])) return false;
      }
    }
  }
  if (state.dropRate) {
    const latestEff = (product.last_price != null)
      ? (product.last_price - (product.last_points || 0))
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

const MP_COUNT_ROWS = [
  { key: 'current', label: '現在の出品者数' },
  { key: 'd7',      label: '7日 平均の出品者数' },
  { key: 'd30',     label: '30日 平均の出品者数' },
  { key: 'd90',     label: '90日 平均の出品者数' },
  { key: 'd180',    label: '180日 平均の出品者数' },
];

const KEYWORD_ROWS = [
  { key: 'asinInclude',  label: 'ASINキーワード検索' },
  { key: 'asinExclude',  label: 'ASINキーワード除外検索' },
  { key: 'titleInclude', label: 'Amazon商品名キーワード検索' },
  { key: 'titleExclude', label: 'Amazon商品名キーワード除外検索' },
];

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

// Hard-coded おススメフィルタ presets per v3 spec. These are NOT user-
// editable — they're suggested condition sets the dev ships with the
// app. Pressing 「適用」 copies the recommended state into the
// left-pane filter; the user can then tweak and save to a custom slot.
//   ① 瞬間 ≥ 15% AND 7日平均 ≥ 30% (substantial sustained drop)
//   ② plus 180日平均 in (-40%, 0%)  (= 「平均より値上がってきている」 too,
//      i.e., long-term up but recently dropping — value-buy candidates)
const RECOMMENDED_PRESETS = [
  {
    name:  'おススメフィルタ①',
    note:  null,
    rules: [
      { label: '実質BuyBox価格の瞬間下落率',     range: '15〜 %' },
      { label: '実質BuyBox価格の7日平均下落率',   range: '30〜 %' },
    ],
    build: () => {
      const s = emptyFnmState();
      s.dropRate.instant = { enabled: true, min: 15, max: null };
      s.dropRate.d7      = { enabled: true, min: 30, max: null };
      return s;
    },
  },
  {
    name:  'おススメフィルタ②',
    note:  '※ 180日下落率が −40〜0% = 平均より値上がってきている',
    rules: [
      { label: '実質BuyBox価格の瞬間下落率',      range: '15〜 %' },
      { label: '実質BuyBox価格の7日平均下落率',    range: '30〜 %' },
      { label: '実質BuyBox価格の180日平均下落率',  range: '−40〜0 %' },
    ],
    build: () => {
      const s = emptyFnmState();
      s.dropRate.instant = { enabled: true, min: 15,  max: null };
      s.dropRate.d7      = { enabled: true, min: 30,  max: null };
      s.dropRate.d180    = { enabled: true, min: -40, max: 0    };
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
    const noteHtml = preset.note
      ? `<div class="fnm-preset-note">${escapeHtml(preset.note)}</div>`
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
    '#fnm-mpcount-grid input[type="checkbox"], ' +
    '#fnm-droprate-grid input[type="checkbox"], ' +
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
  applyFilter();
  renderVisible();
}

// "Filter execute" — capture current pane state and immediately apply
// it to the visible product list. Persists the same state automatically.
async function fnmExecute() {
  captureFnmTabState();
  await persistFnmCurrent();
  await loadFnmStateCache();
  applyFilter();
  renderVisible();
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
  applyFilter();
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
    if (e.target.id === 'history-modal') closeHistoryModal();
  });
}

async function openHistoryModal() {
  await loadNotifications();
  $('#history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  $('#history-modal').classList.add('hidden');
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
    row.last_observed_at = updatedAt;
    row.last_error       = null;
  }
  dirtyAsins.add(asin);
  if (!flushScheduled) { flushScheduled = true; requestAnimationFrame(flushDirty); }
}

async function flushDirty() {
  flushScheduled = false;
  let triggeredAutoAction = false;
  // Snapshot — async ループ中に新しい PRICE_UPDATE が積まれても、この
  // フレームで処理する集合は固定。新規分は次フレームで別 flushDirty が
  // 走るので拾い漏れない (handleIncomingPriceUpdate が flushScheduled を
  // 監視している)。
  const asinsThisTick = Array.from(dirtyAsins);
  dirtyAsins.clear();

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
  ring.title = `スクレイピング進捗 — wave ${p.wave || 1}`;
}

function hideCycleProgress() {
  $('#cycle-progress').classList.add('hidden');
  $('#cycle-progress-counts').classList.add('hidden');
}

// ── CAPTCHA banner ──────────────────────────────────────────

let captchaCountdownTimer = null;
let captchaPausedUntil = 0;

function showCaptchaBanner(p) {
  captchaPausedUntil = p.pausedUntil || 0;
  const titles = { amazon: 'Amazon verification required', google: 'Google bot detection', network: 'Network verification' };
  $('#captcha-banner-title').textContent = titles[p.source] || titles.amazon;
  $('#captcha-banner-reason').textContent = p.reason || '';
  $('#captcha-banner').classList.remove('hidden');
  updateCaptchaCountdown();
  if (captchaCountdownTimer) clearInterval(captchaCountdownTimer);
  captchaCountdownTimer = setInterval(updateCaptchaCountdown, 1000);
  // Click handler for the Solve button is bound once in setupSessionControls().
}

function updateCaptchaCountdown() {
  const rem = captchaPausedUntil - Date.now();
  if (rem <= 0) { hideCaptchaBanner(); return; }
  const m = Math.floor(rem / 60000);
  const s = Math.ceil((rem % 60000) / 1000);
  $('#captcha-countdown').textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function hideCaptchaBanner() {
  $('#captcha-banner').classList.add('hidden');
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
  if (!btn) return;
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

  const clearBtn = $('#circuit-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await window.api.invoke('clearCircuitBreaker').catch(() => {});
      hideCircuitBanner();
      await refreshStatus();
    });
  }

  const solveBtn = $('#captcha-solve-btn');
  if (solveBtn) {
    solveBtn.addEventListener('click', () => {
      window.api.invoke('solveCaptcha').catch((e) => console.warn('solveCaptcha:', e));
    });
  }
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

function setupChartModal() {
  $('#chart-modal-close').addEventListener('click', closeChartModal);

  // Backdrop click (on the overlay itself, not the card) closes.
  $('#chart-modal').addEventListener('click', (e) => {
    if (e.target.id === 'chart-modal') closeChartModal();
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
  $('#chart-modal-asin').textContent = asin;
  $('#chart-modal-name').textContent = (product && product.title) || '(title unknown)';
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
  }
  if (!countChart) {
    countChart = new window.TimeSeriesChart(countCanvas, {
      yFormatter: (v) => `${Math.round(v)}`,
      autoRange:  $('#chart-autorange-count').checked,
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
  set('sellerCount',  last(data.sellerCount),  num);
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

// ── Notifications ───────────────────────────────────────────

async function loadNotifications() {
  const notifs = await window.api.invoke('getNotifications');
  const container = $('#notification-list');
  if (!Array.isArray(notifs) || notifs.length === 0) {
    container.innerHTML = '<div class="empty-message">No notifications yet</div>';
    return;
  }
  container.innerHTML = notifs.map((n) => `
    <div class="notif-item">
      <div class="notif-time">${new Date(n.sent_at).toLocaleString('ja-JP')}</div>
      <div class="notif-asin">${n.asin}</div>
      <div class="notif-detail">Condition #${n.condition_id}${n.discord_sent ? ' (Discord sent)' : ''}</div>
    </div>
  `).join('');
}
