'use strict';

// アプリ内イベントログ (2026-06 client要望)。監視クロールの主要イベント
// (周期開始/完了・ソフトブロック疑い・一時停止・自動再開 等) を時系列で
// リングバッファに保持し、アプリ内の「ログ」ビューアで確認できるようにする。
// console にも出すので、開発時のターミナルでも追える。
// 永続化はしない (メモリ上のみ) — 直近の挙動把握が目的。

const MAX_ENTRIES = 1000;
const buffer = [];

// level: 'info' | 'warn' | 'error'
function log(level, message) {
  const lv = (level === 'warn' || level === 'error') ? level : 'info';
  const entry = { t: Date.now(), level: lv, message: String(message == null ? '' : message) };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  const line = `[applog] ${entry.message}`;
  if (lv === 'error') console.error(line);
  else if (lv === 'warn') console.warn(line);
  else console.info(line);
  return entry;
}

// 直近 limit 件 (省略時は全件) を古い順で返す。
function getLog(limit) {
  if (limit && limit > 0 && limit < buffer.length) {
    return buffer.slice(buffer.length - limit);
  }
  return buffer.slice();
}

function clear() { buffer.length = 0; }

module.exports = { log, getLog, clear };
