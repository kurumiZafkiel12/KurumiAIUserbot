// docs/CONFIG.md 的「完整示例」守门测试（审计 K062-22）：
// 只守完整示例那一份 JSON 代码块——它必须能被 JSON.parse，且含关键字段。
// 文档里其它片段示例（单个字段的演示）不在守门范围内。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const docPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "CONFIG.md");

test("CONFIG.md 完整示例是可解析的 JSON 且含 ignoreSenderIds 数组", () => {
  const md = fs.readFileSync(docPath, "utf-8");
  const heading = md.indexOf("## 完整示例");
  assert.ok(heading >= 0, "文档应有「完整示例」一节");
  const after = md.slice(heading);
  const m = after.match(/```json\s*\n([\s\S]*?)```/);
  assert.ok(m, "完整示例一节应有 json 代码块");
  const parsed = JSON.parse(m[1]); // 解析失败直接抛错 = 测试失败
  assert.ok(Array.isArray(parsed.ignoreSenderIds), "完整示例应含 ignoreSenderIds 数组字段");
  assert.ok(Array.isArray(parsed.adminIds), "完整示例应含 adminIds 数组字段");
  assert.ok(Array.isArray(parsed.customProviders), "完整示例应含 customProviders 数组字段");
});
