// 名字时钟拼名的单元测试：号主定版——姓氏位只能是时间，改名只改打头的名字。

import test from "node:test";
import assert from "node:assert/strict";
import { composeClockName } from "../src/nameclock.js";

test("姓氏位只有时间，不拼任何自定义姓氏", () => {
  assert.deepEqual(composeClockName("大肥鱼", "16:25"), { firstName: "大肥鱼", lastName: "16:25" });
  assert.deepEqual(composeClockName("GPT", "09:05"), { firstName: "GPT", lastName: "09:05" });
});

test("首尾空白会被清掉", () => {
  assert.deepEqual(composeClockName("  GPT ", "09:05"), { firstName: "GPT", lastName: "09:05" });
});
