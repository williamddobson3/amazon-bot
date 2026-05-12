'use strict';

const { getSetting, insertNotification } = require('../db/queries');
const { renderChartImage } = require('./chart-image');

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

// ── Discord 通知レイアウト (v4 — 2026-05) ────────────────────
//
// 詳細はファイル下部 sendDiscordNotification の docstring 参照。
// 概要:
//   - author       : 「{slotName}」の商品検知
//   - title (link) : 商品名 (≤120 文字でトランケート)
//   - thumbnail    : 商品写真
//   - description  : ASIN + 6×3 stats table (ANSI 着色) + 🛒/👥/📦 詳細
//   - image        : アプリ生成チャート PNG
//   - footer       : ASIN + timestamp
//
// v3 まで使っていた embed.fields ベースの 2 行 1 カード × 6 個レイアウト
// は Discord クライアント側で改行幅が安定せず、CJK で 「縦方向に伸びて
// 横幅が破綻」 する問題があったため廃止。代わりに ANSI コードブロックで
// 厳密に整列させる方針に変更。

const fmtYen = (v) => (v == null || !isFinite(v))
  ? '—'
  : `¥${Number(Math.round(v)).toLocaleString('ja-JP')}`;

// Truncate to N characters (counted by code units, fine for Japanese in
// Discord embed titles which have a 256-char hard cap).
const ellipsize = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// CJK-aware monospace cell width. Full-width chars count as 2 cells.
function cellWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    w += (
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x303E) ||
      (code >= 0x3041 && code <= 0x33FF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6)
    ) ? 2 : 1;
  }
  return w;
}
const padR = (s, w) => s + ' '.repeat(Math.max(0, w - cellWidth(s)));
const padL = (s, w) => ' '.repeat(Math.max(0, w - cellWidth(s))) + s;

// Build the 6-row × 3-col stats table as a Discord ansi code block.
// Each row: 「ラベル : ¥価格   ¥差額   下落率%」 — colors per spec image:
//   diff > 0 (= 1個前/平均より最新が安い = 下落)  → RED   (alert / 注目)
//   diff < 0 (= 1個前/平均より最新が高い = 上昇)  → BLUE
//   diff = 0 / null                              → デフォルト色
//
// 6 行 = 最新 (1個前との瞬間下落) + 1日平均/7日平均/30日平均/90日平均/180日平均
// (各平均値との下落)。値の差・%は別カラムで右寄せし、ANSI で着色。
// Discord クライアントはコードブロック内 ANSI を ```ansi``` で解釈する。
//
// CJK 幅対応: padR/padL は cellWidth ベースなのでラベル ("最新", "180日平均")
// の混在でも縦が揃う。色付け前に padding を確定させて ANSI のエスケープ
// 文字列が幅計算に混ざらないようにしている (大事: 順序を逆にすると整列が
// 壊れる)。
function buildStatsTableAnsi(stats, latestEff) {
  const RED   = '\x1b[2;31m';
  const BLUE  = '\x1b[2;34m';
  const RESET = '\x1b[0m';

  const fmtYenStr = (v) => (v == null || !isFinite(v))
    ? '—'
    : '¥' + Math.round(v).toLocaleString('ja-JP');
  const fmtDiffStr = (d) => {
    if (d == null || !isFinite(d)) return '—';
    const r = Math.round(d);
    if (r === 0) return '¥0';
    return '¥' + (r > 0 ? '+' : '') + r.toLocaleString('ja-JP');
  };
  const fmtPctStr = (d, ref) => {
    if (d == null || ref == null || !isFinite(ref) || ref === 0) return '—';
    const p = (d / ref) * 100;
    if (Math.abs(p) < 0.05) return '0.0%';
    return (p > 0 ? '+' : '') + p.toFixed(1) + '%';
  };
  const colorize = (s, sign) => {
    if (sign == null || sign === 0) return s;
    return (sign > 0 ? RED : BLUE) + s + RESET;
  };

  // 最新行は「1 個前の観測」との比較 (= 瞬間下落)
  const prevEff      = (stats && stats.prevEffective != null) ? stats.prevEffective : null;
  const instantDiff  = (prevEff != null && latestEff != null) ? (prevEff - latestEff) : null;

  const rows = [
    { label: '最新',      val: latestEff,                             ref: prevEff,                             diff: instantDiff },
    { label: '1日平均',   val: stats ? stats.avg1d   : null,          ref: stats ? stats.avg1d   : null,        diff: stats ? stats.avg1dDiff   : null },
    { label: '7日平均',   val: stats ? stats.avg7d   : null,          ref: stats ? stats.avg7d   : null,        diff: stats ? stats.avg7dDiff   : null },
    { label: '30日平均',  val: stats ? stats.avg30d  : null,          ref: stats ? stats.avg30d  : null,        diff: stats ? stats.avg30dDiff  : null },
    { label: '90日平均',  val: stats ? stats.avg90d  : null,          ref: stats ? stats.avg90d  : null,        diff: stats ? stats.avg90dDiff  : null },
    { label: '180日平均', val: stats ? stats.avg180d : null,          ref: stats ? stats.avg180d : null,        diff: stats ? stats.avg180dDiff : null },
  ];

  const valStrs  = rows.map((r) => fmtYenStr(r.val));
  const diffStrs = rows.map((r) => fmtDiffStr(r.diff));
  const pctStrs  = rows.map((r) => fmtPctStr(r.diff, r.ref));

  const labelW = Math.max(...rows.map((r) => cellWidth(r.label)));   // "180日平均" = 9
  const valW   = Math.max(cellWidth('価格'),   ...valStrs.map(cellWidth));
  const diffW  = Math.max(cellWidth('差額'),   ...diffStrs.map(cellWidth));
  const pctW   = Math.max(cellWidth('下落率'), ...pctStrs.map(cellWidth));

  const lines = [];
  // ヘッダー行 — ラベル列分のスペース + 3 カラムの右寄せヘッダー。
  // データ行は `${labelCol} ${valCol}` でラベル直後に 1 スペース入るので、
  // ヘッダー側も同じ labelW + 2 (':' 2 文字) + 1 = labelW + 3 で揃える。
  lines.push(
    padR('', labelW + 3) +
    padL('価格', valW)   + '  ' +
    padL('差額', diffW)  + '  ' +
    padL('下落率', pctW)
  );
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const labelCol = padR(r.label, labelW) + ' :';
    const valCol   = padL(valStrs[i],  valW);
    const diffCol  = padL(diffStrs[i], diffW);
    const pctCol   = padL(pctStrs[i],  pctW);
    // diff の符号で diff/pct 両方を着色 (符号は同じ)
    lines.push(
      `${labelCol} ${valCol}  ${colorize(diffCol, r.diff)}  ${colorize(pctCol, r.diff)}`
    );
  }

  return '```ansi\n' + lines.join('\n') + '\n```';
}

// クライアント v4 レイアウト (2026-05) — 横幅問題を解消するため、
// 6 行 × 7 列のスタッツテーブルは描画画像側に閉じ込め、embed テキスト
// 部分は 6 行 × 3 列 (価格 / 差額 / 下落率) のコンパクト表 + 商品詳細
// 行の 2 ブロック構成に再設計した。
//
// レイアウト:
//   [Author    : 「{slotName}」の商品検知]
//   [Title     : 商品名 (≤4 行相当でトランケート、リンク → Amazon 商品ページ)]
//   [Thumbnail : 商品写真 + ASIN ラベル]
//   [Description:
//     詳細リンク (タイトル省略時のみ)
//     🔗 アクション 3 リンク
//     **ASIN** \n `BXXXXXXXXX`
//     ```ansi
//             価格      差額      下落率
//     最新     ...
//     1日平均  ...
//     ...
//     ```
//     🛒 **最新価格** : ...
//     👥 **出品者数** : ...
//     📦 **発送情報** : ...
//   ]
//   [Image     : アプリ生成チャート PNG (添付)]
//   [Footer    : Amazon 価格モニター • ASIN  + timestamp]
//
// 「全て実質BuyBox価格(=BuyBox価格-ポイント、いない場合は他の出品価格)」
// — フォールバックは scheduler.js で実施済み。ここでは latestEffective を
// そのまま使う。
//
// タイトル: Discord 埋め込みタイトルは 256 文字制限。CJK で 4 行に収まる
// ~120 chars でクライアント側のトランケート要望を実現し、超過時は description
// 先頭に [詳細](productUrl) を追加。
async function sendDiscordNotification(webhookUrl, notif) {
  const product  = notif.product || {};
  const stats    = notif.stats   || null;
  const asin     = notif.asin;
  const slotName = notif.slotName || 'フィルタ条件マッチ';

  const productUrl = `https://www.amazon.co.jp/dp/${asin}`;
  const searchUrl  = `https://www.amazon.co.jp/s?k=${encodeURIComponent(asin)}`;
  // Keepa は image embed として使えない (Discord の image proxy が
  // Keepa にアクセスすると "Access to price history blocked" を返す
  // ため)。代わりにテキストリンクとして残し、画像はアプリ生成のみ。
  const keepaPage  = `https://keepa.com/#!product/5-${asin}`;

  const lastPrice  = product.last_price ?? null;
  const lastPoints = product.last_points ?? 0;
  const effective  = (lastPrice != null) ? (lastPrice - lastPoints) : null;

  // タイトル: 4 行相当 ≒ 120 文字でトランケート。残りは [詳細] リンクで補完。
  const TITLE_MAX  = 120;
  const fullTitle  = product.title || asin;
  const truncated  = fullTitle.length > TITLE_MAX;
  const titleShort = truncated ? `${fullTitle.slice(0, TITLE_MAX)}…` : fullTitle;

  // App-rendered chart — single hero image. Generated upfront so we know
  // whether to use attachment URL or fall back gracefully.
  let chartPng = null;
  if (notif.attachChart !== false) {
    chartPng = await renderChartImage(asin);
    if (chartPng) {
      console.info(`[notifier] attached app chart (${chartPng.length} bytes) for ${asin}`);
    } else {
      console.warn(`[notifier] chart render returned null for ${asin}`);
    }
  }

  // 価格行 — "¥4,491 (=4536円-45pt)" 形式。pt が 0/null の時は省略。
  const priceLine = (lastPrice != null)
    ? `${fmtYen(effective)}` + (lastPoints
        ? ` (=${lastPrice.toLocaleString('ja-JP')}円-${lastPoints}pt)`
        : ` (=${lastPrice.toLocaleString('ja-JP')}円)`)
    : '—';

  const sellerLine   = (product.last_mp_count != null) ? `${product.last_mp_count}人` : '—';
  const deliveryLine = product.last_delivery
                         ? ellipsize(product.last_delivery, 200)
                         : '—';

  // Description 構成 — markdown + ansi コードブロック。空行で視覚分離。
  const descParts = [];
  if (truncated) {
    descParts.push(`[詳細](${productUrl})`);
  }
  descParts.push(
    `🔗 [Amazon 商品ページ](${productUrl}) ・ ` +
    `[Amazon 検索](${searchUrl}) ・ ` +
    `[Keepa 詳細](${keepaPage})`
  );
  descParts.push('');
  descParts.push('**ASIN**');
  descParts.push(`\`${asin}\``);
  descParts.push('');
  descParts.push(buildStatsTableAnsi(stats, effective));
  descParts.push(`🛒 **最新価格** : ${priceLine}`);
  descParts.push(`👥 **出品者数** : ${sellerLine}`);
  descParts.push(`📦 **発送情報** : ${deliveryLine}`);

  const description = descParts.join('\n');

  const embed = {
    author: { name: ellipsize(`「${slotName}」の商品検知`, 90) },
    title:  titleShort,
    url:    productUrl,
    description,
    color:  notif.context === 'trash' ? 0x6B7280 : 0xFF1493,
    thumbnail: product.image_url ? { url: product.image_url } : undefined,
    footer: { text: `Amazon 価格モニター • ${asin}` },
    timestamp: new Date().toISOString(),
  };
  if (chartPng) {
    embed.image = { url: 'attachment://chart.png' };
  }

  const payload = {
    username: 'Amazon 価格モニター',
    embeds:   [embed],
  };

  return postToWebhook(webhookUrl, payload, chartPng ? [{
    filename: 'chart.png',
    buffer:   chartPng,
  }] : []);
}

// ── Webhook delivery ─────────────────────────────────────────
//
// Two paths:
//   - JSON only       → Content-Type: application/json
//   - With files      → multipart/form-data (payload_json + files[N])
// Both retry on 429 honouring the retry-after header.
async function postToWebhook(webhookUrl, payload, attachments = []) {
  const useMultipart = attachments && attachments.length > 0;
  const headers = {};
  let body;

  if (useMultipart) {
    const boundary = '----amzbot' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    body = buildMultipartBody(boundary, payload, attachments);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }

  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(webhookUrl, { method: 'POST', headers, body });
      lastStatus = resp.status;
      if (resp.ok || resp.status === 204) return resp.status;
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '2', 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      try {
        const text = await resp.text();
        console.warn(`[notifier] webhook ${resp.status}: ${text.slice(0, 300)}`);
      } catch { /* swallow */ }
      return resp.status;
    } catch (err) {
      lastStatus = 0;
      console.warn(`[notifier] webhook attempt ${attempt + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return lastStatus;
}

// Discord webhook multipart format with N files:
//   --boundary
//   Content-Disposition: form-data; name="payload_json"
//   Content-Type: application/json
//
//   {...JSON payload...}
//   --boundary
//   Content-Disposition: form-data; name="files[0]"; filename="chart.png"
//   Content-Type: image/png
//
//   <binary>
//   --boundary--
function buildMultipartBody(boundary, payload, attachments) {
  const CRLF = '\r\n';
  const parts = [];

  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="payload_json"${CRLF}` +
    `Content-Type: application/json${CRLF}${CRLF}` +
    `${JSON.stringify(payload)}${CRLF}`,
    'utf8'
  ));

  attachments.forEach((file, i) => {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="files[${i}]"; filename="${file.filename}"${CRLF}` +
      `Content-Type: image/png${CRLF}${CRLF}`,
      'utf8'
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from(CRLF, 'utf8'));
  });

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return Buffer.concat(parts);
}

module.exports = { enqueueNotification };
