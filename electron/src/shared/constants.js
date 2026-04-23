// ── Scraping ────────────────────────────────────────────────

const AMAZON_BASE = 'https://www.amazon.co.jp';
const JA_LANG_QUERY = 'language=ja_JP&__mk_ja_JP=%E3%82%AB%E3%82%BF%E3%82%AB%E3%83%8A';

// Max ASINs per search URL. Client-tested sweet spot: 135 ASINs yields
// ~45 results (Amazon's search randomly selects a subset).
const BATCH_SIZE = 135;

// Expected fraction of the batch that Amazon actually shows. Used to
// estimate how many pages a full cycle will require.
const EXPECTED_SHOW_RATIO = 45 / 135;  // ~0.333

// Max attempts per batch in the coverage loop before giving up on the
// remaining unseen ASINs in that batch.
const MAX_COVERAGE_ATTEMPTS = 7;

// ── Pacing ──────────────────────────────────────────────────

// Token bucket: minimum ms between consecutive HTTP requests.
const FETCH_MIN_INTERVAL_MS = 2000;
// Random jitter added on top: total spacing = MIN + random(0, JITTER).
const FETCH_JITTER_MS = 2000;

// CAPTCHA / rate-limit pause ladder (ms). Each consecutive detection
// within a session escalates to the next rung.
const CAPTCHA_PAUSE_LADDER_MS = [
  2  * 60 * 1000,   // 2 min
  5  * 60 * 1000,   // 5 min
  10 * 60 * 1000,   // 10 min
  20 * 60 * 1000,   // 20 min
  30 * 60 * 1000,   // 30 min
];

// ── Data retention ──────────────────────────────────────────

const RETENTION_FULL_DAYS = 7;        // keep every observation
const RETENTION_DAILY_DAYS = 180;     // keep daily averages
// Day 181+ → deleted entirely.

// ── IPC channel ─────────────────────────────────────────────

const IPC_CHANNEL = 'app-action';

// Main → renderer push events.
const PUSH = {
  PRICE_UPDATE:    'price-update',
  CYCLE_PROGRESS:  'cycle-progress',
  CAPTCHA_PAUSE:   'captcha-pause',
  CAPTCHA_RESUME:  'captcha-resume',
  CYCLE_COMPLETE:  'cycle-complete',
};

module.exports = {
  AMAZON_BASE,
  JA_LANG_QUERY,
  BATCH_SIZE,
  EXPECTED_SHOW_RATIO,
  MAX_COVERAGE_ATTEMPTS,
  FETCH_MIN_INTERVAL_MS,
  FETCH_JITTER_MS,
  CAPTCHA_PAUSE_LADDER_MS,
  RETENTION_FULL_DAYS,
  RETENTION_DAILY_DAYS,
  IPC_CHANNEL,
  PUSH,
};
