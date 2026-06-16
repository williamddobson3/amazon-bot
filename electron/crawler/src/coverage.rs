//! Coverage loop — ported from
//! `electron/src/main/scraper/coverage-loop.js`.
//!
//! Amazon's search shows only ~45 of ~135 OR-joined ASINs per page, and
//! *which* 45 is random. The loop fetches batches, records the ASINs
//! that appeared, and re-queues the rest into the next wave until every
//! ASIN is covered (or [`MAX_COVERAGE_ATTEMPTS`] waves are exhausted).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use rand::Rng;
use tokio::sync::mpsc::UnboundedSender;

use crate::constants::*;
use crate::fetcher::{FetchOutcome, Fetcher};
use crate::parser::parse_search_results;
use crate::protocol::Event;

/// Final tallies for one crawl cycle.
#[derive(Debug, Default)]
pub struct CycleSummary {
    pub total: usize,
    pub found: usize,
    pub missed: usize,
    pub pages: u32,
    pub errors: u32,
    pub aborted: bool,
    pub paused: bool,
}

/// Build a search URL for a batch of ASINs using the `|`-OR trick.
///
/// The `|` separator must stay raw — Amazon does not treat `%7C` as OR.
/// ASINs are alphanumeric so they need no encoding either.
fn build_search_url(asins: &[String]) -> String {
    let query = asins.join("|");
    format!("{AMAZON_BASE}/s?k={query}&{JA_LANG_QUERY}")
}

/// Fisher–Yates shuffle (consumes and returns the vec).
fn shuffle(mut v: Vec<String>) -> Vec<String> {
    let mut rng = rand::thread_rng();
    for i in (1..v.len()).rev() {
        let j = rng.gen_range(0..=i);
        v.swap(i, j);
    }
    v
}

/// Split into batches whose size is drawn uniformly from `[min, max]`
/// per batch — breaks the constant "135 items in k=" URL signature.
fn chunk_random(arr: &[String], min: usize, max: usize) -> Vec<&[String]> {
    let mut out = Vec::new();
    let mut rng = rand::thread_rng();
    let mut i = 0;
    while i < arr.len() {
        let size = rng.gen_range(min..=max);
        let end = (i + size).min(arr.len());
        out.push(&arr[i..end]);
        i = end;
    }
    out
}

/// Run one full coverage cycle. Emits [`Event::PageResult`] /
/// [`Event::Progress`] / [`Event::Block`] as it goes and returns the
/// final [`CycleSummary`] (the caller emits [`Event::CycleDone`]).
pub async fn run_coverage_loop(
    all_asins: &[String],
    cookies: &str,
    fetcher: &mut Fetcher,
    events: &UnboundedSender<Event>,
    abort: &AtomicBool,
) -> CycleSummary {
    let total = all_asins.len();
    if total == 0 {
        return CycleSummary::default();
    }

    // Seed the session with organic traffic before the first scrape
    // burst (self-guards — only the very first cycle actually warms up).
    fetcher.warmup(cookies).await;

    let mut unseen: HashSet<String> = all_asins.iter().cloned().collect();
    let mut page_count: u32 = 0;
    let mut error_count: u32 = 0;

    // Project request count for the progress bar (mean batch ÷ ~1/3).
    let estimated_pages =
        ((total as f64) / (BATCH_SIZE_MIN as f64 * EXPECTED_SHOW_RATIO)).ceil() as u32;

    let summary = |unseen: &HashSet<String>, pages, errors, aborted, paused| CycleSummary {
        total,
        found: total - unseen.len(),
        missed: unseen.len(),
        pages,
        errors,
        aborted,
        paused,
    };

    let mut wave: u32 = 0;
    while !unseen.is_empty() && wave < MAX_COVERAGE_ATTEMPTS {
        if abort.load(Ordering::Relaxed) {
            return summary(&unseen, page_count, error_count, true, false);
        }
        wave += 1;

        // Shuffle each wave + jittered batch sizes so consecutive
        // cycles don't re-issue identical URL text.
        let wave_asins = shuffle(unseen.iter().cloned().collect());
        let wave_start_unseen = wave_asins.len();
        let batches = chunk_random(&wave_asins, BATCH_SIZE_MIN, BATCH_SIZE_MAX);

        for batch in batches {
            if abort.load(Ordering::Relaxed) {
                return summary(&unseen, page_count, error_count, true, false);
            }
            // A CAPTCHA pause is active — stop; the parent restarts the
            // crawl once the pause lifts.
            if fetcher.is_paused() {
                return summary(&unseen, page_count, error_count, false, true);
            }

            let url = build_search_url(batch);
            match fetcher.fetch_page(&url, cookies).await {
                FetchOutcome::Ok { html, .. } => {
                    page_count += 1;
                    let results = parse_search_results(&html);
                    for r in &results {
                        unseen.remove(&r.asin);
                    }
                    let _ = events.send(Event::PageResult {
                        results,
                        page: page_count,
                        total_pages: estimated_pages,
                    });
                    let _ = events.send(Event::Progress {
                        done: total - unseen.len(),
                        total,
                        page: page_count,
                        total_pages: estimated_pages,
                        wave,
                    });
                }
                FetchOutcome::Block(info) => {
                    page_count += 1;
                    error_count += 1;
                    let _ = events.send(Event::Block {
                        error: info.error,
                        reason: info.reason,
                        source: info.source,
                        solve_url: info.solve_url,
                        paused_until_ms: fetcher.paused_until_ms(),
                        circuit_until_ms: fetcher.circuit_until_ms(),
                        captcha_streak: fetcher.captcha_streak(),
                    });
                    // fetcher is now paused — next batch's check exits.
                }
                FetchOutcome::RateLimited => {
                    page_count += 1;
                    error_count += 1;
                    let _ = events.send(Event::Block {
                        error: "RATE_LIMITED".to_string(),
                        reason: "HTTP 429".to_string(),
                        source: "amazon".to_string(),
                        solve_url: url.clone(),
                        paused_until_ms: fetcher.paused_until_ms(),
                        circuit_until_ms: fetcher.circuit_until_ms(),
                        captcha_streak: fetcher.captcha_streak(),
                    });
                }
                FetchOutcome::ServiceUnavailable
                | FetchOutcome::HttpError { .. }
                | FetchOutcome::NetworkError { .. } => {
                    page_count += 1;
                    error_count += 1;
                    // Single-page error — move on to the next batch.
                }
            }
        }

        // If a wave reduced `unseen` by nothing, the rest are
        // permanently missing — bail to avoid spinning all 7 waves.
        if unseen.len() == wave_start_unseen {
            let _ = events.send(Event::Log {
                level: "warn".to_string(),
                message: format!(
                    "wave {wave} found 0 new ASINs — {} permanently unseen",
                    unseen.len()
                ),
            });
            break;
        }
    }

    summary(&unseen, page_count, error_count, false, false)
}
