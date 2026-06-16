//! IPC message types shared with the Electron parent process.
//!
//! Everything is serialized as newline-delimited JSON (one object per
//! line). `cmd` / `type` act as the discriminant tags so the JavaScript
//! side can `switch` on a single field.
//!
//! Direction:
//!   * [`Command`] — Electron → crawler  (read from stdin)
//!   * [`Event`]   — crawler → Electron  (written to stdout)

use serde::{Deserialize, Serialize};

/// One parsed product card from an Amazon search-result page.
///
/// Field names are emitted in camelCase so the JSON matches exactly
/// what the Electron `scheduler.js` `onPageResult` handler already
/// consumes (asin / title / imageUrl / price / points / delivery /
/// shippingFee / mpPrice / mpCount / mpCondition / monthlySales).
///
/// `shipping_fee` and `monthly_sales` were added 2026-05 per client
/// spec — the BuyBox 価格 cell shows price+shipping, the standalone
/// 送料 column shows fee-only (blank when free), and 月間販売数 shows
/// the 「過去1か月で○○点以上購入されました」 indicator.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub asin: String,
    pub title: Option<String>,
    pub image_url: Option<String>,
    pub price: Option<i64>,
    pub shipping_fee: Option<i64>,
    pub points: Option<i64>,
    pub delivery: Option<String>,
    pub mp_price: Option<i64>,
    pub mp_count: Option<i64>,
    pub mp_condition: Option<String>,
    pub monthly_sales: Option<i64>,
}

/// Commands sent from Electron to the crawler sidecar.
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// Liveness probe — crawler replies with [`Event::Pong`].
    Ping,
    /// Interrupt the in-flight crawl (if any). The current cycle stops
    /// at the next batch boundary and reports `aborted: true`.
    Abort,
    /// Clear a CAPTCHA pause early (the user finished solving). Resets
    /// `paused_until` and the streak counter. The circuit breaker, if
    /// tripped, is NOT touched — use [`Command::ClearCircuitBreaker`].
    LiftPause,
    /// Clear the circuit breaker so pacing returns to the normal
    /// interval immediately.
    ClearCircuitBreaker,
    /// Graceful shutdown request — the main loop exits cleanly.
    Shutdown,
    /// Run one crawl cycle over the given ASIN set.
    ///
    /// `cookies` is the serialized Amazon session cookie header that the
    /// Electron side exports from `session.defaultSession`. It is passed
    /// over stdin (never argv) so other processes on the machine cannot
    /// read the user's authentication token.
    Crawl {
        /// ASINs to cover this cycle.
        asins: Vec<String>,
        /// `Cookie:` header value (may be empty when logged out).
        #[serde(default)]
        cookies: String,
    },
}

/// Events emitted from the crawler back to Electron.
///
/// Variant tags are `snake_case` (`page_result`, `cycle_done`, …).
/// Struct-variant field names stay snake_case too; the Electron-side
/// `crawler-bridge.js` adapts them to the camelCase shapes the existing
/// scheduler callbacks expect. `Product` is the one exception — it is
/// already camelCase so it flows straight through to `onPageResult`.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// First line printed on startup so the parent knows the sidecar
    /// booted and which build it is.
    Ready { version: String },
    /// Reply to [`Command::Ping`].
    Pong,
    /// Parsed product cards from one search page.
    PageResult {
        results: Vec<Product>,
        page: u32,
        total_pages: u32,
    },
    /// Coverage progress after each page.
    Progress {
        done: usize,
        total: usize,
        page: u32,
        total_pages: u32,
        wave: u32,
    },
    /// A block page was hit (CAPTCHA / dog page / 429 / login wall).
    /// Carries the current pause / breaker state so the renderer can
    /// draw a countdown without an extra round trip.
    Block {
        error: String,
        reason: String,
        source: String,
        solve_url: String,
        /// Wall-clock epoch ms when the pause expires (0 = not paused).
        paused_until_ms: u64,
        /// Wall-clock epoch ms when the breaker expires (0 = inactive).
        circuit_until_ms: u64,
        /// Consecutive block count driving the pause ladder.
        captcha_streak: u32,
    },
    /// Pause / circuit-breaker state snapshot. Emitted after any
    /// state-changing command (LiftPause / ClearCircuitBreaker) and
    /// on startup so the bridge cache can stay in lock-step.
    State {
        paused_until_ms: u64,
        circuit_until_ms: u64,
        captcha_streak: u32,
    },
    /// One crawl cycle finished — final tallies.
    CycleDone {
        total: usize,
        found: usize,
        missed: usize,
        pages: u32,
        errors: u32,
        aborted: bool,
        paused: bool,
    },
    /// Human-readable diagnostic line for the parent's log.
    Log { level: String, message: String },
    /// A non-fatal error the parent should log/surface.
    Error { message: String },
}
