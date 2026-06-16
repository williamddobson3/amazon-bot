'use strict';

// Post-build step for the Rust → Node-API addon.
//
// Cargo emits the cdylib at the platform's standard location:
//   * Windows : crawler/target/release/amazon_crawler.dll
//   * macOS   : crawler/target/release/libamazon_crawler.dylib
//   * Linux   : crawler/target/release/libamazon_crawler.so
//
// Node.js' `require()` recognises ".node" as a native addon, so we
// simply copy the platform-specific file to `crawler/index.node`.
// The destination path is what `crawler-bridge.js` loads at runtime
// (both in dev and inside the packaged app via electron-builder's
// asarUnpack rule).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'crawler', 'target', 'release');

const candidates = {
  win32:  ['amazon_crawler.dll'],
  darwin: ['libamazon_crawler.dylib'],
  linux:  ['libamazon_crawler.so'],
};
const names = candidates[process.platform];
if (!names) {
  console.error(`[copy-crawler] unsupported platform: ${process.platform}`);
  process.exit(1);
}

const src = names.map((n) => path.join(target, n)).find((p) => fs.existsSync(p));
if (!src) {
  console.error(
    `[copy-crawler] cargo output not found in ${target} ` +
    `(expected one of: ${names.join(', ')}). Did 'cargo build --release' succeed?`
  );
  process.exit(1);
}

const dst = path.join(root, 'crawler', 'index.node');
fs.copyFileSync(src, dst);
const kb = (fs.statSync(dst).size / 1024).toFixed(1);
console.log(`[copy-crawler] ${path.basename(src)} → crawler/index.node (${kb} KB)`);
