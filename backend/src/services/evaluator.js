import log from '../utils/logger.js';
import { getConditionsForUserAndAsin, getMovingAverage, getPreviousOfferCount, markConditionFired } from '../db/mysql.js';
import { isNotificationSent, markNotificationSent, setAsinStats } from '../db/redis.js';
import { enqueueNotification } from './notifier.js';

// Evaluate alert conditions strictly within one user's data context.
// Per-user observations means moving averages and offer-count diffs must
// be computed from THIS user's history only — not the shared swarm.
export async function evaluateConditionsForAsin(userId, asin, data) {
  const conditions = await getConditionsForUserAndAsin(userId, asin);
  if (conditions.length === 0) return;

  const ma10 = await getMovingAverage(userId, asin, 10);
  const prevOffers = await getPreviousOfferCount(userId, asin);

  // Cache per-(user, asin) for downstream stats consumers
  await setAsinStats(`${userId}:${asin}`, {
    ma10Price: ma10.avgPrice,
    lastPrice: data.price,
    lastOffers: data.newOfferCount,
    prevOffers,
  });

  const context = {
    price: data.price,
    points: data.points,
    marketplaceLowest: data.marketplaceLowest,
    newOfferCount: data.newOfferCount,
    ma10Price: ma10.avgPrice,
    ma10Count: ma10.count,
    prevOfferCount: prevOffers,
  };

  for (const cond of conditions) {
    try {
      const fired = evaluateSingleCondition(cond, context);
      if (!fired) continue;

      if (cond.last_fired_at) {
        const elapsed = Date.now() - new Date(cond.last_fired_at).getTime();
        if (elapsed < cond.cooldown_sec * 1000) continue;
      }

      const alreadySent = await isNotificationSent(cond.user_id, asin, cond.id);
      if (alreadySent) continue;

      await markConditionFired(cond.id);
      await markNotificationSent(cond.user_id, asin, cond.id, cond.cooldown_sec);

      // Always notify the extension; Discord is optional (webhookUrl may be null)
      await enqueueNotification({
        userId: cond.user_id,
        asin,
        conditionId: cond.id,
        webhookUrl: cond.webhook_url || null,
        ruleType: cond.rule_type,
        price: data.price,
        movingAvg: ma10.avgPrice ? Math.round(ma10.avgPrice) : null,
        points: data.points,
        marketplaceLowest: data.marketplaceLowest,
        newOfferCount: data.newOfferCount,
      });

      log.info(`Condition ${cond.id} fired for ${asin} user=${cond.user_id}`);
    } catch (err) {
      log.error(`Condition eval error cond=${cond.id} asin=${asin}: ${err.message}`);
    }
  }
}

function evaluateSingleCondition(cond, ctx) {
  const params = typeof cond.rule_params === 'string' ? JSON.parse(cond.rule_params) : cond.rule_params;

  switch (cond.rule_type) {
    case 'moving_avg_below_pct': {
      if (ctx.price == null || ctx.ma10Price == null || ctx.ma10Count < 5) return false;
      const threshold = ctx.ma10Price * (1 - (params.value || 30) / 100);
      return ctx.price < threshold;
    }

    case 'absolute_price_below': {
      if (ctx.price == null) return false;
      return ctx.price < (params.value || 0);
    }

    case 'offer_count_drop_pct': {
      if (ctx.newOfferCount == null || ctx.prevOfferCount == null || ctx.prevOfferCount === 0) return false;
      const dropPct = ((ctx.prevOfferCount - ctx.newOfferCount) / ctx.prevOfferCount) * 100;
      return dropPct >= (params.value || 30);
    }

    case 'marketplace_below': {
      if (ctx.marketplaceLowest == null) return false;
      return ctx.marketplaceLowest < (params.value || 0);
    }

    default:
      return false;
  }
}
