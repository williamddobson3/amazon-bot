import Redis from 'ioredis';
import config from '../config.js';
import log from '../utils/logger.js';

const redis = new Redis(config.redisUrl);
redis.on('error', (err) => log.error('Redis error', err.message));

export default redis;

// ── Scrape Queue (Sorted Set: score = next_scrape_at timestamp) ──

export async function pushToScrapeQueue(asin, nextScrapeAt) {
  await redis.zadd('scrape_queue', nextScrapeAt, asin);
}

// Pipelined bulk enqueue. `keys` is an array of "userId:asin" strings.
// All members share the same score so the coordinator jitters them via
// watchlists.next_scrape_at in MySQL, not via the Redis ZSET score.
export async function pushManyToScrapeQueue(keys, nextScrapeAt) {
  if (!keys || keys.length === 0) return;
  const pipeline = redis.pipeline();
  const CHUNK = 1000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const args = [];
    for (const k of chunk) {
      args.push(nextScrapeAt, k);
    }
    pipeline.zadd('scrape_queue', ...args);
  }
  await pipeline.exec();
}

export async function popDueScrapeJobs(limit) {
  const now = Date.now();
  const asins = await redis.zrangebyscore('scrape_queue', '-inf', now, 'LIMIT', 0, limit);
  if (asins.length > 0) {
    await redis.zrem('scrape_queue', ...asins);
  }
  return asins;
}

export async function getScrapeQueueSize() {
  return redis.zcard('scrape_queue');
}

// ── Online Clients ─────────────────────────────────────────

export async function setClientOnline(clientId, userId) {
  await redis.hset('online_clients', clientId, JSON.stringify({
    userId,
    connectedAt: Date.now(),
  }));
}

export async function setClientOffline(clientId) {
  await redis.hdel('online_clients', clientId);
  await redis.del(`client_load:${clientId}`);
}

export async function getOnlineClients() {
  const all = await redis.hgetall('online_clients');
  const result = {};
  for (const [id, json] of Object.entries(all)) {
    result[id] = JSON.parse(json);
  }
  return result;
}

export async function getOnlineClientCount() {
  return redis.hlen('online_clients');
}

// ── Client Load Tracking ───────────────────────────────────

export async function getClientLoad(clientId) {
  const data = await redis.hgetall(`client_load:${clientId}`);
  return {
    activeJobs: parseInt(data.activeJobs || '0', 10),
    jobsLastHour: parseInt(data.jobsLastHour || '0', 10),
    maxPerMin: parseInt(data.maxPerMin || '3', 10),
  };
}

export async function incrClientActiveJobs(clientId) {
  await redis.hincrby(`client_load:${clientId}`, 'activeJobs', 1);
}

export async function decrClientActiveJobs(clientId) {
  await redis.hincrby(`client_load:${clientId}`, 'activeJobs', -1);
}

export async function incrClientJobsLastHour(clientId) {
  await redis.hincrby(`client_load:${clientId}`, 'jobsLastHour', 1);
}

// ── Job Assignments ────────────────────────────────────────

export async function setJobAssignment(asin, clientId, jobId) {
  await redis.hset(`job:${asin}`, 'clientId', clientId, 'jobId', jobId, 'assignedAt', Date.now().toString());
  await redis.expire(`job:${asin}`, config.coordinator.jobTimeoutSec);
}

export async function getJobAssignment(asin) {
  const data = await redis.hgetall(`job:${asin}`);
  return data.clientId ? data : null;
}

export async function clearJobAssignment(asin) {
  await redis.del(`job:${asin}`);
}

// ── ASIN Stats (pre-computed for condition evaluation) ─────

export async function setAsinStats(asin, stats) {
  await redis.hset(`asin_stats:${asin}`,
    'ma10Price', (stats.ma10Price ?? '').toString(),
    'lastPrice', (stats.lastPrice ?? '').toString(),
    'lastOffers', (stats.lastOffers ?? '').toString(),
    'prevOffers', (stats.prevOffers ?? '').toString(),
    'updatedAt', Date.now().toString()
  );
  await redis.expire(`asin_stats:${asin}`, 86400);
}

export async function getAsinStats(asin) {
  const data = await redis.hgetall(`asin_stats:${asin}`);
  if (!data.lastPrice) return null;
  return {
    ma10Price: data.ma10Price ? parseFloat(data.ma10Price) : null,
    lastPrice: data.lastPrice ? parseInt(data.lastPrice, 10) : null,
    lastOffers: data.lastOffers ? parseInt(data.lastOffers, 10) : null,
    prevOffers: data.prevOffers ? parseInt(data.prevOffers, 10) : null,
    updatedAt: data.updatedAt ? parseInt(data.updatedAt, 10) : null,
  };
}

// ── Notification Dedup ─────────────────────────────────────

export async function isNotificationSent(userId, asin, conditionId) {
  const key = `notif_sent:${userId}:${asin}:${conditionId}`;
  return !!(await redis.exists(key));
}

export async function markNotificationSent(userId, asin, conditionId, cooldownSec) {
  const key = `notif_sent:${userId}:${asin}:${conditionId}`;
  await redis.set(key, '1', 'EX', cooldownSec);
}

// ── Rotation Index ─────────────────────────────────────────

export async function getRotationIdx(asin) {
  const val = await redis.get(`rotation:${asin}`);
  return val ? parseInt(val, 10) : 0;
}

export async function setRotationIdx(asin, idx) {
  await redis.set(`rotation:${asin}`, idx.toString());
}
