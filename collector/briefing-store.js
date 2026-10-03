'use strict';
/**
 * 简报的落盘与读取。
 * 简报永久保存，不参与任何清理 —— 它们放在 data/briefings/ 子目录，
 * 目录名不匹配批次文件名规则，cleanup() 扫描 data/ 时天然看不到它们。
 */
const fs = require('node:fs');
const path = require('node:path');
const { listBatches } = require('./dedupe');

const BRIEF_DIR = 'briefings';
const BRIEF_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const dirOf = (dataDir) => path.join(dataDir, BRIEF_DIR);
const fileOf = (dataDir, id) => path.join(dirOf(dataDir), `${id}.json`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 列出简报文件名（去掉扩展名），按 id 倒序。 */
function listBriefIds(dataDir) {
  const dir = dirOf(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => BRIEF_FILE_RE.test(n))
    .map((n) => n.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

/** 列出全部简报的元信息（不含 briefing 正文），按覆盖结束日倒序 —— 最新在前。 */
function listBriefings(dataDir) {
  const out = [];
  for (const id of listBriefIds(dataDir)) {
    const d = readJson(fileOf(dataDir, id));
    if (!d) continue; // 单个文件损坏不影响其余
    const docId = d.id || id;
    if (!BRIEF_FILE_RE.test(`${docId}.json`)) continue; // id 不合规的视为损坏，跳过
    out.push({
      id: docId,
      from: d.from || null,
      to: d.to || id,
      itemCount: d.itemCount || 0,
      batchCount: d.batchCount || 0,
      generatedAt: d.generatedAt || null,
    });
  }
  return out.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
}

function readBriefing(dataDir, id) {
  if (!BRIEF_FILE_RE.test(`${id}.json`)) return null;
  return readJson(fileOf(dataDir, id));
}

/** 写入一份简报，返回落盘的对象。 */
function writeBriefing(dataDir, doc) {
  const id = doc.id;
  if (!BRIEF_FILE_RE.test(`${id}.json`)) throw new Error(`简报 id 不合规：${id}`);
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  fs.writeFileSync(fileOf(dataDir, id), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

/** 读取覆盖区间内的批次（含 items），按 id 升序（旧→新）。 */
function loadBatchesInRange(dataDir, from, to) {
  const out = [];
  for (const b of listBatches(dataDir)) {
    if (b.date < from || b.date > to) continue;
    const d = readJson(path.join(dataDir, b.file));
    if (!d) continue;
    out.push({ id: b.id, date: b.date, slot: b.slot, items: d.items || [] });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

module.exports = { BRIEF_DIR, listBriefings, readBriefing, writeBriefing, loadBatchesInRange };
