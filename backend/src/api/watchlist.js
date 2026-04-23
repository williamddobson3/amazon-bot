import { Router } from 'express';
import { requireAuth } from './middleware.js';
import {
  addToWatchlist, removeFromWatchlist, getWatchlist,
  kickWatchlistScrape, setWatchlistPriority,
  addManyToWatchlist, createBatch, getBatch, query,
  getUserById,
} from '../db/mysql.js';
import log from '../utils/logger.js';
import {
  pushToScrapeQueue, pushManyToScrapeQueue, clearJobAssignment,
} from '../db/redis.js';

const router = Router();

router.use(requireAuth);

// Hard ceiling per bulk request. Guards the connection pool and
// max_allowed_packet from a single pathological paste.
const BULK_MAX = 5000;

router.get('/', async (req, res) => {
  const list = await getWatchlist(req.userId);
  res.json(list);
});

router.post('/', async (req, res) => {
  const { asin } = req.body;
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }

  await addToWatchlist(req.userId, asin);
  await pushToScrapeQueue(`${req.userId}:${asin}`, Date.now());

  res.status(201).json({ ok: true, asin });
});

// ── Bulk add ───────────────────────────────────────────────
//
// Accepts up to BULK_MAX ASINs in a single request. Does ONE transactional
// insert, ONE recalcUserIntervals, ONE pipelined Redis ZADD, and creates a
// scrape_batches row so the extension can poll progress. Returns the
// batchId and acceptance counts so the side panel can show a progress bar.
router.post('/bulk', async (req, res) => {
  try {
    const { asins } = req.body || {};
    if (!Array.isArray(asins)) {
      return res.status(400).json({ error: 'asins[] required' });
    }
    if (asins.length === 0) {
      return res.status(400).json({ error: 'asins[] is empty' });
    }
    if (asins.length > BULK_MAX) {
      return res.status(413).json({ error: `Max ${BULK_MAX} ASINs per request` });
    }

    // ── Stale-JWT guard ───────────────────────────────────
    // The WS auth only verifies the JWT signature. If the users row has
    // been deleted since the token was issued (e.g. a DB wipe between
    // restarts), every downstream INSERT would crash. Fail fast with
    // 401 so the extension can clear its token and prompt the user to
    // sign in again.
    const userRow = await getUserById(req.userId);
    if (!userRow) {
      return res.status(401).json({
        error: 'STALE_SESSION',
        message: 'Your account no longer exists. Please sign out and sign in again.',
      });
    }

    // Normalise + dedupe + regex-filter on the server side so the client
    // can't bypass validation.
    const seen = new Set();
    const valid = [];
    const invalidAsins = [];
    for (const raw of asins) {
      const clean = String(raw || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(clean)) {
        invalidAsins.push(clean);
        continue;
      }
      if (seen.has(clean)) continue;
      seen.add(clean);
      valid.push(clean);
    }

    if (valid.length === 0) {
      return res.status(400).json({
        error: 'No valid ASINs',
        invalid: invalidAsins.length,
      });
    }

    // Create the batch row first so we can stamp it into the inserted
    // watchlist rows. `total` is provisional — we correct it below once
    // we know how many were actually new (not duplicates).
    const batchId = await createBatch(req.userId, valid.length);

    const { acceptedAsins, duplicateAsins } = await addManyToWatchlist(
      req.userId, valid, batchId
    );

    if (acceptedAsins.length !== valid.length) {
      await query(
        `UPDATE scrape_batches SET total = ? WHERE id = ?`,
        [acceptedAsins.length, batchId]
      );
    }

    if (acceptedAsins.length > 0) {
      const keys = acceptedAsins.map((a) => `${req.userId}:${a}`);
      await pushManyToScrapeQueue(keys, Date.now());
    }

    if (acceptedAsins.length === 0) {
      await query(
        `UPDATE scrape_batches
         SET status = 'done', finished_at = NOW(), total = 0
         WHERE id = ?`,
        [batchId]
      );
    }

    res.status(201).json({
      batchId,
      total: acceptedAsins.length,
      accepted: acceptedAsins.length,
      duplicates: duplicateAsins.length,
      invalid: invalidAsins.length,
      acceptedAsins,
    });
  } catch (err) {
    log.error(`POST /api/watchlist/bulk failed: ${err.message}`);
    // Return a structured JSON error instead of bubbling up — without
    // this, an unhandled promise rejection would crash the whole process.
    res.status(500).json({
      error: 'BULK_ADD_FAILED',
      code: err.code || null,
      message: err.message,
    });
  }
});

// Progress poll for the side panel's batch header.
router.get('/bulk/:batchId', async (req, res) => {
  const { batchId } = req.params;
  const batch = await getBatch(req.userId, batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const done = batch.completed + batch.failed;
  const startedMs = new Date(batch.started_at).getTime();
  const elapsedSec = Math.max(1, (Date.now() - startedMs) / 1000);
  const ratePerSec = done / elapsedSec;
  const remaining = Math.max(0, batch.total - done);
  const etaSec = ratePerSec > 0 ? Math.round(remaining / ratePerSec) : null;

  res.json({
    batchId: batch.id,
    total: batch.total,
    completed: batch.completed,
    failed: batch.failed,
    status: batch.status,
    startedAt: startedMs,
    finishedAt: batch.finished_at ? new Date(batch.finished_at).getTime() : null,
    etaSec,
  });
});

// Cancel an in-flight batch. Marks the batch 'cancelled' so the progress
// bar dismisses and future scrape results stop incrementing it. Already-
// inserted watchlist rows keep their normal scrape cadence.
router.post('/bulk/:batchId/cancel', async (req, res) => {
  const { batchId } = req.params;
  await query(
    `UPDATE scrape_batches
     SET status = 'cancelled', finished_at = NOW()
     WHERE id = ? AND user_id = ? AND status = 'running'`,
    [batchId, req.userId]
  );
  res.json({ ok: true });
});

router.delete('/:asin', async (req, res) => {
  const { asin } = req.params;
  await removeFromWatchlist(req.userId, asin);
  await clearJobAssignment(`${req.userId}:${asin}`);
  res.json({ ok: true });
});

// Force an immediate re-scrape of one ASIN (user-triggered refresh).
router.post('/:asin/refresh', async (req, res) => {
  const { asin } = req.params;
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }
  await kickWatchlistScrape(req.userId, asin);
  await clearJobAssignment(`${req.userId}:${asin}`);
  await pushToScrapeQueue(`${req.userId}:${asin}`, Date.now());
  res.json({ ok: true, asin });
});

// Set per-user priority for an ASIN: starred / normal / archived.
router.put('/:asin/priority', async (req, res) => {
  const { asin } = req.params;
  const { priority } = req.body;
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }
  if (!['starred', 'normal', 'archived'].includes(priority)) {
    return res.status(400).json({ error: 'priority must be starred|normal|archived' });
  }
  try {
    await setWatchlistPriority(req.userId, asin, priority);
    res.json({ ok: true, asin, priority });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
