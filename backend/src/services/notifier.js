import log from '../utils/logger.js';
import config from '../config.js';
import { insertNotification } from '../db/mysql.js';
import { sendToUser } from '../ws/hub.js';

const notificationQueue = [];
let processingTimer = null;

export async function enqueueNotification(notif) {
  notificationQueue.push(notif);
  if (!processingTimer) {
    processingTimer = setTimeout(processQueue, 100);
  }
}

async function processQueue() {
  processingTimer = null;
  const batch = notificationQueue.splice(0, config.notification.discordRateLimit);
  if (batch.length === 0) return;

  for (const notif of batch) {
    try {
      // Only call Discord if a webhook URL is configured
      let discordStatus = 0;
      if (notif.webhookUrl) {
        discordStatus = await sendDiscordNotification(notif);
      }

      await insertNotification({
        userId: notif.userId,
        asin: notif.asin,
        conditionId: notif.conditionId,
        price: notif.price,
        movingAvg: notif.movingAvg,
        discordStatus,
      });

      // Always push the triggered event to the extension via WebSocket
      sendToUser(notif.userId, {
        type: 'CONDITION_TRIGGERED',
        asin: notif.asin,
        conditionId: notif.conditionId,
        discordSent: notif.webhookUrl ? (discordStatus >= 200 && discordStatus < 300) : false,
      });
    } catch (err) {
      log.error(`Notification error: ${err.message}`);
    }
  }

  if (notificationQueue.length > 0) {
    processingTimer = setTimeout(processQueue, config.notification.discordRateWindowMs);
  }
}

async function sendDiscordNotification(notif) {
  // Per-rule styling: each alert type gets its own emoji, Japanese title, and accent color
  const ruleConfig = {
    moving_avg_below_pct: {
      emoji: '📉',
      title: '移動平均を大幅に下回る価格を検知',
      color: 0xE53935, // 赤 — strong price drop
    },
    absolute_price_below: {
      emoji: '🎯',
      title: '設定価格を下回りました',
      color: 0xFF6B35, // 橙 — threshold hit
    },
    offer_count_drop_pct: {
      emoji: '⚡',
      title: '出品者数が大幅に減少',
      color: 0x8E44AD, // 紫 — supply change
    },
    marketplace_below: {
      emoji: '🛍️',
      title: 'マーケットプレイス最安値を更新',
      color: 0x00897B, // 青緑 — marketplace deal
    },
  };

  const cfg = ruleConfig[notif.ruleType] || {
    emoji: '🔔',
    title: '価格アラート',
    color: 0xFF9900, // Amazon オレンジ
  };

  // Formatters using ja-JP locale
  const fmtYen = (v) => (v != null ? `¥${v.toLocaleString('ja-JP')}` : '—');
  const fmtNum = (v) => (v != null ? v.toLocaleString('ja-JP') : '—');

  // Percent change vs. 10-day moving average
  const pctChange = notif.movingAvg && notif.price != null
    ? ((notif.price - notif.movingAvg) / notif.movingAvg) * 100
    : null;

  const productUrl = `https://www.amazon.co.jp/dp/${notif.asin}`;

  // Description: blockquote explanation + clickable product link
  const description =
    `> ${cfg.emoji}  **${cfg.title}**\n\n` +
    `🔗  [**${notif.asin}**](${productUrl}) を Amazon.co.jp で開く`;

  const fields = [];

  // Current price — the star of the show, always first
  if (notif.price != null) {
    fields.push({
      name: '💴  現在価格',
      value: `**${fmtYen(notif.price)}**`,
      inline: true,
    });
  }

  // 10-day moving average for context
  if (notif.movingAvg != null) {
    fields.push({
      name: '📊  10日平均',
      value: fmtYen(notif.movingAvg),
      inline: true,
    });
  }

  // Delta vs. average with directional arrow
  if (pctChange != null) {
    const arrow = pctChange < 0 ? '🔻' : '🔺';
    const sign = pctChange > 0 ? '+' : '';
    fields.push({
      name: '📉  平均との差',
      value: `${arrow}  **${sign}${pctChange.toFixed(1)}%**`,
      inline: true,
    });
  }

  // Amazon points (ポイント)
  if (notif.points != null) {
    fields.push({
      name: '⭐  獲得ポイント',
      value: `**${fmtNum(notif.points)}** pt`,
      inline: true,
    });
  }

  // Marketplace (other sellers) lowest price
  if (notif.marketplaceLowest != null) {
    fields.push({
      name: '🛒  他の出品者',
      value: fmtYen(notif.marketplaceLowest),
      inline: true,
    });
  }

  // Number of sellers
  if (notif.newOfferCount != null) {
    fields.push({
      name: '👥  出品者数',
      value: `**${fmtNum(notif.newOfferCount)}** 件`,
      inline: true,
    });
  }

  // Pad to a multiple of 3 inline fields so the last row stays aligned in Discord's grid
  while (fields.length % 3 !== 0 && fields.length > 3) {
    fields.push({ name: '\u200B', value: '\u200B', inline: true });
  }

  // Japanese-formatted JST timestamp for the footer
  const now = new Date();
  const jstTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  const embed = {
    author: {
      name: '🅰  Amazon 価格モニター',
      url: productUrl,
    },
    title: `${cfg.emoji}  ${cfg.title}`,
    url: productUrl,
    description,
    color: cfg.color,
    fields,
    footer: {
      text: `Amazon 価格モニター  •  ${jstTime} JST  •  ${notif.asin}`,
    },
    timestamp: now.toISOString(),
  };

  // Top-level content line — shows in mobile push notification previews
  const body = JSON.stringify({
    username: 'Amazon 価格モニター',
    content: `${cfg.emoji}  **価格アラート発動** — ${notif.asin}`,
    embeds: [embed],
  });

  let lastStatus = 0;
  for (let attempt = 0; attempt < config.notification.maxRetriesPerNotification; attempt++) {
    try {
      const resp = await fetch(notif.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      lastStatus = resp.status;

      if (resp.ok || resp.status === 204) return resp.status;

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '2', 10);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (resp.status === 404) {
        log.warn(`Discord webhook 404 for user ${notif.userId} — webhook deleted`);
        return 404;
      }

      return resp.status;
    } catch (err) {
      log.error(`Discord fetch error attempt ${attempt}: ${err.message}`);
      lastStatus = 0;
      await sleep(2000 * (attempt + 1));
    }
  }

  return lastStatus;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
