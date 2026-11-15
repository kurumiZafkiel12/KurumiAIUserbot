// 名字时钟拼名的单元测试：改名（customName）与时间段的拼法。

import test from "node:test";
import assert from "node:assert/strict";
import { composeClockName } from "../src/nameclock.js";

test("有姓氏：姓氏在前、时间在后", () => {
  assert.deepEqual(composeClockName("大肥鱼", "狂三", "16:25"), { firstName: "大肥鱼", lastName: "狂三 16:25" });
});

test("没姓氏：姓氏位只有时间", () => {
  assert.deepEqual(composeClockName("GPT", "", "09:05"), { firstName: "GPT", lastName: "09:05" });
});

test("首尾空白会被清掉", () => {
  assert.deepEqual(composeClockName("  GPT ", "  ", "09:05"), { firstName: "GPT", lastName: "09:05" });
});
