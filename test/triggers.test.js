// 触发词解析的单元测试：node --test 运行，不依赖 telegram / openai 包。

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTrigger,
  parseOwnerCommand,
  parseMentionOwnerCommand,
  resolveProvider,
  isReplyToSelf,
  isHelpQuery,
} from "../src/triggers.js";

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

test("号主命令解析：只认 /ai 前缀", () => {
  assert.equal(parseOwnerCommand("/ai 状态"), "状态");
  assert.equal(parseOwnerCommand("/ai 帮助"), "帮助");
  assert.equal(parseOwnerCommand("/ai 拉黑 12345"), "拉黑 12345");
  assert.equal(parseOwnerCommand("/ai"), null);
  assert.equal(parseOwnerCommand("/ai "), null);
  assert.equal(parseOwnerCommand("/ai状态"), null);
  assert.equal(parseOwnerCommand(" /ai 状态"), null);
  assert.equal(parseOwnerCommand("状态"), null);
  assert.equal(parseOwnerCommand("你好"), null);
  assert.equal(parseOwnerCommand(""), null);
  assert.equal(parseOwnerCommand(null), null);
});

test("号主命令解析：@ai 是聊天触发词、不是命令前缀，一律不认", () => {
  assert.equal(parseOwnerCommand("@ai 状态"), null);
  assert.equal(parseOwnerCommand("@ai 帮助"), null);
  assert.equal(parseOwnerCommand("@ai 关闭"), null);
  assert.equal(parseOwnerCommand("@ai"), null);
  assert.equal(parseOwnerCommand("@ab 状态"), null);
});

test("帮助类问题判定：恰好是帮助写法才算", () => {
  assert.equal(isHelpQuery("帮助"), true);
  assert.equal(isHelpQuery(" 帮助 "), true);
  assert.equal(isHelpQuery("help"), true);
  assert.equal(isHelpQuery("Help"), true);
  assert.equal(isHelpQuery("HELP"), true);
  assert.equal(isHelpQuery("/ai 帮助"), true);
  assert.equal(isHelpQuery("@ai 帮助"), true);
  assert.equal(isHelpQuery(" /ai  帮助 "), true);
});

test("帮助类问题判定：近似但不恰好是的不算", () => {
  assert.equal(isHelpQuery("帮助我"), false);
  assert.equal(isHelpQuery("请给我帮助"), false);
  assert.equal(isHelpQuery("帮助中心在哪里"), false);
  assert.equal(isHelpQuery("help me"), false);
  assert.equal(isHelpQuery(""), false);
  assert.equal(isHelpQuery(null), false);
  assert.equal(isHelpQuery(undefined), false);
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

test("resolveProvider 支持号主设的默认提供方", () => {
  assert.equal(resolveProvider("@ai", {}, "relay-a"), "relay-a");
  assert.equal(resolveProvider("@ai", { "@ai": "x" }, "relay-a"), "x"); // 显式绑定优先
  assert.equal(resolveProvider("@ai", {}, ""), "default");
  assert.equal(resolveProvider("@aq", {}, "relay-a"), null); // 非默认触发词不吃这个回退
});

test("parseTrigger 透传默认提供方", () => {
  const r = parseTrigger("@ai 你好", { username: "mybot", triggerMap: {}, defaultProvider: "relay-a" });
  assert.equal(r.providerName, "relay-a");
  const m = parseTrigger("@mybot 你好", { username: "mybot", triggerMap: {}, defaultProvider: "relay-a" });
  assert.equal(m.providerName, "relay-a");
});

test("用户名触发关闭时，普通用户的 @用户名 不触发，但触发词照常", () => {
  const opts = { username: "mybot", triggerMap: {}, usernameTrigger: false, role: "user" };
  assert.equal(parseTrigger("@mybot 你好", opts), null);
  const r = parseTrigger("@ai 你好", opts);
  assert.equal(r.kind, "trigger");
  assert.equal(r.question, "你好");
});

test("用户名触发关闭时，号主与管理员的 @用户名 照常触发", () => {
  for (const role of ["owner", "admin"]) {
    const r = parseTrigger("@mybot 你好", { username: "mybot", triggerMap: {}, usernameTrigger: false, role });
    assert.equal(r.kind, "mention");
  }
});

test("用户名触发开启（默认）时普通用户 @用户名 触发", () => {
  const r = parseTrigger("@mybot 你好", { username: "mybot", triggerMap: {}, role: "user" });
  assert.equal(r.kind, "mention");
});

test("parseMentionOwnerCommand：群里 @机器人 后接 /ai 命令能解析出命令正文", () => {
  assert.equal(parseMentionOwnerCommand("@mybot /ai 状态", "mybot"), "状态");
  assert.equal(parseMentionOwnerCommand("@mybot  /ai 帮助", "mybot"), "帮助");
  assert.equal(parseMentionOwnerCommand("  @mybot /ai 拉黑 123", "mybot"), "拉黑 123");
});

test("parseMentionOwnerCommand：不是命令形态一律返回 null", () => {
  assert.equal(parseMentionOwnerCommand("@mybot 你好", "mybot"), null); // 普通提问
  assert.equal(parseMentionOwnerCommand("@mybot @ai 状态", "mybot"), null); // @ai 不是命令前缀
  assert.equal(parseMentionOwnerCommand("/ai 状态", "mybot"), null); // 直接以 /ai 开头走 parseOwnerCommand
  assert.equal(parseMentionOwnerCommand("喂 @mybot /ai 状态", "mybot"), null); // 提及不在开头
  assert.equal(parseMentionOwnerCommand("@other /ai 状态", "mybot"), null); // 提及的不是机器人
  assert.equal(parseMentionOwnerCommand("@mybot /ai 状态", ""), null); // 没配用户名
});
