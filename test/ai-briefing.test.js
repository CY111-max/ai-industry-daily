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
