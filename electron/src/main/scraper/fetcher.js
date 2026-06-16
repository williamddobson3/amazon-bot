'use strict';

// Compatibility shim — the original JS HTTP fetcher has been replaced
// by the Rust crawler sidecar (electron/crawler/, fronted by
// `services/crawler-bridge.js`). This module now re-exports the
// equivalent functions so the existing `index.js` / `ipc-handlers.js`
// imports keep working unchanged.
//
// What stays here (still JS, not crawl-related):
//   * `initSession`  — overrides the Electron default session's UA so
//                      the login window and CAPTCHA solve window send
//                      a real-Chrome User-Agent. Unchanged from the
//                      previous fetcher.js.
//   * `isSignedIn`   — checks the Amazon auth cookie on the
//                      defaultSession jar. No network call — purely a
//                      cookie-store read.
//
// What now lives in the sidecar (re-exported below from the bridge):
//   * pacing token bucket, CAPTCHA / dog-page detection
//   * pause ladder + circuit breaker state
//   * warmup organic-traffic seeding
//
// Callers that still want the JS-side API surface (`isPaused`,
// `liftPause`, `setPauseCallbacks`, `setCircuitCallback`,
// `setBlockCallback`, `getCircuitBreakerState`, `clearCircuitBreaker`,
// `getPauseState`) get bridge-backed implementations.

const { session } = require('electron');
const bridge = require('../services/crawler-bridge');

// A real Chrome 133 User-Agent on Windows. We override Electron's
// default UA because it contains "Electron/33.x" which Amazon instantly
// flags. Applies to in-app BrowserWindows (login, captcha solve) too —
// the crawl itself runs inside the Rust sidecar with its own client.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

function initSession() {
  const ses = session.defaultSession;
  ses.setUserAgent(CHROME_UA);
  console.log('[fetcher] session UA set to real Chrome');
}

// Cheap cookie-store read — no network. Any `at-*` cookie with a
// real-length token value on amazon.co.jp indicates a signed-in session.
async function isSignedIn() {
  try {
    const cookies = await session.defaultSession.cookies.get({
      url: 'https://www.amazon.co.jp/',
    });
    return cookies.some(
      (c) => c.name && c.name.startsWith('at-') && c.value && c.value.length > 10,
    );
  } catch (err) {
    console.warn('[fetcher] cookie check failed:', err.message);
    return false;
  }
}

// Amazon ログアウト — ログインセッションを破棄する。別アカウントでの
// ログインや、パスワード変更後の再ログインを想定 (client request)。
// amazon を含むドメインの Cookie を全削除し (at-* 認証トークンを含む)、
// localStorage 等のストレージも併せてクリアする。これで次回ログイン時は
// 通常のサインイン画面が表示され、別アカウントに切り替えられる。
async function logout() {
  const ses = session.defaultSession;
  let removed = 0;
  try {
    const all = await ses.cookies.get({});               // 全 Cookie
    for (const c of all) {
      const host = (c.domain || '').replace(/^\./, '');  // 先頭ドットを除去
      if (!host.includes('amazon')) continue;            // amazon 系のみ対象
      const path = c.path || '/';
      // domain Cookie / host-only Cookie の両方に効くよう URL を再構成。
      // https/http 双方で取りこぼさないよう両方試す。
      try { await ses.cookies.remove(`https://${host}${path}`, c.name); removed++; } catch {}
      try { await ses.cookies.remove(`http://${host}${path}`,  c.name); } catch {}
    }
    // localStorage / sessionStorage / IndexedDB / ServiceWorker 等もクリア。
    try {
      await ses.clearStorageData({
        origins: ['https://www.amazon.co.jp', 'https://www.amazon.com'],
        storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
      });
    } catch { /* storage クリア失敗は致命ではない */ }
    try { await ses.cookies.flushStore(); } catch {}      // 削除をディスクへ反映
    console.info(`[fetcher] logout — removed ${removed} amazon cookies`);
    return true;
  } catch (err) {
    console.warn('[fetcher] logout failed:', err.message);
    return false;
  }
}

// Adapter — the JS API expects a single setter that takes both
// pause-start and pause-end callbacks; the bridge keeps them as two
// independent slots.
function setPauseCallbacks(onPause, onResume) {
  bridge.setOnBlock(onPause);
  bridge.setOnResume(onResume);
}

module.exports = {
  // ── JS-side helpers (unchanged behaviour) ────────────────────
  initSession,
  isSignedIn,
  logout,

  // ── Sidecar-backed re-exports (state queries) ────────────────
  isPaused:               bridge.isPaused,
  getPauseState:          bridge.getPauseState,
  getCircuitBreakerState: bridge.getCircuitBreakerState,

  // ── Sidecar-backed re-exports (state changes) ────────────────
  liftPause:              bridge.liftPause,
  clearCircuitBreaker:    bridge.clearCircuitBreaker,

  // ── Sidecar-backed re-exports (callback wiring) ──────────────
  setPauseCallbacks,
  setCircuitCallback: bridge.setOnCircuit,
  setBlockCallback:   bridge.setOnBlockPersist,
};
