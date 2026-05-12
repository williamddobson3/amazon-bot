'use strict';

const { app, BrowserWindow, Notification, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { initDb, closeDb } = require('./db/sqlite');
const Q = require('./db/queries');
const { registerIpcHandlers, setWindowCallbacks } = require('./ipc-handlers');
const { startRetentionSchedule, stopRetentionSchedule } = require('./db/retention');
const scheduler = require('./services/scheduler');
const {
  initSession,
  setPauseCallbacks,
  setCircuitCallback,
  setBlockCallback,
  liftPause,
  isSignedIn,
} = require('./scraper/fetcher');
const { PUSH, AMAZON_BASE } = require('../shared/constants');

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

  // Hide the default File/Edit/View/Window/Help menu bar. Applies to
  // every BrowserWindow created afterwards — main, login, CAPTCHA
  // solve. Must be called before the first window is constructed.
  Menu.setApplicationMenu(null);

  initSession();   // override UA to real Chrome BEFORE any requests
  initDb();        // synchronous with better-sqlite3 — opens the file, runs migrations
  registerIpcHandlers();
  setWindowCallbacks({
    openLogin: openLoginWindow,
    openCaptchaSolve: () => openCaptchaSolveWindow(lastCaptchaSolveUrl),
  });
  createMainWindow();
  startRetentionSchedule();

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

app.on('before-quit', () => {
  scheduler.stop();
  stopRetentionSchedule();
  closeDb();
});
