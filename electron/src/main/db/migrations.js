'use strict';

// All migrations run on first launch (or when the schema version bumps).
// Each statement is idempotent via IF NOT EXISTS so re-running is safe.
// sql.js's db.run() executes one statement at a time, so we split them.

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
    sample_count INTEGER DEFAULT 0,
    PRIMARY KEY (asin, day_date)
  )`,

  // Conditions (alert rules)
  `CREATE TABLE IF NOT EXISTS conditions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    asin         TEXT,
    rule_type    TEXT NOT NULL,
    rule_params  TEXT NOT NULL,
    enabled      INTEGER DEFAULT 1,
    cooldown_sec INTEGER DEFAULT 3600,
    last_fired   INTEGER
  )`,

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
];

function runMigrations(db) {
  for (const stmt of STATEMENTS) {
    db.run(stmt);
  }
}

module.exports = { runMigrations };
