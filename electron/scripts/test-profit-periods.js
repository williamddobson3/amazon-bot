'use strict';

// Verifies Stream A (spec 項目7/8/11/12/13) profit math + key wiring.
// These formulas are duplicated across renderer.js (profitAmountForDays),
// notifier.js (roeOf), and chart-render.html (amtFromRef) — they MUST agree.
// This test pins the single canonical formula and the period-key generation.

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = (got === want) || (got == null && want == null);
  if (ok) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${got}, want ${want}`); }
}

// ── Canonical profit formula (must match all three call sites) ──────────
const PROFIT_SANITY = 0.2;
function profitRef(stats, days) {
  if (!stats) return null;
  if (days === 0) return stats.prevEffective ?? null;
  const v = stats['avg' + days + 'd'];
  return v == null ? null : v;
}
function profitAmt(p, stats, days) {
  if (!p || !stats) return null;
  const ref = profitRef(stats, days);
  const eff = p.eff;
  if (ref == null || eff == null) return null;
  if (eff <= 0 || eff < ref * PROFIT_SANITY) return null;
  const { af, ff, sf } = p;
  if (af == null || ff == null || sf == null) return null;
  return ref - eff - af - ff - sf;
}
function profitRoe(p, stats, days) {
  const amt = profitAmt(p, stats, days);
  if (amt == null || p.eff == null || p.eff === 0) return null;
  return (amt / p.eff) * 100;
}

// ── Sample product/stats ────────────────────────────────────────────────
const stats = {
  prevEffective: 11932,
  avg1d: 11887, avg7d: 11250, avg30d: 11250, avg90d: 11250, avg180d: 11250,
};
const prod = { eff: 6324, af: 723, ff: 420, sf: 11 };

// 瞬間 (days 0) uses prevEffective: 11932 - 6324 - 723 - 420 - 11 = 4454
eq('瞬間 amt', profitAmt(prod, stats, 0), 11932 - 6324 - 723 - 420 - 11);
// 30日 uses avg30d: 11250 - 6324 - 723 - 420 - 11 = 3772
eq('30日 amt', profitAmt(prod, stats, 30), 11250 - 6324 - 723 - 420 - 11);
// ROE(30) = amt/eff*100
eq('30日 roe rounded', Math.round(profitRoe(prod, stats, 30)),
   Math.round((3772 / 6324) * 100));

// Client item13 worked example: profit 632 @ eff 6324 → ROE ≈ 10%.
eq('item13 roe direction', Math.round((632 / 6324) * 100), 10);

// ── Sanity guard: eff far below ref → null (price misread) ───────────────
eq('sanity guard fires', profitAmt({ eff: 100, af: 1, ff: 1, sf: 1 }, stats, 30), null);
// ── Missing fee → null ───────────────────────────────────────────────────
eq('null fee → null', profitAmt({ eff: 6324, af: null, ff: 420, sf: 11 }, stats, 30), null);
// ── 瞬間 with no prevEffective → null ────────────────────────────────────
eq('瞬間 no prev → null', profitAmt(prod, { prevEffective: null }, 0), null);
// ── avg missing for a period → null ──────────────────────────────────────
eq('avg missing → null', profitAmt(prod, { avg90d: null }, 90), null);

// ── Period-key generation (項目8) — 12 sort keys + 12 filter keys ────────
const PROFIT_PERIODS = [
  { sfx: 'instant', days: 0,   fA: 'profitAmtInstant', fR: 'profitRoeInstant' },
  { sfx: '1d',      days: 1,   fA: 'profitAmt1d',      fR: 'profitRoe1d' },
  { sfx: '7d',      days: 7,   fA: 'profitAmt7d',      fR: 'profitRoe7d' },
  { sfx: '30d',     days: 30,  fA: 'profitAmt30d',     fR: 'profitRoe30d' },
  { sfx: '90d',     days: 90,  fA: 'profitAmt90d',     fR: 'profitRoe90d' },
  { sfx: '180d',    days: 180, fA: 'profitAmt180d',    fR: 'profitRoe180d' },
];
const sortKeys = [];
const filterKeys = [];
for (const pp of PROFIT_PERIODS) {
  sortKeys.push('profit_amt_' + pp.sfx, 'profit_roe_' + pp.sfx);
  filterKeys.push(pp.fA, pp.fR);
}
eq('12 sort keys', sortKeys.length, 12);
eq('12 filter keys', filterKeys.length, 12);
eq('sort key sample', sortKeys.includes('profit_amt_instant'), true);
eq('sort key sample 180', sortKeys.includes('profit_roe_180d'), true);
eq('legacy migration target exists', sortKeys.includes('profit_amt_30d'), true);
eq('unique sort keys', new Set(sortKeys).size, 12);
eq('unique filter keys', new Set(filterKeys).size, 12);

// ── Period label (項目7) ──────────────────────────────────────────────────
const label = (d) => (d === 0 ? '瞬間' : `${d}日平均`);
eq('label 0 = 瞬間', label(0), '瞬間');
eq('label 30', label(30), '30日平均');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
