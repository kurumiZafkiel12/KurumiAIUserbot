// 日志清理的单元测试（0.2.0）：保留期外的旧日志删掉、保留期内的和不相干文件不动。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupOldLogs, LOG_RETENTION_DAYS } from "../src/logger.js";

test("cleanupOldLogs：删保留期外的 bot-日期.log，保留期内的与不相干文件不动", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-logger-"));
  const now = Date.parse("2026-11-28T12:00:00Z");
  const mk = (name) => fs.writeFileSync(path.join(dir, name), "x", "utf-8");
  mk("bot-2026-10-01.log"); // 58 天前：删
  mk("bot-2026-10-29.log"); // 30 天前一天：删（满保留期即删）
  mk("bot-2026-11-01.log"); // 27 天前：留
  mk("bot-2026-11-28.log"); // 今天：留
  mk("bot-not-a-date.log"); // 名字不像日期：留
  mk("other.txt"); // 不是日志：留

  const removed = cleanupOldLogs(dir, LOG_RETENTION_DAYS, now);
  assert.deepEqual(removed.sort(), ["bot-2026-10-01.log", "bot-2026-10-29.log"]);
  assert.ok(fs.existsSync(path.join(dir, "bot-2026-11-01.log")));
  assert.ok(fs.existsSync(path.join(dir, "bot-2026-11-28.log")));
  assert.ok(fs.existsSync(path.join(dir, "bot-not-a-date.log")));
  assert.ok(fs.existsSync(path.join(dir, "other.txt")));
});

test("cleanupOldLogs：目录不存在/无匹配文件不抛错", () => {
  const missing = path.join(os.tmpdir(), `userbot-logger-none-${Math.random().toString(36).slice(2)}`);
  assert.deepEqual(cleanupOldLogs(missing, 30, Date.now()), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-logger-empty-"));
  assert.deepEqual(cleanupOldLogs(dir, 30, Date.now()), []);
});
