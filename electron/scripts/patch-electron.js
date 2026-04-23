#!/usr/bin/env node
// Post-install script: patch node_modules/electron/index.js so that
// require('electron') returns the Electron API (app, BrowserWindow, etc.)
// when called from within the Electron main process, and the binary path
// when called from Node.js (the CLI launcher).
//
// This works around a known issue on some Windows Server systems where
// Electron's built-in module registration doesn't intercept
// require('electron') before Node's module resolver finds the npm package.

'use strict';
const fs = require('fs');
const path = require('path');

const electronPkgDir = path.join(__dirname, '..', 'node_modules', 'electron');
const indexPath = path.join(electronPkgDir, 'index.js');

if (!fs.existsSync(indexPath)) {
  console.log('[patch-electron] electron not installed yet, skipping');
  process.exit(0);
}

const original = fs.readFileSync(indexPath, 'utf8');
if (original.includes('PATCHED_FOR_MAIN_PROCESS')) {
  console.log('[patch-electron] already patched, skipping');
  process.exit(0);
}

// Save the original
fs.writeFileSync(indexPath + '.orig', original);

const patched = `// PATCHED_FOR_MAIN_PROCESS
// When running inside the Electron main process, this file should return
// the Electron API. When running in Node.js (CLI), return the binary path.
'use strict';

if (process.type === 'browser' || process.type === 'renderer') {
  // Already inside a properly initialized Electron process.
  // This shouldn't happen (the built-in should take precedence),
  // but if it does, try to access the API through the internal
  // module system.
  module.exports = {};
} else if (process.versions && process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  // We're inside the Electron binary but the bootstrap hasn't
  // registered the built-in 'electron' module. This is the bug.
  //
  // Workaround: schedule a microtask to re-export the module AFTER
  // the bootstrap completes. Meanwhile, return a Proxy that defers
  // property access until the real module is available.
  //
  // The key insight: by the time user code accesses 'app.whenReady()',
  // the bootstrap HAS completed and process.type IS set. The Proxy
  // intercepts the property access and re-resolves at that moment.

  const Module = require('module');
  let _cachedElectron = null;

  function getRealElectron() {
    if (_cachedElectron) return _cachedElectron;

    // Delete ourselves from the module cache so the next require('electron')
    // doesn't hit this file again.
    const myPath = __filename;
    delete Module._cache[myPath];

    // Now try to find the REAL electron module.
    // In Electron 33+, after bootstrap, the _resolveFilename should
    // redirect 'electron' to the internal API. But we're here because
    // it didn't. So we construct the API from the linked bindings.
    try {
      // The app binding is the core of the Electron API
      const appBinding = process._linkedBinding('electron_browser_app');
      const EventEmitter = require('events');

      // Create the app object
      const app = new EventEmitter();
      const appProto = Object.getOwnPropertyDescriptors(appBinding);
      for (const [key, desc] of Object.entries(appProto)) {
        try { Object.defineProperty(app, key, desc); } catch {}
      }

      // Create BrowserWindow
      let BrowserWindow, session, ipcMain, Notification, net, Menu, Tray, dialog, nativeImage;
      try { BrowserWindow = process._linkedBinding('electron_browser_window').BrowserWindow; } catch {}
      try { session = process._linkedBinding('electron_browser_session'); } catch {}
      try { ipcMain = process._linkedBinding('electron_browser_ipc_main'); } catch {}
      try { Notification = process._linkedBinding('electron_browser_notification').Notification; } catch {}
      try { net = process._linkedBinding('electron_browser_net'); } catch {}
      try { Menu = process._linkedBinding('electron_browser_menu').Menu; } catch {}
      try { Tray = process._linkedBinding('electron_browser_tray').Tray; } catch {}
      try { dialog = process._linkedBinding('electron_browser_dialog'); } catch {}
      try { nativeImage = process._linkedBinding('electron_common_native_image'); } catch {}

      _cachedElectron = {
        app, BrowserWindow, session, ipcMain, Notification,
        net, Menu, Tray, dialog, nativeImage,
      };

      return _cachedElectron;
    } catch (err) {
      console.error('[electron-patch] failed to construct API from bindings:', err.message);
      return {};
    }
  }

  // Return a Proxy that lazily resolves the API
  module.exports = new Proxy({}, {
    get(_, prop) {
      if (prop === '__esModule') return false;
      if (prop === 'default') return getRealElectron();
      return getRealElectron()[prop];
    },
    has(_, prop) { return prop in getRealElectron(); },
    ownKeys() { return Object.keys(getRealElectron()); },
    getOwnPropertyDescriptor(_, prop) {
      const real = getRealElectron();
      if (prop in real) return { configurable: true, enumerable: true, value: real[prop] };
    },
  });
} else {
  // Normal Node.js context (the CLI launcher). Return the binary path.
${original}
}
`;

fs.writeFileSync(indexPath, patched);
console.log('[patch-electron] patched node_modules/electron/index.js');
