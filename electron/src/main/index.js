'use strict';

const { app, BrowserWindow, Notification, session, Menu, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { initDb, closeDb } = require('./db/sqlite');
const Q = require('./db/queries');
const { registerIpcHandlers, setWindowCallbacks } = require('./ipc-handlers');
const { startRetentionSchedule, stopRetentionSchedule } = require('./db/retention');
const scheduler = require('./services/scheduler');
const keepaRefresh = require('./services/keepa-refresh');
const {
  initSession,
  setPauseCallbacks,
  setCircuitCallback,
  setBlockCallback,
  liftPause,
  isSignedIn,
} = require('./scraper/fetcher');
const { PUSH, AMAZON_BASE, JA_LANG_QUERY } = require('../shared/constants');
const crawlerBridge = require('./services/crawler-bridge');

// ★ Chromium background-throttling completely disabled — this app is a
// monitoring tool whose notifications MUST keep firing while the
// window is minimized, occluded, or the screen is locked (Win+L).
//
// Why three flags, not just one:
//   * `disable-background-timer-throttling` — keeps setTimeout /
//     setInterval running at full rate when the window is hidden.
//   * `disable-renderer-backgrounding`      — prevents Chromium from
//     deprioritising the whole renderer process (CPU + memory) when
//     the window is no longer the foreground OS window.
//   * `disable-backgrounding-occluded-windows` — covers the case where
//     the window is technically visible but covered by another app
//     (and would otherwise be treated as background).
//
// `app.commandLine.appendSwitch` MUST be called before `app.whenReady`
// or the flags have no effect (Chromium reads them at startup).
//
// This is the same combination Discord / Slack / Notion use to keep
// their notifications reliable during screen lock.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow = null;
let captchaSolveWindow = null;
let loginWindow = null;
let lastCaptchaSolveUrl = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 600,
    title: 'Amazon Price Monitor',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,  // allow require() in preload for constants
    },
    backgroundColor: '#080813',
    show: false,
  });

  // ★ Critical: keep the renderer's timers / rAF running at full speed
  // even when the window is minimized or Windows is locked (Win+L).
  // Otherwise Chromium throttles background pages to ≤1 Hz (or pauses
  // entirely), which stalls `flushDirty`'s rAF loop in renderer.js and
  // makes notifications queue up silently until the window is restored.
  // The crawl scheduler runs in main and is unaffected, but the FNM
  // filter evaluation lives in renderer and *was* the bottleneck.
  mainWindow.webContents.setBackgroundThrottling(false);

  // ★ External-link policy — ALL http(s) URL clicks open in the OS
  // default browser (Edge / Chrome / Safari etc.), never in a new
  // in-app BrowserWindow (which would show the app's icon and confuse
  // the user). Covers three cases:
  //
  //   1. <a target="_blank"> / window.open()  → setWindowOpenHandler
  //   2. <a href> without target (normal nav) → will-navigate
  //   3. window.location = "..." inside the page → will-navigate
  //
  // about:, chrome-extension:, file: and the app's own page navigation
  // (loadFile on index.html) are deliberately NOT routed externally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch((err) =>
        console.warn('[index] openExternal failed:', err.message)
      );
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // The very first load (index.html via loadFile) goes through this
    // event too, so we must skip non-http URLs.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url).catch((err) =>
        console.warn('[index] openExternal failed:', err.message)
      );
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // We removed the application menu (Menu.setApplicationMenu(null)),
  // which also removed Electron's default keyboard binding for
  // DevTools (Ctrl+Shift+I / F12 lived under the View menu).
  // Re-bind them explicitly via before-input-event so devs can still
  // inspect. `mode: 'detach'` opens DevTools in its own window so it
  // doesn't squeeze the 1280-wide main viewer.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const wantsDevtools =
      input.key === 'F12' ||
      ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i');
    if (wantsDevtools) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }
    // Ctrl+R / Cmd+R reloads — also useful and also lost with the menu.
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  scheduler.setMainWindow(mainWindow);
}

// ── CAPTCHA solve flow ──────────────────────────────────────

function onClientPause({ pausedUntil, reason, solveUrl, source }) {
  lastCaptchaSolveUrl = solveUrl || null;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH.CAPTCHA_PAUSE, {
      pausedUntil, reason, solveUrl, source,
    });
  }

  const titles = {
    amazon:  'Amazon verification required',
    google:  'Google bot detection triggered',
    network: 'Network verification required',
  };
  const n = new Notification({
    title: titles[source] || titles.amazon,
    body: `${reason} — click to solve and resume scraping`,
    urgency: 'critical',
  });
  n.on('click', () => openCaptchaSolveWindow(solveUrl));
  n.show();
}

function onClientResume() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH.CAPTCHA_RESUME);
  }
  if (captchaSolveWindow && !captchaSolveWindow.isDestroyed()) {
    captchaSolveWindow.close();
    captchaSolveWindow = null;
  }
  // フェッチャの pause が解除された (手動認証で解除 / 期限切れ) — クロールが
  // ブロックの自動再開待ちなら、10 分待たずに即リトライする。
  if (scheduler.isRunning() && scheduler.isBlocked()) scheduler.resumeFromBlock();
}

// Persist a record of every block for post-hoc pacing analysis.
function onBlockEvent(e) {
  try {
    Q.insertBlockEvent(e);
  } catch (err) {
    console.error('[index] failed to persist block event:', err.message);
  }
}

// Push circuit-breaker state changes to the UI + native toast.
function onCircuitBreakerChange(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH.CIRCUIT_BREAKER, state);
  }
  if (state.active) {
    const n = new Notification({
      title: 'Circuit breaker activated',
      body: 'Repeated blocks detected — scraping slowed to a conservative rate for 24h',
      urgency: 'critical',
    });
    n.show();
  }
}

function openCaptchaSolveWindow(url) {
  const target = url || lastCaptchaSolveUrl || `${AMAZON_BASE}/`;
  if (captchaSolveWindow && !captchaSolveWindow.isDestroyed()) {
    captchaSolveWindow.focus();
    return;
  }

  captchaSolveWindow = new BrowserWindow({
    width: 800,
    height: 700,
    title: 'Solve verification',
    webPreferences: {
      // Use the default session so cookies are shared with the fetcher.
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  captchaSolveWindow.loadURL(target);

  captchaSolveWindow.webContents.on('did-navigate', (_e, navUrl) => {
    if (
      !navUrl.includes('/errors/validateCaptcha') &&
      !navUrl.includes('/ap/signin') &&
      !navUrl.includes('google.com/sorry') &&
      !navUrl.includes('google.co.jp/sorry')
    ) {
      console.info('[captcha] solve detected via navigation to:', navUrl);
      liftPause();
    }
  });

  captchaSolveWindow.on('closed', () => {
    captchaSolveWindow = null;
    liftPause();
  });
}

// ── ブロック確認ページのビューア (2026-06 client要望) ────────────
//
// 「Amazonが返したページを確認」ボタン用。モニタ中の代表 ASIN の検索URLを
// スクレイパーと同じセッションで net.request 取得し (= ページ JS を実行しない
// 生のレスポンス)、返ってきた HTML をそのままウィンドウに表示する。これで
// ユーザは「Amazon が商品一覧ではなく確認ページを返している」ことを自分の目で
// 確認できる。ブラウザ窓だと Chromium がチャレンジを解いて商品を出してしまい
// 証跡にならないため、あえて JS 非実行の生レスポンスを sandbox iframe で見せる。
let blockedPageWindow = null;

function escForSrcdoc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function buildBlockedPageViewerHtml(url, status, bytes, hasProducts, rawHtml, viaScraper) {
  const verdict = hasProducts
    ? '⚠ このリクエストでは商品一覧 (s-search-result) が返っています。今この瞬間はブロックされていない可能性があります。'
    : '✅ 商品一覧 (s-search-result) が含まれていません。Amazon が商品ページではなく確認ページ／非商品ページを返しています。';
  const color = hasProducts ? '#ffcc66' : '#7ee787';
  // 取得経路を明示 (2026-06 client要望): スクレイパー本体(Rust)と完全同一の通信で
  // 取れたか、未対応ビルドでブラウザ通信に代替したかを区別する。
  const transport = viaScraper
    ? '取得経路: スクレイパー本体と同じ通信 (Rust HTTP・複数ASINまとめ検索) — 実際のスクレイプと完全に同条件'
    : '取得経路: ブラウザ通信での代替取得 (複数ASINまとめ検索)。完全一致にはクローラーの再ビルドが必要です';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;font-family:'Segoe UI','Meiryo',sans-serif;background:#0f0f1e;color:#eee}
  .hdr{padding:12px 16px;background:#1b1b2b;border-bottom:1px solid #ff9900;font-size:13px;line-height:1.7}
  .hdr b{color:#ff9900}
  .hdr code{color:#9cf;word-break:break-all}
  .hdr .transport{color:#a0a0b0;font-size:12px}
  .verdict{color:${color};font-weight:700;margin-top:4px}
  iframe{border:0;width:100%;height:calc(100vh - 126px);background:#fff}
</style></head>
<body>
  <div class="hdr">
    <b>スクレイパーがAmazonから受け取ったページ（生データ・JS非実行）</b><br>
    URL: <code>${escForSrcdoc(url)}</code><br>
    HTTP ${status} ／ ${Number(bytes).toLocaleString()} bytes
    <div class="transport">${escForSrcdoc(transport)}</div>
    <div class="verdict">${verdict}</div>
  </div>
  <iframe sandbox srcdoc="${escForSrcdoc(rawHtml)}"></iframe>
</body></html>`;
}

function openBlockedPageViewer(filePath) {
  if (blockedPageWindow && !blockedPageWindow.isDestroyed()) {
    blockedPageWindow.loadFile(filePath);
    blockedPageWindow.focus();
    return;
  }
  blockedPageWindow = new BrowserWindow({
    width: 960,
    height: 800,
    title: 'Amazonが返したページ（確認用）',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  blockedPageWindow.loadFile(filePath);
  blockedPageWindow.on('closed', () => { blockedPageWindow = null; });
}

// 単一URLを Electron ブラウザ通信 (net.request) で取得するフォールバック。
// Rust の fetch_raw が使えない (旧クローラービルド) 時に使う。
function fetchViaNet(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, session: session.defaultSession, useSessionCookies: true });
    req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
    req.setHeader('Accept-Language', 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7');
    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), status: res.statusCode, finalUrl: url }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function showBlockedPageWindow() {
  // スクレイパーが実際に投げているのと同じ「複数ASINまとめ検索」URL を組む
  // (s?k=ASIN1|ASIN2|...&言語クエリ)。1商品だけの取得では実スクレイプと条件が
  // 違い証跡にならないため (2026-06 client要望)。先頭の監視ASINを最大135件束ねる。
  let asins = [];
  try {
    const active = Q.getActiveAsins();
    if (Array.isArray(active)) asins = active.slice(0, 135);
  } catch { /* fallback below */ }
  if (asins.length === 0) asins = ['B0CCTXFCDP'];
  const url = `${AMAZON_BASE}/s?k=${asins.join('|')}&${JA_LANG_QUERY}`;
  const outPath = path.join(app.getPath('userData'), 'blocked-page-view.html');

  // まず Rust スクレイパーと同じ HTTP クライアント・ヘッダで取得 (= 完全に同じ
  // ページ)。旧クローラービルド (fetch_raw 未対応) では例外になるので
  // net.request (ブラウザ通信) にフォールバックする。
  let html, status, viaScraper;
  try {
    const r = await crawlerBridge.fetchRaw(url);
    html = r.html; status = r.status; viaScraper = true;
  } catch (eRust) {
    console.info('[block-view] fetch_raw unavailable, falling back to net.request:', eRust.message);
    try {
      const r = await fetchViaNet(url);
      html = r.html; status = r.status; viaScraper = false;
    } catch (eNet) {
      const wrapper = '<!doctype html><meta charset="utf-8">'
        + '<body style="font-family:sans-serif;padding:20px;background:#0f0f1e;color:#eee">'
        + `<h3>ページの取得に失敗しました</h3><p>${escForSrcdoc(eNet.message)}</p>`
        + '<p>ネットワーク状態をご確認のうえ、再度お試しください。</p></body>';
      try { fs.writeFileSync(outPath, wrapper); } catch { /* noop */ }
      openBlockedPageViewer(outPath);
      return;
    }
  }
  const hasProducts = /data-component-type="s-search-result"/.test(html);
  const wrapper = buildBlockedPageViewerHtml(url, status, html.length, hasProducts, html, viaScraper);
  try { fs.writeFileSync(outPath, wrapper); } catch (e) { console.warn('[block-view] write failed:', e.message); }
  openBlockedPageViewer(outPath);
}

// ── Amazon login flow ───────────────────────────────────────
//
// Opens /ap/signin in a BrowserWindow that shares session.defaultSession
// with the fetcher. When the user completes sign-in, Amazon redirects
// off the signin path — detecting that is how we know the session is
// now authenticated. A logged-in session has substantially higher WAF
// tolerance than an anonymous one, which is the largest single lever
// for reducing CAPTCHA rate on a 10k-ASIN workload.
function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 560,
    height: 780,
    title: 'Sign in to Amazon',
    webPreferences: {
      partition: undefined,  // share the scraper's cookie jar
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Amazon's /ap/signin endpoint requires OpenID parameters. Hitting it
  // bare returns the "address is not functional" error page. These are
  // the same parameters the "Sign in" link in Amazon's nav bar uses.
  // assoc_handle=jpflex is the JP marketplace's OpenID handle.
  const signinParams = new URLSearchParams({
    '_encoding': 'UTF8',
    'openid.pape.max_auth_age': '0',
    'openid.return_to': `${AMAZON_BASE}/?ref_=nav_ya_signin`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.assoc_handle': 'jpflex',
    'openid.mode': 'checkid_setup',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.ns': 'http://specs.openid.net/auth/2.0',
  });
  loginWindow.loadURL(`${AMAZON_BASE}/ap/signin?${signinParams.toString()}`);

  // Three detection paths — the cookie-change event is the fastest and
  // race-free; the other two are safety nets. Cookie-change fires the
  // instant Chromium writes `at-main` to the store, before any
  // navigation event the webContents would see. `handled` guards
  // against onLoginSuccess firing more than once per window.
  const ses = session.defaultSession;
  let handled = false;

  const finishLogin = async () => {
    if (handled) return;
    handled = true;
    ses.cookies.removeListener('changed', cookieListener);
    console.info('[login] sign-in detected — closing login window');
    await onLoginSuccess();
  };

  const cookieListener = (_event, cookie, _cause, removed) => {
    // Amazon's auth-token cookie is marketplace-specific:
    //   at-main   for amazon.com, at-acbjp for amazon.co.jp, etc.
    // Any at-* cookie with a real-length value on an amazon.co.jp
    // domain means sign-in just completed.
    if (
      !removed &&
      cookie.name && cookie.name.startsWith('at-') &&
      cookie.value && cookie.value.length > 10 &&
      cookie.domain && cookie.domain.includes('amazon.co.jp')
    ) {
      console.info(`[login] auth cookie ${cookie.name} set`);
      finishLogin();
    }
  };
  ses.cookies.on('changed', cookieListener);

  // Fallback 1: did-navigate with a fresh cookie-store read. Catches
  // the case where the cookie event somehow didn't fire.
  loginWindow.webContents.on('did-navigate', async () => {
    if (await isSignedIn()) finishLogin();
  });

  // Fallback 2: user closes the window themselves. If they happened to
  // sign in and then manually closed, still start the scheduler.
  loginWindow.on('closed', async () => {
    ses.cookies.removeListener('changed', cookieListener);
    loginWindow = null;
    if (!handled && await isSignedIn() && !scheduler.isRunning()) {
      await onLoginSuccess();
    }
  });
}

// Called when sign-in is confirmed. Tells the renderer to hide the
// login gate and closes the login window. Per spec: scraping only ever
// starts via the renderer's 監視スタート button (with the user's
// ✅checked subset). We deliberately do NOT auto-start the scheduler
// here — see the matching note in app.whenReady below.
async function onLoginSuccess() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH.LOGIN_STATE, { loggedIn: true });
  }
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
  // ソフトボットでクロールがブロック中なら、再ログインで取得したフレッシュな
  // セッションで即再開する (フェッチャ側の pause も解除してからリトライ)。
  // 通常起動時のログインはブロック中でないので何もしない。
  if (scheduler.isRunning() && scheduler.isBlocked()) {
    try { await liftPause(); } catch { /* best-effort */ }
    scheduler.resumeFromBlock();
  }
}

// ── App lifecycle ───────────────────────────────────────────

// ── Headless test mode ──────────────────────────────────────
//
// Invoked via:   electron . --test-screenshot=B0CXDLD989 [--out=<path>]
// Runs the screenshot service against the given ASIN, writes the PNG
// to disk, and quits. No DB, no scheduler, no UI — used to sanity-check
// that the capture pipeline works end-to-end.
function parseFlag(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

async function runScreenshotTest() {
  const asin = (parseFlag('test-screenshot') || '').toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    console.error('[test] invalid or missing ASIN. usage: --test-screenshot=B0CXDLD989');
    app.exit(1);
    return;
  }

  initSession(); // UA override matters for an unauth'd capture too
  const { captureProductCard } = require('./services/screenshot');

  console.info(`[test] capturing ${asin} ...`);
  const t0 = Date.now();
  const result = await captureProductCard(asin);
  const elapsed = Date.now() - t0;

  if (result.error) {
    console.error(`[test] FAILED in ${elapsed}ms: ${result.error} ${result.message || ''}`);
    app.exit(2);
    return;
  }

  const out = parseFlag('out') ||
    path.join(app.getPath('userData'), 'screenshots', `test-${asin}-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, result.png);

  console.info(
    `[test] OK in ${elapsed}ms — ${result.source} ` +
    `${result.rect.width}x${result.rect.height} ` +
    `${(result.png.length / 1024).toFixed(1)}KB`
  );
  console.info(`[test] saved: ${out}`);
  app.exit(0);
}

app.whenReady().then(async () => {
  // Headless screenshot test bypasses the rest of app init.
  if (parseFlag('test-screenshot')) {
    await runScreenshotTest();
    return;
  }

  // 多重起動の防止 (2026-06 fix)。同じ DB を使う 2 つ目のインスタンスが
  // 並行してクロール / 通知発火すると、古い条件のまま誤通知が飛ぶ等の
  // 事故になる。2 つ目の起動はロックを取得できず即終了し、代わりに
  // 既存ウィンドウを前面化する。screenshot テストは対象外 (上で return 済)。
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Hide the default File/Edit/View/Window/Help menu bar. Applies to
  // every BrowserWindow created afterwards — main, login, CAPTCHA
  // solve. Must be called before the first window is constructed.
  Menu.setApplicationMenu(null);

  initSession();   // override UA to real Chrome BEFORE any requests
  initDb();        // synchronous with better-sqlite3 — opens the file, runs migrations
  // 手数料・サイズ区分の計算(機密)は Rust addon 側に実装。fee-calc は
  // その呼び出し口を注入で受け取る。CSV インポート/Keepa更新が走る前に設定。
  require('./services/fee-calc').setFeeComputer(
    require('./services/crawler-bridge').computeFees
  );
  registerIpcHandlers();
  setWindowCallbacks({
    openLogin: openLoginWindow,
    openCaptchaSolve: () => openCaptchaSolveWindow(lastCaptchaSolveUrl),
    // viewBlockedPage (生ページ表示) は B10 で撤去 — URL/まとめ検索の露出回避。
    // showBlockedPageWindow は未参照のデッドコードとして残置 (呼び出し経路なし)。
  });
  createMainWindow();
  startRetentionSchedule();
  // Keepa API 定期更新 (spec 項目8) — API キー未設定なら各ティックで no-op。
  // クロール (Amazon スクレイプ) とは独立して動く直接 API 呼び出し。
  keepaRefresh.start();

  // Wire fetcher events into the UI + telemetry.
  setPauseCallbacks(onClientPause, onClientResume);
  setCircuitCallback(onCircuitBreakerChange);
  setBlockCallback(onBlockEvent);

  // Per client spec: scraping never auto-starts. The only entry point
  // is the renderer's 監視スタート button (which sends the user's
  // ✅checked ASIN subset). We still detect sign-in state so the
  // renderer can hide the login gate, but we don't kick off the
  // scheduler — the user explicitly opts in by checking products and
  // clicking 監視スタート.
  const signedIn = await isSignedIn();
  console.info(
    signedIn
      ? '[startup] signed in — awaiting 監視スタート from renderer'
      : '[startup] not signed in — login gate will be shown'
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// ── Guaranteed teardown (恒久対応 2026-06, client要望「終了処理を確実にする」) ──
//
// 旧実装は event.preventDefault() で既定の終了を取り消した上で、try 内の
// `await shutdown(); app.exit(0)` に到達したときだけ実際に終了していた。途中の
// shutdown() が固まる / closeDb() が投げる等で app.exit(0) に届かないと、
// ウィンドウは閉じてもメインプロセスが生き残る (= ゴーストインスタンス)。さらに
// express / ws の listen や Rust スレッドが event loop を生かし続けるため自然終了も
// しない。ゴーストが単一インスタンスロックを握ると、次回「アプリ再起動」しても
// 既存(死んだ)プロセスを前面化するだけで監視が動かず、PC 再起動でしか直らない
// (client報告: アプリ再起動では直らず PC 再起動直後に動く / IP も変わらない)。
//
// 対策: 終了を「必ず」遂行する。各後始末を try/catch で隔離し、shutdown() を
// タイムアウトで打ち切り、finally で必ず app.exit(0)。万一その経路すら詰まっても
// ウォッチドッグで process.exit(0) し、プロセスを確実に落とす。
let _isQuitting = false;
app.on('before-quit', (event) => {
  if (_isQuitting) return;             // 既に終了処理中 — 二重実行しない
  _isQuitting = true;
  event.preventDefault();              // 終了は自前で「必ず」完了させる

  // Hard safety net — 何が起きても一定時間内にプロセスを落とす最終防壁。
  const watchdog = setTimeout(() => {
    try { console.warn('[shutdown] watchdog fired — forcing process.exit'); } catch { /* noop */ }
    process.exit(0);
  }, 2500);
  if (watchdog.unref) watchdog.unref();

  (async () => {
    try { scheduler.stop(); }        catch { /* noop */ }
    try { stopRetentionSchedule(); } catch { /* noop */ }
    try { keepaRefresh.stop(); }     catch { /* noop */ }
    // Best-effort abort of any in-flight crawl. Bounded by a 1.5 s race so a
    // stuck native abort can never hang the quit.
    try {
      const { shutdown } = require('./services/crawler-bridge');
      await Promise.race([
        Promise.resolve().then(() => shutdown()),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch { /* noop */ }
    try { closeDb(); } catch { /* noop */ }
  })().catch(() => { /* noop */ }).finally(() => {
    clearTimeout(watchdog);
    app.exit(0);                       // 通常はここで確実に終了する
  });
});
