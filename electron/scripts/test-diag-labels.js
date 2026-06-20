'use strict';

//
// クロール診断モーダルの表記変更 (2026-06 client B11) のテスト。
// 表示テキストの「ブロック / ブロック○○」を「アクセス調整 / アクセス調整○○」へ
// 変更。内部識別子 (block_events / block_type / クラス名) や英語ラベル・コメントは
// 対象外。新表記が存在し、旧表示文字列が消えていることをソース照合で担保する。
//

const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const rj   = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } }

// 新表記が存在する。
ok('html: 診断ボタン tooltip = アクセス調整発生位置', html.includes('アクセス調整発生位置を表示'));
ok('html: モーダル見出し = アクセス調整発生位置',     html.includes('1 ページ取得時間とアクセス調整発生位置'));
ok('html: 凡例 = ▎ アクセス調整発生',                 html.includes('▎ アクセス調整発生'));
ok('html: 履歴セクション = ▼ アクセス調整発生履歴',   html.includes('▼ アクセス調整発生履歴'));
ok('renderer: 統計行 = アクセス調整回数: N 回 (B13)', rj.includes('`アクセス調整回数: <strong>${b.length}</strong> 回`'));
ok('renderer: 空履歴 = アクセス調整イベント…',        rj.includes('この期間にアクセス調整イベントは発生していません'));

// 旧表示文字列が消えている。
ok('html: 旧「ブロック発生位置」が無い',     !html.includes('ブロック発生位置'));
ok('html: 旧「▎ ブロック発生」が無い',       !html.includes('▎ ブロック発生'));
ok('html: 旧「ブロック発生履歴」が無い',     !html.includes('ブロック発生履歴'));
ok('renderer: 旧「ブロック発生: <strong>」が無い', !rj.includes('ブロック発生: <strong>'));
ok('renderer: 旧「ブロックイベントは発生」が無い',  !rj.includes('ブロックイベントは発生していません'));

// 内部識別子は維持 (誤って改名していない)。
ok('renderer: block_events 参照は維持', rj.includes('block_events'));
ok('renderer: block_type 参照は維持',   rj.includes('b.block_type'));

// ── B12: スクレイプ/スクレイピング などネガティブ表記を回避 ───────────────────
ok('html: 周期セクション = 全商品の最新データ取得完了まで', html.includes('全商品の最新データ取得完了まで'));
ok('html: 旧「全商品スクレイプ完了まで」が無い',           !html.includes('全商品スクレイプ完了まで'));
ok('html: 進捗 tooltip = 最新データ取得の進捗',            html.includes('title="最新データ取得の進捗"'));
ok('renderer: wave tooltip = 最新データ取得の進捗',        rj.includes('最新データ取得の進捗 — wave'));
// 表示文字列 (コメント除外) に スクレイピング進捗 / 全商品スクレイプ / ボット検知 が残っていない。
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|<!--|\*)/.test(l)).join('\n');
for (const term of ['スクレイピング進捗', '全商品スクレイプ', 'ボット検知']) {
  ok(`表示文字列に「${term}」が無い`, !stripComments(html).includes(term) && !stripComments(rj).includes(term));
}

// ── B13: 「1ページ取得時間」サマリだけ サンプル数/平均/最小/最大 を削除 ─────────
// (「1周期合計時間」サマリ = renderCrawlDiagnosticsCycleSummary は対象外・維持)。
const sumStart = rj.indexOf('function renderCrawlDiagnosticsSummary');
const sumEnd   = rj.indexOf('\nfunction ', sumStart + 1);
const sumFn    = stripComments(rj.slice(sumStart, sumEnd));   // コメント行は除外
ok('B13: サマリ関数を抽出', sumStart >= 0 && sumEnd > sumStart);
ok('B13: 1ページ取得サマリに サンプル数 が無い', !sumFn.includes('サンプル数'));
ok('B13: 1ページ取得サマリに 平均 が無い',       !sumFn.includes('平均:'));
ok('B13: 1ページ取得サマリに 最小 が無い',       !sumFn.includes('最小:'));
ok('B13: 1ページ取得サマリに 最大 が無い',       !sumFn.includes('最大:'));
ok('B13: 1ページ取得サマリは アクセス調整回数 を表示', sumFn.includes('アクセス調整回数: <strong>'));
// 1周期合計時間サマリ (cycle) は従来の平均/最小/最大を維持 (誤って消していない)。
ok('B13: cycleサマリは維持', rj.indexOf('function renderCrawlDiagnosticsCycleSummary') >= 0);

// ── B14: 1ページ取得時間チャートの縦軸を /50 (1商品あたり) に換算 ───────────────
function niceCeil(n) {
  if (n <= 0) return 1000;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const r = n / base;
  let step;
  if (r <= 1) step = 1; else if (r <= 2) step = 2; else if (r <= 5) step = 5; else step = 10;
  return step * base;
}
function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} 秒` : '';
}
const PER_PAGE = 50;
const perProduct = (elapsed) => elapsed / PER_PAGE;
ok('B14: 5500ms/50 = 110ms (1商品換算)', perProduct(5500) === 110);
// 縦軸 max が切りの良い値、目盛りも round。
const sample = [5000, 5500, 7700, 4200];
const maxPP = Math.max(...sample.map(perProduct), 20);   // 154
const yMax  = niceCeil(maxPP * 1.1);                     // niceCeil(169.4)=200
ok('B14: yMax=200ms (切りの良い)', yMax === 200);
const ticks = [0, 1, 2, 3, 4, 5].map((i) => (yMax * i) / 5);
ok('B14: 目盛り 0/40/80/120/160/200', JSON.stringify(ticks) === JSON.stringify([0, 40, 80, 120, 160, 200]));
ok('B14: 目盛りラベルは ms 表示', fmtDuration(40) === '40 ms' && fmtDuration(110) === '110 ms');
// ソース照合: チャートが /50 換算を使用。
ok('renderer: PER_PAGE_PRODUCTS = 50', rj.includes('const PER_PAGE_PRODUCTS = 50;'));
ok('renderer: perProductMs 換算 (折れ線+ドット)',
   rj.includes('yFor(perProductMs(timings[i]))') && rj.includes('yFor(perProductMs(t))'));
ok('renderer: Y軸maxも perProductMs', rj.includes('Math.max(...timings.map(perProductMs)'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
