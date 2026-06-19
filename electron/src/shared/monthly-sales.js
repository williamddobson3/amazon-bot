'use strict';

//
// 月間販売数の「最新取得値」選択 (2026-06 client spec 項目3)。
//
// 月間販売数 (Amazon が公表する「過去1か月で○○点以上購入」のまるめ値) は
// 2 経路で取得される:
//   - Amazon 監視クロール : products.last_monthly_sales   (取得日時 last_monthly_sales_at)
//   - Keepa/CSV 取込      : products.imp_monthly_sales    (取得日時 imported_at)
//
// 旧仕様は「監視値優先・無ければ取込値」の固定優先だったが、クライアント要望で
// 「常に取得日時が新しい方を表示」に変更。両方値があれば取得日時の新しい方、
// 片方のみ値があればそれを採用する。タイムスタンプが未記録 (旧データ) の場合は
// 0 (= 最古) 扱いとし、同時刻なら監視値 (直接スクレイプ) を優先する。
//
// ※ renderer.js の pickMonthlySales と同じロジック。片方だけ変更しないこと
//   (passesAllConditions / fnm-eval と同様の「二重実装・要同期」方針)。
//
function pickMonthlySales(product) {
  if (!product) return { value: null, source: null };
  const liveVal = product.last_monthly_sales;
  const liveTs  = product.last_monthly_sales_at;
  const impVal  = product.imp_monthly_sales;
  const impTs   = product.imported_at;
  const liveHas = liveVal != null;
  const impHas  = impVal != null;
  if (liveHas && impHas) {
    return ((liveTs || 0) >= (impTs || 0))
      ? { value: liveVal, source: 'monitor' }
      : { value: impVal,  source: 'import' };
  }
  if (liveHas) return { value: liveVal, source: 'monitor' };
  if (impHas)  return { value: impVal,  source: 'import' };
  return { value: null, source: null };
}

//
// 「月間売行き個数」表示文字列 (2026-06 client spec 項目2 / B5) — 通知本文と
// 詳細グラフ右パネルで共通。月間販売数 (pickMonthlySales) があればそれを優先し
// 頭に「+」を付ける (例「+50個」)。無ければ 30日ランク変動(取込)
// imp_rank_drop_30d を「+」なしで表示 (例「50個」)。両方無ければ null
// (呼び出し側で「—」を表示する)。
//
function formatSalesCountLine(product) {
  const ms = pickMonthlySales(product).value;
  if (ms != null) return `+${Number(ms).toLocaleString('ja-JP')}個`;
  const rd = product ? product.imp_rank_drop_30d : null;
  if (rd != null) return `${Number(rd).toLocaleString('ja-JP')}個`;
  return null;
}

module.exports = { pickMonthlySales, formatSalesCountLine };
