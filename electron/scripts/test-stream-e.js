'use strict';

// Tests for spec 項目27/28/29/30. node:sqlite + REAL migrations.js for the DB
// behavior; require() of constants.js; source-structure checks for renderer/HTML.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require(path.join('..', 'src', 'main', 'db', 'migrations.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const rj  = fs.readFileSync(path.join('src', 'renderer', 'renderer.js'), 'utf8');
const idx = fs.readFileSync(path.join('src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join('src', 'renderer', 'styles.css'), 'utf8');

// ── 項目27 — retention 180→90 + 180 removed from selectors ───────────────
const C = require(path.join('..', 'src', 'shared', 'constants.js'));
eq('27: RETENTION_DAILY_DAYS = 90', C.RETENTION_DAILY_DAYS, 90);
eq('27: sparkline 180 removed', /label: '直近180日'/.test(rj), false);
eq('27: sparkline 90 kept', /label: '直近90日'/.test(rj), true);
eq('27: detail-graph 6m radio removed', idx.includes('name="chart-period" value="6m"'), false);
eq('27: detail-graph 90d radio kept', idx.includes('name="chart-period" value="3m"'), true);
eq('27: stale sparklineDays 180 → 90 guard', rj.includes('if (sparklineDays === 180) sparklineDays = 90'), true);

// ── 項目28 — averaging-source inversion ──────────────────────────────────
// New rule: import value ALWAYS wins when present (no monitoredDays guard).
function effAvg(impVal, computed) { return (impVal != null) ? Math.round(impVal) : computed; }
eq('28: import wins even with full monitoring', effAvg(9000, 1234), 9000);
eq('28: fallback to monitoring when no import', effAvg(null, 1234), 1234);
eq('28: monitoredDays guard removed', /if \(monitoredDays >= days\) return/.test(
  fs.readFileSync(path.join('src','main','db','queries.js'),'utf8')), false);
// 30/90/180 are import-overridable; 1d/7d are NOT (no applyImportedAvg call).
const qj = fs.readFileSync(path.join('src','main','db','queries.js'),'utf8');
eq('28: applyImportedAvg(30) present', qj.includes('applyImportedAvg(30,'), true);
eq('28: applyImportedAvg(90) present', qj.includes('applyImportedAvg(90,'), true);
eq('28: applyImportedAvg(180) present', qj.includes('applyImportedAvg(180,'), true);
eq('28: NO applyImportedAvg(7) (7日=monitoring)', qj.includes('applyImportedAvg(7,'), false);
eq('28: NO applyImportedAvg(1) (1日=monitoring)', qj.includes('applyImportedAvg(1,'), false);

// ── 項目29 — notify-history columns: schema + record + reset (REAL SQL) ───
const db = new DatabaseSync(':memory:');
runMigrations(db);
const cols = db.prepare('PRAGMA table_info(products)').all().map((r) => r.name);
eq('29: last_notified_at column', cols.includes('last_notified_at'), true);
eq('29: notify_hit_count column', cols.includes('notify_hit_count'), true);

db.prepare('INSERT OR IGNORE INTO products (asin, added_at) VALUES (?, ?)').run('N1', 1);
const get = (a) => db.prepare('SELECT notify_hit_count AS c, last_notified_at AS t, trashed_at AS tr FROM products WHERE asin=?').get(a);
eq('29: new product count defaults 0', get('N1').c, 0);
eq('29: new product never-notified null', get('N1').t, null);

// recordNotificationHit SQL (queries.js) — increment + set timestamp.
const hit = db.prepare('UPDATE products SET notify_hit_count = COALESCE(notify_hit_count, 0) + 1, last_notified_at = ? WHERE asin = ?');
hit.run(1000, 'N1'); hit.run(2000, 'N1');
eq('29: count increments to 2', get('N1').c, 2);
eq('29: last_notified_at updated', get('N1').t, 2000);

// restoreProducts SQL — reset count + last_notified_at on restore from trash.
db.prepare('UPDATE products SET trashed_at = ? WHERE asin = ?').run(5000, 'N1');   // trash it
db.prepare('UPDATE products SET trashed_at = NULL, notify_hit_count = 0, last_notified_at = NULL WHERE asin = ? AND trashed_at IS NOT NULL').run('N1');
eq('29: restore resets count to 0', get('N1').c, 0);
eq('29: restore clears last_notified_at', get('N1').t, null);
eq('29: restore clears trashed_at', get('N1').tr, null);

// 通知なし経過日数 (notifyGapDays) — floor((now - last)/day); never → '—'.
function gapDays(now, last) { return last == null ? '—' : `${Math.floor((now - last) / 86_400_000)}日`; }
eq('29: gap 3 days', gapDays(3.5 * 86_400_000, 0), '3日');
eq('29: gap never → —', gapDays(1000, null), '—');

// Column placement: notify cols are movable pos 4/5/6, regdate pushed to 7.
const mc = rj.slice(rj.indexOf('const MOVABLE_COLUMNS'));
const mcBody = mc.slice(0, mc.indexOf('];'));
const posOf = (id) => { const m = mcBody.match(new RegExp(`id: '${id}',\\s*pos: (\\d+)`)); return m ? +m[1] : null; };
eq('29: notifyLast pos 4', posOf('notifyLast'), 4);
eq('29: notifyCount pos 5', posOf('notifyCount'), 5);
eq('29: notifyGap pos 6', posOf('notifyGap'), 6);
eq('29: regdate pushed to pos 7', posOf('regdate'), 7);
eq('29: storageFee pos 36', posOf('storageFee'), 36);
// notify cells/headers present in leading sections.
eq('29: notifyCellsHtml has 3 data-f cells', (rj.match(/data-f="notify(Last|Count|Gap)"/g) || []).length, 3);
eq('29: 3 notify headers (data-col)', (rj.match(/data-col="notify(Last|Count|Gap)"/g) || []).length, 3);

// ── Column count consistency at 36 ───────────────────────────────────────
const posList = [...mcBody.matchAll(/pos:\s*(\d+)/g)].map((m) => +m[1]);
eq('cols: 33 movable, 4..36 contiguous',
   posList.length === 33 && posList[0] === 4 && posList[posList.length - 1] === 36
     && posList.every((p, i) => i === 0 || p === posList[i - 1] + 1), true);
const gt = css.slice(css.indexOf('.viewer-row {'));
const gtc = gt.slice(gt.indexOf('grid-template-columns:'), gt.indexOf('align-items'));
eq('cols: CSS grid = 36', [...gtc.matchAll(/\b\d+px\b/g)].length, 36);

// ── 項目30 — sort + filter for the 3 notify columns ──────────────────────
for (const k of ['notify_last', 'notify_count', 'notify_gap']) {
  eq(`30: SORT_EXTRACTORS ${k}`, new RegExp(`${k}:\\s*\\(p\\)`).test(rj), true);
  eq(`30: SORT_DIR_LABELS ${k}`, new RegExp(`${k}:\\s*\\{ desc`).test(rj), true);
  eq(`30: sort option ${k}`, idx.includes(`value="${k}"`), true);
}
const rr = rj.slice(rj.indexOf('const RANGE_ROWS = ['));
const rrBody = rr.slice(0, rr.indexOf('\n];'));
for (const k of ['notifyLast', 'notifyCount', 'notifyGap']) {
  eq(`30: RANGE_ROWS ${k}`, new RegExp(`key: '${k}'`).test(rrBody), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
