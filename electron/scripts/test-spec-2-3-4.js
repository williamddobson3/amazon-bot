'use strict';

//
// 2026-06 クライアント要望 項目2/3/4 のテスト。
//
//   2) 通知の「月間売行き個数」: 月間販売数 を優先 (頭に「+」)、無ければ
//      30日ランク変動(取込) (「+」なし)。優先度を従来から反転。
//   3) 一覧/通知/チャートの月間販売数は「監視クロール取得値」と「Keepa取込値」の
//      うち取得日時が新しい方 (pickMonthlySales)。監視側は last_monthly_sales_at、
//      取込側は imported_at を取得日時とする。updateProductAfterScrape は
//      月間販売数が取れた (非NULL) サイクルだけ last_monthly_sales_at を更新する。
//   4) 新フィルタ/通知条件「直近でデータ取得できなかった期間 (□〜□日)」: 全商品で
//      最も新しい last_observed_at を基準に、該当商品が何日古いか (staleDaysOf)。
//
// 実装と「写経」がズレないよう、共有ロジックは実モジュール (shared/monthly-sales)
// を import し、renderer / SQL は同じ式を写経 + ソース文字列照合で二重化を担保する。
//

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { pickMonthlySales, formatSalesCountLine } = require(path.join('..', 'src', 'shared', 'monthly-sales.js'));
const { runMigrations } = require(path.join('..', 'src', 'main', 'db', 'migrations.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
const notifierSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services', 'notifier.js'), 'utf8');
const queriesSrc  = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'db', 'queries.js'), 'utf8');

// ── 項目2) 通知の月間売行き個数 (notifier = formatSalesCountLine ?? '—') ─────────
// 月間販売数(pickMonthlySales) を優先し「+」を付ける。無ければ 30日ランク変動を
// 「+」なしで表示。両方無ければ「—」。詳細グラフ凡例 (項目B5) と共通の実モジュール。
const salesLine = (product) => formatSalesCountLine(product) ?? '—';
eq('2 月間販売数(監視)あり → +50個',
   salesLine({ last_monthly_sales: 50, last_monthly_sales_at: 10, imp_rank_drop_30d: 999 }), '+50個');
eq('2 月間販売数(取込)あり → +100個',
   salesLine({ imp_monthly_sales: 100, imported_at: 10, imp_rank_drop_30d: 999 }), '+100個');
eq('2 月間販売数なし → 30日ランク変動 (「+」なし) 30個',
   salesLine({ last_monthly_sales: null, imp_monthly_sales: null, imp_rank_drop_30d: 30 }), '30個');
eq('2 両方なし → —',
   salesLine({ imp_rank_drop_30d: null }), '—');
eq('2 優先度反転: 月間販売数50 と 変動999 両方あり → +50個 (月間販売数優先)',
   salesLine({ last_monthly_sales: 50, last_monthly_sales_at: 10, imp_rank_drop_30d: 999 }), '+50個');
eq('2 桁区切り 月間販売数1000 → +1,000個', salesLine({ imp_monthly_sales: 1000, imported_at: 1, imp_rank_drop_30d: 5 }), '+1,000個');
eq('2 桁区切り 変動1234 (月間販売数なし) → 1,234個', salesLine({ imp_rank_drop_30d: 1234 }), '1,234個');
eq('2 月間販売数の中では取得日時が新しい方 (取込が新) → +777個',
   salesLine({ last_monthly_sales: 50, last_monthly_sales_at: 100, imp_monthly_sales: 777, imported_at: 200, imp_rank_drop_30d: 999 }), '+777個');

// ソース照合: 通知・詳細グラフとも共有 formatSalesCountLine を使用 (表示一致を担保)。
ok('2 notifier: formatSalesCountLine を使用',
   notifierSrc.includes("const salesLine = formatSalesCountLine(product) ?? '—'"));
ok('2 shared: 月間販売数は「+」付き', formatSalesCountLine({ imp_monthly_sales: 50, imported_at: 1 }).startsWith('+'));
ok('2 shared: 30日ランク変動は「+」なし', !formatSalesCountLine({ imp_rank_drop_30d: 50 }).startsWith('+'));

// ── 2b) 通知本文の並び順 + FBA利益額の赤字 (クライアント要望 2026-06) ───────────
// 並び: 💰FBA利益額 → 🛒最新価格 → 📊月間売行き個数 → 👥新品出品者数 → 📦発送情報。
// descParts.push(...) のコード上の出現位置で順序を担保 (コメントではなくコードを対象)。
const iProfit = notifierSrc.indexOf("descParts.push('```ansi\\n' + profitColored");
const iPrice  = notifierSrc.indexOf('descParts.push(`🛒 **最新価格**');
const iSales  = notifierSrc.indexOf('descParts.push(`📊 **月間売行き個数**');
const iSeller = notifierSrc.indexOf('descParts.push(`👥 **新品出品者数**');
const iDeliv  = notifierSrc.indexOf('descParts.push(`📦 **発送情報**');
ok('2b 全行が存在', [iProfit, iPrice, iSales, iSeller, iDeliv].every((i) => i > 0));
ok('2b FBA利益額 が先頭 (最新価格より前)', iProfit < iPrice);
ok('2b 最新価格 < 月間売行き個数',        iPrice  < iSales);
ok('2b 月間売行き個数 < 新品出品者数',    iSales  < iSeller);
ok('2b 新品出品者数 < 発送情報',          iSeller < iDeliv);
ok('2b FBA利益額の数値が赤字 (ansi 1;31)', notifierSrc.includes('\\x1b[1;31m${profitLine}\\x1b[0m'));
ok('2b 利益が出せない時は色なし (—)', notifierSrc.includes("'💰 FBA利益額(ROE利益率) : —'"));

// ── 項目3) updateProductAfterScrape の last_monthly_sales_at 更新 (SQL写経) ─────
// 月間販売数が取れた (非NULL) サイクルだけ取得日時を更新。取れない (NULL) サイクルは
// 値も日時も維持する。COALESCE + CASE WHEN の挙動を実 migrations 上で検証。
{
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(products)').all().map((r) => r.name);
  ok('3 last_monthly_sales_at 列が存在', cols.includes('last_monthly_sales_at'));

  db.prepare('INSERT INTO products (asin, added_at) VALUES (?, ?)').run('B000000010', 1);
  const scrape = db.prepare(`
    UPDATE products SET
      last_monthly_sales    = COALESCE(?, last_monthly_sales),
      last_monthly_sales_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_monthly_sales_at END
    WHERE asin = ?
  `);
  const read = () => db.prepare('SELECT last_monthly_sales AS v, last_monthly_sales_at AS t FROM products WHERE asin = ?').get('B000000010');

  // 1) 月間販売数50 を t=100 で取得 → 値も日時も更新。
  scrape.run(50, 50, 100, 'B000000010');
  eq('3 取得(50@100) → 値50',  read().v, 50);
  eq('3 取得(50@100) → 日時100', read().t, 100);
  // 2) 月間販売数 NULL を t=200 で (バッジ無し) → 値も日時も維持。
  scrape.run(null, null, 200, 'B000000010');
  eq('3 未取得(null@200) → 値は維持50', read().v, 50);
  eq('3 未取得(null@200) → 日時も維持100 (バンプしない)', read().t, 100);
  // 3) 月間販売数60 を t=300 で取得 → 値も日時も更新。
  scrape.run(60, 60, 300, 'B000000010');
  eq('3 取得(60@300) → 値60',  read().v, 60);
  eq('3 取得(60@300) → 日時300', read().t, 300);
}

// 項目3) pickMonthlySales の取得日時比較 (実モジュール)。
eq('3 同時刻は監視優先', pickMonthlySales({ last_monthly_sales: 1, last_monthly_sales_at: 5, imp_monthly_sales: 2, imported_at: 5 }).source, 'monitor');
eq('3 監視が新 → monitor', pickMonthlySales({ last_monthly_sales: 1, last_monthly_sales_at: 9, imp_monthly_sales: 2, imported_at: 5 }).source, 'monitor');
eq('3 取込が新 → import',  pickMonthlySales({ last_monthly_sales: 1, last_monthly_sales_at: 5, imp_monthly_sales: 2, imported_at: 9 }).source, 'import');
eq('3 監視のみ → monitor', pickMonthlySales({ last_monthly_sales: 1, last_monthly_sales_at: null }).source, 'monitor');
eq('3 取込のみ → import',  pickMonthlySales({ imp_monthly_sales: 2, imported_at: null }).source, 'import');
eq('3 どちらも無し → null', pickMonthlySales({}).source, null);
// タイムスタンプ欠損 (旧データ) はどちらも 0 → 監視優先。
eq('3 旧データ(両ts欠損) → 監視優先', pickMonthlySales({ last_monthly_sales: 1, imp_monthly_sales: 2 }).value, 1);

ok('3 queries: require shared/monthly-sales', queriesSrc.includes("require('../../shared/monthly-sales')"));
ok('3 notifier: require shared/monthly-sales', notifierSrc.includes("require('../../shared/monthly-sales')"));
ok('3 renderer: pickMonthlySales 定義あり (main と二重化)', /function pickMonthlySales\(row\)/.test(rendererSrc));
ok('3 renderer: handleIncomingPriceUpdate が last_monthly_sales_at を更新',
   rendererSrc.includes('row.last_monthly_sales_at = updatedAt'));
ok('3 SORT/RANGE が pickMonthlySales を使用', rendererSrc.includes('pickMonthlySales(p)'));

// ── 項目4) 直近でデータ取得できなかった期間 (staleDaysOf を写経) ───────────────
const DAY = 86_400_000;
function staleDaysOf(p, newest) {
  if (newest <= 0 || !p || p.last_observed_at == null) return null;
  const diff = newest - p.last_observed_at;
  return diff > 0 ? Math.floor(diff / DAY) : 0;
}
function inRange(val, range) {
  if (val == null) return false;
  const min = (range.min == null || !isFinite(range.min)) ? -Infinity : range.min;
  const max = (range.max == null || !isFinite(range.max)) ?  Infinity : range.max;
  return val >= min && val <= max;
}

const NEWEST = 1_000_000 * DAY;     // 任意の「最も新しい最新取得日時」
eq('4 最新商品 (基準と同値) → 0日', staleDaysOf({ last_observed_at: NEWEST }, NEWEST), 0);
eq('4 ちょうど3日古い → 3日',       staleDaysOf({ last_observed_at: NEWEST - 3 * DAY }, NEWEST), 3);
eq('4 1.5日古い → floor 1日',       staleDaysOf({ last_observed_at: NEWEST - Math.floor(1.5 * DAY) }, NEWEST), 1);
eq('4 数時間古い → 0日',            staleDaysOf({ last_observed_at: NEWEST - 3 * 3600_000 }, NEWEST), 0);
eq('4 基準未確定 (newest=0) → null', staleDaysOf({ last_observed_at: NEWEST }, 0), null);
eq('4 last_observed_at 無し → null', staleDaysOf({ last_observed_at: null }, NEWEST), null);

// 範囲フィルタ: 5日古い商品。
const stale5 = staleDaysOf({ last_observed_at: NEWEST - 5 * DAY }, NEWEST);
ok('4 5日 ∈ [3,7] → 通す',     inRange(stale5, { min: 3, max: 7 }));
ok('4 5日 ∉ [6,∞) → 弾く',     !inRange(stale5, { min: 6, max: null }));
ok('4 5日 ∈ [5,5] → 通す',     inRange(stale5, { min: 5, max: 5 }));
ok('4 null は範囲外 (未確定は条件失敗)', !inRange(staleDaysOf({ last_observed_at: null }, NEWEST), { min: 0, max: 9999 }));

// DB 統合: 複数商品の last_observed_at から「最も新しい」を基準に経過日数を算出。
{
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const ins = db.prepare('INSERT INTO products (asin, added_at, last_observed_at) VALUES (?, ?, ?)');
  ins.run('A', 1, NEWEST);              // 最新
  ins.run('B', 2, NEWEST - 2 * DAY);    // 2日古い
  ins.run('C', 3, NEWEST - 10 * DAY);   // 10日古い (在庫切れ想定)
  ins.run('D', 4, null);                // 未取得 (last_observed_at なし)
  const rows = db.prepare('SELECT asin, last_observed_at FROM products').all();
  const newest = rows.reduce((m, r) => (r.last_observed_at != null && r.last_observed_at > m ? r.last_observed_at : m), 0);
  eq('4 DB: 基準 = A の last_observed_at', newest, NEWEST);
  const stale = Object.fromEntries(rows.map((r) => [r.asin, staleDaysOf(r, newest)]));
  eq('4 DB: A=0',    stale.A, 0);
  eq('4 DB: B=2',    stale.B, 2);
  eq('4 DB: C=10',   stale.C, 10);
  eq('4 DB: D=null', stale.D, null);
  // 「3日以上未取得」フィルタで C だけがヒット。
  const hit = rows.filter((r) => inRange(staleDaysOf(r, newest), { min: 3, max: null })).map((r) => r.asin);
  eq('4 DB: 3日以上未取得 = [C]', hit, ['C']);
}

// ソース照合: renderer に staleDays フィルタ行と基準更新呼び出しがあること。
ok('4 renderer: staleDays RANGE_ROW あり', /key:\s*'staleDays'/.test(rendererSrc));
ok('4 renderer: 直近でデータ取得できなかった期間 ラベル', rendererSrc.includes('直近でデータ取得できなかった期間'));
ok('4 renderer: staleDaysOf 定義あり', /function staleDaysOf\(p\)/.test(rendererSrc));
ok('4 renderer: refreshNewestObserved 定義あり', /function refreshNewestObserved\(\)/.test(rendererSrc));
// 2箇所 (recomputeFilterSnapshot 表示フィルタ + flushDirty 通知) で基準を更新。
eq('4 renderer: refreshNewestObserved() 呼び出しが2箇所',
   (rendererSrc.match(/refreshNewestObserved\(\);/g) || []).length, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
