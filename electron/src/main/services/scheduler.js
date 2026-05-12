'use strict';

const { getActiveAsins, resetCycleSeen, updateProductAfterScrape, insertObservationsBatch } = require('../db/queries');
const { runCoverageLoop } = require('../scraper/coverage-loop');
const { isPaused, warmup } = require('../scraper/fetcher');
// Legacy `conditions`-table evaluator removed (2026-05). All notification
// logic now lives in the FNM custom-filter slot path. The old evaluator
// silently fired notifications for any leftover conditions row, which
// is dangerous for an app that intentionally surfaces only the FNM UI.

let running = false;
let cycleTimer = null;
let mainWindow = null;
let cycleCount = 0;
// Per-spec: 監視スタート acts on the user's ✅checked subset only.
// `restrictAsins` (Set<string>|null) holds that subset for the current
// run. Null means "scrape every active product" — used when the
// scheduler is launched without a restriction (e.g., post-login auto-
// start at boot).
let restrictAsins = null;
// AbortController fired by stop() to interrupt:
//   - the current rate-limit / CAPTCHA-pause sleep in awaitFetchSlot
//   - the in-flight HTTP fetch in fetchPage
// so 監視ストップ halts work mid-batch instead of waiting for the
// current request to finish.
let cycleAbort = null;

// Rest-period telemetry exposed to the renderer so it can show a
// countdown between cycles. `nextCycleAt` is an absolute timestamp;
// `currentRestMs` is the full rest duration (used by the UI to draw
// the circular progress ring).
let nextCycleAt   = 0;
let currentRestMs = 0;

const { PUSH, REST_MIN_MS, REST_MAX_MS } = require('../../shared/constants');

function setMainWindow(win) {
  mainWindow = win;
}

function pushToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

async function runOneCycle() {
  if (!running) return;
  if (isPaused()) {
    console.info('[scheduler] skipping cycle — client is paused');
    return;
  }

  const allActive = getActiveAsins();
  // Intersect with the user's restriction set if one was supplied via
  // 監視スタート. Trashing a product mid-run automatically drops it
  // from `getActiveAsins`, so the intersection naturally re-narrows
  // every cycle without us tracking trash events here.
  const asins = restrictAsins
    ? allActive.filter((a) => restrictAsins.has(a))
    : allActive;
  if (asins.length === 0) {
    console.info(
      `[scheduler] no products to scrape ` +
      `(active=${allActive.length}, restricted=${restrictAsins ? restrictAsins.size : 'all'}) — sleeping`
    );
    return;
  }

  cycleCount++;
  console.info(`[scheduler] cycle #${cycleCount} starting (${asins.length} products)`);

  // First cycle of a run — seed the session with organic traffic so
  // the scrape burst that follows doesn't look like a cold scraper
  // jumping straight into `/s?k=<150 ASINs>`.
  if (cycleCount === 1) {
    console.info('[scheduler] warming up session');
    await warmup();
  }

  // Reset the cycle_seen flag on all products so the coverage loop can
  // track which ones were found this time around.
  resetCycleSeen();

  const startMs = Date.now();

  const result = await runCoverageLoop(asins, {
    signal: cycleAbort ? cycleAbort.signal : undefined,
    onPageResult: (results, page, totalPages) => {
      const now = Date.now();
      const observations = [];

      for (const r of results) {
        // BuyBox fallback: when Amazon doesn't show a BuyBox price for
        // this ASIN (e.g., 出品者数 ≥ 1 but no Featured Offer), fall
        // back to the lowest other-seller price. Per spec the fallback
        // value is also recorded in the observation history so charts /
        // 平均 / 下落率 don't go blank for products that legitimately
        // have offers but no BuyBox. The substitution happens here
        // (single source of truth) so updateProductAfterScrape, the
        // observation row, the renderer push, and downstream
        // evaluators all see the same effective BuyBox value.
        if (r.price == null && r.mpPrice != null) {
          r.price = r.mpPrice;
          r.priceFromMp = true;       // diagnostic flag — consumers can detect the substitution
        }

        // Update the product's "last known" snapshot.
        updateProductAfterScrape({
          asin:        r.asin,
          title:       r.title,
          imageUrl:    r.imageUrl,
          price:       r.price,
          points:      r.points,
          delivery:    r.delivery,
          mpPrice:     r.mpPrice,
          mpCount:     r.mpCount,
          mpCondition: r.mpCondition,
          observedAt:  now,
        });

        // Queue an observation row.
        observations.push({
          asin:        r.asin,
          observedAt:  now,
          price:       r.price,
          points:      r.points,
          delivery:    r.delivery,
          imageUrl:    r.imageUrl,
          mpPrice:     r.mpPrice,
          mpCount:     r.mpCount,
          mpCondition: r.mpCondition,
        });

        // (Legacy condition evaluator removed — FNM custom-filter slots
        // in the renderer side now own all notification firing.)

        // Push a live update to the renderer so the UI fills in
        // progressively as scrapes complete.
        pushToRenderer(PUSH.PRICE_UPDATE, {
          asin: r.asin,
          data: r,
          updatedAt: now,
        });
      }

      // Batch-insert all observations from this page in one transaction.
      if (observations.length > 0) {
        insertObservationsBatch(observations);
      }
    },

    onProgress: (progress) => {
      pushToRenderer(PUSH.CYCLE_PROGRESS, progress);
    },
  });

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.info(
    `[scheduler] cycle #${cycleCount} done in ${elapsedSec}s — ` +
    `${result.found}/${result.total} found, ${result.missed} missed, ` +
    `${result.pages} pages, ${result.errors} errors`
  );

  pushToRenderer(PUSH.CYCLE_COMPLETE, {
    cycle: cycleCount,
    ...result,
    elapsedSec: parseFloat(elapsedSec),
  });
}

function start(opts = {}) {
  if (running) return;
  // `opts.asins` (array) restricts this run to a specific subset; an
  // empty array is treated as "no restriction" so a misuse doesn't
  // silently lock the scheduler into scraping nothing.
  if (Array.isArray(opts.asins) && opts.asins.length > 0) {
    restrictAsins = new Set(opts.asins.map((a) => String(a).toUpperCase()));
    console.info(`[scheduler] starting with ${restrictAsins.size}-asin restriction`);
  } else {
    restrictAsins = null;
    console.info('[scheduler] starting without restriction (all active products)');
  }
  // Fresh AbortController per run — once aborted, signals can't be
  // re-used, so the next start() needs a new one.
  cycleAbort = new AbortController();
  running = true;

  // Run the first cycle immediately, then repeat with a randomised
  // rest between cycles. Randomness here matters: a fixed 30-second
  // rest makes cycle starts land on predictable boundaries, which is
  // itself a scraper fingerprint. [REST_MIN_MS, REST_MAX_MS] gives
  // cycle-to-cycle spacing that looks like sporadic human browsing.
  const loop = async () => {
    if (!running) return;
    // Clear rest telemetry — cycle is active now, not resting.
    nextCycleAt   = 0;
    currentRestMs = 0;
    await runOneCycle();
    if (!running) return;
    const rest = REST_MIN_MS + Math.floor(Math.random() * (REST_MAX_MS - REST_MIN_MS));
    currentRestMs = rest;
    nextCycleAt   = Date.now() + rest;
    console.info(`[scheduler] resting ${Math.round(rest / 1000)}s before next cycle`);
    cycleTimer = setTimeout(loop, rest);
  };
  loop();
}

function stop() {
  running = false;
  restrictAsins = null;
  nextCycleAt   = 0;
  currentRestMs = 0;
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  // Abort the in-flight fetch + any rate-limit sleep so 監視ストップ
  // halts work mid-batch instead of waiting for the current request to
  // finish. Null it so a stray re-stop doesn't crash on a used signal.
  if (cycleAbort) {
    cycleAbort.abort();
    cycleAbort = null;
  }
  console.info('[scheduler] stopped');
}

function getRestrictionCount() {
  return restrictAsins ? restrictAsins.size : null;
}

function isRunning() {
  return running;
}

// Returns null when the scheduler isn't resting — i.e. during an
// active cycle or when stopped. Otherwise returns the absolute
// timestamp the next cycle will start and the total rest duration
// so the UI can draw a proportionate countdown ring.
function getRestState() {
  if (!running || !nextCycleAt || nextCycleAt <= Date.now()) return null;
  return { nextCycleAt, restMs: currentRestMs };
}

module.exports = { start, stop, isRunning, setMainWindow, getRestState, getRestrictionCount };
