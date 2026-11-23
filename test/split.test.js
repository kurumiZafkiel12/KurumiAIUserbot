// 分条发送纯逻辑的单元测试：人设闲聊拆条、专业长答不拆、无人设不拆。

import test from "node:test";
import assert from "node:assert/strict";
import { decideSplit, isProfessionalText } from "../src/split.js";

test("无人设时永远整条", () => {
  const text = "你好呀\n今天天气不错\n出去玩吗";
  assert.deepEqual(decideSplit(text, { personaMode: false }), [text]);
});

test("人设模式下多行闲聊短答按行拆", () => {
  const parts = decideSplit("你好呀狂三\n今天周日\n想干嘛呢", { personaMode: true });
  assert.deepEqual(parts, ["你好呀狂三", "今天周日", "想干嘛呢"]);
});

test("人设模式下单行短答不拆", () => {
  assert.deepEqual(decideSplit("吃了，刚吃完", { personaMode: true }), ["吃了，刚吃完"]);
});

test("含代码块的专业长答不拆", () => {
  const text = "这样写：\n```js\nconsole.log(1)\n```\n就行了";
  assert.equal(isProfessionalText(text), true);
  assert.deepEqual(decideSplit(text, { personaMode: true }), [text]);
});

test("多行列表/标题结构不拆", () => {
  const text = "步骤如下：\n- 第一步\n- 第二步\n- 第三步";
  assert.equal(isProfessionalText(text), true);
  assert.deepEqual(decideSplit(text, { personaMode: true }), [text]);
});

test("超过 300 字且段落分明不拆", () => {
  const para = "这是一段比较长的内容，用来模拟专业回答里的一个自然段。".repeat(7);
  const text = `${para}\n\n${para}`;
  assert.ok(text.length > 300);
  assert.equal(isProfessionalText(text), true);
  assert.deepEqual(decideSplit(text, { personaMode: true }), [text]);
});

test("超过 5 行时合并余下为最后一条（共 5 条）", () => {
  const lines = ["一", "二", "三", "四", "五", "六", "七"];
  const parts = decideSplit(lines.join("\n"), { personaMode: true });
  assert.equal(parts.length, 5);
  assert.deepEqual(parts.slice(0, 4), ["一", "二", "三", "四"]);
  assert.equal(parts[4], "五\n六\n七");
});

test("某一行特别长时不拆", () => {
  const long = "长".repeat(250);
  const text = `短句\n${long}`;
  assert.deepEqual(decideSplit(text, { personaMode: true }), [text]);
});

test("0.0.1 decideSplit maxParts：上限 3 条时六行并为三条，缺省仍是五条", () => {
const text = ["第一行", "第二行", "第三行", "第四行", "第五行", "第六行"].join("\n");
assert.equal(decideSplit(text, { personaMode: true }).length, 5);
const grp = decideSplit(text, { personaMode: true, maxParts: 3 });
assert.equal(grp.length, 3);
assert.equal(grp[2], "第三行\n第四行\n第五行\n第六行");
});
