'use strict';

const { getActiveAsins, resetCycleSeen, updateProductAfterScrape, insertObservationsBatch } = require('../db/queries');
const { runCoverageLoop } = require('../scraper/coverage-loop');
const { isPaused } = require('../scraper/fetcher');
const { evaluateForAsin } = require('./evaluator');

let running = false;
let cycleTimer = null;
let mainWindow = null;
let cycleCount = 0;

const { PUSH } = require('../../shared/constants');

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

  const asins = getActiveAsins();
  if (asins.length === 0) {
    console.info('[scheduler] no active products — sleeping');
    return;
  }

  cycleCount++;
  console.info(`[scheduler] cycle #${cycleCount} starting (${asins.length} products)`);

  // Reset the cycle_seen flag on all products so the coverage loop can
  // track which ones were found this time around.
  resetCycleSeen();

  const startMs = Date.now();

  const result = await runCoverageLoop(asins, {
    onPageResult: (results, page, totalPages) => {
      const now = Date.now();
      const observations = [];

      for (const r of results) {
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

        // Evaluate alert conditions for this product.
        evaluateForAsin(r.asin, r);

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

function start() {
  if (running) return;
  running = true;
  console.info('[scheduler] started');

  // Run the first cycle immediately, then repeat with a short gap
  // between cycles to avoid hammering Amazon back-to-back.
  const loop = async () => {
    if (!running) return;
    await runOneCycle();
    if (!running) return;
    // 30 s rest between cycles — enough to look human, short enough
    // to maintain the ~14 min total cycle target.
    cycleTimer = setTimeout(loop, 30000);
  };
  loop();
}

function stop() {
  running = false;
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  console.info('[scheduler] stopped');
}

function isRunning() {
  return running;
}

module.exports = { start, stop, isRunning, setMainWindow };
