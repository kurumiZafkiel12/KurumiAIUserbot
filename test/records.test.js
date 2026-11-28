// 群聊天记录的单元测试：环形截断、最近 N 条、拼装、落盘读回、坏文件容错。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GroupRecords, renderRecords } from "../src/records.js";

test("record/recent/count 基本行为，空白不记", () => {
  const r = new GroupRecords(null, { maxPerGroup: 3 });
  assert.equal(r.record("g1", { name: "甲", senderId: "1", text: "你好" }), true);
  assert.equal(r.record("g1", { name: "乙", senderId: "2", text: "   " }), false);
  r.record("g1", { name: "乙", senderId: "2", text: "在聊新番" });
  assert.equal(r.count("g1"), 2);
  assert.equal(r.recent("g1", 1)[0].text, "在聊新番");
  assert.equal(r.count("g2"), 0);
});

test("超过每群上限时环形丢弃最旧的", () => {
  const r = new GroupRecords(null, { maxPerGroup: 2 });
  r.record("g", { name: "甲", text: "一" });
  r.record("g", { name: "甲", text: "二" });
  r.record("g", { name: "甲", text: "三" });
  assert.deepEqual(r.recent("g", 10).map((i) => i.text), ["二", "三"]);
});

test("renderRecords 拼成「名字：内容」，不带数字 ID", () => {
  const out = renderRecords([
    { name: "甲", senderId: "12345", text: "你好" },
    { name: "", senderId: "999", text: "嗯" },
  ]);
  assert.equal(out, "甲：你好\n群友：嗯");
  assert.ok(!out.includes("12345"));
  assert.equal(renderRecords([]), "");
});

test("renderRecords 带时间前缀（机器人时区），跨天能分清（v0.0.9）", () => {
  const out = renderRecords(
    [
      // UTC 11-23 15:04 = 北京 11-23 23:04（昨天）
      { name: "甲", text: "昨天的事", ts: "2026-11-23T15:04:00.000Z" },
      // UTC 11-23 16:30 = 北京 11-24 00:30（今天）——UTC 日期和北京日期不同天，正是翻车点
      { name: "乙", text: "今天的事", ts: "2026-11-23T16:30:00.000Z" },
      // 没 ts 的老记录不带前缀，照常渲染
      { name: "丙", text: "没时间的" },
    ],
    "Asia/Shanghai",
  );
  assert.equal(out, "[11-23 23:04] 甲：昨天的事\n[11-24 00:30] 乙：今天的事\n丙：没时间的");
});

test("落盘后能读回；文件损坏按空启动不抛错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-records-"));
  const file = path.join(dir, "records.json");
  const r1 = new GroupRecords(file, { saveDelayMs: 0 });
  r1.record("g", { name: "甲", senderId: "1", text: "落盘测试" });
  const r2 = new GroupRecords(file);
  assert.equal(r2.count("g"), 1);
  fs.writeFileSync(file, "{坏掉的 json", "utf-8");
  const r3 = new GroupRecords(file);
  assert.equal(r3.count("g"), 0);
});

test("落盘防抖（0.2.0）：默认延迟下 record 不立即写盘，flush 后写入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-records-"));
  const file = path.join(dir, "records.json");
  const r = new GroupRecords(file); // 默认 5 秒防抖
  r.record("g", { name: "甲", senderId: "1", text: "防抖窗口内" });
  assert.equal(fs.existsSync(file), false, "防抖窗口内不该有文件");
  assert.equal(r.count("g"), 1, "内存里要有（写盘失败退化为内存版的老规矩不变）");
  r.flush();
  const r2 = new GroupRecords(file);
  assert.equal(r2.count("g"), 1, "flush 后要落盘");
});

test("GroupRecords.chats()：列出有记录的群（v0.9.18 全群记录的状态页要用）", () => {
const r = new GroupRecords(null);
r.record("-1001", { name: "甲", senderId: "1", text: "你好" });
r.record("-1002", { name: "乙", senderId: "2", text: "在吗" });
assert.deepEqual(r.chats().sort(), ["-1001", "-1002"]);
});
