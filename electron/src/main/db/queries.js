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

// Keepa CSV インポート (2026-06 client spec 項目7 + ①)。
// ASIN に加えて、インポート直値 (出品者数 / BuyBox 90・180日平均 / 月間
// 販売数 / ランキング / 30日変動) と、計算入力 (サイズ・重量・カテゴリ・
// 紹介料) と、算出済みの 4 値 (サイズ区分 / Amazon手数料 / FBA手数料 /
// 在庫保管料) を一括で保存する。手数料計算は呼び出し側 (ipc-handlers) が
// fee-calc で済ませた上で各 record に詰めて渡す。
//
// 新規 ASIN は INSERT (added_at を 1ms ずつ繰り上げて CSV 行順を維持)、
// 既存 ASIN は imp_* / 計算結果のみ UPDATE する (= 再インポートで最新の
// Keepa 値に更新される)。戻り値 added は新規挿入できた件数。
function importProductsWithKeepaData(records, source) {
  if (!Array.isArray(records) || records.length === 0) {
    return { added: 0, total: 0 };
  }
  const base = Date.now();
  const histSource = source === 'keepa' ? 'keepa' : 'csv';   // Ama本体価格履歴の出所 (診断用)
  const insert = prepare(
    'INSERT OR IGNORE INTO products (asin, added_at) VALUES (?, ?)'
  );
  const update = prepare(`
    UPDATE products SET
      imp_sellers           = ?,
      imp_buybox_current    = ?,
      imp_buybox_30d        = ?,
      imp_buybox_90d        = ?,
      imp_buybox_180d       = ?,
      -- Ama本体価格 (項目14): 「Amazon: 現在価格」列が CSV に存在する時のみ上書き
      -- (空白なら NULL で上書き = 旧値を残さない)。列自体が無い CSV (hasAmazon=0) は
      -- 既存値を維持する (列順不同・列の有無が柔軟、項目25 の方針と整合)。
      imp_amazon_current    = CASE WHEN ? = 1 THEN ? ELSE imp_amazon_current END,
      imp_monthly_sales     = ?,
      imp_rank              = ?,
      imp_rank_drop_30d     = ?,
      imp_root_category     = ?,
      imp_sub_category      = ?,
      imp_category_tree     = ?,
      imp_brand             = ?,
      imp_fba_pickpack      = ?,
      imp_referral_pct      = ?,
      imp_referral_buybox   = ?,
      imp_pkg_length        = ?,
      imp_pkg_width         = ?,
      imp_pkg_height        = ?,
      imp_pkg_weight        = ?,
      imp_item_length       = ?,
      imp_item_width        = ?,
      imp_item_height       = ?,
      imp_item_weight       = ?,
      size_kubun            = ?,
      amazon_fee            = ?,
      fba_fee               = ?,
      inventory_storage_fee = ?,
      imported_at           = ?,
      -- 表示シード (2026-06 spec 項目19/20/21 で改定)。プレースホルダ = seedValue:
      --   CSV : 「Buy Box: 現在価格」、無ければ「新品: 現在価格」(項目20)。Keepa: 常に NULL (項目19)。
      -- 「BuyBox価格」(last_price) が空 (NULL) の時だけシードし、ポイント・送料は 0 にする。
      -- 既に監視値が入っている (last_price NOT NULL) 商品は 4 列とも一切触らない (項目21:
      -- 最新価格は監視値を最優先)。SQLite は SET 右辺を更新前の行で評価するので、3 句とも
      -- 「更新前の last_price」を参照でき整合する。シードは一時的: 次回クロールがライブ値に戻す。
      last_price            = CASE WHEN last_price IS NULL THEN COALESCE(?, last_price) ELSE last_price END,
      last_points           = CASE WHEN last_price IS NULL AND ? IS NOT NULL THEN 0 ELSE last_points END,
      last_shipping_fee     = CASE WHEN last_price IS NULL AND ? IS NOT NULL THEN 0 ELSE last_shipping_fee END
    WHERE asin = ?
  `);
  // Ama本体価格 履歴 (項目14/15): CSV に「Amazon: 現在価格」列がある行のみ 1 点記録。
  const insertAmzHist = prepare(
    'INSERT INTO amazon_price_history (asin, observed_at, price, source) VALUES (?, ?, ?, ?)'
  );
  const tx = transaction((list) => {
    let added = 0;
    list.forEach((rec, i) => {
      const info = insert.run(rec.asin, base + i);
      if (info.changes > 0) added++;
      // Amazon列の有無: CSV にその列があれば 1 (空白でも 1)。amazonCurrent は値 or null。
      const hasAmazon = rec.hasAmazonField ? 1 : 0;
      const amazonCurrent = rec.amazonCurrent ?? null;
      // 表示シード値 (項目19/20/21):
      //   CSV  → 「Buy Box: 現在価格」優先、無ければ「新品: 現在価格」(項目20)。
      //   Keepa → 常に null (項目19: 最新価格は監視クロールから取得する前提)。
      // last_price が空の商品にのみシードされる (UPDATE 側の CASE で制御)。
      const seedValue = (histSource === 'keepa')
        ? null
        : (rec.displayBuyboxCurrent ?? rec.newCurrentPrice ?? null);
      update.run(
        rec.sellers ?? null,
        rec.buyboxCurrent ?? null,
        rec.buybox30d ?? null,
        rec.buybox90d ?? null,
        rec.buybox180d ?? null,
        hasAmazon,
        amazonCurrent,
        rec.monthlySales ?? null,
        rec.rank ?? null,
        rec.rankDrop30d ?? null,
        rec.rootCategory ?? null,
        rec.subCategory ?? null,
        rec.categoryTree ?? null,
        rec.brand ?? null,
        rec.fbaPickpack ?? null,
        rec.referralPct ?? null,
        rec.referralBuybox ?? null,
        rec.pkgLength ?? null,
        rec.pkgWidth ?? null,
        rec.pkgHeight ?? null,
        rec.pkgWeight ?? null,
        rec.itemLength ?? null,
        rec.itemWidth ?? null,
        rec.itemHeight ?? null,
        rec.itemWeight ?? null,
        rec.sizeKubun ?? null,
        rec.amazonFee ?? null,
        rec.fbaFee ?? null,
        rec.inventoryStorageFee ?? null,
        base,
        // 表示シード (項目19/20/21): last_price / last_points / last_shipping_fee の
        // CASE 用。3 つとも seedValue を渡す (CSV=BuyBox→新品, Keepa=null)。
        seedValue,
        seedValue,
        seedValue,
        rec.asin,
      );
      // Ama本体価格 監視点 (項目14/15): Amazon列がある CSV 行のみ記録。
      // 列ごとに base+i (各行 1ms ずらし) を観測時刻にする。
      if (hasAmazon) {
        insertAmzHist.run(rec.asin, base + i, amazonCurrent, histSource);
      }
    });
    return added;
  });
  const added = tx(records);
  // 再インポートで imp_buybox_90d/180d 等 (統計の入力) が変わり得るので、
  // 該当商品の事前計算済み統計を無効化する (次回読取時に再計算される)。
  try { clearProductStats(records.map((r) => r.asin)); } catch { /* best-effort */ }
  return { added, total: records.length };
}

// Keepa API 定期更新 (2026-06 spec 項目8) — 取り込みが最も古い、または
// 未取込のアクティブ商品から limit 件返す。staleBeforeMs より新しく取り込んだ
// ものは対象外 (= 更新サイクル内で同じ商品を二重取得しない)。NULL(未取込) を
// 先頭、その後 imported_at の昇順 (古い順)。
function getAsinsForKeepaRefresh(limit, staleBeforeMs) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 1));
  return prepare(`
    SELECT asin FROM products
    WHERE trashed_at IS NULL
      AND (imported_at IS NULL OR imported_at < ?)
    ORDER BY (imported_at IS NULL) DESC, imported_at ASC
    LIMIT ?
  `).all(staleBeforeMs, lim).map((r) => r.asin);
}

// Keepa が結果を返さなかった (廃番 ASIN 等) 場合も imported_at を更新して、
// 同じ ASIN を毎ティック取得し続ける無限リトライを防ぐ。
function markKeepaRefreshed(asins, ts) {
  if (!asins || asins.length === 0) return 0;
  const stamp = ts || Date.now();
  const tx = transaction((list) => {
    let n = 0;
    for (const asin of list) {
      n += prepare('UPDATE products SET imported_at = ? WHERE asin = ?').run(stamp, asin).changes;
    }
    return n;
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
      // ゴミ箱→監視リスト復帰時は通知カウントを 0 にリセットしてカウントし直す
      // (2026-06 spec 項目29)。最新通知日時もクリア。
      const r = prepare(
        'UPDATE products SET trashed_at = NULL, notify_hit_count = 0, last_notified_at = NULL ' +
        'WHERE asin = ? AND trashed_at IS NOT NULL'
      ).run(asin);
      n += r.changes;
    }
    return n;
  });
  return tx(asins);
}

// 通知が確定して送信キューに入った時に呼ぶ (2026-06 spec 項目29)。
// 通知ヒット総回数を +1、最新通知日時を更新する。FNM/個別どちらの通知でも数える。
function recordNotificationHit(asin, ts) {
  if (!asin) return;
  prepare(
    'UPDATE products SET notify_hit_count = COALESCE(notify_hit_count, 0) + 1, last_notified_at = ? WHERE asin = ?'
  ).run(ts || Date.now(), asin);
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
      title              = COALESCE(?, title),
      image_url          = COALESCE(?, image_url),
      last_price         = ?,
      last_points        = ?,
      last_delivery      = ?,
      last_mp_price      = ?,
      last_mp_count      = ?,
      last_mp_condition  = ?,
      -- 月間販売数 (2026-06 spec): スクレイプで取得できなかった (NULL) 場合は
      -- 直近で取得できていた値を維持する。途中から取れなくなっても最後の
      -- 良い値を表示し続け、フィルタ/通知計算でも使えるようにするため。
      last_monthly_sales = COALESCE(?, last_monthly_sales),
      last_shipping_fee  = ?,
      -- Amazon販売手数料は「最新BuyBox価格 × 最新紹介料% × 1.1」で価格更新の
      -- たびに再計算する (2026-06 client要望)。再計算値が null (紹介料%/価格が
      -- 欠落) のときはインポート時の確定値を維持する (COALESCE)。
      amazon_fee         = COALESCE(?, amazon_fee),
      last_observed_at   = ?,
      last_error         = NULL,
      last_error_at      = NULL,
      scrape_failures    = 0,
      cycle_seen         = 1
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
    data.monthlySales ?? null,
    data.shippingFee ?? null,
    data.amazonFee ?? null,
    data.observedAt,
    data.asin
  );
}

// 監視クロールでの Amazon 販売手数料 再計算用に、ASIN → 紹介料%
// (imp_referral_pct) をまとめて引く (2026-06 client要望)。欠落 ASIN は null。
function getReferralPctMap(asins) {
  const out = {};
  if (!asins || asins.length === 0) return out;
  const stmt = prepare('SELECT imp_referral_pct FROM products WHERE asin = ?');
  for (const a of asins) {
    const row = stmt.get(a);
    out[a] = row ? row.imp_referral_pct : null;
  }
  return out;
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

// 個別設定価格 (2026-05): 商品ごとの「最新実質BuyBox価格 < この値」で
// 通知発火する閾値。null / undefined / NaN は「未設定 = NULL」として保存。
function setNotifyPrice(asin, price) {
  let val = null;
  if (price != null && price !== '') {
    const n = Math.round(Number(price));
    if (Number.isFinite(n) && n > 0) val = n;
  }
  prepare('UPDATE products SET notify_price = ? WHERE asin = ?').run(val, asin);
  return val;
}

// ── Viewer stats — moving averages of effective price.
//   実質価格の式 = price − COALESCE(points, 0) + COALESCE(shipping_fee, 0)
// BuyBox 価格は Amazon 表示そのままの基本価格を保存し、送料は別カラム
// `shipping_fee` に独立して保持する仕様 (2026-05)。したがって実質価格
// 算出時に送料を加算する必要がある。古い observations 行で shipping_fee
// が NULL の場合は 0 として扱う (= 旧データは送料抜きの計算のまま)。
// observations_daily 側は shipping の集計列を持たないため、8日以上前の
// 日次集計は引き続き送料抜き — 集計列の追加は別タスク。
//
// Five rolling windows: 1 / 7 / 30 / 90 / 180 days. Reads raw observations
// for windows up to RETENTION_FULL_DAYS (7) and combines with daily
// aggregates for longer windows. Returns absolute averages plus diffs
// vs the latest effective price for the spec's "(±N)" display.
function getProductStats(asin, nowMs) {
  const product = getProduct(asin);
  if (!product) return null;
  const latestPrice    = product.last_price ?? null;
  const latestPoints   = product.last_points ?? 0;
  const latestShipping = product.last_shipping_fee ?? 0;
  const latestEffective = latestPrice == null
    ? null
    : (latestPrice - latestPoints + latestShipping);

  // nowMs を渡せるのは検証/一括処理で時刻基準を揃えるため。通常は現在時刻。
  const now = nowMs || Date.now();
  const windows = [1, 7, 30, 90, 180];
  const result = { latestEffective, otherSellersPrice: product.last_mp_price ?? null };

  for (const days of windows) {
    const cutoffMs = now - days * 86_400_000;
    let sum = 0, cnt = 0;

    if (days <= 7) {
      // Pure raw window — use observations directly.
      const row = prepare(`
        SELECT SUM(price - COALESCE(points, 0) + COALESCE(shipping_fee, 0)) AS s, COUNT(*) AS c
        FROM observations
        WHERE asin = ? AND observed_at >= ? AND price IS NOT NULL
      `).get(asin, cutoffMs);
      sum = row.s || 0;
      cnt = row.c || 0;
    } else {
      // Mixed window — raw for last 7 days, daily aggregates for older.
      const sevenAgo = now - 7 * 86_400_000;
      const rawRow = prepare(`
        SELECT SUM(price - COALESCE(points, 0) + COALESCE(shipping_fee, 0)) AS s, COUNT(*) AS c
        FROM observations
        WHERE asin = ? AND observed_at >= ? AND price IS NOT NULL
      `).get(asin, sevenAgo);
      sum += rawRow.s || 0;
      cnt += rawRow.c || 0;

      const fromStr = new Date(cutoffMs).toISOString().slice(0, 10);
      const toStr   = new Date(sevenAgo).toISOString().slice(0, 10);
      const dailyRow = prepare(`
        SELECT SUM(sample_count * (avg_price - COALESCE(avg_points, 0) + COALESCE(avg_shipping_fee, 0))) AS s,
               SUM(sample_count) AS c
        FROM observations_daily
        WHERE asin = ? AND day_date >= ? AND day_date < ?
              AND avg_price IS NOT NULL
      `).get(asin, fromStr, toStr);
      sum += dailyRow.s || 0;
      cnt += dailyRow.c || 0;
    }

    let avg = cnt > 0 ? sum / cnt : null;
    // 実質価格の平均が負になるのは現実にはあり得ない。ポイントが価格を大きく
    // 超える破損観測 (スクレイプ誤読等) が 1 件混ざると、その実質価格が大きな
    // 負値になって平均を汚染し、FBA利益額/ROE/下落率が壊れる (client報告 項目4:
    // avg90d が ¥-23,706 に化け、利益額が +688 のはずが -25,178 になっていた)。
    // 負の平均は「データ無し」(null) 扱いにして、import値(90/180日) や短い窓への
    // フォールバックに任せる。
    if (avg != null && avg < 0) avg = null;
    const diff = (avg != null && latestEffective != null) ? Math.round(avg - latestEffective) : null;
    result[`avg${days}d`]      = avg != null ? Math.round(avg) : null;
    result[`avg${days}dDiff`]  = diff;
  }

  // ── 平均実質BuyBox の表示ソース反転 (2026-06 spec 項目28) ──────────────
  // 30日/90日/180日平均は、CSVインポート値 / KeepaAPI取得値が「あれば常にそれ」を
  // 表示する (監視データが貯まっていても取込値が優先)。取込値が無い時だけ、上で
  // 計算した監視データの平均にフォールバックする (これまで通り)。
  //   ・最新実質 / 1日平均 → 監視データのみ (上の計算結果をそのまま使用)。
  //   ・7日平均           → 監視データのみ (取込ソースが無いため。client ①)。
  //                         ※ Keepaは取得されるが7日平均には使用しない (client ②)。
  //   ・30/90/180日平均   → 取込値を最優先、無ければ監視計算値。
  // (項目7 の「監視が貯まるまでだけ取込値」という旧挙動を撤回。)
  const applyImportedAvg = (days, impVal) => {
    if (impVal == null) return;   // 取込値なし → 監視計算値のフォールバックを維持
    const v = Math.round(impVal);
    result[`avg${days}d`]     = v;
    result[`avg${days}dDiff`] = latestEffective != null ? Math.round(v - latestEffective) : null;
    result[`avg${days}dSource`] = 'imported';
  };
  applyImportedAvg(30,  product.imp_buybox_30d);
  applyImportedAvg(90,  product.imp_buybox_90d);
  applyImportedAvg(180, product.imp_buybox_180d);

  // 月間販売数 — 監視データ(last_monthly_sales)優先、無ければインポート値
  // (imp_monthly_sales)。last_monthly_sales は updateProductAfterScrape の
  // COALESCE により「直近で取得できていた値」を保持している。
  result.monthlySalesEffective =
    product.last_monthly_sales ?? product.imp_monthly_sales ?? null;

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
      SELECT SUM(price - COALESCE(points, 0) + COALESCE(shipping_fee, 0)) AS s, COUNT(*) AS c
      FROM observations
      WHERE asin = ? AND price IS NOT NULL
    `).get(asin);
    const dailyAll = prepare(`
      SELECT SUM(sample_count * (avg_price - COALESCE(avg_points, 0) + COALESCE(avg_shipping_fee, 0))) AS s,
             SUM(sample_count) AS c
      FROM observations_daily
      WHERE asin = ? AND avg_price IS NOT NULL
    `).get(asin);
    const sumAll = (rawAll.s || 0) + (dailyAll.s || 0);
    const cntAll = (rawAll.c || 0) + (dailyAll.c || 0);
    const avgAllVal = cntAll > 0 ? sumAll / cntAll : null;
    // 上と同様、破損観測由来の負の平均は信用しない (= null)。
    result.avgAll = (avgAllVal != null && avgAllVal >= 0) ? Math.round(avgAllVal) : null;
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

  // ── Ama本体出品割合(直近30日) (2026-06 spec 項目15) ──────────────────
  // 直近30日の Ama本体価格 監視点 (= CSV読込 + Keepa取得 の各イベント) のうち、
  // 値があった (price IS NOT NULL = Amazon本体が出品していた) 点の割合 (%)。
  //   割合 = 値あり点数 ÷ 全点数 × 100
  // ⑤: 監視点が 2 点未満のときは割合 null (= 表示しない)。生カウントも返す
  // (フィルタの「空白含む」判定や将来の検証に使用)。
  {
    const cutoff = now - 30 * 86_400_000;
    let total = 0, withVal = 0;
    try {
      const r = prepare(`
        SELECT COUNT(*) AS total, COUNT(price) AS withVal
        FROM amazon_price_history
        WHERE asin = ? AND observed_at >= ?
      `).get(asin, cutoff);
      total   = r ? r.total   : 0;
      withVal = r ? r.withVal : 0;
    } catch { /* テーブル未作成等 → 0 扱い */ }
    result.amazonPoints30d  = total;
    result.amazonWithVal30d = withVal;
    result.amazonListingRatio30d = (total >= 2) ? (withVal / total) * 100 : null;
  }

  return result;
}

// Ama本体価格 監視点を 1 件記録する (項目14/15)。KeepaAPI 取得時に呼ぶ
// (CSV インポートは importProductsWithKeepaData 内で直接 INSERT)。
// price == null は「Amazon本体 出品なし/値なし」を表す有効な監視点。
function recordAmazonPriceHistory(asin, price, source, ts) {
  prepare(
    'INSERT INTO amazon_price_history (asin, observed_at, price, source) VALUES (?, ?, ?, ?)'
  ).run(asin, ts || Date.now(), price == null ? null : Math.round(price), source || null);
}

// Batch variant of getProductStats — computes stats for many ASINs in
// a single IPC round-trip. Used by the renderer's applyFilter() so that
// stats-dependent filter conditions (実質BuyBox価格の N日平均下落率 等)
// are evaluated against COMPLETE data for every product, not just the
// rows that happen to be scrolled into view.
//
// Why this matters: the renderer's per-row statsCache is populated
// lazily (only visible rows). Evaluating a drop-rate filter against
// that partial cache made the result non-deterministic — products
// flickered in and out of the filtered list depending on scroll
// position and scrape timing. Loading every candidate's stats up front
// makes the filter deterministic.
//
// better-sqlite3 is synchronous and each getProductStats is a handful
// of indexed queries, so looping here is fast enough for the few-
// thousand-product workloads this app targets, and far cheaper than
// one IPC call per ASIN.
function getProductStatsBatch(asins, nowMs) {
  const out = {};
  if (!Array.isArray(asins) || asins.length === 0) return out;
  for (const asin of asins) out[asin] = getProductStats(asin, nowMs);
  return out;
}

// ── 事前計算済み統計 product_stats (2026-06 client要望) ─────────────────
//
// getProductStats() は 1 商品あたり数本のインデックス走査だが、全 ~12.5k 商品を
// 都度計算すると ~1 分かかり、その間クロールが止まる (= 「更新」でスクレイプが
// 0% に固まる) 問題の根本原因だった。そこで各商品の getProductStats 結果を
// product_stats 表に JSON で保持し:
//   ・スクレイプで観測が入るたびに「その 1 商品」だけ refreshProductStats で
//     再計算して upsert する (= クロールの一部として軽量に維持)。
//   ・表示/フィルタ/並び替えの一括取得は getProductStatsBatchFromTable で
//     表を読むだけ (~1 秒) にする。値は getProductStats と完全に同一なので、
//     画面表示・FBA利益額・並び順は一切変わらない。
// 通知判定 (flushDirty / main の最終再評価) は従来どおり on-demand の
// getProductStats を使い続ける (= 常に最新で評価、表の鮮度に依存しない)。

// 1 商品の統計を「今」計算して product_stats に upsert する。戻り値は計算した
// stats (呼び出し側がそのまま返せるように)。nowMs を渡すと窓基準時刻を揃える
// (スクレイプ時刻で固定 = 凍結スナップショットと整合)。
function refreshProductStats(asin, nowMs) {
  const t = nowMs || Date.now();
  const stats = getProductStats(asin, t);
  // 商品が消えている等で null のときは表に残さない (古い値を返さないため削除)。
  if (stats == null) {
    prepare('DELETE FROM product_stats WHERE asin = ?').run(asin);
    return null;
  }
  prepare(`
    INSERT INTO product_stats (asin, computed_at, stats_json)
    VALUES (?, ?, ?)
    ON CONFLICT(asin) DO UPDATE SET computed_at = excluded.computed_at,
                                    stats_json  = excluded.stats_json
  `).run(asin, t, JSON.stringify(stats));
  return stats;
}

// スクレイプ 1 ページ分など、複数 ASIN の統計をまとめて再計算 + upsert する。
// 1 トランザクションでまとめて書き込み、WAL への書込回数を抑える。
function refreshProductStatsBatch(asins, nowMs) {
  if (!Array.isArray(asins) || asins.length === 0) return;
  const t = nowMs || Date.now();
  const tx = transaction((list) => {
    for (const asin of list) {
      // 1 商品の失敗で同ページの他商品まで巻き込んでロールバックしない。
      try { refreshProductStats(asin, t); } catch { /* skip this asin */ }
    }
  });
  tx(asins);
}

// 統計のキャッシュを無効化する (= 行を削除 → 次回読取時に遅延再計算)。
// 価格以外の入力 (imp_buybox_90d/180d 等) が変わる再インポート時に呼ぶ。
function clearProductStats(asins) {
  if (!Array.isArray(asins) || asins.length === 0) return;
  const tx = transaction((list) => {
    for (const asin of list) {
      prepare('DELETE FROM product_stats WHERE asin = ?').run(asin);
    }
  });
  tx(asins);
}

// product_stats 表から 1 商品の統計を読む。未計算 (= 表に無い) なら on-demand で
// 計算 + 保存してから返す (lazy backfill)。表示/並び替え/フィルタ用の高速経路。
function getProductStatsFromTable(asin, nowMs) {
  const row = prepare('SELECT stats_json FROM product_stats WHERE asin = ?').get(asin);
  if (row) {
    try { return JSON.parse(row.stats_json); }
    catch { /* 壊れた JSON → 下で再計算 */ }
  }
  return refreshProductStats(asin, nowMs);
}

// 複数 ASIN を一括で読む (表示/フィルタ/並び替えの一括取得用)。表にある分は
// 1 クエリで読み、無い分だけ遅延計算する。getProductStatsBatch と同じ
// { asin: stats } 形を返すが、~190 万行を走査せず ~1 秒で済む。
const STATS_IN_CHUNK = 200;   // 固定サイズ → prepare キャッシュは 2 種類 (IN固定 + PK) だけ
function getProductStatsBatchFromTable(asins, nowMs) {
  const out = {};
  if (!Array.isArray(asins) || asins.length === 0) return out;
  const have = new Set();
  const take = (r) => {
    try { out[r.asin] = JSON.parse(r.stats_json); have.add(r.asin); }
    catch { /* 壊れた JSON → 下で再計算 */ }
  };
  // 固定サイズの IN 句でまとめ読み (パラメータ上限内 + SQL を 1 種類に固定)。
  const full = Math.floor(asins.length / STATS_IN_CHUNK) * STATS_IN_CHUNK;
  if (full > 0) {
    const sql = `SELECT asin, stats_json FROM product_stats WHERE asin IN (${Array(STATS_IN_CHUNK).fill('?').join(',')})`;
    for (let i = 0; i < full; i += STATS_IN_CHUNK) {
      for (const r of prepare(sql).all(...asins.slice(i, i + STATS_IN_CHUNK))) take(r);
    }
  }
  // 端数は PK ルックアップ (これも 1 種類の cached stmt)。
  for (let i = full; i < asins.length; i++) {
    const row = prepare('SELECT asin, stats_json FROM product_stats WHERE asin = ?').get(asins[i]);
    if (row) take(row);
  }
  // 表に無い (= 未計算) 分だけ遅延計算 + 保存。初回 (表が空) は全件計算 = 一度きり。
  for (const asin of asins) {
    if (!have.has(asin)) out[asin] = refreshProductStats(asin, nowMs);
  }
  return out;
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
      (asin, observed_at, price, points, delivery, image_url,
       mp_price, mp_count, mp_condition, monthly_sales, shipping_fee)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    obs.asin, obs.observedAt,
    obs.price ?? null, obs.points ?? null, obs.delivery ?? null,
    obs.imageUrl ?? null, obs.mpCount ?? null,
    obs.mpCondition ?? null, obs.monthlySales ?? null,
    obs.shippingFee ?? null
  );
}

function insertObservationsBatch(rows) {
  const tx = transaction((list) => {
    for (const obs of list) {
      prepare(`
        INSERT INTO observations
          (asin, observed_at, price, points, delivery, image_url,
           mp_price, mp_count, mp_condition, monthly_sales, shipping_fee)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        obs.asin, obs.observedAt,
        obs.price ?? null, obs.points ?? null, obs.delivery ?? null,
        obs.imageUrl ?? null, obs.mpCount ?? null,
        obs.mpCondition ?? null, obs.monthlySales ?? null,
        obs.shippingFee ?? null
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
    if (d.effective != null) {
      // 2026-06 spec 追加: 日次集計の「最低実質価格」点 (12:00) — buyBox /
      // mpCount 系列には出さず、実質グラフだけにドット表示する。
      effective.push({ t: d.t, v: d.effective });
    } else if (d.price != null) {
      buyBox.push({ t: d.t, v: d.price });
      // 実質価格 = BuyBox − ポイント + 送料 (2026-05 fix)。
      // 8 日以上前の日次集計でも avg_shipping_fee 列が入ったので送料込みで
      // 計算可能 (2026-06)。古い日次行で送料 NULL の場合は 0 扱い。
      effective.push({ t: d.t, v: d.price - (d.points || 0) + (d.shippingFee || 0) });
    }
    if (d.points  != null) points.push({       t: d.t, v: d.points });
    if (d.mpPrice != null) otherSellers.push({ t: d.t, v: d.mpPrice });
    if (d.mpCount != null) sellerCount.push({  t: d.t, v: d.mpCount });
  }

  const trim = (arr) => arr.filter((p) => p.t >= fromMs);

  // 「他の出品価格」の履歴は仕様によりデータベースには記録しない
  // (observations.mp_price は常に NULL)。ただし最新値は
  // products.last_mp_price に残しているので、詳細グラフでは現在値を
  // 1 点だけプロットする (2026-05 client request)。
  //
  // 期間 (1日/7日/全期間など) によらず常に見えるようチャート右端
  // (= toMs / 「今」) に固定で描画する。`last_observed_at` を使うと、
  // 短い表示期間で観測時刻が範囲外になった場合に dot が消えてしまい、
  // 「現在の他の出品価格」を確認したいというクライアントのご要望に
  // 沿わなくなるため。
  let otherSellersOut = trim(otherSellers);
  let monthlySalesOut = null;
  let impSellersOut   = null;
  try {
    const product = getProduct(asin);
    if (product) {
      // 「他の出品価格」が空のときの 1 点合成 (前項目で実装済み)。
      if (otherSellersOut.length === 0 && product.last_mp_price != null) {
        otherSellersOut = [{ t: toMs, v: product.last_mp_price }];
      }
      // 「月間販売数」 — チャート右側パネルに表示する単一スカラ値。
      // 系列ではなくレジェンド表示なので配列ではなく数値で返す。
      monthlySalesOut = product.last_monthly_sales ?? null;
      // 新品出品数(取込) (項目9) — 出品者数グラフに最新1点だけプロットする単一値。
      impSellersOut = product.imp_sellers ?? null;
    }
  } catch { /* ignore — graceful degrade */ }

  // Ama本体価格 履歴 (項目14) — amazon_price_history の price IS NOT NULL 点を
  // 表示範囲内でオレンジのドットとしてプロットする。CSV/Keepa 取得時のみ更新
  // されるためデータ点数は少ない。
  let amazonOut = [];
  try {
    amazonOut = prepare(`
      SELECT observed_at AS t, price AS v
      FROM amazon_price_history
      WHERE asin = ? AND observed_at >= ? AND observed_at <= ? AND price IS NOT NULL
      ORDER BY observed_at ASC
    `).all(asin, fromMs, toMs);
  } catch { /* ignore — graceful degrade */ }

  return {
    buyBox:       trim(buyBox),
    points:       trim(points),
    effective:    trim(effective),
    avg1d:        trim(rollingAvg(effective, 1)),
    avg7d:        trim(rollingAvg(effective, 7)),
    avg30d:       trim(rollingAvg(effective, 30)),
    avg90d:       trim(rollingAvg(effective, 90)),
    avg180d:      trim(rollingAvg(effective, 180)),
    otherSellers: otherSellersOut,
    sellerCount:  trim(sellerCount),
    monthlySales: monthlySalesOut,
    impSellers:   impSellersOut,
    amazon:       amazonOut,
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
           shipping_fee AS shippingFee,
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
    SELECT day_date, avg_price, avg_points, avg_mp_price, avg_mp_count,
           min_effective_price, avg_shipping_fee
    FROM observations_daily
    WHERE asin = ? AND day_date BETWEEN ? AND ?
    ORDER BY day_date ASC
  `).all(asin, fromStr, toStr);
  for (const d of daily) {
    // 2026-06 client spec: 8 日以上前のデータは 1 日に 2 点プロット。
    //   - 09:00 位置: 平均価格 (avg_price - avg_points + avg_shipping_fee)
    //   - 12:00 位置: 最低価格 (min_effective_price = MIN(p - pt + ship))
    // 平均行は通常の price/points/shippingFee 経路で実質価格が計算される。
    // 最低行は `effective` 直値を渡し、getMonitoringChartData 側で
    // 「effective を直接プロット、buyBox/mpCount には追加しない」扱い。
    const dayBaseMs = Date.parse(d.day_date + 'T00:00:00Z');
    // 平均 (09:00 UTC) — 通常の表示行。
    out.push({
      t:       dayBaseMs + 9 * 3600 * 1000,
      price:   d.avg_price   != null ? Math.round(d.avg_price)   : null,
      points:  d.avg_points  != null ? Math.round(d.avg_points)  : null,
      shippingFee: d.avg_shipping_fee != null ? Math.round(d.avg_shipping_fee) : null,
      mpPrice: d.avg_mp_price!= null ? Math.round(d.avg_mp_price): null,
      mpCount: d.avg_mp_count!= null ? Math.round(d.avg_mp_count): null,
    });
    // 最低 (12:00 UTC) — 実質価格チャートにだけ追加でドットを置く。
    if (d.min_effective_price != null) {
      out.push({
        t:         dayBaseMs + 12 * 3600 * 1000,
        effective: Math.round(d.min_effective_price),
        // price / points / shippingFee は null にして buyBox 系列に
        // 出ないようにする (最低ドットは実質グラフだけに描画する)。
      });
    }
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

// (getMovingAverage / getPreviousOfferCount removed — they were only
// consumed by the deleted legacy condition evaluator.)

// 「瞬間下落率」が監視の空白期間をまたいで暴発しないための上限ギャップ
// (2026-06 fix)。瞬間下落率は「連続する2回の監視スナップショット間の
// 急落」を捉えるための指標。通常クロールでは1商品あたりの観測間隔は
// 1サイクル (~20分、大規模リストやポーズ込みでも数時間) 程度。これを
// 大きく超える間隔 = 監視が止まっていた空白 (例: 旧DBを読み込んで
// クロール再開した直後、サーキットブレーカ24h、夜間停止など) であり、
// その「1個前」は数日前の値になりうる。それを基準に瞬間下落率を出すと
// 過去の高値との比較で見かけ上 15% 以上になり、実際は横ばいの商品に
// 誤通知が飛ぶ (クライアント報告のおススメフィルタ①誤通知の真因)。
// よって最新観測と直前観測の間隔が本値を超える場合は「比較不能」(null)
// とする。連続監視中の正当な瞬間下落 (~20分間隔) は本値より遥かに短い
// ため抑制されない。
const INSTANT_MAX_GAP_MS = 12 * 60 * 60 * 1000;   // 12 時間

// 瞬間下落率の比較用に「1 個前の実質価格 (price − points + 送料)」を返す。
// 仕様: (1個前の監視価格 − 最新価格) ÷ 1個前の監視価格 × 100
// "1個前" = 最新観測の直前の観測値。観測が 1 件しかなければ null。
// 監視に長い空白がある場合 (直前観測との間隔が INSTANT_MAX_GAP_MS 超) は
// 「連続する監視」とは言えないため null (= 瞬間下落率は比較不能) を返す。
function getPreviousEffectivePrice(asin) {
  const rows = prepare(`
    SELECT observed_at AS t,
           (price - COALESCE(points, 0) + COALESCE(shipping_fee, 0)) AS effective
    FROM observations
    WHERE asin = ? AND price IS NOT NULL
    ORDER BY observed_at DESC LIMIT 2
  `).all(asin);
  if (rows.length < 2) return null;                       // 観測が1件以下
  const [latest, prev] = rows;
  if (latest.t - prev.t > INSTANT_MAX_GAP_MS) return null; // 監視空白 → 比較不能
  return prev.effective != null ? Math.round(prev.effective) : null;
}

// 監視データの最古時刻 (ms)。observations(直近7日) と observations_daily
// (8日以上前の集計) の両方を見る。観測がまだ無ければ null。インポート値
// 優先判定 (90/180日分のデータが貯まったか) に使う。
function getEarliestObservationMs(asin) {
  const obs = prepare('SELECT MIN(observed_at) AS m FROM observations WHERE asin = ?').get(asin);
  let earliest = obs && obs.m != null ? obs.m : null;
  const daily = prepare('SELECT MIN(day_date) AS d FROM observations_daily WHERE asin = ?').get(asin);
  if (daily && daily.d) {
    const ms = Date.parse(daily.d + 'T00:00:00Z');
    if (earliest == null || ms < earliest) earliest = ms;
  }
  return earliest;
}

// ── Notifications ───────────────────────────────────────────

function insertNotification(n) {
  prepare(`
    INSERT INTO notifications
      (asin, condition_id, price, mp_price, discord_sent, sent_at,
       slot_name, slot_index, context, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    n.asin,
    n.conditionId ?? null,
    n.price ?? null,
    n.mpPrice ?? null,
    n.discordSent ? 1 : 0,
    Date.now(),
    n.slotName  ?? null,
    n.slotIndex ?? null,
    n.context   ?? null,
    n.title     ?? null,
  );
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

function getBlockEventsSince(sinceMs) {
  return prepare(
    'SELECT occurred_at, block_type, source, streak FROM block_events ' +
    'WHERE occurred_at >= ? ORDER BY occurred_at ASC'
  ).all(sinceMs);
}

// ── Crawl diagnostics: per-page elapsed time ────────────────
// `recorded_at` = wall-clock when the page event arrived
// `elapsed_ms`  = time since the previous page event (= 1 ページ取得時間)
// Caller (scheduler) is responsible for filtering out the very first event
// of a cycle (no "previous" reference).
function insertPageTiming({ recordedAt, cycle, page, totalPages, elapsedMs }) {
  prepare(`
    INSERT INTO page_timings (recorded_at, cycle, page, total_pages, elapsed_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(recordedAt, cycle, page, totalPages ?? null, elapsedMs);
}

// `sinceMs` で範囲を指定。ヘッダーモーダルでは過去 24h 程度を想定。
function getPageTimingsSince(sinceMs, limit = 5000) {
  return prepare(
    'SELECT recorded_at, cycle, page, total_pages, elapsed_ms FROM page_timings ' +
    'WHERE recorded_at >= ? ORDER BY recorded_at ASC LIMIT ?'
  ).all(sinceMs, limit);
}

// 古いタイミングデータを定期的に削除して肥大化を防ぐ。
// scheduler の cycle 完了時に呼び出される想定。
function pruneOldPageTimings(beforeMs) {
  prepare('DELETE FROM page_timings WHERE recorded_at < ?').run(beforeMs);
}

// Ama本体価格 履歴の保持期間を超えた行を削除する (項目14/15)。retention.js から呼ぶ。
function pruneOldAmazonPriceHistory(beforeMs) {
  prepare('DELETE FROM amazon_price_history WHERE observed_at < ?').run(beforeMs);
}

// ── 1 周期合計時間 (全商品スクレイプ完了まで) ─────────────────
// 各 cycle 完了時に scheduler から呼ばれる。診断モーダルの 2 つ目の
// 棒グラフで「この周期は何分で全件回れたか」を一目で見せるための
// データソース。
function insertCycleTiming({ recordedAt, cycle, totalPages, found, missed, errors, elapsedMs }) {
  prepare(`
    INSERT INTO cycle_timings
      (recorded_at, cycle, total_pages, found, missed, errors, elapsed_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordedAt,
    cycle,
    totalPages ?? null,
    found ?? null,
    missed ?? null,
    errors ?? null,
    elapsedMs,
  );
}

function getCycleTimingsSince(sinceMs, limit = 2000) {
  return prepare(
    'SELECT recorded_at, cycle, total_pages, found, missed, errors, elapsed_ms ' +
    'FROM cycle_timings WHERE recorded_at >= ? ORDER BY recorded_at ASC LIMIT ?'
  ).all(sinceMs, limit);
}

function pruneOldCycleTimings(beforeMs) {
  prepare('DELETE FROM cycle_timings WHERE recorded_at < ?').run(beforeMs);
}

// 直近 1 周期のクロール所要時間 — ヘッダーの「監視周期: ○○分」
// バッジの初期表示に使う。完了済み周期が無ければ null。
function getLastCycleTiming() {
  return prepare(
    'SELECT recorded_at, cycle, elapsed_ms FROM cycle_timings ' +
    'ORDER BY recorded_at DESC LIMIT 1'
  ).get() || null;
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

// ── 価格サニティチェック (Guard #1) の基準価格 ───────────────────────────
// 各 ASIN の「堅牢な基準価格」を返す。検索ページのスクレイプはたまに BuyBox 以外の
// 数字 (分割払い/他の出品/クーポン等) を価格として誤読するため、新しい読み取りが
// 基準から極端に外れていたら採用しない判定に使う。基準は「直近7日の観測価格の平均」
// (単一の異常値に引きずられない)。7日分の観測が無い ASIN は products.last_price を
// フォールバック基準にする。どちらも無ければ未設定 (= 判定不能 → 採用)。
function getPriceBaselines(asins) {
  const out = {};
  if (!Array.isArray(asins) || asins.length === 0) return out;
  const sevenAgo = Date.now() - 7 * 86_400_000;
  const CHUNK = 400;   // SQLite パラメータ上限内
  for (let i = 0; i < asins.length; i += CHUNK) {
    const slice = asins.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = prepare(
      `SELECT asin, AVG(price) AS avg_price FROM observations
        WHERE asin IN (${ph}) AND price IS NOT NULL AND observed_at >= ?
        GROUP BY asin`
    ).all(...slice, sevenAgo);
    for (const r of rows) if (r.avg_price != null) out[r.asin] = r.avg_price;
  }
  const missing = asins.filter((a) => out[a] == null);
  for (let i = 0; i < missing.length; i += CHUNK) {
    const slice = missing.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = prepare(`SELECT asin, last_price FROM products WHERE asin IN (${ph})`).all(...slice);
    for (const r of rows) if (r.last_price != null) out[r.asin] = r.last_price;
  }
  return out;
}

module.exports = {
  addProducts,
  getPriceBaselines,
  importProductsWithKeepaData,
  getAsinsForKeepaRefresh,
  markKeepaRefreshed,
  removeProduct,
  softDeleteProducts,
  restoreProducts,
  recordNotificationHit,
  hardDeleteProducts,
  getProduct,
  getAllProducts,
  getTrashedProducts,
  getProductCount,
  getTrashedProductCount,
  getActiveAsins,
  updateProductAfterScrape,
  getReferralPctMap,
  markProductError,
  resetCycleSeen,
  getUnseenAsins,
  getAllGroups,
  addGroup,
  ensureGroupSlots,
  renameGroup,
  deleteGroup,
  assignGroup,
  setNotifyPrice,
  getProductStats,
  getProductStatsBatch,
  refreshProductStats,
  refreshProductStatsBatch,
  clearProductStats,
  getProductStatsFromTable,
  getProductStatsBatchFromTable,
  insertObservation,
  insertObservationsBatch,
  getObservationsInRange,
  getObservationSpan,
  getChartData,
  getSparklineSeries,
  getMonitoringChartData,
  recordAmazonPriceHistory,
  pruneOldAmazonPriceHistory,
  insertNotification,
  getRecentNotifications,
  insertBlockEvent,
  getRecentBlockEvents,
  getBlockEventCountSince,
  getBlockEventsSince,
  insertPageTiming,
  getPageTimingsSince,
  pruneOldPageTimings,
  insertCycleTiming,
  getCycleTimingsSince,
  pruneOldCycleTimings,
  getLastCycleTiming,
  getSetting,
  setSetting,
};
