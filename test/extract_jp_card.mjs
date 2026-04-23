import { readFileSync, writeFileSync } from 'fs';
import { parseHTML } from 'linkedom';

const html = readFileSync('../test_jp_search.html', 'utf8');
const { document } = parseHTML(html);

const listitems = document.querySelectorAll('div[role="listitem"][data-asin="B08PTNSTT9"]');
console.log(`Found ${listitems.length} listitem(s) with data-asin=B08PTNSTT9`);

const allAsinEls = document.querySelectorAll('[data-asin="B08PTNSTT9"]');
console.log(`Found ${allAsinEls.length} total elements with data-asin=B08PTNSTT9`);

allAsinEls.forEach((el, i) => {
  const tag = el.tagName;
  const role = el.getAttribute('role') || '';
  const cls = (el.className || '').slice(0, 100);
  const compType = el.getAttribute('data-component-type') || '';
  console.log(`  [${i}] <${tag}> role="${role}" data-component-type="${compType}" class="${cls}..." textContent.length=${(el.textContent || '').length}`);
});

// Dump the primary listitem to a file
if (listitems.length > 0) {
  const card = listitems[0];
  const html = card.outerHTML;
  writeFileSync('jp_card_dump.html', html, 'utf8');
  console.log(`\nDumped card outerHTML (${html.length} chars) to jp_card_dump.html`);

  // Probe for common selectors
  console.log('\n── Selector probe ──────────────────────────────');
  const probes = [
    '.a-price',
    '.a-price .a-offscreen',
    '.a-price-whole',
    '[data-csa-c-price-to-pay]',
    '.a-color-price',
    '.udm-primary-delivery-message',
    '[data-cy="price-recipe"]',
    '[data-cy="delivery-recipe"]',
    '[data-cy="title-recipe"]',
    'h2',
    'h2 span',
  ];
  for (const sel of probes) {
    const found = card.querySelectorAll(sel);
    const first = found[0];
    const text = first ? (first.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '(none)';
    console.log(`  ${sel.padEnd(35)} count=${found.length}  first="${text}"`);
  }

  // Text content search
  console.log('\n── textContent scan ──────────────────────────');
  const text = card.textContent || '';
  console.log(`  card.textContent.length = ${text.length}`);
  console.log(`  contains "¥": ${text.includes('¥')}`);
  console.log(`  contains "￥": ${text.includes('￥')}`);
  console.log(`  contains "円": ${text.includes('円')}`);
  console.log(`  contains "4,780": ${text.includes('4,780')}`);
  console.log(`  contains "4780": ${text.includes('4780')}`);
  console.log(`  contains "pt": ${text.includes('pt')}`);
  console.log(`  contains "ポイント": ${text.includes('ポイント')}`);
  console.log(`  contains "48": ${text.includes('48')}`);
  console.log();
  console.log('  First 1000 chars of textContent (whitespace-collapsed):');
  console.log('  ' + text.replace(/\s+/g, ' ').slice(0, 1000));
}
