'use strict';
/**
 * 采集主流程：抓取 → 相关性过滤 → 去重 → 补详情 → AI 摘要 → 落盘 → 按需生成简报。
 *
 * 每周一、周四各采集一次（北京时间 09:00，slot=0900），每个批次是**纯增量**：
 * 只装本次真正新采集到的条目，批次之间不重复、不结转。
 * 数据写成独立文件：data/2026-10-01-0900.json。
 *
 * 简报不再挂在批次上：每 30 天生成一份，覆盖最近 30 天，存在 data/briefings/ 下永久保留。
 * 生成分两级（见 ai.js）：按批次分块各写一份阶段简报，再汇总成最终简报。
 *
 * 同一批次允许重复运行（workflow 三次兜底）：以本批次文件为底稿，只追加真正新增的条目；
 * 已有摘要的条目不重复调用大模型，本轮无新增则不改写文件，因此兜底运行不产生空提交。
 *
 * 用法：
 *   node collector/run.js                       # 按北京时间自动判断批次
 *   node collector/run.js --slot=0900           # 指定批次（workflow 按 cron 传入）
 *   node collector/run.js --date=2026-10-01 --slot=0900
 *   node collector/run.js --dry-run             # 只抓取解析，不调用大模型
 *   node collector/run.js --source=gkzhan       # 只跑某个源，便于排查
 */
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { SOURCES, isRelevant, parseFeed, parseList } = require('./feeds');
const { fetchText, extractArticle, htmlToText, collapse, sleep } = require('./fetch-utils');
const { idFor, loadSeenIds, listBatches } = require('./dedupe');
const ai = require('./ai');
const briefing = require('./briefing');
const briefingStore = require('./briefing-store');

// ---------- CLI ----------
const opt = { dryRun: false, source: null, date: null, slot: null };
for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') opt.dryRun = true;
  else if (a.startsWith('--source=')) opt.source = a.slice('--source='.length);
  else if (a.startsWith('--date=')) opt.date = a.slice('--date='.length);
  else if (a.startsWith('--slot=')) opt.slot = a.slice('--slot='.length);
}

const log = (...a) => console.log(...a);
/** 当前北京时间（返回的 Date 其 UTC 字段即北京墙上时间）。 */
const beijingNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const beijingDate = (d = beijingNow()) => d.toISOString().slice(0, 10);

/** 两个批次的元信息。 */
const SLOT_INFO = {
  '0900': { label: '09:00', generation: 'morning' },
  '2100': { label: '21:00', generation: 'evening' },
};
/** 兜底推断批次（手动 dispatch 未传 --slot 时用）：15 点前算早报，之后算晚报。 */
const slotOf = (d = beijingNow()) => (d.getUTCHours() < 15 ? '0900' : '2100');

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

const batchFile = (id) => path.join(cfg.dataDir, `${id}.json`);

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

// ---------- 批次底稿 ----------
/**
 * 同批次重复运行（兜底触发）时的底稿：只看本批次自己的文件。
 * 不再跨批次结转 —— 批次是纯增量，每次采集只装本次新增。
 */
function loadOwn(batchId) {
  const own = readJson(batchFile(batchId));
  return { items: (own && own.items) || [], exists: !!own };
}

// ---------- 落盘 ----------
function updateIndex() {
  const batches = listBatches(cfg.dataDir).map((b) => {
    const d = readJson(path.join(cfg.dataDir, b.file)) || {};
    return {
      id: b.id,
      date: b.date,
      slot: b.slot, // 旧格式文件为 null，前端显示为「全天」
      generation: d.generation || null,
      count: (d.items || []).length,
      updatedAt: d.updatedAt || null,
    };
  });
  writeJson(path.join(cfg.dataDir, 'index.json'), {
    batches,
    briefings: briefingStore.listBriefings(cfg.dataDir),
    dates: [...new Set(batches.map((b) => b.date))],
    latest: batches.length ? batches[0].id : null,
    updatedAt: new Date().toISOString(),
  });
  return batches;
}

function cleanup() {
  const cutoff = Date.now() - cfg.retentionDays * 86400000;
  let removed = 0;
  for (const b of listBatches(cfg.dataDir)) {
    if (new Date(`${b.date}T00:00:00Z`).getTime() < cutoff) {
      fs.unlinkSync(path.join(cfg.dataDir, b.file));
      removed++;
    }
  }
  if (removed) log(`[清理] 删除 ${removed} 个超过 ${cfg.retentionDays} 天的批次文件`);
}

// ---------- 简报 ----------
/**
 * 距上一份简报满 briefingIntervalDays 天就生成一份，覆盖最近这么多天。
 * 任何一步失败都只是本次不生成，不抛异常 —— 下次采集会重试（因为没写成功）。
 */
async function maybeGenerateBriefing(useAI) {
  const existing = briefingStore.listBriefings(cfg.dataDir);
  const now = new Date();
  if (!briefing.shouldGenerate(existing, now, cfg.briefingIntervalDays)) {
    log(`[简报] 距上一份未满 ${cfg.briefingIntervalDays} 天，跳过`);
    return;
  }
  if (!useAI) {
    log('[简报] dry-run 或无 AI key，跳过生成');
    return;
  }

  // 注意：beijingDate(d) 取的是 d 的 UTC 字段，所以必须传「已偏移 +8h 的 Date」。
  // 传裸的 new Date() 会得到 UTC 日期——北京时间 00:00~08:00 之间会比北京日期早一天，
  // 覆盖区间和简报文件名都会错。
  const nowBJ = beijingNow();
  const to = beijingDate(nowBJ);
  const from = beijingDate(new Date(nowBJ.getTime() - cfg.briefingIntervalDays * 86400000));
  const batches = briefingStore.loadBatchesInRange(cfg.dataDir, from, to);
  const { chunks, total } = briefing.planChunks(batches, cfg.briefingChunkMax);
  if (!chunks.length) {
    log(`[简报] ${from} ~ ${to} 区间内没有资讯，跳过`);
    return;
  }
  log(`[简报] 生成 ${from} ~ ${to}：去重后 ${total} 条，分 ${chunks.length} 块`);

  const stage1 = [];
  for (let i = 0; i < chunks.length; i++) {
    log(`  [简报] 阶段 ${i + 1}/${chunks.length}（${chunks[i].length} 条）…`);
    try {
      const b = await ai.buildChunkBriefing(cfg.deepseek, chunks[i], `${from} ~ ${to} 第 ${i + 1} 段`, { log });
      if (b) stage1.push(b);
      else log(`  [简报] 阶段 ${i + 1} 返回空，跳过`);
    } catch (err) {
      log(`  [简报] 阶段 ${i + 1} 失败（跳过）：${err.message}`);
    }
  }
  if (!stage1.length) {
    log('[简报] 全部阶段失败，本次不生成');
    return;
  }

  let final = stage1[0];
  if (stage1.length > 1) {
    log(`  [简报] 汇总 ${stage1.length} 份阶段简报…`);
    try {
      final = await ai.mergeBriefings(cfg.deepseek, stage1, from, to, { log });
    } catch (err) {
      log(`  [简报] 汇总失败：${err.message}`);
      final = null;
    }
    if (!final) {
      log('[简报] 汇总没有产出，本次不写入（下次采集会重试）');
      return;
    }
  }

  briefingStore.writeBriefing(cfg.dataDir, {
    id: to,
    from,
    to,
    generatedAt: now.toISOString(),
    itemCount: total,
    batchCount: chunks.length,
    briefing: final,
  });
  log(`[简报] 已写入 briefings/${to}.json（覆盖 ${from} ~ ${to}，${total} 条）`);
}

// ---------- 主流程 ----------
async function main() {
  const date = opt.date || beijingDate();
  const slot = opt.slot || slotOf();
  if (!SLOT_INFO[slot]) throw new Error(`未知批次：${slot}（只支持 0900 / 2100）`);
  const batchId = `${date}-${slot}`;
  const useAI = !opt.dryRun && !!cfg.deepseek.apiKey;
  log(`=== 批次 ${batchId}（${SLOT_INFO[slot].label}）${opt.dryRun ? ' [dry-run]' : useAI ? '' : ' [无 AI key，跳过摘要/简报]'} ===`);

  // 0) 底稿：只含本批次已有的条目，不再跨批次结转
  const own = loadOwn(batchId);
  const baseItems = own.items;
  log(`[底稿] ${own.exists ? `本批次已有 ${baseItems.length} 条` : '新批次，从零开始'}`);

  // 1) 抓取
  const sources = SOURCES.filter((s) => !opt.source || s.id === opt.source);
  if (!sources.length) throw new Error(`未知源：${opt.source}`);
  const raw = [];
  for (const s of sources) {
    try {
      raw.push(...(await collectSource(s)));
    } catch (err) {
      log(`  [源] ${s.name} 失败（已跳过）：${err.message}`);
    }
    await sleep(300);
  }

  // 2) 去重：近 14 天所有批次里出现过的 id 都不再收（每周两次采集，漏跑一次就是 6 天空窗）
  const seen = loadSeenIds(cfg.dataDir, { windowDays: 14 });
  const localSeen = new Set();
  const fresh = [];
  for (const it of raw) {
    it.id = idFor(it.url);
    if (seen.has(it.id) || localSeen.has(it.id)) continue;
    localSeen.add(it.id);
    fresh.push(it);
  }
  log(`[去重] 抓取 ${raw.length} 条 → 本轮新增 ${fresh.length} 条（已排除历史批次中的 ${seen.size} 条）`);

  // 3) 补详情：新增的补；底稿里摘要为空的（上次 AI 失败留下的）也补
  const needDigest = baseItems.filter((it) => !it.digest);
  const toFill = [...fresh, ...needDigest];
  if (toFill.length) await enrich(toFill);

  // 4) AI 摘要：只处理「新增」与「缺摘要的旧条目」，已有摘要的不重复调用
  let digestAdded = 0;
  if (useAI && toFill.length) {
    log(`[AI] 生成 ${toFill.length} 条摘要（新增 ${fresh.length}，补漏 ${needDigest.length}）…`);
    const digests = await ai.summarizeItems(cfg.deepseek, toFill, { textLimit: cfg.textLimit, log });
    toFill.forEach((it, i) => {
      const d = digests.get(i);
      if (d && !it.digest) {
        it.digest = d;
        digestAdded++;
      }
    });
  }

  // 5) 合并成本批次内容（底稿 + 本次新增）
  const merged = [...baseItems];
  const ids = new Set(merged.map((i) => i.id));
  let appended = 0;
  for (const it of fresh) {
    if (ids.has(it.id)) continue;
    ids.add(it.id);
    merged.push(toExport(it));
    appended++;
  }
  merged.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

  // 6) 落盘：内容有变化、或本批次文件还不存在时才写（避免兜底运行产生空提交）
  const changed = appended > 0 || digestAdded > 0;
  if (merged.length && (changed || !own.exists)) {
    writeJson(batchFile(batchId), {
      id: batchId,
      date,
      slot,
      slotLabel: SLOT_INFO[slot].label,
      generation: SLOT_INFO[slot].generation,
      updatedAt: new Date().toISOString(),
      items: merged,
    });
    log(`[写入] ${batchId}.json：本次新增 ${appended} 条，本批共 ${merged.length} 条`);
  } else if (!merged.length) {
    log('[结果] 本次无资讯，仅刷新 index');
  } else {
    log('[结果] 本批次无新增内容，未改写文件');
  }

  // 7) 简报：距上一份满 N 天才生成
  await maybeGenerateBriefing(useAI);

  // 8) 索引 + 清理
  const batches = updateIndex();
  cleanup();
  log(`[完成] 历史批次共 ${batches.length} 个（${[...new Set(batches.map((b) => b.date))].length} 天）`);
}

main().catch((err) => {
  console.error('[致命错误]', err);
  process.exit(1);
});
