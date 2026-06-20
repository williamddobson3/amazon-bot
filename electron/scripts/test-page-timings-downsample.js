'use strict';

//
// クロール診断「1ページ取得時間」の間引き取得 (2026-06 client B16) のテスト。
//
// 旧: getPageTimingsSince = ORDER BY recorded_at ASC LIMIT 5000 → 件数の多い窓
// (24h ≒ 1.5万件) では「最古5000件」だけ返り、直近のオレンジ線が消えていた。
// 新: 窓全体を等間隔で間引き (最新 rn=1 起点の stride サンプリング)、最大 5000 件。
//
// getPageTimingsSince は ./sqlite(better-sqlite3) 依存で node から直接 require でき
// ないため、同一 SQL を node:sqlite + 実 migrations 上で写経して挙動を検証し、併せて
// queries.js のソースを照合する。
//

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
function ok(name, cond) { eq(name, !!cond, true); }

// getPageTimingsSince の SQL を写経 (queries.js と一致させること)。
const COLS = 'recorded_at, cycle, page, total_pages, elapsed_ms';
function getPageTimingsSince(db, sinceMs, targetMax = 5000) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM page_timings WHERE recorded_at >= ?').get(sinceMs).c;
  if (total <= targetMax) {
    return db.prepare(`SELECT ${COLS} FROM page_timings WHERE recorded_at >= ? ORDER BY recorded_at ASC`).all(sinceMs);
  }
  const stride = Math.ceil(total / targetMax);
  return db.prepare(
    `SELECT ${COLS} FROM (SELECT ${COLS}, ROW_NUMBER() OVER (ORDER BY recorded_at DESC) AS rn ` +
    'FROM page_timings WHERE recorded_at >= ?) WHERE (rn - 1) % ? = 0 ORDER BY recorded_at ASC'
  ).all(sinceMs, stride);
}
// 旧 (バグ) 実装 — 比較用。
function getOld(db, sinceMs, limit = 5000) {
  return db.prepare(`SELECT ${COLS} FROM page_timings WHERE recorded_at >= ? ORDER BY recorded_at ASC LIMIT ?`).all(sinceMs, limit);
}

// ── データ生成: 24h ぶんを 5.5秒間隔で投入 (≒ 1.5万件、5000 を大きく超える) ─────
const db = new DatabaseSync(':memory:');
runMigrations(db);
const NOW = 1_700_000_000_000;
const STEP = 5500;
const ins = db.prepare('INSERT INTO page_timings (recorded_at, cycle, page, total_pages, elapsed_ms) VALUES (?,?,?,?,?)');
let lastTs = 0, count = 0;
for (let t = NOW - 24 * 3600 * 1000, i = 0; t <= NOW; t += STEP, i++) {
  ins.run(t, 1, i % 45, 45, 5000 + (i % 2000));
  lastTs = t; count++;
}
ok('24h 投入件数 > 5000 (間引き対象)', count > 5000);

const HOUR = 3600 * 1000;
const span = (rows) => rows.length ? (rows[rows.length - 1].recorded_at - rows[0].recorded_at) : 0;
const sortedAsc = (rows) => rows.every((r, i) => i === 0 || r.recorded_at >= rows[i - 1].recorded_at);

// ── 24時間窓 (>5000) — 間引きで窓全体を覆う ─────────────────────────────────
const since24 = NOW - 24 * HOUR;
const totalIn24 = db.prepare('SELECT COUNT(*) AS c FROM page_timings WHERE recorded_at >= ?').get(since24).c;
const rows24 = getPageTimingsSince(db, since24);
ok('24h: 返却件数 <= 5000 (上限内)',        rows24.length <= 5000);
ok('24h: 返却件数 > 3000 (間引きで十分残る)', rows24.length > 3000);
ok('24h: 昇順ソート',                        sortedAsc(rows24));
// ★ バグ修正の核: 最新の点が必ず含まれ、線が直近(now)まで届く。
eq('24h: 最新の点 = 実際の最新 (直近まで描画)', rows24[rows24.length - 1].recorded_at, lastTs);
ok('24h: 窓ほぼ全体を覆う (>=23h スパン)',    span(rows24) >= 23 * HOUR);
// 最古の点も窓の先頭付近 (stride*step 以内)。
ok('24h: 先頭も窓開始付近',                  rows24[0].recorded_at - since24 <= STEP * Math.ceil(totalIn24 / 5000));

// 旧実装との対比 — 旧は最新が窓開始から ~7.6h で頭打ち、直近が大きく欠ける。
const old24 = getOld(db, since24);
eq('旧実装: 5000件で頭打ち', old24.length, 5000);
ok('旧実装: 最新点が now から大きく遅れる (>15h 欠落)', (NOW - old24[old24.length - 1].recorded_at) > 15 * HOUR);
ok('新実装: 最新点は now 直近 (欠落 < 1分)', (NOW - rows24[rows24.length - 1].recorded_at) < 60 * 1000);

// ── 6時間窓 (<5000) — 全件返す (間引きなし) ─────────────────────────────────
const since6 = NOW - 6 * HOUR;
const totalIn6 = db.prepare('SELECT COUNT(*) AS c FROM page_timings WHERE recorded_at >= ?').get(since6).c;
const rows6 = getPageTimingsSince(db, since6);
ok('6h: 窓内件数 < 5000',          totalIn6 < 5000);
eq('6h: 全件返す (間引きなし)',     rows6.length, totalIn6);
eq('6h: 最新の点 = 実際の最新',     rows6[rows6.length - 1].recorded_at, lastTs);
ok('6h: 昇順ソート',               sortedAsc(rows6));

// 空・少数の窓も壊れない。
const rowsEmpty = getPageTimingsSince(db, NOW + HOUR);
eq('空窓 → []', rowsEmpty.length, 0);

// ── ソース照合: queries.js が新方式 ────────────────────────────────────────
const qsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'db', 'queries.js'), 'utf8');
ok('queries: COUNT + targetMax 分岐', qsrc.includes('SELECT COUNT(*) AS c FROM page_timings WHERE recorded_at >= ?') && qsrc.includes('total <= targetMax'));
ok('queries: ROW_NUMBER OVER (ORDER BY recorded_at DESC)', qsrc.includes('ROW_NUMBER() OVER (ORDER BY recorded_at DESC)'));
ok('queries: stride サンプリング (rn-1)%?', qsrc.includes('WHERE (rn - 1) % ? = 0 ORDER BY recorded_at ASC'));
// getPageTimingsSince 関数内のみで旧 LIMIT 切り捨てが消えていること (cycle 側の LIMIT は維持)。
const fnStart = qsrc.indexOf('function getPageTimingsSince');
const fnEnd   = qsrc.indexOf('\nfunction ', fnStart + 1);
const fnSrc   = qsrc.slice(fnStart, fnEnd);
ok('queries: getPageTimingsSince に LIMIT ? が無い (切り捨て撤去)', !fnSrc.includes('LIMIT ?'));
// cycle_timings 側は従来どおり LIMIT を維持 (件数が少なく切り捨て問題なし)。
ok('queries: getCycleTimingsSince は LIMIT 維持', qsrc.includes('FROM cycle_timings WHERE recorded_at >= ? ORDER BY recorded_at ASC LIMIT ?'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
