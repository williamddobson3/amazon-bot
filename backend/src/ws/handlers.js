import log from '../utils/logger.js';
import { decrClientActiveJobs, clearJobAssignment, incrClientJobsLastHour } from '../db/redis.js';
import {
  updateAsinAfterScrape, incrementAsinFailure, insertObservation,
  markBatchRowTerminal, incBatchCounter, query,
} from '../db/mysql.js';
import { sendToUser } from './hub.js';
import { evaluateConditionsForAsin } from '../services/evaluator.js';

// Failure codes the client returns when it is *temporarily unavailable*
// rather than when the row itself is broken. These must NOT bump the
// row's scrape_failures counter — otherwise a single CAPTCHA on one ASIN
// would escalate every other row in the batch up the exponential-backoff
// ladder through no fault of their own.
const TRANSIENT_CLIENT_ERRORS = new Set(['CLIENT_BUSY', 'CLIENT_PAUSED']);

export async function handleClientMessage(client, msg) {
  switch (msg.type) {
    case 'SCRAPE_RESULT':
      await handleScrapeResult(client, msg);
      break;

    case 'SCRAPE_FAILED':
      await handleScrapeFailed(client, msg);
      break;

    case 'HEARTBEAT':
      break;

    default:
      log.debug(`Unknown WS message type: ${msg.type}`);
  }
}

async function handleScrapeResult(client, msg) {
  const { asin, data, scrapedAt } = msg;
  if (!asin || !data) return;
  if (!client.userId) {
    log.warn(`SCRAPE_RESULT from unauthenticated client ${client.id}`);
    return;
  }

  log.debug(`Scrape result from user=${client.userId}: ${asin} price=${data.price}`);

  await decrClientActiveJobs(client.id);
  await incrClientJobsLastHour(client.id);
  // Per-user job key — different users can have the same ASIN in flight
  await clearJobAssignment(`${client.userId}:${asin}`);

  // Update the user's per-watchlist cached snapshot + reschedule
  await updateAsinAfterScrape(client.userId, asin, {
    title: data.title,
    price: data.price,
    points: data.points,
    marketplaceLowest: data.marketplaceLowest,
    newOfferCount: data.newOfferCount,
  });

  // Persist as a per-user observation (no cross-user sharing)
  await insertObservation({
    userId: client.userId,
    asin,
    scrapedAt: scrapedAt || Date.now(),
    price: data.price,
    points: data.points,
    deliveryTime: data.deliveryTime,
    marketplaceLowest: data.marketplaceLowest,
    newOfferCount: data.newOfferCount,
  });

  // Notify ONLY the scraping user — no fanout to other watchers.
  // Each user is responsible for their own data freshness.
  sendToUser(client.userId, {
    type: 'PRICE_UPDATE',
    asin,
    data,
    updatedAt: scrapedAt || Date.now(),
  });

  // Evaluate alert conditions against this user's observations only
  await evaluateConditionsForAsin(client.userId, asin, data);

  // Batch accounting: if this row belongs to an active bulk-ingest batch
  // AND this is its first terminal scrape event, bump the `completed`
  // counter and (if the batch just crossed total) emit BATCH_COMPLETE.
  await bumpBatchForTerminalEvent(client.userId, asin, 'completed');
}

async function bumpBatchForTerminalEvent(userId, asin, kind) {
  try {
    const mark = await markBatchRowTerminal(userId, asin);
    if (!mark) return;
    const batch = await incBatchCounter(mark.batchId, kind);
    if (!batch) return;

    sendToUser(userId, {
      type: 'BATCH_PROGRESS',
      batchId: batch.id,
      total: batch.total,
      completed: batch.completed,
      failed: batch.failed,
      status: batch.status,
    });

    if (batch.justCompleted) {
      sendToUser(userId, {
        type: 'BATCH_COMPLETE',
        batchId: batch.id,
        total: batch.total,
        completed: batch.completed,
        failed: batch.failed,
      });
      log.info(`Batch ${batch.id} complete for user=${userId} (${batch.completed}/${batch.total})`);
    }
  } catch (err) {
    log.error(`Batch counter update failed: ${err.message}`);
  }
}

async function handleScrapeFailed(client, msg) {
  const { asin, error, missing, finalUrl, htmlLen, partial, cardSnippet, pausedUntil } = msg;
  const details = [
    `user=${client.userId}`,
    `asin=${asin}`,
    `error=${error}`,
    missing ? `missing=[${missing.join(',')}]` : null,
    finalUrl ? `finalUrl=${finalUrl}` : null,
    htmlLen ? `htmlLen=${htmlLen}` : null,
    partial ? `partial=${JSON.stringify(partial).slice(0, 300)}` : null,
  ].filter(Boolean).join(' ');

  if (!client.userId) return;

  await decrClientActiveJobs(client.id);
  await clearJobAssignment(`${client.userId}:${asin}`);

  // ── Transient client-side rejection ───────────────────────
  // CLIENT_BUSY = extension had all 3 slots full when the job arrived.
  // CLIENT_PAUSED = offscreen is sitting out a CAPTCHA/429 cooldown.
  // In both cases the row has done nothing wrong — we must not penalise
  // it with a failure-ladder bump, or a storm of CAPTCHAs would push
  // every innocent row in the batch 24 h into the future.
  if (TRANSIENT_CLIENT_ERRORS.has(error)) {
    log.debug(`Scrape deferred (transient): ${details}`);
    // Compute how long the client will be out.
    //   CLIENT_PAUSED → honour the client's pausedUntil
    //   CLIENT_BUSY   → short 10 s bounce
    let delaySec = 10;
    if (error === 'CLIENT_PAUSED' && typeof pausedUntil === 'number') {
      const deltaMs = Math.max(0, pausedUntil - Date.now());
      // Add 10 s grace past the reported pause end so we don't race
      // the client coming back.
      delaySec = Math.max(10, Math.min(3600, Math.floor(deltaMs / 1000) + 10));
    }
    await query(
      `UPDATE watchlists
       SET next_scrape_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
       WHERE user_id = ? AND asin = ?`,
      [delaySec, client.userId, asin]
    );
    // Do NOT touch scrape_failures, last_error, or the batch counter.
    return;
  }

  // ── Genuine row-level failure ─────────────────────────────
  log.warn(`Scrape failed: ${details}`);
  if (cardSnippet) {
    log.warn(`  card snippet: ${cardSnippet.slice(0, 800).replace(/\s+/g, ' ')}`);
  }

  await incrementAsinFailure(client.userId, asin, error);

  // Failures of rows belonging to a bulk-ingest batch still count as a
  // terminal event for batch progress — otherwise a handful of permanent
  // CAPTCHA rows would make the progress bar wedge at 99%.
  await bumpBatchForTerminalEvent(client.userId, asin, 'failed');

  // Also push a live error marker to the side panel so skeleton rows
  // flip to an errored state immediately, without waiting for a poll.
  sendToUser(client.userId, {
    type: 'PRICE_UPDATE',
    asin,
    error,
    updatedAt: Date.now(),
  });
}
