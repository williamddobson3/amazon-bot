'use strict';

//
// Keepa Product API クライアント (2026-06 spec 項目8)。
//
// インポート情報を定期更新するため、Keepa の /product エンドポイントを叩いて
// 各 ASIN の最新データを取得し、CSV インポートと同じパラメータ名のマップに
// 変換する。変換結果は fee-calc.buildImportRecord にそのまま渡せる。
//
// 検証済みフィールドマッピング (実 API レスポンス + クライアント CSV で確認):
//   - 寸法 packageLength 等は Keepa では mm → cm に変換 (÷10)。重さは g のまま。
//   - 価格は JPY では円そのまま (×100 ではない)。
//   - 紹介料% は referralFeePercentage (小数あり) を優先。
//   - Buy Box 価格/平均は stats index 18 (BUY_BOX_SHIPPING)。buybox=1 が必要
//     (+2 トークン/ASIN)。未取得時は NEW(index 1) でフォールバック。
//   - 出品者数(新品アイテム数) は stats index 11 (COUNT_NEW)。
//   - 月間販売数 は product.monthlySold、30日ランク変動 は stats.salesRankDrops30。
//
// トークン消費: stats=180&history=0 で 1/ASIN、buybox=1 を足すと 3/ASIN。
//

const https = require('https');
const zlib = require('zlib');

const KEEPA_HOST = 'api.keepa.com';
const DOMAIN_JP = 5;                 // Amazon.co.jp

// stats 配列のインデックス (Keepa price-type)。
const IDX = { AMAZON: 0, NEW: 1, SALES: 3, COUNT_NEW: 11, BUYBOX: 18 };

// buybox=1 を付けた場合の 1 ASIN あたりトークン消費 (実測)。
const TOKENS_PER_ASIN_BUYBOX = 3;
const TOKENS_PER_ASIN_BASE = 1;

function isConfigured(key) {
  return !!(key && String(key).trim());
}

// GET https://api.keepa.com<path> → 解析済み JSON。失敗時は reject。
// Keepa は応答を gzip 圧縮するため、Content-Encoding に応じて伸長する
// (https モジュールは fetch と違い自動伸長しない)。
function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: KEEPA_HOST, path, headers: { 'Accept-Encoding': 'gzip, deflate' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 429) { reject(new Error('Keepa rate limited (HTTP 429)')); return; }
          let buf = Buffer.concat(chunks);
          try {
            const enc = (res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip')      buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            resolve(JSON.parse(buf.toString('utf8')));
          } catch {
            reject(new Error(`Keepa response parse error (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Keepa request timeout')));
  });
}

// 最大 100 ASIN/リクエスト。レスポンスは
//   { products:[...], tokensLeft, refillIn, refillRate, tokensConsumed, error? }
async function fetchProducts(asins, opts = {}) {
  const key = opts.key;
  const domain = opts.domain || DOMAIN_JP;
  const buybox = opts.buybox === false ? 0 : 1;
  // ASIN は [A-Z0-9] のみ、key も英数字なので URL エンコード不要。
  const path = `/product?key=${key}&domain=${domain}`
    + `&asin=${asins.join(',')}&stats=180&history=0&buybox=${buybox}`;
  return httpGetJson(path);
}

// 1 ASIN あたりのトークン消費見積り。
function tokensPerAsin(buybox) {
  return buybox === false ? TOKENS_PER_ASIN_BASE : TOKENS_PER_ASIN_BUYBOX;
}

function pick(arr, i) {
  if (!Array.isArray(arr)) return null;
  const v = arr[i];
  return (v == null || v < 0) ? null : v;
}
function mm2cm(v) { return (v != null && v > 0) ? v / 10 : null; }   // Keepa は mm
function gramsOrNull(v) { return (v != null && v > 0) ? v : null; }  // Keepa は g

//
// Keepa product オブジェクト → CSV インポートと同じパラメータ名マップ。
// 戻り値は buildKeepaItemFromCsv / buildImportRecord にそのまま渡せる。
//
function mapProductToParams(p) {
  const s = p.stats || {};
  const cur = s.current || [];
  const a30 = s.avg30 || [];
  const a90 = s.avg90 || [];
  const a180 = s.avg180 || [];

  const catNames = (p.categoryTree || []).map((c) => c && c.name).filter(Boolean);

  // 紹介料%: 小数つき referralFeePercentage を優先、無ければ整数 referralFeePercent。
  const refPct = p.referralFeePercentage != null
    ? p.referralFeePercentage
    : (p.referralFeePercent != null ? p.referralFeePercent : null);

  // Buy Box (index 18)。buybox 未取得なら NEW(index 1) でフォールバック。
  const bbCur  = pick(cur, IDX.BUYBOX);
  const bb30   = pick(a30, IDX.BUYBOX);
  const bb90   = pick(a90, IDX.BUYBOX);
  const bb180  = pick(a180, IDX.BUYBOX);

  // Ama本体価格 (項目14): Amazon 直販の現在価格 (index 0)。Amazon本体が出品して
  // いない時 Keepa は -1 を返す → pick で null (= 「空白」)。追加トークンは不要
  // (stats=180 のレスポンスに含まれる)。毎回の取得が item15 の監視点になる。
  const amzCur = pick(cur, IDX.AMAZON);

  return {
    // ── 計算入力 (Group B) ──
    fbaPickAndPackFee: (p.fbaFees && p.fbaFees.pickAndPackFee != null) ? p.fbaFees.pickAndPackFee : null,
    rootCategory: catNames[0] || null,
    categories:   catNames.length ? catNames[catNames.length - 1] : null,   // サブ = 末端カテゴリ
    categoryTree: catNames.join(' › '),
    brand:        p.brand || null,
    packageLength: mm2cm(p.packageLength), packageWidth:  mm2cm(p.packageWidth),
    packageHeight: mm2cm(p.packageHeight), packageWeight: gramsOrNull(p.packageWeight),
    itemLength:    mm2cm(p.itemLength),    itemWidth:     mm2cm(p.itemWidth),
    itemHeight:    mm2cm(p.itemHeight),    itemWeight:    gramsOrNull(p.itemWeight),
    referralFeePercent: refPct,
    // Keepa は「現在のBuy Box価格に基づく紹介料」を直接返さない。null にして
    // おくと getAmazonFee が 紹介料% × BuyBox価格 で補完する (CSV と同値を確認)。
    referralFeeBasedOnCurrentBuyBoxPrice: null,

    // ── インポート直値 (Group A) ──
    buyBoxCurrent: bbCur != null ? bbCur : pick(cur, IDX.NEW),
    // Buy Box: 30 日平均 (項目26)。BuyBox 未取得なら新品(NEW)平均でフォールバック。
    buyBox30d:     bb30  != null ? bb30  : pick(a30, IDX.NEW),
    buyBox90d:     bb90  != null ? bb90  : pick(a90, IDX.NEW),
    buyBox180d:    bb180 != null ? bb180 : pick(a180, IDX.NEW),
    // 項目14: Amazon現在価格。null でもキーは常に存在させる (= hasAmazonField=true →
    // Keepa取得は毎回 item15 の監視点として記録される)。
    amazonCurrent: amzCur,
    newItemCount:  pick(cur, IDX.COUNT_NEW),
    salesRank:     pick(cur, IDX.SALES),
    salesRankDrop30d: (s.salesRankDrops30 != null && s.salesRankDrops30 >= 0) ? s.salesRankDrops30 : null,
    monthlySales:  (p.monthlySold != null && p.monthlySold >= 0) ? p.monthlySold : null,
  };
}

module.exports = {
  isConfigured,
  fetchProducts,
  mapProductToParams,
  tokensPerAsin,
  DOMAIN_JP,
  IDX,
};
