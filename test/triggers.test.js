// 触发词解析的单元测试：node --test 运行，不依赖 telegram / openai 包。

import test from "node:test";
import assert from "node:assert/strict";
import { parseTrigger, parseOwnerCommand, resolveProvider, isReplyToSelf } from "../src/triggers.js";

const OPTS = { username: "mybot", triggerMap: { "@ab": "relay-a" } };

test("提及用户名触发，问题是剩余文本", () => {
  const r = parseTrigger("@mybot 你好", OPTS);
  assert.equal(r.kind, "mention");
  assert.equal(r.providerName, "default");
  assert.equal(r.question, "你好");
});

test("提及出现在消息中间也能触发", () => {
  const r = parseTrigger("帮我问下 @mybot 今天星期几", OPTS);
  assert.equal(r.kind, "mention");
  assert.equal(r.question, "帮我问下 今天星期几");
});

test("默认触发词 @ai 绑定到 default 提供方", () => {
  const r = parseTrigger("@ai 写一首诗", OPTS);
  assert.equal(r.kind, "trigger");
  assert.equal(r.trigger, "@ai");
  assert.equal(r.providerName, "default");
  assert.equal(r.question, "写一首诗");
});

test("已绑定触发词返回绑定提供方", () => {
  const r = parseTrigger("@ab 你好", OPTS);
  assert.equal(r.trigger, "@ab");
  assert.equal(r.providerName, "relay-a");
  assert.equal(r.question, "你好");
});

test("未绑定触发词 providerName 为 null", () => {
  const r = parseTrigger("@az 你好", OPTS);
  assert.equal(r.trigger, "@az");
  assert.equal(r.providerName, null);
});

test("triggerMap 可覆盖 @ai 的绑定", () => {
  const r = parseTrigger("@ai 你好", { username: "mybot", triggerMap: { "@ai": "main" } });
  assert.equal(r.providerName, "main");
});

test("普通消息不触发", () => {
  assert.equal(parseTrigger("今天天气不错", OPTS), null);
  assert.equal(parseTrigger("", OPTS), null);
  assert.equal(parseTrigger(null, OPTS), null);
});

test("邮箱样式文本不误触发", () => {
  // someone@ai.com 里 @ai 前后紧跟字母/点号场景：前一位是字母，应不匹配为独立词
  assert.equal(parseTrigger("someone@aicom", OPTS), null);
});

test("触发词单独出现时问题为空字符串", () => {
  const r = parseTrigger("@ai", OPTS);
  assert.equal(r.trigger, "@ai");
  assert.equal(r.question, "");
});

test("号主命令解析", () => {
  assert.equal(parseOwnerCommand("@ai 状态"), "状态");
  assert.equal(parseOwnerCommand("@ai 拉黑 12345"), "拉黑 12345");
  assert.equal(parseOwnerCommand("@ai"), null);
  assert.equal(parseOwnerCommand("状态"), null);
  assert.equal(parseOwnerCommand("@ab 状态"), null);
});

test("回复续聊判定：out 为 true 算回复自己", () => {
  assert.equal(isReplyToSelf({ out: true, senderId: 123 }, "999"), true);
  assert.equal(isReplyToSelf({ out: true }, "999"), true);
});

test("回复续聊判定：senderId 等于本账号 ID 算回复自己", () => {
  assert.equal(isReplyToSelf({ out: false, senderId: 999 }, "999"), true);
  assert.equal(isReplyToSelf({ out: false, senderId: "999" }, 999), true);
  // GramJS 的 senderId 是大整数对象，toString 后应能对上
  assert.equal(isReplyToSelf({ out: false, senderId: 999n }, "999"), true);
});

test("回复续聊判定：回复别人、空消息、没配 selfId 都不算", () => {
  assert.equal(isReplyToSelf({ out: false, senderId: 123 }, "999"), false);
  assert.equal(isReplyToSelf({ out: false }, "999"), false);
  assert.equal(isReplyToSelf(null, "999"), false);
  assert.equal(isReplyToSelf(undefined, "999"), false);
  assert.equal(isReplyToSelf({ out: true, senderId: 999 }, ""), false);
  assert.equal(isReplyToSelf({ out: false, senderId: 999 }, null), false);
});

test("resolveProvider 回退规则", () => {
  assert.equal(resolveProvider("@ai", {}), "default");
  assert.equal(resolveProvider("@ai", { "@ai": "x" }), "x");
  assert.equal(resolveProvider("@aq", {}), null);
});
