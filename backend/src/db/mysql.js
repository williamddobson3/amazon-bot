import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import log from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  waitForConnections: true,
  connectionLimit: 20,
  charset: 'utf8mb4',
  multipleStatements: true,
});

export async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryRaw(sql) {
  const [rows] = await pool.query(sql);
  return rows;
}

export async function getConnection() {
  return pool.getConnection();
}

export async function migrate() {
  const conn = await pool.getConnection();
  try {
    // Run all migration files in order. Each file is idempotent — duplicate
    // schema errors are swallowed so the function is safe to re-run.
    const migrationFiles = [
      '001_init.sql',
      '002_per_user_observations.sql',
      '003_bulk_batches.sql',
      '004_drop_scrape_batches_fk.sql',
    ];

    for (const file of migrationFiles) {
      const sql = readFileSync(join(__dirname, 'migrations', file), 'utf8');
      const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        try {
          await conn.query(stmt);
        } catch (err) {
          // These error codes mean "already applied" — ignore so re-running
          // the migration is a no-op.
          // ER_CANT_DROP_FIELD_OR_KEY covers DROP FOREIGN KEY / DROP INDEX
          // against a constraint that no longer exists (or never did on
          // a fresh install).
          if (
            err.code === 'ER_DUP_KEYNAME' ||
            err.code === 'ER_TABLE_EXISTS_ERROR' ||
            err.code === 'ER_DUP_FIELDNAME' ||
            err.code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
            err.errno === 1091 ||   // drop non-existent key
            err.errno === 1025      // error on rename / drop FK
          ) continue;
          log.error(`Migration ${file} failed on stmt: ${stmt.slice(0, 100)}`);
          throw err;
        }
      }
      log.info(`Migration ${file} applied`);
    }

    // Legacy ALTER TABLE additions kept for older deployments
    const addColumns = [
      `ALTER TABLE asin_master ADD COLUMN last_delivery_time TEXT NULL`,
      `ALTER TABLE asin_master ADD COLUMN last_error VARCHAR(100) NULL`,
    ];
    for (const stmt of addColumns) {
      try {
        await conn.query(stmt);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') continue;
        throw err;
      }
    }

    log.info('Database migration complete');
  } finally {
    conn.release();
  }
}

// ── User queries ───────────────────────────────────────────

export async function createUser(email, passwordHash) {
  const id = uuidv4();
  await query(
    'INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)',
    [id, email, passwordHash]
  );
  return { id, email, plan: 'free' };
}

export async function getUserByEmail(email) {
  const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

export async function getUserById(id) {
  const rows = await query(
    'SELECT id, email, plan, contribution_rank, trust_score FROM users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

// ── ASIN master ────────────────────────────────────────────

export async function upsertAsin(asin) {
  await query(
    `INSERT IGNORE INTO asin_master (asin, title, next_scrape_at) VALUES (?, '', NOW())`,
    [asin]
  );
  return getAsinMaster(asin);
}

export async function getAsinMaster(asin) {
  const rows = await query('SELECT * FROM asin_master WHERE asin = ?', [asin]);
  return rows[0] || null;
}

// Per-user scrape state lives on watchlists. asin_master only caches the
// shared title (which doesn't vary per user).
export async function updateAsinAfterScrape(userId, asin, data) {
  const deliveryStr = data.deliveryTime == null
    ? null
    : (typeof data.deliveryTime === 'object' ? JSON.stringify(data.deliveryTime) : String(data.deliveryTime));

  // Update the shared title cache (does not vary by user)
  if (data.title) {
    await query(
      `UPDATE asin_master SET title = ? WHERE asin = ? AND (title = '' OR title IS NULL)`,
      [data.title, asin]
    );
  }

  // Update this user's per-watchlist cached snapshot + reschedule
  await query(
    `UPDATE watchlists SET
       last_scraped_at = NOW(),
       next_scrape_at  = DATE_ADD(NOW(), INTERVAL interval_sec SECOND),
       last_price                  = ?,
       last_points                 = ?,
       last_marketplace_lowest     = ?,
       last_new_offer_count        = ?,
       last_delivery_time          = ?,
       last_error                  = NULL,
       last_error_at               = NULL,
       scrape_failures             = 0
     WHERE user_id = ? AND asin = ?`,
    [data.price, data.points, data.marketplaceLowest, data.newOfferCount,
     deliveryStr, userId, asin]
  );
}

// Explicit failure-count → delay ladder. Replaces the old
// `interval_sec * POW(2, failures)` formula which, for bulk users with
// interval_sec = 86400, pushed every row 24 h into the future on the
// FIRST failure — effectively hiding the row for a day after a single
// CAPTCHA. The ladder below retries fast initially (transient issues
// clear quickly) and backs off glacially for chronic failures.
const FAILURE_BACKOFF_SEC = [
  60,        // 1st failure  → 1 min
  300,       // 2nd failure  → 5 min
  1800,      // 3rd failure  → 30 min
  10800,     // 4th failure  → 3 h
  86400,     // 5th+ failure → 24 h
];

export async function incrementAsinFailure(userId, asin, errorCode = null) {
  // We need to know the current scrape_failures count to pick the right
  // rung of the ladder. Read it, bump, compute delay, write back — all in
  // one short transaction to avoid a race with concurrent updates.
  const rows = await query(
    `SELECT scrape_failures FROM watchlists WHERE user_id = ? AND asin = ?`,
    [userId, asin]
  );
  const current = rows[0]?.scrape_failures ?? 0;
  const nextCount = current + 1;
  const idx = Math.min(nextCount - 1, FAILURE_BACKOFF_SEC.length - 1);
  const delaySec = FAILURE_BACKOFF_SEC[idx];

  await query(
    `UPDATE watchlists SET
       scrape_failures = scrape_failures + 1,
       last_error      = ?,
       last_error_at   = NOW(),
       next_scrape_at  = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE user_id = ? AND asin = ?`,
    [errorCode ? errorCode.slice(0, 100) : null, delaySec, userId, asin]
  );
}

// Per-user scrape queue: each (user_id, asin) pair is its own work item.
// Ordering: starred → normal, then oldest next_scrape_at first.
// Archived rows are excluded entirely.
export async function getAsinsNeedingScrape(limit) {
  const rows = await query(
    `SELECT w.user_id, w.asin, w.priority, w.interval_sec, w.scrape_failures
     FROM watchlists w
     WHERE w.next_scrape_at <= NOW()
       AND w.priority != 'archived'
     ORDER BY
       FIELD(w.priority, 'starred', 'normal'),
       w.next_scrape_at ASC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

// Compute the appropriate scrape interval for a user's watchlist row.
// Stratified by priority + total list size to keep heavy users sustainable.
// Tuned down from the original 6h/12h/24h ladder: a single client can
// comfortably sustain ~25 scrapes/min once pacing is correct, which means
// a 2000-row list completes in ~80 min. An 8 h cycle gives plenty of
// headroom without burying prices.
//
//   - starred:         always 10 min
//   - normal,  <100:   1 hour
//   - normal, <1000:   4 hours
//   - normal, <5000:   8 hours
//   - normal, ≥5000:   12 hours
//   - archived:        never scraped
function pickNormalInterval(total) {
  if (total < 100)  return 3600;    //  1 hour
  if (total < 1000) return 14400;   //  4 hours
  if (total < 5000) return 28800;   //  8 hours
  return 43200;                     // 12 hours
}

export async function recalcWatchlistInterval(userId, asin) {
  const sizeRows = await query(
    `SELECT COUNT(*) AS cnt FROM watchlists WHERE user_id = ? AND priority != 'archived'`,
    [userId]
  );
  const total = sizeRows[0]?.cnt || 0;
  const normalInterval = pickNormalInterval(total);

  await query(
    `UPDATE watchlists
     SET interval_sec = CASE priority
       WHEN 'starred'  THEN 600
       WHEN 'normal'   THEN ?
       WHEN 'archived' THEN 86400
     END
     WHERE user_id = ? AND asin = ?`,
    [normalInterval, userId, asin]
  );
}

// Recompute intervals for ALL of a user's normal-priority rows.
// Called when their list size crosses a tier boundary.
export async function recalcUserIntervals(userId) {
  const sizeRows = await query(
    `SELECT COUNT(*) AS cnt FROM watchlists WHERE user_id = ? AND priority != 'archived'`,
    [userId]
  );
  const total = sizeRows[0]?.cnt || 0;
  const normalInterval = pickNormalInterval(total);

  await query(
    `UPDATE watchlists
     SET interval_sec = CASE priority
       WHEN 'starred'  THEN 600
       WHEN 'normal'   THEN ?
       WHEN 'archived' THEN 86400
     END
     WHERE user_id = ?`,
    [normalInterval, userId]
  );
}

// Called when a user adds an ASIN: force an immediate scrape for THAT user.
export async function kickWatchlistScrape(userId, asin) {
  await query(
    `UPDATE watchlists SET
       next_scrape_at  = NOW(),
       scrape_failures = 0
     WHERE user_id = ? AND asin = ?`,
    [userId, asin]
  );
}

// Set the user-controlled priority for an ASIN (starred / normal / archived).
export async function setWatchlistPriority(userId, asin, priority) {
  if (!['starred', 'normal', 'archived'].includes(priority)) {
    throw new Error('Invalid priority');
  }
  await query(
    `UPDATE watchlists SET priority = ? WHERE user_id = ? AND asin = ?`,
    [priority, userId, asin]
  );
  await recalcWatchlistInterval(userId, asin);
}

// ── Watchlists ─────────────────────────────────────────────

export async function addToWatchlist(userId, asin) {
  await upsertAsin(asin);

  // Insert this user's watchlist row with default priority and an immediate
  // scrape time. INSERT IGNORE ensures re-adds don't error.
  await query(
    `INSERT IGNORE INTO watchlists
       (user_id, asin, priority, interval_sec, next_scrape_at)
     VALUES (?, ?, 'normal', 3600, NOW())`,
    [userId, asin]
  );

  // Bump the global popularity counter (still useful for stats / discovery)
  await query(
    'UPDATE asin_master SET watcher_count = watcher_count + 1 WHERE asin = ?',
    [asin]
  );

  // Recompute this user's intervals — the new row may have pushed them across
  // a tier boundary (e.g. from <100 to ≥100 ASINs)
  await recalcUserIntervals(userId);

  // Force an immediate scrape for THIS user even if the row already existed
  // with backoff from a previous attempt
  await kickWatchlistScrape(userId, asin);
}

export async function removeFromWatchlist(userId, asin) {
  await query('DELETE FROM watchlists WHERE user_id = ? AND asin = ?', [userId, asin]);
  await query(
    'UPDATE asin_master SET watcher_count = GREATEST(watcher_count - 1, 0) WHERE asin = ?',
    [asin]
  );
  await recalcUserIntervals(userId);
}

// ── Bulk watchlist ingest ──────────────────────────────────
//
// One transaction for an entire bulk add. Does NOT do per-row recalc of
// intervals (which was O(N²) in the serial path) — recalculates ONCE at
// the end of the transaction. Jitters next_scrape_at over 10 minutes so
// the coordinator doesn't see all N rows as due in the same tick.
//
// Returns { acceptedAsins: string[], duplicateAsins: string[] }
// where acceptedAsins are the ones we actually inserted (not already
// watched by this user). `duplicateAsins` is what got filtered out.
export async function addManyToWatchlist(userId, asins, batchId) {
  if (asins.length === 0) return { acceptedAsins: [], duplicateAsins: [] };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Find which of the requested ASINs are already on this user's list
    // so we can report them as duplicates and not double-count the batch.
    const placeholders = asins.map(() => '?').join(',');
    const [existingRows] = await conn.query(
      `SELECT asin FROM watchlists WHERE user_id = ? AND asin IN (${placeholders})`,
      [userId, ...asins]
    );
    const existing = new Set(existingRows.map((r) => r.asin));
    const toInsert = asins.filter((a) => !existing.has(a));
    const duplicateAsins = asins.filter((a) => existing.has(a));

    if (toInsert.length === 0) {
      await conn.commit();
      return { acceptedAsins: [], duplicateAsins };
    }

    // ── Chunked multi-row INSERT into asin_master ──────────
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const values = chunk.map(() => `(?, '', NOW())`).join(',');
      await conn.query(
        `INSERT IGNORE INTO asin_master (asin, title, next_scrape_at) VALUES ${values}`,
        chunk
      );
    }

    // ── Chunked multi-row INSERT into watchlists ───────────
    // Jitter next_scrape_at over 0–30 s so the coordinator round-robins
    // instead of seeing a herd of simultaneously-due rows. 30 s is short
    // enough that the first card lights up within a minute even on a
    // 2000-row bulk add; longer windows make the list feel frozen.
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const values = chunk
        .map(() => `(?, ?, 'normal', 3600, DATE_ADD(NOW(), INTERVAL FLOOR(RAND()*30) SECOND), ?, 0)`)
        .join(',');
      const params = [];
      for (const asin of chunk) {
        params.push(userId, asin, batchId);
      }
      await conn.query(
        `INSERT IGNORE INTO watchlists
           (user_id, asin, priority, interval_sec, next_scrape_at, batch_id, batch_done)
         VALUES ${values}`,
        params
      );
    }

    // ── Single bulk counter update on asin_master ──────────
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      await conn.query(
        `UPDATE asin_master SET watcher_count = watcher_count + 1 WHERE asin IN (${ph})`,
        chunk
      );
    }

    // ── ONE recalc of intervals for the whole user ────────
    // (the old per-row path did this N times → O(N²))
    const [sizeRows] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM watchlists WHERE user_id = ? AND priority != 'archived'`,
      [userId]
    );
    const total = sizeRows[0]?.cnt || 0;
    let normalInterval;
    if (total < 100) normalInterval = 3600;
    else if (total < 1000) normalInterval = 21600;
    else if (total < 5000) normalInterval = 43200;
    else normalInterval = 86400;
    await conn.query(
      `UPDATE watchlists
       SET interval_sec = CASE priority
         WHEN 'starred'  THEN 600
         WHEN 'normal'   THEN ?
         WHEN 'archived' THEN 86400
       END
       WHERE user_id = ?`,
      [normalInterval, userId]
    );

    await conn.commit();
    return { acceptedAsins: toInsert, duplicateAsins };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ── Scrape batches ─────────────────────────────────────────

export async function createBatch(userId, total) {
  const id = uuidv4();
  await query(
    `INSERT INTO scrape_batches (id, user_id, total) VALUES (?, ?, ?)`,
    [id, userId, total]
  );
  return id;
}

export async function getBatch(userId, batchId) {
  const rows = await query(
    `SELECT id, user_id, total, completed, failed, status, started_at, finished_at
     FROM scrape_batches
     WHERE id = ? AND user_id = ?`,
    [batchId, userId]
  );
  return rows[0] || null;
}

// Returns true exactly once per row — the first time a terminal scrape
// event lands for a row that belongs to a batch. Subsequent calls return
// false so re-scrapes don't double-count the batch counter.
export async function markBatchRowTerminal(userId, asin) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT batch_id, batch_done FROM watchlists
       WHERE user_id = ? AND asin = ? FOR UPDATE`,
      [userId, asin]
    );
    const row = rows[0];
    if (!row || !row.batch_id || row.batch_done) {
      await conn.commit();
      return null;
    }
    await conn.query(
      `UPDATE watchlists SET batch_done = 1 WHERE user_id = ? AND asin = ?`,
      [userId, asin]
    );
    await conn.commit();
    return { batchId: row.batch_id };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Increment completed or failed. Returns the updated batch row, with a
// boolean `justCompleted` set when THIS call was the one that flipped
// status from 'running' to 'done'. The caller uses that flag to decide
// whether to emit a single BATCH_COMPLETE WS message.
export async function incBatchCounter(batchId, kind) {
  const col = kind === 'failed' ? 'failed' : 'completed';
  await query(
    `UPDATE scrape_batches SET ${col} = ${col} + 1 WHERE id = ?`,
    [batchId]
  );
  const rows = await query(
    `SELECT id, user_id, total, completed, failed, status, started_at, finished_at
     FROM scrape_batches WHERE id = ?`,
    [batchId]
  );
  const b = rows[0];
  if (!b) return null;

  let justCompleted = false;
  if (b.status === 'running' && (b.completed + b.failed) >= b.total) {
    const result = await query(
      `UPDATE scrape_batches
       SET status = 'done', finished_at = NOW()
       WHERE id = ? AND status = 'running'`,
      [batchId]
    );
    if (result?.affectedRows > 0) {
      b.status = 'done';
      b.finished_at = new Date();
      justCompleted = true;
    }
  }
  return { ...b, justCompleted };
}

export async function getWatchlist(userId) {
  // Per-user view: every cached field comes from the user's own watchlist
  // row, not from a shared asin_master snapshot.
  const rows = await query(
    `SELECT
       w.asin,
       a.title,
       w.priority,
       w.interval_sec,
       w.next_scrape_at,
       w.last_scraped_at,
       w.last_price,
       w.last_points,
       w.last_marketplace_lowest,
       w.last_new_offer_count,
       w.last_delivery_time,
       w.last_error,
       w.last_error_at,
       w.scrape_failures,
       w.added_at,
       w.batch_id,
       w.batch_done
     FROM watchlists w
     JOIN asin_master a ON w.asin = a.asin
     WHERE w.user_id = ?
     ORDER BY w.added_at ASC`,
    [userId]
  );
  return rows;
}

// Returns the userIds watching this ASIN. Still used by some legacy
// notification paths but no longer used for scrape distribution.
export async function getWatchersForAsin(asin) {
  const rows = await query(
    `SELECT user_id FROM watchlists WHERE asin = ?`,
    [asin]
  );
  return rows;
}

// ── Observations (strictly per-user) ───────────────────────
//
// Every observation is owned by the user whose client scraped it.
// Cross-user reads are not allowed — Amazon serves personalized prices,
// so user A's scrape result is not a valid observation for user B.

export async function insertObservation(obs) {
  if (!obs.userId) throw new Error('insertObservation: userId is required');
  await query(
    `INSERT INTO observations
       (asin, observed_at, price, points, delivery_time,
        marketplace_lowest, new_offer_count, scraper_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [obs.asin, new Date(obs.scrapedAt || Date.now()), obs.price, obs.points,
     typeof obs.deliveryTime === 'object' ? JSON.stringify(obs.deliveryTime) : obs.deliveryTime,
     obs.marketplaceLowest, obs.newOfferCount, obs.userId]
  );
}

export async function getMovingAverage(userId, asin, days) {
  const rows = await query(
    `SELECT AVG(price) AS avg_price, COUNT(*) AS cnt
     FROM observations
     WHERE scraper_user_id = ?
       AND asin = ?
       AND observed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND price IS NOT NULL`,
    [userId, asin, days]
  );
  const row = rows[0];
  return {
    avgPrice: row?.avg_price ? parseFloat(row.avg_price) : null,
    count: parseInt(row?.cnt || '0', 10),
  };
}

export async function getPreviousOfferCount(userId, asin) {
  const rows = await query(
    `SELECT new_offer_count FROM observations
     WHERE scraper_user_id = ?
       AND asin = ?
       AND new_offer_count IS NOT NULL
     ORDER BY observed_at DESC LIMIT 1 OFFSET 1`,
    [userId, asin]
  );
  return rows[0]?.new_offer_count ?? null;
}

export async function getObservationsInRange(userId, asin, fromMs, toMs, limit = 10000) {
  const rows = await query(
    `SELECT observed_at, price, points, marketplace_lowest, new_offer_count
     FROM observations
     WHERE scraper_user_id = ?
       AND asin = ?
       AND observed_at BETWEEN ? AND ?
     ORDER BY observed_at ASC
     LIMIT ?`,
    [userId, asin, new Date(fromMs), new Date(toMs), limit]
  );
  return rows.map((r) => ({
    observedAt: new Date(r.observed_at).getTime(),
    price: r.price,
    points: r.points,
    marketplaceLowest: r.marketplace_lowest,
    newOfferCount: r.new_offer_count,
  }));
}

export async function getObservationSpan(userId, asin) {
  const rows = await query(
    `SELECT MIN(observed_at) AS first_at, MAX(observed_at) AS last_at, COUNT(*) AS cnt
     FROM observations
     WHERE scraper_user_id = ? AND asin = ?`,
    [userId, asin]
  );
  const row = rows[0];
  if (!row || !row.first_at) return { firstObservedAt: null, lastObservedAt: null, count: 0 };
  return {
    firstObservedAt: new Date(row.first_at).getTime(),
    lastObservedAt: new Date(row.last_at).getTime(),
    count: parseInt(row.cnt || '0', 10),
  };
}

// ── Conditions ─────────────────────────────────────────────

export async function createCondition(userId, cond) {
  const [result] = await pool.execute(
    `INSERT INTO conditions (user_id, asin, rule_type, rule_params, cooldown_sec)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, cond.asin || null, cond.type, JSON.stringify(cond.params), cond.cooldownSec || 3600]
  );
  const rows = await query('SELECT * FROM conditions WHERE id = ?', [result.insertId]);
  return rows[0];
}

// Per-user variant: only conditions belonging to one user, for one ASIN
// (or wildcard "all ASINs" conditions belonging to that user).
export async function getConditionsForUserAndAsin(userId, asin) {
  const rows = await query(
    `SELECT c.*, d.webhook_url FROM conditions c
     LEFT JOIN discord_webhooks d ON c.user_id = d.user_id
     WHERE c.user_id = ?
       AND (c.asin = ? OR c.asin IS NULL)
       AND c.enabled = 1`,
    [userId, asin]
  );
  return rows;
}

export async function getConditionsByAsin(asin) {
  const rows = await query(
    `SELECT c.*, d.webhook_url FROM conditions c
     LEFT JOIN discord_webhooks d ON c.user_id = d.user_id
     WHERE (c.asin = ? OR c.asin IS NULL) AND c.enabled = 1`,
    [asin]
  );
  return rows;
}

export async function getUserConditions(userId) {
  const rows = await query(
    'SELECT * FROM conditions WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

export async function deleteCondition(userId, conditionId) {
  await query('DELETE FROM conditions WHERE id = ? AND user_id = ?', [conditionId, userId]);
}

export async function markConditionFired(conditionId) {
  await query('UPDATE conditions SET last_fired_at = NOW() WHERE id = ?', [conditionId]);
}

// ── Discord webhooks ───────────────────────────────────────

export async function upsertDiscordWebhook(userId, webhookUrl) {
  await query(
    `INSERT INTO discord_webhooks (user_id, webhook_url) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE webhook_url = VALUES(webhook_url)`,
    [userId, webhookUrl]
  );
}

export async function getDiscordWebhook(userId) {
  const rows = await query('SELECT webhook_url FROM discord_webhooks WHERE user_id = ?', [userId]);
  return rows[0]?.webhook_url || null;
}

// ── Notifications ──────────────────────────────────────────

export async function insertNotification(notif) {
  await query(
    `INSERT INTO notification_log (user_id, asin, condition_id, price_at_trigger, moving_avg, discord_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [notif.userId, notif.asin, notif.conditionId, notif.price, notif.movingAvg, notif.discordStatus]
  );
}

// ── Selectors ──────────────────────────────────────────────

export async function getLatestSelectors() {
  const rows = await query('SELECT version, selectors FROM selector_config ORDER BY version DESC LIMIT 1');
  return rows[0] || null;
}

// ── Fairness ───────────────────────────────────────────────

export async function getRotationIndex(asin) {
  const rows = await query(
    'SELECT COALESCE(MIN(position), 0) AS idx FROM asin_watchers WHERE asin = ?',
    [asin]
  );
  return rows[0]?.idx || 0;
}

export default { query, queryRaw, migrate, pool };
