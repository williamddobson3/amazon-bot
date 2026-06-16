'use strict';

const { prepare, transaction } = require('./sqlite');
const {
  RETENTION_FULL_DAYS,
  RETENTION_DAILY_DAYS,
  RETENTION_MP_COUNT_DAYS,
} = require('../../shared/constants');

function runRetention() {
  const now = Date.now();
  const fullCutoffMs = now - RETENTION_FULL_DAYS * 86400000;
  const dailyCutoff  = new Date(now - RETENTION_DAILY_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const mpCountCutoff = new Date(now - RETENTION_MP_COUNT_DAYS * 86400000)
    .toISOString().slice(0, 10);

  const tx = transaction(() => {
    // Step 1: aggregate old observations into daily averages.
    // avg_mp_price は v3 仕様で 「他の出品価格は記録データに残さない」
    // ため常に NULL を入れる。observations.mp_price 自体も既に
    // NULL で記録されるようになったので AVG(mp_price) も NULL に
    // なるが、明示的に NULL を入れることで意図を明確化する。
    //
    // 2026-06 spec 追加:
    //   - min_effective_price: その日の最低実質価格 (= MIN(price - points + shipping))
    //   - avg_shipping_fee:    送料の平均 (long-window avg で利用)
    prepare(`
      INSERT OR REPLACE INTO observations_daily
        (asin, day_date, avg_price, min_price, max_price, avg_points, avg_mp_price, avg_mp_count, sample_count,
         min_effective_price, avg_shipping_fee)
      SELECT
        asin,
        date(observed_at / 1000, 'unixepoch') AS day_date,
        AVG(price),
        MIN(price),
        MAX(price),
        AVG(points),
        NULL,
        AVG(mp_count),
        COUNT(*),
        MIN(price - COALESCE(points, 0) + COALESCE(shipping_fee, 0)),
        AVG(shipping_fee)
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

    // Step 4 (2026-06 client spec): 30 日より古い出品者数を NULL 化。
    //   - raw observations では 30 日以内に既に集計済みなので影響ほぼなし
    //     (= 7 日 retention で既に消えている)。
    //   - 日次集計 observations_daily.avg_mp_count はここで明示 NULL 化。
    // データ量削減 + チャート出品者数表示の打ち切り (30 日) を実現。
    const mpPruned = prepare(
      'UPDATE observations_daily SET avg_mp_count = NULL ' +
      'WHERE day_date < ? AND avg_mp_count IS NOT NULL'
    ).run(mpCountCutoff);

    // Step 5 (2026-06 spec 項目14/15): Ama本体価格履歴の保持期間プルーニング。
    // 出品割合は直近30日しか参照しないので daily と同じ保持窓で十分。テーブル
    // 未作成の古い DB でも落ちないよう try で保護。
    let amzPruned = { changes: 0 };
    try {
      amzPruned = prepare(
        'DELETE FROM amazon_price_history WHERE observed_at < ?'
      ).run(fullCutoffMs > 0 ? (now - RETENTION_DAILY_DAYS * 86400000) : 0);
    } catch { /* テーブル未作成 → スキップ */ }

    return {
      aggregated: deleted.changes,
      pruned:     pruned.changes,
      mpPruned:   mpPruned.changes,
      amzPruned:  amzPruned.changes,
    };
  });

  try {
    const result = tx();
    if (result.aggregated > 0 || result.pruned > 0 || result.mpPruned > 0 || result.amzPruned > 0) {
      console.log(
        `[retention] aggregated ${result.aggregated} old observations, ` +
        `pruned ${result.pruned} daily rows, ` +
        `cleared ${result.mpPruned} old mp_count entries, ` +
        `pruned ${result.amzPruned} old Amazon-price points`
      );
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
