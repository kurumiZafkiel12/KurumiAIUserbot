// permissions.js 单元测试：权限判断是纯逻辑，覆盖三档身份与私聊门禁的各种组合。
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAdminIds,
  isOwner,
  isAdmin,
  roleOf,
  canRunOwnerCommand,
  canUsePrivateChat,
  ownerNote,
  describeRole,
  shouldPauseBlock,
} from "../src/permissions.js";

const CFG = { ownerId: "111", adminIds: ["222", "333"], privateChat: "all" };

test("isOwner：ID 一致才是创建者，数字与字符串混用也能认", () => {
  assert.equal(isOwner("111", CFG), true);
  assert.equal(isOwner(111, CFG), true);
  assert.equal(isOwner("222", CFG), false);
  assert.equal(isOwner("", CFG), false);
});

test("isOwner：没配 ownerId 时谁都不是创建者", () => {
  assert.equal(isOwner("111", { ownerId: "", adminIds: [] }), false);
  assert.equal(isOwner("111", {}), false);
  assert.equal(isOwner("111", null), false);
});

test("isAdmin：只认名单，创建者不在管理员之列", () => {
  assert.equal(isAdmin("222", CFG), true);
  assert.equal(isAdmin(333, CFG), true);
  assert.equal(isAdmin("111", CFG), false); // 创建者是更高一档，不算管理员
  assert.equal(isAdmin("999", CFG), false);
  assert.equal(isAdmin("222", { adminIds: "not-an-array" }), false);
});

test("roleOf：三档身份各归其位", () => {
  assert.equal(roleOf("111", CFG), "owner");
  assert.equal(roleOf("222", CFG), "admin");
  assert.equal(roleOf("999", CFG), "user");
});

test("canRunOwnerCommand：只有创建者能跑号主命令，管理员也不行", () => {
  assert.equal(canRunOwnerCommand("111", CFG), true);
  assert.equal(canRunOwnerCommand("222", CFG), false);
  assert.equal(canRunOwnerCommand("999", CFG), false);
});

test("canUsePrivateChat：all 模式人人可私聊", () => {
  assert.equal(canUsePrivateChat("999", CFG), true);
  assert.equal(canUsePrivateChat("999", { ...CFG, privateChat: undefined }), true);
  assert.equal(canUsePrivateChat("999", { ...CFG, privateChat: "乱写的值" }), true);
});

test("canUsePrivateChat：admins 模式只放行创建者与管理员", () => {
  const locked = { ...CFG, privateChat: "admins" };
  assert.equal(canUsePrivateChat("111", locked), true);
  assert.equal(canUsePrivateChat("222", locked), true);
  assert.equal(canUsePrivateChat("999", locked), false);
});

test("normalizeAdminIds：转字符串、去空、去重，非法输入给空数组", () => {
  assert.deepEqual(normalizeAdminIds([222, "222", " 333 ", "", null]), ["222", "333"]);
  assert.deepEqual(normalizeAdminIds(undefined), []);
  assert.deepEqual(normalizeAdminIds("222"), []);
});

test("ownerNote：带上创建者 ID 并强调只认 ID；没配 ownerId 返回 null", () => {
  const note = ownerNote(CFG);
  assert.match(note, /111/);
  assert.match(note, /创建者/);
  assert.equal(ownerNote({ ownerId: "" }), null);
  assert.equal(ownerNote({}), null);
});

test("describeRole：创建者/管理员有标注，普通用户返回 null", () => {
  assert.match(describeRole("111", CFG), /创建者本人/);
  assert.match(describeRole("222", CFG), /管理员/);
  assert.equal(describeRole("999", CFG), null);
});

test("shouldPauseBlock：没暂停时谁都不拦", () => {
  assert.equal(shouldPauseBlock(false, "999", CFG), false);
  assert.equal(shouldPauseBlock(false, "111", CFG), false);
  assert.equal(shouldPauseBlock(undefined, "999", CFG), false);
});

test("shouldPauseBlock：暂停时普通用户和管理员都拦，只有创建者放行", () => {
  assert.equal(shouldPauseBlock(true, "999", CFG), true); // 普通用户：拦
  assert.equal(shouldPauseBlock(true, "222", CFG), true); // 管理员：也拦，暂停不给任何人开口子
  assert.equal(shouldPauseBlock(true, "111", CFG), false); // 创建者：放行（命令与本人消息不误拦）
  assert.equal(shouldPauseBlock(true, 111, CFG), false); // 数字 ID 混用也能认
});
