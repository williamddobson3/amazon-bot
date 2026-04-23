import { Router } from 'express';
import { requireAuth } from './middleware.js';
import { createCondition, getUserConditions, deleteCondition } from '../db/mysql.js';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const conditions = await getUserConditions(req.userId);
  res.json(conditions);
});

router.post('/', async (req, res) => {
  const { asin, type, params, cooldownSec } = req.body;

  const validTypes = ['moving_avg_below_pct', 'absolute_price_below', 'offer_count_drop_pct', 'marketplace_below'];
  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid condition type' });
  }
  if (!params || typeof params !== 'object') {
    return res.status(400).json({ error: 'Params object required' });
  }

  const cond = await createCondition(req.userId, {
    asin: asin || null,
    type,
    params,
    cooldownSec: cooldownSec || 3600,
  });

  res.status(201).json(cond);
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  await deleteCondition(req.userId, id);
  res.json({ ok: true });
});

export default router;
