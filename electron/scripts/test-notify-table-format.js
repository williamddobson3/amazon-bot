'use strict';

//
// 通知の価格表レイアウト (2026-06 client B7) のテスト。
//
// スマホ (Discord モバイル) で折り返さないよう、価格表を「右揃えワイド列」から
// 「行ラベル : 平均価格、下落率、ROE利益率 を全角読点(、)区切りで左詰め」に変更:
//     最新 : ¥569、0%、-59%
//     1日  : ¥8511、133%、-9%   …
// notifier.js の buildStatsTableAnsi は内部関数 (非 export, queries 依存で node
// から直接呼べない) のため、CJK 幅ヘルパ + 行整形ロジックを写経して出力を検証し、
// 併せて notifier.js のソースが新フォーマットになっていることを照合する。
//

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// ── notifier.js と同一の CJK 幅ヘルパ (写経) ──────────────────────────────────
function cellWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    w += (
      (code >= 0x1100 && code <= 0x115F) || (code >= 0x2E80 && code <= 0x303E) ||
      (code >= 0x3041 && code <= 0x33FF) || (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6)
    ) ? 2 : 1;
  }
  return w;
}
const padR = (s, w) => s + ' '.repeat(Math.max(0, w - cellWidth(s)));
const RESET = '\x1b[0m', RED = '\x1b[2;31m', BLUE = '\x1b[2;34m';
const colorize = (s, sign) => (sign == null || sign === 0) ? s : (sign > 0 ? RED : BLUE) + s + RESET;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── 新フォーマットの行整形 (buildStatsTableAnsi の該当部を写経) ───────────────
function buildLines(rows) {
  const labelW = Math.max(...rows.map((r) => cellWidth(r.label)));
  const lines = [];
  lines.push(padR('', labelW + 2) + '平均価格、下落率、ROE利益率');
  for (const r of rows) {
    const pctCol = colorize(r.pct, r.diffSign);
    const roeCol = colorize(r.roe, r.roeSign);
    lines.push(`${padR(r.label, labelW)}: ${r.val}、${pctCol}、${roeCol}`);
  }
  return lines;
}

// クライアント例に近いサンプル (符号も含めて検証)。
const rows = [
  { label: '最新',  val: '¥569',    pct: '0%',   diffSign: 0,  roe: '-59%', roeSign: -1 },
  { label: '1日',   val: '¥8,511',  pct: '133%', diffSign: 1,  roe: '-9%',  roeSign: -1 },
  { label: '7日',   val: '¥8,541',  pct: '433%', diffSign: 1,  roe: '-9%',  roeSign: -1 },
  { label: '30日',  val: '¥85,521', pct: '33%',  diffSign: 1,  roe: '-9%',  roeSign: -1 },
  { label: '90日',  val: '¥8,511',  pct: '33%',  diffSign: 1,  roe: '-15%', roeSign: -1 },
  { label: '180日', val: '¥701',    pct: '19%',  diffSign: 1,  roe: '-35%', roeSign: -1 },
];
const lines = buildLines(rows);
const plain = lines.map(stripAnsi);

// 見出し: ラベル列ぶん (labelW+2=7) の空白 + 全角読点区切りの凡例。
eq('見出しは 、区切りの凡例', plain[0], '       平均価格、下落率、ROE利益率');
// 各データ行 = ラベル(コロン整列) + ': ' + 値、下落率、ROE (、は2個)。
eq('最新 行',  plain[1], '最新 : ¥569、0%、-59%');
eq('1日 行',   plain[2], '1日  : ¥8,511、133%、-9%');
eq('30日 行',  plain[4], '30日 : ¥85,521、33%、-9%');
eq('180日 行', plain[6], '180日: ¥701、19%、-35%');

// 各データ行に全角読点がちょうど2個 (3カラムを挟む)。
for (let i = 1; i < plain.length; i++) {
  ok(`データ行 ${i}: 、が2個`, (plain[i].match(/、/g) || []).length === 2);
  ok(`データ行 ${i}: 、の前後に空白なし`, !/[ 　]、|、[ 　]/.test(plain[i]));
}
// コロン位置が全行で揃う (ラベル部の cellWidth が一定)。
const colonCols = plain.slice(1).map((l) => cellWidth(l.slice(0, l.indexOf(':'))));
ok('コロン位置が全行一致', colonCols.every((c) => c === colonCols[0]));

// 着色は値全体を包み、読点(、)は色コードの外にある (区切りが壊れない)。
ok('下落率の着色が読点の外側', lines[2].includes(`、${RED}133%${RESET}、`));
ok('ROEの着色が読点の外側',     lines[2].includes(`、${BLUE}-9%${RESET}`));

// ── ソース照合: notifier.js が新フォーマットを実装 ───────────────────────────
const notifierSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services', 'notifier.js'), 'utf8');
ok('notifier: 見出しが 平均価格、下落率、ROE利益率',
   notifierSrc.includes("padR('', labelW + 2) + '平均価格、下落率、ROE利益率'"));
ok('notifier: 行が 値、下落率、ROE の 、区切り左詰め',
   notifierSrc.includes('`${padR(r.label, labelW)}: ${valStrs[i]}、${pctCol}、${roeCol}`'));
ok('notifier: 旧ワイド列 (valW/pctW/roeW の padL) を撤去',
   !notifierSrc.includes('padL(valStrs[i]') && !notifierSrc.includes("Math.max(cellWidth('平均価格')"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
