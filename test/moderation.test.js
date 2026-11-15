// 内容门禁纯逻辑的单元测试：关键词命中、屏蔽判定、尖括号剥除。

import test from "node:test";
import assert from "node:assert/strict";
import { findKeyword, isSensitiveBlocked, unwrapArg } from "../src/moderation.js";

test("findKeyword 子串命中，不分大小写", () => {
  assert.equal(findKeyword("帮我写个 Python 脚本", ["python"]), "python");
  assert.equal(findKeyword("HELLO world", ["hello"]), "hello");
  assert.equal(findKeyword("今天天气好", ["python", "代码"]), null);
  assert.equal(findKeyword("", ["x"]), null);
  assert.equal(findKeyword("问题", []), null);
  assert.equal(findKeyword("问题", null), null);
});

test("findKeyword 返回第一个命中的词", () => {
  assert.equal(findKeyword("写代码和脚本", ["脚本", "代码"]), "脚本");
});

test("isSensitiveBlocked 要群在名单里且命中词才拦", () => {
  const groups = ["-100123"];
  const words = ["违禁词"];
  assert.equal(isSensitiveBlocked("-100123", "有违禁词吗", groups, words), true);
  assert.equal(isSensitiveBlocked("-100123", "正常问题", groups, words), false);
  assert.equal(isSensitiveBlocked("-999", "有违禁词吗", groups, words), false);
  assert.equal(isSensitiveBlocked("-100123", "有违禁词吗", [], words), false);
  assert.equal(isSensitiveBlocked("-100123", "有违禁词吗", groups, []), false);
  // 数字型 chatId / 数字型名单元素都会转成字符串再比
  assert.equal(isSensitiveBlocked(-100123, "有违禁词吗", groups, words), true);
  assert.equal(isSensitiveBlocked("-100123", "有违禁词吗", [-100123], words), true);
});

test("unwrapArg 剥最外层一对尖括号", () => {
  assert.equal(unwrapArg("<12345>"), "12345");
  assert.equal(unwrapArg(" <12345> "), "12345");
  assert.equal(unwrapArg("12345"), "12345");
  assert.equal(unwrapArg("<a<b>>"), "a<b>");
  assert.equal(unwrapArg("写个<脚本>吧"), "写个<脚本>吧");
  assert.equal(unwrapArg(""), "");
  assert.equal(unwrapArg(123), 123);
});
