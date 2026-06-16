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

  // 事前計算済み統計 (2026-06 client要望) — 各商品の getProductStats() 結果を
  // JSON で保持する。スクレイプで新しい観測が入るたびにその商品分だけ再計算して
  // upsert し (= 1 件ずつ・クロールの一部として軽量に維持)、再計算 (更新ボタン /
  // 周期完了 / フィルタ・並び替え) では 190 万行を都度走査する代わりにこの表を
  // 読むだけ (~1 秒) にする。これにより「再計算が ~1 分かかってクロールを止める」
  // 問題が解消する。値は getProductStats と同一 (= 表示・FBA利益額は変わらない)。
  // stats_json が無い ASIN は読み取り時に遅延計算してここへ書き込む (lazy backfill)。
  `CREATE TABLE IF NOT EXISTS product_stats (
    asin        TEXT PRIMARY KEY,
    computed_at INTEGER NOT NULL,
    stats_json  TEXT NOT NULL
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

  // 「過去1か月で○○点以上購入されました」 (2026-05): Amazon が一部の
  // 商品カードに表示する月間販売目安。商品の人気度指標として保存し、
  // ビューア表の新規列に表示する。`last_monthly_sales` は products.
  // observations 側にも履歴として残す (将来のフィルタ条件用)。
  try { db.exec('ALTER TABLE products    ADD COLUMN last_monthly_sales INTEGER'); } catch {}
  try { db.exec('ALTER TABLE observations ADD COLUMN monthly_sales     INTEGER'); } catch {}

  // 通知履歴 UI で「いつ・どのフィルタが・どの商品にマッチしたか」を
  // 表示するために、ヒットした FNM カスタムフィルタスロットの名前と
  // インデックス、active/trash 区別、商品タイトルを保存する (2026-05)。
  try { db.exec('ALTER TABLE notifications ADD COLUMN slot_name  TEXT');    } catch {}
  try { db.exec('ALTER TABLE notifications ADD COLUMN slot_index INTEGER'); } catch {}
  try { db.exec('ALTER TABLE notifications ADD COLUMN context    TEXT');    } catch {}
  try { db.exec('ALTER TABLE notifications ADD COLUMN title      TEXT');    } catch {}

  // 送料 (2026-05): BuyBox 価格には既に加算済みだが、UI 上で送料の有無
  // を独立した列として一目で確認できるよう、単独の値も保存する。
  // products.last_shipping_fee は最新値、observations.shipping_fee は
  // スクレイプごとの履歴。
  try { db.exec('ALTER TABLE products    ADD COLUMN last_shipping_fee INTEGER'); } catch {}
  try { db.exec('ALTER TABLE observations ADD COLUMN shipping_fee     INTEGER'); } catch {}

  // 個別設定価格 (2026-05 client request): 商品ごとに「最新実質BuyBox価格
  // がこの値を下回ったら通知」の閾値を持たせる。NULL = 未設定 → 通常の
  // FNM 通知ロジックに従う。値があるなら、その閾値を満たした時に
  // 「『個別設定価格』の商品検知」専用通知を発火し、FNM は迂回する。
  try { db.exec('ALTER TABLE products    ADD COLUMN notify_price INTEGER'); } catch {}

  // 通知履歴の列 (2026-06 spec 項目29/30):
  //   last_notified_at  各商品の直近の通知日時 (ms)。未通知は NULL。
  //   notify_hit_count  監視登録〜現在の通知発火 総回数。新規登録・ゴミ箱からの
  //                     復元時に 0 にリセットしてカウントし直す。
  // 「通知なし経過日数」は last_notified_at から表示時に算出する (列は持たない)。
  try { db.exec('ALTER TABLE products    ADD COLUMN last_notified_at INTEGER'); } catch {}
  try { db.exec('ALTER TABLE products    ADD COLUMN notify_hit_count INTEGER DEFAULT 0'); } catch {}

  // 8日以上前データの日次集計 (2026-06 client spec):
  //   - min_effective_price: その日の最低実質価格 (= MIN(price - points + shipping))
  //     → グラフの 12 時位置にプロット (avg は 9 時位置)。
  //   - avg_shipping_fee: その日の平均送料 (新観測列。古い日次行では NULL)。
  //     → getProductStats の long-window 平均で送料を反映するため必要。
  try { db.exec('ALTER TABLE observations_daily ADD COLUMN min_effective_price INTEGER'); } catch {}
  try { db.exec('ALTER TABLE observations_daily ADD COLUMN avg_shipping_fee    REAL');    } catch {}

  // ── Keepa CSV インポート拡張 (2026-06 client spec 項目7 + ①) ─────────
  // 「監視対象のASINインポート」で ASIN 以外の列も取り込み、(A) そのまま
  // 表示する値と、(B) サイズ区分/各手数料の計算入力、(C) 計算結果を
  // products 行に保存する。列名は `imp_*` (imported) / 計算結果は無接頭辞。
  //
  // (A) インポート直値 — 表示 & フィルタ/通知のフォールバック源。
  //   imp_sellers          新品アイテム数: 現在価格           (現在の出品者数)
  //   imp_buybox_current   Buy Box: 現在価格                  (手数料計算の salesPrice)
  //   imp_buybox_30d       Buy Box: 30 日平均                 (30日平均実質BuyBox、項目25/26)
  //   imp_buybox_90d       Buy Box: 90 日平均                 (90日平均実質BuyBox)
  //   imp_buybox_180d      Buy Box: 180 日平均                (180日平均実質BuyBox)
  //   imp_amazon_current   Amazon: 現在価格                   (Ama本体価格、項目14)
  //   imp_monthly_sales    月間売上トレンド: 先月の購入        (月間販売数)
  //   imp_rank             売れ筋ランキング: 現在価格          (ランキング)
  //   imp_rank_drop_30d    売れ筋ランキング: 過去30日間の減少  (30日ランキング変動数)
  const IMPORT_COLUMNS = [
    ['imp_sellers',        'INTEGER'],
    ['imp_buybox_current', 'INTEGER'],
    ['imp_buybox_30d',     'INTEGER'],
    ['imp_buybox_90d',     'INTEGER'],
    ['imp_buybox_180d',    'INTEGER'],
    // Ama本体価格 (項目14): CSV「Amazon: 現在価格」/ KeepaAPI の Amazon現在価格。
    // 空白許容 (Amazon本体が出品していない時は NULL)。インポート/取得のたびに
    // 上書き (空白なら NULL で上書き — 旧値は残さない、項目14 の明示仕様)。
    ['imp_amazon_current', 'INTEGER'],
    ['imp_monthly_sales',  'INTEGER'],
    ['imp_rank',           'INTEGER'],
    ['imp_rank_drop_30d',  'INTEGER'],
    // (B) 計算入力 — 後から設定変更/価格変更で再計算できるよう原値も保持。
    ['imp_root_category',  'TEXT'],
    ['imp_sub_category',   'TEXT'],
    ['imp_category_tree',  'TEXT'],
    ['imp_brand',          'TEXT'],
    ['imp_fba_pickpack',   'INTEGER'],
    ['imp_referral_pct',   'REAL'],
    ['imp_referral_buybox','INTEGER'],
    ['imp_pkg_length',     'REAL'],
    ['imp_pkg_width',      'REAL'],
    ['imp_pkg_height',     'REAL'],
    ['imp_pkg_weight',     'REAL'],
    ['imp_item_length',    'REAL'],
    ['imp_item_width',     'REAL'],
    ['imp_item_height',    'REAL'],
    ['imp_item_weight',    'REAL'],
    // (C) 計算結果 — インポート直後に算出し表示。
    ['size_kubun',            'TEXT'],
    ['amazon_fee',            'INTEGER'],
    ['fba_fee',               'INTEGER'],
    ['inventory_storage_fee', 'INTEGER'],
    // 取り込み時刻 (再計算/監視データ優先切替の判定に使用)。
    ['imported_at',           'INTEGER'],
  ];
  for (const [col, type] of IMPORT_COLUMNS) {
    try { db.exec(`ALTER TABLE products ADD COLUMN ${col} ${type}`); } catch {}
  }

  // クロール診断 (2026-05) — 1 ページごとの実所要時間を保存して、ヘッダー
  // の「診断」モーダルでグラフ表示する。`elapsed_ms` は直前ページ完了
  // から本ページ完了までの実時間 (待機含む)。block 発生位置は
  // block_events と時刻でジョインして縦線マーカー表示する。
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_timings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at  INTEGER NOT NULL,
      cycle        INTEGER NOT NULL,
      page         INTEGER NOT NULL,
      total_pages  INTEGER,
      elapsed_ms   INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pt_time ON page_timings(recorded_at)');

  // クロール診断 (2026-05) — 1 周期合計時間 (全商品スクレイプ完了まで)
  // を周期ごとに保存。診断モーダルの 2 つ目の棒グラフで表示する。
  // `elapsed_ms` は周期開始から runCoverage 完了までのウォールクロック
  // 経過時間。サイクル間 (rest) は含まない。
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_timings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at  INTEGER NOT NULL,
      cycle        INTEGER NOT NULL,
      total_pages  INTEGER,
      found        INTEGER,
      missed       INTEGER,
      errors       INTEGER,
      elapsed_ms   INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ct_time ON cycle_timings(recorded_at)');

  // ── Ama本体価格 履歴 (2026-06 spec 項目14/15) ─────────────────────────
  // CSV手動インポート / KeepaAPI取得のたびに 1 行記録する (= 「監視点」)。
  //   price  : Amazon: 現在価格。Amazon本体が出品していない/値が無い時は NULL。
  //   source : 'csv' | 'keepa' (診断用)。
  // 用途:
  //   (項目14) price IS NOT NULL の点を詳細グラフにオレンジでプロット。
  //   (項目15) 直近30日の COUNT(*) を分母、COUNT(price) を分子に
  //            「Ama本体出品割合(直近30日)」= 分子÷分母×100 を算出。
  // BuyBox 監視 (observations) とは別管理 — Amazon価格は CSV/Keepa 時のみ更新
  // されデータ点数が少ないため。
  db.exec(`
    CREATE TABLE IF NOT EXISTS amazon_price_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asin        TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      price       INTEGER,
      source      TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_amzhist_asin_time ON amazon_price_history(asin, observed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_amzhist_time      ON amazon_price_history(observed_at)');
}

module.exports = { runMigrations };
