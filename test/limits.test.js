// 每日限额与日期切分的单元测试：node --test 运行，不依赖任何外部包。

import test from "node:test";
import assert from "node:assert/strict";
import { DailyCounter, todayKey } from "../src/limits.js";

test("todayKey 格式为 YYYY-MM-DD", () => {
  assert.equal(todayKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(todayKey(new Date(2026, 10, 14)), "2026-11-14");
});

test("不限量（limit=0）时一直可用", () => {
  const c = new DailyCounter(0);
  for (let i = 0; i < 50; i++) c.record();
  assert.equal(c.canUse(), true);
  assert.equal(c.remaining(), Infinity);
});

test("达到上限后不可用", () => {
  const c = new DailyCounter(3);
  assert.equal(c.canUse(), true);
  c.record();
  c.record();
  assert.equal(c.remaining(), 1);
  c.record();
  assert.equal(c.canUse(), false);
  assert.equal(c.remaining(), 0);
});

test("跨天自动清零（date rollover）", () => {
  const c = new DailyCounter(1);
  const day1 = new Date(2026, 10, 14, 23, 59);
  const day2 = new Date(2026, 10, 15, 0, 1);
  c.record(day1);
  assert.equal(c.canUse(day1), false);
  // 到了第二天：清零后重新可用
  assert.equal(c.rolloverIfNeeded(day2), true);
  assert.equal(c.snapshot(day2).count, 0);
  assert.equal(c.canUse(day2), true);
  c.record(day2);
  assert.equal(c.snapshot(day2).count, 1);
  assert.equal(c.snapshot(day2).day, "2026-11-15");
});

test("同一天内 rolloverIfNeeded 不清零", () => {
  const c = new DailyCounter(10);
  const morning = new Date(2026, 10, 14, 9, 0);
  const night = new Date(2026, 10, 14, 22, 0);
  c.record(morning);
  assert.equal(c.rolloverIfNeeded(night), false);
  assert.equal(c.snapshot(night).count, 1);
});

test("构造函数把非法上限归为不限量", () => {
  assert.equal(new DailyCounter(-5).limit, 0);
  assert.equal(new DailyCounter("abc").limit, 0);
  assert.equal(new DailyCounter(7).limit, 7);
});
