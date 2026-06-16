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
        asin:        notif.asin,
        conditionId: notif.conditionId,
        price:       notif.price,
        mpPrice:     notif.mpPrice,
        discordSent: webhookUrl ? (discordStatus >= 200 && discordStatus < 300) : false,
        // どの FNM カスタムフィルタスロットがマッチしたか — 通知履歴 UI
        // に「マッチしたカスタムフィルタ」を出すために保存する。
        slotName:    notif.slotName,
        slotIndex:   notif.slotIndex,
        context:     notif.context,
        // 商品タイトルはスナップショット保存 (将来 product が削除されても
        // 通知履歴に出せるように)。
        title:       notif.product && notif.product.title,
      });
    } catch (err) {
      console.error(`[notifier] error: ${err.message}`);
    }
  }

  if (queue.length > 0) {
    flushTimer = setTimeout(flushQueue, 2000);
  }
}

// ── Discord 通知レイアウト (v7 — 2026-06 spec 項目12/13) ────────────
//
// 詳細はファイル下部 sendDiscordNotification の docstring 参照。
// 概要:
//   - author       : 「{slotName}」の商品検知
//   - title (link) : 商品名 (≤120 文字でトランケート)
//   - thumbnail    : 商品写真
//   - description  : サイト比較リンク+ASIN / 価格表 / 🛒💰👥📊📦 詳細
//   - image        : アプリ生成チャート PNG (価格/差額/下落率/利益額/利益率の表を内包)
//   - footer       : ASIN + timestamp
//
// レイアウト変遷:
//   v3: embed.fields ベース → CJK で改行幅が不安定で破綻 → 廃止
//   v4: ANSI コードブロックの表を description に埋め込み → 5 桁価格で折返し
//   v5: 表を画像へ集約 (option C) → クライアントが「テキスト表も残したい」
//   v6: テキスト表を復活させつつ、5 施策で表を圧縮し折り返しにくくした:
//       (1) リンク行を「サイト比較①②」に統一し ASIN を同行配置
//       (2) 列見出しを「平均価格」に  (3) 行名から「平均」を削除
//       (4) 正値の + を非表記 (負値の - は残す)  (5) 下落率を整数表記
//   v7 (項目12/13): テキスト表は「差額」列を撤去し「ROE利益率」列を追加
//       (= 平均価格/下落率/ROE利益率)。詳細行に 💰FBA利益額(ROE利益率) と
//       📊月間売行き個数 を追加、👥は「新品出品者数」に改称、🛒価格行に送料を明記。
//       画像内の表 (chart-render.html) は 価格/差額/下落率 に加え 利益額/利益率
//       の 2 行を追加 (項目11、下落率は小数第 1 位まで)。

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

// 価格表 (embed テキスト用) を Discord ansi コードブロックで描画する。
// v7 仕様 (2026-06 spec 項目12) — 「差額」列を撤去し「ROE利益率」列を追加:
//   - 行ラベル : 最新 / 1日 / 7日 / 30日 / 90日 / 180日 (「平均」を削除)
//   - 列見出し : 平均価格 / 下落率 / ROE利益率
//   - 下落率    : 小数を四捨五入した整数 / 正値は + 無し / 負値は - / 0 は 0%
//   - ROE利益率 : 利益額 ÷ 最新実質 × 100 を四捨五入 / 正値は + / 0 は 0%
//   - 着色      : 下落率=下落の符号 (下落=赤/上昇=青)、ROE=利益の符号
//                (プラス→赤 / マイナス→青) — アプリのリスト/詳細グラフと統一
//
// 「最新」行は 1 個前の観測との比較 (= 瞬間)、それ以外の行は各平均値との比較。
// ROE は各行の基準実質 (最新=1個前実質、N日=N日平均実質) − 最新実質 − 各手数料
// から算出 (アプリの FBA利益額/ROE 列と同じ式)。fees は product 由来。
//
// 着色は padding 確定後に適用すること — ANSI エスケープ文字が cellWidth
// に混ざると整列が壊れるため (順序厳守)。
function buildStatsTableAnsi(stats, latestEff, product) {
  const RED   = '\x1b[2;31m';
  const BLUE  = '\x1b[2;34m';
  const RESET = '\x1b[0m';

  const fmtYenStr = (v) => (v == null || !isFinite(v))
    ? '—'
    : '¥' + Math.round(v).toLocaleString('ja-JP');
  // 下落率 — 整数四捨五入 / 正値は + 非表記 / 負値は - 表記 / 0 は 0%。
  const fmtPctStr = (d, ref) => {
    if (d == null || ref == null || !isFinite(ref) || ref === 0) return '—';
    const r = Math.round((d / ref) * 100);
    return r + '%';
  };
  const colorize = (s, sign) => {
    if (sign == null || sign === 0) return s;
    return (sign > 0 ? RED : BLUE) + s + RESET;
  };

  // ── ROE利益率 (項目12) — 利益額 ÷ 最新実質 × 100 ──────────────
  // 利益額 = 基準実質 − 最新実質 − Amazon販売手数料 − FBA販売手数料 − 在庫保管料。
  const p  = product || {};
  const af = (p.amazon_fee != null) ? p.amazon_fee : null;
  const ff = (p.fba_fee != null) ? p.fba_fee : null;
  const sf = (p.inventory_storage_fee != null) ? p.inventory_storage_fee : null;
  const PROFIT_SANITY = 0.2;
  const roeOf = (ref) => {
    if (ref == null || latestEff == null) return null;
    if (latestEff <= 0 || latestEff < ref * PROFIT_SANITY) return null;
    if (af == null || ff == null || sf == null) return null;
    const amt = ref - latestEff - af - ff - sf;
    return (amt / latestEff) * 100;
  };
  const fmtRoeStr = (roe) => {
    if (roe == null || !isFinite(roe)) return '—';
    return Math.round(roe) + '%';
  };

  // 最新行は「1 個前の観測」との比較 (= 瞬間下落)。
  const prevEff     = (stats && stats.prevEffective != null) ? stats.prevEffective : null;
  const instantDiff = (prevEff != null && latestEff != null) ? (prevEff - latestEff) : null;

  const rows = [
    { label: '最新',  val: latestEff,                    ref: prevEff,                      diff: instantDiff },
    { label: '1日',   val: stats ? stats.avg1d   : null, ref: stats ? stats.avg1d   : null, diff: stats ? stats.avg1dDiff   : null },
    { label: '7日',   val: stats ? stats.avg7d   : null, ref: stats ? stats.avg7d   : null, diff: stats ? stats.avg7dDiff   : null },
    { label: '30日',  val: stats ? stats.avg30d  : null, ref: stats ? stats.avg30d  : null, diff: stats ? stats.avg30dDiff  : null },
    { label: '90日',  val: stats ? stats.avg90d  : null, ref: stats ? stats.avg90d  : null, diff: stats ? stats.avg90dDiff  : null },
    { label: '180日', val: stats ? stats.avg180d : null, ref: stats ? stats.avg180d : null, diff: stats ? stats.avg180dDiff : null },
  ];

  const valStrs = rows.map((r) => fmtYenStr(r.val));
  const pctStrs = rows.map((r) => fmtPctStr(r.diff, r.ref));
  const roeVals = rows.map((r) => roeOf(r.ref));
  const roeStrs = roeVals.map(fmtRoeStr);

  const labelW = Math.max(...rows.map((r) => cellWidth(r.label)));
  const valW   = Math.max(cellWidth('平均価格'),  ...valStrs.map(cellWidth));
  const pctW   = Math.max(cellWidth('下落率'),    ...pctStrs.map(cellWidth));
  const roeW   = Math.max(cellWidth('ROE利益率'), ...roeStrs.map(cellWidth));

  const lines = [];
  // ヘッダー行 — ラベル列ぶん (labelW + ':' + 1sp) の空白 + 3 カラム見出し。
  lines.push(
    padR('', labelW + 2) +
    padL('平均価格', valW) + ' ' +
    padL('下落率', pctW)   + ' ' +
    padL('ROE利益率', roeW)
  );
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const labelCol = padR(r.label, labelW) + ':';
    const valCol   = padL(valStrs[i], valW);
    const pctCol   = padL(pctStrs[i], pctW);
    const roeCol   = padL(roeStrs[i], roeW);
    // 下落率は下落符号 (diff) で、ROEは利益符号 (roe値) で着色。
    lines.push(
      `${labelCol} ${valCol} ${colorize(pctCol, r.diff)} ${colorize(roeCol, roeVals[i])}`
    );
  }

  return '```ansi\n' + lines.join('\n') + '\n```';
}

// クライアント v7 レイアウト (2026-06 spec 項目12/13)。
//
// レイアウト:
//   [Author    : 「{slotName}」の商品検知]
//   [Title     : 商品名 (≤120 文字でトランケート、リンク → Amazon 商品ページ)]
//   [Thumbnail : 商品写真]
//   [Description:
//     詳細リンク (タイトル省略時のみ)
//     🔗 [サイト比較①](Keepa) [サイト比較②](Amazon)　ASIN `BXXXXXXXXX`
//     ```ansi  価格表 (平均価格/下落率/ROE利益率 × 最新/1日/7日/30日/90日/180日)  ```
//     🛒 **最新価格** : ¥X (=X円-Xpt+送料X円)
//     💰 **FBA利益額(ROE利益率)** : ¥X（X％）   ← 30日平均ベース
//     👥 **新品出品者数** : X人   ← 新品出品数(取込) 優先、無ければ 全出品数(内訳)
//     📊 **月間売行き個数** : X個  ← 30日ランク変動(取込) 優先、無ければ 月間販売数
//     📦 **発送情報** : ...
//   ]
//   [Image     : アプリ生成チャート PNG — 価格表(+利益額/利益率) + 2 グラフを内包]
//   [Footer    : Amazon 価格モニター • ASIN  + timestamp]
//
// 「全て実質BuyBox価格(=BuyBox価格-ポイント、いない場合は他の出品価格)」
// — フォールバックは scheduler.js で実施済み。
//
// タイトル: Discord 埋め込みタイトルは 256 文字制限。~120 chars で
// トランケートし、超過時は description 先頭に [詳細](productUrl) を追加。
async function sendDiscordNotification(webhookUrl, notif) {
  const product  = notif.product || {};
  // notif.stats は ipc-handlers の fireFnmNotification が getProductStats
  // で付与する。価格表 (buildStatsTableAnsi) の平均値・下落率に使う。
  const stats    = notif.stats   || null;
  const asin     = notif.asin;
  const slotName = notif.slotName || 'フィルタ条件マッチ';

  // サイト比較リンクはアプリの「サイト比較」ボタンと統一:
  //   ① Keepa 商品ページ   ② Amazon 商品ページ
  const productUrl = `https://www.amazon.co.jp/dp/${asin}`;
  const keepaPage  = `https://keepa.com/#!product/5-${asin}`;

  const lastPrice    = product.last_price ?? null;
  const lastPoints   = product.last_points ?? 0;
  const lastShipping = product.last_shipping_fee ?? 0;
  // 実質価格 = BuyBox − ポイント + 送料 (2026-05 fix)。
  const effective    = (lastPrice != null) ? (lastPrice - lastPoints + lastShipping) : null;

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

  // 価格行 — "¥4,624 (=4540円-136pt+送料220円)" 形式 (項目13: 送料を明記)。
  // pt = 0/null の項は省略、送料 = 0/null の項も省略。
  let priceLine = '—';
  if (lastPrice != null) {
    const parts = [`${lastPrice.toLocaleString('ja-JP')}円`];
    if (lastPoints)   parts.push(`-${lastPoints}pt`);
    if (lastShipping) parts.push(`+送料${lastShipping.toLocaleString('ja-JP')}円`);
    priceLine = `${fmtYen(effective)} (=${parts.join('')})`;
  }

  // 💰 FBA利益額(ROE利益率) 行 (項目13)。期間は 30日平均 (アプリ既定の利益期間に
  // 合わせる = 「現価格で仕入れ、平常価格で売る」想定の代表値)。別期間にしたい
  // 場合は ref を stats.avg{N}d に差し替えるだけ。利益額 = 30日平均実質 − 最新実質
  // − Amazon − FBA − 在庫保管料、ROE = 利益額 ÷ 最新実質 × 100。
  let profitLine = '—';
  {
    const af = (product.amazon_fee != null) ? product.amazon_fee : null;
    const ff = (product.fba_fee != null) ? product.fba_fee : null;
    const sf = (product.inventory_storage_fee != null) ? product.inventory_storage_fee : null;
    const ref = stats ? stats.avg30d : null;
    if (ref != null && effective != null && effective > 0 && effective >= ref * 0.2
        && af != null && ff != null && sf != null) {
      const amt = ref - effective - af - ff - sf;
      const roe = (amt / effective) * 100;
      profitLine = `${fmtYen(amt)}（${Math.round(roe)}％）`;
    }
  }

  // 新品出品者数 (項目13): 新品出品数(取込) を優先、無ければ 全出品数(内訳)。
  const newSellerCount = (product.imp_sellers != null)
    ? product.imp_sellers
    : (product.last_mp_count != null ? product.last_mp_count : null);
  const sellerLine = (newSellerCount != null) ? `${newSellerCount}人` : '—';

  // 月間売行き個数 (項目13): 30日ランク変動(取込) を優先、無ければ 月間販売数
  // (= 監視値 last_monthly_sales 優先、無ければ取込 imp_monthly_sales)。
  const monthlySales = (product.last_monthly_sales != null)
    ? product.last_monthly_sales
    : (product.imp_monthly_sales != null ? product.imp_monthly_sales : null);
  const salesCount = (product.imp_rank_drop_30d != null) ? product.imp_rank_drop_30d : monthlySales;
  const salesLine  = (salesCount != null) ? `${salesCount}個` : '—';

  const deliveryLine = product.last_delivery
                         ? ellipsize(product.last_delivery, 200)
                         : '—';

  // Description 構成 (v6) — markdown + ansi コードブロックの価格表。
  const descParts = [];
  if (truncated) {
    descParts.push(`[詳細](${productUrl})`);
  }
  // リンク行 — 「サイト比較①(Keepa) / ②(Amazon)」の 2 リンクを並べ、
  // 空いた横スペースに ASIN を同じ行で続ける。リンクとリンク・リンクと
  // ASIN の区切りは全角スペース (U+3000) — Discord は連続する半角
  // スペースを 1 個に詰めてしまうため、全角なら間隔が保持される。
  descParts.push(
    `🔗 [サイト比較①](${keepaPage})　[サイト比較②](${productUrl})` +
    `　　**ASIN** \`${asin}\``
  );
  descParts.push('');
  // 価格表 (平均価格 / 下落率 / ROE利益率、項目12)。stats が無いケースでも
  // buildStatsTableAnsi は「最新」行だけ値を出し、平均行は '—' になる。
  descParts.push(buildStatsTableAnsi(stats, effective, product));
  descParts.push(`🛒 **最新価格** : ${priceLine}`);
  descParts.push(`💰 **FBA利益額(ROE利益率)** : ${profitLine}`);
  descParts.push(`👥 **新品出品者数** : ${sellerLine}`);
  descParts.push(`📊 **月間売行き個数** : ${salesLine}`);
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
