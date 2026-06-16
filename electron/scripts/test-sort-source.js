'use strict';
//
// Pure-logic test for the 2026-06 "sort uses the displayed source" fix.
//
// Invariant under test: after applySort, reading each row's value from the
// SAME source the screen displays (rowValueSource: frozen snapshot while
// scraping, live when stopped) must be monotonic in the sort direction.
//
// This replicates the relevant pure functions from renderer.js verbatim.
// It also models the OLD buggy applySort (always reads live) to prove that,
// while scraping, the OLD order makes the DISPLAYED (snapshot) values jumbled.
//

let profitDays = 180;
const PROFIT_EFF_SANITY = 0.2;

function effectiveOf(p) {
  if (!p || p.last_price == null) return null;
  return p.last_price - (p.last_points || 0) + (p.last_shipping_fee || 0);
}
function profitAmount(p, stats) {
  if (!p || !stats) return null;
  const avgN = stats['avg' + profitDays + 'd'];
  const eff  = effectiveOf(p);
  if (avgN == null || eff == null) return null;
  if (eff <= 0 || eff < avgN * PROFIT_EFF_SANITY) return null;
  const af = p.amazon_fee, ff = p.fba_fee, sf = p.inventory_storage_fee;
  if (af == null || ff == null || sf == null) return null;
  return avgN - eff - af - ff - sf;
}
function profitRoe(p, stats) {
  const amt = profitAmount(p, stats);
  const eff = effectiveOf(p);
  if (amt == null || eff == null || eff === 0) return null;
  return (amt / eff) * 100;
}
function dropPctVsAvg(stats, avgKey) {
  if (!stats) return null;
  const latest = stats.latestEffective;
  const avg    = stats[avgKey];
  if (latest == null || avg == null || avg === 0) return null;
  return ((avg - latest) / avg) * 100;
}

// NEW extractors: take (p, stats).
const SORT_EXTRACTORS = {
  price:      (p) => p.last_price,
  profit_amt: (p, stats) => profitAmount(p, stats),
  profit_roe: (p, stats) => profitRoe(p, stats),
  drop_30d:   (p, stats) => dropPctVsAvg(stats, 'avg30d'),
};
// OLD extractors: read statsCache directly (the pre-fix behavior).
const SORT_EXTRACTORS_OLD = {
  price:      (p) => p.last_price,
  profit_amt: (p) => profitAmount(p, statsCache.get(p.asin)),
  profit_roe: (p) => profitRoe(p, statsCache.get(p.asin)),
  drop_30d:   (p) => {
    const s = statsCache.get(p.asin);
    if (!s) return null;
    const latest = s.latestEffective, avg = s.avg30d;
    if (latest == null || avg == null || avg === 0) return null;
    return ((avg - latest) / avg) * 100;
  },
};

// ── mocked renderer global state ──
let allProducts = [];
let productIndex = new Map();
let statsCache = new Map();
let viewSnapshot = new Map();
let crawlCycleStartedAt = 0;   // >0 = scraping (frozen), 0 = stopped (live)
let currentSort = '';
let currentSortDir = 'desc';

function frozenRow(asin) {
  if (crawlCycleStartedAt <= 0) return null;
  return viewSnapshot.get(asin) || null;
}
function rowValueSource(asin) {
  const fz = frozenRow(asin);
  if (fz) return { prod: fz.product, stats: fz.stats };
  const idx = productIndex.get(asin);
  return { prod: (idx != null ? allProducts[idx] : null), stats: statsCache.get(asin) };
}

function applySort(items) {
  if (!currentSort) return items;
  const get = SORT_EXTRACTORS[currentSort];
  if (!get) return items;
  const mult = currentSortDir === 'asc' ? 1 : -1;
  const decorated = items.map((item, i) => {
    const src = rowValueSource(item.asin);
    const v = get(src.prod, src.stats);
    const hasValue = v != null && Number.isFinite(v);
    return { p: item, i, v: hasValue ? v : null, hasValue };
  });
  decorated.sort((a, b) => {
    if (!a.hasValue && !b.hasValue) return a.i - b.i;
    if (!a.hasValue) return 1;
    if (!b.hasValue) return -1;
    if (a.v === b.v) return a.i - b.i;
    return (a.v - b.v) * mult;
  });
  return decorated.map((d) => d.p);
}
function applySortOLD(items) {
  if (!currentSort) return items;
  const get = SORT_EXTRACTORS_OLD[currentSort];
  if (!get) return items;
  const mult = currentSortDir === 'asc' ? 1 : -1;
  const decorated = items.map((item, i) => {
    const idx = productIndex.get(item.asin);
    const prod = (idx != null && allProducts[idx]) ? allProducts[idx] : item;
    const v = get(prod);
    const hasValue = v != null && Number.isFinite(v);
    return { p: item, i, v: hasValue ? v : null, hasValue };
  });
  decorated.sort((a, b) => {
    if (!a.hasValue && !b.hasValue) return a.i - b.i;
    if (!a.hasValue) return 1;
    if (!b.hasValue) return -1;
    if (a.v === b.v) return a.i - b.i;
    return (a.v - b.v) * mult;
  });
  return decorated.map((d) => d.p);
}

// "Displayed value" = what the user SEES for a row in a given key = computed
// from the source the display uses (snapshot while scraping, live otherwise).
function displayedValue(asin, key) {
  const src = rowValueSource(asin);
  return SORT_EXTRACTORS[key](src.prod, src.stats);
}
function isMonotonic(values, dir) {
  // nulls (no value) must be at the bottom; ignore them for monotonicity,
  // but assert they only appear after all real values.
  let seenNull = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) { seenNull = true; continue; }
    if (seenNull) return false; // a real value AFTER a null = nulls not at bottom
  }
  const real = values.filter((v) => v != null && Number.isFinite(v));
  for (let i = 1; i < real.length; i++) {
    if (dir === 'desc' && real[i] > real[i - 1] + 1e-9) return false;
    if (dir === 'asc'  && real[i] < real[i - 1] - 1e-9) return false;
  }
  return true;
}

// ── test fixtures ──────────────────────────────────────────────
// 6 products. While scraping, the SNAPSHOT (displayed) ROE descends
// P0..P5 = 50..0%, but the LIVE ROE is the REVERSE (P0..P5 = 0..50%).
// Fees/points/shipping = 0 so eff = price and ROE = (avg180-price)/price*100.
function setupFixtures() {
  const snapAvg = [150, 140, 130, 120, 110, 100]; // ROE 50..0 with price 100
  const liveAvg = [100, 110, 120, 130, 140, 150]; // ROE 0..50 with price 100
  allProducts = [];
  productIndex = new Map();
  statsCache = new Map();
  viewSnapshot = new Map();
  for (let i = 0; i < 6; i++) {
    const asin = 'P' + i;
    const prodLive = {
      asin, last_price: 100, last_points: 0, last_shipping_fee: 0,
      amazon_fee: 0, fba_fee: 0, inventory_storage_fee: 0,
    };
    const statsLive = { avg180d: liveAvg[i], avg30d: liveAvg[i], latestEffective: 100 };
    allProducts.push(prodLive);
    productIndex.set(asin, i);
    statsCache.set(asin, statsLive);
    // frozen snapshot = a separate (older) capture with the snapAvg values
    const prodSnap = { ...prodLive };
    const statsSnap = { avg180d: snapAvg[i], avg30d: snapAvg[i], latestEffective: 100 };
    viewSnapshot.set(asin, { product: prodSnap, stats: statsSnap });
  }
  return allProducts.slice();
}

let fails = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fails++;
}

// ── Test 1: scraping, sort profit_roe desc → displayed (snapshot) monotonic ──
{
  const items = setupFixtures();
  crawlCycleStartedAt = 1; currentSort = 'profit_roe'; currentSortDir = 'desc';
  const sortedNew = applySort(items.slice());
  const dispNew = sortedNew.map((p) => displayedValue(p.asin, 'profit_roe'));
  check('scraping/ROE-desc: NEW order makes DISPLAYED values monotonic', isMonotonic(dispNew, 'desc'));
  check('scraping/ROE-desc: NEW top row is the highest displayed ROE (P0=50%)', sortedNew[0].asin === 'P0');

  const sortedOld = applySortOLD(items.slice());
  const dispOld = sortedOld.map((p) => displayedValue(p.asin, 'profit_roe'));
  check('scraping/ROE-desc: OLD order makes DISPLAYED values JUMBLED (regression proof)', !isMonotonic(dispOld, 'desc'));
}

// ── Test 2: scraping, sort profit_roe asc → displayed monotonic ascending ──
{
  const items = setupFixtures();
  crawlCycleStartedAt = 1; currentSort = 'profit_roe'; currentSortDir = 'asc';
  const sorted = applySort(items.slice());
  const disp = sorted.map((p) => displayedValue(p.asin, 'profit_roe'));
  check('scraping/ROE-asc: DISPLAYED values monotonic ascending', isMonotonic(disp, 'asc'));
  check('scraping/ROE-asc: top row is lowest displayed ROE (P5=0%)', sorted[0].asin === 'P5');
}

// ── Test 3: stopped, sort profit_roe desc → displayed (live) monotonic ──
{
  const items = setupFixtures();
  crawlCycleStartedAt = 0; currentSort = 'profit_roe'; currentSortDir = 'desc';
  const sorted = applySort(items.slice());
  const disp = sorted.map((p) => displayedValue(p.asin, 'profit_roe'));
  check('stopped/ROE-desc: DISPLAYED (live) values monotonic', isMonotonic(disp, 'desc'));
  // when stopped the live top ROE is P5 (live 50%)
  check('stopped/ROE-desc: top row is highest LIVE ROE (P5)', sorted[0].asin === 'P5');
}

// ── Test 4: profit_amt + drop_30d also consistent while scraping ──
for (const key of ['profit_amt', 'drop_30d']) {
  const items = setupFixtures();
  crawlCycleStartedAt = 1; currentSort = key; currentSortDir = 'desc';
  const sorted = applySort(items.slice());
  const disp = sorted.map((p) => displayedValue(p.asin, key));
  check(`scraping/${key}-desc: DISPLAYED values monotonic`, isMonotonic(disp, 'desc'));
}

// ── Test 5: nulls (Guard #3 eff < avg*0.2) sort to the bottom while scraping ──
{
  const items = setupFixtures();
  crawlCycleStartedAt = 1; currentSort = 'profit_roe'; currentSortDir = 'desc';
  // Corrupt P2's snapshot: eff far below avg → profitAmount/Roe = null (suppressed).
  viewSnapshot.get('P2').product.last_price = 5;   // eff=5 < avg180(130)*0.2=26
  const sorted = applySort(items.slice());
  const disp = sorted.map((p) => displayedValue(p.asin, 'profit_roe'));
  check('scraping/ROE-desc: suppressed (null) row sorts to bottom', isMonotonic(disp, 'desc'));
  check('scraping/ROE-desc: P2 (suppressed) is last', sorted[sorted.length - 1].asin === 'P2');
}

// ── Test 6: simple field sort (price) ignores stats, works in both states ──
{
  const items = setupFixtures();
  // give distinct prices in snapshot vs live
  for (let i = 0; i < 6; i++) {
    viewSnapshot.get('P' + i).product.last_price = 600 - i * 100; // snap: 600..100
    allProducts[i].last_price = 100 + i * 100;                    // live: 100..600
  }
  crawlCycleStartedAt = 1; currentSort = 'price'; currentSortDir = 'desc';
  const sortedS = applySort(items.slice());
  check('scraping/price-desc: orders by snapshot price (P0 first @600)', sortedS[0].asin === 'P0');
  crawlCycleStartedAt = 0;
  const sortedL = applySort(items.slice());
  check('stopped/price-desc: orders by live price (P5 first @600)', sortedL[0].asin === 'P5');
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAIL(S)'}`);
process.exit(fails === 0 ? 0 : 1);
