import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import log from '../utils/logger.js';
import { getAsinsNeedingScrape, query } from '../db/mysql.js';
import {
  pushToScrapeQueue,
  getClientLoad, incrClientActiveJobs, setJobAssignment, getJobAssignment,
} from '../db/redis.js';
import { getAuthenticatedClients, sendToClient } from '../ws/hub.js';

// When the coordinator can't place a row on this tick (no clients online,
// or the owning user's clients are all at capacity), we push it BOTH back
// into the Redis deferral queue AND forward watchlists.next_scrape_at in
// MySQL. Without the MySQL update the same 200 rows would resurface on
// every tick and the coordinator would hot-spin on a 2000-row backlog.
//
// The delay is DELIBERATELY short (5-15 s). A longer deferral pile-up was
// one of the biggest contributors to "scraping feels frozen" on bulk
// adds — when the client finishes a job and frees a slot, we want the
// next due row to be picked up within seconds, not minutes.
async function deferRowInMysql(userId, asin, delayMs) {
  const delaySec = Math.max(1, Math.floor(delayMs / 1000));
  await query(
    `UPDATE watchlists
     SET next_scrape_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE user_id = ? AND asin = ?`,
    [delaySec, userId, asin]
  );
}

// Adaptive deferral delay. Scales up from 5 s (few rows queued) to 20 s
// (hundreds queued) so a large backlog doesn't hammer MySQL with tick-
// rate UPDATEs, but a small backlog gets picked up on the next freed
// slot. Returns milliseconds.
function computeDeferralMs(pendingCount) {
  if (pendingCount <= 10)  return 5000;
  if (pendingCount <= 50)  return 8000;
  if (pendingCount <= 200) return 12000;
  return 20000;
}

let tickTimer = null;

export function startCoordinator() {
  tickTimer = setInterval(coordinatorTick, config.coordinator.tickIntervalMs);
  log.info('Job Coordinator started (per-user routing)');
}

export function stopCoordinator() {
  if (tickTimer) clearInterval(tickTimer);
}

// Each tick:
//   1. Pull up to N due watchlist rows ordered by priority + next_scrape_at
//   2. For each row, find ANY online client of that exact user_id under capacity
//   3. Assign and dispatch SCRAPE_JOB
//   4. If no client available for that user, defer the row 5 minutes
//
// Per-user routing: a scrape for ASIN X owned by user A is ONLY ever
// assigned to user A's own client(s). No swarm sharing — Amazon's
// per-session personalization makes cross-user scrape results invalid.
async function coordinatorTick() {
  try {
    const rows = await getAsinsNeedingScrape(200);
    if (rows.length === 0) return;

    const onlineClients = getAuthenticatedClients();
    if (onlineClients.length === 0) {
      // No clients at all — defer everything by 30 s. When the user
      // opens the side panel, the extension will connect and rows will
      // become eligible again within half a minute.
      for (const r of rows) {
        await pushToScrapeQueue(`${r.user_id}:${r.asin}`, Date.now() + 30000);
        await deferRowInMysql(r.user_id, r.asin, 30000);
      }
      return;
    }

    // Index online clients by user_id for O(1) per-user lookup
    const clientsByUser = new Map();
    for (const c of onlineClients) {
      if (!clientsByUser.has(c.userId)) clientsByUser.set(c.userId, []);
      clientsByUser.get(c.userId).push(c);
    }

    const clientLoadCache = new Map();
    for (const c of onlineClients) {
      clientLoadCache.set(c.clientId, await getClientLoad(c.clientId));
    }

    for (const row of rows) {
      const jobKey = `${row.user_id}:${row.asin}`;
      const existing = await getJobAssignment(jobKey);
      if (existing) continue; // already in flight, skip

      const assigned = await assignJobToUser(row, clientsByUser, clientLoadCache);
      if (!assigned) {
        // User is offline or all of their clients are at capacity.
        // Adaptive deferral: short backoff when the backlog is small so
        // the row comes back fast once a slot frees up; longer backoff
        // for huge backlogs to avoid coordinator hot-spin.
        const delayMs = computeDeferralMs(rows.length);
        await pushToScrapeQueue(jobKey, Date.now() + delayMs);
        await deferRowInMysql(row.user_id, row.asin, delayMs);
      }
    }
  } catch (err) {
    log.error('Coordinator tick error:', err.message);
  }
}

async function assignJobToUser(row, clientsByUser, clientLoadCache) {
  const userClients = clientsByUser.get(row.user_id) || [];
  if (userClients.length === 0) return false; // user is offline

  // If the user has multiple devices online (e.g. desktop + tablet),
  // pick the one with the lowest current load to spread work
  userClients.sort((a, b) => {
    const la = clientLoadCache.get(a.clientId)?.activeJobs ?? 0;
    const lb = clientLoadCache.get(b.clientId)?.activeJobs ?? 0;
    return la - lb;
  });

  for (const candidate of userClients) {
    const load = clientLoadCache.get(candidate.clientId);
    if (!load) continue;
    if (load.activeJobs >= config.coordinator.maxJobsPerClient) continue;

    const jobId = uuidv4();
    const jobKey = `${row.user_id}:${row.asin}`;

    await setJobAssignment(jobKey, candidate.clientId, jobId);
    await incrClientActiveJobs(candidate.clientId);

    load.activeJobs++;
    clientLoadCache.set(candidate.clientId, load);

    sendToClient(candidate.clientId, {
      type: 'SCRAPE_JOB',
      asin: row.asin,
      priority: row.priority,
      jobId,
      deadline: Date.now() + config.coordinator.jobTimeoutSec * 1000,
    });

    log.debug(`Assigned ${row.asin} to user=${row.user_id} client=${candidate.clientId}`);
    return true;
  }

  return false;
}
