'use strict';

//
// 〇日平均実質BuyBox の差額/差率の符号反転 (2026-06 client B15) のテスト。
//
// アプリリストの 1/7/30/90/180日平均セル下の「差額・差率」を、算出値に -1 を乗じて
// プラマイ反転する: 平均が最新実質より高ければ「+ かつ赤(pos)」、低ければ「− かつ
// 青(neg)」(通知の下落率と同じ向き)。色は従来の関係(pos=赤/neg=青)を維持。
// 他の出品(other)列は対象外で従来の符号(最新−基準)を維持。
//
// renderAvg は DOM 描画関数なので、符号・色・% のロジックを写経して検証し、併せて
// renderer.js の配線(flipフラグ)をソース照合する。
//

const fs = require('fs');
const path = require('path');
const rj = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// renderAvg の差額/色/% 部分を写経 (diff = queries.js の「基準値 − 最新実質」)。
function avgParts(val, diff, flip) {
  const displayDiff = flip ? diff : -diff;
  const cls = flip
    ? (displayDiff > 0 ? 'pos' : (displayDiff < 0 ? 'neg' : 'flat'))
    : (displayDiff < 0 ? 'pos' : (displayDiff > 0 ? 'neg' : 'flat'));
  const sign = displayDiff > 0 ? '+' : '';
  const diffStr = `${sign}${displayDiff}`;
  let pctStr = '';
  if (val !== 0) {
    const rounded = Math.round((displayDiff / val) * 100);
    const psign = rounded > 0 ? '+' : '';
    pctStr = `(${psign}${rounded}%)`;
  }
  return { diffStr, cls, pctStr };
}

// ── 〇日平均 (flip=true) — 添付画像の実例 ────────────────────────────────────
// 平均 ¥3,003 / 最新 ¥2,904 → diff = 3003-2904 = +99 → 赤字プラス。
eq('avg: 平均>最新 → +99 / 赤(pos)', avgParts(3003, 99, true), { diffStr: '+99', cls: 'pos', pctStr: '(+3%)' });
// 平均 ¥1,650 / 最新 ¥3,100 → diff = 1650-3100 = -1450 → 青字マイナス。
eq('avg: 平均<最新 → -1450 / 青(neg)', avgParts(1650, -1450, true), { diffStr: '-1450', cls: 'neg', pctStr: '(-88%)' });
// 同値 → 0 / flat。
eq('avg: 同値 → 0 / flat', avgParts(3800, 0, true), { diffStr: '0', cls: 'flat', pctStr: '(0%)' });
// 7日平均の例: ¥3,021 / 最新 ¥2,904 → diff=+117 → +117 赤 (-4%→+4%)。
eq('avg: +117 → 赤プラス (+4%)', avgParts(3021, 117, true), { diffStr: '+117', cls: 'pos', pctStr: '(+4%)' });

// ── 他の出品 (flip=false) — 従来の符号を維持 (最新 − 基準) ─────────────────────
// other ¥3,003 / 最新 ¥2,904 → diff(基準−最新)=+99 → 表示は -99 / 赤(pos) (従来通り)。
eq('other: 従来どおり -99 / 赤(pos)', avgParts(3003, 99, false), { diffStr: '-99', cls: 'pos', pctStr: '(-3%)' });
eq('other: 従来どおり +1450 / 青(neg)', avgParts(1650, -1450, false), { diffStr: '+1450', cls: 'neg', pctStr: '(+88%)' });

// avg と other で同じ price 関係なら「色は同じ・値の符号は逆」。
const a = avgParts(3003, 99, true);   // +99 / pos
const o = avgParts(3003, 99, false);  // -99 / pos
ok('avg と other は色が同じ', a.cls === o.cls);
ok('avg と other は値の符号が逆', a.diffStr === '+99' && o.diffStr === '-99');

// ── ソース照合 ───────────────────────────────────────────────────────────────
ok('renderAvg に flip 引数', /const renderAvg = \(cellSel, val, diff, flip\) =>/.test(rj));
ok('displayDiff = flip ? diff : -diff', rj.includes('const displayDiff = flip ? diff : -diff;'));
ok('flip 時の色条件 (プラス→pos)', rj.includes("(displayDiff > 0 ? 'pos' : (displayDiff < 0 ? 'neg' : 'flat'))"));
for (const k of ['avg1d', 'avg7d', 'avg30d', 'avg90d', 'avg180d']) {
  ok(`${k} は flip=true`, new RegExp(`data-stat="${k}"[\\s\\S]*?,\\s*true\\)`).test(rj));
}
ok('other は flip=false', /data-stat="other"[\s\S]*?,\s*false\)/.test(rj));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
