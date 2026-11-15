// Token 用量统计的单元测试：累计、合计、跨天归零、坏文件容错、落盘往返。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageStats } from "../src/usagestats.js";

test("record 按模型累计次数与 token，snapshot 给合计", () => {
  const s = new UsageStats(null);
  s.record("model-a", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  s.record("model-a", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  s.record("model-b", null); // 没 usage 时只记次数
  const snap = s.snapshot();
  assert.deepEqual(snap.models["model-a"], { calls: 2, prompt: 13, completion: 7, total: 20 });
  assert.deepEqual(snap.models["model-b"], { calls: 1, prompt: 0, completion: 0, total: 0 });
  assert.deepEqual(snap.totals, { calls: 3, prompt: 13, completion: 7, total: 20 });
});

test("usage 缺 total_tokens 时用 prompt+completion 补", () => {
  const s = new UsageStats(null);
  s.record("m", { prompt_tokens: 4, completion_tokens: 6 });
  assert.equal(s.snapshot().models.m.total, 10);
});

test("跨天归零", () => {
  const s = new UsageStats(null);
  const day1 = new Date(2026, 0, 1, 12, 0, 0);
  const day2 = new Date(2026, 0, 2, 0, 0, 1);
  s.record("m", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, day1);
  assert.equal(s.snapshot(day1).totals.calls, 1);
  const snap2 = s.snapshot(day2);
  assert.equal(snap2.totals.calls, 0);
  assert.equal(snap2.day, "2026-01-02");
});

test("落盘后重新构造能读回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagestats-"));
  const file = path.join(dir, "usage.json");
  const a = new UsageStats(file);
  a.record("m1", { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
  const b = new UsageStats(file);
  assert.deepEqual(b.snapshot().models.m1, { calls: 1, prompt: 7, completion: 8, total: 15 });
});

test("文件损坏时按空统计启动，不抛错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagestats-"));
  const file = path.join(dir, "usage.json");
  fs.writeFileSync(file, "{not json", "utf-8");
  const s = new UsageStats(file);
  assert.equal(s.snapshot().totals.calls, 0);
  s.record("m", null);
  assert.equal(s.snapshot().totals.calls, 1);
});
