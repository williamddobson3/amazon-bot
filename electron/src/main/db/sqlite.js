'use strict';

const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

let db = null;
let dbPath = null;

// Prepared-statement cache keyed on SQL text. better-sqlite3 prepared
// statements are heavy to build but cheap to execute, so caching by SQL
// string lets call sites keep their "prepare(sql).run(...)" inline style
// without paying the prepare cost on every call — a measurable win in
// hot loops like insertObservationsBatch at 10k-ASIN scale.
const stmtCache = new Map();

function getDbPath() {
  const userDataDir = app.getPath('userData');
  return path.join(userDataDir, 'amazon-monitor.db');
}

// Synchronous with better-sqlite3 — opens the file (creating it if
// missing) and returns immediately. No WASM load, no async import,
// no deferred init. Caller still uses `await` for backwards-compat
// but the await is a no-op.
function initDb() {
  if (db) return db;

  dbPath = getDbPath();
  db = new Database(dbPath);

  // Performance & correctness pragmas.
  //
  // journal_mode=WAL: concurrent read during write, required at 10k
  //   scale. The old sql.js build silently ignored this pragma.
  // synchronous=NORMAL: safe with WAL, ~2× faster than FULL on writes.
  // foreign_keys=ON: enforce referential integrity.
  // cache_size=-20000: 20 MB page cache (negative = kibibytes).
  // mmap_size=256 MB: memory-map the read pages, avoids many syscalls
  //   on the hot observation indices.
  // temp_store=MEMORY: temp tables & indexes in RAM, not tmp file.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -20000');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');

  console.log(`[sqlite] opened ${dbPath}`);

  runMigrations(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function closeDb() {
  if (db) {
    // Force any pending WAL frames to the main DB file before exit so
    // the next launch sees a clean checkpoint, not a growing -wal file.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    stmtCache.clear();
    db.close();
    db = null;
    console.log('[sqlite] closed');
  }
}

// Cached prepare — returns a better-sqlite3 Statement whose .run/.get/.all
// shape matches exactly what the sql.js compatibility wrapper used to
// return, so queries.js needed no edits.
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// better-sqlite3 has native transaction support — wraps fn so the SQL
// inside runs inside a BEGIN/COMMIT/ROLLBACK block automatically.
// Same call shape as the old sql.js helper (`const tx = transaction(fn); tx(args)`).
function transaction(fn) {
  return getDb().transaction(fn);
}

// No-op. With sql.js the whole DB was in memory and had to be serialised
// to disk on a timer; with better-sqlite3 every committed write is
// already durable on the WAL, so this function exists only so callers
// in queries.js / retention.js don't need to change. Delete the calls
// at leisure — they harm nothing.
function saveToDisk() {
  // intentional no-op
}

module.exports = { initDb, getDb, closeDb, prepare, transaction, saveToDisk };
