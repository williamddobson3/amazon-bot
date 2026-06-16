//! Crawl constants — ported from `electron/src/shared/constants.js`.
//! Keep these values in sync with the JavaScript side.

pub const AMAZON_BASE: &str = "https://www.amazon.co.jp";
pub const JA_LANG_QUERY: &str =
    "language=ja_JP&__mk_ja_JP=%E3%82%AB%E3%82%BF%E3%82%AB%E3%83%8A";

// Batch sizing. 135 ASINs/URL is the empirical sweet spot; the actual
// size is drawn uniformly from [MIN, MAX] per batch so Amazon's WAF
// cannot cache-match on a constant "exactly 135 items in k=" signature.
pub const BATCH_SIZE_MIN: usize = 125;
pub const BATCH_SIZE_MAX: usize = 145;

// Estimated fraction of a batch Amazon actually shows (~45 / 135).
pub const EXPECTED_SHOW_RATIO: f64 = 45.0 / 135.0;

// Max coverage waves per cycle before bailing on the long tail.
pub const MAX_COVERAGE_ATTEMPTS: u32 = 7;

// Pacing — mean ~5.5 s/request, uniform in [4.5, 6.5] s.
pub const FETCH_MIN_INTERVAL_MS: u64 = 4_500;
pub const FETCH_JITTER_MS: u64 = 2_000;

// Two block detections within this window count as one "burst" and do
// not double-escalate the pause ladder.
pub const PAUSE_DEDUP_MS: u64 = 5_000;

// CAPTCHA / rate-limit pause ladder (ms). Each consecutive detection
// escalates to the next rung.
pub const CAPTCHA_PAUSE_LADDER_MS: [u64; 5] = [
    2 * 60 * 1_000,
    5 * 60 * 1_000,
    10 * 60 * 1_000,
    20 * 60 * 1_000,
    30 * 60 * 1_000,
];

// Circuit breaker — once the streak crosses the threshold, pacing drops
// to the slow interval for the breaker duration.
pub const CIRCUIT_BREAKER_THRESHOLD: u32 = 2;
pub const CIRCUIT_BREAKER_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
pub const CIRCUIT_BREAKER_INTERVAL_MS: u64 = 30_000;

// A real Chrome 133 User-Agent on Windows. Must NOT contain "Electron"
// or Amazon instantly classifies the client as a non-browser.
pub const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// Accept header sent with every document request (matches Chrome).
pub const ACCEPT_HTML: &str = "text/html,application/xhtml+xml,application/xml;\
q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;\
v=b3;q=0.7";
