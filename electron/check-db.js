#!/usr/bin/env node
// DB 整合性チェック + 簡易修復スクリプト。
// 1. integrity_check で壊れ具合を確認
// 2. 修復可能なら .dump 経由で新ファイル recovered.db に再構築
//
// Usage:
//   node check-db.js  [check|recover|status]
//
// デフォルトは check。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB_DIR  = path.join(APPDATA, 'amazon-price-monitor');
const DB_PATH = path.join(DB_DIR, 'amazon-monitor.db');
const WAL     = DB_PATH + '-wal';
const SHM     = DB_PATH + '-shm';
const REC     = path.join(DB_DIR, 'amazon-monitor.recovered.db');

const cmd = (process.argv[2] || 'check').toLowerCase();

console.log(`[check-db] DB path: ${DB_PATH}`);

if (cmd === 'status') {
  const list = ['amazon-monitor.db', 'amazon-monitor.db-wal', 'amazon-monitor.db-shm', 'amazon-monitor.recovered.db'];
  for (const name of list) {
    const p = path.join(DB_DIR, name);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      console.log(`  ${name}: ${(st.size / 1024).toFixed(1)} KB  (mtime ${st.mtime.toISOString()})`);
    } else {
      console.log(`  ${name}: (does not exist)`);
    }
  }
  process.exit(0);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`[check-db] DB not found at ${DB_PATH}`);
  process.exit(1);
}

if (cmd === 'check') {
  // 読み取り専用で開いて integrity_check を実行。WAL を触らない。
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length === 1 && rows[0].integrity_check === 'ok') {
      console.log('[check-db] integrity_check: OK');
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM products').get();
      console.log(`[check-db] products count: ${cnt.c}`);
    } else {
      console.log('[check-db] integrity_check FAILED:');
      for (const r of rows.slice(0, 20)) {
        console.log(`  - ${r.integrity_check}`);
      }
      console.log('');
      console.log('To attempt recovery, run:  node check-db.js recover');
    }
  } finally {
    db.close();
  }
  process.exit(0);
}

if (cmd === 'recover') {
  if (fs.existsSync(REC)) {
    console.error(`[check-db] ${REC} already exists. Delete it first or move it aside.`);
    process.exit(1);
  }
  console.log('[check-db] dumping schema + data from corrupt DB...');
  const src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const dst = new Database(REC);
  try {
    // テーブル一覧を取得 (sqlite_master から、破損していても拾える分だけ)。
    const tables = src.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    console.log(`[check-db] found ${tables.length} tables`);

    dst.exec('PRAGMA journal_mode = WAL');
    dst.exec('BEGIN');
    for (const t of tables) {
      console.log(`  ${t.name} ...`);
      try {
        dst.exec(t.sql);
      } catch (e) {
        console.warn(`    CREATE failed: ${e.message}`);
        continue;
      }
      // 行をできる限りコピー (壊れた行はスキップ)。
      let copied = 0;
      let failed = 0;
      try {
        const rows = src.prepare(`SELECT * FROM "${t.name}"`).all();
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const ph = cols.map(() => '?').join(', ');
          const ins = dst.prepare(
            `INSERT OR IGNORE INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph})`
          );
          for (const r of rows) {
            try {
              ins.run(cols.map((c) => r[c]));
              copied++;
            } catch (e) {
              failed++;
            }
          }
        }
      } catch (e) {
        console.warn(`    SELECT failed for ${t.name}: ${e.message}`);
      }
      console.log(`    ${copied} rows copied, ${failed} failed`);
    }

    // インデックスも再構築。
    const indexes = src.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"
    ).all();
    for (const i of indexes) {
      try { dst.exec(i.sql); } catch (e) { /* duplicate / etc — ignore */ }
    }
    dst.exec('COMMIT');
    console.log(`[check-db] recovered DB written to ${REC}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Close the Electron app completely.');
    console.log(`  2. Move/rename amazon-monitor.db (e.g. to .broken.db).`);
    console.log(`  3. Rename amazon-monitor.recovered.db to amazon-monitor.db.`);
    console.log('  4. Delete amazon-monitor.db-wal and amazon-monitor.db-shm if present.');
    console.log('  5. Restart the app.');
  } catch (e) {
    console.error('[check-db] recovery failed:', e.message);
    try { dst.exec('ROLLBACK'); } catch {}
    process.exit(1);
  } finally {
    src.close();
    dst.close();
  }
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
console.error('Usage: node check-db.js [check|recover|status]');
process.exit(1);
