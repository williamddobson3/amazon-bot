//! Amazon crawler — Node-API addon (method A: in-process).
//!
//! Compiled as a cdylib and renamed to `crawler/index.node` so the
//! Electron main process can `require()` it directly. There is no
//! separate child process; the crawl runs on a tokio runtime managed
//! by napi-rs, inside the Electron main process.
//!
//! Public surface (all exposed to JS via `#[napi]`):
//!
//!   version()              -> string
//!   runCoverage(asins, cookies, onEvent) -> Promise<CycleSummary>
//!   abort()                -> void
//!   liftPause()            -> Promise<State>
//!   clearCircuitBreaker()  -> Promise<State>
//!   getState()             -> Promise<State>
//!
//! `onEvent` is a JS function `(jsonString) => void` that receives
//! every PageResult / Progress / Block / State / Log event the crawl
//! produces. The bridge on the JS side parses the JSON and dispatches
//! to per-call callbacks (onPageResult / onProgress / onBlock), and
//! to the global callbacks (setOnBlock / setOnResume / setOnCircuit).
//!
//! State (the long-lived `Fetcher`) lives in module-level statics so
//! pacing, the streak counter and the circuit breaker persist across
//! `runCoverage` calls — same lifetime semantics the sidecar process
//! had.

#![allow(dead_code)]

mod constants;
mod coverage;
mod fee;
mod fetcher;
mod parser;
mod protocol;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;
use tokio::sync::{mpsc, Mutex};

use coverage::run_coverage_loop;
use fetcher::Fetcher;
use protocol::Event;

// ── Long-lived module state ─────────────────────────────────────

/// Singleton fetcher. Initialised on first use; all subsequent crawl
/// cycles share the same instance so pacing / streak / circuit-breaker
/// state persists exactly like the sidecar process did.
static FETCHER: OnceLock<Arc<Mutex<Fetcher>>> = OnceLock::new();

/// Set by `abort()`; checked between batches inside `run_coverage_loop`.
/// Reset to `false` at the start of every `runCoverage` invocation.
static ABORT: AtomicBool = AtomicBool::new(false);

fn fetcher_handle() -> Result<Arc<Mutex<Fetcher>>> {
    if let Some(f) = FETCHER.get() {
        return Ok(f.clone());
    }
    let f = Fetcher::new().map_err(|e| Error::from_reason(e.to_string()))?;
    let arc = Arc::new(Mutex::new(f));
    // OnceLock::set returns Err if another thread won the race — that's
    // fine, we just use whatever ended up stored.
    let _ = FETCHER.set(arc);
    Ok(FETCHER.get().expect("just set").clone())
}

// ── napi-exposed types ─────────────────────────────────────────

/// Snapshot of the fetcher's pause / breaker state. Returned by every
/// state-modifying call (liftPause / clearCircuitBreaker) and by
/// getState. Times are absolute wall-clock epoch ms; 0 = not active.
#[napi(object)]
pub struct State {
    pub paused_until_ms: f64,
    pub circuit_until_ms: f64,
    pub captcha_streak: u32,
}

/// Final tallies of one crawl cycle. Returned by `runCoverage`.
#[napi(object)]
pub struct CycleSummary {
    pub total: u32,
    pub found: u32,
    pub missed: u32,
    pub pages: u32,
    pub errors: u32,
    pub aborted: bool,
    pub paused: bool,
}

fn snapshot_state(f: &Fetcher) -> State {
    State {
        paused_until_ms: f.paused_until_ms() as f64,
        circuit_until_ms: f.circuit_until_ms() as f64,
        captcha_streak: f.captcha_streak(),
    }
}

// ── napi-exposed functions ─────────────────────────────────────

#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Run one full coverage cycle.
///
/// `asins`    — ASINs to cover (any size; the loop chunks them itself).
/// `cookies`  — `Cookie:` header value, exported from session jar on
///              the JS side. Empty when the user is logged out.
/// `on_event` — JS callback invoked for every intermediate event. The
///              argument is a JSON string; the bridge on the JS side
///              parses and dispatches.
///
/// Resolves with [`CycleSummary`] when the cycle finishes (or aborts).
/// Per-event errors do not reject the promise — they are surfaced as
/// `error` / `block` events so the JS bridge can decide what to do.
#[napi(
    ts_args_type = "asins: string[], cookies: string, onEvent: (eventJson: string) => void"
)]
pub async fn run_coverage(
    asins: Vec<String>,
    cookies: String,
    on_event: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
) -> Result<CycleSummary> {
    ABORT.store(false, Ordering::Relaxed);

    let fetcher = fetcher_handle()?;

    // Bridge channel: coverage_loop emits typed Events; a drain task
    // serialises them and pushes JSON strings through the JS callback.
    // Keeping the channel decouples Rust's async scheduling from the
    // V8 thread that ultimately runs the callback.
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let cb = on_event.clone();
    let drain = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&ev) {
                cb.call(json, ThreadsafeFunctionCallMode::Blocking);
            }
        }
    });

    // Initial state snapshot so the bridge cache is in lock-step before
    // the first page is fetched.
    {
        let guard = fetcher.lock().await;
        let _ = tx.send(snapshot_state_event(&guard));
    }

    let summary = {
        let mut guard = fetcher.lock().await;
        run_coverage_loop(&asins, &cookies, &mut guard, &tx, &ABORT).await
    };

    drop(tx);
    let _ = drain.await;

    Ok(CycleSummary {
        total: summary.total as u32,
        found: summary.found as u32,
        missed: summary.missed as u32,
        pages: summary.pages,
        errors: summary.errors,
        aborted: summary.aborted,
        paused: summary.paused,
    })
}

/// Request the in-flight crawl to stop at the next batch boundary.
/// No-op if no crawl is running. Returns immediately (the promise
/// returned by `runCoverage` resolves shortly after).
#[napi(js_name = "abort")]
pub fn abort_crawl() {
    ABORT.store(true, Ordering::Relaxed);
}

/// User dismissed the CAPTCHA pause (solved the challenge). Resets
/// `paused_until` and the streak counter. The circuit breaker is
/// NOT cleared — use `clearCircuitBreaker` for that.
#[napi]
pub async fn lift_pause() -> Result<State> {
    let f = fetcher_handle()?;
    let mut g = f.lock().await;
    g.lift_pause();
    Ok(snapshot_state(&g))
}

/// Manually clear the circuit breaker so pacing returns to the fast
/// interval immediately. Pair this with `liftPause` if the user solved
/// a CAPTCHA AND wants to skip the 24 h slow-pace window.
#[napi]
pub async fn clear_circuit_breaker() -> Result<State> {
    let f = fetcher_handle()?;
    let mut g = f.lock().await;
    g.clear_circuit_breaker();
    Ok(snapshot_state(&g))
}

/// Read the current state snapshot without mutating anything. Used by
/// the JS bridge on startup to sync its cache.
#[napi]
pub async fn get_state() -> Result<State> {
    let f = fetcher_handle()?;
    let g = f.lock().await;
    Ok(snapshot_state(&g))
}

/// Raw one-shot fetch result for the "view returned page" diagnostic.
#[napi(object)]
pub struct RawFetch {
    pub status: u32,
    pub final_url: String,
    pub html: String,
}

/// Diagnostic: fetch `url` once with the SAME HTTP client + headers the
/// scraper uses, returning the raw (JS-non-executed) body. Lets the
/// "Amazonが返したページを確認" button show exactly what the scraper's
/// HTTP layer receives. Does NOT touch pause / streak / pacing state.
#[napi(ts_args_type = "url: string, cookies: string")]
pub async fn fetch_raw(url: String, cookies: String) -> Result<RawFetch> {
    match fetcher::fetch_raw(&url, &cookies).await {
        Ok((status, final_url, html)) => Ok(RawFetch {
            status: status as u32,
            final_url,
            html,
        }),
        Err(e) => Err(Error::from_reason(e.to_string())),
    }
}

// ── Internal helpers ───────────────────────────────────────────

/// Wrap the fetcher's current state in a `state` event for the bridge.
fn snapshot_state_event(f: &Fetcher) -> Event {
    Event::State {
        paused_until_ms: f.paused_until_ms(),
        circuit_until_ms: f.circuit_until_ms(),
        captcha_streak: f.captcha_streak(),
    }
}
