'use strict';

//
// FNM 条件評価ロジック (main プロセス用バックストップ)。
//
// 通知の最終判定を main プロセスでも「現在保存されているスロット条件」+
// 「最新 stats」で再評価するために使う (2026-06 fix)。renderer の評価キャッシュ
// が古い・アプリが多重起動している等で、条件を満たさない商品の誤通知が来ても、
// ここで弾けるようにする。ロジックは renderer.js の inRange / computeDropRate /
// passesAllConditions と一致させること (片方だけ変更しないこと)。
//

// 下落率フォールバック連鎖 (renderer の DROP_RATE_FALLBACK と一致)。
const DROP_RATE_FALLBACK = {
  d180: ['avg180d', 'avg90d', 'avg30d', 'avg7d', 'avg1d', 'avgAll'],
  d90:  ['avg90d',  'avg30d', 'avg7d',  'avg1d',  'avgAll'],
  d30:  ['avg30d',  'avg7d',  'avg1d',  'avgAll'],
  d7:   ['avg7d',   'avg1d',  'avgAll'],
  d1:   ['avg1d',   'avgAll'],
};

const DROP_RATE_KEYS = ['instant', 'd1', 'd7', 'd30', 'd90', 'd180', 'd7m180'];
const MP_COUNT_MAP = { d7: 'mpCountAvg7d', d30: 'mpCountAvg30d', d90: 'mpCountAvg90d', d180: 'mpCountAvg180d' };

function inRange(val, range) {
  if (val == null) return false;
  const min = (range.min == null || !isFinite(range.min)) ? -Infinity : range.min;
  const max = (range.max == null || !isFinite(range.max)) ?  Infinity : range.max;
  return val >= min && val <= max;
}

// 「enabled かつ min/max のどちらかが有限」= 実質的な範囲指定がある条件か。
// enabled だが min も max も未設定の条件は「全件マッチ」になり通知が暴発する
// ため、通知の有効条件としては数えない (誤設定スロットの抑止)。
function rangeHasBound(r) {
  if (!r || !r.enabled) return false;
  const minSet = r.min != null && isFinite(r.min);
  const maxSet = r.max != null && isFinite(r.max);
  return minSet || maxSet;
}

function computeDropRate(stats, latestEffective, key) {
  if (latestEffective == null || !isFinite(latestEffective)) return null;
  if (key === 'd7m180') {
    const r7 = computeDropRate(stats, latestEffective, 'd7');
    const r180 = computeDropRate(stats, latestEffective, 'd180');
    return (r7 == null || r180 == null) ? null : (r7 - r180);
  }
  if (key === 'instant') {
    const prev = stats ? stats.prevEffective : null;
    if (prev == null || !isFinite(prev) || prev === 0) return null;
    return ((prev - latestEffective) / prev) * 100;
  }
  const chain = DROP_RATE_FALLBACK[key] || [];
  for (const k of chain) {
    const v = stats ? stats[k] : null;
    if (v != null && isFinite(v) && v !== 0) {
      return ((v - latestEffective) / v) * 100;
    }
  }
  return null;
}

// stats 由来の条件 (下落率 + 出品者数平均/現在) がすべて通るか。
// latestEffective は stats.latestEffective を渡す (renderer と同じ単一ソース)。
function statsConditionsPass(stats, latestEffective, state) {
  if (!state) return true;
  if (state.dropRate) {
    for (const key of DROP_RATE_KEYS) {
      const r = state.dropRate[key];
      if (!r || !r.enabled) continue;
      const rate = computeDropRate(stats, latestEffective, key);
      if (!inRange(rate, r)) return false;
    }
  }
  // 全出品数(内訳) mpCount は 2026-06 spec 項目17 で撤去。renderer 側と同様、
  // 旧保存スロットに enabled が残っていても評価しない (= 通知判定でも無効)。
  return true;
}

// 通知発火に値する「実質的な条件」が1つでもあるか。enabled でも min/max が
// 全く無い (= 全件マッチ) だけのスロットは通知させない。
function hasFireableBound(state) {
  if (!state) return false;
  if (state.dropRate) for (const k of DROP_RATE_KEYS) if (rangeHasBound(state.dropRate[k])) return true;
  // 全出品数(内訳) mpCount は項目17 で撤去 — fireable 条件として数えない。
  if (state.ranges)   for (const k of Object.keys(state.ranges)) if (rangeHasBound(state.ranges[k])) return true;
  if (state.keyword) {
    for (const k of ['asinInclude', 'asinExclude', 'titleInclude', 'titleExclude']) {
      const v = state.keyword[k];
      if (v && v.enabled && v.query && v.query.trim() !== '') return true;
    }
  }
  return false;
}

module.exports = {
  inRange,
  computeDropRate,
  statsConditionsPass,
  hasFireableBound,
  rangeHasBound,
  DROP_RATE_FALLBACK,
};
