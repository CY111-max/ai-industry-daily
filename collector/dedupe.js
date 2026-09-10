'use strict';
/** 去重：URL 归一化 + 近 N 天滚动窗口的已收录 id 集合。 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRACKING_PARAMS = new Set([
  'spm', 'from', 'source', 'share_token', 'weibo_id', 'tt_from', 'utm_source',
  'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'refer',
]);

/** 归一化 URL：去 hash、去追踪参数、统一 https、去尾部斜杠。 */
function normalizeUrl(u) {
  const raw = String(u || '').trim();
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase()) || /^utm_/i.test(k)) url.searchParams.delete(k);
    }
    let s = url.toString().replace(/\/+$/, '');
    return s.replace(/^http:/, 'https:');
  } catch {
    return raw.replace(/^http:/, 'https:').replace(/\/+$/, '');
  }
}

/** 条目标识：归一化 URL 的 md5。 */
function idFor(url) {
  return crypto.createHash('md5').update(normalizeUrl(url)).digest('hex');
}

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * 收集近 windowDays 天内已收录的 id（用于跨天去重）。
 * excludeDate：当前正在写入的日期文件本身不参与（它会与本次结果 merge）。
 */
function loadSeenIds(dataDir, { windowDays = 7, excludeDate = null, now = new Date() } = {}) {
  const ids = new Set();
  if (!fs.existsSync(dataDir)) return ids;
  for (const name of fs.readdirSync(dataDir)) {
    const m = DATE_FILE_RE.exec(name);
    if (!m) continue;
    const dateStr = m[1];
    if (excludeDate && dateStr === excludeDate) continue;
    const ageDays = (now - new Date(`${dateStr}T00:00:00Z`)) / 86400000;
    if (ageDays > windowDays || ageDays < -1) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
      for (const it of data.items || []) if (it.id) ids.add(it.id);
    } catch {
      /* 单个文件损坏不影响整轮 */
    }
  }
  return ids;
}

module.exports = { normalizeUrl, idFor, loadSeenIds, DATE_FILE_RE };
