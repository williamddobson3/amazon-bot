'use strict';
// ─────────────────────────────────────────────────────────────────────────
// THROWAWAY DIAGNOSTIC — capture the EXACT search HTML the scraper receives
// for one ASIN, using the app's OWN logged-in session cookies.
//
// Why this exists: the active (Rust) scraper parses HTML in memory and never
// saves it, and a cold/cookieless request to Amazon only gets an Akamai bot
// interstitial. The only way to reproduce what the scraper sees is to reuse
// the app's session (auth + Akamai bot cookies) from its userData profile.
//
// RUN WITH THE APP CLOSED (so the cookie store isn't locked):
//   cd electron
//   node_modules\.bin\electron scripts\dump-search-html.js B0CCTXFCDP
//
// Output: electron\scripts\dump-<ASIN>.html  + a summary of which price
// blocks (price-recipe / multi-offer-display / secondary-offer-recipe) and
// which values appear. Cookie VALUES are never printed (only names), since
// the session token is sensitive.
// ─────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { app, session, net } = require('electron');

// Point at the SAME profile the app uses, so we read its real cookies.
const APPDATA = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
app.setPath('userData', path.join(APPDATA, 'amazon-price-monitor'));

const ASIN = (process.argv.find((a) => /^B0[A-Z0-9]{8}$/.test(a))) || 'B0CCTXFCDP';
const TARGET = `https://www.amazon.co.jp/s?k=${ASIN}`;
const OUT = path.join(__dirname, `dump-${ASIN}.html`);

// Same Chrome UA the scraper presents (must NOT say "Electron").
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

function count(html, needle) {
  return (html.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  ses.setUserAgent(CHROME_UA);

  // Login / bot-token indicator — NAMES ONLY (never values).
  const cookies = await ses.cookies.get({ url: 'https://www.amazon.co.jp/' });
  const names = cookies.map((c) => c.name);
  const auth = names.filter((n) => /^(at-|sess-|session-|x-acb|x-main|ubid)/i.test(n));
  const akamai = names.filter((n) => /^(bm_|_abck|ak_)/i.test(n));
  console.log(`[dump] userData : ${app.getPath('userData')}`);
  console.log(`[dump] target   : ${TARGET}`);
  console.log(`[dump] cookies for amazon.co.jp : ${cookies.length}`);
  console.log(`[dump] auth cookies present     : ${auth.join(', ') || '(NONE — session is LOGGED OUT)'}`);
  console.log(`[dump] akamai cookies present   : ${akamai.join(', ') || '(none)'}`);

  const req = net.request({ method: 'GET', url: TARGET, session: ses, useSessionCookies: true });
  req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
  req.setHeader('Accept-Language', 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7');
  req.setHeader('Referer', 'https://www.amazon.co.jp/');
  req.setHeader('Upgrade-Insecure-Requests', '1');

  const chunks = [];
  req.on('response', (res) => {
    console.log(`[dump] HTTP ${res.statusCode}`);
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8');
      fs.writeFileSync(OUT, html);
      console.log(`\n[dump] wrote ${html.length} bytes -> ${OUT}`);
      console.log(`[dump] has 6,534 / 6534          : ${/6,534|6534/.test(html)}`);
      console.log(`[dump] has 4,566 / 4566          : ${/4,566|4566/.test(html)}`);
      console.log(`[dump] data-cy=price-recipe       : ${count(html, 'data-cy="price-recipe"')}`);
      console.log(`[dump] data-cy=add-to-cart        : ${count(html, 'data-cy="add-to-cart"')}`);
      console.log(`[dump] data-csa-c-price-to-pay    : ${count(html, 'data-csa-c-price-to-pay')}`);
      console.log(`[dump] data-cy=multi-offer-display: ${count(html, 'data-cy="multi-offer-display"')}`);
      console.log(`[dump] data-cy=secondary-offer    : ${count(html, 'data-cy="secondary-offer-recipe"')}`);
      console.log(`[dump] s-search-result cards      : ${count(html, 'data-component-type="s-search-result"')}`);
      console.log(`[dump] bot interstitial?          : ${/bm-verify|_sec\/verify|api-services-support/.test(html)}`);
      app.quit();
    });
  });
  req.on('error', (e) => {
    console.error('[dump] request error:', e.message);
    app.quit();
  });
  req.end();
});
