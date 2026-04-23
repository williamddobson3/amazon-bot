'use strict';

const {
  getConditionsForAsin,
  getMovingAverage,
  getPreviousOfferCount,
  markConditionFired,
} = require('../db/queries');
const { enqueueNotification } = require('./notifier');

// Evaluate all active conditions against a freshly-scraped product.
// Ported from backend/src/services/evaluator.js — same condition logic,
// SQLite queries instead of MySQL.
function evaluateForAsin(asin, data) {
  const conditions = getConditionsForAsin(asin);
  if (conditions.length === 0) return;

  const ma10 = getMovingAverage(asin, 10);
  const prevOffers = getPreviousOfferCount(asin);

  const context = {
    price:          data.price,
    points:         data.points,
    mpPrice:        data.mpPrice,
    mpCount:        data.mpCount,
    ma10Price:      ma10?.avgPrice ? parseFloat(ma10.avgPrice) : null,
    ma10Count:      ma10?.cnt || 0,
    prevOfferCount: prevOffers,
  };

  for (const cond of conditions) {
    try {
      const fired = evaluateSingle(cond, context);
      if (!fired) continue;

      // Cooldown check: don't re-fire within cooldown window.
      if (cond.last_fired) {
        const elapsed = Date.now() - cond.last_fired;
        if (elapsed < cond.cooldown_sec * 1000) continue;
      }

      markConditionFired(cond.id);

      enqueueNotification({
        asin,
        conditionId: cond.id,
        ruleType:    cond.rule_type,
        price:       data.price,
        mpPrice:     data.mpPrice,
        mpCount:     data.mpCount,
        points:      data.points,
        movingAvg:   ma10?.avgPrice ? Math.round(parseFloat(ma10.avgPrice)) : null,
      });

      console.info(`[evaluator] condition ${cond.id} fired for ${asin}`);
    } catch (err) {
      console.error(`[evaluator] error on cond=${cond.id} asin=${asin}: ${err.message}`);
    }
  }
}

function evaluateSingle(cond, ctx) {
  const params = typeof cond.rule_params === 'string'
    ? JSON.parse(cond.rule_params)
    : cond.rule_params;

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
      if (ctx.mpCount == null || ctx.prevOfferCount == null || ctx.prevOfferCount === 0) return false;
      const dropPct = ((ctx.prevOfferCount - ctx.mpCount) / ctx.prevOfferCount) * 100;
      return dropPct >= (params.value || 30);
    }

    case 'marketplace_below': {
      if (ctx.mpPrice == null) return false;
      return ctx.mpPrice < (params.value || 0);
    }

    default:
      return false;
  }
}

module.exports = { evaluateForAsin };
