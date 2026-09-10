'use strict';
/**
 * 采集主流程：抓取 → 相关性过滤 → 去重 → 补详情 → AI 摘要 → 双板块简报 → 落盘。
 *
 * 用法：
 *   node collector/run.js                 # 正常跑（北京日期，自动判断 morning/evening）
 *   node collector/run.js --dry-run       # 只抓取解析，不调用大模型
 *   node collector/run.js --source=gkzhan # 只跑某个源
 *   node collector/run.js --date=2026-09-08 --generation=manual
 */
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { SOURCES, isRelevant, parseFeed, parseList } = require('./feeds');
const { fetchText, extractArticle, htmlToText, collapse, sleep } = require('./fetch-utils');
const { idFor, loadSeenIds } = require('./dedupe');
const ai = require('./ai');

// ---------- CLI ----------
const opt = { dryRun: false, source: null, date: null, generation: null };
for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') opt.dryRun = true;
  else if (a.startsWith('--source=')) opt.source = a.slice('--source='.length);
  else if (a.startsWith('--date=')) opt.date = a.slice('--date='.length);
  else if (a.startsWith('--generation=')) opt.generation = a.slice('--generation='.length);
}

const log = (...a) => console.log(...a);
/** 当前北京时间（返回的 Date 其 UTC 字段即北京墙上时间）。 */
const beijingNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const beijingDate = (d = beijingNow()) => d.toISOString().slice(0, 10);

// ---------- 工具 ----------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
/** 简单并发池。 */
async function runPool(items, size, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

// ---------- 采集 ----------
async function collectSource(src) {
  const urls = src.urls || [src.url];
  let parsed = 0;
  const relevant = [];
  for (const u of urls) {
    const { text } = await fetchText(u, { encoding: src.encoding, timeout: 20000, retries: 2 });
    const items = src.type === 'rss' ? parseFeed(text, src) : parseList(text, src);
    parsed += items.length;
    for (const it of items) if (isRelevant(it.title)) relevant.push(it);
  }
  log(`  [源] ${src.name}：解析 ${parsed} 条 → 相关 ${relevant.length} 条`);
  return relevant;
}

/** 进详情页补「时间 / 摘要正文」（feed 自带正文过短的也补）。 */
async function enrich(items) {
  const capFor = (id) => SOURCES.find((s) => s.id === id)?.maxDetail || cfg.maxDetailPerSource;
  const perSource = new Map();
  const picked = [];
  for (const it of items) {
    const existing = it.text || htmlToText(it.rawText || '');
    const needs = it.needDetail || collapse(existing).length < 80;
    if (!needs) continue;
    const n = perSource.get(it.sourceId) || 0;
    if (n >= capFor(it.sourceId)) continue;
    perSource.set(it.sourceId, n + 1);
    picked.push(it);
  }
  log(`[详情] 需补抓 ${picked.length} 条`);
  let done = 0;
  await runPool(picked, cfg.concurrency, async (it) => {
    try {
      const { text: html } = await fetchText(it.url, { timeout: 15000, retries: 1 });
      const { date, text } = extractArticle(html);
      if (date && !it.time) it.time = date.toISOString();
      if (text) it.text = text;
    } catch (err) {
      log(`  [详情] 跳过 ${it.url}：${err.message}`);
    } finally {
      done++;
      if (done % 10 === 0) log(`  [详情] 进度 ${done}/${picked.length}`);
    }
  });
  // 未补抓的用 feed 自带正文兜底
  for (const it of items) {
    if (!it.text) it.text = collapse(htmlToText(it.rawText || '')).slice(0, cfg.textLimit);
  }
  return items;
}

const toExport = (it) => ({
  id: it.id,
  title: it.title,
  source: it.source,
  time: it.time,
  url: it.url,
  digest: it.digest || '',
});

// ---------- 落盘 ----------
function updateIndex() {
  const files = fs
    .readdirSync(cfg.dataDir)
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n)?.[1])
    .filter(Boolean)
    .sort()
    .reverse();
  writeJson(path.join(cfg.dataDir, 'index.json'), {
    dates: files,
    latest: files[0] || null,
    updatedAt: new Date().toISOString(),
  });
  return files;
}

function cleanup() {
  const cutoff = Date.now() - cfg.retentionDays * 86400000;
  let removed = 0;
  for (const name of fs.readdirSync(cfg.dataDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (!m) continue;
    if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
      fs.unlinkSync(path.join(cfg.dataDir, name));
      removed++;
    }
  }
  if (removed) log(`[清理] 删除 ${removed} 个超过 ${cfg.retentionDays} 天的历史文件`);
}

// ---------- 主流程 ----------
async function main() {
  const date = opt.date || beijingDate();
  const generation = opt.generation || (beijingNow().getUTCHours() < 12 ? 'morning' : 'evening');
  const useAI = !opt.dryRun && !!cfg.deepseek.apiKey;
  log(`=== ${date} (${generation}) ${opt.dryRun ? '[dry-run]' : useAI ? '' : '[无 AI key，跳过摘要/简报]'} ===`);

  const sources = SOURCES.filter((s) => !opt.source || s.id === opt.source);
  if (!sources.length) throw new Error(`未知源：${opt.source}`);

  // 1) 抓取
  const raw = [];
  for (const s of sources) {
    try {
      raw.push(...(await collectSource(s)));
    } catch (err) {
      log(`  [源] ${s.name} 失败（已跳过）：${err.message}`);
    }
    await sleep(300);
  }

  // 2) 去重（近 7 天窗口）
  const seen = loadSeenIds(cfg.dataDir, { windowDays: 7, excludeDate: date });
  const localSeen = new Set();
  const fresh = [];
  for (const it of raw) {
    it.id = idFor(it.url);
    if (seen.has(it.id) || localSeen.has(it.id)) continue;
    localSeen.add(it.id);
    fresh.push(it);
  }
  log(`[去重] 抓取 ${raw.length} 条 → 新增 ${fresh.length} 条（已排除近 7 天重复）`);
  if (!fresh.length) {
    log('[结果] 今日无新增，仅刷新 index');
    updateIndex();
    return;
  }

  // 3) 补详情 + 4) AI 摘要
  await enrich(fresh);
  if (useAI) {
    log(`[AI] 生成 ${fresh.length} 条摘要…`);
    const digests = await ai.summarizeItems(cfg.deepseek, fresh, { textLimit: cfg.textLimit, log });
    fresh.forEach((it, i) => {
      it.digest = digests.get(i) || '';
    });
  }

  // 5) merge 当日文件
  const dayFile = path.join(cfg.dataDir, `${date}.json`);
  const prev = readJson(dayFile) || { date, items: [], briefing: null };
  const merged = [...(prev.items || [])];
  const ids = new Set(merged.map((i) => i.id));
  for (const it of fresh) {
    if (ids.has(it.id)) continue;
    ids.add(it.id);
    merged.push(toExport(it));
  }
  // 回填：此前跑批（如无 key 的 dry-run）留下的空摘要，用本轮结果补上
  const digestById = new Map(fresh.filter((it) => it.digest).map((it) => [it.id, it.digest]));
  for (const it of merged) {
    if (!it.digest && digestById.has(it.id)) it.digest = digestById.get(it.id);
  }
  merged.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

  // 6) 简报
  let briefing = prev.briefing || null;
  if (useAI && merged.length) {
    log('[AI] 生成每日双板块简报…');
    try {
      const b = await ai.buildBriefing(cfg.deepseek, merged, date, { log });
      if (b) briefing = b;
    } catch (err) {
      log(`  [AI] 简报失败，保留旧简报：${err.message}`);
    }
  }

  writeJson(dayFile, {
    date,
    generation,
    updatedAt: new Date().toISOString(),
    items: merged,
    briefing,
  });
  const dates = updateIndex();
  cleanup();
  log(`[完成] ${date}：新增 ${merged.length - (prev.items || []).length} 条，累计 ${merged.length} 条；历史 ${dates.length} 天`);
}

main().catch((err) => {
  console.error('[致命错误]', err);
  process.exit(1);
});
