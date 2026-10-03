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
