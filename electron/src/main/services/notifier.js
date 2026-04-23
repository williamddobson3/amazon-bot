'use strict';

const { getSetting, insertNotification } = require('../db/queries');

// In-memory queue, flushed in batches of 5 every 2 s (matches the
// Discord rate limit of 5 requests per 2 seconds per webhook).
const queue = [];
let flushTimer = null;

function enqueueNotification(notif) {
  queue.push(notif);
  if (!flushTimer) {
    flushTimer = setTimeout(flushQueue, 100);
  }
}

async function flushQueue() {
  flushTimer = null;
  const batch = queue.splice(0, 5);
  if (batch.length === 0) return;

  const webhookUrl = getSetting('discordWebhookUrl');

  for (const notif of batch) {
    try {
      let discordStatus = 0;
      if (webhookUrl) {
        discordStatus = await sendDiscordNotification(webhookUrl, notif);
      }

      insertNotification({
        asin: notif.asin,
        conditionId: notif.conditionId,
        price: notif.price,
        mpPrice: notif.mpPrice,
        discordSent: webhookUrl ? (discordStatus >= 200 && discordStatus < 300) : false,
      });
    } catch (err) {
      console.error(`[notifier] error: ${err.message}`);
    }
  }

  if (queue.length > 0) {
    flushTimer = setTimeout(flushQueue, 2000);
  }
}

async function sendDiscordNotification(webhookUrl, notif) {
  const ruleConfig = {
    moving_avg_below_pct: { emoji: '📉', title: '移動平均を大幅に下回る価格を検知', color: 0xE53935 },
    absolute_price_below: { emoji: '🎯', title: '設定価格を下回りました', color: 0xFF6B35 },
    offer_count_drop_pct: { emoji: '⚡', title: '出品者数が大幅に減少', color: 0x8E44AD },
    marketplace_below:    { emoji: '🛍️', title: 'マーケットプレイス最安値を更新', color: 0x00897B },
  };

  const cfg = ruleConfig[notif.ruleType] || { emoji: '🔔', title: '価格アラート', color: 0xFF9900 };
  const fmtYen = (v) => (v != null ? `¥${v.toLocaleString('ja-JP')}` : '—');

  const productUrl = `https://www.amazon.co.jp/dp/${notif.asin}`;

  const pctChange = notif.movingAvg && notif.price != null
    ? ((notif.price - notif.movingAvg) / notif.movingAvg) * 100
    : null;

  const fields = [];
  if (notif.price != null) fields.push({ name: '💴 現在価格', value: `**${fmtYen(notif.price)}**`, inline: true });
  if (notif.movingAvg != null) fields.push({ name: '📊 10日平均', value: fmtYen(notif.movingAvg), inline: true });
  if (pctChange != null) {
    const arrow = pctChange < 0 ? '🔻' : '🔺';
    const sign = pctChange > 0 ? '+' : '';
    fields.push({ name: '📉 平均との差', value: `${arrow} **${sign}${pctChange.toFixed(1)}%**`, inline: true });
  }
  if (notif.points != null) fields.push({ name: '⭐ 獲得ポイント', value: `**${notif.points}** pt`, inline: true });
  if (notif.mpPrice != null) fields.push({ name: '🛒 他の出品者', value: fmtYen(notif.mpPrice), inline: true });
  if (notif.mpCount != null) fields.push({ name: '👥 出品者数', value: `**${notif.mpCount}** 件`, inline: true });

  const jstTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());

  const body = JSON.stringify({
    username: 'Amazon 価格モニター',
    content: `${cfg.emoji} **価格アラート発動** — ${notif.asin}`,
    embeds: [{
      author: { name: '🅰 Amazon 価格モニター', url: productUrl },
      title: `${cfg.emoji} ${cfg.title}`,
      url: productUrl,
      description: `> ${cfg.emoji} **${cfg.title}**\n\n🔗 [**${notif.asin}**](${productUrl}) を Amazon.co.jp で開く`,
      color: cfg.color,
      fields,
      footer: { text: `Amazon 価格モニター • ${jstTime} JST • ${notif.asin}` },
      timestamp: new Date().toISOString(),
    }],
  });

  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      lastStatus = resp.status;
      if (resp.ok || resp.status === 204) return resp.status;
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '2', 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      return resp.status;
    } catch (err) {
      lastStatus = 0;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return lastStatus;
}

module.exports = { enqueueNotification };
