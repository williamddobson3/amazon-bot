'use strict';

// Stream D test (spec 項目9/10/17/24). Mixes a real module import (fnm-eval.js,
// pure JS — testable under node) with source-level structural checks for the
// renderer/HTML pieces that need a DOM/canvas.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const rj  = fs.readFileSync(path.join('src', 'renderer', 'renderer.js'), 'utf8');
const idx = fs.readFileSync(path.join('src', 'renderer', 'index.html'), 'utf8');

// ── 項目17 — 全出品数(内訳) mpCount fully neutralized (REAL fnm-eval.js) ──
const fnmEval = require(path.join('..', 'src', 'main', 'services', 'fnm-eval.js'));
// A state that enables an mpCount condition the product would FAIL — must be
// ignored now (statsConditionsPass returns true).
const mpState = {
  mpCount: { current: { enabled: true, min: 999999, max: null }, d7:{}, d30:{}, d90:{}, d180:{} },
  dropRate: {}, ranges: {},
};
eq('17: statsConditionsPass ignores mpCount', fnmEval.statsConditionsPass({ mpCountCurrent: 1 }, 1000, mpState), true);
// A slot whose ONLY condition is mpCount must NOT be considered fireable.
eq('17: hasFireableBound ignores mpCount', fnmEval.hasFireableBound(mpState), false);
// A real range bound still counts as fireable (sanity — we didn't over-neutralize).
eq('17: ranges still fireable', fnmEval.hasFireableBound({ ranges: { price: { enabled: true, min: 100, max: null } } }), true);
// index.html no longer has the mpcount filter grid.
eq('17: index.html drops fnm-mpcount-grid', idx.includes('id="fnm-mpcount-grid"'), false);
// renderer no longer evaluates/counts mpCount in the two gates.
eq('17: passesAllConditions has no mpCount block', /if \(state\.mpCount\)/.test(rj), false);

// ── 項目10 — filter order: impRank → monthlySales → impRankDrop ──────────
// Parse the RANGE_ROWS key order from source.
const rrBlock = rj.slice(rj.indexOf('const RANGE_ROWS = ['));
const rrBody  = rrBlock.slice(0, rrBlock.indexOf('\n];'));
const keyOrder = [...rrBody.matchAll(/key:\s*'([a-zA-Z0-9]+)'/g)].map((m) => m[1]);
const iRank  = keyOrder.indexOf('impRank');
const iSales = keyOrder.indexOf('monthlySales');
const iDrop  = keyOrder.indexOf('impRankDrop');
eq('10: impRank before monthlySales', iRank >= 0 && iRank < iSales, true);
eq('10: monthlySales before impRankDrop', iSales < iDrop, true);
eq('10: the three are consecutive', iDrop - iRank, 2);

// ── 項目9 — 新品出品数(取込) single point wiring ──────────────────────────
eq('9: getMonitoringChartData returns impSellers', /impSellers:\s*impSellersOut/.test(
  fs.readFileSync(path.join('src','main','db','queries.js'),'utf8')), true);
eq('9: countSeries pushes imp-sellers point', /data\.impSellers != null/.test(rj), true);
eq('9: diamond marker added', /shape === 'diamond'/.test(
  fs.readFileSync(path.join('src','renderer','chart-renderer.js'),'utf8')), true);
eq('9: legend row present', idx.includes('data-static="impSellers"'), true);

// ── 項目24 — sparkline zero-fixed variants ───────────────────────────────
// Replicate the dropdown generation: 6 periods × {normal, zero} = 12 buttons.
const PERIODS = [1, 7, 30, 90, 180, null];
function buildButtons(sparklineDays, sparklineMinZero) {
  const optBtn = (days, zero) => ({
    days, zero,
    active: (days === sparklineDays && zero === sparklineMinZero),
  });
  return [...PERIODS.map((d) => optBtn(d, false)), ...PERIODS.map((d) => optBtn(d, true))];
}
const btns = buildButtons(30, false);
eq('24: 12 buttons (6×2)', btns.length, 12);
eq('24: exactly one active', btns.filter((b) => b.active).length, 1);
eq('24: active is 30d normal', btns.find((b) => b.active), { days: 30, zero: false, active: true });
const btnsZero = buildButtons(90, true);
eq('24: zero-fixed selection active', btnsZero.find((b) => b.active), { days: 90, zero: true, active: true });

// Sparkline minZero floor math (chart-renderer Sparkline.draw).
function vLo(minZero, vMin) { return minZero ? 0 : vMin; }
eq('24: minZero floors to 0', vLo(true, 4500), 0);
eq('24: normal keeps vMin', vLo(false, 4500), 4500);

// Source wiring: setData receives minZero, header reflects state, prefs persist.
eq('24: loadSparkline passes minZero', /chart\.setData\(series, xMin, xMax, sparklineMinZero\)/.test(rj), true);
eq('24: header shows ゼロ固定 state', rj.includes("sparklineMinZero ? 'ゼロ固定' : '監視グラフ'"), true);
eq('24: persists sparklineMinZero', rj.includes("key:   'viewer.sparklineMinZero'"), true);
// 180d was kept by Stream D, then removed by 項目27 (retention 180→90).
eq('24: 180d removed by 項目27', /label: '直近180日'/.test(rj), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
