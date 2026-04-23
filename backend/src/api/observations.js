import { Router } from 'express';
import { requireAuth } from './middleware.js';
import { getObservationsInRange, getObservationSpan, getWatchlist } from '../db/mysql.js';

const router = Router();

router.use(requireAuth);

// GET /api/observations/:asin?from=<unix_ms>&to=<unix_ms>
// Returns the AUTHENTICATED USER's price observations for this ASIN.
// Strictly per-user — no cross-user data sharing.
router.get('/:asin', async (req, res) => {
  const asin = req.params.asin?.trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }

  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);
  if (isNaN(from) || isNaN(to) || from >= to) {
    return res.status(400).json({ error: 'Invalid from/to' });
  }

  // Authorization: user must be watching this ASIN
  const watchlist = await getWatchlist(req.userId);
  if (!watchlist.some((w) => w.asin === asin)) {
    return res.status(403).json({ error: 'Not watching this ASIN' });
  }

  const rows = await getObservationsInRange(req.userId, asin, from, to);
  res.json(rows);
});

// GET /api/observations/:asin/span
// Returns the user's first/last observation timestamps for this ASIN.
router.get('/:asin/span', async (req, res) => {
  const asin = req.params.asin?.trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }

  const watchlist = await getWatchlist(req.userId);
  if (!watchlist.some((w) => w.asin === asin)) {
    return res.status(403).json({ error: 'Not watching this ASIN' });
  }

  const span = await getObservationSpan(req.userId, asin);
  res.json(span);
});

export default router;
