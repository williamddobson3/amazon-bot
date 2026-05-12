'use strict';

const { getDb, prepare, transaction } = require('./sqlite');

// ── Products ────────────────────────────────────────────────

function addProducts(asins) {
  // Per spec: CSV imports must preserve their on-disk row order in the
  // viewer. The viewer sorts by added_at ASC, so the FIRST asin in
  // `asins` needs the smallest timestamp. We bump by +1 ms per entry
  // — sub-millisecond resolution isn't useful here and a 1 ms gap is
  // enough for SQLite's ORDER BY to keep the ordering stable.
  const base = Date.now();
  const tx = transaction((list) => {
    let count = 0;
    list.forEach((asin, i) => {
      const info = prepare(
        'INSERT OR IGNORE INTO products (asin, added_at) VALUES (?, ?)'
      ).run(asin, base + i);
      if (info.changes > 0) count++;
    });
    return count;
  });
  return tx(asins);
}

// Soft delete — moves products to trash. Observations/aggregates are
// preserved so a restore brings full history back. Use hardDeleteProducts
// to actually drop rows.
function softDeleteProducts(asins) {
  if (!asins || asins.length === 0) return 0;
  const now = Date.now();
  const tx = transaction((list) => {
    let n = 0;
    for (const asin of list) {
      const r = prepare(
        'UPDATE products SET trashed_at = ? WHERE asin = ? AND trashed_at IS NULL'
      ).run(now, asin);
      n += r.changes;
    }
    return n;
  });
  return tx(asins);
}

function restoreProducts(asins) {
  if (!asins || asins.length === 0) return 0;
  const tx = transaction((list) => {
    let n = 0;
    for (const asin of list) {
      const r = prepare(
        'UPDATE products SET trashed_at = NULL WHERE asin = ? AND trashed_at IS NOT NULL'
      ).run(asin);
      n += r.changes;
    }
    return n;
  });
  return tx(asins);
}

function hardDeleteProducts(asins) {
  if (!asins || asins.length === 0) return 0;
  const tx = transaction((list) => {
    let n = 0;
    for (const asin of list) {
      prepare('DELETE FROM observations WHERE asin = ?').run(asin);
      prepare('DELETE FROM observations_daily WHERE asin = ?').run(asin);
      prepare('DELETE FROM block_events WHERE final_url LIKE ?').run('%' + asin + '%');
      const r = prepare('DELETE FROM products WHERE asin = ?').run(asin);
      n += r.changes;
    }
    return n;
  });
  return tx(asins);
}

// Backwards-compat: existing UI calls removeProduct expecting it to
// move the product out of the active list. With trash semantics, that
// means soft-delete now. Hard-delete is reachable from the trash view.
function removeProduct(asin) {
  return softDeleteProducts([asin]);
}

function getProduct(asin) {
  return prepare('SELECT * FROM products WHERE asin = ?').get(asin);
}

// Returns active (non-trashed) products. Optional groupId filter:
// null = ALL active products; 0 = ungrouped only; >0 = that group.
function getAllProducts(opts = {}) {
  const groupId = opts.groupId == null ? null : Number(opts.groupId);
  if (groupId === null) {
    return prepare(
      'SELECT * FROM products WHERE trashed_at IS NULL ORDER BY added_at ASC'
    ).all();
  }
  if (groupId === 0) {
    return prepare(
      'SELECT * FROM products WHERE trashed_at IS NULL AND group_id IS NULL ORDER BY added_at ASC'
    ).all();
  }
  return prepare(
    'SELECT * FROM products WHERE trashed_at IS NULL AND group_id = ? ORDER BY added_at ASC'
  ).all(groupId);
}

function getTrashedProducts() {
  return prepare(
    'SELECT * FROM products WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC'
  ).all();
}

function getProductCount() {
  const row = prepare(
    'SELECT COUNT(*) AS cnt FROM products WHERE trashed_at IS NULL'
  ).get();
  return row ? row.cnt : 0;
}

function getTrashedProductCount() {
  const row = prepare(
    'SELECT COUNT(*) AS cnt FROM products WHERE trashed_at IS NOT NULL'
  ).get();
  return row ? row.cnt : 0;
}

function getActiveAsins() {
  return prepare(
    "SELECT asin FROM products WHERE priority != 'archived' AND trashed_at IS NULL"
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
    "SELECT asin FROM products WHERE cycle_seen = 0 AND priority != 'archived' AND trashed_at IS NULL"
  ).all().map((r) => r.asin);
}

// ── Groups ──────────────────────────────────────────────────

const GROUP_LIMIT = 20;  // matches client spec

function getAllGroups() {
  return prepare(`
    SELECT g.id, g.name, g.created_at,
           (SELECT COUNT(*) FROM products p
            WHERE p.group_id = g.id AND p.trashed_at IS NULL) AS member_count
    FROM groups g
    ORDER BY g.id ASC
  `).all();
}

function addGroup(name) {
  // Empty name is intentionally allowed: the v3 spec presents 20
  // pre-allocated group slots in the dropdown ("No.1..No.20"), and
  // unused slots persist as empty-named rows so they have stable ids
  // and counts.
  const trimmed = String(name || '').trim();
  const count = prepare('SELECT COUNT(*) AS cnt FROM groups').get().cnt;
  if (count >= GROUP_LIMIT) {
    throw new Error(`Group limit (${GROUP_LIMIT}) reached`);
  }
  const r = prepare(
    'INSERT INTO groups (name, created_at) VALUES (?, ?)'
  ).run(trimmed, Date.now());
  return r.lastInsertRowid;
}

// Ensure the groups table has at least `target` slots (default 20 per
// spec). Called once on app init so the dropdown / rename modal /
// per-row picker can safely assume 20 stable slots exist. Idempotent.
function ensureGroupSlots(target = GROUP_LIMIT) {
  const count = prepare('SELECT COUNT(*) AS cnt FROM groups').get().cnt;
  const need = Math.max(0, Math.min(GROUP_LIMIT, target) - count);
  if (need === 0) return { added: 0, total: count };
  const insert = prepare('INSERT INTO groups (name, created_at) VALUES (?, ?)');
  const tx = transaction((n) => {
    const now = Date.now();
    for (let i = 0; i < n; i++) insert.run('', now);
  });
  tx(need);
  return { added: need, total: count + need };
}

function renameGroup(id, name) {
  // Empty names are allowed — they reset the slot to its bare "No.X"
  // label in the dropdown without removing the slot.
  const trimmed = String(name || '').trim();
  prepare('UPDATE groups SET name = ? WHERE id = ?').run(trimmed, id);
}

function deleteGroup(id) {
  // v3 spec: 20 group slots are always present and stable. "Delete" is
  // really "clear" — un-assign every product in the slot and blank out
  // the name, but keep the row so its slot index stays put. (Removing
  // the row would shift slot numbering after the next ensureGroupSlots
  // call recreates it with a fresh autoincrement id.)
  const tx = transaction((gid) => {
    prepare('UPDATE products SET group_id = NULL WHERE group_id = ?').run(gid);
    prepare("UPDATE groups SET name = '' WHERE id = ?").run(gid);
  });
  tx(id);
}

function assignGroup(asins, groupId) {
  if (!asins || asins.length === 0) return 0;
  const gid = groupId == null ? null : Number(groupId);
  const tx = transaction((list) => {
    let n = 0;
    for (const asin of list) {
      const r = prepare(
        'UPDATE products SET group_id = ? WHERE asin = ? AND trashed_at IS NULL'
      ).run(gid, asin);
      n += r.changes;
    }
    return n;
  });
  return tx(asins);
}

// ── Viewer stats — moving averages of effective price (price - points)
//
// Five rolling windows: 1 / 7 / 30 / 90 / 180 days. Reads raw observations
// for windows up to RETENTION_FULL_DAYS (7) and combines with daily
// aggregates for longer windows. Returns absolute averages plus diffs
// vs the latest effective price for the spec's "(±N)" display.
function getProductStats(asin) {
  const product = getProduct(asin);
  if (!product) return null;
  const latestPrice  = product.last_price ?? null;
  const latestPoints = product.last_points ?? 0;
  const latestEffective = latestPrice == null ? null : (latestPrice - latestPoints);

  const now = Date.now();
  const windows = [1, 7, 30, 90, 180];
  const result = { latestEffective, otherSellersPrice: product.last_mp_price ?? null };

  for (const days of windows) {
    const cutoffMs = now - days * 86_400_000;
    let sum = 0, cnt = 0;

    if (days <= 7) {
      // Pure raw window — use observations directly.
      const row = prepare(`
        SELECT SUM(price - COALESCE(points, 0)) AS s, COUNT(*) AS c
        FROM observations
        WHERE asin = ? AND observed_at >= ? AND price IS NOT NULL
      `).get(asin, cutoffMs);
      sum = row.s || 0;
      cnt = row.c || 0;
    } else {
      // Mixed window — raw for last 7 days, daily aggregates for older.
      const sevenAgo = now - 7 * 86_400_000;
      const rawRow = prepare(`
        SELECT SUM(price - COALESCE(points, 0)) AS s, COUNT(*) AS c
        FROM observations
        WHERE asin = ? AND observed_at >= ? AND price IS NOT NULL
      `).get(asin, sevenAgo);
      sum += rawRow.s || 0;
      cnt += rawRow.c || 0;

      const fromStr = new Date(cutoffMs).toISOString().slice(0, 10);
      const toStr   = new Date(sevenAgo).toISOString().slice(0, 10);
      const dailyRow = prepare(`
        SELECT SUM(sample_count * (avg_price - COALESCE(avg_points, 0))) AS s,
               SUM(sample_count) AS c
        FROM observations_daily
        WHERE asin = ? AND day_date >= ? AND day_date < ?
              AND avg_price IS NOT NULL
      `).get(asin, fromStr, toStr);
      sum += dailyRow.s || 0;
      cnt += dailyRow.c || 0;
    }

    const avg = cnt > 0 ? sum / cnt : null;
    const diff = (avg != null && latestEffective != null) ? Math.round(avg - latestEffective) : null;
    result[`avg${days}d`]      = avg != null ? Math.round(avg) : null;
    result[`avg${days}dDiff`]  = diff;
  }

  // Other-sellers diff vs latest effective.
  if (result.otherSellersPrice != null && latestEffective != null) {
    result.otherSellersDiff = result.otherSellersPrice - latestEffective;
  } else {
    result.otherSellersDiff = null;
  }

  // All-time effective average — used as the last-resort fallback when
  // a windowed average has no data (per FNM spec: 「1日分のデータも溜
  // まっていない場合は、全監視データの平均価格を使用」).
  {
    const rawAll = prepare(`
      SELECT SUM(price - COALESCE(points, 0)) AS s, COUNT(*) AS c
      FROM observations
      WHERE asin = ? AND price IS NOT NULL
    `).get(asin);
    const dailyAll = prepare(`
      SELECT SUM(sample_count * (avg_price - COALESCE(avg_points, 0))) AS s,
             SUM(sample_count) AS c
      FROM observations_daily
      WHERE asin = ? AND avg_price IS NOT NULL
    `).get(asin);
    const sumAll = (rawAll.s || 0) + (dailyAll.s || 0);
    const cntAll = (rawAll.c || 0) + (dailyAll.c || 0);
    result.avgAll = cntAll > 0 ? Math.round(sumAll / cntAll) : null;
  }

  // ── 出品者数 (mp_count) rolling averages ─────────────────────
  // Same windowing strategy as price averages — raw for ≤7 days,
  // mixed (raw + daily aggregate) for longer windows. Required for
  // the v2 FNM filter pane which has separate 出品者数 range
  // controls for 現在 / 7日平均 / 30日平均 / 90日平均 / 180日平均.
  result.mpCountCurrent = product.last_mp_count ?? null;
  for (const days of [7, 30, 90, 180]) {
    const cutoffMs = now - days * 86_400_000;
    let sum = 0, cnt = 0;
    if (days <= 7) {
      const row = prepare(`
        SELECT SUM(mp_count) AS s, COUNT(mp_count) AS c
        FROM observations
        WHERE asin = ? AND observed_at >= ? AND mp_count IS NOT NULL
      `).get(asin, cutoffMs);
      sum = row.s || 0;
      cnt = row.c || 0;
    } else {
      const sevenAgo = now - 7 * 86_400_000;
      const rawRow = prepare(`
        SELECT SUM(mp_count) AS s, COUNT(mp_count) AS c
        FROM observations
        WHERE asin = ? AND observed_at >= ? AND mp_count IS NOT NULL
      `).get(asin, sevenAgo);
      sum += rawRow.s || 0;
      cnt += rawRow.c || 0;

      const fromStr = new Date(cutoffMs).toISOString().slice(0, 10);
      const toStr   = new Date(sevenAgo).toISOString().slice(0, 10);
      const dailyRow = prepare(`
        SELECT SUM(sample_count * avg_mp_count) AS s,
               SUM(CASE WHEN avg_mp_count IS NOT NULL THEN sample_count ELSE 0 END) AS c
        FROM observations_daily
        WHERE asin = ? AND day_date >= ? AND day_date < ?
      `).get(asin, fromStr, toStr);
      sum += dailyRow.s || 0;
      cnt += dailyRow.c || 0;
    }
    const avg = cnt > 0 ? sum / cnt : null;
    result[`mpCountAvg${days}d`] = avg != null ? Math.round(avg * 10) / 10 : null;
  }

  // 「実質BuyBox価格の瞬間下落率」用 — 1 個前の観測との比較。FNM
  // evaluator が stats.prevEffective を直接読む。null は観測が 1 件
  // しかないなど比較不能を意味する。
  result.prevEffective = getPreviousEffectivePrice(asin);

  return result;
}

// ── Observations ────────────────────────────────────────────

// 「他の出品価格」 (mp_price) は記録データに残さない仕様
// (v3 spec, 2026-05): データ容量節約 + 集計クエリ高速化のため、観測
// 記録は mp_price を常に NULL にする。products.last_mp_price は更新
// される (= 最新の "今" の値はビューアー列に出る) ので、現状値の
// 表示は維持される。チャート上の「他の出品価格」系列は新規データが
// 入らなくなるため、既存履歴が retention で消えるにつれて空になる。
function insertObservation(obs) {
  prepare(`
    INSERT INTO observations
      (asin, observed_at, price, points, delivery, image_url, mp_price, mp_count, mp_condition)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    obs.asin, obs.observedAt,
    obs.price ?? null, obs.points ?? null, obs.delivery ?? null,
    obs.imageUrl ?? null, obs.mpCount ?? null,
    obs.mpCondition ?? null
  );
}

function insertObservationsBatch(rows) {
  const tx = transaction((list) => {
    for (const obs of list) {
      prepare(`
        INSERT INTO observations
          (asin, observed_at, price, points, delivery, image_url, mp_price, mp_count, mp_condition)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        obs.asin, obs.observedAt,
        obs.price ?? null, obs.points ?? null, obs.delivery ?? null,
        obs.imageUrl ?? null, obs.mpCount ?? null,
        obs.mpCondition ?? null
      );
    }
  });
  tx(rows);
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
  // Spec: 「全期間」グラフ表示は最古〜最新データの実時刻を使う。
  // We must look at both raw `observations` (last ~7 days per retention)
  // AND `observations_daily` (older aggregates) — otherwise the span
  // would shrink to only the retention window for any product older
  // than a week.
  const obs = prepare(`
    SELECT MIN(observed_at) AS firstAt, MAX(observed_at) AS lastAt, COUNT(*) AS cnt
    FROM observations WHERE asin = ?
  `).get(asin);
  const daily = prepare(`
    SELECT MIN(day_date) AS firstDay, MAX(day_date) AS lastDay, SUM(sample_count) AS cnt
    FROM observations_daily WHERE asin = ?
  `).get(asin);

  let firstAt = obs.firstAt;
  let lastAt  = obs.lastAt;
  if (daily.firstDay) {
    const dailyFirstMs = Date.parse(daily.firstDay + 'T00:00:00Z');
    if (firstAt == null || dailyFirstMs < firstAt) firstAt = dailyFirstMs;
  }
  if (daily.lastDay) {
    const dailyLastMs = Date.parse(daily.lastDay + 'T23:59:59Z');
    if (lastAt == null || dailyLastMs > lastAt) lastAt = dailyLastMs;
  }
  const cnt = (obs.cnt || 0) + (daily.cnt || 0);
  return { firstAt, lastAt, cnt };
}

// Sliding-window rolling average. O(n) over a sorted-by-time series.
// Returns one output point per input point with v = mean of all values
// whose timestamp is in (input.t − windowDays, input.t]. Skips inputs
// where v is null.
function rollingAvg(points, windowDays) {
  const window = windowDays * 86_400_000;
  const out = [];
  let sum = 0, count = 0, leftIdx = 0;
  for (let r = 0; r < points.length; r++) {
    const p = points[r];
    if (p.v == null) continue;
    sum += p.v;
    count++;
    while (leftIdx < r) {
      const left = points[leftIdx];
      if (left.v != null && (p.t - left.t) > window) {
        sum -= left.v;
        count--;
        leftIdx++;
      } else if (left.v == null) {
        leftIdx++;
      } else {
        break;
      }
    }
    out.push({ t: p.t, v: count > 0 ? sum / count : null });
  }
  return out;
}

// All 9 series for the monitoring-graph modal. Fetches a wider time
// window than the user's display range so rolling averages have
// proper lookback (180-day average needs 180 days of data before the
// chart's start). Then trims each series to the display window.
function getMonitoringChartData(asin, fromMs, toMs) {
  const lookback = 180 * 86_400_000;
  const data = getChartData(asin, fromMs - lookback, toMs);

  const buyBox       = [];
  const points       = [];
  const effective    = [];
  const otherSellers = [];
  const sellerCount  = [];

  for (const d of data) {
    if (d.price != null) {
      buyBox.push({ t: d.t, v: d.price });
      effective.push({ t: d.t, v: d.price - (d.points || 0) });
    }
    if (d.points  != null) points.push({       t: d.t, v: d.points });
    if (d.mpPrice != null) otherSellers.push({ t: d.t, v: d.mpPrice });
    if (d.mpCount != null) sellerCount.push({  t: d.t, v: d.mpCount });
  }

  const trim = (arr) => arr.filter((p) => p.t >= fromMs);
  return {
    buyBox:       trim(buyBox),
    points:       trim(points),
    effective:    trim(effective),
    avg1d:        trim(rollingAvg(effective, 1)),
    avg7d:        trim(rollingAvg(effective, 7)),
    avg30d:       trim(rollingAvg(effective, 30)),
    avg90d:       trim(rollingAvg(effective, 90)),
    avg180d:      trim(rollingAvg(effective, 180)),
    otherSellers: trim(otherSellers),
    sellerCount:  trim(sellerCount),
  };
}

// Compact effective-price series for the per-row sparkline (replaces
// the external Keepa image). Returns thinned [{t, v}] points where
// v = price − points. Same data source as the chart modal but only
// one series and pre-projected to the value the cell shows.
function getSparklineSeries(asin, days = 30) {
  const now = Date.now();
  // days === null → 全期間 (renderer の "全期間" 選択時に渡される)。
  // 0 を fromMs にすれば observations / observations_daily の最古行
  // から取れるので「全データ」を意味する特別値として扱う。
  const fromMs = (days == null) ? 0 : now - days * 86_400_000;
  const data = getChartData(asin, fromMs, now);
  const out = [];
  for (const d of data) {
    if (d.price == null) continue;
    out.push({ t: d.t, v: d.price - (d.points || 0) });
  }
  // Thin: drop interior points where 3 consecutive values are equal.
  // Keeps endpoints of flat runs so the line shape is preserved.
  if (out.length < 3) return out;
  const thinned = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    if (!(out[i - 1].v === out[i].v && out[i].v === out[i + 1].v)) {
      thinned.push(out[i]);
    }
  }
  thinned.push(out[out.length - 1]);
  return thinned;
}

// Fetch a unified time series for the chart view. Merges raw observations
// (days 0–7) with daily aggregates (days 8–180), sorted by timestamp.
// Daily rows carry the midnight-UTC of their day as the timestamp.
function getChartData(asin, fromMs, toMs) {
  const out = [];

  const raw = prepare(`
    SELECT observed_at AS t,
           price, points,
           mp_price AS mpPrice, mp_count AS mpCount
    FROM observations
    WHERE asin = ? AND observed_at BETWEEN ? AND ?
    ORDER BY observed_at ASC
  `).all(asin, fromMs, toMs);
  for (const r of raw) out.push(r);

  // Convert fromMs/toMs to YYYY-MM-DD for the TEXT day_date column.
  const fromStr = new Date(fromMs).toISOString().slice(0, 10);
  const toStr   = new Date(toMs).toISOString().slice(0, 10);
  const daily = prepare(`
    SELECT day_date, avg_price, avg_points, avg_mp_price, avg_mp_count
    FROM observations_daily
    WHERE asin = ? AND day_date BETWEEN ? AND ?
    ORDER BY day_date ASC
  `).all(asin, fromStr, toStr);
  for (const d of daily) {
    out.push({
      t:       Date.parse(d.day_date + 'T00:00:00Z'),
      price:   d.avg_price   != null ? Math.round(d.avg_price)   : null,
      points:  d.avg_points  != null ? Math.round(d.avg_points)  : null,
      mpPrice: d.avg_mp_price!= null ? Math.round(d.avg_mp_price): null,
      mpCount: d.avg_mp_count!= null ? Math.round(d.avg_mp_count): null,
    });
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

// (getMovingAverage / getPreviousOfferCount removed — they were only
// consumed by the deleted legacy condition evaluator.)

// 瞬間下落率の比較用に「1 個前の実質価格 (price − points)」を返す。
// 仕様: (1個前の監視価格 − 最新価格) ÷ 1個前の監視価格 × 100
// "1個前" = 最新観測の直前の観測値。観測が 1 件しかなければ null。
function getPreviousEffectivePrice(asin) {
  const row = prepare(`
    SELECT (price - COALESCE(points, 0)) AS effective
    FROM observations
    WHERE asin = ? AND price IS NOT NULL
    ORDER BY observed_at DESC LIMIT 1 OFFSET 1
  `).get(asin);
  return row && row.effective != null ? Math.round(row.effective) : null;
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

// ── Block events (WAF telemetry) ────────────────────────────

function insertBlockEvent(e) {
  prepare(`
    INSERT INTO block_events
      (occurred_at, block_type, source, streak, url_len, final_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    e.type || 'UNKNOWN',
    e.source || null,
    e.streak || 0,
    e.urlLen || 0,
    e.finalUrl || null
  );
}

function getRecentBlockEvents(limit = 50) {
  return prepare(
    'SELECT * FROM block_events ORDER BY occurred_at DESC LIMIT ?'
  ).all(limit);
}

function getBlockEventCountSince(sinceMs) {
  const row = prepare(
    'SELECT COUNT(*) AS cnt FROM block_events WHERE occurred_at >= ?'
  ).get(sinceMs);
  return row ? row.cnt : 0;
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
}

module.exports = {
  addProducts,
  removeProduct,
  softDeleteProducts,
  restoreProducts,
  hardDeleteProducts,
  getProduct,
  getAllProducts,
  getTrashedProducts,
  getProductCount,
  getTrashedProductCount,
  getActiveAsins,
  updateProductAfterScrape,
  markProductError,
  resetCycleSeen,
  getUnseenAsins,
  getAllGroups,
  addGroup,
  ensureGroupSlots,
  renameGroup,
  deleteGroup,
  assignGroup,
  getProductStats,
  insertObservation,
  insertObservationsBatch,
  getObservationsInRange,
  getObservationSpan,
  getChartData,
  getSparklineSeries,
  getMonitoringChartData,
  insertNotification,
  getRecentNotifications,
  insertBlockEvent,
  getRecentBlockEvents,
  getBlockEventCountSince,
  getSetting,
  setSetting,
};
