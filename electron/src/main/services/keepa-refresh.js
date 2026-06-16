'use strict';

//
// Keepa API 定期更新ジョブ (2026-06 spec 項目8)。
//
// インポート済みの取得情報を「数日に1回程度の低頻度」で自動更新する。
// Keepa Pro の API レート (1 トークン/分 ≈ 1,440/日) と buybox 付き
// 3 トークン/ASIN という制約に合わせ、トークンバケットを使い切らないよう
// 自動でペース配分する。1 ASIN を約 CADENCE_DAYS 日に 1 回更新する。
//
// 流れ: 最古取得の ASIN を少数だけ取り出す → Keepa /product を叩く →
// keepa-api.mapProductToParams → fee-calc.buildImportRecord →
// queries.importProductsWithKeepaData (= CSV インポートと同じ保存経路)。
//

const Q = require('../db/queries');
const fee = require('./fee-calc');
const { loadFeeSettings } = require('./fee-settings');
const keepa = require('./keepa-api');

const TICK_MS           = 10 * 60 * 1000;   // 10 分ごとに 1 バッチ検討
const FIRST_RUN_DELAY_MS = 60 * 1000;       // 起動 1 分後に初回
const CADENCE_DAYS      = 3;                 // 各 ASIN を約 3 日に 1 回更新
const TOKENS_PER_ASIN   = keepa.tokensPerAsin(true);   // buybox 付き = 3
const TOKEN_RESERVE     = 10;               // バケットを使い切らない余裕
const MAX_BATCH         = 100;              // Keepa 1 リクエスト上限
const ASSUMED_FULL_BUCKET = 60;             // 初回のトークン残見積り(Pro は ~60)

let timer = null;
let busy = false;

// トークン会計 — Keepa レスポンスの tokensLeft / refillRate から推定し続ける。
let estTokens = null;       // 直近に判明した残トークン
let lastTokenAt = 0;        // その時刻
let refillRate = 1;         // tokens/min (レスポンスで上書き)
let lastResult = null;      // 直近バッチ結果 (UI 表示用)

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, FIRST_RUN_DELAY_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// 現時点で使える(と推定される)トークン量。
function availableTokens() {
  if (estTokens == null) return ASSUMED_FULL_BUCKET;
  const mins = (Date.now() - lastTokenAt) / 60_000;
  return estTokens + mins * refillRate;
}

async function runBatch(opts = {}) {
  const key = Q.getSetting('keepaApiKey');
  if (!keepa.isConfigured(key)) return { skipped: 'no-key' };

  // 予算 → 何 ASIN 取得できるか。
  const budget = availableTokens() - TOKEN_RESERVE;
  const affordable = Math.floor(budget / TOKENS_PER_ASIN);
  if (affordable < 1) return { skipped: 'no-tokens', tokensEst: Math.round(availableTokens()) };

  const batchSize = Math.min(MAX_BATCH, affordable);
  // 自動ティックは CADENCE_DAYS より古い(または未取込)商品だけを対象にして
  // トークンを節約する。手動「今すぐ更新」(opts.force) は鮮度を無視し、
  // 最も古い順に即更新する (= 押せば必ず何か更新される)。
  const staleBefore = opts.force ? Date.now() : (Date.now() - CADENCE_DAYS * 86_400_000);
  const asins = Q.getAsinsForKeepaRefresh(batchSize, staleBefore);
  if (asins.length === 0) return { skipped: 'nothing-stale' };

  const settings = loadFeeSettings(Q);
  const resp = await keepa.fetchProducts(asins, { key });

  // トークン会計を更新。
  if (resp && typeof resp.tokensLeft === 'number') { estTokens = resp.tokensLeft; lastTokenAt = Date.now(); }
  if (resp && typeof resp.refillRate === 'number' && resp.refillRate > 0) refillRate = resp.refillRate;

  if (resp && resp.error) {
    const msg = (resp.error && (resp.error.message || resp.error.type)) || 'Keepa error';
    return { error: String(msg), tokensLeft: resp.tokensLeft };
  }

  const products = (resp && resp.products) || [];
  const records = [];
  const returned = new Set();
  for (const p of products) {
    if (!p || !p.asin) continue;
    returned.add(p.asin);
    try {
      // Keepa に BuyBox 価格が無い場合も、監視中の現在価格を salesPrice フォール
      // バックに使う (CSV インポートと同じ手数料補正、2026-06)。
      const existing = Q.getProduct(p.asin);
      const fallbackPrice = existing && existing.last_price != null ? existing.last_price : null;
      const rec = fee.buildImportRecord(keepa.mapProductToParams(p), settings, fallbackPrice);
      rec.asin = p.asin;
      records.push(rec);
    } catch { /* 1 商品の失敗は無視 */ }
  }
  if (records.length) Q.importProductsWithKeepaData(records, 'keepa');

  // Keepa が返さなかった ASIN も imported_at を更新してローテーション。
  const missing = asins.filter((a) => !returned.has(a));
  if (missing.length) Q.markKeepaRefreshed(missing, Date.now());

  return {
    refreshed: records.length,
    missing: missing.length,
    requested: asins.length,
    tokensLeft: resp ? resp.tokensLeft : null,
  };
}

async function tick(opts = {}) {
  if (busy) return lastResult;
  busy = true;
  try {
    const r = await runBatch(opts);
    lastResult = { at: Date.now(), ...r };
  } catch (e) {
    lastResult = { at: Date.now(), error: e.message };
  } finally {
    busy = false;
  }
  return lastResult;
}

// UI 表示用ステータス。
function getStatus() {
  const key = Q.getSetting('keepaApiKey');
  let queuePreview = 0;
  try {
    const staleBefore = Date.now() - CADENCE_DAYS * 86_400_000;
    // MAX_BATCH 上限なので「100」は「100 件以上」を意味する目安。
    queuePreview = Q.getAsinsForKeepaRefresh(MAX_BATCH, staleBefore).length;
  } catch { /* noop */ }
  return {
    configured: keepa.isConfigured(key),
    running: !!timer,
    busy,
    tokensEst: estTokens == null ? null : Math.round(availableTokens()),
    cadenceDays: CADENCE_DAYS,
    tokensPerAsin: TOKENS_PER_ASIN,
    queuePreview,
    last: lastResult,
  };
}

// 手動「今すぐ更新」— 鮮度フィルタを無視して 1 バッチだけ即時実行する。
async function runOnce() {
  return tick({ force: true });
}

module.exports = { start, stop, runOnce, getStatus };
