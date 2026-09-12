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

/**
 * 批次文件名：`YYYY-MM-DD-HHmm.json`（例 2026-09-12-0900.json）。
 * 兼容早期只有日期的 `YYYY-MM-DD.json`（slot 视为 null，前端显示为「全天」）。
 */
const BATCH_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?\.json$/;
const INDEX_FILE = 'index.json';

/** 列出 data 目录下所有批次，按 id 倒序（最新在前）。 */
function listBatches(dataDir) {
  const out = [];
  if (!fs.existsSync(dataDir)) return out;
  for (const name of fs.readdirSync(dataDir)) {
    if (name === INDEX_FILE) continue;
    const m = BATCH_FILE_RE.exec(name);
    if (!m) continue;
    out.push({ file: name, id: name.replace(/\.json$/, ''), date: m[1], slot: m[2] || null });
  }
  // id 倒序：同日内 "D-0900" < "D-2100"；旧的 "D" 短于二者，排在同日最后
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

/**
 * 收集近 windowDays 天内已收录的 id（用于跨天、跨批次去重）。
 * 注意：**不排除**任何批次——同一个批次重复运行时应只捞到「真正新增」的条目，
 * 已有条目由 run.js 的批次底稿（全量快照）负责带过来。
 */
function loadSeenIds(dataDir, { windowDays = 7, now = new Date() } = {}) {
  const ids = new Set();
  for (const b of listBatches(dataDir)) {
    const ageDays = (now - new Date(`${b.date}T00:00:00Z`)) / 86400000;
    if (ageDays > windowDays || ageDays < -1) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, b.file), 'utf8'));
      for (const it of data.items || []) if (it.id) ids.add(it.id);
    } catch {
      /* 单个文件损坏不影响整轮 */
    }
  }
  return ids;
}

module.exports = { normalizeUrl, idFor, loadSeenIds, listBatches, BATCH_FILE_RE, INDEX_FILE };
