'use strict';

const { app, BrowserWindow, Notification } = require('electron');
const path = require('path');
const { initDb, closeDb, saveToDisk } = require('./db/sqlite');
const { registerIpcHandlers } = require('./ipc-handlers');
const { startRetentionSchedule, stopRetentionSchedule } = require('./db/retention');
const scheduler = require('./services/scheduler');
const { initSession, setPauseCallbacks, liftPause } = require('./scraper/fetcher');
const { PUSH } = require('../shared/constants');

let mainWindow = null;
let captchaSolveWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 800,
    minWidth: 380,
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Give the scheduler a reference so it can push events to the renderer.
  scheduler.setMainWindow(mainWindow);
}

// ── CAPTCHA solve flow ──────────────────────────────────────
// When the fetcher detects a CAPTCHA/block, it calls the onPause
// callback. We show a native notification and (when clicked) open the
// block URL in a BrowserWindow so the user can solve it with the same
// session cookies the fetcher uses (Electron's defaultSession).

function onClientPause({ pausedUntil, reason, solveUrl, source }) {
  // Notify the renderer so it can show a banner.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH.CAPTCHA_PAUSE, {
      pausedUntil, reason, solveUrl, source,
    });
  }

  // Desktop notification.
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

function openCaptchaSolveWindow(url) {
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

  captchaSolveWindow.loadURL(url || 'https://www.amazon.co.jp/');

  // Detect when the user navigates away from the block page.
  captchaSolveWindow.webContents.on('did-navigate', (_e, navUrl) => {
    if (
      !navUrl.includes('/errors/validateCaptcha') &&
      !navUrl.includes('/ap/signin') &&
      !navUrl.includes('google.com/sorry') &&
      !navUrl.includes('google.co.jp/sorry')
    ) {
      // Probable solve — lift the pause.
      console.info('[captcha] solve detected via navigation to:', navUrl);
      liftPause();
    }
  });

  captchaSolveWindow.on('closed', () => {
    captchaSolveWindow = null;
    // User closed the window — try lifting (recovery probe would be
    // better, but for simplicity we trust the user).
    liftPause();
  });
}

// ── App lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  initSession();   // override UA to real Chrome BEFORE any requests
  await initDb();  // async: loads sql.js WASM binary on first call
  registerIpcHandlers();
  createMainWindow();
  startRetentionSchedule();

  // Wire CAPTCHA pause/resume callbacks from the fetcher into the
  // notification + BrowserWindow solve flow.
  setPauseCallbacks(onClientPause, onClientResume);

  // Auto-start scraping on launch.
  scheduler.start();
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
