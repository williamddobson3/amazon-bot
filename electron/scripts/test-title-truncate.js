'use strict';

// Verifies the 3-line title truncation logic (renderer truncateTitleTo3Lines).
// Mocks canvas measureText with a simple width model so the wrap math is testable
// in node. Key property: the RESULT, re-wrapped, must be ≤ 3 lines and end with …
// for over-long titles (= overflow genuinely removed, not just hidden).

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('FAIL ' + name); } }

const MAXW = 214;
// width model: CJK ≈ 11px, fullwidth punctuation ≈ 11, ASCII ≈ 6, space ≈ 4, … ≈ 11
function charW(ch) {
  const c = ch.codePointAt(0);
  if (ch === '…') return 11;
  if (/\s/.test(ch)) return 4;
  if (c >= 0x2E80) return 11;     // CJK / kana / fullwidth
  return 6;                        // ASCII
}
function widthOf(s) { let w = 0; for (const ch of s) w += charW(ch); return w; }
const fits = (s) => widthOf(s) <= MAXW;

// ── the exact wrap/truncate algorithm from renderer.js ──────────────────
function truncate(t) {
  t = String(t == null ? '' : t);
  if (!t) return '';
  const lines = [];
  let cur = '';
  let truncated = false;
  const tokens = t.split(/(\s+)/);
  outer:
  for (const token of tokens) {
    if (token === '') continue;
    if (cur === '' && /^\s+$/.test(token)) continue;
    if (fits(cur + token)) { cur += token; continue; }
    if (cur !== '') { lines.push(cur); cur = ''; if (lines.length >= 3) { truncated = true; break; } }
    for (const ch of token) {
      if (cur === '' && /\s/.test(ch)) continue;
      if (cur !== '' && !fits(cur + ch)) { lines.push(cur); cur = ''; if (lines.length >= 3) { truncated = true; break outer; } }
      cur += ch;
    }
  }
  if (!truncated) return t;
  let last = lines[2];
  while (last && !fits(last + '…')) last = last.slice(0, -1);
  return ((lines[0] || '') + (lines[1] || '') + last).replace(/\s+$/, '') + '…';
}

// Count how many lines a string wraps to (same algorithm, no truncation cap).
function lineCount(t) {
  const lines = [];
  let cur = '';
  const tokens = String(t).split(/(\s+)/);
  for (const token of tokens) {
    if (token === '') continue;
    if (cur === '' && /^\s+$/.test(token)) continue;
    if (fits(cur + token)) { cur += token; continue; }
    if (cur !== '') { lines.push(cur); cur = ''; }
    for (const ch of token) {
      if (cur === '' && /\s/.test(ch)) continue;
      if (cur !== '' && !fits(cur + ch)) { lines.push(cur); cur = ''; }
      cur += ch;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines.length;
}

// ── 1) Short title (≤3 lines) returned unchanged, no … ──────────────────
const short = '和気産業 丸カラビナ キーホルダー 登山';
ok('short returned unchanged', truncate(short) === short);
ok('short has no ellipsis', !truncate(short).endsWith('…'));
ok('short fits ≤3 lines', lineCount(short) <= 3);

// ── 2) Long CJK title (the screenshot case) truncates to ≤3 lines + … ────
const long = '和気産業(Waki Sangyo) 丸型カラビナ リング キーリング スマホストラップ キーホルダー バッグチャーム 鍵 2個入 ガンメタ 外径30mm 防錆 アウトドア 多用途 大容量 まとめ買い お買い得セット 高品質';
const r = truncate(long);
ok('long is truncated (shorter)', r.length < long.length);
ok('long ends with …', r.endsWith('…'));
ok('long result re-wraps to ≤3 lines', lineCount(r) <= 3);
ok('long original was >3 lines', lineCount(long) > 3);

// ── 3) Pure CJK no-spaces title also clamps to 3 lines ──────────────────
const cjk = 'あ'.repeat(200);
const rc = truncate(cjk);
ok('cjk truncated', rc.length < cjk.length);
ok('cjk ends with …', rc.endsWith('…'));
ok('cjk re-wraps to ≤3 lines', lineCount(rc) <= 3);

// ── 4) Exactly-3-lines title is NOT truncated (no spurious …) ────────────
// Build a string that wraps to exactly 3 lines.
let s3 = '';
while (lineCount(s3 + 'あ') <= 3) s3 += 'あ';
ok('exactly-3-lines not truncated', truncate(s3) === s3 && !truncate(s3).endsWith('…'));
ok('one more char does truncate', truncate(s3 + 'いいいい').endsWith('…'));

// ── 5) Empty / null safe ────────────────────────────────────────────────
ok('empty → empty', truncate('') === '' && truncate(null) === '' && truncate(undefined) === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
