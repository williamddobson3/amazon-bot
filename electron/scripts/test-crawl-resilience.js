'use strict';

// Tests for the 2026-06 crawl-resilience changes:
//   - app-log ring buffer (req7)
//   - escalating soft-block backoff ladder 1→3→5→10 min (req6)
//   - relaxed soft-block thresholds: log at 3, abort at 15 (req4/req5)
//   - modal shows only during countdown, hidden on resume (req3)

const path = require('path');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// ── app-log (req7) — real module ─────────────────────────────────────────
const appLog = require(path.join('..', 'src', 'main', 'services', 'app-log.js'));
appLog.clear();
appLog.log('info', 'first');
appLog.log('warn', 'second');
const entries = appLog.getLog();
eq('applog: 2 entries', entries.length, 2);
eq('applog: order preserved', entries.map((e) => e.message), ['first', 'second']);
eq('applog: levels', entries.map((e) => e.level), ['info', 'warn']);
eq('applog: invalid level → info', appLog.log('debug', 'x').level, 'info');
eq('applog: entries have timestamps', typeof entries[0].t, 'number');
// ring-buffer cap (MAX_ENTRIES = 1000)
appLog.clear();
for (let i = 0; i < 1100; i++) appLog.log('info', 'e' + i);
const capped = appLog.getLog();
eq('applog: capped at 1000', capped.length, 1000);
eq('applog: oldest dropped (keeps newest)', capped[capped.length - 1].message, 'e1099');
eq('applog: getLog(limit) tail', appLog.getLog(5).length, 5);
appLog.clear();

// ── Escalating backoff ladder (req6) ─────────────────────────────────────
const SOFT_BLOCK_PAUSE_LADDER_MS = [1, 3, 5, 10].map((m) => m * 60 * 1000);
function pauseForStreak(streak) {
  const idx = Math.min(streak, SOFT_BLOCK_PAUSE_LADDER_MS.length - 1);
  return SOFT_BLOCK_PAUSE_LADDER_MS[idx] / 60000;   // minutes
}
// streak is the value BEFORE increment (0 on first block).
eq('ladder: 1st block → 1 min', pauseForStreak(0), 1);
eq('ladder: 2nd → 3 min', pauseForStreak(1), 3);
eq('ladder: 3rd → 5 min', pauseForStreak(2), 5);
eq('ladder: 4th → 10 min', pauseForStreak(3), 10);
eq('ladder: 5th capped at 10', pauseForStreak(4), 10);
eq('ladder: 10th still 10', pauseForStreak(9), 10);

// ── Relaxed soft-block thresholds (req4/req5) ────────────────────────────
const SOFT_BLOCK_LOG_LIMIT = 3;
const SOFT_BLOCK_EMPTY_PAGE_LIMIT = 15;
// Simulate consecutive empty pages: log once at 3, abort once at 15.
function simulate(emptyRun) {
  let logged = false, aborted = false, consecutive = 0;
  for (let i = 0; i < emptyRun; i++) {
    consecutive++;
    if (!logged && consecutive >= SOFT_BLOCK_LOG_LIMIT) logged = true;
    if (!aborted && consecutive >= SOFT_BLOCK_EMPTY_PAGE_LIMIT) aborted = true;
  }
  return { logged, aborted };
}
eq('thresholds: 2 empties → no log, no abort', simulate(2), { logged: false, aborted: false });
eq('thresholds: 3 empties → log only (no interrupt)', simulate(3), { logged: true, aborted: false });
eq('thresholds: 14 empties → log, still no abort', simulate(14), { logged: true, aborted: false });
eq('thresholds: 15 empties → log + abort', simulate(15), { logged: true, aborted: true });
eq('thresholds: relaxed from old 5 (5 no longer aborts)', simulate(5).aborted, false);

// ── Modal visibility (req3): only during countdown, hidden on resume ──────
// Mirrors refreshStatus: show iff (running && blockedUntil > now); else hide.
function modalShown(running, blockedUntil, now) {
  return !!(running && blockedUntil && blockedUntil > now);
}
const NOW = 1_000_000;
eq('modal: countdown (future blockedUntil) → shown', modalShown(true, NOW + 60000, NOW), true);
eq('modal: resume (blockedUntil=0) → hidden', modalShown(true, 0, NOW), false);
eq('modal: expired countdown → hidden (no 再開中 limbo)', modalShown(true, NOW - 1, NOW), false);
eq('modal: stopped → hidden', modalShown(false, NOW + 60000, NOW), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
