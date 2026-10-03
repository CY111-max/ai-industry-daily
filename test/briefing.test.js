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
