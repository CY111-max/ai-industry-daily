# 采集频率与简报频率改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把采集频率从每天两次改为每周一、周四各一次，简报从每批一份改为每 30 天一份且永久保存。

**Architecture:** 批次退化为「本次新增」的纯增量集合（移除跨批次结转）；简报从批次里剥离，成为独立的 `data/briefings/` 存储，由 `run.js` 在采集时按「距上一份满 30 天」触发。30 天的资讯量（约 1800 条）超出单次大模型调用上限，因此简报生成改为两级：一级按批次分块各写一份阶段简报，二级把阶段简报汇总成最终简报。前端简报模块从「读当前批次的字段」改为「按批次日期匹配一份简报并单独请求」。

**Tech Stack:** Node 20（GitHub Actions）/ Node 18+ 本地，零依赖，内置 `node:test` 测试，原生 fetch，原生 JS/CSS 单文件前端。

## Global Constraints

- **不引入任何 npm 依赖**。测试用 Node 内置的 `node:test` + `node:assert/strict`。`package.json` 保持无 `dependencies` / `devDependencies`。
- **Node 版本下限 18**（`engines` 字段现状）。`node:test` 的 `test()` / `describe()` 在 18 可用；Actions 用 Node 20。
- **注释与界面文案一律中文**，与现有代码风格一致（`'use strict';` 开头，顶部一段块注释说明模块职责）。
- **DeepSeek API key 只从环境变量 `DEEPSEEK_API_KEY` 注入**，绝不写进代码、测试或仓库。
- **落盘的批次条目只允许含 `{id, title, source, time, url, digest}`**。抓取到的正文（`text` / `rawText` 字段）绝不能进入导出的 JSON —— 这是现有 `toExport()` 保证的不变量，改造后必须继续成立。
- **简报文件永不删除**。`cleanup()` 只能删 `data/` 下匹配 `^(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?\.json$` 的批次文件；`data/briefings/` 是子目录，目录名不匹配该正则，天然免疫。
- **批次文件名格式保持 `YYYY-MM-DD-HHmm.json`**，`slot` 恒为 `0900`。这是为了兼容线上已有的 37 个批次文件，不引入迁移。
- 所有 shell 命令在仓库根目录执行：`C:\Users\33723\ai-industry-daily`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `collector/briefing.js` | **新建**。简报纯逻辑：覆盖区间匹配、窗口分块去重、二级汇总输入拼装。无 IO、无网络 |
| `collector/briefing-store.js` | **新建**。简报落盘与读取：`briefings/` 目录读写、按区间加载批次 |
| `collector/ai.js` | 追加两级汇总：`buildChunkBriefing()` / `mergeBriefings()` |
| `collector/run.js` | 批次改纯增量；移除批次内嵌简报；接入简报触发 |
| `collector/config.js` | 保留期 30→90 天；新增简报间隔与分块上限 |
| `collector/dedupe.js` | 去重窗口默认值 7→14 天 |
| `test/dedupe.test.js` | **新建**。去重窗口 |
| `test/briefing.test.js` | **新建**。简报匹配 / 分块 / 汇总载荷 |
| `test/briefing-store.test.js` | **新建**。简报读写与区间加载 |
| `test/ai-briefing.test.js` | **新建**。两级汇总的输出规整（注入假 `chatFn`） |
| `.github/workflows/daily.yml` | crons 改为周一/周四三条 |
| `index.html` | 简报模块改为按批次日期匹配 |
| `README.md` | 同步文档 |

拆分理由：`briefing.js` 与 `briefing-store.js` 分开，是因为前者是本次改造里最容易写错的规则逻辑（匹配、去重、分块），分开后可以完全不碰文件系统地密集测试；后者是薄的 IO 层。

---

### Task 1: 测试脚手架 + 去重窗口 7→14 天

**Files:**
- Modify: `package.json`
- Modify: `collector/dedupe.js:60`（`loadSeenIds` 的 `windowDays` 默认值）
- Test: `test/dedupe.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `npm test` 可运行；`loadSeenIds(dataDir, { windowDays = 14, now = new Date() })` 返回 `Set<string>`

- [ ] **Step 1: 加测试脚本**

修改 `package.json` 的 `scripts`，加一行：

```json
  "scripts": {
    "collect": "node collector/run.js",
    "collect:dry": "node collector/run.js --dry-run",
    "serve": "node serve.js",
    "test": "node --test"
  },
```

> 注意：**不能**写成 `node --test test/`。实测在 Node 24.16.0 上带路径参数会把 `test` 当文件解析并报 `MODULE_NOT_FOUND`。
> 不带参数的 `node --test` 用内置的默认发现规则（`**/*.test.js` 与 `test/**/*.js`），Node 18/20/24 都可用，
> 本项目里也只会扫到 `test/*.test.js` 这几个文件。

- [ ] **Step 2: 写失败的测试**

新建 `test/dedupe.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSeenIds } = require('../collector/dedupe');

/** 造一个临时 data 目录，按 {文件名: 对象} 写入批次文件。 */
function tmpData(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-dedupe-'));
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj), 'utf8');
  }
  return dir;
}
const batch = (date, ids) => ({ date, items: ids.map((id) => ({ id })) });
const NOW = new Date('2026-10-03T00:00:00Z');

test('默认窗口是 14 天：12 天前的批次仍计入', () => {
  const dir = tmpData({ '2026-09-21-0900.json': batch('2026-09-21', ['a']) });
  assert.equal(loadSeenIds(dir, { now: NOW }).has('a'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('默认窗口是 14 天：16 天前的批次不计入', () => {
  const dir = tmpData({ '2026-09-17-0900.json': batch('2026-09-17', ['b']) });
  assert.equal(loadSeenIds(dir, { now: NOW }).has('b'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('显式传入 windowDays 时覆盖默认值', () => {
  const dir = tmpData({ '2026-09-29-0900.json': batch('2026-09-29', ['c']) });
  assert.equal(loadSeenIds(dir, { now: NOW, windowDays: 1 }).has('c'), false);
  assert.equal(loadSeenIds(dir, { now: NOW, windowDays: 7 }).has('c'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('跨多个批次累积，且忽略 index.json 与子目录', () => {
  const dir = tmpData({
    '2026-10-01-0900.json': batch('2026-10-01', ['x', 'y']),
    '2026-09-29-0900.json': batch('2026-09-29', ['z']),
    'index.json': { batches: [] },
  });
  fs.mkdirSync(path.join(dir, 'briefings'));
  const seen = loadSeenIds(dir, { now: NOW });
  assert.deepEqual([...seen].sort(), ['x', 'y', 'z']);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `npm test`
Expected: 第一个用例 FAIL（12 天前的条目在 7 天窗口下被判为不计入），其余通过。

- [ ] **Step 4: 改默认窗口**

修改 `collector/dedupe.js` 第 60 行附近，把默认值从 7 改为 14，并补一句理由：

```js
/**
 * 收集近 windowDays 天内已收录的 id（用于跨天、跨批次去重）。
 * 窗口取 14 天：采集频率是每周两次，漏跑一次就是 6 天空窗，
 * 原来 7 天的窗口在连续两次失败时会漏收资讯。
 * 注意：**不排除**任何批次——同一个批次重复运行时应只捞到「真正新增」的条目，
 * 已有条目由 run.js 读本批次自己的文件负责带过来。
 */
function loadSeenIds(dataDir, { windowDays = 14, now = new Date() } = {}) {
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test`
Expected: 4 个用例全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json collector/dedupe.js test/dedupe.test.js
git commit -m "test: 引入 node:test 测试脚手架；去重窗口 7→14 天"
```

---

### Task 2: 简报纯逻辑 `collector/briefing.js`

**Files:**
- Create: `collector/briefing.js`
- Test: `test/briefing.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `SUB_LABELS` — `{ part1: [[key, 中文label], ...], part2: [...] }`
  - `pickBriefingFor(briefings, date) → briefingMeta | null`
  - `shouldGenerate(briefings, now: Date, intervalDays: number) → boolean`
  - `planChunks(batches, maxItems: number) → { chunks: item[][], total: number }`
  - `buildMergePayload(chunkBriefings) → string`
  - `toBriefingPayload(items) → {title, source, digest, date}[]`

briefingMeta 形状：`{ id, from, to, itemCount, batchCount, generatedAt }`，`from` / `to` 是 `YYYY-MM-DD` 字符串。
item 形状：`{ id, title, source, time, url, digest }`。

- [ ] **Step 1: 写失败的测试**

新建 `test/briefing.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickBriefingFor, shouldGenerate, planChunks, buildMergePayload, toBriefingPayload } =
  require('../collector/briefing');

const B_SEP = { id: '2026-09-02', from: '2026-08-03', to: '2026-09-02' };
const B_OCT = { id: '2026-10-02', from: '2026-09-02', to: '2026-10-02' };

test('pickBriefingFor：批次落在某份简报区间内 → 选覆盖它的那份', () => {
  assert.equal(pickBriefingFor([B_SEP, B_OCT], '2026-09-15').id, '2026-10-02');
  assert.equal(pickBriefingFor([B_SEP, B_OCT], '2026-08-20').id, '2026-09-02');
});

test('pickBriefingFor：边界日归属覆盖它的那份', () => {
  assert.equal(pickBriefingFor([B_SEP, B_OCT], '2026-10-02').id, '2026-10-02');
  assert.equal(pickBriefingFor([B_SEP, B_OCT], '2026-09-02').id, '2026-10-02');
});

test('pickBriefingFor：批次早于所有简报 → 选最早一份', () => {
  assert.equal(pickBriefingFor([B_SEP, B_OCT], '2026-07-01').id, '2026-09-02');
});

test('pickBriefingFor：批次比所有简报都新 → 退回最新一份', () => {
  assert.equal(pickBriefingFor([B_SEP, B_OCT], '2026-10-05').id, '2026-10-02');
});

test('pickBriefingFor：输入乱序结果一致', () => {
  assert.equal(pickBriefingFor([B_OCT, B_SEP], '2026-09-15').id, '2026-10-02');
});

test('pickBriefingFor：没有简报 → null', () => {
  assert.equal(pickBriefingFor([], '2026-10-05'), null);
  assert.equal(pickBriefingFor(null, '2026-10-05'), null);
});

test('shouldGenerate：从未生成过 → true', () => {
  assert.equal(shouldGenerate([], new Date('2026-10-03T00:00:00Z'), 30), true);
});

test('shouldGenerate：满 30 天 → true，差一天 → false', () => {
  const bs = [{ generatedAt: '2026-09-03T00:00:00Z' }];
  assert.equal(shouldGenerate(bs, new Date('2026-10-03T00:00:00Z'), 30), true);
  assert.equal(shouldGenerate(bs, new Date('2026-10-02T00:00:00Z'), 30), false);
});

test('shouldGenerate：取最新的一份判断，与数组顺序无关', () => {
  const bs = [{ generatedAt: '2026-08-01T00:00:00Z' }, { generatedAt: '2026-09-20T00:00:00Z' }];
  assert.equal(shouldGenerate(bs, new Date('2026-10-03T00:00:00Z'), 30), false);
});

test('planChunks：跨批次按 id 去重', () => {
  const batches = [{ items: [{ id: 'a' }, { id: 'b' }] }, { items: [{ id: 'b' }, { id: 'c' }] }];
  const { chunks, total } = planChunks(batches, 100);
  assert.equal(total, 3);
  assert.deepEqual(chunks.flat().map((i) => i.id), ['a', 'b', 'c']);
});

test('planChunks：以批次为单位累积，超过上限就开新块', () => {
  const batches = [{ items: [{ id: 'a' }, { id: 'b' }] }, { items: [{ id: 'c' }, { id: 'd' }] }];
  const { chunks } = planChunks(batches, 3);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].map((i) => i.id), ['a', 'b']);
  assert.deepEqual(chunks[1].map((i) => i.id), ['c', 'd']);
});

test('planChunks：单个批次自身超过上限时被拆开', () => {
  const items = [1, 2, 3, 4, 5].map((n) => ({ id: 'x' + n }));
  const { chunks } = planChunks([{ items }], 2);
  assert.deepEqual(chunks.map((c) => c.length), [2, 2, 1]);
  assert.deepEqual(chunks.flat().map((i) => i.id), ['x1', 'x2', 'x3', 'x4', 'x5']);
});

test('planChunks：空批次不产生空块；没有 id 的条目被丢弃', () => {
  const { chunks, total } = planChunks([{ items: [] }, { items: [{ title: '没 id' }, { id: 'a' }] }], 10);
  assert.equal(chunks.length, 1);
  assert.equal(total, 1);
});

test('planChunks：全部为空 → 无块、total 为 0', () => {
  const { chunks, total } = planChunks([{ items: [] }], 10);
  assert.deepEqual(chunks, []);
  assert.equal(total, 0);
});

test('toBriefingPayload：只保留标题/来源/摘要/日期，不泄露正文', () => {
  const out = toBriefingPayload([
    { title: 'T', source: 'S', digest: 'D', time: '2026-10-01T02:00:00.000Z', text: '正文不该出现', rawText: '也不该' },
  ]);
  assert.deepEqual(out, [{ title: 'T', source: 'S', digest: 'D', date: '2026-10-01' }]);
});

test('buildMergePayload：把各段要点平铺并标注段号，空小节不出现', () => {
  const txt = buildMergePayload([
    { summary: '总览一', part1: { launch: ['A 落地'], line: [] }, part2: { finance: ['B 融资'] } },
    { summary: '总览二', part1: { launch: ['C 落地'] } },
  ]);
  assert.match(txt, /【第 1 段】/);
  assert.match(txt, /【第 2 段】/);
  assert.match(txt, /总览：总览一/);
  assert.match(txt, /落地进展：A 落地/);
  assert.match(txt, /投融资：B 融资/);
  assert.match(txt, /落地进展：C 落地/);
  assert.doesNotMatch(txt, /产线变化/);
});

test('buildMergePayload：空输入 → 空串', () => {
  assert.equal(buildMergePayload([]), '');
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test`
Expected: 报 `Cannot find module '../collector/briefing'`，`test/briefing.test.js` 全部失败。

- [ ] **Step 3: 实现**

新建 `collector/briefing.js`：

```js
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
 * 若批次比所有简报都新（没有 to > date 的），退回最新一份。
 * briefings 为空 → null。
 *
 * 边界为什么用严格大于：一份简报的 id 就是它的生成日，而它的 to 也等于生成日。
 * 所以 to == date 意味着「这份简报是在该批次当天生成的」—— 那天新生成的那份
 * 属于以该日为起点的下一个周期（下一份的 from 正好等于这一份的 to）。
 * 例：B1(to=9/2)、B2(to=10/2)，批次 9/2 → 命中 B2（覆盖 9/2~10/2），而不是 B1。
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
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test`
Expected: Task 1 的 4 个 + 本任务 17 个，共 21 个用例全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add collector/briefing.js test/briefing.test.js
git commit -m "feat: 简报纯逻辑模块（区间匹配 / 分块去重 / 汇总载荷）"
```

---

### Task 3: 简报存储 `collector/briefing-store.js`

**Files:**
- Create: `collector/briefing-store.js`
- Test: `test/briefing-store.test.js`（新建）

**Interfaces:**
- Consumes: `listBatches(dataDir)`（来自 `collector/dedupe.js`，返回 `{file, id, date, slot}[]`，按 id 倒序）
- Produces:
  - `listBriefings(dataDir) → briefingMeta[]`（按 `to` 倒序，不含简报正文）
  - `readBriefing(dataDir, id) → doc | null`
  - `writeBriefing(dataDir, doc) → doc`
  - `loadBatchesInRange(dataDir, from, to) → {id, date, slot, items}[]`（按 id 升序，即旧→新）

doc 形状：`{ id, from, to, generatedAt, itemCount, batchCount, briefing }`。

- [ ] **Step 1: 写失败的测试**

新建 `test/briefing-store.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../collector/briefing-store');

function tmpData(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-store-'));
  for (const [name, obj] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  }
  return dir;
}
const doc = (id, from, to, itemCount) => ({
  id, from, to,
  generatedAt: `${id}T01:00:00.000Z`,
  itemCount, batchCount: 3,
  briefing: { summary: `${id} 总览`, part1: { launch: ['x'] }, part2: {} },
});

test('listBriefings：空目录（briefings/ 不存在）→ []', () => {
  const dir = tmpData();
  assert.deepEqual(store.listBriefings(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeBriefing 后能读回，元信息按覆盖结束日倒序', () => {
  const dir = tmpData();
  store.writeBriefing(dir, doc('2026-09-02', '2026-08-03', '2026-09-02', 11));
  store.writeBriefing(dir, doc('2026-10-02', '2026-09-02', '2026-10-02', 22));

  const list = store.listBriefings(dir);
  assert.deepEqual(list.map((b) => b.id), ['2026-10-02', '2026-09-02']);
  assert.equal(list[0].itemCount, 22);
  assert.equal(list[0].briefing, undefined, '元信息里不应带简报正文');

  const back = store.readBriefing(dir, '2026-10-02');
  assert.equal(back.briefing.summary, '2026-10-02 总览');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBriefing：不存在 → null；文件名不合规不会被读到', () => {
  const dir = tmpData({
    'briefings/not-a-date.json': { id: 'x' },
    'briefings/2026-10-02.json.bak': { id: 'y' },
  });
  assert.equal(store.readBriefing(dir, '2026-01-01'), null);
  assert.deepEqual(store.listBriefings(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏的简报文件被跳过，不影响其他', () => {
  // 两个损坏样本：一个是内容合法但声明的 id 不合规，一个是 JSON 本身坏掉。
  // 前者的 fixture 还顺带把 briefings/ 目录建出来，好让下面那行原始写入有地方落。
  const dir = tmpData({ 'briefings/2026-09-01.json': { id: 'bad' } });
  fs.writeFileSync(path.join(dir, 'briefings', '2026-09-02.json'), '{ 坏 JSON', 'utf8');
  store.writeBriefing(dir, doc('2026-10-02', '2026-09-02', '2026-10-02', 5));
  assert.deepEqual(store.listBriefings(dir).map((b) => b.id), ['2026-10-02']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeBriefing：id 不合规直接抛错，且不落盘', () => {
  const dir = tmpData();
  assert.throws(() => store.writeBriefing(dir, doc('not-a-date', 'a', 'b', 1)), /简报 id 不合规/);
  assert.deepEqual(store.listBriefings(dir), []);
  assert.equal(fs.existsSync(path.join(dir, 'briefings')), false, '校验应发生在建目录之前，不该留下空目录');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadBatchesInRange：只取区间内的批次，按旧→新排序', () => {
  const dir = tmpData({
    '2026-08-01-0900.json': { date: '2026-08-01', items: [{ id: 'old' }] },
    '2026-09-15-0900.json': { date: '2026-09-15', items: [{ id: 'mid' }] },
    '2026-10-01-0900.json': { date: '2026-10-01', items: [{ id: 'new' }] },
    'index.json': { batches: [] },
  });
  const got = store.loadBatchesInRange(dir, '2026-09-02', '2026-10-02');
  assert.deepEqual(got.map((b) => b.id), ['2026-09-15-0900', '2026-10-01-0900']);
  assert.deepEqual(got[0].items.map((i) => i.id), ['mid']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadBatchesInRange：区间含旧格式单文件批次（无 slot）', () => {
  const dir = tmpData({
    '2026-09-20.json': { date: '2026-09-20', items: [{ id: 'legacy' }] },
  });
  const got = store.loadBatchesInRange(dir, '2026-09-02', '2026-10-02');
  assert.deepEqual(got.map((b) => b.id), ['2026-09-20']);
  assert.equal(got[0].slot, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test`
Expected: 报 `Cannot find module '../collector/briefing-store'`。

- [ ] **Step 3: 实现**

新建 `collector/briefing-store.js`：

```js
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

/**
 * 列出全部简报的元信息（不含 briefing 正文），按覆盖结束日倒序 —— 最新在前。
 *
 * id 的处理：文件名是存储键（writeBriefing 就是按 id 命名的），文件里的 id 字段只是副本。
 * 万一两者不一致（手改过、或内容写坏了），以**声明出来的 id 为准并校验**：
 * 声明的 id 不合 `YYYY-MM-DD` 就整个跳过，与 readBriefing / writeBriefing 对不合规 id 的态度一致
 * （前者返回 null，后者抛错）。这样索引里不会混进前端无法按 id 取到的条目。
 */
function listBriefings(dataDir) {
  const out = [];
  for (const id of listBriefIds(dataDir)) {
    const d = readJson(fileOf(dataDir, id));
    if (!d) continue; // 单个文件损坏不影响其余
    const docId = d.id || id;
    if (!BRIEF_FILE_RE.test(`${docId}.json`)) continue; // 声明的 id 不合规，视为损坏，跳过
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
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test`
Expected: 全部 PASS（Task 1 的 4 + Task 2 的 17 + 本任务 7 = 28）。

- [ ] **Step 5: 提交**

```bash
git add collector/briefing-store.js test/briefing-store.test.js
git commit -m "feat: 简报存储层（永久保存，不参与清理）"
```

---

### Task 4: 两级汇总 `collector/ai.js` + `collector/config.js`

**Files:**
- Modify: `collector/ai.js`（在 `buildBriefing` 之后追加两个函数；`module.exports` 加两项）
- Modify: `collector/config.js`（保留期与两个新配置）
- Test: `test/ai-briefing.test.js`（新建）

**Interfaces:**
- Consumes: `toBriefingPayload()` / `buildMergePayload()`（Task 2）、`normalizeBriefing()` / `parseJsonLoose()` / `chat()`（`ai.js` 现有）
- Produces:
  - `buildChunkBriefing(cfg, items, label, { log = console.log, chatFn = chat }) → briefing | null`
  - `mergeBriefings(cfg, chunkBriefings, from, to, { log = console.log, chatFn = chat }) → briefing | null`
  - `cfg.briefingIntervalDays: number`（默认 30）
  - `cfg.briefingChunkMax: number`（默认 180，取值理由见 Step 5 的注释）
  - `cfg.retentionDays` 默认 30 → 90

`chatFn` 参数是为了让这两个函数可以在测试里注入假的大模型调用，不必打网络。现有的 `buildBriefing` 不动。

- [ ] **Step 1: 写失败的测试**

新建 `test/ai-briefing.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChunkBriefing, mergeBriefings } = require('../collector/ai');

const noop = () => {};

test('buildChunkBriefing：把模型返回的 JSON 规整成八小节结构', async () => {
  const chatFn = async () =>
    JSON.stringify({
      summary: '本段总览',
      part1: { launch: ['甲'], line: [], risk: [], policy: ['乙'] },
      part2: { finance: ['丙'] },
    });
  const b = await buildChunkBriefing({}, [{ title: 't' }], '段一', { chatFn, log: noop });
  assert.equal(b.summary, '本段总览');
  assert.deepEqual(b.part1.launch, ['甲']);
  assert.deepEqual(b.part1.line, []);
  assert.deepEqual(b.part1.policy, ['乙']);
  assert.deepEqual(b.part2.finance, ['丙']);
});

test('buildChunkBriefing：送进模型的载荷不含正文', async () => {
  let seen = '';
  const chatFn = async (cfg, messages) => {
    seen = messages[1].content;
    return JSON.stringify({ summary: 's' });
  };
  await buildChunkBriefing({}, [{ title: 'T', source: 'S', digest: 'D', text: '正文不该出现' }], '段一',
    { chatFn, log: noop });
  assert.match(seen, /段一/);
  assert.match(seen, /"title":"T"/);
  assert.doesNotMatch(seen, /正文不该出现/);
});

test('buildChunkBriefing：模型返回空内容 → null', async () => {
  const b = await buildChunkBriefing({}, [{ title: 't' }], '段一', { chatFn: async () => '{}', log: noop });
  assert.equal(b, null);
});

test('mergeBriefings：输入里带上覆盖区间与各段要点', async () => {
  let seen = '';
  const chatFn = async (cfg, messages) => {
    seen = messages[1].content;
    return JSON.stringify({ summary: '月度总览', part1: { launch: ['合并后'] }, part2: {} });
  };
  const b = await mergeBriefings(
    {},
    [{ summary: '总览一', part1: { launch: ['甲'] } }, { summary: '总览二', part1: { launch: ['乙'] } }],
    '2026-09-03', '2026-10-03',
    { chatFn, log: noop }
  );
  assert.equal(b.summary, '月度总览');
  assert.match(seen, /2026-09-03 ~ 2026-10-03/);
  assert.match(seen, /【第 1 段】/);
  assert.match(seen, /【第 2 段】/);
  assert.match(seen, /落地进展：甲/);
  assert.match(seen, /落地进展：乙/);
});

test('mergeBriefings：模型返回空内容 → null', async () => {
  const b = await mergeBriefings({}, [{ summary: 'x' }], 'a', 'b', { chatFn: async () => 'null', log: noop });
  assert.equal(b, null);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test`
Expected: 报 `buildChunkBriefing is not a function`。

- [ ] **Step 3: 实现 ai.js 的两个函数**

在 `collector/ai.js` 顶部 `const { collapse } = require('./fetch-utils');` 下面加一行引入：

```js
const { toBriefingPayload, buildMergePayload } = require('./briefing');
```

在 `BRIEFING_SYSTEM` 常量之后加二级汇总专用的提示词：

```js
const MERGE_SYSTEM = `你是资深产业分析师。用户会给你同一时间段内、分成若干段的「阶段简报」（每段含总览与要点，结构相同）。
请把它们汇总成一份给手机阅读的「月度简报」，固定分为两大块：
① part1 智能制造产业影响：launch(落地进展)、line(产线变化)、risk(机遇风险)、policy(政策)
② part2 市场与金融资本市场影响：finance(投融资)、capital(资本动向)、chain(产业链)、corp(企业机会风险)
要求：合并同类项、去掉重复、按重要性取舍，不要简单罗列；每个要点一句话，尽量具体（公司名、金额、数字、产品），避免空泛套话；某子项确实无内容就给空数组；另写 summary 作为 100-160 字的本期总览。
只输出 JSON，格式：{"summary":"","part1":{"launch":[],"line":[],"risk":[],"policy":[]},"part2":{"finance":[],"capital":[],"chain":[],"corp":[]}}`;
```

在 `buildBriefing` 函数之后、`normalizeBriefing` 之前插入：

```js
/**
 * 一级汇总：对一块条目生成「阶段简报」，输出结构与最终简报相同。
 * chatFn 可注入，便于测试；生产环境用默认的 chat。
 * 失败不抛出，由调用方决定是跳过这一段还是整体放弃。
 */
async function buildChunkBriefing(cfg, items, label, { log = console.log, chatFn = chat } = {}) {
  const content = await chatFn(
    cfg,
    [
      { role: 'system', content: BRIEFING_SYSTEM },
      { role: 'user', content: `时间段：${label}\n该段资讯：${JSON.stringify(toBriefingPayload(items))}` },
    ],
    { json: true, timeout: 120000 }
  );
  return normalizeBriefing(parseJsonLoose(content), label, log);
}

/**
 * 二级汇总：把多份阶段简报合并成最终简报。
 * 输入是已经压缩过的阶段简报（每段约 2500 字），9 段合计约 2.3 万字，
 * 远低于一次调用塞 1800 条原始资讯的体积 —— 这就是必须分两级的原因。
 */
async function mergeBriefings(cfg, chunkBriefings, from, to, { log = console.log, chatFn = chat } = {}) {
  const content = await chatFn(
    cfg,
    [
      { role: 'system', content: MERGE_SYSTEM },
      { role: 'user', content: `覆盖区间：${from} ~ ${to}\n各阶段简报：\n${buildMergePayload(chunkBriefings)}` },
    ],
    { json: true, timeout: 120000 }
  );
  return normalizeBriefing(parseJsonLoose(content), `${from}~${to}`, log);
}
```

把文件末尾的导出改为：

```js
module.exports = {
  chat, parseJsonLoose, summarizeItems,
  buildBriefing, buildChunkBriefing, mergeBriefings, normalizeBriefing, EMPTY_BRIEFING,
};
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test`
Expected: 33 个用例全部 PASS。

- [ ] **Step 5: 改 config.js**

把 `collector/config.js` 改为（保留期 30→90，新增两项）：

```js
'use strict';
/** 运行时配置（全部可用环境变量覆盖，密钥只从环境注入，不写进仓库）。 */
const path = require('node:path');

module.exports = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    temperature: 0.3,
    timeout: 90000,
  },
  dataDir: path.join(__dirname, '..', 'data'),
  /**
   * 批次数据保留天数（超出会被清理）。
   * 必须大于 briefingIntervalDays：生成简报要回头读最近 30 天的批次，
   * 保留期短于这个窗口就会把自己的输入删掉。简报本身永久保存，不受此限制。
   */
  retentionDays: Number(process.env.RETENTION_DAYS || 90),
  /** 距上一份简报满多少天生成新的一份。 */
  briefingIntervalDays: Number(process.env.BRIEFING_INTERVAL_DAYS || 30),
  /**
   * 一级汇总单块最多多少条资讯（超过会拆块，防止单次调用超上下文）。
   * 取 180 是因为一次采集约 180 条（3 天 × 60 条/天），
   * 这样「一个批次 ≈ 一个块」，批次本身就是自然的语义单元，不需要额外切分逻辑。
   */
  briefingChunkMax: Number(process.env.BRIEFING_CHUNK_MAX || 180),
  /** 每个源每次最多补抓多少条详情页。 */
  maxDetailPerSource: Number(process.env.MAX_DETAIL_PER_SOURCE || 15),
  /** 详情页抓取并发数。 */
  concurrency: Number(process.env.FETCH_CONCURRENCY || 4),
  /** 单条资讯送进大模型的最大正文字数。 */
  textLimit: 500,
};
```

- [ ] **Step 6: 跑测试，确认仍然通过**

Run: `npm test`
Expected: 33 个用例全部 PASS（config 不影响测试）。

- [ ] **Step 7: 提交**

```bash
git add collector/ai.js collector/config.js test/ai-briefing.test.js
git commit -m "feat: 两级简报汇总 + 保留期 90 天 + 简报间隔配置"
```

---

### Task 5: `collector/run.js` 批次改纯增量 + 接入简报生成

**Files:**
- Modify: `collector/run.js`（顶部引入、`loadBase`→`loadOwn`、`main()` 第 4~7 步、`updateIndex()`）

**Interfaces:**
- Consumes: `briefing.*`（Task 2）、`briefingStore.*`（Task 3）、`ai.buildChunkBriefing` / `ai.mergeBriefings`（Task 4）、`cfg.briefingIntervalDays` / `cfg.briefingChunkMax`（Task 4）
- Produces: `data/YYYY-MM-DD-0900.json`（无 `briefing` 字段）、`data/briefings/YYYY-MM-DD.json`、`data/index.json`（新增 `briefings` 数组）

这个任务是编排层，验证方式是端到端 dry-run（Step 6~9），不写单元测试。

- [ ] **Step 1: 顶部引入**

`collector/run.js` 第 26 行附近的 require 区域，改为：

```js
const { idFor, loadSeenIds, listBatches } = require('./dedupe');
const ai = require('./ai');
const briefing = require('./briefing');
const briefingStore = require('./briefing-store');
```

同时把文件顶部块注释里的「全量快照」「互不覆盖」段落换成新语义：

```js
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
```

- [ ] **Step 2: `loadBase` 换成 `loadOwn`**

把 `collector/run.js` 第 137~151 行整段（`// ---------- 批次底稿 ----------` 到 `loadBase` 结束）替换为：

```js
// ---------- 批次底稿 ----------
/**
 * 同批次重复运行（兜底触发）时的底稿：只看本批次自己的文件。
 * 不再跨批次结转 —— 批次是纯增量，每次采集只装本次新增。
 */
function loadOwn(batchId) {
  const own = readJson(batchFile(batchId));
  return { items: (own && own.items) || [], exists: !!own };
}
```

- [ ] **Step 3: `updateIndex` 带上 briefings**

把 `collector/run.js` 的 `updateIndex()` 替换为：

```js
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
```

- [ ] **Step 4: 新增简报生成函数**

在 `cleanup()` 之后、`// ---------- 主流程 ----------` 之前插入：

```js
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
```

- [ ] **Step 5: 改 `main()` 的第 0 步、第 2 步、第 5~8 步**

把 `main()` 里以下几处改掉，其余（抓取、补详情、AI 摘要）保持不变：

第 0 步（底稿）：

```js
  // 0) 底稿：只含本批次已有的条目，不再跨批次结转
  const own = loadOwn(batchId);
  const baseItems = own.items;
  log(`[底稿] ${own.exists ? `本批次已有 ${baseItems.length} 条` : '新批次，从零开始'}`);
```

原第 0 步末尾那行 `const fileExists = !!readJson(batchFile(batchId));` **删掉** ——
它和 `own.exists` 是同一件事（`loadOwn` 内部就是读同一个文件），留着会变成没人用的变量，
而且两处判断可能不一致。第 7 步改用 `own.exists`。

第 2 步（去重窗口）：

```js
  // 2) 去重：近 14 天所有批次里出现过的 id 都不再收（每周两次采集，漏跑一次就是 6 天空窗）
  const seen = loadSeenIds(cfg.dataDir, { windowDays: 14 });
```

第 5 步（合并）保持不变，注释改为：

```js
  // 5) 合并成本批次内容（底稿 + 本次新增）
```

第 6 步整段（原「简报：只有出现新条目或还没有简报时才重算」，含 `let briefing = base.briefing;` 那一段）**删掉**。

第 7 步（落盘）替换为：

```js
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
```

- [ ] **Step 6: 语法检查 + 单源 dry-run**

Run:
```bash
node --check collector/run.js
node collector/run.js --dry-run --date=2026-10-05 --slot=0900 --source=qbitai
```
Expected：语法检查无输出；dry-run 打印 `=== 批次 2026-10-05-0900（09:00） [dry-run] ===`、`[底稿] 新批次，从零开始`、若干 `[源] 量子位：…`、`[去重] …`、`[写入] 2026-10-05-0900.json: …`、`[简报] dry-run 或无 AI key，跳过生成`、`[完成] 历史批次共 N 个`。无报错。

- [ ] **Step 7: 确认落盘文件不含 briefing 也不含正文**

Run:
```bash
node -e "
const d=JSON.parse(require('fs').readFileSync('data/2026-10-05-0900.json','utf8'));
console.log('顶层字段:', Object.keys(d).join(','));
console.log('有 briefing 字段:', 'briefing' in d);
console.log('条目字段:', Object.keys(d.items[0]).join(','));
"
```
Expected：顶层字段为 `id,date,slot,slotLabel,generation,updatedAt,items`；`有 briefing 字段: false`；条目字段为 `id,title,source,time,url,digest`（**不含** `text` / `rawText`）。

- [ ] **Step 8: 确认重复运行幂等**

Run:
```bash
BEFORE=$(md5sum data/2026-10-05-0900.json | cut -d' ' -f1)
node collector/run.js --dry-run --date=2026-10-05 --slot=0900 --source=qbitai 2>&1 | tail -4
AFTER=$(md5sum data/2026-10-05-0900.json | cut -d' ' -f1)
echo "文件未变: $([ "$BEFORE" = "$AFTER" ] && echo 是 || echo 否)"
```
Expected：倒数第三行左右出现 `[结果] 本批次无新增内容，未改写文件`；`文件未变: 是`。

- [ ] **Step 9: 清理测试产物**

Run:
```bash
rm -f data/2026-10-05-0900.json
git checkout data/index.json
git status --short
```
Expected：只剩 `M collector/run.js` 一项；`data/` 下没有多余文件（dry-run 不会写简报，`updateIndex()` 对 `index.json` 的改动已被 `git checkout` 还原）。

- [ ] **Step 10: 提交**

```bash
git add collector/run.js
git commit -m "feat: 批次改纯增量；简报从批次剥离，按 30 天触发两级生成"
```

---

### Task 6: workflow 排期改为周一/周四

**Files:**
- Modify: `.github/workflows/daily.yml`

**Interfaces:**
- Consumes: `run.js --slot=0900`（Task 5）
- Produces: 无（CI 配置）

- [ ] **Step 1: 改 crons 与 slot 映射**

把 `on.schedule` 与采集步骤的 `case` 分别替换为：

```yaml
on:
  schedule:
    # 每周一、周四各采集一次（北京 09:00），提前三次兜底。
    # GitHub 的 schedule 是「尽力而为」，实测排队延迟 1.5~6 小时。
    # 注意星期字段：UTC 的周日/周三 22:40 对应北京的周一/周四 06:40。
    - cron: '40 22 * * 0,3'   # 北京 周一/周四 06:40
    - cron: '40 23 * * 0,3'   # 北京 周一/周四 07:40
    - cron: '40 0 * * 1,4'    # 北京 周一/周四 08:40
  workflow_dispatch:
    inputs:
      date:
        description: '指定日期（YYYY-MM-DD，留空=今天，北京时间）'
        required: false
      dry_run:
        description: '只抓取不调用大模型（跳过摘要与简报）'
        type: boolean
        default: false
```

```yaml
          # 批次由「哪个 cron 触发」决定，不由运行时刻推断：
          # 排期本身会延迟 1.5~6 小时，用墙上时间推断会把批次归错日期。
          # 一天只有一个批次，所以三条 cron 全部映射到 0900。
          SLOT=""
          case "${{ github.event.schedule }}" in
            "40 22 * * 0,3"|"40 23 * * 0,3"|"40 0 * * 1,4") SLOT="--slot=0900" ;;
          esac
```

`concurrency`、`permissions`、提交步骤均不动。

- [ ] **Step 2: 用真实日期换算验证 cron 与北京时间的对应**

Run:
```bash
node -e "
const days=['周日','周一','周二','周三','周四','周五','周六'];
// 2026-10-04 是周日
const cases=[[0,22,40],[0,23,40],[3,22,40],[3,23,40],[1,0,40],[4,0,40]];
for(const [dow,h,m] of cases){
  const utc=new Date(Date.UTC(2026,9,4+dow,h,m));
  const bj=new Date(utc.getTime()+8*3600*1000);
  const p=n=>String(n).padStart(2,'0');
  console.log('UTC',days[dow],p(h)+':'+p(m),'→ 北京',days[bj.getUTCDay()],p(bj.getUTCHours())+':'+p(bj.getUTCMinutes()));
}"
```
Expected（逐行核对，六个 UTC 时刻两两合并成三条 cron）：
```
UTC 周日 22:40 → 北京 周一 06:40
UTC 周日 23:40 → 北京 周一 07:40
UTC 周三 22:40 → 北京 周四 06:40
UTC 周三 23:40 → 北京 周四 07:40
UTC 周一 00:40 → 北京 周一 08:40
UTC 周四 00:40 → 北京 周四 08:40
```

- [ ] **Step 3: 确认文件里只有三条 cron，且 case 覆盖全部三条**

Run:
```bash
grep -n "cron:" .github/workflows/daily.yml
grep -n "SLOT=" .github/workflows/daily.yml
```
Expected：`grep cron:` 恰好 3 行；`SLOT=` 那行的 case 分支里逐一列出这 3 条表达式字符串，与上面完全一致。

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/daily.yml
git commit -m "ci: 采集改为每周一、周四三次兜底（北京 09:00）"
```

---

### Task 7: 前端简报模块改为按批次日期匹配

**Files:**
- Modify: `index.html`（`<style>` 加一条规则；`LIB` 加三个成员；UI 层改 `state`、`pruneCache`、`renderBriefing`、`copyBriefing`）

**Interfaces:**
- Consumes: `data/index.json` 的 `briefings` 数组（Task 5）、`data/briefings/<id>.json`（Task 3）
- Produces: 无（终端 UI）

- [ ] **Step 1: 加覆盖区间标签的样式**

在 `index.html` 的 `<style>` 里，`.brief-sum` 规则之前加一行：

```css
  .brief-range{font-size:12px;color:var(--ink3);margin-bottom:8px}
```

- [ ] **Step 2: LIB 加简报工具**

在 `index.html` 里 `const KEY_CUSTOM = 'aid_custom';` 之后加：

```js
  const KEY_BRIEF = 'aid_brief_';
```

在 `batchLabel` 之后（`function fmtStamp` 之前）加：

```js
  /** index.json 里的简报元信息数组（没有则空）。 */
  const briefings = (index) => (index && Array.isArray(index.briefings) ? index.briefings : []);

  /**
   * 挑出某批资讯该配哪份简报：取满足 to > date 的最早一份
   * （即生成于该日期之后、且往回覆盖到它的那份）。
   * 边界用严格大于：to == date 的那份属于以该日为起点的下一个周期。
   * 批次比所有简报都新 → 退回最新一份；没有简报 → null。
   *
   * 这段必须与 collector/briefing.js 的 pickBriefingFor 行为完全一致
   * （单文件 H5 无构建步骤，没法 require Node 模块，只能各存一份）。
   */
  function pickBriefingFor(list, date) {
    const bs = (list || []).slice().sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    if (!bs.length) return null;
    return bs.find((b) => b.to > date) || bs[bs.length - 1];
  }
```

把 `LIB` 的 return 改为（加三项）：

```js
  return {
    PRESET, SUB_LABELS, PART_TITLES,
    KEY_INDEX, KEY_DAY, KEY_SEL, KEY_CUSTOM, KEY_BRIEF,
    readCache, writeCache, allWords, defOf, matchWords, heat, filterItems,
    fmtTime, fmtDate, weekOf, fmtStamp, esc, highlight, briefingText,
    batches, latestBatch, slotText, batchLabel, briefings, pickBriefingFor,
  };
```

- [ ] **Step 3: `state` 加两个字段、`pruneCache` 一并清理简报缓存**

`state` 对象加两行：

```js
    briefId: null,    // 当前正在展示的简报 id
    briefDoc: null,   // 对应的简报正文（用于复制）
```

`pruneCache()` 替换为：

```js
  /** 本机只保留最近 7 个批次快照 + 最近 12 份简报，避免 localStorage 越用越满。 */
  function pruneCache() {
    const keepDays = new Set(LIB.batches(state.index).slice(0, 7).map((b) => LIB.KEY_DAY + b.id));
    const keepBriefs = new Set(LIB.briefings(state.index).slice(0, 12).map((b) => LIB.KEY_BRIEF + b.id));
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(LIB.KEY_DAY) && !keepDays.has(k)) drop.push(k);
      else if (k.startsWith(LIB.KEY_BRIEF) && !keepBriefs.has(k)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  }
```

- [ ] **Step 4: `renderBriefing` 改成按批次匹配 + 单独请求**

把 `renderBriefing()` 整个函数替换为下面两个函数：

```js
  let briefSeq = 0;
  /** 当前批次该配哪份简报的元信息（没有则 null）。 */
  function targetBriefing() {
    const day = state.day || {};
    return LIB.pickBriefingFor(LIB.briefings(state.index), day.date || '');
  }

  async function renderBriefing() {
    const el = $('briefing');
    const meta = targetBriefing();
    if (!meta) {
      state.briefId = null; state.briefDoc = null;
      el.innerHTML = '<div class="empty">当时尚未生成简报<br><span style="font-size:12px">每 30 天生成一份，覆盖最近 30 天</span></div>';
      return;
    }
    if (state.briefId === meta.id && state.briefDoc) return;   // 已经画过同一份，不重复请求

    const cached = LIB.readCache(LIB.KEY_BRIEF + meta.id);
    if (cached) {
      state.briefId = meta.id; state.briefDoc = cached;
      paintBriefing(meta, cached);
      return;
    }

    const seq = ++briefSeq;
    el.innerHTML = '<div class="empty">简报加载中…</div>';
    try {
      const doc = await fetchJson(`briefings/${meta.id}.json`);
      LIB.writeCache(LIB.KEY_BRIEF + meta.id, doc);
      if (seq !== briefSeq) return;   // 期间用户已切到别的批次
      state.briefId = meta.id; state.briefDoc = doc;
      paintBriefing(meta, doc);
    } catch {
      if (seq !== briefSeq) return;
      el.innerHTML = '<div class="empty">简报加载失败，点右上角刷新重试</div>';
    }
  }

  /** 画简报：顶部标出覆盖区间，正文结构不变。 */
  function paintBriefing(meta, doc) {
    const el = $('briefing');
    const b = doc && doc.briefing;
    if (!b) {
      el.innerHTML = '<div class="empty">本期简报内容为空</div>';
      return;
    }
    let html = meta
      ? `<div class="brief-range">覆盖 ${LIB.fmtDate(meta.from)} ~ ${LIB.fmtDate(meta.to)} · 共 ${meta.itemCount} 条资讯</div>`
      : '';
    html += b.summary ? `<div class="brief-sum">${LIB.esc(b.summary)}</div>` : '';
    for (const part of ['part1', 'part2']) {
      const block = b[part];
      if (!block) continue;
      let inner = '';
      for (const [k, label] of LIB.SUB_LABELS[part]) {
        const arr = block[k] || [];
        if (!arr.length) continue;
        inner += `<div class="sub"><b>${label}</b><ul>${arr.map((x) => `<li>${LIB.esc(x)}</li>`).join('')}</ul></div>`;
      }
      if (!inner) continue;
      html += `<div class="part"><h4>${LIB.PART_TITLES[part]}</h4>${inner}</div>`;
    }
    html += `<div style="margin-top:12px"><button class="btn small" id="btnCopy">复制简报全文</button></div>`;
    el.innerHTML = html;
    $('btnCopy').addEventListener('click', copyBriefing);
  }
```

- [ ] **Step 5: `copyBriefing` 用缓存的简报正文与覆盖区间**

把 `copyBriefing()` 替换为：

```js
  async function copyBriefing() {
    const doc = state.briefDoc || {};
    const meta = targetBriefing();
    const label = meta ? `${LIB.fmtDate(meta.from)} ~ ${LIB.fmtDate(meta.to)}` : '';
    const txt = LIB.briefingText(label, doc.briefing);
    if (!txt) return toast('暂无可复制的简报');
    try {
      await navigator.clipboard.writeText(txt);
      toast('已复制简报全文');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制简报全文'); } catch { toast('复制失败，请长按选择'); }
      ta.remove();
    }
  }
```

`render()` 里对 `renderBriefing()` 的调用不用改（现在是异步的，fire-and-forget 即可）。

- [ ] **Step 6: 造一份测试简报，端到端验证渲染**

线上还没有简报文件，所以先临时造一份假数据 —— 这样不用 API key 也能验证整条链路。注意 CDP 每次都用全新的 Chrome 临时 profile，localStorage 是空的，不会有缓存干扰。

```bash
node -e "
const fs=require('fs');
fs.mkdirSync('data/briefings',{recursive:true});
fs.writeFileSync('data/briefings/2026-10-02.json', JSON.stringify({
  id:'2026-10-02', from:'2026-09-02', to:'2026-10-02',
  generatedAt:'2026-10-02T01:20:00.000Z', itemCount:1794, batchCount:9,
  briefing:{ summary:'本期智能制造与资本市场要点总览（测试数据）。',
    part1:{launch:['某公司发布新一代工业大模型'],line:['某工厂产线自动化率提升'],risk:['算力成本上行'],policy:['某地发布智能制造补贴']},
    part2:{finance:['某具身智能公司完成 B 轮融资'],capital:['产业基金规模扩大'],chain:['减速器供应紧张'],corp:['某上市公司加码机器人业务']}}
},null,2));
const idx=JSON.parse(fs.readFileSync('data/index.json','utf8'));
idx.briefings=[{id:'2026-10-02',from:'2026-09-02',to:'2026-10-02',itemCount:1794,batchCount:9,generatedAt:'2026-10-02T01:20:00.000Z'}];
fs.writeFileSync('data/index.json', JSON.stringify(idx,null,2));
console.log('已写入测试简报；index 批次总数', idx.batches.length, '最新批次', idx.latest);
"
```

Expected：打印 `已写入测试简报；index 批次总数 … 最新批次 …`。

- [ ] **Step 7: 起服务，用 CDP 在 390px 真实移动视口验证**

```bash
node serve.js
```

另开一个终端：

```bash
node _cdp.js "http://127.0.0.1:8777/index.html" _b 0 --wait=4500 \
  --eval="({label:document.getElementById('dateLabel').textContent,
    range:(document.querySelector('.brief-range')||{}).textContent||'(无)',
    summary:(document.querySelector('.brief-sum')||{}).textContent||'(无)',
    subs:[...document.querySelectorAll('#briefing .sub b')].map(e=>e.textContent),
    first:[...document.querySelectorAll('#briefing .sub li')].map(e=>e.textContent)[0],
    items:document.querySelectorAll('#list .item').length,
    words:document.querySelectorAll('#cloud .word').length})"
```

Expected（页面默认停在最新批次，即假简报覆盖区间内）：
- `range` = `覆盖 9月2日 ~ 10月2日 · 共 1794 条资讯`
- `summary` = `本期智能制造与资本市场要点总览（测试数据）。`
- `subs` = `["落地进展","产线变化","机遇风险","政策","投融资","资本动向","产业链","企业机会风险"]`（八个都在，顺序一致）
- `first` = `某公司发布新一代工业大模型`
- `items` 与 `words` 均为大于 0 的正常数值
- 末尾 `metrics: {"iw":390,"sw":390,...}`（`sw` 等于 `iw`，无横向溢出）
- 末尾 `页面无 JS 报错 ✓`

- [ ] **Step 8: 验证匹配规则与空态**

匹配规则（纯函数，直接注入假 index）：

```bash
node _cdp.js "http://127.0.0.1:8777/index.html" _t 0 --wait=4500 \
  --eval="(()=>{const L=LIB;
    const bs=[{id:'2026-09-02',from:'2026-08-03',to:'2026-09-02',itemCount:11},
              {id:'2026-10-02',from:'2026-09-02',to:'2026-10-02',itemCount:22}];
    return ['2026-08-20','2026-09-15','2026-10-02','2026-10-09','2026-07-01','2026-01-01'].map(d=>d+' → '+(L.pickBriefingFor(bs,d)||{id:'null'}).id)})()"
```

Expected（逐条核对）：
```
2026-08-20 → 2026-09-02
2026-09-15 → 2026-10-02
2026-10-02 → 2026-10-02
2026-10-09 → 2026-10-02
2026-07-01 → 2026-09-02
2026-01-01 → 2026-09-02
```

空态（去掉简报后应显示提示而不是空白）：临时把 index 里的 `briefings` 清空再截一次：

```bash
node -e "
const fs=require('fs');
const p='data/index.json';
const i=JSON.parse(fs.readFileSync(p,'utf8'));
fs.writeFileSync(p+'.bak', JSON.stringify(i,null,2));
delete i.briefings;
fs.writeFileSync(p, JSON.stringify(i,null,2));
" && node _cdp.js "http://127.0.0.1:8777/index.html" _n 0 --wait=4500 \
  --eval="document.getElementById('briefing').textContent.trim().slice(0,40)" \
&& mv data/index.json.bak data/index.json
```

Expected：`eval → "当时尚未生成简报每 30 天生成一份，覆盖最近 30 天"`（`textContent` 会把 `<br>` 前后的文字直接拼上，所以看起来连在一起是正常的）。

- [ ] **Step 9: 看一眼简报卡片的实际样子**

```bash
TOP=$(node _cdp.js "http://127.0.0.1:8777/index.html" _tmp 0 --wait=4500 \
  --eval="document.getElementById('briefing').offsetTop" | sed -n 's/^eval → //p')
echo "简报卡片 offsetTop = $TOP"
node _cdp.js "http://127.0.0.1:8777/index.html" _b "$TOP" --wait=4500
```

用 Read 打开生成的 `_b_<TOP>.png` 目视确认：覆盖区间小字在卡片顶部、总览段紧随其后、两块八小节结构与改造前完全一致（标题、字号、缩进都没变）。

- [ ] **Step 10: 清理测试产物并提交**

```bash
rm -f _*.png _tmp_*.png data/index.json.bak
rm -f data/briefings/2026-10-02.json     # 只删本例造的那份测试简报
rmdir data/briefings 2>/dev/null         # 只在目录为空时删掉；里面还有真实简报就保留
git checkout data/index.json
git status --short
```

Expected：只剩 `M index.html`，`data/` 下没有多余文件。

```bash
git add index.html
git commit -m "feat(h5): 简报模块按批次日期匹配月度简报，标注覆盖区间"
```

---

### Task 8: 更新 README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前七个任务的全部产出
- Produces: 无

- [ ] **Step 1: 改顶部特性列表**

找到开头连续的五条要点（`- **定时**` / `- **词云**` / `- **简报**` / `- **历史**` / `- **前端**`，现在是第 5~10 行），**整段五条一起替换**为：

```markdown
- **定时**：GitHub Actions 每周**一、周四**各采集一次（北京时间 09:00），也可在 Actions 页手动触发。
  GitHub 的排期会排队延迟 1.5~6 小时，所以每个采集日提前埋三次兜底（06:40 / 07:40 / 08:40），先跑成的那次落盘，后面几次发现无新增就不提交——保证 9 点打开页面就有当天内容。
- **词云**：按当日资讯热度自动生成词云，字号随热度变化；点词看中文释义，勾选即筛选资讯列表
- **简报**：每 30 天生成一份，覆盖最近 30 天，**永久保存不删除**。DeepSeek 生成固定两大块 —— ① 智能制造产业影响（落地进展 / 产线变化 / 机遇风险 / 政策）② 市场与金融资本市场影响（投融资 / 资本动向 / 产业链 / 企业机会风险），可一键复制
- **历史**：**纯增量**批次（每批只装本次新增，批次之间不重复）。顶栏 `‹` `›` 逐条切换，或点「历史」直接跳；保留最近 **90 天**。切到某一批资讯时，下方自动显示**覆盖那段日期**的那份简报
- **前端**：单文件 `index.html`，无构建、无依赖；localStorage 缓存优先，秒开后后台刷新
```

注意：原来是「定时 / 词云 / 简报 / 历史 / 前端」五条，替换后仍是五条 —— 简报那条是**改写**（原来只说「每天生成」，现在说明 30 天一份），不是新增，别留下重复的两条。

- [ ] **Step 2: 改目录结构**

「目录结构」代码块里改三处、加三行。改完这一段应为：

```markdown
index.html                  # 移动端 H5（全部前端代码，含 LIB 纯逻辑层）
collector/
  run.js                    # 入口：抓取 → 过滤 → 去重 → 补详情 → 摘要 → 落盘 → 按需生成简报
  feeds.js                  # 资讯源清单与解析适配器（RSS / 列表页）
  fetch-utils.js            # 抓取、重试、编码识别（gbk→gb18030）、正文抽取
  dedupe.js                 # URL 归一化 + 批次文件扫描 + 近 14 天滚动去重
  briefing.js               # 简报纯逻辑：覆盖区间匹配 / 分块去重 / 汇总载荷拼装
  briefing-store.js         # 简报读写（briefings/ 永久保存，不参与清理）
  ai.js                     # DeepSeek 摘要 / 简报调用（含两级汇总与 JSON 容错解析）
  config.js                 # 运行时配置（全部可用环境变量覆盖）
.github/workflows/daily.yml # 定时任务（每周一/周四，每批次三次兜底）
data/                       # Actions 产出：批次 YYYY-MM-DD-HHmm.json + briefings/ + index.json（自动提交）
test/                       # node:test 单元测试（npm test，无外部依赖）
serve.js                    # 本地预览用静态服务器
```

逐条对应关系（改前 → 改后）：
- `run.js` 描述末尾「…→ 简报 → 落盘」→「…→ 落盘 → 按需生成简报」
- `dedupe.js` 描述「近 7 天」→「近 14 天」
- `ai.js` 描述「（含 JSON 容错解析）」→「（含两级汇总与 JSON 容错解析）」
- 在 `dedupe.js` 与 `ai.js` 之间**插入** `briefing.js`、`briefing-store.js` 两行
- `daily.yml` 描述「（每批次三次兜底）」→「（每周一/周四，每批次三次兜底）」
- `data/` 描述补上 `+ briefings/`
- 在 `data/` 之后**插入** `test/` 一行

- [ ] **Step 3: 改数据格式一节**

把 `data/YYYY-MM-DD-HHmm.json` 的例子改成不含 `briefing` 的版本，并新增简报的例子：

```markdown
`data/YYYY-MM-DD-HHmm.json`（一个采集日一个批次；早期只有日期的 `YYYY-MM-DD.json` 仍兼容，页面显示为「全天」）：

```json
{
  "id": "2026-10-01-0900",
  "date": "2026-10-01",
  "slot": "0900",
  "updatedAt": "2026-10-01T01:12:00.000Z",
  "items": [
    { "id": "url-md5", "title": "…", "source": "IT之家",
      "time": "2026-10-01T01:47:00.000Z", "url": "https://…", "digest": "AI 摘要（1-2 句）" }
  ]
}
```

**纯增量**：每个批次只装本次真正新采集到的条目，批次之间不重复、不结转。
同一批次可以重复运行（三次兜底）：以本批次已有内容为底稿只追加新增，本轮无新增则不改写文件，所以兜底运行不会产生空提交。

`data/briefings/YYYY-MM-DD.json`（文件名是生成日；**永久保存，不参与清理**）：

```json
{
  "id": "2026-10-02",
  "from": "2026-09-02",
  "to": "2026-10-02",
  "generatedAt": "2026-10-02T01:20:00.000Z",
  "itemCount": 1794,
  "batchCount": 9,
  "briefing": { "summary": "…", "part1": { "launch": [], "line": [], "risk": [], "policy": [] },
                "part2": { "finance": [], "capital": [], "chain": [], "corp": [] } }
}
```

30 天的资讯量（约 1800 条）远超单次大模型调用的上下文上限，所以简报分两级生成：
一级按批次分块各写一份阶段简报，二级把这些阶段简报汇总成最终简报。

`data/index.json`：`batches` 为全部批次（新的在前，含 id / 日期 / 批次 / 条数 / 更新时间），
`briefings` 为全部简报（按覆盖结束日新的在前，只含元信息、不含正文），`latest` 是最新批次 id。
```

这一段要**整段替换** README 里原来的三行：

```markdown
`data/index.json`：`batches` 为全部批次（新的在前，含 id / 日期 / 批次 / 条数 / 更新时间），`latest` 是最新批次 id。

**全量快照语义**：每个批次是「当天截至该时刻的全部资讯」，所以晚报包含早报的全部条目。
同一批次可以重复运行（兜底触发）：以该批次已有内容为底稿，只追加真正新增的条目，
已有摘要的不重复调用大模型；本轮无新增时**不改写文件**，因此不会产生空提交。
```

紧接着的那条引用块（`> 落盘只保留标题、来源、时间、原文链接与 AI 摘要…`）**不动**。

- [ ] **Step 4: 改「手动跑第一次」结尾与「本地运行」一节**

a) 「手动跑第一次」里那句「之后每天…自动更新」：

找到 → `之后每天 **09:00 / 21:00（北京时间）**自动更新，不用再管。`
换成 → `之后每周**一、周四 09:00（北京时间）**自动更新，不用再管；每 30 天会多出一份覆盖最近 30 天的简报。`

b) 「本地运行」的代码块加一行 `npm test`：

```bash
node collector/run.js --dry-run     # 只抓取不调用大模型（不需要 Key）
DEEPSEEK_API_KEY=sk-xxx node collector/run.js   # 完整跑一遍
node serve.js                       # 起本地服务，浏览器开 http://127.0.0.1:8777
npm test                            # 跑单元测试（node:test，无外部依赖）
```

c) 「常用参数」的示例与说明：

找到 → ``node collector/run.js --date=2026-09-08 --slot=0900    # 指定日期与批次（0900 / 2100）``
换成 → ``node collector/run.js --date=2026-09-08 --slot=0900    # 指定日期与批次（现在恒为 0900）``

找到那段引用块 → 
```markdown
> 不带 `--slot` 时会按北京时间自动判断（15 点前算早批）。**Actions 里一定要显式传**：
> 排期本身会延迟 1~3 小时，用墙上时间判断会把早批错写成晚批，所以 workflow 直接按
> 「哪个 cron 触发的」来定批次。
```
换成 →
```markdown
> 现在一个采集日只有 `0900` 一个批次，保留 `--slot` 是为了兼容既有的批次文件名、
> 并让三次兜底都落到同一个批次上。不带 `--slot` 时会按北京时间自动判断（15 点前算 0900）。
> **Actions 里仍然显式传**：排期本身会延迟 1.5~6 小时，用墙上时间判断会把批次归错日期，
> 所以 workflow 直接按「哪个 cron 触发的」来定批次。
```

- [ ] **Step 5: 改「说明与注意」一节**

a) 找到 → `- 本机（浏览器）会缓存最近 7 个批次的数据快照；勾选的关键词、自定义词也存本机，不上传。`
换成 → `- 本机（浏览器）会缓存最近 7 个批次的数据快照与最近 12 份简报；勾选的关键词、自定义词也存本机，不上传。`

b) 找到 → `- 页面**刷新按钮**的含义是「拉取最新已生成的数据」。真正的重新采集发生在 09:00 / 21:00 的定时任务，或在 Actions 页手动 Run workflow。`
换成 → `- 页面**刷新按钮**的含义是「拉取最新已生成的数据」。真正的重新采集发生在周一/周四 09:00 的定时任务，或在 Actions 页手动 Run workflow。`

c) 找到 → `- 定时任务**实测会排队延迟 1.5~3.3 小时**（不是几分钟）。这正是每批次埋三次兜底、且批次由 cron 而非运行时刻决定的原因。`
换成 → 
```markdown
- 定时任务**实测会排队延迟 1.5~6 小时**（不是几分钟）。这正是每批次埋三次兜底、且批次由 cron 而非运行时刻决定的原因。
- 批次数据保留 **90 天**（必须大于简报的 30 天覆盖窗口，否则生成简报时源数据会被自己删掉）；**简报永久保留**，不受保留期影响。
- 简报是**按批次日期匹配**的：切到某一批时，显示覆盖那段日期的那一份；若该批次比所有简报都新，则退回显示最新一份。
```

- [ ] **Step 6: 提交**

```bash
git add README.md
git commit -m "docs: 同步频率、简报模型与数据格式说明"
```

---

## 完成后的验收（不写进任何任务，最后统一跑一遍）

1. `npm test` —— 33 个用例全绿。
2. 完整跑一次带 key 的本地采集（或推送后手动 Run workflow），确认：
   - `data/briefings/` 下出现一份简报，`itemCount` 与窗口内去重后的条目数一致
   - `data/index.json` 里有 `briefings` 数组
   - 页面刷新后简报卡片顶部显示「覆盖 X月X日 ~ X月X日 · 共 N 条资讯」
3. 切到早于所有简报的批次，画面应退回最新一份简报（而不是空白）。
4. 词云、资讯列表、筛选、批次前后切换的行为与改造前完全一致。
5. 造一个 91 天前的批次文件跑一次 `cleanup()`，确认它被删除，而 `data/briefings/` 下的文件不受影响。

## 已知不做的事

- **不减配两次采集日的 `slotOf` 推断**（`< 15 点算 0900`）：手动 dispatch 时仍按钟点推断，workflow 里显式传 `--slot`，两者不冲突。
- **不处理跨午夜延迟**：批次日期在运行时刻计算，需要延迟超过 17 小时才可能跨过午夜记错（实测最长 6 小时）。
- **不做旧 `briefing` 字段的兼容读取**：改造前批次里内嵌的 `briefing` 直接忽略。代价是推送后到首次运行之间，页面会显示「这段时间尚未生成简报」——**推送后请立刻手动 Run workflow 一次**消除这段空窗。
