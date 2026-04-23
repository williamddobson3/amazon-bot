'use strict';

const { getDb, prepare, transaction, saveToDisk } = require('./sqlite');

// ── Products ────────────────────────────────────────────────

function addProducts(asins) {
  const now = Date.now();
  const tx = transaction((list) => {
    let count = 0;
    for (const asin of list) {
      const info = prepare(
        'INSERT OR IGNORE INTO products (asin, added_at) VALUES (?, ?)'
      ).run(asin, now);
      if (info.changes > 0) count++;
    }
    return count;
  });
  const result = tx(asins);
  saveToDisk();
  return result;
}

function removeProduct(asin) {
  prepare('DELETE FROM products WHERE asin = ?').run(asin);
  prepare('DELETE FROM observations WHERE asin = ?').run(asin);
  prepare('DELETE FROM observations_daily WHERE asin = ?').run(asin);
  saveToDisk();
}

function getProduct(asin) {
  return prepare('SELECT * FROM products WHERE asin = ?').get(asin);
}

function getAllProducts() {
  return prepare('SELECT * FROM products ORDER BY added_at ASC').all();
}

function getProductCount() {
  const row = prepare('SELECT COUNT(*) AS cnt FROM products').get();
  return row ? row.cnt : 0;
}

function getActiveAsins() {
  return prepare(
    "SELECT asin FROM products WHERE priority != 'archived'"
  ).all().map((r) => r.asin);
}

function updateProductAfterScrape(data) {
  prepare(`
    UPDATE products SET
      title             = COALESCE(?, title),
      image_url         = COALESCE(?, image_url),
      last_price        = ?,
      last_points       = ?,
      last_delivery     = ?,
      last_mp_price     = ?,
      last_mp_count     = ?,
      last_mp_condition = ?,
      last_observed_at  = ?,
      last_error        = NULL,
      last_error_at     = NULL,
      scrape_failures   = 0,
      cycle_seen        = 1
    WHERE asin = ?
  `).run(
    data.title || null,
    data.imageUrl || null,
    data.price ?? null,
    data.points ?? null,
    data.delivery ?? null,
    data.mpPrice ?? null,
    data.mpCount ?? null,
    data.mpCondition ?? null,
    data.observedAt,
    data.asin
  );
}

function markProductError(asin, error) {
  prepare(`
    UPDATE products SET
      last_error      = ?,
      last_error_at   = ?,
      scrape_failures = scrape_failures + 1
    WHERE asin = ?
  `).run(error, Date.now(), asin);
}

function resetCycleSeen() {
  prepare('UPDATE products SET cycle_seen = 0').run();
}

function getUnseenAsins() {
  return prepare(
    "SELECT asin FROM products WHERE cycle_seen = 0 AND priority != 'archived'"
  ).all().map((r) => r.asin);
}

// ── Observations ────────────────────────────────────────────

function insertObservation(obs) {
  prepare(`
    INSERT INTO observations
      (asin, observed_at, price, points, delivery, image_url, mp_price, mp_count, mp_condition)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    obs.asin, obs.observedAt,
    obs.price ?? null, obs.points ?? null, obs.delivery ?? null,
    obs.imageUrl ?? null, obs.mpPrice ?? null, obs.mpCount ?? null,
    obs.mpCondition ?? null
  );
}

function insertObservationsBatch(rows) {
  const tx = transaction((list) => {
    for (const obs of list) {
      prepare(`
        INSERT INTO observations
          (asin, observed_at, price, points, delivery, image_url, mp_price, mp_count, mp_condition)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        obs.asin, obs.observedAt,
        obs.price ?? null, obs.points ?? null, obs.delivery ?? null,
        obs.imageUrl ?? null, obs.mpPrice ?? null, obs.mpCount ?? null,
        obs.mpCondition ?? null
      );
    }
  });
  tx(rows);
  // Don't saveToDisk here — the auto-save handles it every 10s.
  // Calling saveToDisk on every batch (every ~6s per page) would
  // serialize the entire DB to disk too often.
}

function getObservationsInRange(asin, fromMs, toMs) {
  return prepare(`
    SELECT observed_at AS observedAt, price, points, delivery,
           mp_price AS mpPrice, mp_count AS mpCount
    FROM observations
    WHERE asin = ? AND observed_at BETWEEN ? AND ?
    ORDER BY observed_at ASC
  `).all(asin, fromMs, toMs);
}

function getObservationSpan(asin) {
  return prepare(`
    SELECT MIN(observed_at) AS firstAt, MAX(observed_at) AS lastAt, COUNT(*) AS cnt
    FROM observations WHERE asin = ?
  `).get(asin);
}

function getMovingAverage(asin, days) {
  const sinceMs = Date.now() - days * 86400000;
  return prepare(`
    SELECT AVG(price) AS avgPrice, COUNT(*) AS cnt
    FROM observations
    WHERE asin = ? AND observed_at >= ? AND price IS NOT NULL
  `).get(asin, sinceMs);
}

function getPreviousOfferCount(asin) {
  const row = prepare(`
    SELECT mp_count FROM observations
    WHERE asin = ? AND mp_count IS NOT NULL
    ORDER BY observed_at DESC LIMIT 1 OFFSET 1
  `).get(asin);
  return row?.mp_count ?? null;
}

// ── Conditions ──────────────────────────────────────────────

function getAllConditions() {
  return prepare('SELECT * FROM conditions ORDER BY id DESC').all();
}

function getConditionsForAsin(asin) {
  return prepare(
    'SELECT * FROM conditions WHERE enabled = 1 AND (asin = ? OR asin IS NULL)'
  ).all(asin);
}

function addCondition(cond) {
  const info = prepare(`
    INSERT INTO conditions (asin, rule_type, rule_params, cooldown_sec)
    VALUES (?, ?, ?, ?)
  `).run(cond.asin || null, cond.ruleType, JSON.stringify(cond.params), cond.cooldownSec || 3600);
  return info.lastInsertRowid;
}

function deleteCondition(id) {
  prepare('DELETE FROM conditions WHERE id = ?').run(id);
  saveToDisk();
}

function markConditionFired(id) {
  prepare('UPDATE conditions SET last_fired = ? WHERE id = ?').run(Date.now(), id);
}

// ── Notifications ───────────────────────────────────────────

function insertNotification(n) {
  prepare(`
    INSERT INTO notifications (asin, condition_id, price, mp_price, discord_sent, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(n.asin, n.conditionId, n.price ?? null, n.mpPrice ?? null, n.discordSent ? 1 : 0, Date.now());
}

function getRecentNotifications(limit = 50) {
  return prepare(
    'SELECT * FROM notifications ORDER BY sent_at DESC LIMIT ?'
  ).all(limit);
}

// ── Settings ────────────────────────────────────────────────

function getSetting(key) {
  const row = prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run(key, value);
  saveToDisk();
}

module.exports = {
  addProducts,
  removeProduct,
  getProduct,
  getAllProducts,
  getProductCount,
  getActiveAsins,
  updateProductAfterScrape,
  markProductError,
  resetCycleSeen,
  getUnseenAsins,
  insertObservation,
  insertObservationsBatch,
  getObservationsInRange,
  getObservationSpan,
  getMovingAverage,
  getPreviousOfferCount,
  getAllConditions,
  getConditionsForAsin,
  addCondition,
  deleteCondition,
  markConditionFired,
  insertNotification,
  getRecentNotifications,
  getSetting,
  setSetting,
};
