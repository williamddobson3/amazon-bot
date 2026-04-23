export const BACKEND_HTTP_URL = 'http://localhost:3000';
export const BACKEND_WS_URL = 'ws://localhost:3000';

export const ALARM_TICK = 'scrape-tick';
export const ALARM_SYNC = 'sync-tick';
export const ALARM_INTERVAL_MIN = 1;
export const SYNC_INTERVAL_MIN = 5;

export const DB_NAME = 'AmazonMonitorDB';
export const DB_VERSION = 1;

export const STORES = {
  ASIN_MASTER: 'asin_master',
  OBSERVATIONS: 'observations',
  CONDITIONS: 'conditions',
  NOTIFICATIONS: 'notifications',
  SETTINGS: 'settings',
};

export const MSG = {
  SCRAPE: 'SCRAPE',
  SCRAPE_RESULT: 'SCRAPE_RESULT',
  SCRAPE_FAILED: 'SCRAPE_FAILED',
  // Offscreen → background: the fetcher has hit a CAPTCHA or 429 and is
  // self-pausing until `pausedUntil`. Background should reject incoming
  // SCRAPE_JOBs with CLIENT_PAUSED until that time.
  CLIENT_PAUSE: 'CLIENT_PAUSE',
  // Background → offscreen: the user has solved the CAPTCHA (or the
  // recovery probe came back clean). Reset pausedUntil and captchaStreak
  // so the next scrape sails straight through awaitFetchSlot.
  CLIENT_RESUME: 'CLIENT_RESUME',
};

export const WS_MSG = {
  AUTH: 'AUTH',
  HEARTBEAT: 'HEARTBEAT',
  SCRAPE_JOB: 'SCRAPE_JOB',
  SCRAPE_RESULT: 'SCRAPE_RESULT',
  SCRAPE_FAILED: 'SCRAPE_FAILED',
  PRICE_UPDATE: 'PRICE_UPDATE',
  CONDITION_TRIGGERED: 'CONDITION_TRIGGERED',
  SELECTOR_UPDATE: 'SELECTOR_UPDATE',
  SYNC_WATCHLIST: 'SYNC_WATCHLIST',
  SYNC_CONDITIONS: 'SYNC_CONDITIONS',
  BATCH_PROGRESS: 'BATCH_PROGRESS',
  BATCH_COMPLETE: 'BATCH_COMPLETE',
};

// Popup <-> background messages for streaming UI updates. The popup
// subscribes to these via chrome.runtime.onMessage and the background
// forwards them whenever a WS event lands.
export const POPUP_MSG = {
  PRICE_UPDATE: 'popup:priceUpdate',
  BATCH_PROGRESS: 'popup:batchProgress',
  BATCH_COMPLETE: 'popup:batchComplete',
  REFRESH: 'popup:refresh',
  // CAPTCHA pause signalling for the side-panel banner.
  CLIENT_PAUSE: 'popup:clientPause',
  CLIENT_RESUME: 'popup:clientResume',
};
