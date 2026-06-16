//! Amazon crawler sidecar — entry point.
//!
//! A standalone binary spawned by the Electron app. It owns the
//! Amazon search crawl (HTTP fetch + HTML parse + the 135→45 coverage
//! loop). Moving this core off the JavaScript side keeps the crawl
//! logic in a compiled, hard-to-reverse binary and isolates its load
//! from the Electron UI process.
//!
//! Transport — newline-delimited JSON over stdio:
//!   * stdin  : [`Command`]s from Electron
//!   * stdout : [`Event`]s back to Electron
//!   * stderr : human-readable logs only (never structured data)
//!
//! stdio is private to the parent/child pair, so there is no network
//! port for other processes to reach — the auth cookie passed in
//! [`Command::Crawl`] never leaves this process boundary.
//!
//! Concurrency: a single writer task serialises every [`Event`] to
//! stdout. The crawl runs as a spawned task so the main loop can keep
//! reading stdin and honour an [`Command::Abort`] mid-cycle.

// `dead_code` is allowed crate-wide while the modules are being wired
// up phase by phase; the final phase removes this once every item has
// a caller.
#![allow(dead_code)]

mod constants;
mod coverage;
mod fetcher;
mod parser;
mod protocol;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use coverage::run_coverage_loop;
use fetcher::Fetcher;
use protocol::{Command, Event};

/// Snapshot the fetcher state into a [`Event::State`] payload. Used at
/// startup and after any state-changing command so the bridge cache
/// stays in lock-step with the sidecar.
fn snapshot_state(fetcher: &Fetcher) -> Event {
    Event::State {
        paused_until_ms: fetcher.paused_until_ms(),
        circuit_until_ms: fetcher.circuit_until_ms(),
        captcha_streak: fetcher.captcha_streak(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Event channel — every part of the program sends Events here; one
    // writer task serialises them to stdout so writes never interleave.
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(ev) = rx.recv().await {
            if let Ok(mut line) = serde_json::to_string(&ev) {
                line.push('\n');
                if stdout.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdout.flush().await;
            }
        }
    });

    // Announce readiness so the parent knows the sidecar booted.
    let _ = tx.send(Event::Ready { version: env!("CARGO_PKG_VERSION").to_string() });

    // Long-lived fetcher — pacing / streak / circuit-breaker state
    // persists across crawl cycles. Behind an async mutex so the
    // spawned crawl task can own it for the cycle's duration.
    let fetcher = Arc::new(Mutex::new(Fetcher::new()?));
    let abort = Arc::new(AtomicBool::new(false));

    // Send the initial (all-zeros) state snapshot so the bridge can
    // populate its cache before the first crawl.
    {
        let guard = fetcher.lock().await;
        let _ = tx.send(snapshot_state(&guard));
    }

    let mut reader = BufReader::new(tokio::io::stdin()).lines();
    let mut crawl: Option<tokio::task::JoinHandle<()>> = None;

    while let Some(line) = reader.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cmd: Command = match serde_json::from_str(line) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Event::Error { message: format!("bad command: {e}") });
                continue;
            }
        };

        match cmd {
            Command::Ping => {
                let _ = tx.send(Event::Pong);
            }
            Command::Abort => {
                abort.store(true, Ordering::Relaxed);
                if let Some(h) = crawl.take() {
                    let _ = h.await;
                }
            }
            Command::LiftPause => {
                let mut guard = fetcher.lock().await;
                guard.lift_pause();
                let _ = tx.send(snapshot_state(&guard));
            }
            Command::ClearCircuitBreaker => {
                let mut guard = fetcher.lock().await;
                guard.clear_circuit_breaker();
                let _ = tx.send(snapshot_state(&guard));
            }
            Command::Shutdown => {
                abort.store(true, Ordering::Relaxed);
                if let Some(h) = crawl.take() {
                    let _ = h.await;
                }
                break;
            }
            Command::Crawl { asins, cookies } => {
                // Reap a finished handle; reject overlapping crawls.
                if let Some(h) = crawl.take() {
                    if h.is_finished() {
                        let _ = h.await;
                    } else {
                        crawl = Some(h);
                        let _ = tx.send(Event::Error {
                            message: "crawl already running".to_string(),
                        });
                        continue;
                    }
                }
                abort.store(false, Ordering::Relaxed);

                let fetcher = fetcher.clone();
                let abort = abort.clone();
                let tx2 = tx.clone();
                crawl = Some(tokio::spawn(async move {
                    let mut guard = fetcher.lock().await;
                    let s = run_coverage_loop(&asins, &cookies, &mut guard, &tx2, &abort).await;
                    let _ = tx2.send(Event::CycleDone {
                        total: s.total,
                        found: s.found,
                        missed: s.missed,
                        pages: s.pages,
                        errors: s.errors,
                        aborted: s.aborted,
                        paused: s.paused,
                    });
                }));
            }
        }
    }

    // Graceful shutdown — every crawl task is already joined above, so
    // dropping `tx` releases the last sender; the writer drains the
    // channel and exits.
    drop(tx);
    let _ = writer.await;
    Ok(())
}
