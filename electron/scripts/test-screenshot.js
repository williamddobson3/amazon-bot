#!/usr/bin/env node
'use strict';

// Cross-shell launcher for the headless screenshot test. Required
// because the ELECTRON_RUN_AS_NODE=1 env var is set globally on this
// machine — it makes electron.exe behave as a plain Node interpreter,
// which means `app.whenReady()` is undefined and our index.js crashes.
// The bash inline-prefix unset (`ELECTRON_RUN_AS_NODE= electron ...`)
// only works in POSIX shells; from cmd.exe or PowerShell the var
// stays set. Spawning a child with a cleaned env works everywhere.
//
// Usage:
//   node scripts/test-screenshot.js B0CXDLD989 [outPath]
//   npm run test:screenshot -- B0CXDLD989

const { spawn } = require('child_process');
const path = require('path');

const asin = (process.argv[2] || '').toUpperCase();
if (!/^[A-Z0-9]{10}$/.test(asin)) {
  console.error('usage: node scripts/test-screenshot.js <ASIN> [outPath]');
  process.exit(1);
}

const outPath = process.argv[3] ||
  path.join(__dirname, '..', '..', `test-${asin}.png`);

const electronExe = path.join(
  __dirname, '..', 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [
  '.',
  `--test-screenshot=${asin}`,
  `--out=${outPath}`,
];

console.info(`[runner] electron ${args.join(' ')}`);
console.info(`[runner] out: ${outPath}`);

const child = spawn(electronExe, args, {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => {
  console.error('[runner] spawn failed:', err.message);
  process.exit(1);
});
