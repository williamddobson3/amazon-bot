'use strict';

// Bridge to the in-process Rust crawler (method A — Node-API addon).
//
// The crawl core runs INSIDE the Electron main process via a napi-rs
// compiled native addon (`crawler/index.node`). There is no subprocess
// and no stdio IPC — the Electron main process calls Rust functions
// directly. Per-event callbacks (PageResult / Progress / Block) are
// passed straight through; the global block / resume / circuit-breaker
// hooks remain identical to the old sidecar bridge so `index.js` and
// `ipc-handlers.js` keep working unchanged.
//
// The Rust addon was compiled with napi-rs targeting N-API v6, which
// is ABI-stable across Node.js / Electron versions — no
// electron-rebuild is required when Electron is upgraded.

const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');

// ── Native addon discovery ─────────────────────────────────────
//
// Dev: `<repo>/electron/crawler/index.node` (produced by
//      `npm run build:crawler`).
// Packaged: electron-builder's asarUnpack rule copies the file to
//      `<resources>/app.asar.unpacked/crawler/index.node`.
function resolveAddonPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'crawler', 'index.node');
  }
  // src/main/services/  →  ../../../crawler/index.node
  return path.join(__dirname, '..', '..', '..', 'crawler', 'index.node');
}

let native = null;
function loadNative() {
  if (native) return native;
  const file = resolveAddonPath();
  if (!fs.existsSync(file)) {
    throw new Error(`[crawler-bridge] native addon not found: ${file}`);
  }
  native = require(file);
  console.info(`[crawler-bridge] addon loaded v${native.version()}`);
  return native;
}

// ── Mirrored state cache ───────────────────────────────────────
//
// Same shape as the sidecar bridge had — `index.js` reads from these
// via the fetcher.js shim. The native addon emits `state` events at
// startup and after every block / liftPause / clearCircuitBreaker so
// the cache stays authoritative.
let cache = {
  pausedUntilMs:  0,
  circuitUntilMs: 0,
  captchaStreak:  0,
};

// Global callbacks (one each) — wired by `index.js` to push CAPTCHA /
// resume / circuit-breaker UI events to the renderer.
let onBlockCb        = null;  // ({pausedUntil, reason, solveUrl, source, streak})
let onResumeCb       = null;  // ()                — fires when pause clears
let onCircuitCb      = null;  // ({active, until}) — fires on breaker change
let onBlockPersistCb = null;  // ({type, source, streak, urlLen, finalUrl})

function setOnBlock(cb)        { onBlockCb        = cb; }
function setOnResume(cb)       { onResumeCb       = cb; }
function setOnCircuit(cb)      { onCircuitCb      = cb; }
function setOnBlockPersist(cb) { onBlockPersistCb = cb; }

// Apply a fresh state snapshot and fire transition callbacks.
function updateCacheAndFireTransitions(next) {
  const now = Date.now();
  const wasPaused        = cache.pausedUntilMs > now;
  const wasCircuitActive = cache.circuitUntilMs > now;

  cache = next;

  const isPausedNow        = cache.pausedUntilMs > Date.now();
  const isCircuitActiveNow = cache.circuitUntilMs > Date.now();

  if (wasPaused && !isPausedNow && typeof onResumeCb === 'function') {
    onResumeCb();
  }
  if (wasCircuitActive !== isCircuitActiveNow && typeof onCircuitCb === 'function') {
    onCircuitCb({
      active: isCircuitActiveNow,
      until:  cache.circuitUntilMs,
    });
  }
}

// ── Public state queries ──────────────────────────────────────

function isPaused() {
  return cache.pausedUntilMs > Date.now();
}

function getPauseState() {
  if (!isPaused()) return null;
  return { pausedUntil: cache.pausedUntilMs, streak: cache.captchaStreak };
}

function isCircuitActive() {
  return cache.circuitUntilMs > Date.now();
}

function getCircuitBreakerState() {
  return isCircuitActive()
    ? { active: true,  until: cache.circuitUntilMs }
    : { active: false, until: 0 };
}

function isRunning() {
  return native !== null;
}

// ── State-changing commands ───────────────────────────────────

async function liftPause() {
  // Optimistic local update — the native call returns the authoritative
  // state, which we then sync into the cache.
  if (isPaused()) {
    cache = { ...cache, pausedUntilMs: 0, captchaStreak: 0 };
    if (typeof onResumeCb === 'function') onResumeCb();
  }
  try {
    const st = await loadNative().liftPause();
    updateCacheAndFireTransitions({
      pausedUntilMs:  Number(st.pausedUntilMs)  || 0,
      circuitUntilMs: Number(st.circuitUntilMs) || 0,
      captchaStreak:  Number(st.captchaStreak)  || 0,
    });
  } catch (err) {
    console.warn('[crawler-bridge] liftPause failed:', err.message);
  }
}

async function clearCircuitBreaker() {
  if (isCircuitActive()) {
    cache = { ...cache, circuitUntilMs: 0 };
    if (typeof onCircuitCb === 'function') onCircuitCb({ active: false, until: 0 });
  }
  try {
    const st = await loadNative().clearCircuitBreaker();
    updateCacheAndFireTransitions({
      pausedUntilMs:  Number(st.pausedUntilMs)  || 0,
      circuitUntilMs: Number(st.circuitUntilMs) || 0,
      captchaStreak:  Number(st.captchaStreak)  || 0,
    });
  } catch (err) {
    console.warn('[crawler-bridge] clearCircuitBreaker failed:', err.message);
  }
}

// ── Cookie export ──────────────────────────────────────────────

async function getCookieHeader() {
  try {
    const cookies = await session.defaultSession.cookies.get({
      url: 'https://www.amazon.co.jp/',
    });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (err) {
    console.warn('[crawler-bridge] cookie read failed:', err.message);
    return '';
  }
}

// ── Per-crawl state + event dispatcher ────────────────────────

let activeCrawl = null; // { onPageResult, onProgress, onBlock }

function dispatchEventJson(json) {
  let ev;
  try { ev = JSON.parse(json); }
  catch {
    console.warn('[crawler-bridge] non-JSON event:', json);
    return;
  }
  switch (ev.type) {
    case 'log':
      if (ev.level === 'warn') console.warn(`[crawler] ${ev.message}`);
      else                     console.info(`[crawler] ${ev.message}`);
      break;

    case 'page_result':
      if (activeCrawl && typeof activeCrawl.onPageResult === 'function') {
        activeCrawl.onPageResult(ev.results || [], ev.page, ev.total_pages);
      }
      break;

    case 'progress':
      if (activeCrawl && typeof activeCrawl.onProgress === 'function') {
        activeCrawl.onProgress({
          done:        ev.done,
          total:       ev.total,
          page:        ev.page,
          totalPages:  ev.total_pages,
          wave:        ev.wave,
        });
      }
      break;

    case 'block':
      updateCacheAndFireTransitions({
        pausedUntilMs:  ev.paused_until_ms  || 0,
        circuitUntilMs: ev.circuit_until_ms || 0,
        captchaStreak:  ev.captcha_streak   || 0,
      });
      if (typeof onBlockCb === 'function') {
        onBlockCb({
          pausedUntil: ev.paused_until_ms || 0,
          reason:      ev.reason,
          solveUrl:    ev.solve_url,
          source:      ev.source,
          streak:      ev.captcha_streak || 0,
        });
      }
      if (typeof onBlockPersistCb === 'function') {
        onBlockPersistCb({
          type:     ev.error,
          source:   ev.source,
          streak:   ev.captcha_streak || 0,
          finalUrl: ev.solve_url || '',
          urlLen:   (ev.solve_url || '').length,
        });
      }
      if (activeCrawl && typeof activeCrawl.onBlock === 'function') {
        activeCrawl.onBlock({
          error:    ev.error,
          reason:   ev.reason,
          source:   ev.source,
          solveUrl: ev.solve_url,
        });
      }
      break;

    case 'state':
      updateCacheAndFireTransitions({
        pausedUntilMs:  ev.paused_until_ms  || 0,
        circuitUntilMs: ev.circuit_until_ms || 0,
        captchaStreak:  ev.captcha_streak   || 0,
      });
      break;

    default:
      console.warn('[crawler-bridge] unknown event type:', ev.type);
  }
}

// ── Crawl entry point ──────────────────────────────────────────
//
// Same signature as the sidecar bridge had, so `scheduler.js` needs no
// changes:
//   runCoverage(asins, {
//     signal,         // AbortSignal — calls native.abort() when fired
//     onPageResult,   // (results, page, totalPages)
//     onProgress,     // ({done, total, page, totalPages, wave})
//     onBlock,        // ({error, reason, source, solveUrl})
//   })
async function runCoverage(asins, opts = {}) {
  const n = loadNative();
  if (activeCrawl) {
    throw new Error('crawler bridge: a crawl is already in progress');
  }
  const cookies = await getCookieHeader();

  if (opts.signal) {
    const onAbort = () => { try { n.abort(); } catch { /* native gone */ } };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  activeCrawl = {
    onPageResult: opts.onPageResult || null,
    onProgress:   opts.onProgress   || null,
    onBlock:      opts.onBlock      || null,
  };

  try {
    const s = await n.runCoverage(asins, cookies, dispatchEventJson);
    return {
      total:   Number(s.total),
      found:   Number(s.found),
      missed:  Number(s.missed),
      pages:   Number(s.pages),
      errors:  Number(s.errors),
      aborted: !!s.aborted,
      paused:  !!s.paused,
    };
  } finally {
    activeCrawl = null;
  }
}

// ── 診断: スクレイパーと同じ通信での生ページ取得 (2026-06 client要望) ──────
//
// 「Amazonが返したページを確認」が、スクレイパー(Rust reqwest)と完全に同じ
// HTTP クライアント・ヘッダで取得した生ページを表示できるようにする。
// 旧 index.node (fetch_raw 未実装) では native.fetchRaw が無いので、呼び出し側で
// net.request にフォールバックできるよう、ここでは未実装時に例外を投げる。
async function fetchRaw(url) {
  const n = loadNative();
  if (typeof n.fetchRaw !== 'function') {
    throw new Error('fetch_raw not available in this crawler build (rebuild crawler to enable)');
  }
  const cookies = await getCookieHeader();
  const r = await n.fetchRaw(url, cookies);
  return {
    status:   Number(r.status),
    finalUrl: r.finalUrl,
    html:     r.html,
  };
}

// ── 手数料・サイズ区分計算 (機密ロジックは Rust 内) ─────────────
//
// JS 側は keepaItem(列マッピング済み) と salesPrice / settings を渡すだけ。
// 実際の計算 (カテゴリ別料率 / FBA 表 / サイズ判定 / ブランド表) は
// コンパイル済み Rust addon (compute_fees) 内にのみ存在する。
// 同期関数 (CSV インポート時にインライン呼び出し)。
//   keepaItem: buildKeepaItemFromCsv / mapProductToParams の出力
//   戻り値:    { sizeKubun, fbaFee, inventoryStorageFee, amazonFee }
function computeFees(keepaItem, salesPrice, settings) {
  const n = loadNative();
  const month = new Date().getMonth() + 1;   // 在庫保管料の季節区分用
  const json = n.computeFees(
    JSON.stringify(keepaItem || {}),
    Number(salesPrice) || 0,
    JSON.stringify(settings || {}),
    month,
  );
  return JSON.parse(json);
}

// ── Lifecycle (no-ops in addon mode; kept for API compatibility) ──

async function ensureStarted() {
  loadNative();
  try {
    const st = await native.getState();
    updateCacheAndFireTransitions({
      pausedUntilMs:  Number(st.pausedUntilMs)  || 0,
      circuitUntilMs: Number(st.circuitUntilMs) || 0,
      captchaStreak:  Number(st.captchaStreak)  || 0,
    });
  } catch (err) {
    console.warn('[crawler-bridge] initial getState failed:', err.message);
  }
}

async function shutdown() {
  // No subprocess to terminate — the Rust state is in-process and
  // freed automatically when Electron exits. Best-effort abort of any
  // in-flight crawl so it doesn't hang the quit sequence.
  if (activeCrawl) {
    try { native && native.abort(); } catch { /* ignore */ }
  }
}

module.exports = {
  runCoverage,
  fetchRaw,
  computeFees,
  ensureStarted,
  shutdown,
  isRunning,
  isPaused,
  getPauseState,
  isCircuitActive,
  getCircuitBreakerState,
  liftPause,
  clearCircuitBreaker,
  setOnBlock,
  setOnResume,
  setOnCircuit,
  setOnBlockPersist,
};
