'use strict';

//
// ════════════════════════════════════════════════════════════════════
//  手数料・サイズ区分 計算 — JS 側プラム配管 (fee-calc)
// ════════════════════════════════════════════════════════════════════
//
// ★ 機密のため、手数料・サイズ区分の計算ロジック本体 (カテゴリ別料率表 /
//   FBA 料金表 / サイズ判定 / ブランド表 / 各種閾値・係数) は、コンパイル
//   済み Rust addon (crawler/src/fee.rs の compute_fees、strip + LTO 済み)
//   に移管した。JS にはここに残す
//     ・CSV / Keepa API → keepaItem への列マッピングと値抽出
//     ・Rust への受け渡し (computeFees)
//   のみが含まれ、計算式そのものは一切 JS 内に存在しない。
//
//   実際の計算関数は main プロセス起動時に setFeeComputer() で
//   crawler-bridge.computeFees (= Rust addon 呼び出し) を注入する。
//   (renderer / 単体テストでは別途 setFeeComputer で差し替え可能。)
//

// ── CSV 列 → keepaItem パラメータ名 のマッピング ────────────────────
// （クライアント添付「KeepaExport-2026-05-23_パラメータ名追記.csv」の
//   2 行目に記載されたパラメータ名。CSV ヘッダー(1 行目)の日本語列名で
//   引けるよう日本語→パラメータ名で持つ。renderer 側の CSV パーサと
//   ipc-handlers が参照する単一の真実源。）これは列名対応表であって
//   計算ロジックではないため JS に残す。
const KEEPA_CSV_COLUMN_MAP = {
  // 計算入力 (Group B)
  'FBA Pick&Pack 料金':                 'fbaPickAndPackFee',
  'カテゴリ: ルート':                    'rootCategory',
  'カテゴリ: サブ':                      'categories',
  'カテゴリ: ツリー':                    'categoryTree',
  'ブランド':                            'brand',
  'パッケージ: 長さ (cm)':               'packageLength',
  'パッケージ: 幅 (cm)':                 'packageWidth',
  'パッケージ: 高さ (cm)':               'packageHeight',
  'パッケージ: 重さ (g)':                'packageWeight',
  '商品: 長さ (cm)':                     'itemLength',
  '商品: 幅 (cm)':                       'itemWidth',
  '商品: 高さ (cm)':                     'itemHeight',
  '商品: 重さ (g)':                      'itemWeight',
  '紹介料％':                            'referralFeePercent',
  '現在のBuy Box価格に基づく紹介料':     'referralFeeBasedOnCurrentBuyBoxPrice',
  // 直接表示 (Group A) — fee 計算では salesPrice / 表示に使用
  'Buy Box: 現在価格':                   'buyBoxCurrent',
  'Buy Box: 30 日平均':                  'buyBox30d',
  'Buy Box: 90 日平均':                  'buyBox90d',
  'Buy Box: 180 日平均':                 'buyBox180d',
  'Amazon: 現在価格':                    'amazonCurrent',
  '新品: 現在価格':                      'newCurrentPrice',
  '新品アイテム数: 現在価格':            'newItemCount',
  '売れ筋ランキング: 現在価格':          'salesRank',
  '売れ筋ランキング: 過去30日間の減少':  'salesRankDrop30d',
  '月間売上トレンド: 先月の購入':        'monthlySales',
};

//
// 数字の文字列を数値に変換。変換できない場合は -1、空なら null。
//
function formatStrToNumber(numberStr) {
  let ret = numberStr;
  if (ret == null) return null;
  // 全角→半角に正規化してから記号を除去する。CSV / Excel 経由のセルには
  // 全角数字(０-９)・全角％・全角￥・全角，．／ が混じり得る。NFKC で
  // これらを ASCII 化しておかないと Number() で NaN(=-1) になり、値が在る
  // のに「欠損」扱いされてしまう (search-parser.js と同じ正規化方針)。
  ret = String(ret).normalize('NFKC');
  if (ret.trim() === '') return null;

  ret = ret
    .replace(/¥/g, '')
    .replace(/%/g, '')
    .replace(/#/g, '')
    .replace(/\//g, '')
    .replace(/,/g, '')
    .trim();

  if (ret === '' || isNaN(ret)) return -1;
  return Number(ret);
}

//
// CSV の 1 行(パラメータ名→値) から keepaItem を構築する。
// 元 scraping.js の scrapingKeepaDatasV2 に相当するが、HTML ではなく
// CSV プレーンテキストを入力とする。これは列値の抽出・整形であって
// 手数料計算ではないため JS に残す。
//
function buildKeepaItemFromCsv(row) {
  const num = (k) => formatStrToNumber(row[k]);

  // カテゴリ: ツリーは「A › B › C」形式。区切り(全角›/半角>)で分解。
  const treeRaw = row.categoryTree != null ? String(row.categoryTree) : '';
  const categoryTreeList = treeRaw
    ? treeRaw.split(/›|＞|>/).map((s) => s.trim()).filter(Boolean)
    : [];

  // カテゴリ: サブは複数の可能性 (カンマ区切り) を許容。
  const subRaw = row.categories != null ? String(row.categories) : '';
  const categories = subRaw
    ? subRaw.split(/,|、/).map((s) => s.trim()).filter(Boolean)
    : [];

  const rootCategory = row.rootCategory != null ? String(row.rootCategory).trim() : '';

  // referralFeeBasedOnCurrentBuyBoxPrice は通貨記号付きの場合がある。
  let referralFeeBuyBox = null;
  if (row.referralFeeBasedOnCurrentBuyBoxPrice != null
      && String(row.referralFeeBasedOnCurrentBuyBoxPrice).trim() !== '') {
    const cleaned = String(row.referralFeeBasedOnCurrentBuyBoxPrice)
      .normalize('NFKC').replace(/¥|%|,/g, '').trim();
    referralFeeBuyBox = isNaN(cleaned) ? -1 : Number(cleaned);
  }

  return {
    packageLength: num('packageLength'),
    packageWidth:  num('packageWidth'),
    packageHeight: num('packageHeight'),
    packageWeight: num('packageWeight'),

    itemLength: num('itemLength'),
    itemWidth:  num('itemWidth'),
    itemHeight: num('itemHeight'),
    itemWeight: num('itemWeight'),

    fbaPickAndPackFee: num('fbaPickAndPackFee'),

    referralFeePercent: num('referralFeePercent'),
    referralFeeBasedOnCurrentBuyBoxPrice: referralFeeBuyBox,

    rootCategory,
    categories,
    categoryTreeList,

    // 元コードでは rootCategory を productGroup にも流用していた。
    productGroup: rootCategory,
    brand: row.brand != null ? String(row.brand).trim() : '',
  };
}

// ── 機密計算 (Rust) への委譲 ──────────────────────────────────────
//
// 計算ロジック本体は Rust addon 内。main 起動時に
//   feeCalc.setFeeComputer(require('./crawler-bridge').computeFees)
// で注入する。computeFees(keepaItem, salesPrice, settings) は
//   { sizeKubun, fbaFee, inventoryStorageFee, amazonFee }
// を返す。
let _feeComputer = null;

function setFeeComputer(fn) {
  _feeComputer = typeof fn === 'function' ? fn : null;
}

function computeFees(keepaItem, salesPrice, settings) {
  if (typeof _feeComputer !== 'function') {
    throw new Error(
      'fee-calc: 手数料計算エンジン(Rust)が未初期化です。' +
      'main 起動時に setFeeComputer(crawlerBridge.computeFees) を呼んでください。'
    );
  }
  return _feeComputer(keepaItem, salesPrice, settings);
}

// 数値クリーン: -1(無効) や null は null に、それ以外は数値で返す。
function cleanNum(v) {
  const n = (typeof v === 'number') ? v : formatStrToNumber(v);
  return (n == null || n < 0) ? null : n;
}
function cleanInt(v) {
  const n = cleanNum(v);
  return n == null ? null : Math.round(n);
}

// 手数料計算に使う salesPrice を決める。
//   1. Buy Box: 現在価格
//   2. 無ければ Buy Box: 90 日平均
//   3. それも無ければ 紹介料 ÷ 紹介料% × 100 で逆算
//   4. それも無ければ 監視中の現在価格 (last_price) ← fallbackPrice
//   5. すべて無ければ 0
function pickSalesPrice(keepaItem, params, fallbackPrice) {
  const bb = formatStrToNumber(params.buyBoxCurrent);
  if (bb != null && bb > 0) return bb;
  const bb90 = formatStrToNumber(params.buyBox90d);
  if (bb90 != null && bb90 > 0) return bb90;
  const fee = keepaItem.referralFeeBasedOnCurrentBuyBoxPrice;
  const pct = keepaItem.referralFeePercent;
  if (fee != null && fee > 0 && pct != null && pct > 0) return (fee / pct) * 100;
  // ★ CSV/Keepa に価格が一切無い行は、アプリが監視中の現在価格 (last_price) を
  // 最終フォールバックに使う (2026-06, client報告 B0BN7B9FKK)。これが無いと
  // salesPrice=0 になり、Amazon販売手数料が ¥30 下限 (×1.1=¥33) に、FBA販売手数料が
  // 「¥1000以下」テーブル (標準4=371) に化けていた。監視価格を渡せば正しい料率
  // (紹介料% × 価格) と正しいサイズ料金帯 (>¥1000 → 標準4=420) で算出される。
  if (fallbackPrice != null && fallbackPrice > 0) return fallbackPrice;
  return 0;
}

//
// CSV の 1 行(パラメータ名→値マップ) から、DB 保存用レコード(asin 以外)を
// 構築する。インポート直値(Group A) + 計算入力(Group B) + 計算結果(C, Rust)
// をすべて含む。ipc-handlers の importProductsWithKeepaData から呼ばれる。
//
function buildImportRecord(params, settings, fallbackPrice) {
  const keepaItem = buildKeepaItemFromCsv(params);
  const salesPrice = pickSalesPrice(keepaItem, params, fallbackPrice);

  // 計算に使える Keepa 入力が一つも無い行(= ASIN しか無い CSV 等)では
  // 手数料/サイズ区分を算出しない (誤った既定値を保存しないため)。
  const hasFeeInputs =
    !!keepaItem.rootCategory ||
    keepaItem.referralFeeBasedOnCurrentBuyBoxPrice != null ||
    cleanNum(keepaItem.packageLength) != null ||
    cleanNum(keepaItem.itemLength) != null ||
    cleanNum(keepaItem.fbaPickAndPackFee) != null;

  const fees = hasFeeInputs
    ? computeFees(keepaItem, salesPrice, settings)     // ← Rust addon
    : { sizeKubun: null, amazonFee: null, fbaFee: null, inventoryStorageFee: null };

  return {
    // (A) インポート直値
    sellers:       cleanInt(params.newItemCount),
    buyboxCurrent: salesPrice > 0 ? Math.round(salesPrice) : null,
    // 表示シード (2026-06 spec 項目5): アプリリストの「BuyBox価格」/「最新実質
    // BuyBox価格」列に、CSV「Buy Box: 現在価格」の素の値をそのまま初期表示する
    // ための値。fee 計算用 salesPrice(90日平均/逆算へフォールバックし得る)とは
    // 区別し、現在価格が空なら null (= シードしない)。ポイント・送料は 0 扱い。
    displayBuyboxCurrent: cleanInt(params.buyBoxCurrent),
    // 新品: 現在価格 (項目20): BuyBox現在価格が空の時のシード代替値。
    newCurrentPrice: cleanInt(params.newCurrentPrice),
    buybox30d:     cleanInt(params.buyBox30d),
    buybox90d:     cleanInt(params.buyBox90d),
    buybox180d:    cleanInt(params.buyBox180d),
    // Ama本体価格 (項目14): CSV「Amazon: 現在価格」列の値。空白/「-」→ null。
    // hasAmazonField = その列が CSV に存在したか (空白でも true / 列無しは false)。
    // 列があれば imp_amazon_current を上書き + 監視点を記録、無ければ据え置き。
    amazonCurrent:  cleanInt(params.amazonCurrent),
    hasAmazonField: Object.prototype.hasOwnProperty.call(params, 'amazonCurrent'),
    monthlySales:  cleanInt(params.monthlySales),
    rank:          cleanInt(params.salesRank),
    rankDrop30d:   cleanInt(params.salesRankDrop30d),
    // (B) 計算入力(原値)
    rootCategory: keepaItem.rootCategory || null,
    subCategory:  (keepaItem.categories || []).join(',') || null,
    categoryTree: (keepaItem.categoryTreeList || []).join(' › ') || null,
    brand:        keepaItem.brand || null,
    fbaPickpack:    cleanNum(keepaItem.fbaPickAndPackFee),
    referralPct:    cleanNum(keepaItem.referralFeePercent),
    referralBuybox: cleanNum(keepaItem.referralFeeBasedOnCurrentBuyBoxPrice),
    pkgLength: cleanNum(keepaItem.packageLength),
    pkgWidth:  cleanNum(keepaItem.packageWidth),
    pkgHeight: cleanNum(keepaItem.packageHeight),
    pkgWeight: cleanNum(keepaItem.packageWeight),
    itemLength: cleanNum(keepaItem.itemLength),
    itemWidth:  cleanNum(keepaItem.itemWidth),
    itemHeight: cleanNum(keepaItem.itemHeight),
    itemWeight: cleanNum(keepaItem.itemWeight),
    // (C) 計算結果 (Rust)
    sizeKubun:           fees.sizeKubun || null,
    amazonFee:           fees.amazonFee,
    fbaFee:              fees.fbaFee,
    inventoryStorageFee: fees.inventoryStorageFee,
  };
}

// ── 監視クロール時の Amazon 販売手数料 再計算 (2026-06, client要望) ──────
//
// クライアント仕様: 「Amazon販売手数料 = 最新の『BuyBox価格』× 最新の『紹介料%』
// × 1.1」。
//   ・最新の『BuyBox価格』= 監視クロールで数十分おきに更新される素の last_price
//     (『最新実質BuyBox価格』= 価格−ポイント+送料 ではないことに注意)。
//   ・最新の『紹介料%』= CSV インポート値 / Keepa API 取得値のうち各商品ごとに
//     一番直近で保持している imp_referral_pct。
// インポート時に確定させた amazon_fee は価格更新に追従しないため、価格が変わる
// たびに本関数で再計算する (scheduler の updateProductAfterScrape 経路)。
//
// 機密の計算式は Rust (computeFees) に委譲する。referralFeeBasedOnCurrentBuyBox
// Price を渡さないことで Rust 側の補完ロジックが「salesPrice × referralFeePercent
// / 100」(= 紹介料率 × 最新価格) を採用し、最新価格に追従する。¥30 下限・消費税
// 1.1・端数処理はすべて Rust と同一。settings は FBA サイズ計算専用で Amazon
// 手数料には影響しないため {} で良い。紹介料% か価格が無ければ null を返し、
// 呼び出し側はインポート時の値を維持する。
function computeLiveAmazonFee(lastPrice, referralPct) {
  const price = cleanNum(lastPrice);
  const pct   = cleanNum(referralPct);
  if (price == null || price <= 0 || pct == null || pct <= 0) return null;
  try {
    const fees = computeFees({ referralFeePercent: pct }, price, {});
    return fees && fees.amazonFee != null ? fees.amazonFee : null;
  } catch {
    // 計算エンジン未初期化など — インポート値を維持させる。
    return null;
  }
}

module.exports = {
  KEEPA_CSV_COLUMN_MAP,
  formatStrToNumber,
  buildKeepaItemFromCsv,
  setFeeComputer,
  computeFees,
  computeLiveAmazonFee,
  pickSalesPrice,
  buildImportRecord,
};
