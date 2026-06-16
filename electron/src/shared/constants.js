// ── Scraping ────────────────────────────────────────────────

const AMAZON_BASE = 'https://www.amazon.co.jp';
const JA_LANG_QUERY = 'language=ja_JP&__mk_ja_JP=%E3%82%AB%E3%82%BF%E3%82%AB%E3%83%8A';

// Target batch size. 135 ASINs/URL is the empirical sweet spot — yields
// ~45 cards per page (ratio 0.333). The coverage loop draws each batch's
// actual size uniformly from [BATCH_SIZE_MIN, BATCH_SIZE_MAX] so Amazon's
// WAF can't cache-match on a constant "exactly 135 items in k=" signature.
const BATCH_SIZE     = 135;
const BATCH_SIZE_MIN = 125;
const BATCH_SIZE_MAX = 145;

// Expected fraction of a batch that Amazon actually shows. Used to
// estimate page count for the progress bar.
const EXPECTED_SHOW_RATIO = 45 / 135;  // ~0.333

// Max waves per cycle before bailing. At 10k ASINs this is the natural
// cap — waves 1–3 catch ~96%, waves 4–7 clean up the long tail.
const MAX_COVERAGE_ATTEMPTS = 7;

// ── Pacing ──────────────────────────────────────────────────
//
// Sized for a 20-minute cycle on a 10k-ASIN list. With ~212 batches per
// cycle, the budget is 1200 s ÷ 212 = 5.66 s/request. MIN=4500 +
// JITTER=2000 yields a mean of 5.5 s, uniform in [4.5, 6.5]. Effective
// rate: ~11 req/min — inside the "active human browsing" band, below
// the "bot" band Amazon's WAF flags.
const FETCH_MIN_INTERVAL_MS = 4500;
const FETCH_JITTER_MS       = 2000;

// Rest between cycles. Randomised so cycle starts don't land on
// predictable :00 / :20 / :40 boundaries — breaks scheduler-tick
// fingerprinting.
const REST_MIN_MS = 30_000;   // 30 s
const REST_MAX_MS = 150_000;  // 2 min 30 s

// CAPTCHA / rate-limit pause ladder (ms). Each consecutive detection
// within a session escalates to the next rung.
const CAPTCHA_PAUSE_LADDER_MS = [
  2  * 60 * 1000,   // 2 min
  5  * 60 * 1000,   // 5 min
  10 * 60 * 1000,   // 10 min
  20 * 60 * 1000,   // 20 min
  30 * 60 * 1000,   // 30 min
];

// Circuit breaker. If captchaStreak crosses the threshold, the fetcher
// switches to the reduced interval for CIRCUIT_BREAKER_DURATION_MS.
// Turns a cascading-failure scenario into bounded degradation.
const CIRCUIT_BREAKER_THRESHOLD   = 2;                      // 2 blocks in a row
const CIRCUIT_BREAKER_DURATION_MS = 24 * 60 * 60 * 1000;    // 24 h
const CIRCUIT_BREAKER_INTERVAL_MS = 30_000;                 // 30 s between requests

// ── Data retention ──────────────────────────────────────────

const RETENTION_FULL_DAYS  = 7;    // keep every observation
// 2026-06 spec 項目27: 監視データの最大保持期間を 180→90 日に短縮 (重要仕様変更)。
// 90 日より古い日次集計は削除される。※「180日平均実質BuyBox」列は残す
// (項目28 で CSV/Keepa 取込値を表示。監視 180 日平均は計算しない)。
const RETENTION_DAILY_DAYS = 90;   // keep daily averages
// Day 91+ → deleted entirely.

// 出品者数の保持期間 (2026-06 client spec): クロール頻度の高いデータが
// 巨大化しないよう、30 日より古い observations 行の mp_count 値だけ
// NULL に上書きする (= 行自体は通常 retention で 7 日で集計済み)。
// 日次集計の avg_mp_count は 30 日より古いものは NULL にする。
const RETENTION_MP_COUNT_DAYS = 30;

// ── IPC channel ─────────────────────────────────────────────

const IPC_CHANNEL = 'app-action';

// Main → renderer push events.
const PUSH = {
  PRICE_UPDATE:    'price-update',
  CYCLE_PROGRESS:  'cycle-progress',
  CAPTCHA_PAUSE:   'captcha-pause',
  CAPTCHA_RESUME:  'captcha-resume',
  CYCLE_COMPLETE:  'cycle-complete',
  CIRCUIT_BREAKER: 'circuit-breaker',
  LOGIN_STATE:     'login-state',
};

module.exports = {
  AMAZON_BASE,
  JA_LANG_QUERY,
  BATCH_SIZE,
  BATCH_SIZE_MIN,
  BATCH_SIZE_MAX,
  EXPECTED_SHOW_RATIO,
  MAX_COVERAGE_ATTEMPTS,
  FETCH_MIN_INTERVAL_MS,
  FETCH_JITTER_MS,
  REST_MIN_MS,
  REST_MAX_MS,
  CAPTCHA_PAUSE_LADDER_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_DURATION_MS,
  CIRCUIT_BREAKER_INTERVAL_MS,
  RETENTION_FULL_DAYS,
  RETENTION_DAILY_DAYS,
  RETENTION_MP_COUNT_DAYS,
  IPC_CHANNEL,
  PUSH,
};
