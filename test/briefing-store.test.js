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
  const dir = tmpData({ 'briefings/2026-09-01.json': { id: 'bad' } });
  fs.writeFileSync(path.join(dir, 'briefings', '2026-09-02.json'), '{ 坏 JSON', 'utf8');
  store.writeBriefing(dir, doc('2026-10-02', '2026-09-02', '2026-10-02', 5));
  assert.deepEqual(store.listBriefings(dir).map((b) => b.id), ['2026-10-02']);
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
