import { Router } from 'express';
import { requireAuth } from './middleware.js';
import authRouter from './auth.js';
import watchlistRouter from './watchlist.js';
import conditionsRouter from './conditions.js';
import observationsRouter from './observations.js';
import { upsertDiscordWebhook, getDiscordWebhook, getLatestSelectors } from '../db/mysql.js';
import { getOnlineClientCount, getScrapeQueueSize } from '../db/redis.js';

const router = Router();

router.use('/auth', authRouter);
router.use('/watchlist', watchlistRouter);
router.use('/conditions', conditionsRouter);
router.use('/observations', observationsRouter);

router.put('/discord-webhook', requireAuth, async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });
  await upsertDiscordWebhook(req.userId, webhookUrl);
  res.json({ ok: true });
});

router.get('/discord-webhook', requireAuth, async (req, res) => {
  const url = await getDiscordWebhook(req.userId);
  res.json({ url });
});

router.get('/selectors', requireAuth, async (req, res) => {
  const row = await getLatestSelectors();
  if (!row) return res.json({ version: 1, selectors: {} });
  res.json({ version: row.version, selectors: row.selectors });
});

router.get('/stats', async (req, res) => {
  const clients = await getOnlineClientCount();
  const queueSize = await getScrapeQueueSize();
  res.json({ onlineClients: clients, scrapeQueueSize: queueSize });
});

export default router;
