'use strict';

// 月間販売数 (Keepa monthlySold) テスト — 2026-06 クライアント要望
// 「『+50』『+100』などの月間販売数を Keepa API からトークン追加消費なしに取得」。
//
// Keepa の monthlySold は Amazon の「○○+ 買われました(過去1か月)」バッジ由来の
// 「○○以上」まるめ値で、product オブジェクト直下に入る (stats=180 の基本レスポンスに
// 含まれ、buybox/offers のような追加トークンは不要)。本テストは:
//   A) keepa-api.mapProductToParams が p.monthlySold を正しく抽出 (-1/欠落→null、
//      buybox/stats に依存しない = 追加トークン不要の裏付け)
//   B) fee-calc.buildImportRecord が monthlySales を import レコードへ素通し
//   C) 表の月間販売数列 (renderer.monthlySalesText) が常に「+」を付ける (Keepa も)
//      + 値選択は pickMonthlySales (取得日時が新しい方、項目3)
//   D) チャート右パネルのソース (queries.getMonitoringChartData の monthlySalesOut)
//      が pickMonthlySales (最新取得値、項目3) を使う
//   E) チャート右パネルの整形 (renderer salesFmt) との一貫性
//   F) 実 migrations のスキーマに imp_monthly_sales / last_monthly_sales /
//      last_monthly_sales_at が存在し値が永続化される

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const keepa = require(path.join('..', 'src', 'main', 'services', 'keepa-api.js'));
const fee   = require(path.join('..', 'src', 'main', 'services', 'fee-calc.js'));
const { runMigrations } = require(path.join('..', 'src', 'main', 'db', 'migrations.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// ── A) Keepa monthlySold 抽出 (mapProductToParams) ──────────────────────────
const baseProduct = (over) => Object.assign({
  asin: 'B000000001',
  stats: { current: [], avg30: [], avg90: [], avg180: [] },
  categoryTree: [],
}, over);

eq('A monthlySold 50 → 50',   keepa.mapProductToParams(baseProduct({ monthlySold: 50 })).monthlySales, 50);
eq('A monthlySold 100 → 100', keepa.mapProductToParams(baseProduct({ monthlySold: 100 })).monthlySales, 100);
eq('A monthlySold -1 (データ無し) → null', keepa.mapProductToParams(baseProduct({ monthlySold: -1 })).monthlySales, null);
eq('A monthlySold 欠落 → null',  keepa.mapProductToParams(baseProduct({})).monthlySales, null);
eq('A monthlySold null → null',  keepa.mapProductToParams(baseProduct({ monthlySold: null })).monthlySales, null);
// stats / buybox が空でも monthlySold は取れる = 追加トークン(buybox=1)に依存しない。
eq('A buybox/stats 空でも抽出可 (追加トークン不要の裏付け)',
   keepa.mapProductToParams({ asin: 'X', monthlySold: 200, stats: {}, categoryTree: [] }).monthlySales, 200);

// ── B) import レコードへ素通し (buildImportRecord) ──────────────────────────
// monthlySales だけのレコードは fee 計算入力が無い → Rust(computeFees) を呼ばない。
eq('B buildImportRecord 数値', fee.buildImportRecord({ monthlySales: 50 }, {}, null).monthlySales, 50);
eq('B buildImportRecord 文字列"100"→100', fee.buildImportRecord({ monthlySales: '100' }, {}, null).monthlySales, 100);
eq('B buildImportRecord null→null', fee.buildImportRecord({ monthlySales: null }, {}, null).monthlySales, null);
// Keepa → params → record の往復。
const kparams = keepa.mapProductToParams(baseProduct({ monthlySold: 100 }));
eq('B Keepa往復: record.monthlySales = 100', fee.buildImportRecord(kparams, {}, null).monthlySales, 100);

// ── C) 表の月間販売数表示 — pickMonthlySales(最新取得値) + 常に「+」(項目3) ──
// 監視値/取込値のうち取得日時が新しい方を採用 (実 shared モジュールを使用)。
const { pickMonthlySales } = require(path.join('..', 'src', 'shared', 'monthly-sales.js'));
function monthlySalesText(row) {
  const ms = pickMonthlySales(row).value;
  if (ms == null) return '';
  return Number(ms).toLocaleString('ja-JP') + '+';
}
eq('C 監視値のみ 50 → 50+',
   monthlySalesText({ last_monthly_sales: 50, last_monthly_sales_at: 100, imp_monthly_sales: null, imported_at: null }), '50+');
eq('C Keepa取込のみ 100 → 100+',
   monthlySalesText({ last_monthly_sales: null, last_monthly_sales_at: null, imp_monthly_sales: 100, imported_at: 100 }), '100+');
eq('C 両方あり → 取得日時が新しい監視値 50+',
   monthlySalesText({ last_monthly_sales: 50, last_monthly_sales_at: 200, imp_monthly_sales: 999, imported_at: 100 }), '50+');
eq('C 両方あり → 取得日時が新しい取込値 999+',
   monthlySalesText({ last_monthly_sales: 50, last_monthly_sales_at: 100, imp_monthly_sales: 999, imported_at: 200 }), '999+');
eq('C 同時刻は監視値優先 50+',
   monthlySalesText({ last_monthly_sales: 50, last_monthly_sales_at: 100, imp_monthly_sales: 999, imported_at: 100 }), '50+');
eq('C どちらも無し → 空',                 monthlySalesText({}), '');
eq('C 桁区切り 1000 → 1,000+',           monthlySalesText({ imp_monthly_sales: 1000, imported_at: 1 }), '1,000+');

// 退行ガード: renderer.js が「常に + を付ける」実装になっていること
// (旧: live != null の時だけ + を付ける条件式が残っていないこと)。
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
ok('C renderer: 旧条件式 (live != null ? \'+\' : \'\') が消えている',
   !rendererSrc.includes("(live != null ? '+' : '')"));
ok('C renderer: monthlySalesText が常に + を付ける',
   /toLocaleString\('ja-JP'\)\s*\+\s*'\+';/.test(rendererSrc));

// ── D) チャート右パネルのソース — pickMonthlySales (最新取得値、項目3) ─────────
function chartMonthlySales(product) { return pickMonthlySales(product).value; }
eq('D 両方あり → 取得日時が新しい監視値',
   chartMonthlySales({ last_monthly_sales: 50, last_monthly_sales_at: 200, imp_monthly_sales: 100, imported_at: 100 }), 50);
eq('D 両方あり → 取得日時が新しい取込値',
   chartMonthlySales({ last_monthly_sales: 50, last_monthly_sales_at: 100, imp_monthly_sales: 100, imported_at: 200 }), 100);
eq('D Keepa取込のみ', chartMonthlySales({ imp_monthly_sales: 100, imported_at: 5 }), 100);
eq('D どちらも無し → null', chartMonthlySales({}), null);

const queriesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'db', 'queries.js'), 'utf8');
ok('D queries: getMonitoringChartData が pickMonthlySales を使う',
   queriesSrc.includes('pickMonthlySales(product).value'));
ok('D queries: monthlySalesEffective も pickMonthlySales を使う',
   queriesSrc.includes('result.monthlySalesEffective = pickMonthlySales(product).value'));

// ── E) チャート右パネル「月間売行き個数」整形 (formatSalesCountLine、項目B5) ──
// 通知本文と同じ整形済み文字列。月間販売数→「+N個」、無ければ30日ランク変動→「N個」。
const { formatSalesCountLine } = require(path.join('..', 'src', 'shared', 'monthly-sales.js'));
eq('E 月間販売数あり → +50個',    formatSalesCountLine({ last_monthly_sales: 50, last_monthly_sales_at: 1 }), '+50個');
eq('E 月間販売数1000 → +1,000個', formatSalesCountLine({ imp_monthly_sales: 1000, imported_at: 1 }), '+1,000個');
eq('E 月間販売数なし → 30日ランク変動 50個', formatSalesCountLine({ imp_rank_drop_30d: 50 }), '50個');
eq('E 両方なし → null',           formatSalesCountLine({}), null);
ok('E renderer: チャート凡例が data.salesLine を使用', rendererSrc.includes('data.salesLine'));
ok('E queries: getMonitoringChartData が salesLine を返す', queriesSrc.includes('salesLine:    salesLineOut'));
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
ok('E index.html: 詳細グラフ凡例ラベルが「月間売行き個数」',
   /<div class="chart-legend-label">月間売行き個数<\/div>/.test(indexHtml));

// ── F) スキーマ (実 migrations) ────────────────────────────────────────────
const db = new DatabaseSync(':memory:');
runMigrations(db);
const cols = db.prepare('PRAGMA table_info(products)').all().map((r) => r.name);
ok('F imp_monthly_sales 列が存在',      cols.includes('imp_monthly_sales'));
ok('F last_monthly_sales 列が存在',     cols.includes('last_monthly_sales'));
ok('F last_monthly_sales_at 列が存在 (項目3)', cols.includes('last_monthly_sales_at'));
// 永続化の確認。
db.prepare('INSERT INTO products (asin, added_at, imp_monthly_sales, imported_at) VALUES (?, ?, ?, ?)').run('B000000009', 1, 100, 500);
const got = db.prepare('SELECT imp_monthly_sales AS v FROM products WHERE asin = ?').get('B000000009');
eq('F imp_monthly_sales 永続化 = 100', got.v, 100);
// 監視値を「より新しい取得日時」で入れると最新取得値は監視値に切替わる (項目3)。
db.prepare('UPDATE products SET last_monthly_sales = ?, last_monthly_sales_at = ? WHERE asin = ?').run(50, 900, 'B000000009');
const got2 = db.prepare('SELECT last_monthly_sales, last_monthly_sales_at, imp_monthly_sales, imported_at FROM products WHERE asin = ?').get('B000000009');
eq('F 最新取得値 (監視900>取込500) = 50', chartMonthlySales(got2), 50);
// 取込側の方が新しければ取込値を採用。
db.prepare('UPDATE products SET imported_at = ? WHERE asin = ?').run(1000, 'B000000009');
const got3 = db.prepare('SELECT last_monthly_sales, last_monthly_sales_at, imp_monthly_sales, imported_at FROM products WHERE asin = ?').get('B000000009');
eq('F 最新取得値 (取込1000>監視900) = 100', chartMonthlySales(got3), 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
