'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Init ────────────────────────────────────────────────────
//
// CRITICAL: set up all click/event handlers SYNCHRONOUSLY before any
// async call. If an async call (like refreshStatus → window.api.invoke)
// throws because the IPC bridge isn't ready yet, we must not let that
// prevent UI handlers from being registered — otherwise buttons render
// but are unclickable.

document.addEventListener('DOMContentLoaded', () => {
  // 1. Synchronous UI setup — always succeeds, no IPC needed.
  setupTabs();
  setupProductControls();
  setupConditionControls();
  setupDiscordControls();
  setupScrapeToggle();

  window.addEventListener('resize', () => renderVisible());

  // 2. Async data loading — best-effort, errors don't break the UI.
  (async () => {
    try { await refreshStatus(); }  catch (e) { console.warn('init refreshStatus:', e); }
    try { await loadProducts(); }   catch (e) { console.warn('init loadProducts:', e); }
    try { await loadConditions(); } catch (e) { console.warn('init loadConditions:', e); }
    try { await loadDiscord(); }    catch (e) { console.warn('init loadDiscord:', e); }
    try { await loadNotifications(); } catch (e) { console.warn('init loadNotifications:', e); }
  })();

  setInterval(() => { refreshStatus().catch(() => {}); }, 5000);
});

// ── Push events from main process ───────────────────────────

window.api.onPriceUpdate((data) => {
  handleIncomingPriceUpdate(data.asin, data.data, data.updatedAt);
});

window.api.onCycleProgress((p) => {
  showCycleProgress(p);
});

window.api.onCycleComplete((c) => {
  hideCycleProgress();
  loadProducts(); // refresh full list with final state
});

window.api.onCaptchaPause((p) => {
  showCaptchaBanner(p);
});

window.api.onCaptchaResume(() => {
  hideCaptchaBanner();
});

// ── Tabs ────────────────────────────────────────────────────

function setupTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// ── Status ──────────────────────────────────────────────────

async function refreshStatus() {
  const status = await window.api.invoke('getStatus');
  if (!status) return;

  const dot  = $('#status-indicator');
  const text = $('#status-text');
  const cnt  = $('#product-count');
  const btn  = $('#btn-toggle-scraping');

  if (status.running) {
    dot.className  = 'status-dot online';
    text.textContent = status.paused ? 'Paused (CAPTCHA)' : 'Scraping';
    btn.textContent = 'Stop';
  } else {
    dot.className  = 'status-dot offline';
    text.textContent = 'Stopped';
    btn.textContent = 'Start';
  }
  cnt.textContent = `${status.productCount} items`;
}

function setupScrapeToggle() {
  $('#btn-toggle-scraping').addEventListener('click', async () => {
    const status = await window.api.invoke('getStatus');
    if (status.running) {
      await window.api.invoke('stopScraping');
    } else {
      await window.api.invoke('startScraping');
    }
    await refreshStatus();
  });
}

// ── Product management (virtualised list) ───────────────────

const ROW_HEIGHT = 140;
const SCROLL_BUFFER = 4;

let allProducts = [];
let filtered = [];
let productIndex = new Map();
const visibleCards = new Map();
const dirtyAsins = new Set();
let flushScheduled = false;
let currentSearch = '';

function setupProductControls() {
  $('#btn-add').addEventListener('click', onAddClick);
  $('#csv-import').addEventListener('change', onCsvImport);
  $('#product-search').addEventListener('input', () => {
    currentSearch = $('#product-search').value.toLowerCase();
    applyFilter();
    $('#product-list').scrollTop = 0;
    renderVisible();
  });

  const container = $('#product-list');
  container.addEventListener('click', onListClick);
  container.addEventListener('scroll', renderVisible, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => renderVisible()).observe(container);
  }
}

async function onAddClick() {
  const raw = $('#asin-input').value;
  const asins = raw.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (asins.length === 0) return;

  const btn = $('#btn-add');
  btn.disabled = true;
  try {
    const result = await window.api.invoke('addProducts', { asins });
    $('#asin-input').value = '';
    showAddStatus(`${result.added} added (${result.total} submitted)`, 'success');
    await loadProducts();
    await refreshStatus();
  } catch (err) {
    showAddStatus(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function onCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const asins = text.split(/[\n,;\s]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9]{10}$/.test(s));
  if (asins.length === 0) { showAddStatus('No valid ASINs in file', 'error'); return; }
  const result = await window.api.invoke('addProducts', { asins });
  showAddStatus(`${result.added} added from file`, 'success');
  await loadProducts();
  await refreshStatus();
  e.target.value = '';
}

function showAddStatus(text, type) {
  const el = $('#add-status');
  el.textContent = text;
  el.className = `asin-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

async function loadProducts() {
  const result = await window.api.invoke('getProducts');
  if (!Array.isArray(result)) return;
  allProducts = result;
  productIndex = new Map();
  for (let i = 0; i < allProducts.length; i++) {
    productIndex.set(allProducts[i].asin, i);
  }
  applyFilter();
  renderVisible();
}

function applyFilter() {
  if (!currentSearch) {
    filtered = allProducts;
  } else {
    filtered = allProducts.filter(
      (p) => p.asin.toLowerCase().includes(currentSearch) ||
             (p.title || '').toLowerCase().includes(currentSearch)
    );
  }
  $('#product-list-count').textContent = `${filtered.length} items`;
  const sizer = $('#product-list-sizer');
  if (filtered.length === 0) {
    sizer.style.height = '0px';
    for (const [, el] of visibleCards) el.remove();
    visibleCards.clear();
    if (!sizer.querySelector('.empty-message')) {
      sizer.innerHTML = '<div class="empty-message">No products added yet</div>';
    }
    return;
  }
  const em = sizer.querySelector('.empty-message');
  if (em) em.remove();
  sizer.style.height = `${filtered.length * ROW_HEIGHT}px`;
}

function renderVisible() {
  const container = $('#product-list');
  const sizer = $('#product-list-sizer');
  if (filtered.length === 0) return;

  const viewportH = container.clientHeight;
  const scrollTop = container.scrollTop;
  let startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - SCROLL_BUFFER);
  let endIdx = Math.min(filtered.length - 1, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + SCROLL_BUFFER);

  const shouldExist = new Set();
  for (let i = startIdx; i <= endIdx; i++) {
    const row = filtered[i];
    shouldExist.add(row.asin);
    let card = visibleCards.get(row.asin);
    if (!card) {
      card = createCard(row);
      sizer.appendChild(card);
      visibleCards.set(row.asin, card);
    }
    card.style.top = `${i * ROW_HEIGHT}px`;
    updateCard(card, row);
  }
  for (const [asin, card] of visibleCards) {
    if (!shouldExist.has(asin)) { card.remove(); visibleCards.delete(asin); }
  }
}

function onListClick(e) {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    handleRemove(removeBtn.dataset.remove);
    return;
  }
}

async function handleRemove(asin) {
  await window.api.invoke('removeProduct', { asin });
  const idx = productIndex.get(asin);
  if (idx != null) {
    allProducts.splice(idx, 1);
    productIndex = new Map();
    for (let i = 0; i < allProducts.length; i++) productIndex.set(allProducts[i].asin, i);
  }
  const card = visibleCards.get(asin);
  if (card) { card.remove(); visibleCards.delete(asin); }
  applyFilter();
  renderVisible();
  await refreshStatus();
}

// ── Live update pipeline ────────────────────────────────────

function handleIncomingPriceUpdate(asin, data, updatedAt) {
  const idx = productIndex.get(asin);
  if (idx == null) { loadProducts(); return; }
  const row = allProducts[idx];
  if (data) {
    if (data.title) row.title = data.title;
    if (data.imageUrl) row.image_url = data.imageUrl;
    row.last_price       = data.price ?? null;
    row.last_points      = data.points ?? null;
    row.last_delivery    = data.delivery ?? null;
    row.last_mp_price    = data.mpPrice ?? null;
    row.last_mp_count    = data.mpCount ?? null;
    row.last_mp_condition = data.mpCondition ?? null;
    row.last_observed_at = updatedAt;
    row.last_error       = null;
  }
  dirtyAsins.add(asin);
  if (!flushScheduled) { flushScheduled = true; requestAnimationFrame(flushDirty); }
}

function flushDirty() {
  flushScheduled = false;
  for (const asin of dirtyAsins) {
    const idx = productIndex.get(asin);
    if (idx == null) continue;
    const card = visibleCards.get(asin);
    if (!card) continue;
    updateCard(card, allProducts[idx]);
    card.classList.remove('just-updated');
    void card.offsetWidth;
    card.classList.add('just-updated');
  }
  dirtyAsins.clear();
}

// ── Card builders ───────────────────────────────────────────

function createCard(row) {
  const card = document.createElement('div');
  card.className = 'asin-card virtual';
  card.dataset.asin = row.asin;

  card.innerHTML = `
    <div class="asin-card-head">
      <a class="asin-code-link" href="https://www.amazon.co.jp/dp/${row.asin}" target="_blank">${row.asin}</a>
      <div class="asin-card-head-actions">
        <button class="btn btn-danger btn-sm" data-remove="${row.asin}">Remove</button>
      </div>
    </div>
    <div class="asin-card-title" data-f="title"></div>
    <div class="asin-card-grid">
      <div class="field"><div class="field-label">Price</div><div class="field-value field-price" data-f="price">---</div></div>
      <div class="field"><div class="field-label">Points</div><div class="field-value" data-f="points">---</div></div>
      <div class="field"><div class="field-label">MP Price</div><div class="field-value" data-f="mpPrice">---</div></div>
      <div class="field"><div class="field-label">MP Count</div><div class="field-value" data-f="mpCount">---</div></div>
    </div>
    <div class="asin-card-foot" data-f="foot"></div>
  `;

  updateCard(card, row);
  return card;
}

function updateCard(card, row) {
  const hasData = row.last_observed_at != null;
  const pending = !hasData && !row.last_error;
  card.classList.toggle('skeleton', pending);
  card.classList.toggle('asin-card-pending', !hasData);

  const set = (name, val) => {
    const el = card.querySelector(`[data-f="${name}"]`);
    if (el && el.textContent !== val) el.textContent = val;
  };

  set('title', row.title || '(Not scraped yet)');
  set('price', row.last_price != null ? `¥${Number(row.last_price).toLocaleString()}` : '---');
  set('points', row.last_points != null ? `${row.last_points} pt` : '---');
  set('mpPrice', row.last_mp_price != null ? `¥${Number(row.last_mp_price).toLocaleString()}` : '---');
  set('mpCount', row.last_mp_count != null ? `${row.last_mp_count} 件` : '---');

  const updatedStr = row.last_observed_at
    ? new Date(row.last_observed_at).toLocaleString('ja-JP')
    : (row.last_error ? `Error: ${row.last_error}` : 'Waiting…');
  set('foot', `Updated: ${updatedStr}`);
}

// ── Cycle progress ──────────────────────────────────────────

function showCycleProgress(p) {
  const el = $('#cycle-progress');
  el.classList.remove('hidden');
  $('#cycle-progress-counts').textContent = `${p.done} / ${p.total}`;
  const pct = p.total > 0 ? (p.done / p.total * 100) : 0;
  $('#cycle-progress-fill').style.width = `${pct.toFixed(1)}%`;
  $('#cycle-progress-wave').textContent = `wave ${p.wave || 1}`;
}

function hideCycleProgress() {
  $('#cycle-progress').classList.add('hidden');
}

// ── CAPTCHA banner ──────────────────────────────────────────

let captchaCountdownTimer = null;
let captchaPausedUntil = 0;

function showCaptchaBanner(p) {
  captchaPausedUntil = p.pausedUntil || 0;
  const titles = { amazon: 'Amazon verification required', google: 'Google bot detection', network: 'Network verification' };
  $('#captcha-banner-title').textContent = titles[p.source] || titles.amazon;
  $('#captcha-banner-reason').textContent = p.reason || '';
  $('#captcha-banner').classList.remove('hidden');
  updateCaptchaCountdown();
  if (captchaCountdownTimer) clearInterval(captchaCountdownTimer);
  captchaCountdownTimer = setInterval(updateCaptchaCountdown, 1000);

  $('#captcha-solve-btn').onclick = () => window.api.invoke('solveCaptcha');
}

function updateCaptchaCountdown() {
  const rem = captchaPausedUntil - Date.now();
  if (rem <= 0) { hideCaptchaBanner(); return; }
  const m = Math.floor(rem / 60000);
  const s = Math.ceil((rem % 60000) / 1000);
  $('#captcha-countdown').textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function hideCaptchaBanner() {
  $('#captcha-banner').classList.add('hidden');
  if (captchaCountdownTimer) { clearInterval(captchaCountdownTimer); captchaCountdownTimer = null; }
}

// ── Conditions ──────────────────────────────────────────────

function setupConditionControls() {
  $('#btn-add-condition').addEventListener('click', async () => {
    const type = $('#cond-type').value;
    const asin = $('#cond-asin').value.trim().toUpperCase() || null;
    const value = parseFloat($('#cond-value').value);
    const cooldownMin = parseInt($('#cond-cooldown').value, 10) || 60;
    if (isNaN(value)) return;

    await window.api.invoke('addCondition', {
      condition: { asin, ruleType: type, params: { value }, cooldownSec: cooldownMin * 60 },
    });
    $('#cond-value').value = '';
    $('#cond-asin').value = '';
    await loadConditions();
  });
}

async function loadConditions() {
  const conditions = await window.api.invoke('getConditions');
  const container = $('#condition-list');
  if (!Array.isArray(conditions) || conditions.length === 0) {
    container.innerHTML = '<div class="empty-message">No conditions set</div>';
    return;
  }
  const typeLabels = {
    moving_avg_below_pct: (p) => `Price < 10-day MA by ${p.value}%`,
    absolute_price_below: (p) => `Price < ¥${p.value?.toLocaleString()}`,
    offer_count_drop_pct: (p) => `MP count drops > ${p.value}%`,
    marketplace_below:    (p) => `MP price < ¥${p.value?.toLocaleString()}`,
  };
  container.innerHTML = conditions.map((c) => {
    const params = typeof c.rule_params === 'string' ? JSON.parse(c.rule_params) : c.rule_params;
    const label = typeLabels[c.rule_type]?.(params) || c.rule_type;
    return `<div class="cond-item">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><div class="cond-desc">${label}</div><div class="cond-asin">${c.asin || 'All'}</div></div>
        <button class="btn btn-danger btn-sm" data-del-cond="${c.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-del-cond]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.api.invoke('deleteCondition', { id: parseInt(btn.dataset.delCond, 10) });
      await loadConditions();
    });
  });
}

// ── Discord ─────────────────────────────────────────────────

function setupDiscordControls() {
  $('#btn-save-discord').addEventListener('click', async () => {
    const url = $('#discord-url').value.trim();
    if (!url) return;
    await window.api.invoke('setDiscordWebhook', { url });
    showDiscordStatus('Webhook saved', 'success');
  });
  $('#btn-test-discord').addEventListener('click', async () => {
    const url = $('#discord-url').value.trim();
    if (!url) return;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Amazon 価格モニター', content: '✅ テスト通知' }),
      });
      showDiscordStatus(resp.ok ? 'Test sent!' : `Error: ${resp.status}`, resp.ok ? 'success' : 'error');
    } catch (err) {
      showDiscordStatus(`Error: ${err.message}`, 'error');
    }
  });
}

async function loadDiscord() {
  const result = await window.api.invoke('getDiscordWebhook');
  if (result?.url) $('#discord-url').value = result.url;
}

function showDiscordStatus(msg, type) {
  const el = $('#discord-status');
  el.textContent = msg;
  el.className = type;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── Notifications ───────────────────────────────────────────

async function loadNotifications() {
  const notifs = await window.api.invoke('getNotifications');
  const container = $('#notification-list');
  if (!Array.isArray(notifs) || notifs.length === 0) {
    container.innerHTML = '<div class="empty-message">No notifications yet</div>';
    return;
  }
  container.innerHTML = notifs.map((n) => `
    <div class="notif-item">
      <div class="notif-time">${new Date(n.sent_at).toLocaleString('ja-JP')}</div>
      <div class="notif-asin">${n.asin}</div>
      <div class="notif-detail">Condition #${n.condition_id}${n.discord_sent ? ' (Discord sent)' : ''}</div>
    </div>
  `).join('');
}
