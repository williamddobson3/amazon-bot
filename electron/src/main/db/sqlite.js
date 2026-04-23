'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { runMigrations } = require('./migrations');

let db = null;
let dbPath = null;
let saveTimer = null;

// sql.js loads WebAssembly asynchronously on first call. After that,
// the API is fully synchronous — same usage pattern as better-sqlite3.
let SQL = null;

function getDbPath() {
  const userDataDir = app.getPath('userData');
  return path.join(userDataDir, 'amazon-monitor.db');
}

async function initDb() {
  if (db) return db;

  // Load the sql.js WASM binary (one-time async init).
  if (!SQL) {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();
  }

  dbPath = getDbPath();

  // Load existing database from disk, or create a new one.
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log(`[sqlite] opened existing ${dbPath}`);
  } else {
    db = new SQL.Database();
    console.log(`[sqlite] created new ${dbPath}`);
  }

  // WAL mode isn't available in sql.js (it runs in-memory with manual
  // saves), but we enable it anyway — it's silently ignored.
  try { db.run('PRAGMA journal_mode = WAL'); } catch {}
  try { db.run('PRAGMA foreign_keys = ON'); } catch {}

  runMigrations(db);

  // Auto-save to disk every 10 seconds so data survives crashes.
  startAutoSave();

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function saveToDisk() {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    // Write to a temp file first, then rename — atomic write.
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, dbPath);
  } catch (err) {
    console.error('[sqlite] save failed:', err.message);
  }
}

function startAutoSave() {
  if (saveTimer) return;
  saveTimer = setInterval(saveToDisk, 10000);
}

function closeDb() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (db) {
    saveToDisk(); // final save
    db.close();
    db = null;
    console.log('[sqlite] closed');
  }
}

// ── Compatibility wrapper ───────────────────────────────────
//
// sql.js has a different API than better-sqlite3. This wrapper provides
// a `.prepare(sql)` method that returns an object with `.run()`,
// `.get()`, `.all()` methods matching better-sqlite3's interface, so
// queries.js can use the same code for both.

function prepare(sql) {
  return {
    run(...params) {
      const flat = flattenParams(params);
      getDb().run(sql, flat);
      // Return an object mimicking better-sqlite3's RunResult.
      return {
        changes: getDb().getRowsModified(),
        lastInsertRowid: getLastInsertRowId(),
      };
    },

    get(...params) {
      const flat = flattenParams(params);
      const stmt = getDb().prepare(sql);
      stmt.bind(flat);
      let row = null;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      stmt.free();
      return row || undefined;
    },

    all(...params) {
      const flat = flattenParams(params);
      const stmt = getDb().prepare(sql);
      stmt.bind(flat);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    },
  };
}

function getLastInsertRowId() {
  try {
    const stmt = getDb().prepare('SELECT last_insert_rowid() AS id');
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return row.id;
  } catch {
    return 0;
  }
}

// sql.js expects params as a flat array. If the caller passes them as
// individual arguments (better-sqlite3 style), flatten.
function flattenParams(params) {
  if (params.length === 0) return [];
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

// Expose a transaction helper that matches better-sqlite3's pattern:
//   const tx = transaction((args) => { ... });
//   tx(args);
function transaction(fn) {
  return function (...args) {
    const d = getDb();
    d.run('BEGIN');
    try {
      const result = fn(...args);
      d.run('COMMIT');
      return result;
    } catch (err) {
      d.run('ROLLBACK');
      throw err;
    }
  };
}

module.exports = { initDb, getDb, closeDb, prepare, transaction, saveToDisk };
