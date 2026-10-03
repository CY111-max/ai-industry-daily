'use strict';
/**
 * 简报的纯逻辑：覆盖区间匹配、窗口分块去重、二级汇总的输入拼装。
 * 不做任何文件 IO、不发起网络请求 —— 读写见 briefing-store.js，生成见 ai.js。
 */

/** 两个板块的八个子项（与前端 index.html 的 LIB.SUB_LABELS 保持一致）。 */
const SUB_LABELS = {
  part1: [['launch', '落地进展'], ['line', '产线变化'], ['risk', '机遇风险'], ['policy', '政策']],
  part2: [['finance', '投融资'], ['capital', '资本动向'], ['chain', '产业链'], ['corp', '企业机会风险']],
};

/**
 * 挑出「某一批资讯该配哪份简报」。
 * 规则：取满足 to > date 的**最早**一份 —— 也就是生成于该日期之后、且往回覆盖到它的那份。
 * 边界为什么用严格大于：一份简报的 id 就是它的生成日，而它的 to 也等于生成日。
 * 所以 to == date 意味着「这份简报是在该批次当天生成的」—— 那天新生成的那份
 * 属于以该日为起点的下一个周期（下一份的 from 正好等于这一份的 to）。
 * 若批次比所有简报都新（没有 to > date 的），退回最新一份。
 * briefings 为空 → null。
 * （前端 index.html 的 LIB.pickBriefingFor 是同一逻辑的副本，改动须两处同步。）
 */
function pickBriefingFor(briefings, date) {
  const list = (briefings || []).slice().sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  if (!list.length) return null;
  return list.find((b) => b.to > date) || list[list.length - 1];
}

/** 距最新一份简报是否已满 intervalDays 天。从未生成过 → true。 */
function shouldGenerate(briefings, now, intervalDays) {
  const list = briefings || [];
  if (!list.length) return true;
  let latest = list[0].generatedAt;
  for (const b of list) if (b.generatedAt > latest) latest = b.generatedAt;
  return now.getTime() - new Date(latest).getTime() >= intervalDays * 86400000;
}

/**
 * 把窗口内的批次切成若干块，供一级汇总逐块调用大模型。
 * 去重：跨批次按 id 去重 —— 改造前的批次之间是重叠快照，不去重会重复计数。
 * 分块：以批次为单位累积，单块不超过 maxItems；单个批次自身超过 maxItems 时会被拆开。
 * 返回 { chunks, total }，total 是去重后的条目总数（用于记录简报覆盖了多少条）。
 */
function planChunks(batches, maxItems) {
  const seen = new Set();
  const picked = [];
  for (const b of batches) {
    const items = [];
    for (const it of b.items || []) {
      if (!it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    }
    if (items.length) picked.push(items);
  }

  const chunks = [];
  let cur = [];
  for (const items of picked) {
    if (items.length >= maxItems) {
      if (cur.length) { chunks.push(cur); cur = []; }
      for (let i = 0; i < items.length; i += maxItems) chunks.push(items.slice(i, i + maxItems));
      continue;
    }
    if (cur.length + items.length > maxItems) { chunks.push(cur); cur = []; }
    cur.push(...items);
  }
  if (cur.length) chunks.push(cur);
  return { chunks, total: seen.size };
}

/** 条目 → 送进大模型的精简载荷。只保留标题/来源/摘要/日期，绝不带正文。 */
function toBriefingPayload(items) {
  return (items || []).map((it) => ({
    title: it.title,
    source: it.source,
    digest: it.digest || '',
    date: it.time ? it.time.slice(0, 10) : '',
  }));
}

/** 二级汇总的输入文本：把多份阶段简报的八小节要点平铺。 */
function buildMergePayload(chunkBriefings) {
  const lines = [];
  (chunkBriefings || []).forEach((b, i) => {
    lines.push(`【第 ${i + 1} 段】`);
    if (b.summary) lines.push(`总览：${b.summary}`);
    for (const part of ['part1', 'part2']) {
      for (const [k, label] of SUB_LABELS[part]) {
        const arr = (b[part] && b[part][k]) || [];
        if (arr.length) lines.push(`${label}：${arr.join('；')}`);
      }
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

module.exports = { SUB_LABELS, pickBriefingFor, shouldGenerate, planChunks, toBriefingPayload, buildMergePayload };
