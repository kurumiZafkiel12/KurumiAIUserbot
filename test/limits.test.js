// 每日限额与日期切分的单元测试：node --test 运行，不依赖任何外部包。

import test from "node:test";
import assert from "node:assert/strict";
import { DailyCounter, todayKey, SlowdownTracker } from "../src/limits.js";

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

test("SlowdownTracker 冷却递增 5→10→30→60 并封顶", () => {
  const t = new SlowdownTracker();
  const t0 = 1_000_000_000;
  assert.equal(t.isBlocked("u1", t0), false);
  assert.equal(t.recordAnswer("u1", t0), 5);
  assert.equal(t.isBlocked("u1", t0 + 4 * 60_000), true);
  assert.equal(t.isBlocked("u1", t0 + 5 * 60_000 + 1), false);
  assert.equal(t.recordAnswer("u1", t0 + 6 * 60_000), 10);
  assert.equal(t.recordAnswer("u1", t0 + 20 * 60_000), 30);
  assert.equal(t.recordAnswer("u1", t0 + 60 * 60_000), 60);
  assert.equal(t.recordAnswer("u1", t0 + 130 * 60_000), 60);
});

test("预留/结算/释放：预留同步占名额，失败释放不计用量，成功结算计一次（K062-04）", () => {
  const c = new DailyCounter(1);
  assert.equal(c.reserve(), true);
  assert.equal(c.canUse(), false, "预留后名额被在途请求占住");
  assert.equal(c.reserve(), false, "上限 1 时第二次预留必须失败");
  c.release();
  assert.equal(c.snapshot().count, 0, "释放不计用量");
  assert.equal(c.reserve(), true, "释放后可再预留");
  c.commit();
  assert.equal(c.snapshot().count, 1, "结算计一次用量");
  assert.equal(c.reserve(), false, "结算后额度已满");
  assert.equal(c.canUse(), false);
});

test("inheritFrom：只继承同一天的已用计数，跨天不继承（K062-02）", () => {
  const old = new DailyCounter(5);
  old.record();
  old.record();
  const fresh = new DailyCounter(5);
  fresh.inheritFrom(old);
  assert.equal(fresh.snapshot().count, 2);
  const stale = new DailyCounter(5);
  stale.day = "2000-01-01";
  stale.count = 9;
  const fresh2 = new DailyCounter(5);
  fresh2.inheritFrom(stale);
  assert.equal(fresh2.snapshot().count, 0, "昨天的计数不能带到今天");
});

test("SlowdownTracker 各用户独立，reset 清零", () => {
  const t = new SlowdownTracker();
  const t0 = 5_000_000;
  t.recordAnswer("u1", t0);
  assert.equal(t.isBlocked("u2", t0), false);
  t.reset("u1");
  assert.equal(t.isBlocked("u1", t0), false);
  assert.equal(t.recordAnswer("u1", t0), 5); // reset 后从第一档重新开始
});
