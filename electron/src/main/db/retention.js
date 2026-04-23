'use strict';

const { prepare, transaction, saveToDisk } = require('./sqlite');
const { RETENTION_FULL_DAYS, RETENTION_DAILY_DAYS } = require('../../shared/constants');

function runRetention() {
  const now = Date.now();
  const fullCutoffMs = now - RETENTION_FULL_DAYS * 86400000;
  const dailyCutoff  = new Date(now - RETENTION_DAILY_DAYS * 86400000)
    .toISOString().slice(0, 10);

  const tx = transaction(() => {
    // Step 1: aggregate old observations into daily averages.
    prepare(`
      INSERT OR REPLACE INTO observations_daily
        (asin, day_date, avg_price, min_price, max_price, avg_points, avg_mp_price, sample_count)
      SELECT
        asin,
        date(observed_at / 1000, 'unixepoch') AS day_date,
        AVG(price),
        MIN(price),
        MAX(price),
        AVG(points),
        AVG(mp_price),
        COUNT(*)
      FROM observations
      WHERE observed_at < ?
      GROUP BY asin, day_date
    `).run(fullCutoffMs);

    // Step 2: delete the aggregated raw observations.
    const deleted = prepare(
      'DELETE FROM observations WHERE observed_at < ?'
    ).run(fullCutoffMs);

    // Step 3: prune daily averages older than 180 days.
    const pruned = prepare(
      'DELETE FROM observations_daily WHERE day_date < ?'
    ).run(dailyCutoff);

    return { aggregated: deleted.changes, pruned: pruned.changes };
  });

  try {
    const result = tx();
    if (result.aggregated > 0 || result.pruned > 0) {
      console.log(
        `[retention] aggregated ${result.aggregated} old observations, ` +
        `pruned ${result.pruned} daily rows`
      );
      saveToDisk();
    }
  } catch (err) {
    console.error('[retention] failed:', err.message);
  }
}

let retentionTimer = null;
function startRetentionSchedule() {
  runRetention();
  retentionTimer = setInterval(runRetention, 3600000);
}

function stopRetentionSchedule() {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

module.exports = { runRetention, startRetentionSchedule, stopRetentionSchedule };
