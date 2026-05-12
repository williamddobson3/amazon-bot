'use strict';

// All migrations run on first launch (or when the schema version bumps).
// Each statement is idempotent via IF NOT EXISTS so re-running is safe.
// Executed via better-sqlite3's db.exec() — one statement per call.

const STATEMENTS = [
  // Products
  `CREATE TABLE IF NOT EXISTS products (
    asin              TEXT PRIMARY KEY,
    title             TEXT DEFAULT '',
    image_url         TEXT,
    priority          TEXT DEFAULT 'normal',
    added_at          INTEGER NOT NULL,
    last_price        INTEGER,
    last_points       INTEGER,
    last_delivery     TEXT,
    last_mp_price     INTEGER,
    last_mp_count     INTEGER,
    last_mp_condition TEXT,
    last_observed_at  INTEGER,
    last_error        TEXT,
    last_error_at     INTEGER,
    scrape_failures   INTEGER DEFAULT 0,
    cycle_seen        INTEGER DEFAULT 0
  )`,

  // Observations: high-frequency, 7-day full retention
  `CREATE TABLE IF NOT EXISTS observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    asin         TEXT NOT NULL,
    observed_at  INTEGER NOT NULL,
    price        INTEGER,
    points       INTEGER,
    delivery     TEXT,
    image_url    TEXT,
    mp_price     INTEGER,
    mp_count     INTEGER,
    mp_condition TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_obs_asin_time ON observations(asin, observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_time      ON observations(observed_at)`,

  // Daily summaries for days 8-180
  `CREATE TABLE IF NOT EXISTS observations_daily (
    asin         TEXT NOT NULL,
    day_date     TEXT NOT NULL,
    avg_price    REAL,
    min_price    INTEGER,
    max_price    INTEGER,
    avg_points   REAL,
    avg_mp_price REAL,
    avg_mp_count REAL,
    sample_count INTEGER DEFAULT 0,
    PRIMARY KEY (asin, day_date)
  )`,

  // (`conditions` table removed 2026-05 — legacy alert-rule engine
  // replaced entirely by FNM custom-filter slots. Existing rows in
  // older installs are dropped at startup, see runMigrations below.)

  // Notification log
  `CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    asin         TEXT NOT NULL,
    condition_id INTEGER,
    price        INTEGER,
    mp_price     INTEGER,
    discord_sent INTEGER DEFAULT 0,
    sent_at      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notif_sent ON notifications(sent_at)`,

  // Key-value settings
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,

  // Block-event telemetry — every CAPTCHA / WAF block the fetcher sees,
  // with enough metadata to correlate triggers over time. Used by the
  // health panel and for post-hoc pacing tuning.
  `CREATE TABLE IF NOT EXISTS block_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    block_type  TEXT NOT NULL,
    source      TEXT,
    streak      INTEGER DEFAULT 0,
    url_len     INTEGER,
    final_url   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_block_time ON block_events(occurred_at)`,

  // Groups — at most 20 groups per spec. Used to filter the viewer
  // and bulk-classify products. Each product belongs to ≤1 group.
  `CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

function runMigrations(db) {
  for (const stmt of STATEMENTS) {
    db.exec(stmt);
  }
  // Additive columns for databases created before later features.
  // SQLite has no `ADD COLUMN IF NOT EXISTS`, so we just catch the
  // "duplicate column" error if it's already present.
  try { db.exec('ALTER TABLE observations_daily ADD COLUMN avg_mp_count REAL'); } catch {}
  // Soft-delete: trashed_at is null for active products, a ms timestamp
  // for products in the trash bin. Permanent deletion is `DELETE FROM ...`.
  try { db.exec('ALTER TABLE products ADD COLUMN trashed_at INTEGER'); } catch {}
  // Group assignment: FK to groups.id. Null = ungrouped.
  try { db.exec('ALTER TABLE products ADD COLUMN group_id INTEGER'); } catch {}
  // One-shot cleanup: drop the `conditions` table on installs that
  // ran prior versions. Any leftover rows in there were silently
  // firing notifications via the old evaluator path.
  try { db.exec('DROP TABLE IF EXISTS conditions'); } catch {}
}

module.exports = { runMigrations };
