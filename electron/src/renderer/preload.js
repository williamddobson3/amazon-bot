'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Load constants — wrap in try/catch so a path resolution error
// doesn't prevent the bridge from being exposed at all.
let IPC_CHANNEL = 'app-action';
let PUSH = {
  PRICE_UPDATE:   'price-update',
  CYCLE_PROGRESS: 'cycle-progress',
  CYCLE_COMPLETE: 'cycle-complete',
  CAPTCHA_PAUSE:  'captcha-pause',
  CAPTCHA_RESUME: 'captcha-resume',
};
try {
  const c = require('../shared/constants');
  IPC_CHANNEL = c.IPC_CHANNEL;
  PUSH = c.PUSH;
} catch (err) {
  console.error('[preload] failed to load constants, using defaults:', err.message);
}

contextBridge.exposeInMainWorld('api', {
  invoke: (action, payload) => ipcRenderer.invoke(IPC_CHANNEL, { action, ...payload }),

  onPriceUpdate:   (cb) => ipcRenderer.on(PUSH.PRICE_UPDATE,   (_e, d) => cb(d)),
  onCycleProgress: (cb) => ipcRenderer.on(PUSH.CYCLE_PROGRESS, (_e, d) => cb(d)),
  onCycleComplete: (cb) => ipcRenderer.on(PUSH.CYCLE_COMPLETE, (_e, d) => cb(d)),
  onCaptchaPause:  (cb) => ipcRenderer.on(PUSH.CAPTCHA_PAUSE,  (_e, d) => cb(d)),
  onCaptchaResume: (cb) => ipcRenderer.on(PUSH.CAPTCHA_RESUME, (_e, d) => cb(d)),
});

console.log('[preload] api bridge exposed');
