'use strict';
//
// Repro + regression test for the 2026-06 "row data off-by-one vs ASIN label" bug.
//
// Root cause: applyFilter set `filtered = allProducts` (SAME reference) when the
// search box is empty, then `reapplyRankOrder(filtered)` did `filtered.sort(...)`
// — an IN-PLACE sort that therefore reordered `allProducts` itself. `productIndex`
// (asin -> index, built once) was NOT rebuilt, so it went stale. updateRow /
// updateRowStats re-resolve each row via `allProducts[productIndex.get(asin)]`,
// which now returns a DIFFERENT (shifted) product → every data cell shows a
// neighbour's values while the ASIN label stays correct.
//
// The fix: `filtered = allProducts.slice()` so the in-place sort reorders a COPY
// and never mutates allProducts / desyncs productIndex.
//

// reapplyRankOrder — copied verbatim from renderer.js.
function reapplyRankOrder(arr, sortedAsinRank) {
  if (!sortedAsinRank) return;
  const ranks = sortedAsinRank;
  arr.sort((a, b) => {
    const ra = ranks.get(a.asin);
    const rb = ranks.get(b.asin);
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}

function buildIndex(allProducts) {
  const idx = new Map();
  for (let i = 0; i < allProducts.length; i++) idx.set(allProducts[i].asin, i);
  return idx;
}

// Simulate applyFilter (no search) + render re-resolution, for BUGGY vs FIXED.
// Returns the list of rows as the SCREEN would show them: { label, dataAsin }
// where label = the ASIN cell (filtered[i].asin, set at createRow) and dataAsin =
// the ASIN whose data updateRow actually paints (allProducts[productIndex.get(label)]).
function simulate({ alias }) {
  // DB/registration order — B0F9KF5Q1C sits MID-LIST (index 2), as in reality.
  const allProducts = [
    { asin: 'B0GJ8YSRB3', fba: 662 },
    { asin: 'B08CBDCBTC', fba: -575 },
    { asin: 'B0F9KF5Q1C', fba: 7968 },
    { asin: 'B0AAAAAAAA', fba: 100 },
    { asin: 'B0BBBBBBBB', fba: 200 },
  ];
  const productIndex = buildIndex(allProducts);
  // A frozen 1-entry rank (as after sorting while a single ASIN was searched):
  // move B0F9KF5Q1C to the front; the rest keep their order. Because it was
  // NOT already first, the in-place sort actually reorders the array.
  const sortedAsinRank = new Map([['B0F9KF5Q1C', 0]]);

  // applyFilter, no search:
  let filtered = alias ? allProducts : allProducts.slice();
  reapplyRankOrder(filtered, sortedAsinRank);   // in-place sort

  // renderVisible → updateRow re-resolves each row via the (possibly stale) index:
  return filtered.map((row) => {
    const resolved = allProducts[productIndex.get(row.asin)];
    return { label: row.asin, dataAsin: resolved ? resolved.asin : '(none)', fba: resolved ? resolved.fba : null };
  });
}

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

// ── BUGGY (alias=true): demonstrates the off-by-one ──
{
  const rows = simulate({ alias: true });
  const anyMismatch = rows.some((r) => r.label !== r.dataAsin);
  check('BUGGY (filtered = allProducts): produces label≠data mismatch (repro)', anyMismatch);
  // Specifically B0F9KF5Q1C's data (7968) should leak onto another row's label.
  const leaked = rows.find((r) => r.label !== 'B0F9KF5Q1C' && r.fba === 7968);
  check('BUGGY: ¥7,968 (B0F9KF5Q1C) appears under the WRONG ASIN label', !!leaked);
  if (leaked) console.log(`        → ¥7,968 shown under label ${leaked.label}`);
}

// ── FIXED (alias=false): every row's data matches its own ASIN ──
{
  const rows = simulate({ alias: false });
  const allAligned = rows.every((r) => r.label === r.dataAsin);
  check('FIXED (filtered = allProducts.slice()): every row label === its data ASIN', allAligned);
  const b0 = rows.find((r) => r.label === 'B0F9KF5Q1C');
  check('FIXED: B0F9KF5Q1C shows its own ¥7,968', b0 && b0.fba === 7968);
  const b1 = rows.find((r) => r.label === 'B0GJ8YSRB3');
  check('FIXED: B0GJ8YSRB3 shows its own ¥662', b1 && b1.fba === 662);
}

// ── allProducts must remain in its original order under the FIXED path ──
{
  const allProducts = [
    { asin: 'X1' }, { asin: 'X2' }, { asin: 'X3' },
  ];
  const productIndex = buildIndex(allProducts);
  const rank = new Map([['X3', 0]]);
  const filtered = allProducts.slice();
  reapplyRankOrder(filtered, rank);
  const indexStillValid = ['X1', 'X2', 'X3'].every((a) => allProducts[productIndex.get(a)].asin === a);
  check('FIXED: allProducts order + productIndex stay consistent after rank sort', indexStillValid);
  check('FIXED: filtered (the copy) is reordered (X3 first)', filtered[0].asin === 'X3');
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAIL(S)'}`);
process.exit(fails === 0 ? 0 : 1);
