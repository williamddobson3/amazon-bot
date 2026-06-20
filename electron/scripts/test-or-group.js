'use strict';

//
// 「いずれか一つの条件でも合致すれば抽出」OR グループ (2026-06 client B9) のテスト。
//
// ランキング(取込)/月間販売数/30日ランク変動(取込) の3条件を、state.rankGroupOr が
// true のとき OR (1つでも一致で通過)、false のとき従来どおり AND で評価する。グループ
// 外の範囲条件は常に AND。passesAllConditions の ranges ループ該当部を写経して検証し、
// 併せて renderer.js の配線 (state/parse/capture/UI) をソース照合する。
//

const fs = require('fs');
const path = require('path');
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// ── passesAllConditions の ranges ループ (OR グループ部) を写経 ────────────────
const RANK_OR_GROUP_KEYS = ['impRank', 'monthlySales', 'impRankDrop'];
function inRange(v, r) {
  if (v == null) return false;
  const min = (r.min == null || !isFinite(r.min)) ? -Infinity : r.min;
  const max = (r.max == null || !isFinite(r.max)) ?  Infinity : r.max;
  return v >= min && v <= max;
}
const ROWS = [
  { key: 'impRank',      extract: (p) => p.impRank },
  { key: 'monthlySales', extract: (p) => p.monthlySales },
  { key: 'impRankDrop',  extract: (p) => p.impRankDrop },
  { key: 'price',        extract: (p) => p.price },     // グループ外 (常に AND)
];
function passesRanges(state, product) {
  const orOn = !!state.rankGroupOr;
  let grpEnabled = false, grpMatched = false;
  for (const row of ROWS) {
    const r = state.ranges[row.key];
    if (!r || !r.enabled) continue;
    const v = row.extract(product);
    const passes = inRange(v, r);
    if (orOn && RANK_OR_GROUP_KEYS.includes(row.key)) {
      grpEnabled = true;
      if (passes) grpMatched = true;
    } else if (!passes) {
      return false;
    }
  }
  if (orOn && grpEnabled && !grpMatched) return false;
  return true;
}

// 3条件: impRank≤100 / monthlySales≥50 / impRankDrop≥10。
const ranges3 = {
  impRank:      { enabled: true, min: null, max: 100 },
  monthlySales: { enabled: true, min: 50,   max: null },
  impRankDrop:  { enabled: true, min: 10,   max: null },
};
const A = { impRank: 50,  monthlySales: 10,  impRankDrop: 5 };   // impRank だけ一致
const B = { impRank: 200, monthlySales: 10,  impRankDrop: 5 };   // どれも不一致
const C = { impRank: 50,  monthlySales: 100, impRankDrop: 20 };  // 全部一致

// AND モード (rankGroupOr=false) — 全条件一致が必要。
eq('AND: 1つだけ一致 → 除外', passesRanges({ ranges: ranges3, rankGroupOr: false }, A), false);
eq('AND: どれも不一致 → 除外', passesRanges({ ranges: ranges3, rankGroupOr: false }, B), false);
eq('AND: 全部一致 → 抽出',    passesRanges({ ranges: ranges3, rankGroupOr: false }, C), true);

// OR モード (rankGroupOr=true) — 1つでも一致で抽出。
eq('OR: 1つ一致 → 抽出',      passesRanges({ ranges: ranges3, rankGroupOr: true }, A), true);
eq('OR: どれも不一致 → 除外', passesRanges({ ranges: ranges3, rankGroupOr: true }, B), false);
eq('OR: 全部一致 → 抽出',     passesRanges({ ranges: ranges3, rankGroupOr: true }, C), true);

// OR + グループ外条件 (price≥1000) は AND のまま効く。
const rangesWithPrice = Object.assign({}, ranges3, { price: { enabled: true, min: 1000, max: null } });
eq('OR + 価格条件NG → 除外 (グループ外は AND)',
   passesRanges({ ranges: rangesWithPrice, rankGroupOr: true }, Object.assign({}, A, { price: 500 })), false);
eq('OR + 価格条件OK + グループ1つ一致 → 抽出',
   passesRanges({ ranges: rangesWithPrice, rankGroupOr: true }, Object.assign({}, A, { price: 2000 })), true);

// OR ON だがグループ条件が未設定なら OR は無効果 (グループ外のみ評価)。
eq('OR ON・グループ無効・価格のみ一致 → 抽出',
   passesRanges({ ranges: { price: { enabled: true, min: 1000, max: null } }, rankGroupOr: true }, { price: 2000 }), true);

// null 値の条件は不一致扱い。OR では他で救済される。
eq('OR: monthlySales=null でも impRank一致なら抽出',
   passesRanges({ ranges: ranges3, rankGroupOr: true }, { impRank: 50, monthlySales: null, impRankDrop: null }), true);
eq('AND: monthlySales=null → 除外',
   passesRanges({ ranges: ranges3, rankGroupOr: false }, { impRank: 50, monthlySales: null, impRankDrop: 20 }), false);

// 部分的に有効: monthlySales のみ enabled の OR — その1条件で判定。
const onlyMs = { monthlySales: { enabled: true, min: 50, max: null } };
eq('OR: monthlySalesのみ有効・一致 → 抽出', passesRanges({ ranges: onlyMs, rankGroupOr: true }, { monthlySales: 80 }), true);
eq('OR: monthlySalesのみ有効・不一致 → 除外', passesRanges({ ranges: onlyMs, rankGroupOr: true }, { monthlySales: 10 }), false);

// ── ソース照合: renderer.js の配線 ───────────────────────────────────────────
ok('RANK_OR_GROUP_KEYS が impRank/monthlySales/impRankDrop',
   /const RANK_OR_GROUP_KEYS = \['impRank', 'monthlySales', 'impRankDrop'\]/.test(rendererSrc));
ok('passesAllConditions に OR 判定 (grpEnabled && !grpMatched)',
   rendererSrc.includes('if (orOn && grpEnabled && !grpMatched) return false;'));
ok('emptyFnmState に rankGroupOr: false', /rankGroupOr: false/.test(rendererSrc));
ok('parseFnmState が rankGroupOr を復元', rendererSrc.includes('out.rankGroupOr = !!data.rankGroupOr;'));
ok('captureFnmTabState が OR チェックを読む',
   rendererSrc.includes("document.querySelector('[data-fnm-rank-or]')") &&
   rendererSrc.includes('out.rankGroupOr = !!(orCb && orCb.checked);'));
ok('renderRangesGrid に OR グループ UI (data-fnm-rank-or)', rendererSrc.includes('data-fnm-rank-or'));
ok('OR グループのラベル文言', rendererSrc.includes('いずれか一つの条件でも'));
ok('OR グループの3行をまとめて描画', rendererSrc.includes("if (row.key === RANK_OR_GROUP_KEYS[0]) { html += orGroupHtml(); continue; }"));

// CSS
const stylesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
ok('CSS に .fnm-or-group', /\.fnm-or-group\s*\{/.test(stylesSrc));
ok('CSS に .fnm-or-rows (ブラケット風)', /\.fnm-or-rows\s*\{/.test(stylesSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
