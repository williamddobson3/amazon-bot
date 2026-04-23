const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'background', ...msg }, resolve);
  });
}

// ── Init ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const status = await refreshStatus();

  // Show whatever IndexedDB currently has so the panel renders instantly
  // and the user isn't staring at a blank list for a second or two.
  await loadAsins();
  await loadConditions();
  await loadDiscord();
  await loadNotifications();
  setupTabs();
  setupAuth();
  setupAsinControls();
  setupConditionControls();
  setupDiscordControls();
  setupBatchProgress();
  setupCaptchaBanner();

  // If we woke up already authenticated (persistent JWT from a prior
  // session), reconcile IndexedDB against the backend's authoritative
  // watchlist. This is the recovery path for the "logged out then back
  // in and everything is gone" symptom — IndexedDB may have been wiped
  // by Chrome (quota / reinstall / profile change) while the session
  // was idle. We fire it in the background and refresh the list when
  // the reconcile completes, so the initial render isn't blocked.
  if (status?.authToken) {
    sendBg({ action: 'reconcileWatchlist' })
      .then((r) => {
        if (r?.ok) {
          loadAsins();
        } else if (r?.error) {
          console.warn('[reconcile] failed:', r.error);
        }
      })
      .catch((err) => console.warn('[reconcile] threw:', err));
  }

  // Low-frequency health check for the status indicator only. The ASIN
  // list no longer polls — rows stream in via chrome.runtime.onMessage
  // forwarded from the background WebSocket handler.
  setInterval(() => { refreshStatus(); }, 5000);

  // Resume batch progress across side-panel close/open and SW restarts.
  const active = await sendBg({ action: 'getActiveBatch' });
  if (active?.batchId) startBatchProgress(active.batchId);

  // Rehydrate the CAPTCHA banner if a pause is already active (SW
  // restart, panel reopened mid-pause, etc.).
  const pauseState = await sendBg({ action: 'getClientPauseState' });
  if (pauseState?.pausedUntil && pauseState.pausedUntil > Date.now()) {
    showCaptchaBanner(pauseState);
  }

  // Re-render visible rows on window resize so the virtual window stays
  // in sync with the new viewport height.
  window.addEventListener('resize', () => renderVisible());
});

// Background forwards structured per-row updates here. The popup is
// stateless — it just maps each message to a tiny in-memory + DOM edit.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'popup') return;
  switch (msg.action) {
    case 'popup:priceUpdate':
      handleIncomingPriceUpdate(msg.asin, msg.data, msg.error, msg.updatedAt);
      break;
    case 'popup:batchProgress':
      applyBatchProgress({
        batchId: msg.batchId,
        total: msg.total,
        completed: msg.completed,
        failed: msg.failed,
        status: msg.status,
      });
      break;
    case 'popup:batchComplete':
      onBatchComplete(msg);
      break;
    case 'popup:clientPause':
      showCaptchaBanner({
        pausedUntil: msg.pausedUntil,
        captchaUrl:  msg.captchaUrl,
        reason:      msg.reason,
        source:      msg.source,
      });
      break;
    case 'popup:clientResume':
      hideCaptchaBanner();
      break;
    case 'popup:refresh':
      loadAsins();
      loadNotifications();
      break;
  }
});

// ── Tabs ───────────────────────────────────────────────────

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

// ── Status ─────────────────────────────────────────────────

async function refreshStatus() {
  const status = await sendBg({ action: 'getStatus' });
  if (!status) return null;

  const dot   = $('#status-indicator');
  const text  = $('#status-text');
  const count = $('#asin-count');

  if (status.wsConnected) {
    dot.className   = 'status-dot online';
    text.textContent = `Connected · ${status.activeJobs} job${status.activeJobs !== 1 ? 's' : ''}`;
  } else {
    dot.className   = 'status-dot offline';
    text.textContent = 'Disconnected';
  }
  count.textContent = `${status.asinCount} ASINs`;

  if (!status.authToken) {
    $('#auth-view').classList.remove('hidden');
    $('#app-view').classList.add('hidden');
  } else {
    $('#auth-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    if (!document.querySelector('.tab-content.active')) {
      $('#tab-asins').classList.add('active');
    }
  }
  return status;
}

// ── Auth ───────────────────────────────────────────────────

function setupAuth() {
  // ── Tab switching ──────────────────────────────────────
  $('#auth-tab-login').addEventListener('click', () => switchAuthTab('login'));
  $('#auth-tab-register').addEventListener('click', () => switchAuthTab('register'));

  function switchAuthTab(tab) {
    const isLogin = tab === 'login';
    $('#auth-tab-login').classList.toggle('active', isLogin);
    $('#auth-tab-register').classList.toggle('active', !isLogin);
    $('#login-form').classList.toggle('hidden', !isLogin);
    $('#register-form').classList.toggle('hidden', isLogin);
    // Re-trigger form-in animation
    const form = isLogin ? $('#login-form') : $('#register-form');
    form.style.animation = 'none';
    requestAnimationFrame(() => { form.style.animation = ''; });
  }

  // ── Floating label: sync has-value class so label reliably floats ─
  document.querySelectorAll('#auth-view .field-wrap input').forEach((input) => {
    const sync = () => input.classList.toggle('has-value', input.value !== '');
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync(); // set initial state (e.g. browser autofill)
  });

  // ── Password show/hide toggles ─────────────────────────
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(`#${btn.dataset.for}`);
      const isText = input.type === 'text';
      input.type = isText ? 'password' : 'text';
      btn.querySelector('.eye-open').classList.toggle('hidden', !isText);
      btn.querySelector('.eye-closed').classList.toggle('hidden', isText);
    });
  });

  // ── Password strength meter ────────────────────────────
  $('#reg-password').addEventListener('input', () => {
    const pw = $('#reg-password').value;
    const { score, label, color } = getStrength(pw);
    const fill  = $('#pw-strength-fill');
    const lbl   = $('#pw-strength-label');
    fill.style.width = `${score * 25}%`;
    fill.className   = `pw-strength-fill strength-${score}`;
    lbl.textContent  = label;
    lbl.style.color  = color;
  });

  function getStrength(pw) {
    if (!pw) return { score: 0, label: 'Enter a password', color: 'var(--text3)' };
    let s = 0;
    if (pw.length >= 6)  s++;
    if (pw.length >= 10) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    const levels = [
      { score: 1, label: 'Too weak',  color: '#f87171' },
      { score: 2, label: 'Fair',      color: '#fb923c' },
      { score: 3, label: 'Good',      color: '#facc15' },
      { score: 4, label: 'Strong  ✓', color: '#4ade80' },
    ];
    return levels[Math.max(0, Math.min(s, 4)) - 1] || { score: 1, label: 'Too weak', color: '#f87171' };
  }

  // ── Inline validation helpers ──────────────────────────
  function fieldOk(input, errEl) {
    input.classList.remove('is-error'); input.classList.add('is-ok');
    errEl.textContent = '';
  }
  function fieldErr(input, errEl, msg) {
    input.classList.remove('is-ok'); input.classList.add('is-error');
    errEl.textContent = msg;
  }
  function clearField(input, errEl) {
    input.classList.remove('is-ok', 'is-error');
    errEl.textContent = '';
  }

  function validateEmail(val, input, errEl) {
    if (!val) { fieldErr(input, errEl, 'Email is required'); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { fieldErr(input, errEl, 'Enter a valid email address'); return false; }
    fieldOk(input, errEl); return true;
  }
  function validatePassword(val, input, errEl) {
    if (!val)        { fieldErr(input, errEl, 'Password is required'); return false; }
    if (val.length < 6) { fieldErr(input, errEl, 'At least 6 characters'); return false; }
    fieldOk(input, errEl); return true;
  }

  // Blur-time validation
  $('#login-email').addEventListener('blur', () => {
    const v = $('#login-email').value.trim();
    if (v) validateEmail(v, $('#login-email'), $('#login-email-err'));
  });
  $('#login-email').addEventListener('input', () => {
    if ($('#login-email').classList.contains('is-error'))
      validateEmail($('#login-email').value.trim(), $('#login-email'), $('#login-email-err'));
  });
  $('#reg-email').addEventListener('blur', () => {
    const v = $('#reg-email').value.trim();
    if (v) validateEmail(v, $('#reg-email'), $('#reg-email-err'));
  });
  $('#reg-password').addEventListener('blur', () => {
    const v = $('#reg-password').value;
    if (v) validatePassword(v, $('#reg-password'), $('#reg-password-err'));
  });
  $('#reg-confirm').addEventListener('blur', () => {
    const pw = $('#reg-password').value;
    const cf = $('#reg-confirm').value;
    if (cf && cf !== pw) fieldErr($('#reg-confirm'), $('#reg-confirm-err'), 'Passwords do not match');
    else if (cf) fieldOk($('#reg-confirm'), $('#reg-confirm-err'));
  });

  // ── Login submit ───────────────────────────────────────
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = $('#login-email').value.trim();
    const password = $('#login-password').value;
    const errEl    = $('#login-error');

    let valid = true;
    if (!validateEmail(email, $('#login-email'), $('#login-email-err'))) valid = false;
    if (!validatePassword(password, $('#login-password'), $('#login-password-err'))) valid = false;
    if (!valid) return;

    errEl.classList.add('hidden');
    setAuthBtnState('#btn-sign-in', 'loading');

    const result = await sendBg({ action: 'login', email, password });

    if (result?.token) {
      setAuthBtnState('#btn-sign-in', 'success');
      clearField($('#login-email'), $('#login-email-err'));
      clearField($('#login-password'), $('#login-password-err'));
      setTimeout(async () => { await reloadAll(); }, 600);
    } else {
      setAuthBtnState('#btn-sign-in', 'idle');
      const msg = result?.error || 'Incorrect email or password';
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      // Re-trigger shake
      errEl.style.animation = 'none';
      requestAnimationFrame(() => { errEl.style.animation = ''; });
      $('#login-password').value = '';
      $('#login-password').focus();
    }
  });

  // ── Register submit ────────────────────────────────────
  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = $('#reg-email').value.trim();
    const password = $('#reg-password').value;
    const confirm  = $('#reg-confirm').value;
    const errEl    = $('#register-error');

    let valid = true;
    if (!validateEmail(email, $('#reg-email'), $('#reg-email-err'))) valid = false;
    if (!validatePassword(password, $('#reg-password'), $('#reg-password-err'))) valid = false;
    if (confirm !== password) {
      fieldErr($('#reg-confirm'), $('#reg-confirm-err'), 'Passwords do not match');
      valid = false;
    } else if (confirm) {
      fieldOk($('#reg-confirm'), $('#reg-confirm-err'));
    }
    if (!valid) return;

    errEl.classList.add('hidden');
    setAuthBtnState('#btn-create-account', 'loading');

    const regResult = await sendBg({ action: 'register', email, password });

    if (regResult?.ok) {
      const loginResult = await sendBg({ action: 'login', email, password });
      if (loginResult?.token) {
        setAuthBtnState('#btn-create-account', 'success');
        setTimeout(async () => { await reloadAll(); }, 600);
        return;
      }
    }

    setAuthBtnState('#btn-create-account', 'idle');
    const msg = regResult?.error || 'Registration failed. Please try again.';
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    errEl.style.animation = 'none';
    requestAnimationFrame(() => { errEl.style.animation = ''; });
  });

  // ── Button state machine: idle / loading / success ─────
  function setAuthBtnState(selector, state) {
    const btn     = $(selector);
    const label   = btn.querySelector('.btn-label');
    const spinner = btn.querySelector('.btn-spinner');
    const check   = btn.querySelector('.btn-check');

    btn.disabled = state !== 'idle';
    label.classList.toggle('hidden',  state !== 'idle');
    spinner.classList.toggle('hidden', state !== 'loading');
    check.classList.toggle('hidden',  state !== 'success');

    if (state === 'success') {
      btn.style.background = 'linear-gradient(135deg, #4ade80, #16a34a)';
    } else {
      btn.style.background = '';
    }
  }

  // ── Logout ─────────────────────────────────────────────────
  $('#btn-logout').addEventListener('click', async () => {
    const btn = $('#btn-logout');
    btn.disabled = true;
    await sendBg({ action: 'logout' });
    btn.disabled = false;
    await refreshStatus();
  });
}

async function reloadAll() {
  await refreshStatus();
  await loadAsins();
  await loadConditions();
  await loadDiscord();
  await loadNotifications();
}

// ── ASIN Management ────────────────────────────────────────
//
// The ASIN tab is a streaming, virtualised live view over IndexedDB.
// Rules of the road:
//
//  - `allAsins` is the single source of truth, sorted by addedAt ASC
//    so incoming scrape results never reorder the list while streaming.
//  - `asinIndex` maps asin → index for O(1) in-place updates.
//  - `visibleCards` holds ONLY the DOM nodes currently in the scroll
//    viewport. A 2000-row list has ~20-30 live nodes at any time.
//  - Incoming PRICE_UPDATE events update `allAsins[i]` immediately and
//    add the asin to `dirtyAsins`. A single requestAnimationFrame flush
//    then updates each visible dirty row's fields in place (no innerHTML
//    rebuild) and triggers the `.just-updated` highlight.

const ROW_HEIGHT = 220;
const SCROLL_BUFFER_ROWS = 4;

let allAsins = [];
let filtered = [];
let asinIndex = new Map();           // asin → index in allAsins
const visibleCards = new Map();      // asin → HTMLElement
const dirtyAsins = new Set();
let flushScheduled = false;
let currentSearch = '';

function setupAsinControls() {
  $('#btn-add-asins').addEventListener('click', onAddAsinsClick);
  $('#csv-import').addEventListener('change', onCsvImport);
  $('#asin-search').addEventListener('input', onSearchInput);

  // Event delegation on the list container so virtualised rows don't
  // have to re-bind listeners as they enter / leave the viewport.
  const container = $('#asin-list');
  container.addEventListener('click', onListClick);
  container.addEventListener('scroll', onListScroll, { passive: true });

  // When the container changes size — tab switches, login transition,
  // side-panel resize — re-compute the virtual window so rows that were
  // off-screen at initial render become visible now.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => renderVisible());
    ro.observe(container);
  }
}

// ── Status/error line below the Add form ──────────────────
//
// Visible feedback for the bulk-add flow. `type` is 'info' | 'success'
// | 'error'. Auto-clears after 6 s unless `sticky` is true (used for
// errors so they stay until the next action).
function showAsinStatus(text, type = 'info', sticky = false) {
  const el = $('#asin-status');
  if (!el) return;
  el.textContent = text;
  el.className = `asin-status ${type}`;
  el.classList.remove('hidden');
  if (_asinStatusTimer) clearTimeout(_asinStatusTimer);
  if (!sticky) {
    _asinStatusTimer = setTimeout(() => {
      el.classList.add('hidden');
      el.textContent = '';
    }, 6000);
  }
}
let _asinStatusTimer = null;

async function onAddAsinsClick() {
  const raw = $('#asin-input').value;
  const asins = raw.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (asins.length === 0) return;

  const btn = $('#btn-add-asins');
  btn.disabled = true;
  showAsinStatus(`Submitting ${asins.length} ASIN${asins.length !== 1 ? 's' : ''}…`, 'info');
  try {
    const result = await sendBg({ action: 'addAsins', asins });
    await handleAddAsinsResult(result, asins.length);
  } finally {
    btn.disabled = false;
  }
}

async function onCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const asins = text.split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9]{10}$/.test(s));
  if (asins.length === 0) {
    showAsinStatus('CSV contained no valid ASINs', 'error', true);
    e.target.value = '';
    return;
  }

  showAsinStatus(`Importing ${asins.length} ASINs…`, 'info');
  const result = await sendBg({ action: 'addAsins', asins });
  await handleAddAsinsResult(result, asins.length);
  e.target.value = '';
}

// Shared post-submit handler — translates the background's addAsins
// result into visible feedback, then refreshes the list and starts the
// batch-progress strip if a batch was actually created.
async function handleAddAsinsResult(result, requested) {
  if (!result || result.error) {
    const err = result?.error || 'UNKNOWN_ERROR';
    const human = {
      NOT_AUTHENTICATED:      'Sign in first, then try again.',
      NO_VALID_ASINS:         'None of the entries are valid ASINs (need 10 chars).',
      FETCH_FAILED:           'Cannot reach the backend. Is it running?',
      STALE_SESSION:          'Your account no longer exists on the server. Signing you out — please sign in again.',
      BULK_ADD_FAILED:        result?.message || 'Backend failed to process the bulk request.',
      'HTTP 404':             'Backend is outdated — restart it so the bulk endpoint loads.',
      'HTTP 413':             'Too many ASINs in one request (max 5000).',
      'HTTP 500':             'Backend error. Check the server logs.',
      'HTTP 401':             'Session expired — sign out and back in.',
    };
    showAsinStatus(`Failed: ${human[err] || err}`, 'error', true);
    console.warn('addAsins error:', result);

    // If the backend cleared our token (stale session), the popup needs
    // to flip back to the auth view. refreshStatus reads the new
    // authToken=null state and toggles visibility.
    if (err === 'STALE_SESSION') {
      await refreshStatus();
    }
    return; // keep the input intact so the user can retry without re-pasting
  }

  // Success — clear the input and reload the list.
  $('#asin-input').value = '';
  await loadAsins();
  await refreshStatus();

  const accepted = result.accepted ?? 0;
  const duplicates = result.duplicates ?? 0;
  const invalid = result.invalid ?? 0;
  const parts = [`${accepted} added`];
  if (duplicates > 0) parts.push(`${duplicates} already watched`);
  if (invalid > 0) parts.push(`${invalid} invalid`);
  showAsinStatus(parts.join(' · '), accepted > 0 ? 'success' : 'info');

  if (result.batchId && result.total > 0) {
    startBatchProgress(result.batchId);
  }
}

function onSearchInput() {
  currentSearch = $('#asin-search').value.toLowerCase();
  applyFilter();
  $('#asin-list').scrollTop = 0;
  renderVisible();
}

async function loadAsins() {
  const result = await sendBg({ action: 'getAsins' });
  // CRITICAL: distinguish "legitimately empty" from "transient error".
  // A falsy / error-shaped result must NOT wipe the existing in-memory
  // state — that was the data-loss hazard where a single SW-timing blip
  // during login blanked the whole UI. Only a real array replaces state.
  if (!Array.isArray(result)) {
    console.warn('[loadAsins] non-array result, keeping existing state:', result);
    return;
  }
  allAsins = result;
  // Stable sort by addedAt ASC. A row's position never moves once it's
  // in the list — only its contents change as data streams in.
  allAsins.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  asinIndex = new Map();
  for (let i = 0; i < allAsins.length; i++) {
    asinIndex.set(allAsins[i].asin, i);
  }
  applyFilter();
  renderVisible();
}

function applyFilter() {
  if (!currentSearch) {
    filtered = allAsins;
  } else {
    filtered = allAsins.filter(
      (a) => a.asin.toLowerCase().includes(currentSearch) ||
             (a.title || '').toLowerCase().includes(currentSearch)
    );
  }
  $('#asin-list-count').textContent = `${filtered.length} items`;

  const sizer = $('#asin-list-sizer');
  if (filtered.length === 0) {
    sizer.style.height = '0px';
    for (const [, el] of visibleCards) el.remove();
    visibleCards.clear();
    if (!sizer.querySelector('.empty-message')) {
      sizer.innerHTML = '<div class="empty-message">No ASINs added yet</div>';
    }
    return;
  }
  const em = sizer.querySelector('.empty-message');
  if (em) em.remove();
  sizer.style.height = `${filtered.length * ROW_HEIGHT}px`;

  // Filter changed — any visible card whose asin is no longer in the
  // filtered view should be torn down. The renderVisible() call after
  // this will recreate whatever needs to exist now.
  const visibleAsinSet = new Set(filtered.map((r) => r.asin));
  for (const [asin, card] of visibleCards) {
    if (!visibleAsinSet.has(asin)) {
      card.remove();
      visibleCards.delete(asin);
    }
  }
}

function renderVisible() {
  const container = $('#asin-list');
  const sizer = $('#asin-list-sizer');
  if (filtered.length === 0) return;

  const viewportH = container.clientHeight;
  const scrollTop = container.scrollTop;

  let startIdx = Math.floor(scrollTop / ROW_HEIGHT) - SCROLL_BUFFER_ROWS;
  let endIdx = Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + SCROLL_BUFFER_ROWS;
  startIdx = Math.max(0, startIdx);
  endIdx = Math.min(filtered.length - 1, endIdx);

  const shouldExist = new Set();
  for (let i = startIdx; i <= endIdx; i++) {
    const row = filtered[i];
    shouldExist.add(row.asin);

    let card = visibleCards.get(row.asin);
    if (!card) {
      card = createCardElement(row);
      sizer.appendChild(card);
      visibleCards.set(row.asin, card);
    }
    card.style.top = `${i * ROW_HEIGHT}px`;
    // Refresh contents in case data changed while the card was off-screen.
    updateCardInPlace(card, row);
  }

  for (const [asin, card] of visibleCards) {
    if (!shouldExist.has(asin)) {
      card.remove();
      visibleCards.delete(asin);
    }
  }
}

function onListScroll() {
  // ~30 visible cards per frame, well under the 8ms budget. If this ever
  // shows up in a profile, rAF-batch it the same way flushDirty does.
  renderVisible();
}

function onListClick(e) {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) { handleRemoveAsin(removeBtn.dataset.remove); return; }
  const chartBtn = e.target.closest('[data-chart]');
  if (chartBtn) { openChartModal(chartBtn.dataset.chart); return; }
  const refreshBtn = e.target.closest('[data-refresh]');
  if (refreshBtn) { handleRefreshAsin(refreshBtn); return; }
}

async function handleRemoveAsin(asin) {
  await sendBg({ action: 'removeAsin', asin });

  // Local splice — no need to round-trip getAllAsins just to remove one row.
  const idx = asinIndex.get(asin);
  if (idx != null) {
    allAsins.splice(idx, 1);
    asinIndex = new Map();
    for (let i = 0; i < allAsins.length; i++) {
      asinIndex.set(allAsins[i].asin, i);
    }
  }
  const card = visibleCards.get(asin);
  if (card) { card.remove(); visibleCards.delete(asin); }
  applyFilter();
  renderVisible();
  await refreshStatus();
}

async function handleRefreshAsin(btn) {
  const asin = btn.dataset.refresh;
  btn.disabled = true;
  btn.textContent = '…';
  await sendBg({ action: 'refreshAsin', asin });
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '↻';
  }, 1500);
}

// ── Live row-update pipeline ───────────────────────────────

function handleIncomingPriceUpdate(asin, data, error, updatedAt) {
  const idx = asinIndex.get(asin);
  if (idx == null) {
    // Row we don't know about yet — pull the whole list once so the new
    // row materialises. This is rare (only happens if IndexedDB was
    // written but loadAsins hasn't run since).
    loadAsins();
    return;
  }
  const row = allAsins[idx];
  if (error) {
    row.lastError = error;
    row.lastErrorAt = updatedAt;
  } else if (data) {
    if (data.title) row.title = data.title;
    row.lastPrice = data.price ?? null;
    row.lastPoints = data.points ?? null;
    row.lastDeliveryTime = data.deliveryTime ?? null;
    row.lastMarketplaceLowest = data.marketplaceLowest ?? null;
    row.lastNewOfferCount = data.newOfferCount ?? null;
    row.lastObservedAt = updatedAt;
    row.lastError = null;
    row.lastErrorAt = null;
  }
  dirtyAsins.add(asin);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushDirty);
}

function flushDirty() {
  flushScheduled = false;
  for (const asin of dirtyAsins) {
    const idx = asinIndex.get(asin);
    if (idx == null) continue;
    const row = allAsins[idx];
    const card = visibleCards.get(asin);
    if (!card) continue; // off-screen — DOM will catch up on next scroll
    updateCardInPlace(card, row);
    card.classList.remove('just-updated');
    // Force reflow so re-adding the class restarts the animation.
    void card.offsetWidth;
    card.classList.add('just-updated');
  }
  dirtyAsins.clear();
}

// ── Card element builders (no innerHTML beyond the static grid) ──

function createCardElement(row) {
  const card = document.createElement('div');
  card.className = 'asin-card virtual';
  card.dataset.asin = row.asin;

  const head = document.createElement('div');
  head.className = 'asin-card-head';

  const link = document.createElement('a');
  link.className = 'asin-code-link';
  link.href = `https://www.amazon.co.jp/dp/${row.asin}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = row.asin;
  head.appendChild(link);

  const actions = document.createElement('div');
  actions.className = 'asin-card-head-actions';

  const chartBtn = document.createElement('button');
  chartBtn.className = 'btn btn-secondary btn-sm';
  chartBtn.dataset.chart = row.asin;
  chartBtn.title = '価格履歴グラフ';
  chartBtn.textContent = '📈';
  actions.appendChild(chartBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn btn-secondary btn-sm';
  refreshBtn.dataset.refresh = row.asin;
  refreshBtn.title = 'Refresh Now';
  refreshBtn.textContent = '↻';
  actions.appendChild(refreshBtn);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-danger btn-sm';
  removeBtn.dataset.remove = row.asin;
  removeBtn.textContent = 'Remove';
  actions.appendChild(removeBtn);

  head.appendChild(actions);
  card.appendChild(head);

  const titleEl = document.createElement('div');
  titleEl.className = 'asin-card-title';
  titleEl.dataset.f = 'title';
  card.appendChild(titleEl);

  const errorEl = document.createElement('div');
  errorEl.className = 'asin-card-error hidden';
  errorEl.dataset.f = 'error';
  card.appendChild(errorEl);

  const grid = document.createElement('div');
  grid.className = 'asin-card-grid';
  grid.innerHTML = `
    <div class="field">
      <div class="field-label">② Price</div>
      <div class="field-value field-price" data-f="price">---</div>
    </div>
    <div class="field">
      <div class="field-label">③ Points</div>
      <div class="field-value" data-f="points">---</div>
    </div>
    <div class="field field-wide">
      <div class="field-label">④ Delivery</div>
      <div class="field-value" data-f="delivery">---</div>
    </div>
    <div class="field">
      <div class="field-label">⑥ Other Sellers Price</div>
      <div class="field-value" data-f="mpPrice">---</div>
    </div>
    <div class="field">
      <div class="field-label">⑦ Other Sellers Count</div>
      <div class="field-value" data-f="mpCount">---</div>
    </div>
  `;
  card.appendChild(grid);

  const foot = document.createElement('div');
  foot.className = 'asin-card-foot';
  foot.dataset.f = 'foot';
  card.appendChild(foot);

  updateCardInPlace(card, row);
  return card;
}

function updateCardInPlace(card, row) {
  const hasData = row.lastObservedAt != null;
  const pending = !hasData && !row.lastError;
  card.classList.toggle('skeleton', pending);
  card.classList.toggle('asin-card-pending', !hasData);

  const set = (name, val) => {
    const el = card.querySelector(`[data-f="${name}"]`);
    if (el && el.textContent !== val) el.textContent = val;
  };

  set('title', row.title || '(Product name not fetched yet)');

  const errorEl = card.querySelector('[data-f="error"]');
  if (row.lastError) {
    const suffix = row.lastErrorAt
      ? ` (at ${new Date(row.lastErrorAt).toLocaleTimeString('ja-JP')})`
      : '';
    const next = `⚠ ${row.lastError}${suffix}`;
    if (errorEl.textContent !== next) errorEl.textContent = next;
    errorEl.classList.remove('hidden');
  } else {
    if (errorEl.textContent !== '') errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  set('price',    row.lastPrice              != null ? '¥' + Number(row.lastPrice).toLocaleString()              : '---');
  set('points',   row.lastPoints             != null ? `${row.lastPoints} pt`                                    : '---');
  set('delivery', formatDelivery(row.lastDeliveryTime));
  set('mpPrice',  row.lastMarketplaceLowest  != null ? '¥' + Number(row.lastMarketplaceLowest).toLocaleString()  : '---');
  set('mpCount',  row.lastNewOfferCount      != null ? `${row.lastNewOfferCount} 点`                             : '---');

  const updatedStr = row.lastObservedAt
    ? new Date(row.lastObservedAt).toLocaleString('ja-JP')
    : (row.lastError ? 'Scrape failed' : 'Waiting for first scrape…');
  set('foot', `Updated: ${updatedStr}`);
}

function formatDelivery(dt) {
  if (!dt) return '---';
  if (typeof dt === 'string') return dt;
  if (typeof dt === 'object') {
    const parts = [];
    if (dt.time) parts.push(dt.time);
    if (dt.cutoff) parts.push(`(${dt.cutoff})`);
    return parts.join(' ') || '---';
  }
  return String(dt);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Bulk batch progress strip ──────────────────────────────
//
// The strip lives above the ASIN list header and shows X/Y completed,
// a progress bar, ETA, and a cancel button. It is driven by two inputs:
//   1. WS-forwarded BATCH_PROGRESS events (instant, live)
//   2. A 3 s polling fallback on /api/watchlist/bulk/:batchId (so the
//      strip stays accurate if WS was briefly dropped).
// On BATCH_COMPLETE it shows 100% for 1.5 s and then self-hides.

let batchPollTimer = null;
let currentBatchId = null;

function setupBatchProgress() {
  $('#batch-progress-cancel').addEventListener('click', async () => {
    if (!currentBatchId) return;
    await sendBg({ action: 'cancelBatch', batchId: currentBatchId });
    stopBatchProgress();
  });
}

function startBatchProgress(batchId) {
  currentBatchId = batchId;
  $('#batch-progress').classList.remove('hidden');
  pollBatchOnce();
  if (batchPollTimer) clearInterval(batchPollTimer);
  batchPollTimer = setInterval(pollBatchOnce, 3000);
}

async function pollBatchOnce() {
  if (!currentBatchId) return;
  const result = await sendBg({ action: 'getBatchProgress', batchId: currentBatchId });
  if (result?.error === 'NOT_FOUND') { stopBatchProgress(); return; }
  if (!result || result.error) return;
  applyBatchProgress(result);
  if (result.status !== 'running') {
    await loadAsins();
    stopBatchProgress();
  }
}

function applyBatchProgress(p) {
  if (!p || !p.batchId) return;
  if (currentBatchId && p.batchId !== currentBatchId) return;
  if (!currentBatchId) { currentBatchId = p.batchId; $('#batch-progress').classList.remove('hidden'); }

  const done = (p.completed || 0) + (p.failed || 0);
  const total = p.total || 0;
  $('#batch-progress-counts').textContent = `${done} / ${total}`;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  $('#batch-progress-fill').style.width = `${pct.toFixed(1)}%`;

  const eta = p.etaSec;
  const etaEl = $('#batch-progress-eta');
  if (eta != null && p.status === 'running' && total > done) {
    etaEl.textContent = `ETA ${formatDuration(eta)}`;
  } else {
    etaEl.textContent = '';
  }
}

function onBatchComplete(msg) {
  if (currentBatchId && msg.batchId !== currentBatchId) return;
  applyBatchProgress({
    batchId: msg.batchId,
    total: msg.total,
    completed: msg.completed,
    failed: msg.failed,
    status: 'done',
    etaSec: 0,
  });
  // Show 100% briefly, then self-hide and refresh the list once more to
  // catch any late rows.
  setTimeout(() => { stopBatchProgress(); loadAsins(); }, 1500);
}

function stopBatchProgress() {
  if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = null; }
  $('#batch-progress').classList.add('hidden');
  currentBatchId = null;
  sendBg({ action: 'clearActiveBatch' });
}

function formatDuration(totalSec) {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

// ── CAPTCHA / session-pause banner ─────────────────────────
//
// Shown when the background worker tells us offscreen hit a CAPTCHA,
// 429, dog page, or login wall. Two buttons:
//   - "Solve now" opens the CAPTCHA URL in a new Chrome tab, where
//     the user solves it with their normal browser session.
//   - "Skip pause" asks background to run a recovery probe and lift
//     the pause if the session is actually clean (e.g. the user
//     already solved the CAPTCHA in another tab).

let captchaCountdownTimer = null;
let captchaPausedUntil    = 0;

function setupCaptchaBanner() {
  $('#captcha-solve-btn').addEventListener('click', async () => {
    await sendBg({ action: 'solveCaptcha' });
  });
  $('#captcha-skip-btn').addEventListener('click', async () => {
    await sendBg({ action: 'skipClientPause' });
    // Don't hide the banner here — wait for the popup:clientResume
    // message that background will send IF the recovery probe confirms
    // the session is clean. If it doesn't, the banner stays and the
    // user gets honest feedback that the pause is still active.
  });
}

function showCaptchaBanner({ pausedUntil, captchaUrl, reason, source }) {
  captchaPausedUntil = pausedUntil || 0;
  const banner = $('#captcha-banner');

  // Source-aware title so the user understands WHAT triggered the block.
  const titles = {
    amazon:  'Amazon verification required',
    google:  'Google bot detection triggered',
    network: 'Network verification required',
  };
  const titleEl = banner.querySelector('.captcha-banner-title');
  if (titleEl) titleEl.textContent = titles[source] || titles.amazon;
  $('#captcha-banner-reason').textContent = reason || 'CAPTCHA';

  banner.classList.remove('hidden');
  updateCaptchaCountdown();
  if (captchaCountdownTimer) clearInterval(captchaCountdownTimer);
  captchaCountdownTimer = setInterval(updateCaptchaCountdown, 1000);
}

function updateCaptchaCountdown() {
  const remainingMs = captchaPausedUntil - Date.now();
  const el = $('#captcha-banner-countdown');
  if (remainingMs <= 0) {
    // Pause expired on the clock — hide locally. Background will also
    // lift the pause (via its own clock or probe); if it doesn't we'll
    // see CLIENT_PAUSE re-fire and re-show.
    el.textContent = '0:00';
    hideCaptchaBanner();
    return;
  }
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  el.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function hideCaptchaBanner() {
  $('#captcha-banner').classList.add('hidden');
  if (captchaCountdownTimer) {
    clearInterval(captchaCountdownTimer);
    captchaCountdownTimer = null;
  }
  captchaPausedUntil = 0;
}

// ── Conditions ─────────────────────────────────────────────

function setupConditionControls() {
  $('#btn-add-condition').addEventListener('click', async () => {
    const type = $('#cond-type').value;
    const asin = $('#cond-asin').value.trim().toUpperCase() || null;
    const value = parseFloat($('#cond-value').value);
    const days = parseInt($('#cond-days').value, 10) || 10;
    const cooldownMin = parseInt($('#cond-cooldown').value, 10) || 60;
    const msgEl = $('#cond-msg');

    if (isNaN(value)) {
      showCondMsg('Enter a numeric value', 'error');
      return;
    }

    const condition = {
      asin,
      type,
      params: { value, days },
      enabled: true,
      cooldownSec: cooldownMin * 60,
      lastFiredAt: null,
    };

    const btn = $('#btn-add-condition');
    btn.disabled = true;
    const result = await sendBg({ action: 'addCondition', condition });
    btn.disabled = false;

    if (result?.error) {
      const msgs = {
        NOT_AUTHENTICATED: 'Sign in first to add alerts',
        OFFLINE: 'Cannot reach backend — check connection',
      };
      showCondMsg(msgs[result.error] || result.error, 'error');
      return;
    }

    showCondMsg('Alert added', 'success');
    $('#cond-value').value = '';
    $('#cond-asin').value = '';
    await loadConditions();
  });

  function showCondMsg(text, type) {
    const el = $('#cond-msg');
    el.textContent = text;
    el.className = '';
    el.style.background = type === 'error' ? 'rgba(252,129,129,.1)' : 'rgba(104,211,145,.1)';
    el.style.color = type === 'error' ? 'var(--error)' : 'var(--success)';
    el.style.border = `1px solid ${type === 'error' ? 'rgba(252,129,129,.3)' : 'rgba(104,211,145,.3)'}`;
    setTimeout(() => { el.textContent = ''; el.style.cssText = ''; }, 3000);
  }
}

async function loadConditions() {
  const result = await sendBg({ action: 'getConditions' });
  const conditions = Array.isArray(result) ? result : [];
  const container = $('#condition-list');

  if (conditions.length === 0) {
    container.innerHTML = '<div class="empty-message">No conditions set</div>';
    return;
  }

  const typeLabels = {
    moving_avg_below_pct: (p) => `Price < ${p.days}-day MA by ${p.value}%`,
    absolute_price_below: (p) => `Price < ¥${p.value.toLocaleString()}`,
    offer_count_drop_pct: (p) => `Offer count drops > ${p.value}%`,
    marketplace_below: (p) => `Marketplace price < ¥${p.value.toLocaleString()}`,
  };

  container.innerHTML = conditions
    .map((c) => {
      const label = typeLabels[c.type]?.(c.params) || c.type;
      return `
      <div class="cond-item">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="cond-desc">${label}</div>
            <div class="cond-asin">${c.asin || 'All ASINs'}</div>
            <div class="cond-meta">Cooldown: ${(c.cooldownSec / 60)}min</div>
          </div>
          <button class="btn btn-danger btn-sm" data-del-cond="${c.id}">Delete</button>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('[data-del-cond]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sendBg({ action: 'deleteCondition', id: parseInt(btn.dataset.delCond, 10) });
      await loadConditions();
    });
  });
}

// ── Discord ────────────────────────────────────────────────

function setupDiscordControls() {
  $('#btn-save-discord').addEventListener('click', async () => {
    const url = $('#discord-url').value.trim();
    if (!url) return;
    await sendBg({ action: 'setDiscordWebhook', url });
    showDiscordStatus('Webhook saved', 'success');
  });

  $('#btn-test-discord').addEventListener('click', async () => {
    const url = $('#discord-url').value.trim();
    if (!url) return;

    // Sample values mirror the real notifier output so the user sees exactly
    // what a fired alert will look like.
    const sampleAsin = 'B08N5WRWNW';
    const productUrl = `https://www.amazon.co.jp/dp/${sampleAsin}`;
    const price = 3980;
    const movingAvg = 5480;
    const pctChange = ((price - movingAvg) / movingAvg) * 100;
    const points = 40;
    const marketplaceLowest = 4200;
    const newOfferCount = 18;

    const fmtYen = (v) => `¥${v.toLocaleString('ja-JP')}`;
    const fmtNum = (v) => v.toLocaleString('ja-JP');

    const jstTime = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

    const embed = {
      author: {
        name: '🅰  Amazon 価格モニター  •  テスト送信',
        url: productUrl,
      },
      title: '✅  Webhook 接続テスト',
      url: productUrl,
      description:
        `> 🧪  **これはサンプル通知です**\n` +
        `> 実際のアラートもこの形式でお届けします\n\n` +
        `🔗  [**${sampleAsin}**](${productUrl}) を Amazon.co.jp で開く`,
      color: 0x4ADE80, // 緑 — success/test
      fields: [
        { name: '💴  現在価格',    value: `**${fmtYen(price)}**`,                inline: true },
        { name: '📊  10日平均',    value: fmtYen(movingAvg),                     inline: true },
        { name: '📉  平均との差',  value: `🔻  **${pctChange.toFixed(1)}%**`,    inline: true },
        { name: '⭐  獲得ポイント', value: `**${fmtNum(points)}** pt`,            inline: true },
        { name: '🛒  他の出品者',  value: fmtYen(marketplaceLowest),             inline: true },
        { name: '👥  出品者数',    value: `**${fmtNum(newOfferCount)}** 件`,     inline: true },
      ],
      footer: {
        text: `Amazon 価格モニター  •  ${jstTime} JST`,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Amazon 価格モニター',
          content: '✅  **テスト通知** — Webhook が正常に設定されました',
          embeds: [embed],
        }),
      });
      if (resp.ok || resp.status === 204) {
        showDiscordStatus('テスト通知を送信しました', 'success');
      } else {
        showDiscordStatus(`エラー: HTTP ${resp.status}`, 'error');
      }
    } catch (err) {
      showDiscordStatus(`エラー: ${err.message}`, 'error');
    }
  });
}

async function loadDiscord() {
  const result = await sendBg({ action: 'getDiscordWebhook' });
  if (result?.url) {
    $('#discord-url').value = result.url;
  }
}

function showDiscordStatus(msg, type) {
  const el = $('#discord-status');
  el.textContent = msg;
  el.className = type;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── Notifications ──────────────────────────────────────────

async function loadNotifications() {
  const result = await sendBg({ action: 'getNotifications', limit: 50 });
  const notifs = Array.isArray(result) ? result : [];
  const container = $('#notification-list');

  if (notifs.length === 0) {
    container.innerHTML = '<div class="empty-message">No notifications yet</div>';
    return;
  }

  container.innerHTML = notifs
    .map((n) => {
      const time = new Date(n.sentAt).toLocaleString('ja-JP');
      return `
      <div class="notif-item">
        <div class="notif-time">${time}</div>
        <div class="notif-asin">${n.asin}</div>
        <div class="notif-detail">Condition #${n.conditionId} triggered${n.discordSent ? ' (Discord sent)' : ''}</div>
      </div>`;
    })
    .join('');
}

// ═══════════════════════════════════════════════════════════
// CHART MODAL — price history per ASIN
// ═══════════════════════════════════════════════════════════

const chartState = {
  asin: null,
  period: '1m',
  observations: [],      // deduped, sorted ascending
  yOverride: null,       // { min, max, step } | null
  xOverride: null,       // { from, to, divisions } | null
  spanDays: null,        // total-history day count
};

const DAY_MS = 86400000;
const PERIOD_DAYS = { '1d': 1, '1w': 7, '1m': 30, '3m': 90, '1y': 365, 'all': null };

function openChartModal(asin) {
  chartState.asin = asin;
  chartState.period = '1m';
  chartState.yOverride = null;
  chartState.xOverride = null;
  chartState.observations = [];

  $('#chart-asin').textContent = asin;
  $('#chart-modal').classList.remove('hidden');

  // Reset period tab active state
  $$('#period-tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.period === '1m')
  );

  fetchSpan();
  loadChartData();
}

function closeChartModal() {
  $('#chart-modal').classList.add('hidden');
  $('#y-axis-modal').classList.add('hidden');
  $('#x-axis-modal').classList.add('hidden');
}

async function fetchSpan() {
  const span = await sendBg({ action: 'getObservationSpan', asin: chartState.asin });
  if (span?.firstObservedAt) {
    const days = Math.max(1, Math.ceil((Date.now() - span.firstObservedAt) / DAY_MS));
    chartState.spanDays = days;
    $('#all-days').textContent = days.toLocaleString('ja-JP');
  } else {
    $('#all-days').textContent = '0';
  }
}

function periodToRange(period) {
  const to = Date.now();
  if (period === 'all') {
    return { from: 0, to };
  }
  return { from: to - PERIOD_DAYS[period] * DAY_MS, to };
}

async function loadChartData() {
  const statusEl = $('#chart-status');
  statusEl.textContent = '読み込み中…';
  statusEl.classList.remove('error');

  const { from, to } = periodToRange(chartState.period);
  // Short periods → local IndexedDB (faster, offline-friendly)
  // Long periods → backend MySQL (full history)
  const source = (chartState.period === '1d' || chartState.period === '1w') ? 'local' : 'remote';

  const raw = await sendBg({
    action: 'getObservationsRange',
    asin: chartState.asin,
    from, to, source,
  });

  if (raw?.error) {
    statusEl.textContent = `エラー: ${raw.error}`;
    statusEl.classList.add('error');
    chartState.observations = [];
    renderChart();
    renderTable();
    return;
  }

  const obs = (Array.isArray(raw) ? raw : [])
    .filter((o) => o.price != null)
    .sort((a, b) => a.observedAt - b.observedAt);

  chartState.observations = dedupeFlatMidpoints(obs);

  if (chartState.observations.length === 0) {
    statusEl.textContent = 'この期間のデータがありません';
  } else {
    statusEl.textContent = `${chartState.observations.length} 件のデータ`;
  }

  renderChart();
  renderTable();
}

// Deduplication: drop middle points when prev/curr/next prices are all equal.
// (User's "間引き" requirement — collapses flat runs to just their endpoints.)
function dedupeFlatMidpoints(obs) {
  if (obs.length <= 2) return obs.slice();
  const result = [obs[0]];
  for (let i = 1; i < obs.length - 1; i++) {
    const prev = obs[i - 1].price;
    const curr = obs[i].price;
    const next = obs[i + 1].price;
    if (!(prev === curr && curr === next)) {
      result.push(obs[i]);
    }
  }
  result.push(obs[obs.length - 1]);
  return result;
}

// ── SVG chart rendering ───────────────────────────────────

function niceStep(rawStep) {
  // Round to 1/2/5 × 10^n
  if (rawStep <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  let nice;
  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 7) nice = 5;
  else nice = 10;
  return nice * pow;
}

function computeYAxis() {
  if (chartState.yOverride) return chartState.yOverride;
  const prices = chartState.observations.map((o) => o.price).filter((p) => p != null);
  if (prices.length === 0) return { min: 0, max: 100, step: 20 };

  const dataMin = Math.min(...prices);
  const dataMax = Math.max(...prices);

  if (dataMin === dataMax) {
    const pad = Math.max(100, dataMin * 0.05);
    return {
      min: Math.floor((dataMin - pad) / 100) * 100,
      max: Math.ceil((dataMax + pad) / 100) * 100,
      step: niceStep(pad),
    };
  }

  const range = dataMax - dataMin;
  const padding = range * 0.1;
  const step = niceStep(range / 6);
  const min = Math.floor((dataMin - padding) / step) * step;
  const max = Math.ceil((dataMax + padding) / step) * step;
  return { min, max, step };
}

function computeXAxis() {
  if (chartState.xOverride) {
    return {
      from: chartState.xOverride.from,
      to: chartState.xOverride.to,
      divisions: chartState.xOverride.divisions,
    };
  }
  const { from, to } = periodToRange(chartState.period);
  // Default divisions by period: aim for ~6-8 ticks
  const divisions = {
    '1d': 6,
    '1w': 7,
    '1m': 6,
    '3m': 6,
    '1y': 6,
    'all': 6,
  }[chartState.period];
  return { from, to, divisions };
}

function renderChart() {
  const svg = $('#price-chart');
  const W = 720;
  const H = 360;
  const PAD_LEFT = 60;
  const PAD_RIGHT = 20;
  const PAD_TOP = 20;
  const PAD_BOTTOM = 48;
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  const { min: yMin, max: yMax, step: yStep } = computeYAxis();
  const { from: xFrom, to: xTo, divisions: xDivs } = computeXAxis();

  const xScale = (t) => PAD_LEFT + ((t - xFrom) / (xTo - xFrom)) * plotW;
  const yScale = (p) => PAD_TOP + ((yMax - p) / (yMax - yMin)) * plotH;

  const obs = chartState.observations;
  const points = obs.map((o) => [xScale(o.observedAt), yScale(o.price)]);

  // ── Build Y-axis tick lines + labels ──────────────────
  const yTicks = [];
  for (let v = yMin; v <= yMax + 0.01; v += yStep) {
    yTicks.push(Math.round(v));
    if (yTicks.length > 20) break; // safety
  }

  // ── Build X-axis tick marks ───────────────────────────
  const xTicks = [];
  for (let i = 0; i <= xDivs; i++) {
    xTicks.push(xFrom + ((xTo - xFrom) * i) / xDivs);
  }

  const fmtDate = (t) => {
    const d = new Date(t);
    const period = chartState.period;
    if (period === '1d') {
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    if (period === '1w' || period === '1m') {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return `${d.getFullYear()}/${d.getMonth() + 1}`;
  };

  // ── SVG building ──────────────────────────────────────
  const parts = [];

  // Gradients (defs)
  parts.push(`
    <defs>
      <linearGradient id="price-gradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%"   stop-color="#FFB84D"/>
        <stop offset="100%" stop-color="#FF9900"/>
      </linearGradient>
      <linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#FF9900" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#FF9900" stop-opacity="0"/>
      </linearGradient>
    </defs>
  `);

  // Horizontal gridlines + Y-tick labels
  for (const v of yTicks) {
    const y = yScale(v);
    parts.push(`<line class="grid-line" x1="${PAD_LEFT}" y1="${y}" x2="${W - PAD_RIGHT}" y2="${y}"/>`);
    parts.push(`<text class="tick-label" x="${PAD_LEFT - 8}" y="${y + 3}" text-anchor="end">¥${v.toLocaleString('ja-JP')}</text>`);
  }

  // Vertical gridlines + X-tick labels
  for (const t of xTicks) {
    const x = xScale(t);
    parts.push(`<line class="grid-line" x1="${x}" y1="${PAD_TOP}" x2="${x}" y2="${H - PAD_BOTTOM}"/>`);
    parts.push(`<text class="tick-label" x="${x}" y="${H - PAD_BOTTOM + 14}" text-anchor="middle">${fmtDate(t)}</text>`);
  }

  // Axis lines
  parts.push(`<line class="axis-line" x1="${PAD_LEFT}" y1="${PAD_TOP}" x2="${PAD_LEFT}" y2="${H - PAD_BOTTOM}"/>`);
  parts.push(`<line class="axis-line" x1="${PAD_LEFT}" y1="${H - PAD_BOTTOM}" x2="${W - PAD_RIGHT}" y2="${H - PAD_BOTTOM}"/>`);

  // Axis titles
  parts.push(`<text class="axis-title" x="20" y="${PAD_TOP - 4}" text-anchor="start">販売価格 (円)</text>`);
  parts.push(`<text class="axis-title" x="${W - PAD_RIGHT}" y="${H - 8}" text-anchor="end">年月日</text>`);

  // Price area (filled under the line) + line + data points
  if (points.length >= 2) {
    const areaPath =
      `M ${points[0][0]} ${H - PAD_BOTTOM} ` +
      points.map(([x, y]) => `L ${x} ${y}`).join(' ') +
      ` L ${points[points.length - 1][0]} ${H - PAD_BOTTOM} Z`;
    parts.push(`<path class="price-area" d="${areaPath}"/>`);

    const linePath = 'M ' + points.map(([x, y]) => `${x} ${y}`).join(' L ');
    parts.push(`<path class="price-line" d="${linePath}"/>`);

    for (const [x, y] of points) {
      parts.push(`<circle class="data-point" cx="${x}" cy="${y}" r="4"/>`);
    }
  } else if (points.length === 1) {
    const [x, y] = points[0];
    parts.push(`<circle class="data-point" cx="${x}" cy="${y}" r="5"/>`);
  }

  // Invisible click zones for axis-config modals
  parts.push(`<rect class="axis-click-zone" data-axis="y" x="0" y="${PAD_TOP}" width="${PAD_LEFT}" height="${plotH}"/>`);
  parts.push(`<rect class="axis-click-zone" data-axis="x" x="${PAD_LEFT}" y="${H - PAD_BOTTOM}" width="${plotW}" height="${PAD_BOTTOM}"/>`);

  svg.innerHTML = parts.join('\n');

  // Re-wire axis click handlers (innerHTML replaces nodes)
  svg.querySelectorAll('.axis-click-zone').forEach((rect) => {
    rect.addEventListener('click', () => {
      const axis = rect.dataset.axis;
      if (axis === 'y') openYAxisModal();
      else openXAxisModal();
    });
  });
}

// ── Data table ────────────────────────────────────────────

function renderTable() {
  const tbody = $('#price-table tbody');
  const obs = chartState.observations;

  if (obs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:20px">データなし</td></tr>';
    return;
  }

  // Table shows newest first so most recent change is visible without scrolling
  const rows = [...obs].reverse();
  tbody.innerHTML = rows
    .map((o, i) => {
      const date = new Date(o.observedAt).toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      const priceStr = o.price != null ? `¥${o.price.toLocaleString('ja-JP')}` : '—';

      // Compare to the NEXT row in the reversed array (= older observation)
      const older = rows[i + 1];
      let deltaStr = '—';
      let deltaCls = 'price-flat';
      if (older && older.price != null && o.price != null) {
        const diff = o.price - older.price;
        if (diff > 0) { deltaStr = `▲ +¥${diff.toLocaleString('ja-JP')}`; deltaCls = 'price-up'; }
        else if (diff < 0) { deltaStr = `▼ -¥${Math.abs(diff).toLocaleString('ja-JP')}`; deltaCls = 'price-down'; }
        else { deltaStr = '±0'; }
      }

      const pointsStr = o.points != null ? `${o.points.toLocaleString('ja-JP')} pt` : '—';

      return `<tr>
        <td>${date}</td>
        <td>${priceStr}</td>
        <td class="${deltaCls}">${deltaStr}</td>
        <td>${pointsStr}</td>
      </tr>`;
    })
    .join('');
}

// ── Axis configuration modals ─────────────────────────────

function openYAxisModal() {
  const current = computeYAxis();
  $('#y-min').value = current.min;
  $('#y-max').value = current.max;
  $('#y-step').value = current.step;
  $('#y-axis-modal').classList.remove('hidden');
  setTimeout(() => $('#y-min').focus(), 50);
}

function openXAxisModal() {
  const current = computeXAxis();
  const toIso = (t) => new Date(t).toISOString().slice(0, 10);
  $('#x-start').value = toIso(current.from);
  $('#x-end').value = toIso(current.to);
  $('#x-divisions').value = current.divisions;
  $('#x-axis-modal').classList.remove('hidden');
}

// ── Wire up all chart-related event handlers on DOM ready ─

function setupChartControls() {
  // Close buttons / backdrop clicks
  document.querySelectorAll('[data-chart-close]').forEach((el) => {
    el.addEventListener('click', closeChartModal);
  });
  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#y-axis-modal').classList.contains('hidden')) {
      $('#y-axis-modal').classList.add('hidden');
    } else if (!$('#x-axis-modal').classList.contains('hidden')) {
      $('#x-axis-modal').classList.add('hidden');
    } else if (!$('#chart-modal').classList.contains('hidden')) {
      closeChartModal();
    }
  });

  // Period switcher
  $$('#period-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#period-tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      chartState.period = btn.dataset.period;
      // Reset axis overrides when switching period — they no longer make sense
      chartState.yOverride = null;
      chartState.xOverride = null;
      loadChartData();
    });
  });

  // Y-axis modal actions
  $('#y-axis-apply').addEventListener('click', () => {
    const min = parseFloat($('#y-min').value);
    const max = parseFloat($('#y-max').value);
    const step = parseFloat($('#y-step').value);
    if (isNaN(min) || isNaN(max) || isNaN(step) || min >= max || step <= 0) {
      return; // invalid, ignore
    }
    chartState.yOverride = { min, max, step };
    $('#y-axis-modal').classList.add('hidden');
    renderChart();
  });
  $('#y-axis-reset').addEventListener('click', () => {
    chartState.yOverride = null;
    $('#y-axis-modal').classList.add('hidden');
    renderChart();
  });
  document.querySelector('[data-axis-close="y"]').addEventListener('click', () => {
    $('#y-axis-modal').classList.add('hidden');
  });

  // X-axis modal actions
  $('#x-axis-apply').addEventListener('click', () => {
    const fromStr = $('#x-start').value;
    const toStr = $('#x-end').value;
    const divisions = parseInt($('#x-divisions').value, 10);
    if (!fromStr || !toStr || isNaN(divisions) || divisions < 1) return;
    const from = new Date(fromStr).getTime();
    const to = new Date(toStr).getTime() + DAY_MS - 1; // end of day
    if (from >= to) return;
    chartState.xOverride = { from, to, divisions };
    $('#x-axis-modal').classList.add('hidden');
    // When user manually overrides the x-range, re-fetch data for that range.
    // We fall back to remote source since an arbitrary range could exceed local.
    loadChartDataForCustomRange(from, to);
  });
  $('#x-axis-reset').addEventListener('click', () => {
    chartState.xOverride = null;
    $('#x-axis-modal').classList.add('hidden');
    loadChartData();
  });
  document.querySelector('[data-axis-close="x"]').addEventListener('click', () => {
    $('#x-axis-modal').classList.add('hidden');
  });
}

async function loadChartDataForCustomRange(from, to) {
  const statusEl = $('#chart-status');
  statusEl.textContent = '読み込み中…';
  statusEl.classList.remove('error');

  const raw = await sendBg({
    action: 'getObservationsRange',
    asin: chartState.asin,
    from, to,
    source: 'remote',
  });

  if (raw?.error) {
    statusEl.textContent = `エラー: ${raw.error}`;
    statusEl.classList.add('error');
    return;
  }

  const obs = (Array.isArray(raw) ? raw : [])
    .filter((o) => o.price != null)
    .sort((a, b) => a.observedAt - b.observedAt);

  chartState.observations = dedupeFlatMidpoints(obs);
  statusEl.textContent = `${chartState.observations.length} 件のデータ`;
  renderChart();
  renderTable();
}

// Hook into init
document.addEventListener('DOMContentLoaded', () => {
  setupChartControls();
});
