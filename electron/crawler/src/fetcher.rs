//! HTTP fetch layer — ported from
//! `electron/src/main/scraper/fetcher.js`.
//!
//! Owns the request pacing (token bucket), CAPTCHA / block-page
//! detection, the escalating pause ladder and the circuit breaker.
//! State persists for the lifetime of the sidecar process so pacing and
//! the streak counter carry across crawl cycles, exactly like the
//! original long-lived JS module.

use std::time::{Duration, Instant};

use rand::Rng;
use reqwest::StatusCode;

use crate::constants::*;

/// Outcome of a single page fetch.
#[derive(Debug)]
pub enum FetchOutcome {
    /// Page fetched successfully — `html` is the decoded body.
    Ok { html: String, final_url: String },
    /// A block page: CAPTCHA, "dog" page, login wall or network intercept.
    Block(BlockInfo),
    /// HTTP 429 — rate limited.
    RateLimited,
    /// HTTP 503 — service unavailable (transient, not counted as a block).
    ServiceUnavailable,
    /// Any other non-success HTTP status.
    HttpError { status: u16 },
    /// Transport-level failure (DNS, TLS, timeout, connection reset…).
    NetworkError { message: String },
}

/// Details of a detected block page — surfaced to Electron so the UI
/// can show the pause banner and (for solvable CAPTCHAs) a solve URL.
#[derive(Debug, Clone)]
pub struct BlockInfo {
    pub error: String,
    pub reason: String,
    pub source: String,
    pub solve_url: String,
}

/// Long-lived HTTP fetcher. One instance per sidecar process.
pub struct Fetcher {
    client: reqwest::Client,
    /// Earliest instant the next request may start (token bucket).
    next_allowed_fetch_at: Instant,
    /// While in the future, the fetcher is in a CAPTCHA pause.
    paused_until: Instant,
    /// While in the future, the circuit breaker is tripped (slow pacing).
    circuit_breaker_until: Instant,
    /// Consecutive block detections — drives the pause ladder.
    captcha_streak: u32,
    /// When the last pause was set (burst de-duplication).
    last_pause_set_at: Instant,
    /// Whether the organic-traffic warmup has run yet.
    warmed_up: bool,
}

impl Fetcher {
    /// Build the fetcher. Fails only if the TLS backend cannot init.
    pub fn new() -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(CHROME_UA)
            .gzip(true)
            .brotli(true)
            .deflate(true)
            .timeout(Duration::from_secs(30))
            .build()?;
        let now = Instant::now();
        Ok(Self {
            client,
            next_allowed_fetch_at: now,
            paused_until: now,
            circuit_breaker_until: now,
            captcha_streak: 0,
            last_pause_set_at: now,
            warmed_up: false,
        })
    }

    /// True while inside a CAPTCHA pause window.
    pub fn is_paused(&self) -> bool {
        self.paused_until > Instant::now()
    }

    /// Remaining pause duration (zero when not paused).
    pub fn pause_remaining(&self) -> Duration {
        self.paused_until.saturating_duration_since(Instant::now())
    }

    /// True while the circuit breaker is tripped.
    pub fn circuit_active(&self) -> bool {
        self.circuit_breaker_until > Instant::now()
    }

    /// Wall-clock epoch ms when the current pause expires (0 if not
    /// paused). The renderer uses this to draw a countdown banner.
    pub fn paused_until_ms(&self) -> u64 {
        if self.paused_until <= Instant::now() {
            return 0;
        }
        let remaining = self.paused_until.saturating_duration_since(Instant::now());
        ms_now().saturating_add(remaining.as_millis() as u64)
    }

    /// Wall-clock epoch ms when the circuit breaker expires.
    pub fn circuit_until_ms(&self) -> u64 {
        if self.circuit_breaker_until <= Instant::now() {
            return 0;
        }
        let remaining = self.circuit_breaker_until.saturating_duration_since(Instant::now());
        ms_now().saturating_add(remaining.as_millis() as u64)
    }

    /// Current consecutive-block streak.
    pub fn captcha_streak(&self) -> u32 {
        self.captcha_streak
    }

    /// Clear the CAPTCHA pause — the user has solved the challenge.
    /// Mirrors fetcher.js `liftPause`: resets pause / streak / burst
    /// timer but leaves the circuit breaker alone.
    pub fn lift_pause(&mut self) {
        let now = Instant::now();
        self.paused_until = now;
        self.captcha_streak = 0;
        self.last_pause_set_at = now;
    }

    /// Manually clear the circuit breaker (the user has confirmed the
    /// block rate has recovered). Pacing returns to the fast interval.
    pub fn clear_circuit_breaker(&mut self) {
        self.circuit_breaker_until = Instant::now();
    }

    /// Block until the token bucket (and any active pause) allows the
    /// next request, then reserve the following slot.
    async fn await_fetch_slot(&mut self) {
        // 1. CAPTCHA pause.
        let wait = self.paused_until.saturating_duration_since(Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        // 2. Token bucket.
        let wait = self.next_allowed_fetch_at.saturating_duration_since(Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        // 3. Reserve the next slot — interval depends on breaker state.
        let min_interval = if self.circuit_active() {
            CIRCUIT_BREAKER_INTERVAL_MS
        } else {
            FETCH_MIN_INTERVAL_MS
        };
        let jitter = rand::thread_rng().gen_range(0..FETCH_JITTER_MS);
        self.next_allowed_fetch_at =
            Instant::now() + Duration::from_millis(min_interval + jitter);
    }

    /// Escalate the pause ladder after a block detection and, once the
    /// streak crosses the threshold, trip the circuit breaker.
    fn trigger_pause(&mut self) {
        let now = Instant::now();
        let within_burst =
            now.saturating_duration_since(self.last_pause_set_at)
                < Duration::from_millis(PAUSE_DEDUP_MS);
        if !within_burst {
            self.captcha_streak += 1;
        }
        self.last_pause_set_at = now;

        let idx = (self.captcha_streak.saturating_sub(1) as usize)
            .min(CAPTCHA_PAUSE_LADDER_MS.len() - 1);
        let delay = CAPTCHA_PAUSE_LADDER_MS[idx];
        self.paused_until = now + Duration::from_millis(delay);

        if self.captcha_streak >= CIRCUIT_BREAKER_THRESHOLD
            && self.circuit_breaker_until < now
        {
            self.circuit_breaker_until =
                now + Duration::from_millis(CIRCUIT_BREAKER_DURATION_MS);
        }
    }

    /// Fetch one page. `cookies` is the `Cookie:` header value (empty
    /// when logged out). Applies pacing, classifies block pages, and
    /// updates pause / streak / breaker state as a side effect.
    pub async fn fetch_page(&mut self, url: &str, cookies: &str) -> FetchOutcome {
        self.await_fetch_slot().await;

        let mut req = self
            .client
            .get(url)
            .header("Accept", ACCEPT_HTML)
            .header("Accept-Language", "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7")
            .header("Referer", format!("{AMAZON_BASE}/"))
            .header("Upgrade-Insecure-Requests", "1")
            .header(
                "sec-ch-ua",
                r#""Chromium";v="133", "Not:A-Brand";v="24", "Google Chrome";v="133""#,
            )
            .header("sec-ch-ua-mobile", "?0")
            .header("sec-ch-ua-platform", r#""Windows""#)
            .header("sec-fetch-dest", "document")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-site", "same-origin")
            .header("sec-fetch-user", "?1");
        if !cookies.is_empty() {
            req = req.header(reqwest::header::COOKIE, cookies);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return FetchOutcome::NetworkError { message: e.to_string() },
        };

        let status = resp.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.trigger_pause();
            return FetchOutcome::RateLimited;
        }
        if status == StatusCode::SERVICE_UNAVAILABLE {
            return FetchOutcome::ServiceUnavailable;
        }
        if !status.is_success() {
            return FetchOutcome::HttpError { status: status.as_u16() };
        }

        let final_url = resp.url().to_string();
        let html = match resp.text().await {
            Ok(t) => t,
            Err(e) => return FetchOutcome::NetworkError { message: e.to_string() },
        };

        if let Some(block) = classify_block(&html, &final_url) {
            self.trigger_pause();
            return FetchOutcome::Block(block);
        }

        // Clean fetch — reset the streak (mirrors fetcher.js resetStreak).
        self.captcha_streak = 0;
        FetchOutcome::Ok { html, final_url }
    }

    /// Seed the session with a little organic traffic before the first
    /// scrape burst — homepage, then maybe bestsellers / a generic
    /// search. Runs at most once per process. Failures are swallowed:
    /// warmup is best-effort, never fatal.
    pub async fn warmup(&mut self, cookies: &str) {
        if self.warmed_up {
            return;
        }
        self.warmed_up = true;

        let mut urls = vec![format!("{AMAZON_BASE}/")];
        {
            let mut rng = rand::thread_rng();
            if rng.gen_bool(0.5) {
                urls.push(format!("{AMAZON_BASE}/gp/bestsellers"));
            }
            if rng.gen_bool(0.5) {
                const QUERIES: [&str; 4] = ["ベストセラー", "新着", "セール", "人気"];
                let q = QUERIES[rng.gen_range(0..QUERIES.len())];
                let enc: String = url_encode(q);
                urls.push(format!("{AMAZON_BASE}/s?k={enc}&{JA_LANG_QUERY}"));
            }
        }
        for url in urls {
            // Discard the outcome — warmup only needs the cookie jar /
            // referrer chain to settle, not the body.
            let _ = self.fetch_page(&url, cookies).await;
        }
    }
}

/// Diagnostic one-shot fetch (2026-06 client要望: 「Amazonが返したページを確認」が
/// スクレイパーと完全に同じページを表示するため)。スクレイパーと同一の reqwest
/// クライアント設定・同一のリクエストヘッダで `url` を 1 回だけ取得し、
/// `(status, final_url, html)` を返す。ペーシング/ポーズ/ストリーク状態には
/// 一切触れない (使い捨てクライアント) — 純粋な診断用。
pub async fn fetch_raw(url: &str, cookies: &str) -> anyhow::Result<(u16, String, String)> {
    let client = reqwest::Client::builder()
        .user_agent(CHROME_UA)
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut req = client
        .get(url)
        .header("Accept", ACCEPT_HTML)
        .header("Accept-Language", "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7")
        .header("Referer", format!("{AMAZON_BASE}/"))
        .header("Upgrade-Insecure-Requests", "1")
        .header(
            "sec-ch-ua",
            r#""Chromium";v="133", "Not:A-Brand";v="24", "Google Chrome";v="133""#,
        )
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", r#""Windows""#)
        .header("sec-fetch-dest", "document")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-site", "same-origin")
        .header("sec-fetch-user", "?1");
    if !cookies.is_empty() {
        req = req.header(reqwest::header::COOKIE, cookies);
    }
    let resp = req.send().await?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let html = resp.text().await?;
    Ok((status, final_url, html))
}

/// Current wall-clock epoch ms. Used for `paused_until_ms` /
/// `circuit_until_ms` so the renderer can draw a countdown.
pub fn ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Minimal percent-encoding for warmup query strings (Japanese terms).
/// Only used for organic-traffic seeding so a tiny encoder is enough.
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Classify a fetched page as a block, or `None` if it looks like a
/// normal Amazon search-result page. Ported from fetcher.js
/// `classifyBlock` — order of checks is significant.
fn classify_block(html: &str, final_url: &str) -> Option<BlockInfo> {
    let block = |error: &str, reason: &str, source: &str| {
        Some(BlockInfo {
            error: error.to_string(),
            reason: reason.to_string(),
            source: source.to_string(),
            solve_url: final_url.to_string(),
        })
    };

    if final_url.contains("google.com/sorry")
        || final_url.contains("google.co.jp/sorry")
        || final_url.contains("ipv4.google.com")
        || html.contains("unusual traffic from your computer network")
        || html.contains("お使いのコンピュータ ネットワークから異常なトラフィック")
    {
        return block("GOOGLE_CAPTCHA", "Google IP-level bot detection", "google");
    }

    if html.contains("google.com/recaptcha") || html.contains("g-recaptcha") {
        return block("GOOGLE_RECAPTCHA", "Google reCAPTCHA widget", "google");
    }

    if !final_url.contains("amazon.co.jp")
        && !final_url.contains("google.com")
        && !final_url.contains("google.co.jp")
        && !final_url.starts_with("about:")
        && !final_url.starts_with("chrome")
    {
        return block("NETWORK_BLOCK", "Network interception", "network");
    }

    if html.contains("validateCaptcha")
        || html.contains("Type the characters you see in this image")
        || html.contains("画像に表示されている文字を入力してください")
    {
        return block("CAPTCHA", "Amazon CAPTCHA", "amazon");
    }

    if html.contains("Sorry, we just need to make sure")
        || (html.contains("cs-help-home") && html.len() < 5_000)
    {
        return block("DOG_PAGE", "Amazon dog page", "amazon");
    }

    if final_url.contains("/ap/signin")
        || final_url.contains("/ap/register")
        || (html.contains("ap_email") && html.contains("ap_password"))
    {
        return block("LOGIN_REDIRECT", "Amazon login wall", "amazon");
    }

    None
}
