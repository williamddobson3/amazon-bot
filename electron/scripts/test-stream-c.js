'use strict';

// Stream C integration test (spec 項目19/20/21/25/26). node:sqlite + REAL migrations.js.
// Verifies the import seed-precedence SQL and the 30-day BuyBox import wiring:
//   19: Keepa never seeds the current BuyBox price (seedValue = null for keepa)
//   20: CSV seeds from 「新品: 現在価格」 when 「Buy Box: 現在価格」 is empty
//   21: seed applies ONLY when last_price IS NULL (monitoring value wins)
//   25/26: imp_buybox_30d column stored + applyImportedAvg(30) display override

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
runMigrations(db);

const cols = db.prepare('PRAGMA table_info(products)').all().map((r) => r.name);
eq('imp_buybox_30d column exists', cols.includes('imp_buybox_30d'), true);

// ── Exact seed SQL from queries.importProductsWithKeepaData ──────────────
const seedUpdate = db.prepare(`
  UPDATE products SET
    imp_buybox_30d    = ?,
    last_price        = CASE WHEN last_price IS NULL THEN COALESCE(?, last_price) ELSE last_price END,
    last_points       = CASE WHEN last_price IS NULL AND ? IS NOT NULL THEN 0 ELSE last_points END,
    last_shipping_fee = CASE WHEN last_price IS NULL AND ? IS NOT NULL THEN 0 ELSE last_shipping_fee END
  WHERE asin = ?
`);
const insertProduct = db.prepare('INSERT OR IGNORE INTO products (asin, added_at) VALUES (?, ?)');
const setLive = db.prepare('UPDATE products SET last_price=?, last_points=?, last_shipping_fee=? WHERE asin=?');
const row = (asin) => db.prepare('SELECT last_price, last_points, last_shipping_fee, imp_buybox_30d FROM products WHERE asin=?').get(asin);

// A) New product (last_price NULL), CSV seed = 5000 → seeds price, points/shipping → 0.
insertProduct.run('A1', 1);
seedUpdate.run(7000, 5000, 5000, 5000, 'A1');
eq('A seed price', row('A1').last_price, 5000);
eq('A points → 0', row('A1').last_points, 0);
eq('A shipping → 0', row('A1').last_shipping_fee, 0);
eq('A imp_buybox_30d stored', row('A1').imp_buybox_30d, 7000);

// B) New product, seedValue = null (e.g. Keepa, or CSV with no BuyBox/新品) → no seed.
insertProduct.run('B1', 1);
seedUpdate.run(6800, null, null, null, 'B1');
eq('B price stays NULL', row('B1').last_price, null);
eq('B points stays NULL', row('B1').last_points, null);
eq('B imp_buybox_30d stored even without seed', row('B1').imp_buybox_30d, 6800);

// C) Monitored product (last_price=3000, points=50, shipping=100) — seed must NOT touch it (項目21).
insertProduct.run('C1', 1);
setLive.run(3000, 50, 100, 'C1');
seedUpdate.run(6900, 5000, 5000, 5000, 'C1');
eq('C monitoring price wins', row('C1').last_price, 3000);
eq('C points untouched', row('C1').last_points, 50);
eq('C shipping untouched', row('C1').last_shipping_fee, 100);
eq('C imp_buybox_30d still updates', row('C1').imp_buybox_30d, 6900);

// ── seedValue computation (queries.js JS logic) ─────────────────────────
function seedValue(histSource, rec) {
  return (histSource === 'keepa') ? null : (rec.displayBuyboxCurrent ?? rec.newCurrentPrice ?? null);
}
eq('CSV: BuyBox preferred',        seedValue('csv', { displayBuyboxCurrent: 5000, newCurrentPrice: 4500 }), 5000);
eq('CSV: 新品 fallback (項目20)',  seedValue('csv', { displayBuyboxCurrent: null, newCurrentPrice: 4500 }), 4500);
eq('CSV: both empty → null',       seedValue('csv', { displayBuyboxCurrent: null, newCurrentPrice: null }), null);
eq('Keepa: always null (項目19)',  seedValue('keepa', { displayBuyboxCurrent: 5000, newCurrentPrice: 4500 }), null);

// ── applyImportedAvg(30) display logic (getProductStats) — item 25/26 ────
// override avg30d with imp_buybox_30d while monitoredDays < 30.
function effectiveAvg30(monitoredDays, computedAvg30, imp30) {
  let v = computedAvg30;
  if (imp30 != null && monitoredDays < 30) v = imp30;
  return v;
}
eq('30d: import shown while <30d monitored', effectiveAvg30(10, 1234, 9000), 9000);
eq('30d: computed used once ≥30d monitored', effectiveAvg30(45, 1234, 9000), 1234);
eq('30d: no import → computed', effectiveAvg30(10, 1234, null), 1234);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
