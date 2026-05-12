'use strict';

// Preload bridge for the offscreen chart-render window. Keeps the page
// itself free of nodeIntegration; only exposes the two IPC primitives
// the renderer-side scaffold needs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chartRender', {
  onRender:    (cb) => ipcRenderer.on('chart:render', (_e, msg) => cb(msg)),
  signalReady: ()   => ipcRenderer.send('chart:ready'),
});
