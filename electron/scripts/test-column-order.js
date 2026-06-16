'use strict';
// Verify the column-reorder math (mirrors renderer.js applyColumnOrder):
//  1. default order reproduces the exact CSS grid-template-columns
//  2. for ANY permutation, each column's width follows it to its slot
//     and each cell's `order` lands it in the matching track.
const FIXED_COL_WIDTHS = ['64px', '230px', '100px'];
const MOVABLE_COLUMNS = [
  { id: 'regdate', pos: 4, width: '100px' }, { id: 'thumb', pos: 5, width: '76px' },
  { id: 'title', pos: 6, width: '240px' }, { id: 'asin', pos: 7, width: '100px' },
  { id: 'impRank', pos: 8, width: '96px' }, { id: 'monthlySales', pos: 9, width: '100px' },
  { id: 'impRankDrop', pos: 10, width: '104px' }, { id: 'allCount', pos: 11, width: '112px' },
  { id: 'impSellers', pos: 12, width: '88px' }, { id: 'profitAmt', pos: 13, width: '112px' },
  { id: 'profitRoe', pos: 14, width: '104px' }, { id: 'sparkline', pos: 15, width: '100px' },
  { id: 'effective', pos: 16, width: '96px' }, { id: 'notifyPrice', pos: 17, width: '90px' },
  { id: 'avg1d', pos: 18, width: '120px' }, { id: 'avg7d', pos: 19, width: '120px' },
  { id: 'avg30d', pos: 20, width: '120px' }, { id: 'avg90d', pos: 21, width: '120px' },
  { id: 'avg180d', pos: 22, width: '120px' }, { id: 'other', pos: 23, width: '120px' },
  { id: 'price', pos: 24, width: '90px' }, { id: 'points', pos: 25, width: '62px' },
  { id: 'shipping', pos: 26, width: '70px' }, { id: 'delivery', pos: 27, width: '160px' },
  { id: 'sizeKubun', pos: 28, width: '150px' }, { id: 'amazonFee', pos: 29, width: '104px' },
  { id: 'fbaFee', pos: 30, width: '96px' }, { id: 'storageFee', pos: 31, width: '96px' },
];
const colById = (id) => MOVABLE_COLUMNS.find((c) => c.id === id);
const DEFAULT = MOVABLE_COLUMNS.map((c) => c.id);

// Replica of applyColumnOrder's computed outputs.
function compute(order) {
  const widths = FIXED_COL_WIDTHS.concat(order.map((id) => colById(id).width));
  const cellOrder = {}; // nth-child pos -> order value
  cellOrder[1] = 1; cellOrder[2] = 2; cellOrder[3] = 3;
  order.forEach((id, i) => { cellOrder[colById(id).pos] = 4 + i; });
  return { widths, cellOrder };
}

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

// CSS default grid-template-columns (from styles.css .viewer-row), in px.
const CSS_DEFAULT = [64,230,100,100,76,240,100,96,100,104,112,88,112,104,100,96,90,120,120,120,120,120,120,90,62,70,160,150,104,96,96]
  .map((n) => n + 'px');

const def = compute(DEFAULT);
ok('default grid-template-columns == CSS (31 tracks)', JSON.stringify(def.widths) === JSON.stringify(CSS_DEFAULT));
ok('31 cells total (3 fixed + 28 movable)', def.widths.length === 31 && MOVABLE_COLUMNS.length === 28);

// Invariant for arbitrary permutations: the track a column lands in (= its
// `order` value, 1-based) must have that column's own width.
function checkInvariant(order, label) {
  const { widths, cellOrder } = compute(order);
  let good = true;
  for (const c of MOVABLE_COLUMNS) {
    const track = cellOrder[c.pos];          // 1-based track it occupies
    if (widths[track - 1] !== c.width) { good = false; break; }
  }
  // fixed cols always tracks 1-3
  if (cellOrder[1] !== 1 || cellOrder[2] !== 2 || cellOrder[3] !== 3) good = false;
  // every track used exactly once
  const used = new Set(Object.values(cellOrder));
  if (used.size !== 31) good = false;
  ok(`width follows column for: ${label}`, good);
}

// Simulate the drag splice (move dragId to before/after targetId).
function reorder(order, dragId, targetId, after) {
  const o = order.slice();
  o.splice(o.indexOf(dragId), 1);
  let to = o.indexOf(targetId); if (after) to += 1;
  o.splice(to, 0, dragId);
  return o;
}

checkInvariant(DEFAULT, 'default');
checkInvariant(reorder(DEFAULT, 'price', 'thumb', false), 'price → before thumb');
checkInvariant(reorder(DEFAULT, 'regdate', 'storageFee', true), 'regdate → after storageFee (last)');
checkInvariant(reorder(reorder(DEFAULT, 'title', 'points', true), 'avg30d', 'thumb', false), 'two moves');
// reversed movable order
checkInvariant(DEFAULT.slice().reverse(), 'fully reversed');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAIL(S)'}`);
process.exit(fails === 0 ? 0 : 1);
