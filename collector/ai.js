'use strict';
/** DeepSeek 调用：批量生成每条资讯的简短摘要 + 当日双板块简报。 */
const { collapse } = require('./fetch-utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUMMARY_SYSTEM = `你是严谨的中文科技媒体编辑。用户会给你一组当日 AI / 智能制造相关资讯（含标题、来源、日期、正文节选）。
请为每一条写 1-2 句中文摘要（不超过 60 字），要求：客观、具体，优先说明"发生了什么 + 涉及哪家公司/机构 + 与智能制造或产业/资本的关联"，不要复述标题、不要评论、不要编造原文没有的信息。
只输出 JSON，格式：{"items":[{"i":0,"digest":"摘要"}]}`;

const BRIEFING_SYSTEM = `你是资深产业分析师。用户会给你某一天全部 AI / 智能制造相关资讯（标题+来源+摘要）。
请生成一份给手机阅读的「每日简报」，固定分为两大块：
① part1 智能制造产业影响：launch(落地进展)、line(产线变化)、risk(机遇风险)、policy(政策)
② part2 市场与金融资本市场影响：finance(投融资)、capital(资本动向)、chain(产业链)、corp(企业机会风险)
要求：每个要点一句话，尽量具体（公司名、金额、数字、产品），避免空泛套话；某子项当天确实无内容就给空数组；另写 summary 作为 80-120 字的当日总览。
只输出 JSON，格式：{"summary":"","part1":{"launch":[],"line":[],"risk":[],"policy":[]},"part2":{"finance":[],"capital":[],"chain":[],"corp":[]}}`;

/** 调用 DeepSeek chat completions，返回字符串内容。 */
async function chat(cfg, messages, { json = false, timeout = cfg.timeout, retries = 2 } = {}) {
  if (!cfg.apiKey) throw new Error('缺少 DEEPSEEK_API_KEY');
  const body = { model: cfg.model, messages, temperature: cfg.temperature, stream: false };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      const data = JSON.parse(txt);
      return data.choices?.[0]?.message?.content || '';
    } catch (err) {
      lastErr = err;
      if (i < retries) await sleep(1200 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`DeepSeek 调用失败：${lastErr && lastErr.message}`);
}

/** 从可能带 ```json 围栏或前后废话的回复里，尽最大努力取出 JSON。 */
function parseJsonLoose(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const seg = extractBalanced(s, open, close);
    if (seg) {
      try {
        return JSON.parse(seg);
      } catch {
        /* 试下一个 */
      }
    }
  }
  return null;
}

/** 按括号配对截取第一段完整结构（忽略字符串内的括号）。 */
function extractBalanced(s, open, close) {
  const start = s.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 批量生成摘要：返回 Map<index, digest>。失败的批次只记日志，不抛出。 */
async function summarizeItems(cfg, items, { chunkSize = 12, textLimit = 500, log = console.log } = {}) {
  const digests = new Map();
  for (let base = 0; base < items.length; base += chunkSize) {
    const chunk = items.slice(base, base + chunkSize);
    const payload = chunk.map((it, i) => ({
      i: base + i,
      title: it.title,
      source: it.source,
      date: it.time ? it.time.slice(0, 10) : '',
      text: collapse(it.text || '').slice(0, textLimit),
    }));
    try {
      const content = await chat(
        cfg,
        [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        { json: true }
      );
      const parsed = parseJsonLoose(content);
      const rows = Array.isArray(parsed) ? parsed : parsed?.items || parsed?.data || [];
      for (const row of rows) {
        const idx = Number(row.i ?? row.index);
        const dg = collapse(row.digest || row.summary || '');
        if (!isNaN(idx) && dg) digests.set(idx, dg.slice(0, 80));
      }
    } catch (err) {
      log(`  [AI] 摘要批次 ${base}-${base + chunk.length - 1} 失败：${err.message}`);
    }
  }
  return digests;
}

const EMPTY_BRIEFING = {
  summary: '',
  part1: { launch: [], line: [], risk: [], policy: [] },
  part2: { finance: [], capital: [], chain: [], corp: [] },
};

/** 生成当日双板块简报（结构化对象）。失败返回 null，由调用方决定是否保留旧简报。 */
async function buildBriefing(cfg, items, date, { log = console.log } = {}) {
  const payload = items.map((it) => ({
    title: it.title,
    source: it.source,
    digest: it.digest || '',
    date: it.time ? it.time.slice(0, 10) : '',
  }));
  const content = await chat(
    cfg,
    [
      { role: 'system', content: BRIEFING_SYSTEM },
      { role: 'user', content: `日期：${date}\n当日资讯：${JSON.stringify(payload)}` },
    ],
    { json: true, timeout: 120000 }
  );
  return normalizeBriefing(parseJsonLoose(content), date, log);
}

/** 把模型输出规整成固定结构（缺项补空、非数组丢弃）。 */
function normalizeBriefing(raw, date, log = console.log) {
  if (!raw || typeof raw !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v.map((x) => collapse(String(x))).filter(Boolean).slice(0, 8) : []);
  const part1 = raw.part1 || {};
  const part2 = raw.part2 || {};
  const out = {
    summary: collapse(raw.summary || '').slice(0, 240),
    part1: {
      launch: arr(part1.launch),
      line: arr(part1.line),
      risk: arr(part1.risk),
      policy: arr(part1.policy),
    },
    part2: {
      finance: arr(part2.finance),
      capital: arr(part2.capital),
      chain: arr(part2.chain),
      corp: arr(part2.corp),
    },
  };
  const hasAny = out.summary || [...Object.values(out.part1), ...Object.values(out.part2)].some((a) => a.length);
  if (!hasAny) {
    log('  [AI] 简报为空，忽略');
    return null;
  }
  out.date = date;
  return out;
}

module.exports = { chat, parseJsonLoose, summarizeItems, buildBriefing, normalizeBriefing, EMPTY_BRIEFING };
