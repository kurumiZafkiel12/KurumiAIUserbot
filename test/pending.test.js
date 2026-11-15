// 两步选择 pending 的单元测试：node --test 运行，时间靠注入的假时钟控制。

import test from "node:test";
import assert from "node:assert/strict";
import { PendingSelections } from "../src/pending.js";

function makePending(ttlMs = 60_000) {
  let now = 1_000_000;
  const p = new PendingSelections({ ttlMs, nowFn: () => now });
  return { p, advance: (ms) => (now += ms) };
}

test("set 后 peek 能拿到，未过期", () => {
  const { p } = makePending();
  p.set("chat1", "owner1", { kind: "换模型", step: 1 });
  const got = p.peek("chat1", "owner1");
  assert.equal(got.expired, false);
  assert.equal(got.entry.kind, "换模型");
  assert.equal(got.entry.step, 1);
});

test("不同会话/不同人互不干扰", () => {
  const { p } = makePending();
  p.set("chat1", "owner1", { kind: "限额", step: 1 });
  assert.equal(p.peek("chat2", "owner1"), null);
  assert.equal(p.peek("chat1", "owner2"), null);
});

test("consume 取出后即删除", () => {
  const { p } = makePending();
  p.set("c", "o", { kind: "换key", step: 2, providerName: "default" });
  const entry = p.consume("c", "o");
  assert.equal(entry.providerName, "default");
  assert.equal(p.peek("c", "o"), null);
  assert.equal(p.consume("c", "o"), null);
});

test("超过 ttl 后 peek 标记 expired，但条目还在（供回「已超时」）", () => {
  const { p, advance } = makePending(60_000);
  p.set("c", "o", { kind: "禁用api", step: 1 });
  advance(60_001);
  const got = p.peek("c", "o");
  assert.equal(got.expired, true);
  assert.equal(got.entry.kind, "禁用api");
});

test("ttl 内不算过期", () => {
  const { p, advance } = makePending(60_000);
  p.set("c", "o", { kind: "启用api", step: 1 });
  advance(59_999);
  assert.equal(p.peek("c", "o").expired, false);
});

test("重复 set 覆盖旧条目并刷新过期时间", () => {
  const { p, advance } = makePending(60_000);
  p.set("c", "o", { kind: "换模型", step: 1 });
  advance(50_000);
  p.set("c", "o", { kind: "限额", step: 1 });
  advance(50_000);
  const got = p.peek("c", "o");
  assert.equal(got.entry.kind, "限额");
  assert.equal(got.expired, false);
});

test("clear 直接清掉", () => {
  const { p } = makePending();
  p.set("c", "o", { kind: "换模型", step: 1 });
  p.clear("c", "o");
  assert.equal(p.peek("c", "o"), null);
});
