// profiles.js 单元测试：称呼提取的各种口语说法、防误记规则，以及档案的读写与持久化容错。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserProfiles, extractCallName } from "../src/profiles.js";

test("extractCallName：最基本的交代", () => {
  assert.equal(extractCallName("叫我小明"), "小明");
  assert.equal(extractCallName("以后叫我小明"), "小明");
  assert.equal(extractCallName("你好，叫我阿紫"), "阿紫");
});

test("extractCallName：取最后一个「叫我」——不要叫我A，叫我B 取 B", () => {
  assert.equal(extractCallName("不要叫我小明，叫我明哥"), "明哥");
  assert.equal(extractCallName("别叫我全名，叫我小李就行"), "小李");
});

test("extractCallName：唯一的「叫我」被否定时不记", () => {
  assert.equal(extractCallName("不要叫我小明"), null);
  assert.equal(extractCallName("别叫我明哥"), null);
});

test("extractCallName：屏蔽词——提问和吐槽不是报称呼", () => {
  assert.equal(extractCallName("叫我干嘛"), null);
  assert.equal(extractCallName("你叫我干啥"), null);
  assert.equal(extractCallName("叫我什么"), null);
  assert.equal(extractCallName("刚才谁叫我"), null);
  assert.equal(extractCallName("叫我干嘛呀"), null);
});

test("extractCallName：剥引号与语气尾缀（可叠加多层）", () => {
  assert.equal(extractCallName("叫我「小明」"), "小明");
  assert.equal(extractCallName('叫我"小明"吧'), "小明");
  assert.equal(extractCallName("叫我小明吧"), "小明");
  assert.equal(extractCallName("叫我小明就可以了"), "小明");
  assert.equal(extractCallName("叫我阿紫就行了"), "阿紫");
  assert.equal(extractCallName("叫我小明可以了"), "小明");
  assert.equal(extractCallName("叫我鱼鱼捏"), "鱼鱼");
});

test("extractCallName：称呼只取紧跟的一个词，后半句话不要", () => {
  assert.equal(extractCallName("叫我小明，他是我朋友"), "小明");
  assert.equal(extractCallName("叫我小明。听到了吗"), "小明");
  assert.equal(extractCallName("叫我小明 去吃饭"), "小明");
});

test("extractCallName：没有交代、空内容、超长都返回 null", () => {
  assert.equal(extractCallName("今天天气不错"), null);
  assert.equal(extractCallName("叫我"), null);
  assert.equal(extractCallName("叫我 "), null);
  assert.equal(extractCallName(""), null);
  assert.equal(extractCallName(null), null);
  assert.equal(extractCallName("叫我这是一个超级超级长的名字啊"), null); // 14 字 > 12
});

test("UserProfiles：称呼与印象的读写，互不串人", () => {
  const p = new UserProfiles(null);
  assert.equal(p.callName("111"), "");
  assert.equal(p.impression("111"), "");
  assert.equal(p.setCallName("111", "小明"), true);
  assert.equal(p.setCallName(222, "阿紫"), true); // 数字 ID 也认
  assert.equal(p.callName("111"), "小明");
  assert.equal(p.callName("222"), "阿紫");
  assert.equal(p.setImpression("111", "说话简短，爱聊游戏"), true);
  assert.equal(p.impression("111"), "说话简短，爱聊游戏");
  assert.equal(p.impression("222"), "");
});

test("UserProfiles：空称呼/空印象不写入、不覆盖", () => {
  const p = new UserProfiles(null);
  p.setCallName("111", "小明");
  p.setImpression("111", "爱开玩笑");
  assert.equal(p.setCallName("111", "  "), false);
  assert.equal(p.setImpression("111", ""), false);
  assert.equal(p.callName("111"), "小明");
  assert.equal(p.impression("111"), "爱开玩笑");
});

test("UserProfiles 持久化：写盘后新实例能读回；文件损坏不崩", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-"));
  const file = path.join(dir, "profiles.json");
  const p1 = new UserProfiles(file);
  p1.setCallName("111", "小明");
  p1.setImpression("111", "夜猫子，常聊 VPS");
  const p2 = new UserProfiles(file);
  assert.equal(p2.callName("111"), "小明");
  assert.equal(p2.impression("111"), "夜猫子，常聊 VPS");

  fs.writeFileSync(file, "坏掉的内容{{{", "utf-8");
  const p3 = new UserProfiles(file);
  assert.equal(p3.callName("111"), "");
  p3.setCallName("111", "重建也能存");
  assert.equal(p3.callName("111"), "重建也能存");
  fs.rmSync(dir, { recursive: true, force: true });
});
