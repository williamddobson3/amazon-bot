'use strict';

//
// おススメフィルタ プリセット (2026-06 client spec 項目18) のテスト。
//
//   ① 瞬間下落率 ≥1% + 30日ランク変動(取込) ≥10 + 新品出品数(取込) ≥2 +
//      FBA利益額(7/30/90日平均) ≥100円  / ※FBA利益額注記
//   ② ① から瞬間下落率を除いた版                         / ※FBA利益額注記
//   ③ 自動ゴミ捨て向け: 通知なし経過日数 ≥60日           / ※2行注記
//
// renderer.js はブラウザ文脈で直接 require できないため、RECOMMENDED_PRESETS の
// 定義ブロックをソースから抽出し、emptyFnmState をスタブして eval で実行し、
// build() が返す state を検証する (= 実コードの挙動テスト)。併せて、参照する
// range キーが RANGE_ROWS / PROFIT_PERIODS に実在することをソース照合で担保する
// (キー名のタイポで「フィルタが無言で効かない」事故を防ぐ)。
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

// ── 参照キーが実在するか (RANGE_ROWS / PROFIT_PERIODS) ───────────────────────
ok('RANGE_ROWS に impRankDrop (30日ランク変動)', /key: 'impRankDrop'/.test(rendererSrc));
ok('RANGE_ROWS に impSellers (新品出品数)',      /key: 'impSellers'/.test(rendererSrc));
ok('RANGE_ROWS に notifyGap (通知なし経過日数)', /key: 'notifyGap'/.test(rendererSrc));
ok('PROFIT_PERIODS に profitAmt7d',  /fA: 'profitAmt7d'/.test(rendererSrc));
ok('PROFIT_PERIODS に profitAmt30d', /fA: 'profitAmt30d'/.test(rendererSrc));
ok('PROFIT_PERIODS に profitAmt90d', /fA: 'profitAmt90d'/.test(rendererSrc));

// ── RECOMMENDED_PRESETS をソースから抽出して build() を実行 ───────────────────
const emptyFnmState = () => ({ dropRate: {}, ranges: {} });   // スタブ (空の器)
const start = rendererSrc.indexOf('const PROFIT_FILTER_RULES');
const end   = rendererSrc.indexOf('// Compute the drop rate', start);
ok('プリセット定義ブロックを抽出できた', start >= 0 && end > start);
const block = rendererSrc.slice(start, end);
// eslint-disable-next-line no-eval
const RECOMMENDED_PRESETS = eval(block + '\nRECOMMENDED_PRESETS;');

eq('プリセット数 = 3', RECOMMENDED_PRESETS.length, 3);
eq('① 名称', RECOMMENDED_PRESETS[0].name, 'おススメフィルタ①');
eq('② 名称', RECOMMENDED_PRESETS[1].name, 'おススメフィルタ②');
eq('③ 名称', RECOMMENDED_PRESETS[2].name, 'おススメフィルタ③（自動ゴミ捨て）');

// ① build()
const p1 = RECOMMENDED_PRESETS[0].build();
ok('① 瞬間下落率 enabled',  p1.dropRate.instant && p1.dropRate.instant.enabled);
eq('① 瞬間下落率 min=1',     p1.dropRate.instant.min, 1);
eq('① 瞬間下落率 max=null',  p1.dropRate.instant.max, null);
eq('① 30日ランク変動 min=10', p1.ranges.impRankDrop.min, 10);
eq('① 新品出品数 min=2',      p1.ranges.impSellers.min, 2);
eq('① FBA利益額7日 min=100',  p1.ranges.profitAmt7d.min, 100);
eq('① FBA利益額30日 min=100', p1.ranges.profitAmt30d.min, 100);
eq('① FBA利益額90日 min=100', p1.ranges.profitAmt90d.min, 100);
ok('① 4種(瞬間+ランク+出品+利益3)が enabled',
   [p1.dropRate.instant, p1.ranges.impRankDrop, p1.ranges.impSellers,
    p1.ranges.profitAmt7d, p1.ranges.profitAmt30d, p1.ranges.profitAmt90d].every((r) => r && r.enabled));

// ② build() — ① から瞬間下落率を除いたもの
const p2 = RECOMMENDED_PRESETS[1].build();
ok('② 瞬間下落率は無効/未設定', !p2.dropRate.instant || !p2.dropRate.instant.enabled);
eq('② 30日ランク変動 min=10', p2.ranges.impRankDrop.min, 10);
eq('② 新品出品数 min=2',      p2.ranges.impSellers.min, 2);
eq('② FBA利益額7日 min=100',  p2.ranges.profitAmt7d.min, 100);
eq('② FBA利益額30日 min=100', p2.ranges.profitAmt30d.min, 100);
eq('② FBA利益額90日 min=100', p2.ranges.profitAmt90d.min, 100);

// ③ build() — 自動ゴミ捨て向け
const p3 = RECOMMENDED_PRESETS[2].build();
ok('③ 通知なし経過日数 enabled', p3.ranges.notifyGap && p3.ranges.notifyGap.enabled);
eq('③ 通知なし経過日数 min=60',  p3.ranges.notifyGap.min, 60);
eq('③ 通知なし経過日数 max=null', p3.ranges.notifyGap.max, null);
ok('③ 他の条件は付かない (notifyGap のみ)',
   Object.keys(p3.ranges).filter((k) => p3.ranges[k] && p3.ranges[k].enabled).join(',') === 'notifyGap');

// ── ※ 注記 (notes) — カードに必ず表記する ────────────────────────────────────
ok('① FBA利益額の注記あり',
   RECOMMENDED_PRESETS[0].notes.some((n) => n.includes('日平均価格で売れた場合の利益')));
ok('② FBA利益額の注記あり',
   RECOMMENDED_PRESETS[1].notes.some((n) => n.includes('日平均価格で売れた場合の利益')));
ok('③ 通知なし経過日数の定義 注記',
   RECOMMENDED_PRESETS[2].notes.some((n) => n.includes('直近の通知日から現在までの経過日数')));
ok('③ 自動ゴミ捨て推奨の注記',
   RECOMMENDED_PRESETS[2].notes.some((n) => n.includes('自動ゴミ捨てを有効')));

// ── rules (UI 表示) ─────────────────────────────────────────────────────────
const labels1 = RECOMMENDED_PRESETS[0].rules.map((r) => r.label);
ok('① rules に 瞬間下落率',       labels1.includes('実質BuyBox価格の瞬間下落率'));
ok('① rules に 30日ランク変動',   labels1.includes('30日ランク変動(取込)'));
ok('① rules に 新品出品数',       labels1.includes('新品出品数(取込)'));
ok('① rules に FBA利益額(7/30/90日)',
   ['FBA利益額(7日平均)', 'FBA利益額(30日平均)', 'FBA利益額(90日平均)'].every((l) => labels1.includes(l)));
const labels2 = RECOMMENDED_PRESETS[1].rules.map((r) => r.label);
ok('② rules に 瞬間下落率は無い', !labels2.includes('実質BuyBox価格の瞬間下落率'));
eq('③ rules は 通知なし経過日数 のみ',
   RECOMMENDED_PRESETS[2].rules.map((r) => r.label).join(','), '通知なし経過日数');

// ── レンダラが notes (配列) を表記すること ───────────────────────────────────
ok('renderPresetList が preset.notes を map して表記',
   /preset\.notes[\s\S]{0,80}fnm-preset-note/.test(rendererSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
