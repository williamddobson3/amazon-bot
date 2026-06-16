'use strict';

// Stream B integration test (spec 項目14/15/16). Uses the built-in node:sqlite
// (better-sqlite3 is Electron-ABI only) + the REAL migrations.js schema, then
// exercises the exact SQL behavior the queries.js paths rely on:
//   - imp_amazon_current blank-overwrite vs column-absent keep (項目14)
//   - amazon_price_history recording (項目14/15)
//   - 30-day listing ratio + ≥2-points rule (項目15)
//   - chart series (price IS NOT NULL) (項目14)
//   - retention prune (項目14/15)

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { runMigrations } = require(path.join('..', 'src', 'main', 'db', 'migrations.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const db = new DatabaseSync(':memory:');
runMigrations(db);   // ← the actual production schema, incl. amazon_price_history + imp_amazon_current

// Confirm the migration created the new column + table.
const prodCols = db.prepare("PRAGMA table_info(products)").all().map((r) => r.name);
eq('imp_amazon_current column exists', prodCols.includes('imp_amazon_current'), true);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
eq('amazon_price_history table exists', tables.includes('amazon_price_history'), true);

// ── Replicate the import write path (queries.importProductsWithKeepaData) ──
// The exact imp_amazon_current CASE + the history INSERT my code uses.
const insertProduct = db.prepare('INSERT OR IGNORE INTO products (asin, added_at) VALUES (?, ?)');
const updateAmazon  = db.prepare(
  'UPDATE products SET imp_amazon_current = CASE WHEN ? = 1 THEN ? ELSE imp_amazon_current END WHERE asin = ?'
);
const insertHist = db.prepare(
  'INSERT INTO amazon_price_history (asin, observed_at, price, source) VALUES (?, ?, ?, ?)'
);
function simulateImport(asin, ts, { hasAmazon, amazonCurrent, source }) {
  insertProduct.run(asin, ts);
  const flag = hasAmazon ? 1 : 0;
  updateAmazon.run(flag, amazonCurrent ?? null, asin);
  if (hasAmazon) insertHist.run(asin, ts, amazonCurrent ?? null, source || 'csv');
}
const getImpAmazon = (asin) => db.prepare('SELECT imp_amazon_current AS v FROM products WHERE asin = ?').get(asin).v;
const ASIN = 'B000000001';
const t0 = 1_000_000_000_000;
const DAY = 86_400_000;

// A) CSV import with Amazon column = 5000.
simulateImport(ASIN, t0, { hasAmazon: true, amazonCurrent: 5000, source: 'csv' });
eq('A imp_amazon_current = 5000', getImpAmazon(ASIN), 5000);

// B) Re-import, Amazon column present but blank → overwrite to NULL (blank-overwrite).
simulateImport(ASIN, t0 + 1000, { hasAmazon: true, amazonCurrent: null, source: 'csv' });
eq('B blank overwrites to NULL', getImpAmazon(ASIN), null);

// C) Re-import WITHOUT the Amazon column → keep existing value (still NULL), no new history row.
const histBeforeC = db.prepare('SELECT COUNT(*) c FROM amazon_price_history WHERE asin=?').get(ASIN).c;
simulateImport(ASIN, t0 + 2000, { hasAmazon: false });
eq('C column-absent keeps value', getImpAmazon(ASIN), null);
eq('C column-absent records no history', db.prepare('SELECT COUNT(*) c FROM amazon_price_history WHERE asin=?').get(ASIN).c, histBeforeC);

// D) Keepa refresh, Amazon = 6000 → overwrite + history (source keepa).
simulateImport(ASIN, t0 + 3000, { hasAmazon: true, amazonCurrent: 6000, source: 'keepa' });
eq('D keepa imp_amazon_current = 6000', getImpAmazon(ASIN), 6000);
eq('D keepa history source', db.prepare("SELECT source FROM amazon_price_history WHERE asin=? ORDER BY observed_at DESC LIMIT 1").get(ASIN).source, 'keepa');

// ── E) 30-day listing ratio (getProductStats SQL) ───────────────────────
// History so far for ASIN: [5000, NULL, 6000] within 30d (3 points, 2 with value).
const now = t0 + 4000;
const ratioRow = db.prepare(
  'SELECT COUNT(*) AS total, COUNT(price) AS withVal FROM amazon_price_history WHERE asin = ? AND observed_at >= ?'
).get(ASIN, now - 30 * DAY);
eq('E total points', ratioRow.total, 3);
eq('E with-value points', ratioRow.withVal, 2);
const ratio = (ratioRow.total >= 2) ? (ratioRow.withVal / ratioRow.total) * 100 : null;
eq('E ratio = 66.67%', Math.round(ratio * 100) / 100, 66.67);

// F) ≥2-points rule: product with a single point → ratio null.
const SOLO = 'B000000002';
simulateImport(SOLO, now, { hasAmazon: true, amazonCurrent: 1000, source: 'csv' });
const soloRow = db.prepare(
  'SELECT COUNT(*) AS total, COUNT(price) AS withVal FROM amazon_price_history WHERE asin = ? AND observed_at >= ?'
).get(SOLO, now - 30 * DAY);
const soloRatio = (soloRow.total >= 2) ? (soloRow.withVal / soloRow.total) * 100 : null;
eq('F single point → ratio null', soloRatio, null);

// G) Chart series — only price IS NOT NULL points, in window, ordered.
const series = db.prepare(
  'SELECT observed_at AS t, price AS v FROM amazon_price_history WHERE asin = ? AND observed_at >= ? AND observed_at <= ? AND price IS NOT NULL ORDER BY observed_at ASC'
).all(ASIN, t0 - DAY, now);
eq('G chart series values', series.map((r) => r.v), [5000, 6000]);

// H) Retention prune — drop points older than the cutoff.
const OLD = 'B000000003';
simulateImport(OLD, now - 200 * DAY, { hasAmazon: true, amazonCurrent: 999, source: 'csv' });   // 200d old
simulateImport(OLD, now, { hasAmazon: true, amazonCurrent: 1234, source: 'csv' });               // fresh
const cutoff = now - 180 * DAY;
db.prepare('DELETE FROM amazon_price_history WHERE observed_at < ?').run(cutoff);
const remaining = db.prepare('SELECT price FROM amazon_price_history WHERE asin = ? ORDER BY observed_at').all(OLD).map((r) => r.price);
eq('H retention drops only the old point', remaining, [1234]);

// ── Renderer-side logic (mirrors renderer.js) ───────────────────────────
// ratio display: ≥2 points → "N%", else "—".
function ratioCell(stats) {
  const r = stats.amazonListingRatio30d;
  return (r == null || !isFinite(r)) ? '—' : `${Math.round(r)}%`;
}
eq('cell shows 67%', ratioCell({ amazonListingRatio30d: 66.67 }), '67%');
eq('cell shows — when null', ratioCell({ amazonListingRatio30d: null }), '—');

// 空白含む filter logic (passesAllConditions): includeBlank default true.
function inRange(val, range) {
  if (val == null) return false;
  const min = (range.min == null) ? -Infinity : range.min;
  const max = (range.max == null) ? Infinity : range.max;
  return val >= min && val <= max;
}
function ratioFilterPasses(val, range) {
  if (range.includeBlankOpt && val == null && range.includeBlank !== false) return true;
  return inRange(val, range);
}
const r50 = { min: 50, max: null, includeBlankOpt: true };
eq('filter: 67% passes ≥50', ratioFilterPasses(67, r50), true);
eq('filter: 40% fails ≥50',  ratioFilterPasses(40, r50), false);
eq('filter: blank passes when 空白含む ON (default)', ratioFilterPasses(null, { ...r50, includeBlank: true }), true);
eq('filter: blank excluded when 空白含む OFF',        ratioFilterPasses(null, { ...r50, includeBlank: false }), false);

// ── includeBlank persistence + default semantics ────────────────────────
// parseFnmState rule: includeBlank = (src.includeBlank === false) ? false : true.
function parseIncludeBlank(src) { return (src.includeBlank === false) ? false : true; }
eq('parse: false preserved',        parseIncludeBlank({ includeBlank: false }), false);
eq('parse: true preserved',         parseIncludeBlank({ includeBlank: true }),  true);
eq('parse: missing → default true', parseIncludeBlank({}),                       true);
// renderRangesGrid checkbox: checked unless explicitly false.
function blankChecked(r) { return r.includeBlank === false ? '' : 'checked'; }
eq('render: undefined → checked', blankChecked({}), 'checked');
eq('render: false → unchecked',   blankChecked({ includeBlank: false }), '');
// read-back default when checkbox element missing → true.
function readbackBlank(bb) { return bb ? !!bb.checked : true; }
eq('readback: no element → true', readbackBlank(null), true);
eq('readback: checked element',   readbackBlank({ checked: true }), true);
eq('readback: unchecked element', readbackBlank({ checked: false }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
