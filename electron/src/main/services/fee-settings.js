'use strict';

//
// fee-calc が要求する設定値のデフォルト。
//
// getFbaFee はサイズ区分名に「クリックポスト,」「ネコポス,」の接頭辞を
// 付けるため、両配送方法の寸法・重量上限を必要とする (FBA 手数料の金額
// 自体には影響しない)。値は日本郵便クリックポスト / ヤマトネコポスの
// 標準規格に基づく。ユーザーが将来 UI で調整できるよう、settings テーブル
// の 'feeSettings' キー (JSON) に保存された上書き値があればマージする。
//
const DEFAULT_FEE_SETTINGS = {
  // クリックポスト (長さ34cm / 幅25cm / 厚さ3cm / 1kg)。
  // sizeList は昇順 → [厚さ, 幅, 長さ] の順で判定される。
  clickpostLength1: 34,   // 最長辺
  clickpostLength2: 25,   // 中間辺
  clickpostLength3: 3,    // 最短辺(厚さ)
  clickpostWeight:  1,    // kg

  // ネコポス (角形A4: 31.2 × 22.8 / 厚さ3cm / 1kg)。
  // 中間辺上限 = nekoposTotalLength − nekoposShortest − nekoposLongest
  //            = 57 − 3 − 31.2 = 22.8
  nekoposLongest:     31.2,
  nekoposShortest:    3,
  nekoposTotalLength: 57,
  nekoposWeight:      1,
};

// settings テーブルから 'feeSettings'(JSON) を読み、デフォルトにマージ。
// Q は db/queries モジュール (getSetting を持つ) を想定。読み込み失敗時は
// デフォルトをそのまま返す。
function loadFeeSettings(Q) {
  let merged = { ...DEFAULT_FEE_SETTINGS };
  try {
    const raw = Q && typeof Q.getSetting === 'function' ? Q.getSetting('feeSettings') : null;
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') merged = { ...merged, ...obj };
    }
  } catch { /* デフォルトのまま */ }
  return merged;
}

module.exports = { DEFAULT_FEE_SETTINGS, loadFeeSettings };
